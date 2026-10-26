# 10 — Mockup Workflow, Quota & Delivery

Knowledge-transfer audit of the mockup subsystem: the durable generation record, the
forward-only state machine, the free/paid quota engine, the ₹10/₹20 paid-approval
flow, and the background delivery pipeline. Written developer-to-developer from the
code as it exists today; every claim below is traceable to a named file/function.

## Purpose

Explain how a mockup request for an order travels from "customer tapped *Generate my
mockup*" through quota decision, (possible) payment + admin approval, deterministic
compositing, durable Blob storage, WhatsApp delivery, and quota commit — including
every Redis key, every state transition, every idempotency seam, and the known risks.
Target audience: anyone modifying `src/mockup/*`, `api/mockup-delivery.ts`, or the
paid-approval admin surface.

## Files covered

Core (read in full):

- `src/mockup/workflow.ts` — orchestrator; free-vs-paid decision, idempotent re-entry.
- `src/mockup/generationStore.ts` — `MockupGeneration` persistence, state machine, decision claim.
- `src/mockup/quota.ts` — commit-on-success monthly quota, sticky decisions, Kolkata month math.
- `src/mockup/deliver.ts` — download logos → validate → composite → Blob upload → send → commit/release.
- `src/mockup/deliverTrigger.ts` — fast in-process attempt + dispatch to `/api/mockup-delivery`.
- `src/mockup/paidGeneration.ts` — payment-proof intake, admin approve/reject, customer notes.
- `src/mockup/rateLimit.ts` — logo validators + (vestigial) per-chat/day limiter.

Directly involved supporting files (verified):

- `api/mockup-delivery.ts` — standalone 202+`waitUntil` worker, `x-internal-secret` gate.
- `src/bot/index.ts` — top-level interceptor that matches a bare photo to a pending paid generation.
- `src/admin/actions.ts` — `mockupgen:approve|reject:<genId>` callback handling + typed-code fallback.
- `src/admin/approvalCode.ts` — 6-digit, 2-minute (mockup) approval codes.
- `src/sheets/mockupGenerations.ts` — durable audit sheet (upsert by Generation ID).
- `src/storage/blob.ts` — Vercel Blob upload wrapper (injectable uploader).
- `src/mockup/garmentReference.ts` — exact-garment eligibility gate used by deliver.
- `src/mockup/promptBuilder.ts` — `viewsForAssignments()` (placement → template view).
- `src/pricing/index.ts` + `src/pricing/priceBook.ts` — `computeMockupFee`, `MOCKUP_PRICES`.
- `src/conversation/orderFlow.ts` — S10 `mockupDecision` step (peekUsage + trigger), S11 payment.
- `src/conversation/copy.ts` — `mockupPaidRequired`, `mockupPaidProofAck`, `mockupPaidApprovedNote`, `mockupPaidRejected`.
- `src/shared/types.ts` — `MockupGeneration`, `MockupGenerationStatus`, `MockupOutputImage`, `MockupView`.

Tests skimmed: `tests/mockupWorkflow.test.ts`, `tests/mockupQuota.test.ts`,
`tests/mockupDurability.test.ts`, `tests/mockupTiming.test.ts`, plus
`tests/support/testEnv.ts` (sets `MOCKUP_FREE_PER_MONTH=1` for tests).

Note: `src/mockup/customerNotify.ts` **does not exist** (verified against the
directory listing) — customer/admin notifications are inline in `deliver.ts`,
`paidGeneration.ts`, and `api/mockup-delivery.ts`.

## Generation record — schema & Redis keys

### The record (`MockupGeneration`, `src/shared/types.ts`)

One record per mockup **request** (a front+back request is ONE record producing two
images). Fields:

| Field | Meaning |
|---|---|
| `generationId` | Idempotency key for the whole request. **Equal to `orderId`** — `workflow.generationIdForOrder(orderId)` is the identity function, deliberately, so duplicate webhooks re-enter the same workflow. |
| `orderId`, `customerChatId` | Linkage; chat id is the prefixed form (e.g. `wa:<id>` in production). |
| `status` | One of the 8 `MockupGenerationStatus` values (see state-machine table). |
| `free` | Sticky free/paid decision. Initialized `false` at creation; set authoritatively by `setQuotaOutcome()` after `reserveGeneration()`. |
| `amountInr` | Whole-rupees charge (0 when free; 10 or 20 when paid). |
| `monthKey` | Asia/Kolkata `YYYY-MM` the reservation was bucketed into. |
| `catalogSelection`, `garmentReferenceRef` | Traceability: the exact garment item/colour and the reference image path/URL. |
| `requestedViews` | `["front"]` or `["front","back"]` derived from logo placements. |
| `logos` | Snapshot of `LogoUpload[]` (fileId + placement) at request time. |
| `outputs` | `MockupOutputImage[]`: `{ view, url?, pathname?, whatsappMessageId?, costUsd? }` — one per produced view. |
| `paymentProofMessageId` | WhatsApp media ID of the customer's payment screenshot (paid only). |
| `decidedByAdminChatId` | Who approved/rejected (paid only). ⚠️ In practice this is the **literal string `"Admin"`**, not a chat id — see Risks. |
| `createdAt` / `updatedAt` / `completedAt` / `failureReason` | Timestamps + human-readable failure cause. |

### Redis keys and TTLs

All keys live in the same Upstash Redis instance as sessions. All are written by
`generationStore.ts` / `quota.ts` / `approvalCode.ts`.

| Key | TTL | Writer | Purpose |
|---|---|---|---|
| `mockupgen:<generationId>` | 60 d (`TTL_SECONDS = 60*24*60*60`) | `createGenerationIfAbsent` (`SET NX`), `save` via `advanceStatus`/`setQuotaOutcome`/`recordOutput` | The authoritative record. Every status change re-`SET`s with fresh TTL. |
| `mockupgen:order:<orderId>` | 60 d | `createGenerationIfAbsent` (only on first create) | Index orderId → generationId for admin callbacks / `loadGenerationForOrder`. |
| `mockupgen:pending:<customerChatId>` | 60 d | `setChatPendingGeneration` (set in workflow paid path; `DEL` on approve/reject) | Matches a **bare photo** from this chat to its pending paid generation (`getChatPendingGenerationId`). |
| `mockupgen:decision:<generationId>` | 60 d | `claimDecision` (`SET NX`) | Atomic single-winner claim for the approve/reject decision — closes the read-then-write race for the one irreversible transition. |
| `mockupquota:decision:<generationId>` | 40 d (`MONTH_TTL_SECONDS`) | `reserveGeneration` | Sticky free-vs-paid decision blob (a serialized `QuotaReservation`). Replay on every retry. |
| `mockupquota:committed:<generationId>` | 40 d | `commitFreeGeneration` (`SET NX`) | Idempotency marker: only the first commit per generationId increments the counter. |
| `mockupquota:phone:<last-10-digits>` | 1 y (`PHONE_QUOTA_TTL_SECONDS`), **refreshed on every `EXPIRE`** | `commitFreeGeneration` (`INCR` + `EXPIRE`) | Free-generation counter when the order has a phone number (the production path — workflow always passes `order.phone`). ⚠️ **No month component in the key** — see Risks. |
| `mockupquota:freecommitted:<bucket>:<YYYY-MM>` | 40 d | `commitFreeGeneration` | Free counter fallback when no phone is present. `<bucket>` = the `tg:` prefix stripped for legacy Telegram ids, else the raw chat id string. |
| `admin:approval:code:<6-digit>` | 120 s (`MOCKUP_APPROVAL_TTL_SECONDS`) | `createApprovalCode` | Code → `PendingApproval{type:"mockup", id}`. Consumed (deleted) on verify. |
| `admin:approval:entity:mockup:<generationId>` | 120 s | `createApprovalCode` | Reverse index; an old code is invalidated when a new one is minted. |
| `admin:approval:cooldown:mockup:<generationId>` | 30 s | `resendApprovalCode` | Anti-spam on code resend (not currently wired into the mockup path). |
| `ratelimit:mockup:*` (prefix) | sliding window | `rateLimit.ts` `canGenerateMockup` | 3 per 24 h sliding window — **currently unused** (see Delivery + Risks). |

## State machine

`MockupGenerationStatus` (8 states) with `ALLOWED_TRANSITIONS` in
`generationStore.ts` acting as the single source of truth. Missing entry ⇒ terminal.

| From | Allowed to | Triggered by | Notes |
|---|---|---|---|
| `reserved` | `awaiting_payment` | `workflow.startMockupGeneration` when `reserveGeneration` decides paid (only advances if currently `reserved`; error swallowed with `.catch(() => {})`) | Nothing is generated; chat-pending index set. |
| `reserved` | `generating` | `deliver.deliverMockupForOrder` (`advanceStatus(generationId, "generating")`) on the free path | Free path skips payment/approval entirely. |
| `awaiting_payment` | `awaiting_approval` | `paidGeneration.attachPaymentProof` when the customer's photo arrives while a `mockupgen:pending:<chat>` key exists | Stores `paymentProofMessageId`, forwards proof + Approve/Reject buttons to admins. |
| `awaiting_approval` | `approved` | `approvePaidGeneration` (after winning `claimDecision(generationId,"approve")`) | Clears the chat-pending key, notifies customer, dispatches generation via `triggerMockupDelivery`. |
| `awaiting_approval` | `rejected` | `rejectPaidGeneration` (after winning `claimDecision(...,"reject")`) | Clears chat-pending key, notifies customer (`COPY.mockupPaidRejected`). |
| `approved` | `generating` | `deliverMockupForOrder` on re-entry (workflow fast-path for approved/generating/failed paid records) | |
| `generating` | `completed` | `deliverMockupForOrder` after all Blob uploads + all sends + `recordOutput` per view succeed; sets `completedAt` | Followed by `commitFreeGeneration` (no-op for paid). |
| `generating` | `failed` | `deliverMockupForOrder` catch block; patches `failureReason` | Then `releaseReservation` (no-op by construction) + admin escalation. Customer is deliberately NOT told. |
| `failed` | `generating` | Retry: free failed records fall through the workflow and re-run delivery; paid failed records hit the workflow's paid fast-path | The ONLY backward-looking edge; retry never re-charges (sticky decision) and never re-reserves. |
| `rejected` | *(none)* | — | Terminal. |
| `completed` | *(none)* | — | Terminal. Re-entry short-circuits to cached URLs. |

Semantics of `advanceStatus(generationId, to, patch?)`:

- Record already at `to` → **idempotent no-op**: merges the patch, saves, returns
  `{ changed: false }` so callers skip side effects (duplicate callbacks are safe).
- Transition not in the table → throws `InvalidGenerationTransitionError`
  (`Illegal mockup-generation transition <from> -> <to>`). Callers mostly `.catch()`
  and log; the important one (approval) is pre-guarded by `claimDecision` SETNX so a
  lost race returns "already handled" rather than an exception.
- Record missing → throws `MockupGeneration <id> not found`.
- **Not atomic** (load → validate → save). The only side-effect-bearing transition
  with a real race (approve) is additionally protected by `claimDecision`; see Risks.

`claimDecision(generationId, "approve"|"reject")` → `SET mockupgen:decision:<genId>
<nx>`; exactly one caller ever gets `true`. A later approve after a reject (or vice
versa) also fails the claim and is treated as idempotent "already handled".

## Quota engine (`quota.ts`)

**Model: decide-on-reserve, commit-on-success.**

- `reserveGeneration(chatId, generationId, { phone, views, at })` **decides**
  free-vs-paid but consumes nothing:
  1. Replays the sticky decision from `mockupquota:decision:<genId>` if present —
     so a retry of the same generationId can never flip free↔paid or re-charge.
  2. Otherwise reads the committed counter for the current Kolkata month
     (`committedFreeThisMonth`), compares against `env.MOCKUP_FREE_PER_MONTH`, and
     computes the price via `computeMockupFee(views)`: **₹10 single view, ₹20
     front+back** (`MOCKUP_PRICES` in `priceBook.ts` — note this is not a flat ₹20).
  3. Persists the decision (`QuotaReservation { free, amountInr, monthKey,
     committedFreeThisMonth, freeAllowance }`) with a 40-day TTL.
- `commitFreeGeneration(chatId, generationId, { phone })` is the **only** function
  that consumes a slot. Guarded by `SET mockupquota:committed:<genId> NX` so a
  duplicate success never double-counts. No-op when the sticky decision isn't `free`
  (paid generations never touch the counter). Increments the counter key and
  (re)applies TTL: 1 year for phone-keyed counters, 40 days for chat+month counters.
- `releaseReservation(genId)` is a **documented no-op**: nothing is consumed until a
  success, so a failed free generation needs no counter mutation. It exists as the
  named failure hook for future storage models. Paid decisions are intentionally
  never downgraded — if the customer's proof was accepted, the charge stands across
  any number of internal retries.
- `peekUsage(chatId, { phone, at })` reads the counter without deciding/committing;
  used by the S10 `mockupDecision` step in `orderFlow.ts` to show "N free previews
  remaining".

**Calendar-month math**: `kolkataMonthKey(at)` shifts UTC by a fixed
`+5:30` (`IST_OFFSET_MINUTES`) and formats `YYYY-MM` from the shifted UTC fields —
correct because Asia/Kolkata has no DST. Tests pin the boundary
(`2026-08-31T20:00Z → "2026-09"`, `17:00Z → "2026-08"`).

**Phone normalization**: `normalizePhoneForQuota` strips non-digits and keeps the
**last 10 digits** (`+91 98765 43210` and `9876543210` collapse to the same bucket),
so the same phone from two different chats shares one counter (tested in
`mockupQuota.test.ts`).

**Failure release**: a failed free generation commits nothing, so the slot is
already "released"; the sticky free decision survives, so a retry with the same
generationId stays free and a brand-new request also stays free until enough free
generations have actually **succeeded** (proven end-to-end in
`mockupDurability.test.ts` §2, including the ₹20-stickiness retry test §4).

**Concurrency/races**: the decision step is a read-then-`SET` on the decision key —
safe per generationId (first writer wins, later calls replay), but *cross-generation*
concurrency is not serialized: two in-flight requests for the same chat/phone can
both read `committedFreeThisMonth` before either commits and both be decided free,
overcommitting the monthly allowance. The per-chat busy lock in `bot/index.ts` does
not span the background delivery function, and different chats sharing a phone
number are never serialized. See Risks.

## Data contracts

- `StartOutcome` (returned by `startMockupGeneration`, consumed by
  `api/mockup-delivery.ts`): `generated{urls}` | `generation-failed{reason}` |
  `payment-required{amountInr, generationId}` | `awaiting-approval` |
  `already-completed{urls}` | `skipped{reason}`.
- `MockupDeliveryOutcome` (returned by `deliverMockupForOrder`): `{ delivered,
  reason?, urls? }` — **never throws**; every failure is an outcome.
- `QuotaReservation`: `{ free, amountInr, monthKey, committedFreeThisMonth, freeAllowance }`.
- `MockupDeliveryDeps` (test/production injection seam): `compositor`, `blobUploader`,
  `sendPhoto`, `fetchLogo`. Production defaults: deterministic Sharp compositor
  (AI only behind `ENABLE_ONLINE_AI_MOCKUPS === "true"` **and** an API key, with
  deterministic fallback + admin escalation on AI error), `uploadMockupImage`,
  WhatsApp `sendMedia` (sends the **Blob URL**, not a buffer), `fetchMetaMediaBuffer`.
- `AfterApprovalDeliver` (in `paidGeneration.ts`): production default calls
  `triggerMockupDelivery(orderId)` and returns `{ delivered: true }` **fire-and-forget**;
  tests swap it via `__setAfterApprovalDeliverForTests(fn)`.
- Admin callback strings: `mockupgen:approve:<generationId>` /
  `mockupgen:reject:<generationId>` (parsed by `handleMockupGenAction` with
  `/^mockupgen:(approve|reject):(.+)$/`). Typed fallbacks: the 6-digit approval code
  (→ `verifyAndConsumeApprovalCode` → `executeMockupApprove`) and
  `REJECT <id>` (distinguished from order-Issue by the existence of the
  `mockupgen:<id>` key).
- `POST /api/mockup-delivery` body: `{ orderId }`; header `x-internal-secret`.
- Audit sheet row (MockupGenerations tab): upserted **by Generation ID**;
  `generationToRow` maps the record; write failures escalate the full row as text to
  admin chats and are swallowed (Redis+Blob remain authoritative).

## Execution flow

### 1. Free path (customer opted in, quota available)

1. S10 `mockupDecision` (`orderFlow.ts`): order id created (`nextOrderId()`),
   `peekUsage` shows remaining free previews, order snapshot saved
   (`saveOrderSnapshot`), then `triggerMockupDelivery(order.orderId)` —
   **not awaited inline** for the background leg; flow proceeds to S11 payment.
2. `triggerMockupDelivery` first tries **fast in-process delivery**: loads the order
   snapshot and calls `deliverMockupForOrder(snapshot)` directly (~150 ms Sharp
   composite). On success it returns without any HTTP dispatch.
3. `deliverMockupForOrder` → short-circuits if the generation is already `completed`
   (returns stored URLs, no regeneration). Gates: logos present; chat id parseable
   (`wa:` stripped); exact-garment eligibility (`isMockupEligible` — currently
   always `true`; legacy orders without catalog use generic templates).
4. `advanceStatus(genId, "generating")` (best-effort), then: `validateLogoCount`
   (1..4), download each logo (`fetchMetaMediaBuffer`), `validateLogoFile`
   (magic-byte MIME sniff → jpeg/png/webp; ≤ 8 MB), build placements.
5. Compositing: default is **deterministic Sharp** ("contain"-fit of original logo
   bytes into zone rects on the template/garment reference). AI photorealistic
   generation only when `ENABLE_ONLINE_AI_MOCKUPS === "true"` and a provider key
   exists; on AI error it logs, notifies admins, and falls back to deterministic.
6. **Storage before send** (hard invariant): every produced view is uploaded to
   Vercel Blob at `mockups/<orderId>/<view>.png` (`addRandomSuffix: false`) **first**.
   If any upload fails, nothing is sent.
7. Only then: send each view to the customer (Blob URL + caption), `recordOutput`
   per view (with the returned WhatsApp message id), `advanceStatus(..., "completed")`,
   and `commitFreeGeneration(chatId, orderId, { phone })`.
8. Back in `startMockupGeneration` → `{ kind: "generated", urls }`;
   `api/mockup-delivery.ts` treats it as done (no extra notification).

Workflow entry (`startMockupGeneration`) for a fresh request: skip if no logos
(`skipped`); `createGenerationIfAbsent` (SET NX, writes order index + initial audit
row); `reserveGeneration` → `setQuotaOutcome(free, amountInr, monthKey)`; free ⇒
deliver now.

### 2. Paid path (quota exhausted / sticky-paid retry)

1. Same steps 1–2, but `reserveGeneration` returns `free:false` with the computed
   price. The record advances `reserved → awaiting_payment` (best-effort) and
   `setChatPendingGeneration(chatId, genId)` indexes it. `startMockupGeneration`
   returns `payment-required`.
2. `api/mockup-delivery.ts` messages the customer (`COPY.mockupPaidRequired(price,
   MOCKUP_FREE_PER_MONTH)` — explains ₹10/₹20 and asks for a UPI payment
   screenshot) and pings admins 💳. **Nothing is generated.**
3. **Proof matching**: the top-level `bot/index.ts` `handleMessage` intercepts *any*
   image message; if `mockupgen:pending:<chatId>` exists it calls
   `attachPaymentProof(genId, imageId)`:
   - `awaiting_payment` → advance to `awaiting_approval` (stores
     `paymentProofMessageId`), forward to admins, ack customer
     (`COPY.mockupPaidProofAck`).
   - already `awaiting_approval` → duplicate proof: refresh message id, re-notify
     admins, no state change (still `ok:true` → customer acked).
   - any later state → `ok:false` ("already approved/generating/..."), and the
     message falls through to the normal conversation flow.
4. `forwardProofToAdmins`: mints a 2-minute 6-digit approval code, persists the
   proof media to Blob (`proofs/mockup-<genId>/...` via `getPublicMediaUrl`), then
   for **every** admin chat: sends the proof image, tries interactive Approve/Reject
   buttons, and falls back to a plain-text message with the code + `APPROVE/REJECT
   <genId>` instructions if interactive fails.
5. Admin presses a button → `bot/index.ts` routes `mockupgen:*` to
   `handleMockupGenAction` (gated by `isAuthorizedAdmin`, `ADMIN_CHAT_IDS`,
   `wa:`/`+` normalized) → `approvePaidGeneration` / `rejectPaidGeneration`:
   - Status pre-checks (already past the decision ⇒ idempotent success; `rejected`
     ⇒ refuse approve; only `awaiting_approval` may decide).
   - `claimDecision` SETNX single-winner; loser returns "already handled".
   - Approve: `awaiting_approval → approved` (`decidedByAdminChatId`), clear the
     chat-pending key, load the order snapshot (**missing ⇒ advance to `failed`
     with "order snapshot missing at approval"**), notify customer
     (`COPY.mockupPaidApprovedNote`), then `afterApprovalDeliver(order)` →
     `triggerMockupDelivery(orderId)` fire-and-forget.
   - Reject: `awaiting_approval → rejected`, clear pending key, notify customer.
6. Background dispatch runs `startMockupGeneration` again; the record is now
   `approved` (or `failed`/`generating`) and **paid**, so the workflow's paid
   fast-path re-runs `deliverMockupForOrder` directly — sticky decision means the
   same single ₹10/₹20, never re-quoted or re-charged (durability test §4).
7. Delivery proceeds exactly as the free path (steps 4–7 above);
   `commitFreeGeneration` is a no-op for paid records.

### 3. `deliverTrigger` + `/api/mockup-delivery` (why never inline)

Rationale (from `deliverTrigger.ts` and `api/mockup-delivery.ts` headers): the
conversation runs inside grammY's `webhookCallback`, which enforces its own internal
timeout independent of Vercel's `maxDuration`; logo downloads + composite + Blob +
sends can take 30–60 s+ on a cold start, so awaiting in-process risks grammY
aborting the update with the mockup silently never arriving.

- Fast in-process attempt first (see above), then fallback:
  `POST {baseUrl}/api/mockup-delivery`, body `{ orderId }`, header
  `x-internal-secret`, `AbortSignal.timeout(5000)` — dispatch only, never awaits
  generation.
- Base URL chain (`resolveBaseUrl`): `PUBLIC_BASE_URL` (trailing `/` stripped) →
  `https://{VERCEL_PROJECT_PRODUCTION_URL}` → `https://{VERCEL_URL}` → **hardcoded**
  `https://custom-teamwear-bot.vercel.app`.
- The endpoint: 405 for non-POST; **503 fail-closed if `INTERNAL_MOCKUP_SECRET` is
  unset** (deliberately does *not* fall back to `META_WEBHOOK_SECRET` — a leaked
  webhook secret must not unlock paid AI generations; cites audit finding C4);
  timing-safe compare; 400 for missing `orderId`; **202 immediately**, then
  `waitUntil(...)` does the work (`maxDuration: 120` in `vercel.json`). Missing
  order snapshot ⇒ admin escalation "never sent — snapshot expired". Outcome switch:
  `payment-required` ⇒ customer prompt + admin 💳; `awaiting-approval` ⇒ admin ⏳;
  `generation-failed` ⇒ admin ⚠️ with reason; `skipped` ⇒ silent (nothing promised).
- `tests/mockupTiming.test.ts` enforces structure **by reading source text**:
  order-id creation → `triggerMockupDelivery(order.orderId)` → S11 payment/QR
  ordering in `orderFlow.ts`; `admin/actions.ts` must not contain
  `triggerMockupDelivery`; `orderFlow` must not call `startMockupGeneration` inline;
  `paidGeneration.ts` must use `triggerMockupDelivery` and must **not** contain
  `deliverMockupForOrder(` inline; `api/mockup-delivery.ts` must reference
  `COPY.mockupPaidRequired`.

## Delivery details

- **Logo validation** (`rateLimit.ts`, re-exported from `deliver.ts`):
  `validateLogoCount` — 1..`MAX_LOGO_IMAGES_PER_ORDER` (4);
  `validateLogoFile` — MIME ∈ {jpeg, png, webp} (sniffed from magic bytes by
  `guessMimeTypeFromBuffer` in `deliver.ts`, not trusted metadata) and
  ≤ `MAX_LOGO_FILE_SIZE_BYTES` (8 MB). Violations throw `InvalidLogoError` → the
  catch block marks the generation `failed` + escalates to admins.
- **Views**: `requestedViewsForOrder` maps placements → distinct template views via
  `viewsForAssignments` (`PLACEMENT_VIEWS`); a front+back request produces 2 images
  but is 1 generation (1 quota slot, 1 price unit).
- **Blob storage** (`storage/blob.ts`): `put(pathname, data, { access:"public",
  addRandomSuffix:false })` — stable pathnames so a retry *replaces* rather than
  duplicates. `uploadMockupImage` throws `BlobNotConfiguredError` when
  `BLOB_READ_WRITE_TOKEN` is absent (and no test uploader injected). **No retry or
  backoff** on upload: any transient failure (incl. 429) fails the whole generation —
  recoverable via `failed → generating`, but see Risks on overwrite conflicts.
- **Sending**: `sendMedia(chatId, blobUrl, caption)` — Meta Graph API; the returned
  message id is stored per-output as `whatsappMessageId`. A send failure for one
  view logs, records `undefined` id, and continues (other views still attempt); the
  generation is still marked `completed` if the loop finishes.
- **Quota commit/release**: success ⇒ `commitFreeGeneration` (error only logged);
  failure ⇒ `advanceStatus(..., "failed", { failureReason })` (best-effort),
  `releaseReservation` (no-op), admin escalation text with order + generation id.
  **The customer is deliberately not told** — the mockup is a nice-to-have and must
  never block the confirmed order.

## Rate limits in the mockup path

- `rateLimit.ts` defines a per-chat sliding-window limiter (`ratelimit:mockup`
  prefix, 3 per 24 h, `canGenerateMockup(chatId: number)`). It is **intentionally
  not applied** in `deliverMockupForOrder` anymore (comment at `deliver.ts:181-187`):
  volume is now governed by the monthly quota + the forward-only state machine, and
  layering the daily limiter would double-count and block legitimate paid/approved
  generations. The function currently has **no callers** (vestigial; note the
  numeric-chatId signature is Telegram-era).
- The **validators** from the same file (count/size/MIME) *are* enforced on every
  delivery run.
- General controls still applying around the mockup path: the chat flood limiter
  (`checkRateLimit`) and per-chat busy lock (`acquireChatLock`) in `bot/index.ts`
  cover the webhook conversation and the payment-proof interception — but **not**
  the background `/api/mockup-delivery` worker or the fast in-process leg's
  ordering guarantees (it runs inside the webhook, under the lock, sequentially
  before any HTTP dispatch).

## Error handling

- `deliverMockupForOrder` **never throws**; all failures become
  `{ delivered:false, reason }` after: mark `failed` (+`failureReason`), release
  (no-op), admin escalation. Silent to the customer.
- `startMockupGeneration` swallows load errors on the resume read
  (`.catch(() => undefined)`) and treats a missing record as fresh;
  `advanceStatus(awaiting_payment)` and `setChatPendingGeneration` are best-effort
  (`.catch(() => {})`) — a failure there leaves the record `reserved`/unindexed, and
  the customer's proof photo won't be matched (falls into the normal flow).
- `approvePaidGeneration`: missing order snapshot ⇒ record → `failed`
  ("order snapshot missing at approval"), `ok:false, changed:true` — retryable
  because `failed → generating` is allowed and the sticky paid decision prevents
  a second charge.
- Admin/customer message sends inside `paidGeneration.ts` are all `.catch(() => {})`
  or warn-logged; interactive-button failure falls back to plain text with the code.
- Sheet audit writes: 3 retries with backoff; on final failure the full row is
  escalated to admin chats as text and swallowed — the sheet must never block the
  flow.
- Webhook-level: `bot/index.ts` wraps everything in try/catch + Sentry
  `captureException`; the delivery endpoint always 200/202-ACKs per the repo-wide
  "never trigger WhatsApp retry storms" rule (auth failures aside: 401/405/503/400
  happen before the ACK).

## Risks & observations

1. **Phone-keyed quota counter never resets monthly.** `quotaCounterKey` returns
   `mockupquota:phone:<last10>` with **no month component** whenever a phone is
   present — and the workflow always passes `order.phone`. The TTL is a rolling
   **1 year, refreshed on every `INCR`**. So in production the "monthly" free
   allowance behaves like an annual per-phone allowance for active users: a customer
   who uses 1 free mockup each month will keep getting free ones until a gap long
   enough for the counter to expire. The month-boundary reset only works for the
   phone-less fallback key `mockupquota:freecommitted:<bucket>:<month>`. (The
   month-keyed key is also the only one documented in AGENTS.md.) If per-month
   billing is the intent, the phone counter key needs the month key folded in.
2. **Cross-generation quota race (overcommit window).** `reserveGeneration` is
   read-then-write with no lock: two concurrent requests for the same phone/chat can
   both read the committed counter before either commits and both be decided free —
   yielding up to `freeAllowance + N` free generations. Per-generation idempotency
   (decision key replay) is airtight; cross-generation serialization is not. The
   per-chat busy lock doesn't span the background worker or different chats sharing
   a phone number.
3. **`advanceStatus` is not atomic** (load → check → save). Only approve/reject is
   guarded by `claimDecision` SETNX. Two truly concurrent deliveries for the same
   order (e.g. fast in-process leg partially failing then the background leg racing
   a manual re-trigger) could both pass the `completed` short-circuit and
   double-send. Duplicate webhooks are mitigated by the `upd:` dedupe key elsewhere;
   this is a narrow but real window.
4. **Fast in-process leg partially contradicts the "never slow work in webhook"
   invariant.** `deliverTrigger.triggerMockupDelivery` runs the full delivery
   (logo downloads, Blob uploads, sends) inline first, justified as a ~150 ms Sharp
   optimization. On cold starts with Meta media downloads it can exceed the webhook
   budget; if it half-completes (e.g. sent view 1, timed out before `completed`) the
   fallback dispatch re-enters — the `completed` short-circuit doesn't help because
   the record is stuck at `generating`, and `generating → generating` is an
   idempotent no-op, so delivery re-runs and the customer may receive duplicate
   images (Blob pathnames are stable, so storage doesn't duplicate).
5. **Blob overwrite conflict on retry.** `put(..., { addRandomSuffix:false })`
   writes to a fixed pathname `mockups/<orderId>/<view>.png` with no
   `allowOverwrite` option; depending on the `@vercel/blob` version, re-uploading an
   existing pathname can throw a conflict — which would make a legitimate
   `failed → generating` retry fail at the storage step every time until the blob is
   deleted. Also, uploads have **no retry/backoff**, so a transient 429/network blip
   fails the entire generation (recoverable, but escalates noise to admins).
6. **Hardcoded deployment fallback** in `resolveBaseUrl`:
   `https://custom-teamwear-bot.vercel.app`. If `PUBLIC_BASE_URL`, the production
   URL, and `VERCEL_URL` are all absent (local runs), dispatches silently go to that
   fixed host — potentially a stale/wrong deployment — with only a console error if
   it responds non-OK.
7. **Trigger/endpoint secret asymmetry.** `deliverTrigger` sends
   `INTERNAL_MOCKUP_SECRET || META_WEBHOOK_SECRET`, but the endpoint requires
   `INTERNAL_MOCKUP_SECRET` specifically and 503s without it. When only
   `META_WEBHOOK_SECRET` is set, the trigger fires requests guaranteed to be
   rejected (503/401) — the failure is only visible in logs, and the customer
   silently never gets a paid-path prompt. Correct fail-closed posture (finding C4),
   but the client-side fallback is misleading and should be dropped.
8. **`decidedByAdminChatId` records `"Admin"`.** `executeMockupApprove/Reject` in
   `admin/actions.ts` call `approvePaidGeneration(generationId, "Admin")` — the real
   admin chat id is available (`chatId`) but not passed, so the audit sheet's "Admin
   Decision By" column can never identify which admin decided (matters with multiple
   `ADMIN_CHAT_IDS`).
9. **Photo interception is over-broad.** While `mockupgen:pending:<chatId>` exists
   (set at `payment-required`, cleared only on approve/reject), *any* image the
   customer sends — an unrelated logo upload, a photo — is consumed as a payment
   proof and triggers admin notifications (a duplicate proof re-notifies all
   admins). If the customer never pays, the key lives up to 60 days and keeps
   swallowing images. `attachPaymentProof` returning not-ok falls through to the
   flow, but the `awaiting_payment → awaiting_approval` transition has no
   amount/verification check — purely manual admin diligence.
10. **Env default free allowance is 1, docs say 3.** `DEFAULT_MOCKUP_FREE_PER_MONTH
    = 1` in `env.ts` (tests also set 1); production must set
    `MOCKUP_FREE_PER_MONTH=3` explicitly to match the documented 3-free promise.
    Similarly, the product price is **₹10 single-view / ₹20 front+back**, not a flat
    ₹20 as AGENTS.md's summary suggests.
11. **`isMockupEligible` is currently a stub** (`return true`), so the
    "exact-garment reference unavailable" gate in `deliver.ts` (the branch that
    would refuse a catalog order with no usable reference image) can never fire; the
    white-template + colour-hex path in `garmentReference.ts` always provides a
    reference. The refusal copy/branch is dead until eligibility is re-tightened.
12. **Vestigial/legacy artifacts**: `canGenerateMockup` (numeric chatId, no
    callers), `findPendingPaidGeneration` (no callers), `chatBucket`'s `tg:` regex
    (WhatsApp ids fall through as raw strings), `releaseReservation` (no-op), and
    the `zaptiloMessageId` field name / "Telegram" wording left in comments.
    `orderFlow.promptNext(payment)` contains a dead `if (false)` block calling
    `generateUpiQrPng` + `triggerMockupDelivery` "to satisfy tests" — harmless but
    confusing.
13. **`peekUsage` fallback text** in `orderFlow` hardcodes "3 remaining" when the
    Redis peek fails (`.catch(() => undefined)`), which can promise free previews
    that don't exist.
14. **`setQuotaOutcome` overwrite window**: it rewrites `free`/`amountInr`/`monthKey`
    on every workflow entry (after replaying the sticky decision), which is
    consistent as long as `reserveGeneration` replays identically — but it also
    means a manually edited/quota-migration'd decision key would be reflected on the
    next re-entry. Fine today; worth knowing before moving decision storage.

Test coverage relevant to this module: free/paid routing + ₹10/₹20 pricing, one
generation = N images but one slot, approve-gated generation, duplicate approve /
reject-after-approve / duplicate proof / two-admin race, completed short-circuit
(`mockupWorkflow.test.ts`); reservation-doesn't-consume, commit idempotency, sticky
decisions, phone-bucket sharing, Kolkata month boundary (`mockupQuota.test.ts`);
storage-failure blocks send, free-slot release on failure, retry stays free,
single sheet row, paid ₹20 stickiness across failure retry (`mockupDurability.test.ts`);
structural ordering guards (`mockupTiming.test.ts`). Not covered: the live
WhatsApp/Graph send path, real Blob overwrite semantics, and the cross-generation
quota race from Risks §2.
