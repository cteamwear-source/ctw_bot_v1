# Module Audit — 01: API Endpoints (`api/` folder + `vercel.json`)

## Purpose

Knowledge-transfer reference for every Vercel serverless function in this repo. It
documents the HTTP surface, auth gates, request/response contracts, exact execution
flows, status codes, timeouts, external dependencies, and serverless-specific behavior
of each endpoint, plus the `vercel.json` routing/resource config that governs them.
Read this before touching anything under `api/` — most of the "invisible" contracts
(ACK strategy, internal secrets, waitUntil lifetime) live here and are easy to break.

## Files covered

- `api/webhook.ts` (260 lines) — WhatsApp Cloud API webhook entry
- `api/mockup-delivery.ts` (128 lines) — internal-only background mockup worker
- `api/admin-approve.ts` (957 lines) — public admin approval web portal (HTML + JSON API)
- `api/heartbeat.ts` (19 lines) — daily cron health ping
- `api/health.ts` (63 lines) — public build/env diagnostics
- `vercel.json` (24 lines) — per-function memory/duration/includeFiles + cron schedule

Supporting modules referenced (not audited in full here, behavior summarized from
source): `src/session/dedupe.ts`, `src/session/orderStore.ts`, `src/session/rateLimit.ts`,
`src/session/chatLock.ts`, `src/mockup/deliverTrigger.ts`, `src/mockup/workflow.ts`,
`src/mockup/generationStore.ts`, `src/mockup/paidGeneration.ts`, `src/admin/notify.ts`,
`src/admin/actions.ts`, `src/admin/approvalToken.ts`, `src/admin/approvalCode.ts`,
`src/admin/email.ts`, `src/whatsapp/metaClient.ts`.

---

## 1. `api/webhook.ts` — WhatsApp webhook entry point

### Purpose

Sole public ingress for inbound WhatsApp traffic (Meta Cloud API directly, or a
Tech-Provider wrapper such as Emovur at `metagraph.backendprod.com`). Performs the
Meta GET handshake, HMAC-verifies every POST, deduplicates messages, and forwards
each message into the bot core (`handleMessage` from `src/bot/index.ts`).

### HTTP surface

| Aspect | Detail |
|---|---|
| Method/Path | `GET` + `POST` on the function route (Vercel maps `api/webhook.ts` → `/api/webhook`) |
| Auth | GET: `hub.mode=subscribe` + `hub.verify_token` == `META_WEBHOOK_SECRET` (plain string compare). POST: HMAC-SHA256 `X-Hub-Signature-256` vs `META_APP_SECRET` **only when `META_APP_SECRET` is set** |
| Body parsing | `export const config = { api: { bodyParser: false } }` — Vercel's JSON parser is disabled so the handler gets byte-exact raw body for HMAC |

### Request/response contract

**GET (Meta webhook verification handshake)**

- Query params: `hub.mode` (must equal `subscribe`), `hub.verify_token` (must equal
  `META_WEBHOOK_SECRET`), `hub.challenge` (echoed back verbatim on success).
- Success: `200` with the challenge string as the body.
- Failure: `403 Forbidden` (plain text).

**POST (inbound events)**

- Body: Meta webhook JSON. Two accepted shapes:
  1. **Standard Meta payload** — matched when `payload.object === "whatsapp_business_account"`
     OR `payload.entry` is an array. Iterates `entry[].changes[].value.messages[]`.
  2. **Direct messages array fallback** — matched when `payload.messages` is a array
     (non-standard; presumably a Tech-Provider convenience shape).
- Success response: `200` with body `"EVENT_RECEIVED"`.
- Other statuses: `400` (unreadable raw body or invalid JSON), `401` (bad/missing
  `X-Hub-Signature-256` when `META_APP_SECRET` is set), `405` (any method other than
  GET/POST). Notably: an invalid signature is **never** acknowledged with 200.

### Key functions

- `maskPhone(phone)` — logs-safe rendering: `1311223999 → "131***999"`; short numbers
  (≤6 chars) become first-char + `***` + last-char.
- `summarizePayload(payload)` — builds a redacted structural summary for logging:
  `object`, per-entry `id`, per-change `field`, `phone_number_id`,
  `display_phone_number`, contact **count**, and per-message `{id, from (masked), type,
  timestamp}`, plus status **count**. Deliberately excludes message text, customer
  name, full wa_id, profile/image URLs, and raw headers.
- `verifyMetaSignature(rawBody, signatureHeader, appSecret)` — rejects on: missing
  header; prefix other than `sha256=`; non-hex payload; length mismatch; byte mismatch.
  Comparison uses `crypto.timingSafeEqual` on the decoded hex buffers, with a
  length pre-check and try/catch around `timingSafeEqual` (it throws on unequal lengths).
  Meta's spec: `signature = "sha256=" + lowercase-hex HMAC-SHA256(appSecret, rawBody)`.
- `readRawBody(req)` — tries `req.rawBody` (Buffer or string, newer `@vercel/node`),
  else streams `data`/`end` events into a concatenated Buffer; resolves `null` on
  stream error (→ 400).
- `headerString(headers, name)` — case-insensitive header lookup across
  `name` / lowercase / uppercase, accepts first element if array-valued.

### Execution flow (step-by-step)

1. **Once per cold start:** log `build=<BUILD_STAMP> commit=<VERCEL_GIT_COMMIT_SHA>
   ref=<VERCEL_GIT_COMMIT_REF>` (guarded by module-level `buildStampLogged`).
2. **GET:** validate `hub.mode` + `hub.verify_token` → 200 + challenge, else 403.
3. **Non-POST after GET branch:** 405.
4. **POST:** read raw bytes (`readRawBody`) → 400 if null.
5. `getEnv()` (throws on misconfiguration → function error, no response body written).
6. **Signature gate:** if `META_APP_SECRET` set → verify `x-hub-signature-256`;
   mismatch/missing → log warn, `401`. If unset → log a single WARN per cold start
   (`signatureWarningLogged`) and accept unverified POSTs.
7. `JSON.parse` the raw body → 400 on parse failure.
8. Log `[webhook] received <redacted summary>`.
9. **Shape 1 (standard Meta):** for every `entry → changes → value.messages[]`:
   - `claimUpdate(message.id)` — if not new, `continue` (skip).
   - Skip if `message.from` is empty.
   - `chatId = "wa:" + from`; `await handleMessage(chatId, message)`.
10. **Shape 2 (fallback `messages[]`):** same claim/from/handle logic.
11. If neither shape matched, log a warn with `typeof payload` and `Object.keys`.
12. `200 "EVENT_RECEIVED"` **after all messages finish processing** (deliberate — the
    in-code comment says this avoids Vercel freezing the container mid-work).
13. On any thrown error: log, and still send `200 "EVENT_RECEIVED"` if headers not
    yet sent (explicitly to stop Meta/Emovur retry storms).

### ACK strategy & timeouts

- There is **no fast 200-ACK**: the response is sent only after every message in the
  payload has been fully handled (all downstream Meta sends, Redis, Sheets). The
  function budget is `maxDuration: 60` (vercel.json) with 1024 MB.
- Error path deliberately swallows failures into a 200 (see step 13).
- Outbound WhatsApp calls made inside the handler have their own 35 s abort timeout
  (`src/whatsapp/metaClient.ts`); email calls 8 s.

### Dependencies

- `getEnv()` — `META_WEBHOOK_SECRET`, `META_APP_SECRET`.
- `claimUpdate` (`src/session/dedupe.ts`) — **in-memory** `Set<string>` keyed on the
  WhatsApp **message id** (despite the function/module naming "update_id"): returns
  `true` if unseen; evicts the entire set when it reaches `MAX_SEEN = 10000`.
- `handleMessage` (`src/bot/index.ts`) — the whole bot core (rate limit, lock,
  admin interception, order flow).
- Vercel-injected `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF` (logging only).

### Security gates

1. GET handshake token check (`META_WEBHOOK_SECRET`).
2. POST HMAC-SHA256 signature check (`META_APP_SECRET`) — constant-time, fail-401.
3. Logging redaction (masked phones, no bodies/headers).

### Risks & observations

- **AGENTS.md drift:** AGENTS.md documents dedupe as Redis `upd:<updateId>` (24 h,
  SETNX). The actual implementation is an **in-memory** Set with clear-all eviction at
  10 000 entries. Consequences: (a) dedupe is per-lambda-instance only — two
  concurrent instances can both process the same message; (b) the Set is keyed on
  message id, not a webhook update id.
- **Message-loss on transient error:** `claimUpdate` marks the id *before*
  `handleMessage`. If `handleMessage` throws, the catch still returns 200, so Meta
  never retries; even if it did, dedupe would reject the retry. A transient Redis/Sheets
  failure during a message permanently drops it (mitigated by the fact that
  `handleMessage` itself catches most errors internally).
- **Unverified-POST window:** with `META_APP_SECRET` unset (common with Tech
  Providers that don't share the secret), anyone who discovers the webhook URL can
  inject forged messages as any `from` number. The code documents this as a temporary
  posture; the WARN is logged once per cold start only.
- **Slow ACK:** processing multiple messages (or slow Meta calls) inside one webhook
  invocation can consume much of the 60 s `maxDuration`. If Vercel kills the
  function mid-flight, the response never goes out and Meta **will** retry — but
  dedupe already claimed earlier message ids, so retried messages may be silently
  skipped while unprocessed ones go through.
- Verbose step logging (`processing message`, `claimUpdate returned`, `calling
  handleMessage`, `completed`) exists at every hop — presumably added while debugging
  delivery issues; harmless but noisy in production logs.

---

## 2. `api/mockup-delivery.ts` — internal background mockup worker

### Purpose

Decouples slow mockup generation (Sharp composite, Blob upload, sends, or paid-approval
prompting) from the webhook request/response cycle. The order flow dispatches a fire-and-
forget HTTP call here and immediately continues the conversation; this function ACKs
`202` instantly and does the real work inside `waitUntil()` after the response is gone.
Rationale (from `src/mockup/deliverTrigger.ts`): generation can take 30–60 s+ on cold
start, far beyond comfortable webhook budgets, and running it in-process risks the
update being aborted before the mockup ever reaches the customer. `tests/mockupTiming.test.ts`
structurally enforces that generation never runs inside the webhook handler.

### HTTP surface

| Aspect | Detail |
|---|---|
| Method/Path | `POST` only (`405` otherwise) on `/api/mockup-delivery` |
| Auth | Shared-secret header `x-internal-secret` compared against `INTERNAL_MOCKUP_SECRET` with a **timing-safe** comparison. Fail-closed: if `INTERNAL_MOCKUP_SECRET` is unset, the endpoint returns `503` and refuses all requests |
| Body | JSON `{ "orderId": string }` |

### Request/response contract

- `405` — non-POST.
- `503 "Service Unavailable"` — `INTERNAL_MOCKUP_SECRET` not configured (logged as error).
- `401 "Unauthorized"` — missing/non-string/mismatched `x-internal-secret`.
- `400 "Missing orderId"` — body lacks `orderId`.
- `202 "Accepted"` — job accepted; all real work happens post-response in `waitUntil`.

### Security

- **Dedicated trust boundary.** The endpoint deliberately does *not* fall back to
  `META_WEBHOOK_SECRET`: "a leaked webhook secret also lets an attacker trigger our
  OpenRouter / Gemini generations" (audit finding C4 referenced in the header comment).
  This contrasts with `deliverTrigger.ts`, which *does* fall back to
  `META_WEBHOOK_SECRET` when sending the header (see risks).
- `secretsMatch()` compares Buffers with an explicit length pre-check then
  `crypto.timingSafeEqual`.

### Execution flow (step-by-step)

1. Method check → `405` if not POST.
2. `getEnv()`; if `!env.INTERNAL_MOCKUP_SECRET` → log error, `503`.
3. Validate `x-internal-secret` header (timing-safe) → `401` on failure.
4. Extract `body.orderId` → `400` if absent.
5. **Immediately** `res.status(202).send("Accepted")`.
6. `waitUntil(async () => { ... })` background work:
   a. `loadOrderSnapshot(orderId)` (`order:<orderId>` Redis key, 14 d TTL); errors
   swallowed to `undefined`.
   b. If no snapshot: log warn + `notifyAdminsText("⚠️ Mockup for <id> was never sent —
   order snapshot expired/missing from cache...")` and return. (PRD §7 "never fails
   silently" escalation rule.)
   c. `startMockupGeneration(orderSnapshot)` — the idempotent workflow (generationId
   == orderId, so duplicate triggers re-enter the same record, never double-reserving
   quota or double-charging).
   d. Switch on outcome:
     - `generated` / `already-completed` — nothing extra; delivery already happened.
     - `payment-required` — strip `wa:` prefix from `orderSnapshot.customerChatId`,
       send the customer `COPY.mockupPaidRequired(amountInr, MOCKUP_FREE_PER_MONTH)`
       via `sendMessage`, and text admins "💳 Mockup for <id> needs payment (₹X)…".
     - `awaiting-approval` — text admins "⏳ … awaiting admin approval…".
     - `generation-failed` — text admins "⚠️ … not delivered: <reason>".
     - `skipped` — silent (no artwork was ever promised to the customer).
   Every admin notify and the customer send are `.catch()`-guarded individually.

### Dependencies

- `getEnv()` — `INTERNAL_MOCKUP_SECRET`, `MOCKUP_FREE_PER_MONTH`.
- `loadOrderSnapshot` — Redis (`order:<orderId>`, 14 d TTL).
- `startMockupGeneration` — quota (`mockupquota:*`), generation store
  (`mockupgen:*`), Sharp compositing, Blob upload, WhatsApp sends.
- `notifyAdminsText` — loops `ADMIN_CHAT_IDS`, sends via Meta client, per-admin
  catch; also logs the escalation text.
- `sendMessage` — Meta Cloud API (35 s abort timeout).
- `COPY.mockupPaidRequired` — canonical product copy.
- `@vercel/functions` `waitUntil` — keeps the lambda alive after the 202 response
  so the background task can finish within `maxDuration: 120` (vercel.json, 1024 MB,
  `includeFiles: assets/**` for catalog garment images).

### Risks & observations

- **Caller/callee secret mismatch:** `deliverTrigger.ts` sends
  `x-internal-secret: env.INTERNAL_MOCKUP_SECRET || env.META_WEBHOOK_SECRET`, but this
  endpoint 503s when `INTERNAL_MOCKUP_SECRET` is unset. So with the secret unset the
  trigger's HTTP fallback path can never succeed (it will 503, and `deliverTrigger`
  only logs the failure). The in-process fast path (`deliverMockupForOrder`, ~150 ms
  Sharp composite) usually masks this, but any order that falls through to the HTTP
  fallback without `INTERNAL_MOCKUP_SECRET` configured silently never generates.
- `getEnv()` is called twice (`env`, then `env2` inside the payment-required branch) —
  harmless (cached), just odd.
- Duplicate triggers are safe by design (idempotent `startMockupGeneration` keyed on
  orderId) — worth preserving if the workflow changes.
- No size/type validation on the JSON body beyond `orderId` presence; fine because the
  secret gate precedes it.

---

## 3. `api/admin-approve.ts` — admin approval web portal

### Purpose

A self-contained, token-authenticated HTML portal (plus a small JSON API) that lets
admins verify a customer's payment: view the order summary and payment screenshot,
then either **Confirm** (requires a 6-digit emailed OTP) or **Flag Payment Issue**
(token only). It exists because admin confirmation can't rely on a single WhatsApp
button press anymore — the 2026-10 security posture adds second-factor email OTP.
This file is **not** listed in AGENTS.md's repo layout (it predates or was omitted
from that summary) — treat the file as ground truth.

### HTTP surface

| Aspect | Detail |
|---|---|
| Method/Path | `GET` (render portal HTML) and `POST` (JSON action API) on `/api/admin-approve`; other methods → `405` with `Allow: GET, POST` |
| Auth | Every request requires `orderId` + `token` query/body params; token must pass `verifyPortalToken()` — HMAC-SHA256 `<timestamp>.<hmac>` signed with `ADMIN_PORTAL_SECRET` over `"<orderId>:<timestamp>"`, max age **7 days**, ±60 s future-skew tolerance, `timingSafeEqual` compare. `confirm` additionally requires a valid 6-digit OTP |
| Body (POST) | JSON (also tolerates `application/x-www-form-urlencoded` string bodies via `parseBody`) |

### Request/response contract

**GET** — query `orderId`, `token`, optional `action=resend_otp`:

- `400` HTML error page — missing `orderId`/`token`.
- `403` HTML error page — invalid/expired token ("valid for 7 days").
- `200 text/html` — full portal page. When `action=resend_otp`, a fresh OTP is
  generated (30 s cooldown per order) and emailed before rendering; the result shows
  as a success/warning/info banner. Note: on email failure the banner **includes the
  OTP code in plaintext** so the admin isn't locked out.

**POST** — JSON body `{ orderId, token, action, code? }` (or same-named query params
as fallback for orderId/token):

| Action | Extra auth | Success | Failure codes |
|---|---|---|---|
| `resend_otp` | token only | `200 {ok:true, message}` after emailing a new OTP | `429` cooldown (`cooldownRemaining`), `502` code-generated-but-email-failed |
| `issue` | token only | `200 {ok:true, message:"…Payment Issue 🚩 in CRM."}` | `400` already processed / lost SETNX race |
| `confirm` | token + 6-digit `code` | `200 {ok:true, message}` (+ " Customer notified on WhatsApp." if the DM landed) | `400` already processed; `400` code not 6 digits; `400` code invalid/expired (30 min); `400` code doesn't match this orderId; `400` lost SETNX race |
| anything else | — | — | `400 {ok:false, error:"Unknown action"}` |

### Execution flow (step-by-step)

**GET handler (`handleGet`):**

1. Parse `orderId`/`token`/`action` from query → `400` error page if missing.
2. `verifyPortalToken(orderId, token)` → `403` error page if invalid.
3. If `action === "resend_otp"`: `resendApprovalCode("order", orderId)` (30 s Redis
   cooldown key `admin:approval:cooldown:order:<id>`); on success
   `sendSecondaryOtpEmail(orderId, code, getPortalUrl(...))`; build banner
   (success / warning-with-code / info-cooldown).
4. `loadOrderSnapshot(orderId)` and `getProcessedAction(orderId)`
   (Redis `admin-action:<orderId>`).
5. `200` + `renderPortalHtml({orderId, token, order, processedAction, banner})`.

**POST handler (`handlePost`):**

1. `parseBody` → extract `orderId`, `token`, `action`, `code` → `400` if missing ids.
2. `verifyPortalToken` → `403` JSON if invalid.
3. `resend_otp`: cooldown-gated OTP regen + email (see above) with 429/502/200.
4. `issue`: `getProcessedAction` → `400` if already processed;
   `markProcessedIfFirst(orderId, "issue")` (Redis SETNX `admin-action:<orderId>`,
   90-day TTL) → `400` on race; `updateOrderRowStatus(orderId, "Payment Issue")`
   (Google Sheets, error only logged, not surfaced); `200`.
5. `confirm`: existing check → `400`; `code` must match `/^\d{6}$/` → `400`;
   `verifyAndConsumeApprovalCode(code)` — consumes (deletes) both the code key
   `admin:approval:code:<code>` and entity key `admin:approval:entity:order:<id>`
   immediately, so it is strictly one-time → `400` if missing/expired (30-min TTL);
   `pending.id !== orderId` → `400` (code/order mismatch); `markProcessedIfFirst(orderId, "confirm")`
   → `400` on race; `updateOrderRowStatus(orderId, "Confirmed")` (logged-only on error);
   reload snapshot, `renderConfirmationDm(orderId)` and `sendMessage(customerChatId, dmText)`
   inside try/catch (DM failure doesn't fail the request, just omits the sentence from
   the message); `200`.
6. Unknown `action` → `400`.

**`renderPortalHtml`** (lines 246–934) is a large inline single-file page: order
details table (customer, city, timeline with urgent flag, tier/qty/item, size badges,
print method, garment total, print estimate, 50% advance due), payment screenshot card
(Vercel Blob public URL, or a placeholder if the snapshot has none), status badge
(Pending/Confirmed/Issue), an OTP modal with 6 single-digit inputs (auto-advance,
backspace, paste-fill), a "Request Secondary OTP" failsafe button with a client-side
30 s cooldown, and a Flag button with a `confirm()` dialog. All POSTs from the page go
to `/api/admin-approve` with `{orderId, token, action, code?}` and reload on success.
An auto-refresh warning banner appears when the order is >30 minutes old and unprocessed
(`30 * 60 * 1000` ms) because the emailed OTP TTL has likely lapsed.

**`renderErrorPage(title, message)`** — minimal styled HTML for 400/403 GET errors.

### Dependencies

- `verifyPortalToken` / `getPortalUrl` / `getResendOtpUrl` — `src/admin/approvalToken.ts`
  (7-day tokens, base URL from `PUBLIC_BASE_URL` → `VERCEL_PROJECT_PRODUCTION_URL` →
  `VERCEL_URL` → hardcoded `https://custom-teamwear-bot.vercel.app`).
- `verifyAndConsumeApprovalCode` / `resendApprovalCode` — `src/admin/approvalCode.ts`
  (Redis; order OTP TTL `ORDER_APPROVAL_TTL_SECONDS = 30*60`, mockup OTP 120 s;
  30 s resend cooldown).
- `markProcessedIfFirst` / `getProcessedAction` — Redis `admin-action:<orderId>`,
  SETNX, 90-day TTL (`PROCESSED_TTL_SECONDS` in `src/admin/actions.ts`).
- `loadOrderSnapshot` — Redis `order:<orderId>` (14 d TTL); the snapshot carries
  name/phone/city/timeline/qty/tier/catalogItemName/sizeSplit/printMethod/
  garmentTotal/garmentRate/printEstLow/printEstHigh/advanceDue/paymentScreenshotUrl.
- `updateOrderRowStatus` — Google Sheets CRM ("Confirmed" / "Payment Issue" row status).
- `renderConfirmationDm` / `sendMessage` — customer WhatsApp DM on confirm.
- `sendSecondaryOtpEmail` — Resend email (8 s timeout, `RESEND_API_KEY`).
- `getEnv()` — `ADMIN_EMAILS` (shown in the OTP modal), `ADMIN_PORTAL_SECRET`.

### Error handling

- GET: human-readable styled error pages (400/403); portal renders even if the order
  snapshot is missing (fields fall back to "—"/defaults).
- POST: structured `{ok:false, error}` JSON with the codes in the table above.
- Sheet update failures are logged (`console.error`) but do **not** roll back the
  Redis processed flag or fail the response — the order stays "processed" even if the
  CRM write failed (manual reconciliation required; this diverges from invariant #3's
  escalation style used in the order flow).
- Customer DM failure is logged and only affects the response `message` suffix.

### Security

- HMAC portal tokens (7 days, timing-safe, orderId-bound — a token for order A can't
  open order B).
- OTP confirm: 6-digit crypto-random (`crypto.randomInt(100000, 1000000)`), 30-minute
  TTL, one-time consume, bound to a specific orderId, with a 30 s resend cooldown.
- SETNX idempotency (`admin-action:<orderId>`, 90 d) makes confirm/issue exactly-once
  across concurrent requests.
- `issue` intentionally requires **no OTP** — flagging is reversible-ish and lower risk.

### Risks & observations

- **HTML injection (stored XSS) surface:** `renderPortalHtml` interpolates
  customer-controlled snapshot fields (`order.name`, `order.city`, `order.timeline`,
  `order.catalogItemName`, and the size keys) into HTML with **no escaping**. A
  customer who types `<img src=x onerror=...>` as their name would have it rendered in
  the admin's browser. Same for `paymentScreenshotUrl` inside `href`/`src`. Recommend
  an HTML-escape helper before any remediation work.
- **Token-in-URL:** the portal token sits in the query string (and in the admin's email
  / browser history / referrer headers). Acceptable for a 7-day, per-order token but
  worth knowing.
- `confirm()` browser dialogs and `alert()` on the flag path are UX-level only.
- The page's JS hardcodes the same-origin `/api/admin-approve` path — breaks if the
  function is ever mounted elsewhere.
- `parseBody` accepts form-encoded bodies too — harmless, but broadens the surface.
- Banner on GET resend path leaks the fresh OTP into the rendered HTML when email
  delivery fails (deliberate availability-over-stealth tradeoff; the page is
  token-gated).

---

## 4. `api/heartbeat.ts` — daily cron ping

### Purpose

PRD §10.2 / AC10: "Daily heartbeat cron → 👍 to admin chat; silence = investigate."
A dead-simple liveness signal — if the admin chats stop receiving the daily 👍,
something (deploy, env, cron) is broken.

### HTTP surface

- `GET` (Vercel cron default; handler is permissive and ignores method).
- **No auth.** Vercel Cron invokes it on schedule; there is no `CRON_SECRET` /
  header check, so anyone who knows the URL can trigger an admin ping.

### Contract & flow

1. `notifyAdminsText("👍 CTW bot heartbeat — all systems nominal.")` — loops
   `ADMIN_CHAT_IDS`, sends each via the Meta client (35 s timeout per send),
   per-admin catch inside `notifyAdminsText`.
2. `200 "OK"` on success; `500 "Heartbeat failed"` if the notify throws (only if
   `getEnv()` itself throws — send failures are swallowed inside `notifyAdminsText`).

### Scheduling

`vercel.json` crons: `{ path: "/api/heartbeat", schedule: "0 3 * * *" }` — daily at
03:00 UTC (08:30 IST). Function config: 256 MB, `maxDuration: 10`.

### Risks & observations

- Because `notifyAdminsText` swallows per-admin send errors, a heartbeat can return
  `200` while every WhatsApp send failed (e.g., bad `META_API_TOKEN`) — "silence =
  investigate" still works for admins, but Vercel's cron status will look green.
- Unauthenticated trigger allows ping-spam to admin chats (low severity, no data at
  risk).

---

## 5. `api/health.ts` — public build/env diagnostics

### Purpose

Prove **which build** a deployment is actually serving ("deploy-lag diagnosis")
without needing any WhatsApp traffic, and surface a coarse env-config snapshot.
Called as `curl https://<deployment>/api/health`; `buildStamp`/`commitSha` are
compared against expectations. Explicitly non-secret by design (per its own header),
though see risks.

### HTTP surface

- `GET` any query. Special trigger: `?test_resend=1`.
- **No auth.**

### Response contract

`200 application/json`:

```json
{
  "ok": true,
  "service": "custom-teamwear-bot",
  "time": "<ISO timestamp>",
  "buildStamp": "...", "commitSha": "...", "commitRef": "...", "commitMessage": "...",
  "features": { "catalogColourFlow": true, "fiftyPercentAdvance": true,
                "deterministicMockup": true, "mockupBeforePayment": true },
  "envStatus": {
    "hasResendApiKey": true, "resendPrefix": "re_xxx...", 
    "adminEmails": ["..."], "adminEmailFrom": "...",
    "hasAdminPortalSecret": true,
    "hasOpenAiApiKey": true, "openAiPrefix": "sk-xxxx...",
    "mockupImageProvider": "openai",
    "mockupImageModel": "gpt-image-2.5-flare-2026-09-08"
  }
}
```

With `?test_resend=1`, the response instead contains `envStatus` + `testResult`
(the result of actually dispatching a test email via Resend to `ADMIN_EMAILS`) and
omits the build-info/time fields.

### Execution flow (step-by-step)

1. `getBuildInfo()` (`src/config/version.ts`) — BUILD_STAMP + Vercel git env vars +
   hardcoded feature flags.
2. Build `envStatus` by reading `process.env` **directly** (not via `getEnv()`):
   `RESEND_API_KEY` presence + first-6-chars prefix (treats empty and
   `re_test_dummy` as "not configured"); `ADMIN_EMAILS` (comma-split, default
   `cteamwear@gmail.com`); `ADMIN_EMAIL_FROM` (default `Custom Teamwear
   <onboarding@resend.dev>`); `ADMIN_PORTAL_SECRET` presence; `OPENAI_API_KEY ||
   OPENAI_API` presence + first-10-chars prefix; `MOCKUP_IMAGE_PROVIDER` (default
   `"openai"`); `MOCKUP_IMAGE_MODEL` (default `"gpt-image-2.5-flare-2026-09-08"`).
3. If `req.query.test_resend === "1"`: `sendEmailWithResend({to: adminEmails, subject:
   "[Vercel Live Test] …", html: …})` → 200 with `testResult`.
4. Otherwise 200 with `{ok, service, time, ...info, envStatus}`.

### Risks & observations

- **Unauthenticated email trigger:** `?test_resend=1` sends a real email to the
  configured admin list to anyone on the internet — a spam/abuse vector and a way to
  burn Resend quota. Consider gating behind a secret query param.
- **Info disclosure:** the full admin email list, sender address, and API-key prefixes
  (`resendPrefix`, `openAiPrefix`) are public. Key prefixes are short but are still
  partial secrets; admin emails are PII. This is broader than "no secrets" in the
  header comment.
- **Violates invariant #4 locally:** it reads `process.env` directly instead of
  `getEnv()` (inconsistent with the rest of the codebase, and means validation
  differences never surface here).
- `MOCKUP_IMAGE_MODEL` / provider defaults shown here (`openai` /
  `gpt-image-2.5-flare-2026-09-08`) differ from `.env.example`'s documented default
  (`openrouter` / `bytedance-seed/seedream-4.5`) — the endpoint reports env reality,
  not `.env.example` intent.

---

## 6. `vercel.json` — function config & crons

```json
{
  "functions": {
    "api/webhook.ts":        { "memory": 1024, "maxDuration": 60,  "includeFiles": "assets/**" },
    "api/mockup-delivery.ts":{ "memory": 1024, "maxDuration": 120, "includeFiles": "assets/**" },
    "api/heartbeat.ts":      { "memory": 256,  "maxDuration": 10 }
  },
  "crons": [ { "path": "/api/heartbeat", "schedule": "0 3 * * *" } ]
}
```

### Why it matters

- **`includeFiles: "assets/**"`** bundles the committed catalog preview images into
  the two functions that need them at runtime (catalog images are read from disk, not
  traced by the bundler). AGENTS.md says `assets/catalog/**`; the actual glob is
  broader (`assets/**`). Keep this in sync with any asset-layout change or images will
  404 at runtime in production only.
- **`maxDuration`:** webhook 60 s (everything happens in-request), mockup-delivery
  120 s (post-202 `waitUntil` work), heartbeat 10 s. `api/admin-approve.ts` and
  `api/health.ts` use Vercel defaults (no explicit memory/duration).
- **Cron:** `/api/heartbeat` daily 03:00 UTC.
- `sharp` (native) must match the Vercel runtime for the 1024 MB functions; `mupdf`
  is only used by the local catalog-generation script, not by any function.

---

## Data contracts/types (cross-endpoint)

- **`message` (inbound WhatsApp payload item, loosely typed `any` in bot core):**
  fields consumed by `webhook.ts` → `bot/index.ts`: `id`, `from`, `type`, `timestamp`,
  `text.body`, `interactive.button_reply.{id,title}`, `interactive.list_reply.{id,title}`,
  `button.{payload,text}`, `image.id`.
- **`OrderData` (`src/shared/types.ts`)** — snapshot persisted at `order:<orderId>`
  (14 d TTL) by `notifyAdmins` and consumed by mockup-delivery/admin-approve:
  `orderId`, `customerChatId` (`wa:`-prefixed), `name`, `phone`, `city`, `qty`, `tier`,
  `catalogItemName`, `sizeSplit`, `printMethod`, `timeline`, `timelineUrgent`,
  `garmentTotal`, `garmentRate`, `printEstLow`, `printEstHigh`, `advanceDue`,
  `paymentScreenshotUrl`, `logoReceived`, `logos`, `catalogSelection`.
- **`StartOutcome` (`src/mockup/workflow.ts`)** — the union switched on by
  mockup-delivery: `generated | generation-failed | payment-required{amountInr,generationId} |
  awaiting-approval | already-completed | skipped`.
- **`PendingApproval` (`src/admin/approvalCode.ts`)** — `{type:"order"|"mockup", id,
  code, adminChatId?, createdAt}` stored at `admin:approval:code:<code>` (one-time).
- **Portal POST body:** `{orderId, token, action:"resend_otp"|"issue"|"confirm", code?}`
  → `{ok:boolean, message?, error?, cooldownRemaining?}`.
- **Internal dispatch body:** `{orderId}` with header `x-internal-secret`.

## Error handling (summary)

| Endpoint | Strategy |
|---|---|
| webhook | Always 200 after processing (incl. thrown errors) except 400/401/403/405 pre-processing rejections; never trigger Meta retries |
| mockup-delivery | Fail-closed 503/401 pre-ACK; post-202 work fully `.catch()`-guarded with admin escalation via `notifyAdminsText` (PRD "never fails silently") |
| admin-approve | Structured 400/403/429/502 JSON for POST; styled HTML error pages for GET; Sheets/DM failures logged but don't roll back idempotency flags |
| heartbeat | 200/500 around `notifyAdminsText` (send failures internally swallowed) |
| health | Never fails; always 200 JSON; test_resend result embedded in payload |

## Security (summary)

1. **Webhook trust:** GET verify-token echo + POST HMAC-SHA256 (`META_APP_SECRET`,
   timing-safe, 401 on failure; documented insecure fallback when unset).
2. **Internal trust boundary:** `INTERNAL_MOCKUP_SECRET` header, timing-safe,
   fail-closed 503 when unset — deliberately separate from the webhook secret
   (audit finding C4). Note the caller (`deliverTrigger.ts`) does fall back to the
   webhook secret when constructing the header, which can never authenticate against
   a 503-ing endpoint — a latent config trap.
3. **Portal trust:** per-order HMAC tokens (7 d) + one-time 6-digit email OTP
   (30 min) for confirmations + Redis SETNX exactly-once actions (90 d).
4. **Logging redaction:** webhook logs never include message bodies/headers; phones
   masked.
5. **Known gaps:** unauthenticated `health` email trigger + key-prefix/PII exposure;
   unauthenticated `heartbeat`; unescaped customer fields in the portal HTML.

## Risks & observations (consolidated)

1. **AGENTS.md is stale in three places** (verify against code, not the doc):
   dedupe, chat lock, and rate limiting are all **in-memory** (`src/session/dedupe.ts`
   Set with 10 000-entry clear-all eviction; `chatLock.ts` Set with no TTL;
   `rateLimit.ts` Map, 20 msgs/60 s window), not Redis keys (`upd:*`, `busy:*`,
   `ratelimit:*`) as the AGENTS table claims. All three are per-lambda-instance only.
2. **Webhook ACK happens after processing**, not before — long Meta calls can eat into
   the 60 s budget; a mid-flight kill leaves Meta retrying a payload whose earlier
   message ids are already dedupe-claimed.
3. **Dedupe-before-handle + always-200** = transient failures drop messages silently.
4. **`deliverTrigger` vs `mockup-delivery` secret semantics disagree** (fallback vs
   fail-closed) — unset `INTERNAL_MOCKUP_SECRET` breaks the HTTP fallback path with
   only a log line as evidence.
5. **Portal HTML is unescaped** w.r.t. customer-supplied fields (stored XSS in the
   admin browser).
6. **`health` leaks** admin emails, sender address, and API-key prefixes publicly and
   allows unauthenticated outbound email via `?test_resend=1`.
7. **`.env.example` is incomplete/duplicated** relative to `env.ts`: it lacks
   `ADMIN_EMAILS`, `ADMIN_EMAIL_FROM`, `ADMIN_PORTAL_SECRET`, `RESEND_API_KEY`,
   `EMOVUR_CONNECTOR_ID`, and defines `MOCKUP_IMAGE_PROVIDER`/`MOCKUP_IMAGE_MODEL`
   twice with conflicting values (openrouter vs openai). See doc 03 for the full
   var-by-var inventory.
8. `api/admin-approve.ts` is missing from the AGENTS.md `api/` layout listing.
9. Sheets-update failure on the admin-approve path leaves Redis and the CRM
   divergent (processed-flag committed, sheet row stale) with only a log line.
