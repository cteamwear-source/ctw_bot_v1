# Module Audit 12 — Admin Module (`src/admin/`)

Knowledge-transfer review of everything an administrator touches to verify a payment:
the WhatsApp admin-chat action handlers, the 6-digit approval-code (OTP) system, the
HMAC-signed web approval portal, and the Resend email alerts. Written developer-to-developer
from the current source (all facts verified against the files listed below).

## Purpose

The admin module implements **invariant #3 ("money events never fail silently")** and
**invariant #5 ("admin actions gated server-side by `ADMIN_CHAT_IDS`")** for the two
decisions an operator makes about money:

1. **Order payment verification** — an order lands at S11 with a customer-uploaded UPI
   screenshot. An admin must mark it `Confirmed` or `Payment Issue`. This is deliberately
   *two-factor*: a WhatsApp press alone cannot confirm (see `handleAdminAction`), the
   confirm path requires a 6-digit OTP delivered out-of-band by email, and the web portal
   additionally requires a signed token. Issue only requires the admin chat gate.
2. **Paid-mockup approval** — the 4th+ mockup in an Asia/Kolkata month costs ₹20; after
   the customer pays, the admin approves/rejects via interactive WhatsApp buttons (or a
   typed 2-minute code / `REJECT <genId>` command) before any image is generated.

The module is the *notification + decision* layer; it does not own pricing, the sheet
schema, or mockup generation. It calls into `src/sheets/client.ts#updateOrderRowStatus`,
`src/session/orderStore.ts`, `src/mockup/paidGeneration.ts`, and `src/whatsapp/metaClient.ts`.

## Files covered

| File | Lines | Role |
|---|---|---|
| `src/admin/actions.ts` | 246 | Server-side gating, idempotency claims, Confirm/Issue execution, mockup approve/reject execution, typed-command parser |
| `src/admin/notify.ts` | 77 | `notifyAdmins` (order alert orchestration) + `notifyAdminsText` (plain-text escalation fan-out) |
| `src/admin/approvalCode.ts` | 114 | 6-digit OTP generation / verification / consumption / resend cooldown, Redis key helpers |
| `src/admin/approvalToken.ts` | 73 | HMAC-SHA256 portal tokens, base-URL resolution, portal + resend URLs |
| `src/admin/email.ts` | 335 | Resend REST wrapper (never throws), order-alert email template, secondary-OTP email template |
| `api/admin-approve.ts` | 957 | Public HTTP surface: GET renders the portal HTML page, POST performs `resend_otp` / `issue` / `confirm` |

Supporting surfaces (contract only, owned elsewhere): `src/bot/index.ts` (message routing
into the handlers), `src/mockup/paidGeneration.ts` (emits the `mockupgen:` buttons and
drives the paid-generation state machine), `src/sheets/client.ts#updateOrderRowStatus`,
`src/shared/render.ts#renderConfirmationDm` / `renderAdminCard`, `src/conversation/copy.ts`.

## Architecture: three channels into the same decisions

```
                     ┌────────────────────────────────────────────┐
 Order placed        │ notifyAdmins(order, screenshotIdOrUrl)     │
 (orderFlow S11) ───►│  email OTP + portal link to ADMIN_EMAILS   │──► Resend API
                     │  fallback: WhatsApp text w/ code+link      │──► ADMIN_CHAT_IDS
                     └────────────────────────────────────────────┘
                                   │ portal link (token-signed, 7d)
                                   ▼
                     ┌────────────────────────────────────────────┐
 Admin browser ─────►│ GET/POST /api/admin-approve                │
                     │  GET  → portal HTML (OTP modal)            │
                     │  POST → resend_otp | issue | confirm+OTP   │
                     └────────────────────────────────────────────┘

 Admin WhatsApp ────► bot/index.ts handleMessage
                       ├─ input "admin:*"        → handleAdminAction
                       ├─ input "mockupgen:*"    → handleMockupGenAction
                       ├─ admin typed text       → handleAdminTextCommand (OTP / ISSUE / REJECT)
                       └─ customer image + pending paid gen → attachPaymentProof
```

`bot/index.ts` resolves the raw `input` in this precedence:
`message.text.body` → `interactive.button_reply.id` → `button_reply.title` →
`list_reply.id` → `list_reply.title` → `button.payload` → `button.text`. Cloud-API
button presses therefore arrive as ordinary messages whose text is the button id
(e.g. `admin:issue:CTW-261012-01`), not as grammY callback queries.

## Data contracts

### `PendingApproval` (`src/admin/approvalCode.ts`)

```ts
interface PendingApproval {
  type: "order" | "mockup";
  id: string;              // orderId or generationId
  code: string;            // 6-digit numeric string
  adminChatId?: string;    // never populated in production paths (see Risks)
  createdAt: number;       // Date.now()
}
```

### Redis keys owned by this module

| Key | TTL | Value | Purpose |
|---|---|---|---|
| `admin-action:<orderId>` | `90 * 24 * 60 * 60` s (7,776,000) | `"confirm"` \| `"issue"` | SETNX one-shot claim — idempotency + permanent "already processed" marker |
| `admin:approval:code:<code>` | 1800 s (order) / 120 s (mockup) | `PendingApproval` JSON | code → entity lookup |
| `admin:approval:entity:<type>:<id>` | same as code | the active code string | entity → code lookup (so reissue invalidates the old code) |
| `admin:approval:cooldown:<type>:<id>` | 30 s | `"1"` | secondary-OTP resend throttle |

`PROCESSED_TTL_SECONDS` is defined inline in `actions.ts` (not exported):
`90 * 24 * 60 * 60`.

### Button / callback-id grammar

| Pattern | Emitted by | Handled by |
|---|---|---|
| `admin:confirm:<orderId>` | *(no production renderer anymore — vestigial contract)* | `handleAdminAction` — **explicitly rejected**: replies "One-click confirmation is disabled…reply with the active 6-digit approval code" |
| `admin:issue:<orderId>` | *(same — vestigial)* | `handleAdminAction` → `executeOrderIssue` |
| `mockupgen:approve:<generationId>` | `paidGeneration.decisionButtons()` via `sendInteractiveButtons` | `handleMockupGenAction` → `executeMockupApprove` |
| `mockupgen:reject:<generationId>` | same | `handleMockupGenAction` → `executeMockupReject` |

Note the mockup regex in `handleMockupGenAction` is `^mockupgen:(approve|reject):(.+)$`
(decision first, id second), matching the emitted ids.

### Typed-command grammar (`handleAdminTextCommand`, admin-only)

| Input | Meaning |
|---|---|
| `482910` or `482 910` (`/^\s*(\d{3}\s*\d{3})\s*$/`) | raw OTP |
| `code 482910`, `confirm:482910`, `approve-482910`, `otp 482910` (`/^(?:code\|confirm\|approve\|otp)\s*[:#-]?\s*(\d{6})$/i`) | prefixed OTP |
| `confirm CTW-261012-01` / `approve <id>` (no code) | refused — "Direct text confirmation is disabled…" |
| `issue CTW-261012-01` or `reject <id>` | if Redis `mockupgen:<id>` exists → `executeMockupReject`, else → `executeOrderIssue` |

Returns `true` when the message was consumed (bot stops routing to the order flow),
`false` otherwise.

### Exported API surface

**`src/admin/actions.ts`**

| Export | Signature | Notes |
|---|---|---|
| `normalizeAdminChatId` | `(chatId?: string) => string` | trim, strip leading `wa:`, strip leading `+` |
| `isAuthorizedAdmin` | `(chatId?: string) => boolean` | `undefined → false`; compares *normalized* incoming id against *normalized* `ADMIN_CHAT_IDS` |
| `markProcessedIfFirst` | `(orderId, "confirm" \| "issue") => Promise<boolean>` | `SET NX EX`; `true` iff `"OK"` |
| `getProcessedAction` | `(orderId) => Promise<string \| null>` | raw stored value, no enum validation |
| `executeOrderConfirm` | `(orderId, adminChatId) => Promise<void>` | sheet `Confirmed` + admin DMs + customer DM |
| `executeOrderIssue` | `(orderId, adminChatId) => Promise<void>` | sheet `Payment Issue` + single admin DM |
| `executeMockupApprove` | `(generationId, adminChatId) => Promise<void>` | delegates to `approvePaidGeneration(id, "Admin")` |
| `executeMockupReject` | `(generationId, adminChatId) => Promise<void>` | delegates to `rejectPaidGeneration(id, "Admin")` |
| `handleAdminAction` | `(chatId, input, _message: any) => Promise<void>` | `admin:` buttons |
| `handleMockupGenAction` | `(chatId, input, _message: any) => Promise<void>` | `mockupgen:` buttons |
| `handleAdminTextCommand` | `(chatId, text) => Promise<boolean>` | typed OTP/commands |

**`src/admin/approvalCode.ts`**

| Export | Signature | Notes |
|---|---|---|
| `ORDER_APPROVAL_TTL_SECONDS` | `30 * 60` | exported constant |
| `MOCKUP_APPROVAL_TTL_SECONDS` | `120` | exported constant |
| `createApprovalCode` | `(type, id, adminChatId?, ttlSeconds = type==="order" ? 1800 : 120) => Promise<string>` | deletes any existing code for the entity first; `crypto.randomInt(100000, 1000000)` → 6 digits; writes both `code:` and `entity:` keys with the TTL |
| `resendApprovalCode` | `(type, id) => Promise<{ ok: boolean; code?: string; cooldownRemaining?: number }>` | 30 s cooldown key set **before** generating; cooldown hit → `{ ok:false, cooldownRemaining }` (uses `redis.ttl` when available, else 30) |
| `verifyAndConsumeApprovalCode` | `(code) => Promise<PendingApproval \| null>` | validates `/^\d{6}$/`, parses (tolerates string or object), **deletes both keys on success** (single-use) |
| `getActiveApprovalCode` | `(type, id) => Promise<string \| null>` | entity → code lookup |

**`src/admin/approvalToken.ts`**

| Export | Signature | Notes |
|---|---|---|
| `createPortalToken` | `(orderId, timestamp = Date.now()) => string` | `<ts>.<hmac-sha256-hex>`; payload `${orderId}:${timestamp}`; secret `getEnv().ADMIN_PORTAL_SECRET` |
| `verifyPortalToken` | `(orderId, token?: string) => boolean` | 2 parts, finite ts, `now - ts ≤ 7d`, `ts ≤ now + 60s` (future-drift guard), length check then `crypto.timingSafeEqual` on hex buffers |
| `resolveBaseUrl` | `() => string` | `PUBLIC_BASE_URL` (trailing `/` stripped) → `https://${VERCEL_PROJECT_PRODUCTION_URL}` → `https://${VERCEL_URL}` → hard-coded `https://custom-teamwear-bot.vercel.app` |
| `getPortalUrl` | `(orderId, token) => string` | `${base}/api/admin-approve?orderId=<enc>&token=<enc>` |
| `getResendOtpUrl` | `(orderId, token) => string` | same + `&action=resend_otp` |

`TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000` (module-private).

**`src/admin/email.ts`**

| Export | Signature | Notes |
|---|---|---|
| `sendEmailWithResend` | `(payload: {to,subject,html,text?,from?,reply_to?}) => Promise<{ok; id?; error?}>` | **never throws**; 8 s `AbortController` timeout; see "email simulation" below |
| `sendAdminOrderAlertEmail` | `(order, code, portalUrl, resendOtpUrl, screenshotUrl?) => Promise<{ok; id?; error?}>` | full HTML + text/plain alternative |
| `sendSecondaryOtpEmail` | `(orderId, newCode, portalUrl) => Promise<{ok; id?; error?}>` | resend template |

**`src/admin/notify.ts`**

| Export | Signature | Notes |
|---|---|---|
| `notifyAdmins` | `(order: OrderData, screenshotUrlOrId: string) => Promise<void>` | order alert orchestration (below) |
| `notifyAdminsText` | `(text: string) => Promise<void>` | `console.log` + best-effort DM to every `ADMIN_CHAT_IDS` entry (per-admin `catch → console.warn`); used as escalation primitive by sheets/safeAppend, mockup delivery, heartbeat |

### Environment variables consumed

| Var | Required | Fallback in `env.ts` | Used for |
|---|---|---|---|
| `ADMIN_CHAT_IDS` | yes (comma-separated) | — | WhatsApp gating + notification fan-out |
| `ADMIN_EMAILS` | no | `["cteamwear@gmail.com"]` (comma-split) | OTP/alert recipients |
| `RESEND_API_KEY` | no | — | when absent/blank/`"re_test_dummy"` → **simulated** dispatch |
| `ADMIN_EMAIL_FROM` | no | `"Custom Teamwear <onboarding@resend.dev>"` | Resend `from` |
| `ADMIN_PORTAL_SECRET` | yes | `process.env.ADMIN_PORTAL_SECRET ?? process.env.META_WEBHOOK_SECRET ?? "ctw-portal-secret-key"` | portal-token HMAC key |

## Execution flow

### 1. Order placed → `notifyAdmins` (from `orderFlow.completeOrder`)

`src/conversation/orderFlow.ts:1075-1117` (`completeOrder`) runs, in order: (1) `saveOrderSnapshot(order)`
(non-fatal), (2) `safeAppendOrderRow(order)` (failure sets `sheetWriteFailed`, escalated
per doc 11), (3) `notifyAdmins(order, draft.paymentScreenshotId ?? "")` inside try/catch —
a `notifyAdmins` throw is only `console.error`'d, never surfaced to the customer,
(4) customer apology message if the sheet write failed, (5) `clearDraft(chatId)`.

Inside `notifyAdmins`:

1. **Media → URL.** If `screenshotUrlOrId` matches `/^https?:\/\//i` it is used as-is;
   otherwise it is treated as a WhatsApp media id and converted via
   `getPublicMediaUrl(id, "proofs/<orderId>")` (Vercel Blob re-host — see doc 13), with
   `.catch(() => undefined)`. Empty string → no URL, no error.
2. **Mutates the passed order**: `order.paymentScreenshotUrl = publicUrl` when resolved.
3. `saveOrderSnapshot(order)` — again, now including the screenshot URL so the portal
   and later admin actions can read it. Failure: `console.error`, continues.
4. `createApprovalCode("order", order.orderId)` → 6-digit code, 30-minute TTL, both
   Redis keys written (any previous code for this order is invalidated).
5. `createPortalToken(orderId)` + `getPortalUrl` + `getResendOtpUrl`.
6. `sendAdminOrderAlertEmail(order, code, portalUrl, resendOtpUrl, publicUrl)`.
   - Not ok → `notifyAdminsText` fallback message containing the **approval code** and
     portal URL (wrapped `.catch(() => {})`).
   - Throws → same fallback. So a Resend outage degrades to a WhatsApp DM with the code
     — money event does not fail silently. **But see Risk 1 for the missing-API-key case.**

The email itself (subject `🛒 NEW BULK ORDER ALERT: <id> (₹<advanceDue> Advance)`) contains:
the OTP in a large monospace box ("VALID FOR 30 MINS"), the portal CTA, an order summary
table (customer/phone/city/timeline/tier/sizes/garment total/print estimate/advance due),
the payment screenshot inline (or a note when no URL), a plain-text alternative, and the
amber "FAIL-SAFE: Request Secondary OTP (Beyond 30 mins)" box linking `resendOtpUrl`.

### 2. Admin opens the portal — `GET /api/admin-approve?orderId=&token=`

1. Missing params → 400 error page. `verifyPortalToken` failure → 403 "Access Denied…
   (valid for 7 days)" error page.
2. `?action=resend_otp` (the fail-safe link): `resendApprovalCode("order", orderId)` —
   ok → `sendSecondaryOtpEmail`; email failure → warning banner **that embeds the fresh
   code in the page** plus the Resend test-mode caveat; cooldown → info banner with
   remaining seconds.
3. Loads `loadOrderSnapshot(orderId)` + `getProcessedAction(orderId)`, renders the portal:
   status badge (Pending / Confirmed / Payment Issue / already-processed), a >30-minute
   age warning with a resend button, the order-detail card, the payment screenshot
   (linked full-res), and — when unprocessed — three buttons: **✅ Confirm Payment (Enter
   OTP)**, **🚩 Flag Payment Issue**, **🔄 Request Secondary OTP**. The confirm button opens
   a 6-box OTP modal (auto-advance, backspace, paste handling) that POSTs
   `{orderId, token, code, action:"confirm"}`. A client-side 30 s resend cooldown timer
   runs in the modal.

### 3. Portal actions — `POST /api/admin-approve`

Body `{orderId, token, action, code?}` (JSON, or form-encoded fallback via `parseBody`).
Token verified first (403 on failure).

- **`resend_otp`** → `resendApprovalCode`: cooldown → 429 with `cooldownRemaining`;
  email failure → 502 "Code generated, but email delivery failed: …"; success → 200.
- **`issue`** → `getProcessedAction` non-null → 400 "already been processed as: X";
  `markProcessedIfFirst(orderId,"issue")` loss → 400 "already processed concurrently";
  `updateOrderRowStatus(orderId, "Payment Issue")` with `.catch(console.error)` (logged,
  not rethrown); 200 `Order X has been marked as Payment Issue 🚩 in CRM.`
- **`confirm`** → processed check (400); `code` must match `/^\d{6}$/` (400);
  `verifyAndConsumeApprovalCode(code)` null → 400 "invalid or has expired (valid for
  30 minutes)…"; `pending.id !== orderId` → 400 "code does not match order X";
  `markProcessedIfFirst(orderId,"confirm")` loss → 400; `updateOrderRowStatus(orderId,
  "Confirmed")` with `.catch(console.error)`; `loadOrderSnapshot` →
  `sendMessage(customerChatId, renderConfirmationDm(orderId))` (DM failure only logged,
  `dmDelivered` stays false); 200 message mentions WhatsApp DM delivery when it happened.

### 4. WhatsApp buttons (`bot/index.ts` → `handleAdminAction` / `handleMockupGenAction`)

Both start with `isAuthorizedAdmin(chatId)`; failure → `console.warn` +
DM `COPY.adminUnauthorized` ("You're not authorized to perform this action.") — never a
silent success, never any state change.

- `admin:confirm:<id>` → refused, admin is told to reply with the 6-digit code
  (single-click confirm is disabled by design).
- `admin:issue:<id>` → `executeOrderIssue` (no OTP required).
- `mockupgen:approve:<genId>` → `executeMockupApprove` → `approvePaidGeneration(genId,
  "Admin")` (`src/mockup/paidGeneration.ts`): forward-only status machine +
  `claimDecision` SETNX make it idempotent; on the winning approve it advances
  `awaiting_approval → approved`, clears the chat pending marker, DMs the customer
  (`COPY.mockupPaidApprovedNote`), then dispatches generation to `/api/mockup-delivery`
  via `triggerMockupDelivery` (fire-and-forget, never inline). Reply to admin:
  "Approved ✅ — generating mockup now." (changed) / "Already handled" (idempotent) /
  `result.reason` (failure, e.g. "already rejected", "cannot approve from <status>",
  "order snapshot missing" — the latter also moves the record to `failed`).
- `mockupgen:reject:<genId>` → `executeMockupReject` → `rejectPaidGeneration(genId,
  "Admin")` → record `rejected`, customer DM via `notifyMockupRejected`
  (`COPY.mockupPaidRejectedNote`); admin reply "Rejected 🚩" / "Already handled" / reason.

The mockup decision card that carries these buttons is emitted by
`paidGeneration.forwardProofToAdmins` (per admin): proof image via `sendMedia`, then
`sendInteractiveButtons` with caption containing order id, ₹ amount, and a **2-minute**
`createApprovalCode("mockup", generationId)` code; if interactive buttons fail, a plain
text message with the same code and `APPROVE <genId>` / `REJECT <genId>` instructions.

### 5. Admin types the OTP (WhatsApp)

`bot/index.ts` calls `handleAdminTextCommand(chatId, input)` only when
`isAuthorizedAdmin(chatId)`; the function re-checks gating itself (defense in depth) and
returns a boolean "handled".

1. Extract code from the raw or prefixed pattern.
2. `verifyAndConsumeApprovalCode(code)` — null → "⚠️ That approval code is invalid or has
   expired (codes expire after 2 minutes)…" (copy is mockup-centric; see Risk 9).
3. `pending.type === "order"` → `executeOrderConfirm(pending.id, chatId)`; `"mockup"` →
   `executeMockupApprove(pending.id, chatId)`.

`executeOrderConfirm`:
1. `getProcessedAction` non-null → DM `COPY.alreadyProcessed` ("This order was already
   processed.").
2. `markProcessedIfFirst(orderId,"confirm")` race loss → same DM.
3. `updateOrderRowStatus(orderId, "Confirmed")` — `.catch(console.error)`, **no revert of
   the claim** (Risk 2).
4. DM the acting admin: `Confirmed ✅ Code verified. Order <id> marked as confirmed.`
5. DM every *other* `ADMIN_CHAT_IDS` entry: `✅ Order <id> was confirmed by admin with
   approval code.` (`.catch(() => {})` per admin).
6. `loadOrderSnapshot(orderId)` → `customerChatId` → DM `renderConfirmationDm(orderId)`
   ("🎉 *Order X confirmed!* Production planning begins…"); DM failure → warning DM to
   the acting admin including the error message; missing snapshot → `console.error`.

`executeOrderIssue`: same two idempotency gates, `updateOrderRowStatus(orderId,
"Payment Issue").catch(console.error)`, single DM `Marked as Payment Issue 🚩 for <id>`.
No customer DM, no cross-admin fan-out.

### 6. Status write mechanics (`updateOrderRowStatus`, sheets module)

Scans all Orders rows for the one whose `Order ID` header cell equals the id (matched
by header name via `row.get("Order ID")`, not by a fixed column letter), then sets the
`Status` header cell to the new status and `Last Updated` to the current ISO timestamp
(plus `Admin Notes` when a third argument is passed — neither confirm path passes it,
only the API is capable). Never adds rows. Own retry policy is in doc 11; from this
module's perspective it is fire-and-forget-with-log.

## Error handling

- **Email never breaks the flow.** `sendEmailWithResend` catches everything, returns
  `{ok:false, error}`; `notifyAdmins` converts a not-ok/throw into a WhatsApp
  `notifyAdminsText` fallback carrying the code + portal link.
- **Fan-out is best-per-admin.** `notifyAdminsText` logs and `console.warn`s per admin;
  one dead admin chat id cannot block the others.
- **`notifyAdmins` itself never throws** at its call site (orderFlow wraps it in
  try/catch that only logs) — a total failure (Redis down, snapshot failure) still leaves
  the sheet row + the admin's own eyes on the payment screenshot in WhatsApp.
- **Sheet status writes are non-fatal and non-reverting** in both confirm
  implementations and in issue: `.catch(console.error)`. The Redis claim is NOT rolled
  back, so a sheet outage permanently wedges the order in the admin-action layer
  (Risk 2).
- **Idempotency everywhere.** `markProcessedIfFirst` (SETNX) protects order decisions;
  the mockup path is protected by the generation record's forward-only state machine plus
  `claimDecision`; `verifyAndConsumeApprovalCode` deletes both keys so a code is
  single-use.
- **Cooldowns surface to the user:** `resendApprovalCode` returns `cooldownRemaining`;
  portal POST returns 429 + remaining seconds; portal GET renders an info banner; the
  modal shows a client-side countdown (cosmetic only — the server enforces the 30 s).
- **Customer DM failure is reported upward:** WhatsApp path warns the acting admin with
  the error; portal path logs and reflects `dmDelivered` in the success message.
- **Unauthorized presses are logged and answered** (`console.warn` + `COPY.adminUnauthorized`)
  — invariant "never silently succeed" honored.
- **Sentry:** unhandled errors in the bot pipeline reach `captureException` in
  `bot/index.ts`; this module relies on logging, not Sentry, for its own failures.

## Security

- **Server-side gating.** `isAuthorizedAdmin` is the single gate for every WhatsApp
  action; it normalizes both sides (`wa:` prefix, `+`, whitespace), so `ADMIN_CHAT_IDS`
  can be configured as `wa:+91…`, `+91…`, or bare ids. `undefined` chat → false. The
  portal has no `ADMIN_CHAT_IDS` check at all — its gate is the HMAC token.
- **Two-factor confirm.** Pressing `admin:confirm:` is explicitly refused; confirming
  requires the 6-digit OTP (email) *plus* (in the portal) the signed token. The OTP is
  generated with `crypto.randomInt` (CSPRNG), single-use, entity-bound
  (`pending.id !== orderId` rejected in the portal), 30-min TTL for orders / 2-min for
  mockups, reissue invalidates the previous code.
- **Portal token.** HMAC-SHA256 over `orderId:timestamp` keyed by `ADMIN_PORTAL_SECRET`;
  7-day expiry; ±60 s future-drift rejection; constant-time comparison via
  `crypto.timingSafeEqual` (with a length pre-check and try/catch on hex decode).
- **Issue is single-factor by design** — only the chat gate / valid token. Acceptable for
  a reversible "flag for follow-up" action, but see Risk 12.
- **No OTP attempt rate-limiting server-side.** Wrong codes simply return null; the only
  throttle is the per-chat flood control in `bot/index.ts` for the WhatsApp channel. The
  portal POST endpoint has no attempt counter (Risk 11).
- **Secret hygiene caveat.** `ADMIN_PORTAL_SECRET` falls back to `META_WEBHOOK_SECRET`
  and then to the literal `"ctw-portal-secret-key"` (Risk 5).
- **PII surface.** The portal and emails render customer name/phone/city and the payment
  screenshot; access is token-gated, but tokens travel in URL query strings (logs,
  referrers, browser history) and live 7 days (Risk 7).

## Risks & observations

1. **Silent money-event black hole when `RESEND_API_KEY` is unset.** `sendEmailWithResend`
   treats a missing/blank/`"re_test_dummy"` key as a *successful simulation* (`{ok:true,
   id:"mock-<ts>"}`), logging "Simulating email dispatch". `notifyAdmins` therefore logs
   "dispatched successfully" and **never** sends the WhatsApp fallback — no admin is
   notified anywhere, the OTP is delivered to nobody, and the order sits as "Pending
   Payment" invisible except as a sheet row. This is the one configuration state that
   violates invariant #3. Fix direction: treat simulated dispatch as `ok:false` for the
   fallback decision (or as a distinct `simulated:true` flag).
2. **Sheet-update failure after the claim wedges the order for 90 days.** Both
   `executeOrderConfirm` and the portal `confirm`/`issue` handlers call
   `markProcessedIfFirst` *before* `updateOrderRowStatus`, and swallow sheet errors
   without deleting `admin-action:<orderId>`. Result: sheet still says "Pending Payment",
   customer never got the confirmation DM, and every retry (portal or WhatsApp) answers
   "already processed" until the key's 90-day TTL lapses. Manual recovery: `DEL
   admin-action:<orderId>` + fix the sheet row by hand.
3. **Two independent confirm implementations.** `actions.executeOrderConfirm`
   (WhatsApp-code path) and `api/admin-approve.ts` `action:"confirm"` (portal path)
   duplicate the claim → sheet → DM sequence with drift: only the WhatsApp path notifies
   the other admins and warns the acting admin on DM failure; only the portal path
   checks `pending.id !== orderId`. Any fix (e.g. the revert in Risk 2) must be applied
   in both places, or the two should be collapsed into one function.
4. **Stored XSS into the admin portal and emails.** `renderPortalHtml` and the email
   templates interpolate customer-controlled fields (`order.name`, `city`, `phone`,
   `catalogItemName`, `catalogColor`) into HTML with no escaping. A customer named
   `<img src=x onerror=…>` gets executed in the admin's browser on the portal page
   (token-gated, but the admin *will* open it) and in email clients that allow scripts/
   tracking. `sanitizeForSheet` guards Sheets formulas only — it is not an HTML
   sanitizer. Fix direction: escape at render time in `admin-approve.ts`/`email.ts`.
5. **Weak portal-secret fallback.** `ADMIN_PORTAL_SECRET ?? META_WEBHOOK_SECRET ??
   "ctw-portal-secret-key"`: on a fresh deployment with neither var set, anyone who knows
   the open-source default can mint valid 7-day tokens for any order id and reach the
   portal (issue action needs no OTP). Reusing the webhook secret equally widens blast
   radius. Consider failing fast when neither var is set.
6. **OTP is not bound to an administrator.** `createApprovalCode("order", id)` is called
   without `adminChatId`, and every address in `ADMIN_EMAILS` receives the same code —
   any admin's code confirms from any admin's portal session or WhatsApp chat. Fine for a
   small owner-operated team; documented here because `PendingApproval.adminChatId`
   exists but is dead.
7. **Token-in-URL leakage.** The portal token rides in the query string of links embedded
   in email and in the `resend_otp` deep link; it leaks via email forward, browser
   history, and any URL logging for up to 7 days. The GET handler also performs state
   changes for `?action=resend_otp` (invalidates the current code, emails a new one) —
   a mail-scanner/prefetch that follows links could burn the original OTP.
8. **`renderAdminCard` is now test-only.** Production new-order notification is the email
   template in `email.ts` (plus text fallback); no code sends the WhatsApp admin card on
   a new order, and no renderer emits `admin:confirm/issue:` buttons anymore. Invariant
   #2 ("one shared renderer") therefore no longer covers the admin-facing order summary —
   the email duplicates every money field independently of `src/shared/render.ts`, and
   `tests/render.test.ts` only polices the unused card. Terminology/format drift between
   quote card, (vestigial) admin card, and email is unchecked.
9. **Misleading OTP-expiry copy on WhatsApp.** `handleAdminTextCommand` answers an
   invalid code with "codes expire after 2 minutes" — true for mockup codes, false for
   order codes (30 minutes). An admin who fat-fingers an order OTP may wait unnecessarily
   or re-request instead of retrying.
10. **`issue` on arbitrary ids.** The `admin:issue:` regex accepts any suffix and
    `executeOrderIssue` performs no existence check — it will SETNX-claim
    `admin-action:<typo-id>` and attempt a sheet scan. Harmless to real orders but it
    pollutes Redis and reports success ("Marked as Payment Issue 🚩") for ids that exist
    nowhere.
11. **Portal OTP brute-force window.** A 6-digit code with no per-token attempt counter
    and only Vercel's default edge limits means a token holder can POST ~1M candidates
    within the 30-minute TTL. Mitigations to consider: attempts counter on
    `admin:approval:code:<code>` or the token, and/or lockout mirroring the 30 s resend
    cooldown.
12. **Asymmetric second factors.** Confirm requires OTP; issue does not (token or admin
    chat only). A leaked portal link alone can flag orders as Payment Issue — reversible,
    but it can trigger a customer-facing "payment problem" follow-up.
13. **`resendApprovalCode` burns the cooldown before generating.** The 30 s cooldown key
    is written before `createApprovalCode`; if generation throws (Redis hiccup), the
    caller gets an exception and the cooldown is already spent.
14. **`notifyAdmins` mutates its argument** (`order.paymentScreenshotUrl`), a side effect
    on a shared `OrderData` that later code (snapshot, sheet) observes. Convenient, but
    surprising; document or copy.
15. **`getProcessedAction` returns raw strings.** It does not validate the value is
    `"confirm"|"issue"`; the portal renders whatever it is as "already processed as: X".
    Only this module writes the key, so benign today.
16. **Secondary-OTP banner leaks the code into HTML.** On the GET `?action=resend_otp`
    path, an email-delivery failure renders the fresh code inside a warning banner.
    Token-gated page, so acceptable — but it means the page source contains a live OTP.

## References (existing coverage)

- Behavior tests: `tests/adminApproval.test.ts` (unauthorized gate, confirm-button
  refusal), `tests/adminApprovalFlow.test.ts` (OTP consume/execute), 
  `tests/adminEmailApprovalPortal.test.ts` (token + portal + `notifyAdmins`).
- Manual triggers: `scripts/test-admin-trigger.ts`, `scripts/test-admin-email-portal.ts`
  (both call `notifyAdmins` with a realistic `OrderData`).
- Related audits: doc 11 (`updateOrderRowStatus` / sheet failure escalation), doc 13
  (`getPublicMediaUrl`, `sendMessage`/`sendInteractiveButtons` transport details).
