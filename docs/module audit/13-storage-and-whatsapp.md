# Module Audit 13 — Storage & WhatsApp Transport

Knowledge-transfer review of the two outbound plumbing layers: durable image storage
(Vercel Blob) and the WhatsApp Cloud API transport (media download, message senders,
webhook payload typing). Written developer-to-developer from the current source; every
signature and constant below was read directly from the files listed.

> Note: parts of this codebase predate the WhatsApp migration and still carry
> Telegram-era names/comments (`Zaptilo*` types, the `blob.ts` header comment mentioning
> "Telegram file_ids"). This document describes what the code *does today*: WhatsApp
> Cloud API (or an approved Tech-Provider wrapper such as Emovur) + Vercel Blob.

## Purpose

- **`src/storage/blob.ts`** gives generated mockups (and re-hosted payment proofs) a
  durable, public, long-lived URL — WhatsApp media IDs expire, Blob URLs do not. It is a
  deliberately thin wrapper around `@vercel/blob`'s `put` with an injectable upload
  primitive so tests never need a real `BLOB_READ_WRITE_TOKEN`.
- **`src/whatsapp/media.ts`** turns an inbound WhatsApp media ID into bytes
  (`fetchMetaMediaBuffer`) and into a durable public URL (`getPublicMediaUrl`, which
  composes media download + Blob upload + MIME sniffing).
- **`src/whatsapp/metaClient.ts`** is the single egress point for everything the bot
  sends: text, media-by-URL, interactive buttons, interactive lists, templates. All
  Graph-API path building, auth headers, BSP routing, and timeouts live here.
- **`src/whatsapp/types.ts`** types the inbound webhook payload (`ZaptiloWebhookPayload`)
  and the interactive-outbound shapes consumed by the UI mapper.
- **`api/webhook.ts`** (adjacent surface, summarized here because it defines how
  `types.ts` payloads and media IDs enter the system) is the Vercel ingress: Meta
  handshake, HMAC verification, dedupe, and dispatch into `bot/index.ts#handleMessage`.

## Files covered

| File | Lines | Role |
|---|---|---|
| `src/storage/blob.ts` | 83 | `uploadMockupImage` + `BlobUploader` seam + `BlobNotConfiguredError` + `isBlobStorageConfigured` |
| `src/whatsapp/media.ts` | 109 | `fetchMetaMediaBuffer` (15 s budget), `guessMimeType`, `getPublicMediaUrl` |
| `src/whatsapp/metaClient.ts` | 152 | `metaFetch` core + `sendMessage` / `sendMedia` / `sendInteractiveButtons` / `sendInteractiveList` / `sendTemplate` |
| `src/whatsapp/types.ts` | 77 | `ZaptiloWebhookPayload`, `ZaptiloInteractiveButton`, `ZaptiloInteractiveListSection` |
| `api/webhook.ts` | 260 | Ingress (summarized): GET handshake, `X-Hub-Signature-256` HMAC, dedupe, `handleMessage` dispatch |

Closest consumers (for tracing call chains): `src/conversation/uiMapper.ts` (menu →
buttons/list/plain-text), `src/mockup/deliver.ts` (logo download + mockup upload/send),
`src/mockup/paidGeneration.ts` (proof forwarding), `src/admin/notify.ts` (proof
re-hosting for the admin email).

## 1. `src/storage/blob.ts` — durable image storage

### Data contracts

```ts
export interface UploadedMockup {
  url: string;      // durable, publicly reachable URL
  pathname: string; // stable object path within the blob store
}

export interface BlobUploadInput {
  pathname: string;   // e.g. "mockups/CTW-.../front.png", "proofs/<orderId>/..."
  data: Buffer;
  contentType: string;
  token: string;
}

export type BlobUploader = (input: BlobUploadInput) => Promise<UploadedMockup>;

export class BlobNotConfiguredError extends Error {
  // "BLOB_READ_WRITE_TOKEN is not configured; durable mockup storage is disabled."
}
```

### Exported functions

| Export | Signature | Behavior |
|---|---|---|
| `isBlobStorageConfigured` | `() => boolean` | `Boolean(getEnv().BLOB_READ_WRITE_TOKEN)` |
| `uploadMockupImage` | `(pathname: string, data: Buffer, contentType = "image/png", uploader?: BlobUploader) => Promise<UploadedMockup>` | If an `uploader` is passed → called directly with `token: ""` (no Vercel token needed — this is the test/alt-backend seam). Else requires `BLOB_READ_WRITE_TOKEN`, throwing `BlobNotConfiguredError` when absent, and delegates to the default uploader. |

The default uploader is `put(pathname, data, { access: "public", contentType, token,
addRandomSuffix: false })` from `@vercel/blob`. **`addRandomSuffix: false` is a
deliberate choice**: pathnames are already unique per generation+view, so a retried
generation *replaces* the object instead of accumulating duplicates.

### Injection seam (current form)

There is **no** `__setBlobUploaderForTests` global in the current code. The seam is
per-call: `uploadMockupImage(..., uploader?)` accepts an explicit `BlobUploader`, and
`src/mockup/deliver.ts` accepts a `blobUploader` in its dependency bag
(`deliver.ts:228-229` chooses the injected vs default call). Tests in `tests/support/`
supply capturing fakes through these two doors.

### Call sites

| Caller | Pathname pattern | Content |
|---|---|---|
| `src/mockup/deliver.ts` | `mockups/<orderId>/...` (per-generation, per-view) | composited/AI mockup PNG |
| `src/whatsapp/media.ts#getPublicMediaUrl` | `<prefix>/<Date.now()>-<waMediaId>.<ext>`, prefix defaults `proofs` | re-hosted payment proof / logo bytes |
| `scripts/test-mockup-generator.ts` | manual test upload | — |

### Observations

- The module header still explains the rationale in Telegram terms ("sent to Telegram…
  Telegram file_ids are not a durable archive"). The *reason* stands for WhatsApp
  (Cloud API media URLs expire in hours), but the wording is an onboarding hazard.
- `access: "public"` is hard-coded: **every uploaded image is world-readable by URL**.
  Vercel Blob has no private ACL; the only protection is pathname obscurity (see
  Security).
- No timeout, size cap, or retry around `put` — a slow/hung upload inherits the
  caller's serverless limit. `deliver.ts` treats a failed upload as non-fatal for
  sending (customer still gets the image), consistent with the doc comment "it should
  never block sending the image to the customer".
- `token` travels inside `BlobUploadInput` even though only the default uploader uses
  it; injected uploaders receive `""`. Harmless, but keep it in mind when logging inputs.

## 2. `src/whatsapp/media.ts` — media download & proof re-hosting

### `fetchMetaMediaBuffer(fileId: string): Promise<Buffer>`

`MEDIA_FETCH_TIMEOUT_MS = 15000` — a **single** `AbortController` whose timer covers the
entire chain (metadata lookup → download → manual redirect follow).

Flow:

1. **Metadata lookup.** `GET https://graph.facebook.com/v20.0/<fileId>` with
   `Authorization: Bearer META_API_TOKEN` plus, when `EMOVUR_CONNECTOR_ID` is set,
   `collector-id` and `connector-id` headers. **The host here is hard-coded to
   graph.facebook.com** — `META_API_BASE_URL` is *not* used for this first call.
2. **BSP fallback.** If that response is not ok AND `META_API_BASE_URL` is set AND does
   not contain `"facebook.com"`, retry `${META_API_BASE_URL}/v20.0/<fileId>` with the
   same headers.
3. Non-ok → throw `Failed to query media metadata (<status>): <body>`. Missing `url`
   field → throw "WhatsApp media has no download URL".
4. **Download.** `GET meta.url` with `Authorization: Bearer META_API_TOKEN` and
   `User-Agent: CustomTeamwearBot/1.0`, `redirect: "manual"`.
5. **Manual redirect.** On a 3xx with a `Location` header, re-fetch `Location` **with no
   headers at all** (the bearer token is not forwarded to the redirect host).
6. Still not ok → one more attempt: `GET meta.url` with the auth headers and *standard*
   redirect following (the "fallback: standard follow" branch).
7. Final non-ok → throw `Failed to download WhatsApp media file (<status>): <body>`;
   otherwise `Buffer.from(await response.arrayBuffer())`.

Errors from any step propagate (the catch clears the timer and rethrows).

### `guessMimeType(buffer: Buffer): string`

Magic-byte sniffing, in order: PNG (`89 50`), JPEG (`FF D8`), WEBP (`RIFF....WEBP` at
offset 8), PDF (`%PDF`), else `application/octet-stream`. **Note:** two module-private
variants with the same name exist in `src/mockup/geminiClient.ts` and
`src/mockup/openaiClient.ts` — three copies of MIME sniffing in the repo (see Risks).

### `getPublicMediaUrl(mediaIdOrUrl: string, pathnamePrefix = "proofs"): Promise<string | undefined>`

The bridge used by admin notifications to turn a WhatsApp media ID into a link that
survives Meta's media expiry:

1. Empty input → `undefined`.
2. `/^https?:\/\//i` match → returned as-is (already a URL).
3. Otherwise treat as a WhatsApp Media ID:
   - `isBlobStorageConfigured()` false → `undefined` (soft-degrade, no error).
   - `fetchMetaMediaBuffer(id)` → `guessMimeType` → extension mapping
     (`image/png→png`, `image/webp→webp`, `application/pdf→pdf`, everything else →
     `jpg`).
   - `uploadMockupImage(\`${prefix}/${Date.now()}-${mediaId}.\${ext}\`, buffer, mime)` →
     return `uploaded.url`.
4. Any thrown error → `console.warn` + `undefined`. **Never throws.**

Production callers: `src/admin/notify.ts` (prefix `proofs/<orderId>` — payment screenshot
for the admin email/portal) and `src/mockup/paidGeneration.ts` (prefix
`proofs/mockup-<generationId>` — proof forwarded to admins with the Approve/Reject card).

## 3. `src/whatsapp/metaClient.ts` — the single egress point

### `metaFetch(path, body)` anatomy

- URL: `` `${env.META_API_BASE_URL}/v20.0/${env.META_PHONE_NUMBER_ID}${path}` `` —
  **the `/v20.0` version segment is hard-coded in code**, not taken from env (the env
  doc-comment claiming the version can be folded into `META_API_BASE_URL` is stale;
  folding it in would produce `…/v20.0/v20.0/…`).
- `META_API_BASE_URL` defaults to `https://graph.facebook.com`, is trailing-slash
  stripped at env validation, and **must be `https://`** (env.ts throws otherwise —
  "Refusing to send the bearer token over a non-TLS endpoint").
- Headers: `Authorization: Bearer META_API_TOKEN`, `Content-Type: application/json`,
  and when `EMOVUR_CONNECTOR_ID` is set: `collector-id` + `connector-id` (the Emovur
  BSP routing surface).
- Timeout: `AbortController` with **35 000 ms**; cleared on both success and error.
- Non-ok → `console.error` with status + body, then throw
  `Meta API error <status>: <body>`. Success → `JSON.parse(text)` with a raw-text
  fallback if the body isn't JSON. Every call logs the URL and status.
- **No retries, no backoff** — callers own failure handling (nearly all wrap in
  try/catch, often `.catch(() => {})` for best-effort DMs).

### Exported senders

| Export | Payload shape | Limits enforced in code |
|---|---|---|
| `sendMessage(to, text)` | `type: "text"`, `text.body` | none (Cloud API caps body at 4096) |
| `sendMedia(to, mediaUrl, caption?)` | `type: "image"`, `image.link` (+ optional `caption`) | URL-based only — the bot never uploads binary media to Meta, it sends Blob URLs |
| `sendInteractiveButtons(to, text, buttons, footerText?)` | `type: "interactive"`, `interactive.type: "button"` | `buttons.slice(0, 3)`; `id.slice(0, 256)`; `title.slice(0, 20)`; `footer.slice(0, 60)` (matches Cloud API: max 3 reply buttons) |
| `sendInteractiveList(to, text, buttonText, sections, footerText?)` | `interactive.type: "list"` | `body.slice(0, 1024)`; `buttonText.slice(0, 20)`; `sections.slice(0, 10)`; per-section `title.slice(0, 24)`, `rows.slice(0, 10)`; row `id.slice(0, 200)`, `title.slice(0, 24)`, `description.slice(0, 72)`; footer 60 |
| `sendTemplate(to, templateName, languageCode = "en")` | `type: "template"` | **dead export — zero call sites** |

All senders normalize the recipient through `phone(to)`:
`to.replace(/^(wa:)+/gi, "").replace(/^\+/, "").trim()` — strips any `wa:` prefixes
(repeatable, matching the `wa:<id>` convention used for chat IDs) and a leading `+`.

### Consumer map

| Consumer | Uses |
|---|---|
| `src/conversation/uiMapper.ts#sendMenu` | `sendInteractiveButtons` (≤3 options), `sendInteractiveList` (4–10), plain-text numbered menu (>10 **or** any interactive failure — falls back to `sendMessage`) |
| `src/conversation/orderFlow.ts` | `sendMessage` everywhere; `sendMedia` for the UPI QR (`"Scan & pay with any UPI app"`) |
| `src/admin/notify.ts#notifyAdminsText`, `src/admin/actions.ts` | `sendMessage` for escalations, admin confirmations, customer DMs |
| `src/mockup/paidGeneration.ts` | `sendMedia` (proof image) + `sendInteractiveButtons` (`mockupgen:approve/reject:<id>`), with a plain-text fallback carrying the same code when buttons fail |
| `src/mockup/deliver.ts` | `sendMedia(chatId, url, caption)` for the finished mockup (URL = Blob) |

## 4. `src/whatsapp/types.ts` — payload inventory

```ts
ZaptiloWebhookPayload {
  object: string;                       // "whatsapp_business_account"
  entry: Array<{
    id: string;                         // WABA id
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: { display_phone_number: string; phone_number_id: string };
        contacts?: Array<{ profile: { name: string }; wa_id: string }>;
        messages?: Array<{
          from: string; id: string; timestamp: string;
          type: "text" | "interactive" | "image" | "document" | "button";
          text?: { body: string };
          interactive?: {
            type: "button_reply" | "list_reply";
            button_reply?: { id: string; title: string };
            list_reply?: { id: string; title: string; description?: string };
          };
          image?: { caption?; mime_type; sha256; id };
          document?: { caption?; filename; mime_type; sha256; id };
          button?: { text: string; payload: string };   // legacy template-button push
        }>;
      };
      field: string;                    // "messages"
    }>;
  }>;
}

ZaptiloInteractiveButton  { type: "reply"; reply: { id: string; title: string } }
ZaptiloInteractiveListSection { title?: string; rows: Array<{ id; title; description? }> }
```

Notes: `type` union covers only the message kinds the flow consumes; delivery-receipt
`statuses` arrays (counted by the webhook's redacted logger) and other kinds (audio,
video, sticker, location, reaction) are untyped and effectively ignored downstream.
The `Zaptilo` prefix is legacy naming; the shape is the standard Meta Cloud API payload.

## 5. Ingress summary — `api/webhook.ts` (adjacent surface)

- **GET**: `hub.mode === "subscribe"` && `hub.verify_token === META_WEBHOOK_SECRET` →
  echo `hub.challenge` (200); else 403.
- **POST**: `config = { api: { bodyParser: false } }` so the handler sees the **exact
  raw bytes**; `readRawBody` prefers `req.rawBody` (Buffer/string) then streams the
  request itself.
- **Signature**: when `META_APP_SECRET` is set, `X-Hub-Signature-256` is checked as
  `sha256=` + HMAC-SHA256(appSecret, rawBody), prefix/charset/length validated, compared
  with `crypto.timingSafeEqual` — mismatch → **401**. When unset, one WARN per cold
  start and POSTs are accepted unverified (setup window; the header comment says set it
  ASAP).
- **Logging is redacted**: `summarizePayload` emits only ids, masked phones
  (`1311223999 → "131***999"`), types, timestamps, phone_number_id, counts of
  contacts/messages/statuses — never text, names, or raw headers.
- **Dispatch**: standard shape (`object === "whatsapp_business_account"` or an `entry`
  array) → iterate `entry[].changes[].value.messages[]`; each `message.id` goes through
  `claimUpdate` (Redis dedupe, `upd:<id>` SETNX 24 h, see doc on sessions); chat ID is
  built as `` `wa:${message.from}` ``; then `handleMessage(chatId, message)` — the
  `bot/index.ts` pipeline (rate limit → chat lock → admin interception → order flow).
  A direct `{ messages: [...] }` array is accepted as a fallback shape.
- **Always 200**: success and processing errors both end in
  `res.status(200).send("EVENT_RECEIVED")` so Meta/BSPs don't retry-storm; 400 only for
  unreadable body/JSON, 405 for other methods, 403/401 for auth.

The `wa:` prefix produced here is the repo-wide customer-chat-id convention; the
outbound `phone()` strips it again before calling Meta. `normalizeAdminChatId` in the
admin module strips the same prefix for gating (doc 12).

## Data contracts — environment variables

| Var | Required | Default / validation | Consumed by |
|---|---|---|---|
| `META_API_TOKEN` | yes | — | metaClient + media (bearer) |
| `META_PHONE_NUMBER_ID` | yes | — | metaClient URL |
| `META_BUSINESS_ACCOUNT_ID` | yes | — | (env inventory; catalog/other modules) |
| `META_WEBHOOK_SECRET` | yes | — | webhook GET handshake |
| `META_API_BASE_URL` | no | `https://graph.facebook.com`; trailing `/` stripped; must be `https://` | metaClient; media BSP fallback only |
| `META_APP_SECRET` | no | — | webhook HMAC; unset → unverified POSTs |
| `EMOVUR_CONNECTOR_ID` | no | — | `collector-id` + `connector-id` headers (metaFetch + media metadata) |
| `BLOB_READ_WRITE_TOKEN` | no | — | blob.ts; unset → media re-hosting soft-degrades to `undefined` |

## Execution flows

**A. Outbound text/DM.** Caller (`sendMessage`) → `phone()` normalization → `metaFetch`
builds `${BASE}/v20.0/${PHONE_ID}/messages` → POST JSON with bearer (+ Emovur headers)
→ 35 s abort → non-ok throws with body text; ok returns parsed JSON (message id). All
call sites catch; best-effort DMs use `.catch(() => {})`, escalations log.

**B. Menu rendering.** `sendMenu` picks buttons (≤3 options) / list (4–10) / numbered
plain text (>10), and drops to plain text on *any* interactive API failure — so a Cloud
API rejection of an interactive shape never blocks the conversation.

**C. Inbound media ingestion.** Webhook message (`image`/`document` with `id`) →
dedupe → `handleMessage` → order flow stores the **media ID** (never the bytes) on the
draft (`draft.paymentScreenshotId`, logo entries). Bytes are fetched later, at the moment
they're needed.

**D. Proof re-hosting (admin alert path).** `notifyAdmins`/`forwardProofToAdmins` call
`getPublicMediaUrl(mediaId, prefix)` → metadata lookup → download → MIME sniff → Blob
upload → public URL embedded in the admin email/portal/forwarded image. Any failure →
`undefined` → notification proceeds text-only.

**E. Mockup delivery.** `deliver.ts` downloads customer logos via
`fetchMetaMediaBuffer` (injectable `fetchLogo` dep), generates the composite, uploads
via `uploadMockupImage(pathname, buffer, "image/png", blobUploader?)`, then
`sendMedia(chatId, blobUrl, caption)` — Meta fetches the image from the Blob URL.

## Error handling

- **`metaFetch` throws on every non-ok/abort**, embedding status + response text;
  there is no retry. Callers uniformly contain it: customer-facing sends log and
  degrade, admin escalations `console.warn` per admin, `notifyAdminsText` fan-out is
  per-admin best-effort.
- **`fetchMetaMediaBuffer` throws** with stage-specific messages (metadata vs
  download); the 15 s abort manifests as a generic AbortError.
- **`getPublicMediaUrl` never throws** — catches, warns, returns `undefined`; callers
  treat `undefined` as "no public URL" and continue (email shows the fallback note).
- **Blob**: `BlobNotConfiguredError` only from `uploadMockupImage` without a token;
  `deliver.ts` computes `canPersist = isBlobStorageConfigured()` and skips the upload
  branch when false, still sending the image from memory.
- **`uiMapper`** converts any interactive-send failure into a plain-text menu — the
  strongest degrade path in the stack.
- **Webhook** absorbs everything: parse errors → 400, processing errors → logged +
  200, so Meta retries are suppressed by design (invariant: never retry-storm).

## Security

- **Transport trust.** Bearer token only over `https://` (env-enforced for
  `META_API_BASE_URL`; the hard-coded `graph.facebook.com` is https by construction).
  Manual redirect following in the media download deliberately does **not** forward the
  Authorization header to the `Location` host, so a redirect cannot leak the token.
- **Ingress authenticity.** HMAC-SHA256 `X-Hub-Signature-256` with timing-safe compare
  when `META_APP_SECRET` is set; GET handshake gated by `META_WEBHOOK_SECRET`. The
  unverified-POST fallback window is the main documented weakness (401 never becomes
  200 when the secret is set).
- **Attacker-controlled `fileId`.** `fetchMetaMediaBuffer` interpolates the inbound
  media ID straight into the Graph URL path with no encoding/allow-list — a crafted
  `from`/message could aim the business-token request at other Graph paths (e.g.
  `../<other-id>`). Impact is bounded (GET metadata only, response only mined for
  `.url`), but it is an open proxy against the Graph API with the app token.
- **BSP trust.** When `META_API_BASE_URL` points at a Tech Provider, the bearer token
  and both connector headers go to that host, and the metadata `url` it returns is then
  fetched (initial download request carries the bearer to whatever host `meta.url`
  names). The BSP is trusted by configuration; a malicious/compromised BSP could capture
  the token. Acceptable, but it is a real trust boundary.
- **Public-by-URL storage.** Blob objects (payment screenshots, mockups) are
  `access: "public"` with pathnames like `proofs/<orderId>/<ts>-<waMediaId>.jpg` —
  unguessable in practice, but permanent and unauthenticated. A leaked URL (email
  forward, log, referrer) exposes customer PII forever; there is no expiry or ACL.
- **PII in logs (inconsistent).** `webhook.ts` masks phone numbers; `metaClient.ts`
  logs full recipient ids (`to=919876543210`) on every send. Any log pipeline therefore
  carries customer phone numbers.
- **No inbound payload trust.** Message contents are never logged raw; the dedupe key
  is the Meta message id; all authorization decisions (admin gate, MOQ, money) happen
  server-side downstream.

## Risks & observations

1. **Hard-coded `graph.facebook.com` in `fetchMetaMediaBuffer`'s first hop.** In an
   Emovur/BSP deployment where media metadata lives only on the provider, every media
   download pays a failing first request before the fallback — consuming part of the
   single 15 s budget. `metaClient` uses `META_API_BASE_URL` consistently; media.ts does
   not. Fix direction: use the configured base first (with facebook as fallback), or
   share one resolver.
2. **One timeout for the whole media chain.** The 15 s `AbortController` spans
   metadata + download + redirect + retry; a slow metadata call can starve the download.
   Consider per-stage budgets.
3. **No size cap on downloaded media.** `fetchMetaMediaBuffer` accumulates an
   unbounded `arrayBuffer`. The logo path validates ≤ 8 MB *after* download (deliver.ts);
   the proofs path (`getPublicMediaUrl`) has no cap at all — a hostile/large media ID
   can pressure serverless memory. Fix direction: `Content-Length` check + streamed cap.
4. **`guessMimeType` triplicated** (`whatsapp/media.ts`, `mockup/geminiClient.ts`,
   `mockup/openaiClient.ts`) with divergent implementations (magic bytes vs whatever the
   others do). Consolidate into `src/shared/`.
5. **`/v20.0` hard-coded in `metaClient`.** Version bumps require a code change, and the
   env doc-comment about folding the version into `META_API_BASE_URL` is misleading
   (would double the segment). Make the version an env var with a default.
6. **35 s send timeout inside the webhook path.** Customer DMs and admin escalations are
   awaited inside `handleMessage`, which runs inside the webhook invocation — a slow
   Meta can push the function toward platform limits (the reason mockup generation was
   already moved to `/api/mockup-delivery`). Long fan-outs (one `sendMessage` per admin
   per escalation) amplify this serially.
7. **`sendTemplate` is dead code.** Zero callers; either wire it for re-engagement
   outside the 24-hour window or delete it.
8. **Unknown inbound message types fall through silently.** A `location`/`sticker`/
   `audio` message isn't in the typed union; `bot/index.ts` resolves no `input` and the
   order flow receives a message it doesn't understand (typically answered by the
   flow's fallback). Worth an explicit "unsupported type" reply for UX.
9. **Legacy naming misleads maintainers.** `ZaptiloWebhookPayload` and the `blob.ts`
   Telegram header comment contradict the actual integrations (Meta/Emovur, WhatsApp).
   AGENTS.md warns about this; renaming or re-commenting would pay for itself.
10. **Permanent public exposure of payment proofs.** Every admin alert re-hosts the
    customer's UPI screenshot to a public Blob URL that never expires. Acceptable for
    the current threat model, but be deliberate: these URLs end up in emails, and email
    is forwardable.
11. **`metaClient` logs recipient phone numbers** on every call while the webhook
    deliberately masks them — align on one PII policy (mask at log time).
12. **Open Graph proxy via un-encoded `fileId`** (see Security) — encode/allow-list
    `^[A-Za-z0-9]+$` before interpolating into the URL.
13. **MIME fallback = `jpg` for proofs.** `getPublicMediaUrl` maps any unrecognized
    byte stream to `jpg` extension + sniffed content type; a PNG mislabeled as jpg (or
    an octet-stream) may render poorly in the admin email/portal. Low impact, but the
    extension should follow the sniffed MIME, defaulting to a download link.

## Cross-references

- Doc 11 (Sheets): safeAppend escalation uses `notifyAdminsText` (this doc's
  `sendMessage` fan-out) as its admin-DM primitive.
- Doc 12 (Admin): `notifyAdmins` calls `getPublicMediaUrl` for the payment screenshot;
  portal/HMAC details live there.
- Mockup audit: `deliver.ts` (blobUploader injection, `fetchLogo` dep), `deliverTrigger`
  and `/api/mockup-delivery` (why no generation work happens inside the webhook).
- Session/dedupe audit: `claimUpdate` (`upd:<id>`) and `chatLock` wrap every inbound
  message before it reaches any code in this document.
