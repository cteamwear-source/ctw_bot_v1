# Module Audit 04 — Session & State Management (`src/session/`)

> Knowledge-transfer review. Read `AGENTS.md` first for repo invariants; this document
> goes deeper on the session/state layer only. All facts below are taken directly from
> the source files listed under "Files covered" (verified against the working tree at
> the time of writing).

## Purpose

`src/session/` holds every piece of state the webhook bot needs to behave like a
stateless serverless app pretending to be a stateful conversation:

- **Dedupe** — WhatsApp retries webhooks; `claimUpdate()` ensures a message is
  processed at most once.
- **Per-chat lock** — a customer can spam messages while the bot is still working;
  `acquireChatLock()` serialises handling per chat.
- **Flood control** — `checkRateLimit()` caps each chat at ~20 messages/minute
  (PRD §5.3, §10.1).
- **Draft snapshot** — `saveDraft()`/`loadDraft()` mirror the collected order fields
  under `sess:<chatId>` so `/start` can offer "Resume my quote?" and abandoned
  conversations can be written as Lead rows, independent of the grammY
  `conversations()` plugin's own `conv:*` state.
- **Order ID generation** — `nextOrderId()` issues race-safe `CTW-YYMMDD-nn` ids via
  a Redis INCR daily counter (PRD §8.2).
- **Order snapshot store** — `saveOrderSnapshot()` persists the full `OrderData`
  under `order:<orderId>` so admin Confirm / mockup flows can recover everything the
  admin card caption does not carry.
- **Status machine** — `canTransition()` enforces the forward-only order-status
  transitions required by tech.md (PRD §8.1, §8.4).

Everything routes through the single injectable Redis accessor in `redisClient.ts`,
which is what lets the test suite (`tests/support/fakeRedis.ts`) run the whole layer
with zero network.

## Files covered

All eight expected files exist. **`src/session/redisStorageAdapter.ts` does NOT
exist** even though `AGENTS.md`'s repo-layout block lists it — the grammY
storages (outer session / conversations) are wired somewhere else (in
`src/bot/`), not as a file in this directory. Treat the AGENTS.md layout entry as
stale.

| File | Role |
|---|---|
| `src/session/redisClient.ts` | Lazy Upstash client + `RedisLike` subset + `__setRedisForTests` seam |
| `src/session/chatLock.ts` | Per-chat busy lock (`busy:<chatId>` semantics) — now in-memory |
| `src/session/dedupe.ts` | Webhook dedupe (`upd:<updateId>` semantics) — now in-memory |
| `src/session/draftStore.ts` | Order-draft snapshot `sess:<chatId>`, 24h TTL |
| `src/session/orderId.ts` | `CTW-YYMMDD-nn` generator, `oid:<YYMMDD>` Redis counter |
| `src/session/orderStore.ts` | Full `OrderData` snapshot `order:<orderId>`, 14-day TTL |
| `src/session/rateLimit.ts` | Per-chat sliding-window flood control — now in-memory |
| `src/session/statusMachine.ts` | Forward-only `OrderStatus` transition guard |

## 1. `redisClient.ts` — the single Redis entry point

### `RedisLike` interface

A deliberately minimal structural subset of the Upstash client surface:

```ts
interface RedisLike {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<string | null>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number | boolean>;
  del(...keys: string[]): Promise<number>;
}
```

The real `@upstash/redis` client is a structural superset, so anything typed
`RedisLike` (notably `tests/support/fakeRedis.ts`'s `FakeRedis`) is accepted
wherever these modules call `getRedis()`. Note the comment in the file: the
interface exists explicitly so mockup quota / generation-store modules (which
use `SET NX` and `EX`) can be tested without a network.

### `getRedis(): Redis`

- Returns the test override if one is installed (cast via
  `as unknown as Redis`).
- Otherwise lazily constructs a module-level singleton
  `new Redis({ url: env.REDIS_REST_URL, token: env.REDIS_REST_TOKEN })` from
  `getEnv()` (the fail-fast env validator, AGENTS.md invariant #4). Construction
  happens on first call, not at import time.

### `__setRedisForTests(fake: RedisLike | undefined)`

Test seam — replaces the client, or restores the real one when passed
`undefined`. Never called from production code. This is the seam every session
test uses; the mockup tests share the same seam (documented again in the
mockup-module audit).

## 2. `chatLock.ts` — per-chat busy lock

**Current implementation is a plain in-memory `Set<string>` named `localLocks`
with no TTL and no persistence:**

- `acquireChatLock(chatId): Promise<boolean>` — if `localLocks.has(chatId)`
  returns `false`, otherwise adds and returns `true`. The function is `async`
  (returns a Promise) purely to keep the old Redis call signature.
- `releaseChatLock(chatId): Promise<void>` — `localLocks.delete(chatId)`. Safe
  to call even if never acquired (documented in the JSDoc).

**Caller:** `src/bot/index.ts` only — `acquireChatLock()` at line 35 gates
message handling; `releaseChatLock()` runs at line 91 wrapped in
`.catch(() => {})`, i.e. release failures are swallowed (with an in-memory
`Set` they cannot happen).

### Doc-vs-code drift (important)

`AGENTS.md` describes `busy:<chatId>` as a **90-second Redis lock**. The git
history (commits `a8176f0` / `812131a`, "perf: optimize menu response latency")
replaced the Redis implementation with this in-memory one to eliminate network
latency on every message. Consequences a new dev must understand:

- **No TTL / no expiry.** If a handler crashes *without* reaching the
  `releaseChatLock()` path, the chat is permanently locked on this instance —
  the 90s Redis TTL previously self-healed that. (The `bot/index.ts` wrapper's
  try/finally shape matters; verify it before relying on this.)
- **Per-instance only.** On Vercel serverless, two concurrent invocations may
  land on different instances and both acquire the lock for the same chat, so
  the lock no longer guarantees global serialisation. Within one warm instance
  it is exact.

## 3. `dedupe.ts` — webhook dedupe

**Current implementation is an in-memory `Set<string>` (`seenUpdates`), capped
at `MAX_SEEN = 10000` entries.**

- `claimUpdate(updateId): Promise<boolean>` — returns `true` if this id has NOT
  been seen (safe to process). If the id is present → `false` (duplicate).
  Before adding, if `seenUpdates.size >= MAX_SEEN` the whole set is
  **cleared** (a full flush, not LRU eviction — a duplicate that arrives right
  after a flush would be reprocessed).
- Again `async` by legacy signature only.

**Call sites:** `api/webhook.ts` calls `claimUpdate(...)` twice — line 186 and
line 206 — and both are keyed on the **WhatsApp message id**
(`message.id`, a string like `wamid....`), *not* on the webhook's
`entry[].changes[].value.messages[].id`-vs-`update_id` distinction the module
JSDoc ("dedupe on update_id") suggests. The practical effect is the same
(per-message idempotence across WhatsApp's retry storms), but the naming drift
should be known: the AGENTS.md key table calls this `upd:<updateId>` (24h
Redis SETNX); none of that survives in the current code.

**Serverless caveat:** same instance-local caveat as the chat lock — dedupe
state evaporates on instance recycle and is invisible across instances, so a
retried webhook that hits a *different* warm instance will be processed again.
Downstream idempotence (draft resume-skip, `admin-action:` SETNX, generation
idempotency keys) is what actually protects money paths.

## 4. `draftStore.ts` — the order draft (`sess:<chatId>`)

The one session file still fully backed by Redis (plus a hot cache).

- **Key:** `sess:<chatId>` where `chatId` is the channel-prefixed id
  (`wa:919876543210`). **TTL:** `TTL_SECONDS = 24 * 60 * 60` (24h), applied on
  every write via `{ ex: TTL_SECONDS }`.
- **In-memory cache:** `memoryDrafts: Map<string, OrderDraft>` in front of
  Redis. `loadDraft()` returns the cached copy if present, otherwise reads
  Redis and populates the cache.
- **Cache invalidation on seam swap:** a module-level `lastRedisInstance`
  is compared via `checkRedisInstance()` at the top of every exported function;
  if `getRedis()` now returns a different object (i.e. tests swapped the fake),
  the entire `memoryDrafts` map is cleared. This is why tests can flip fakes
  without stale drafts leaking between cases.
- **`saveDraft(chatId, draft, persistToRedis = false)`**:
  - Always writes `{ ...draft, updatedAt: Date.now() }` into `memoryDrafts`
    first (so the caller's view is instantly consistent — the comment says
    "latency stays 0ms while navigating preset menus").
  - If `persistToRedis === true`, **awaits** the Redis `SET ... EX`.
  - Otherwise it fires a **non-blocking background** `redis.set(...)` and only
    `.catch()`-logs a warning — the happy path returns before Redis round-trips.
    A Redis failure therefore loses at most the last un-persisted step, not the
    conversation.
- **`clearDraft(chatId)`** — deletes from the cache **and** awaits
  `redis.del(sess:<chatId>)`. Called on flow completion/cancel.
- **`__clearMemoryDraftsForTests()`** — test seam to reset the cache.

`updatedAt` is what makes the `/start` "draft younger than 24h → offer Resume"
check possible (see `orderFlow.ts` resume step).

## 5. `orderId.ts` — `CTW-YYMMDD-nn` generator

- **Counter key:** `oid:<YYMMDD>` (e.g. `oid:250614`). **TTL:**
  `COUNTER_TTL_SECONDS = 48 * 60 * 60` (48h), and — importantly — the TTL is
  **refreshed on every call** (`incr` then `expire`), so the JSDoc's "survives
  just past midnight if needed" is a rolling 48h from the last order of the
  day, not from the first.
- **Date portion is UTC:** `todayYYMMDD()` uses `getUTCFullYear()`,
  `getUTCMonth()`, `getUTCDate()`, each `% 100` / `+1` then
  `padStart(2, "0")`. A chat ordering at 03:00 IST on the 15th gets the
  *previous* day's key if UTC still says the 14th — order ids can differ from
  the customer's calendar date. (Asia/Kolkata is used for mockup quota month
  keys; the order-id counter is UTC. The two conventions differ.)
- **Format:** `nextOrderId()` returns `` `CTW-${dateKey}-${seq}` `` where
  `seq = String(n).padStart(2, "0")`. Race safety comes free from Redis INCR
  (atomic). Edge cases:
  - Sequence ≥ 100 renders as 3 digits (`CTW-250614-100`) — cosmetic only, no
    parsing code depends on a fixed width.
  - If the `expire` call fails after a successful `incr`, the counter key
    persists **without TTL** (no rollback) — ids stay unique, the key just
    never expires until the date rolls over anyway (a new date key is used).
  - The INCR is not wrapped in any transaction; a crash between `incr` and id
    usage burns one sequence number. Harmless.

## 6. `orderStore.ts` — full-order snapshot (`order:<orderId>`)

Created (per its header comment) because the admin Confirm callback only
carries the order id embedded in the admin card caption — not enough to run
mockup generation, which needs `productId`, logo file ids and placements.

- **Key:** `order:<orderId>`. **TTL:** `TTL_SECONDS = 14 * 24 * 60 * 60`
  (14 days), commented as "long enough to cover any realistic
  admin-verification delay".
- `saveOrderSnapshot(order: OrderData)` — awaits `SET order:<orderId> <order>
  EX 1209600`. The **whole `OrderData` object** is stored (the Upstash client
  serialises to JSON and deserialises on `GET`).
- `loadOrderSnapshot(orderId)` — `GET`, returns `value ?? undefined`.

**Write sites** (`saveOrderSnapshot`, all with `.catch(...)` so a snapshot
failure never blocks the customer path):

| Site | Context |
|---|---|
| `src/admin/notify.ts:30` | At admin-card send time (`notifyAdmins`), logged on failure |
| `src/conversation/orderFlow.ts:731, 749, 991` | Mockup-step snapshots during S10 order assembly |
| `src/conversation/orderFlow.ts:1086` | Final order assembly before the quote/payment screen |
| tests + `scripts/test-*` | Fixture setup |

**Read sites:** `api/admin-approve.ts` (lines 90, 211), `api/mockup-delivery.ts`
(line 79, `.catch` → `undefined`), `src/admin/actions.ts` (line 79),
`src/mockup/deliverTrigger.ts` (line 47, `.catch` → `undefined`),
`src/mockup/paidGeneration.ts` (lines 189, 230, `.catch` → `undefined`), plus
scripts/tests. The `.catch(() => undefined)` pattern at the trigger sites means
a missing/expired snapshot degrades to "no snapshot" rather than throwing.

## 7. `rateLimit.ts` — per-chat flood control

**Current implementation is an in-memory sliding window** (`chatRateLimits:
Map<string, number[]>`):

- `WINDOW_MS = 60 * 1000`, `MAX_MESSAGES_PER_WINDOW = 20` (PRD §5.3/§10.1's
  "~20 msg/min", made exact).
- Algorithm (`checkRateLimit(chatId): Promise<boolean>`):
  1. `now = Date.now()`;
  2. take the chat's history (or `[]`);
  3. `valid = history.filter(ts => now - ts < WINDOW_MS)` — **filter-then-push**
     sliding window (per-message timestamps, not a fixed window bucket);
  4. if `valid.length >= 20` → return `false` **without recording the
     attempt** (a rejected message does not extend the window);
  5. otherwise push `now`, store back, return `true`.
- **No eviction of idle chats** — a chat whose window has lapsed keeps its
  (stale) timestamp array forever; entries only shrink on that chat's next
  message. Unbounded-ness is bounded in practice by real chat volume, but it is
  a slow leak across the instance's lifetime.
- **Caller:** `src/bot/index.ts:27` only. Rate limiting is applied to every
  inbound message before the chat lock is taken.
- AGENTS.md lists this as `ratelimit:ctw*` in Redis; the Redis version no
  longer exists. (The mockup subsystem has a **separate, still-Redis** limiter —
  `ratelimit:mockup*` in `src/mockup/rateLimit.ts` — do not confuse the two.)

## 8. `statusMachine.ts` — forward-only transitions

Pure function + error class, no I/O.

- **Transition table** (`ALLOWED_TRANSITIONS: Record<OrderStatus, OrderStatus[]>`):

  | From | Allowed to |
  |---|---|
  | `Pending Payment` | `Confirmed`, `Payment Issue` |
  | `Confirmed` | *(terminal)* |
  | `Payment Issue` | *(terminal)* |
  | `Lead — High-Value Callback` | *(terminal)* |
  | `Lead — No Payment` | *(terminal)* |
  | `Lead — Abandoned` | *(terminal)* |

  i.e. leads are terminal, payment may resolve either way, nothing moves
  backward, and nothing that has started payment can fall back into a lead
  state (module JSDoc).

- `canTransition(from, to)` — returns `false` when `from === to` (explicitly
  documented as "duplicate action, handled separately as a no-op"), otherwise
  `ALLOWED_TRANSITIONS[from]?.includes(to) ?? false`. The `?? false` also
  covers any unknown string slipping past the type system.
- `InvalidStatusTransitionError` — `Error` subclass; message format is
  exactly `` `Invalid status transition: "${from}" -> "${to}"` `` with
  `this.name = "InvalidStatusTransitionError"`.

**Adoption gap (risk):** as of this writing the module is imported only by its
own test (`tests/statusMachine.test.ts`). Production admin actions
(`src/admin/actions.ts`) mutate order status via
`updateOrderRowStatus` in `src/sheets/client.ts` **directly, without a
`canTransition` gate** — the forward-only guarantee currently lives in the
sheets writer's own behaviour and in the admin card design (buttons only offer
Confirm/Issue from `Pending Payment`), not in an enforced machine. The same is
true for the `MockupGenerationStatus` machine, which is *declared* in
`src/shared/types.ts` (see doc 05) and enforced by `src/mockup/workflow.ts`,
not by this file.

## Redis key conventions (this module + neighbours)

Keys owned by `src/session/`:

| Key | TTL | Written by | Notes |
|---|---|---|---|
| `sess:<chatId>` | 24h | `draftStore.saveDraft` | Draft snapshot; refreshed on every save |
| `oid:<YYMMDD>` | 48h (refreshed per INCR) | `orderId.nextOrderId` | UTC date key |
| `order:<orderId>` | 14 days | `orderStore.saveOrderSnapshot` | Whole `OrderData` JSON |
| `admin-action:<orderId>` | 90d (per AGENTS.md) | `src/admin/actions.ts` (line 40, and read at line 47) | Admin Confirm/Issue idempotency via SETNX — lives in `src/admin/`, documented here only because AGENTS.md groups it with session keys |

Keys that AGENTS.md *documents* under `src/session/` but which are now
**in-memory, not Redis** (see drift section): `upd:<updateId>`,
`busy:<chatId>`, `ratelimit:ctw*`.

Redis keys owned by the mockup subsystem (out of scope here, cross-referenced
from AGENTS.md's table): `ratelimit:mockup*`, `mockupquota:*`,
`mockupgen:*`. Those are covered in the mockup-module audit doc.

## Injection seams (tests)

| Seam | File | Purpose |
|---|---|---|
| `__setRedisForTests(fake \| undefined)` | `redisClient.ts` | Swap in `tests/support/fakeRedis.ts`'s `FakeRedis` (or restore the real client) for **every** module that goes through `getRedis()` — draft, orderId, orderStore, admin-action, and the mockup quota/generation stores |
| `__clearMemoryDraftsForTests()` | `draftStore.ts` | Reset the `memoryDrafts` cache between tests |

Note that `chatLock`, `dedupe` and `rateLimit` have **no seams** — their
in-memory `Set`/`Map` state is module-private and persists for the life of the
process. Tests that exercise the bot wrapper must therefore either avoid
colliding chat ids/update ids or accept the shared state (a known wart of the
perf rewrite).

## Execution flow (how the pieces sequence on one inbound message)

1. `api/webhook.ts` — secret check, then `claimUpdate(message.id)` (dedupe;
   done at both message-processing entry points, lines 186/206). Duplicates
   short-circuit.
2. `src/bot/index.ts` — `checkRateLimit(chatId)` (line 27): over-limit chats
   are rejected before any locking.
3. `src/bot/index.ts` — `acquireChatLock(chatId)` (line 35): second concurrent
   message for the same chat is refused while the first is being handled.
4. Conversation steps (`orderFlow.ts`) call `saveDraft(...)` after each step
   (memory-first; Redis awaited only on the designated persist points).
5. S10 order assembly calls `nextOrderId()` once per order, builds
   `OrderData`, and calls `saveOrderSnapshot(...)` (lines 991/1086) before the
   quote/payment screen.
6. On payment-screenshot receipt, `notifyAdmins` calls `saveOrderSnapshot`
   again (`src/admin/notify.ts:30`) then sends the admin card; admin
   Confirm/Issue callbacks later `loadOrderSnapshot(orderId)` to recover the
   full order for status updates and mockup work.
7. `releaseChatLock(chatId)` (line 91, errors swallowed) ends the turn.

## Error handling

- **Non-blocking draft saves** swallow Redis errors with a `console.warn`
  (`[draftStore] Non-blocking Redis save failed ...`) by design — latency over
  durability on the hot path; the memory cache still serves the running
  conversation.
- **`clearDraft` awaits `redis.del`** — a Redis outage here *will* throw into
  the caller (orderFlow's cancel/complete paths).
- **Order snapshots** are written with `.catch(...)` at every production call
  site (notify logs, orderFlow either logs or, at line 1086, logs an error
  before proceeding) — snapshot loss degrades admin/mockup recovery, never the
  customer quote.
- **`loadOrderSnapshot`** callers in the mockup/trigger paths wrap in
  `.catch(() => undefined)`; `api/admin-approve.ts` (lines 90/211) does not —
  a Redis error there propagates to the API handler.
- **Lock release** failures are swallowed (`.catch(() => {})`).
- **`nextOrderId`** — a failed `incr`/`expire` throws; order assembly must
  handle it upstream (there is no retry inside the module).
- **`statusMachine`** never throws; it returns booleans. `InvalidStatusTransitionError`
  is provided for callers that want to throw — currently only tests do.

## Risks & observations

1. **Doc-vs-code drift on three keys.** AGENTS.md/tech.md describe Redis
   `upd:<updateId>` (24h SETNX), `busy:<chatId>` (90s) and `ratelimit:ctw`;
   the code (post `a8176f0`/`812131a` "perf" commits) is in-memory for all
   three. The git history contains the original Redis implementations if a
   durable version is ever needed again. Anyone auditing against AGENTS.md
   will "not find" these keys — they are not missing, they were relocated.
2. **In-memory state is instance-scoped on Vercel.** Dedupe, the busy lock
   and the rate limiter all lose meaning across concurrent instances and reset
   on cold start. Money-adjacent idempotence is carried by Redis-backed
   mechanisms instead (`admin-action:` SETNX, generation idempotency keys,
   draft resume-skip) — keep it that way if extending.
3. **Chat lock has no TTL now.** A crash path that skips
   `releaseChatLock()` permanently locks that chat on the instance (the old
   90s Redis TTL self-healed). Review the try/finally shape in
   `bot/index.ts` before adding new early-return paths.
4. **`dedupe.ts` clear-on-full flush** means a burst >10k messages flushes
   the entire seen-set; duplicates older than the flush boundary would be
   reprocessed on the same instance. Practically unlikely, structurally real.
5. **`statusMachine` is advisory-only today.** No production caller enforces
   `canTransition`; sheets status writes are direct. If the forward-only
   invariant must be a hard guarantee, the gate needs to be wired into
   `src/admin/actions.ts` (or the sheets writer).
6. **`redisStorageAdapter.ts` referenced in AGENTS.md does not exist** —
   update the layout doc or restore the file; do not go looking for it.
7. **UTC vs Asia/Kolkata convention split:** order ids use UTC dates; mockup
   free-quota month keys use Asia/Kolkata. Around midnight IST the two
   disagree; this is intentional-ish but surprising.
8. **`checkRedisInstance` only exists in `draftStore`.** `orderStore`,
   `orderId` and the admin-action key go straight to `getRedis()` per call,
   which is why swapping the test fake works for them without any cache
   invalidation logic.
9. **No `expire`-on-`set` atomicity anywhere:** `nextOrderId` does
   `incr` then `expire` as two round-trips (a failure between them leaves a
   no-TTL key); `orderStore`/`draftStore` use the `EX` option on `SET`, which
   *is* atomic. Keep new counters aware of the two-step TTL pattern.
10. **`async` signatures on pure in-memory helpers** (`chatLock`, `dedupe`,
    `rateLimit`) are retained purely for call-site compatibility — they never
    await anything. Harmless, but don't be misled by the `Promise` returns
    into thinking there is I/O.

## Related tests

- `tests/statusMachine.test.ts` — full transition matrix + error message.
- `tests/support/fakeRedis.ts` — `FakeRedis` implementing `RedisLike`
  (including `nx`/`ex` semantics used by the mockup modules and
  `admin-action:`).
- Draft/orderId/orderStore behaviour is exercised indirectly by the mockup
  workflow/durability suites (`tests/mockupWorkflow.test.ts`,
  `tests/mockupDurability.test.ts`, `tests/adminApproval.test.ts`,
  `tests/adminEmailApprovalPortal.test.ts`) which seed snapshots via
  `saveOrderSnapshot`.
