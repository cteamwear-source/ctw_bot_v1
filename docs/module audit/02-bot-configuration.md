# Module Audit — 02: Bot Configuration (`src/bot/index.ts`)

## Purpose

`src/bot/index.ts` is the **entire bot core**: the single function every inbound
WhatsApp message funnels through after `api/webhook.ts` verifies and deduplicates it.
Despite AGENTS.md's historical references to grammY (`webhookCallback`, storages),
this module contains **no grammY `Bot` instance** — routing is hand-rolled prefix
dispatch inside one exported `handleMessage(chatId, message)` function. It owns the
cold-start init (Sentry + env), flood control, per-chat concurrency, admin-action
interception, paid-mockup proof interception, and delegation into the customer
conversation state machine.

## Files covered

- `src/bot/index.ts` (93 lines) — the only file in this audit; behavior of its
  imported dependencies is summarized inline where relevant.

---

## Module structure

```
src/bot/index.ts
├── module-level `initialized` flag (cold-start-once init)
└── export async function handleMessage(chatId: string, message: any)
    ├── init (once): initSentry(); getEnv();
    ├── checkRateLimit(chatId)              — flood control
    ├── acquireChatLock(chatId)             — busy lock
    ├── input extraction (text / interactive / button payloads)
    ├── 1. admin:…        → handleAdminAction
    ├── 2. mockupgen:…    → handleMockupGenAction
    ├── 3. admin typed commands (if authorized) → handleAdminTextCommand
    ├── 4. image + pending paid generation → attachPaymentProof
    └── 5. default → handleWhatsAppMessage (order flow)
        catch → console.error + captureException
        finally → releaseChatLock
```

## Bot construction & grammY usage

There is **none** in this file. Historical comments in `src/mockup/deliverTrigger.ts`
reference "grammY's `bot.handleUpdate()`" and "webhookCallback's internal timeout" —
those describe an earlier Telegram-era architecture. The current pipeline is:

```
Meta/Emovur → api/webhook.ts (raw HMAC + dedupe) → handleMessage() here
```

`api/webhook.ts` calls `handleMessage(chatId, message)` directly per message; there is
no middleware chain, no `bot.command(...)`, no `bot.on(...)`, no grammY session/storage
wiring in this module. (AGENTS.md's mention of "outer-sess:*, conv:*  grammY storages"
Redis keys does not correspond to anything reachable from this file.)

## `handleMessage(chatId, message)` — detailed walkthrough

### Parameters

- `chatId: string` — always `"wa:<phone>"` when coming from the webhook (both payload
  shapes prefix `wa:`). Admin ids are also normalized via
  `normalizeAdminChatId()` (strips `wa:` and `+`) on the admin paths.
- `message: any` — the raw WhatsApp message object; deliberately untyped. Fields
  consumed: `text.body`,
  `interactive.button_reply.{id,title}`, `interactive.list_reply.{id,title}`,
  `button.{payload,text}`, `image.id`.

### Step 1 — Cold-start init (module-level `initialized` flag)

```ts
if (!initialized) { initSentry(); getEnv(); initialized = true; }
```

- `initSentry()` is idempotent and no-ops without `SENTRY_DSN`.
- `getEnv()` throws on any missing required env var → satisfies invariant #4
  (fail-fast at first message, not deep inside a handler).
- If this throws, the exception propagates to `api/webhook.ts`, which still returns
  200 to Meta (log-only visibility).

### Step 2 — Flood control (`checkRateLimit`)

- `src/session/rateLimit.ts`: **in-memory** sliding window per chatId —
  `MAX_MESSAGES_PER_WINDOW = 20` per `WINDOW_MS = 60_000` (PRD §5.3/§10.1 "~20 msg/min").
- Over limit → `sendMessage(chatId, COPY.floodCooldown)` (`.catch(()=>{})`), then
  `return` — the message is dropped, not queued.
- AGENTS.md claims `ratelimit:ctw*` Redis keys; the real implementation is a per-instance
  `Map<string, number[]>`. Across serverless instances the limit is effectively
  20 msg/min **per instance**, and the Map grows unbounded per chat within an instance's
  life (entries only pruned for chats that keep messaging).

### Step 3 — Busy lock (`acquireChatLock` / `releaseChatLock`)

- `src/session/chatLock.ts`: **in-memory** `Set<string>` of chatIds currently being
  processed. `acquireChatLock` returns false if already present; `releaseChatLock`
  deletes (safe if absent), always invoked in `finally` with `.catch(()=>{})`.
- Not acquired → `sendMessage(chatId, COPY.busyReprompt)` then return.
- No TTL: if a `handleWhatsAppMessage` invocation hangs forever (it can't throw past
  the catch, but a hang would), the chat is locked until the lambda dies. In practice
  the lambda lifecycle bounds it. Again per-instance only — two near-simultaneous
  messages from one chat can land on two instances and both proceed (AGENTS.md's
  `busy:<chatId>` 90 s Redis lock does not exist in the code).

### Step 4 — Input extraction

One `input` string is derived with this precedence:

```
message.text?.body
|| message.interactive?.button_reply?.id
|| message.interactive?.button_reply?.title
|| message.interactive?.list_reply?.id
|| message.interactive?.list_reply?.title
|| message.button?.payload
|| message.button?.text
```

Plus `isImage = !!message.image` and `imageId = message.image?.id`.

### Step 5 — Routing (in order)

1. **`input.startsWith("admin:")`** → `handleAdminAction(chatId, input, message)`
   (src/admin/actions.ts). Handles `admin:confirm:<orderId>` (rejected — single-click
   confirm disabled; admin is told to reply with the 6-digit OTP) and
   `admin:issue:<orderId>` (executes immediately). Non-admins get
   `COPY.adminUnauthorized` and a warn log — never a silent success.
2. **`input.startsWith("mockupgen:")`** → `handleMockupGenAction` — parses
   `mockupgen:(approve|reject):<generationId>`; admin-gated identically; drives
   `approvePaidGeneration`/`rejectPaidGeneration`.
3. **Admin typed commands** — only if `isAuthorizedAdmin(chatId)` (normalized phone
   match against `ADMIN_CHAT_IDS`):
   `handleAdminTextCommand` consumes 6-digit OTPs (`482910`, `482 910`,
   `CONFIRM 482910`, `CODE/OTP/APPROVE …`), rejects bare `CONFIRM <orderId>` text, and
   handles `ISSUE <orderId>` / `REJECT <id>` (orders vs mockup generations probed via
   `mockupgen:<id>` Redis presence). Returns `handled:boolean`; if false, execution
   falls through to the customer flow (an admin's ordinary chatter still works as a
   customer would expect).
4. **Paid-mockup proof interception** — if the message has an image and
   `getChatPendingGenerationId(chatId)` (Redis `mockupgen:pending:<chatId>`) returns a
   generation id, the image is treated as the ₹20 payment proof:
   `attachPaymentProof(pendingGenId, imageId)` advances
   `awaiting_payment → awaiting_approval` (or re-notifies on duplicates), forwards the
   proof media + a 2-minute OTP to admins, and on `ok` sends
   `COPY.mockupPaidProofAck` and returns. If the generation is no longer in a state
   that accepts proofs (`attachPaymentProof` returns `ok:false`), execution **falls
   through** to the order flow.
5. **Default:** `handleWhatsAppMessage(chatId, message)` — the S00–S11 conversation
   state machine (`src/conversation/orderFlow.ts`), which is where the order draft,
   catalog, pricing, payment QR, and sheet append all happen.

### Error handling

```ts
catch (err) { console.error("Unhandled bot error:", err); captureException(err); }
finally { await releaseChatLock(chatId).catch(() => {}); }
```

- Any throw from routing/flow is swallowed here (logged + Sentry) — the webhook
  handler therefore almost never sees an exception, which is why its "always 200"
  behavior rarely triggers for message-processing failures.
- The lock is always released in `finally`.
- No message is sent to the customer on unhandled errors at this layer — error UX
  (apologies, retries) is the responsibility of inner layers (order flow / mockup
  delivery), per invariant #3.

### Security

- All admin paths are gated **server-side** by `isAuthorizedAdmin(chatId)` inside the
  admin handlers themselves (not just here) — pressing/typing `admin:` or `mockupgen:`
  as a customer results in `COPY.adminUnauthorized`, and unauthorized attempts are
  logged.
- Monetary decisions and confirmations never accept customer input directly at this
  layer; the OTP for order confirmation is verified via the Redis one-time code store
  (see doc 01 / approvalCode).
- The paid-proof interception trusts only the presence of the Redis
  `mockupgen:pending:<chatId>` marker — a customer cannot force proof attachment for
  another chat.

## Connection to the webhook

`api/webhook.ts` imports `handleMessage` and invokes it per message after
`claimUpdate` dedupe:

```
for entry → changes → value.messages[]:
    if !claimUpdate(message.id): continue
    if !message.from: continue
    await handleMessage(`wa:${message.from}`, message)
```

`handleMessage` returns normally after each message (errors are internal), so the
webhook proceeds to the next message and finally 200-ACKs. There is no back-pressure
from this layer to the webhook: slow flows simply consume webhook wall-clock time
against the 60 s `maxDuration`.

## Injection seams

This module has **no test seams of its own**, but it composes several modules that do:

- `__resetEnvForTests()` (`src/config/env.ts`) — clears cached env.
- `__setRedisForTests()` (session/redisClient per AGENTS.md) and the
  `MockupSheetStore` / `BlobUploader` injection seams in `tests/support/`.
- `__setAfterApprovalDeliverForTests` on the paid-approval delivery path
  (`src/mockup/paidGeneration.ts`).

Because `handleMessage` imports concrete functions (not injected ports), unit-testing
this module end-to-end requires those lower-level seams; `tests/` currently exercises
the pieces rather than this dispatcher itself (no live end-to-end conversation suite
exists — manual WhatsApp QA per README §6).

## Risks & observations

1. **In-memory rate limit / lock / dedupe are per-instance.** Under Vercel's
   concurrent-lambda model, bursty traffic from one chat can be processed in parallel
   across instances; the "busy" reprompt and 20/min flood gate only hold within a
   single warm instance. Documented Redis keys in AGENTS.md don't exist.
2. **`message: any` typing** — no compile-time guard on the WhatsApp payload shape;
   extraction chain silently yields `undefined` for unsupported types (e.g. document,
   audio, location), which then enter the order flow as "no input" (the flow's
   fallback copy handles it, but it's implicit).
3. **Paid-proof interception can swallow legit uploads** — any image sent while
   `mockupgen:pending:<chatId>` exists is consumed as a payment proof. If the customer
   instead uploads a new logo (e.g. restarting the flow), it is misinterpreted;
   mitigation is the fall-through when the generation no longer accepts proofs, and
   the pending marker is cleared by the workflow when consumed/expired.
4. **Admin fall-through** — a non-command message from an admin continues into the
   customer order flow with the admin's phone as the customer; intentional, but it
   means admins can accidentally create draft orders with their own chat.
5. **Init failure mode** — a missing env var throws on the *first message* of each
   cold start; customers see nothing (webhook 200-swallow), only logs/Sentry show it.
   `/api/health` is the pre-flight check for this.
6. Verbose per-step console logging (`rate limit allowed=`, `lock claimed=`,
   `calling handleWhatsAppMessage`, `completed`) — debugging aids, noisy in prod.
