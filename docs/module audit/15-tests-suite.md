# Module Audit 15 — Test Suite

> Companion to the module audits of `src/` and `api/`. This doc explains how tests run,
> what the test doubles in `tests/support/` actually fake (and what they deliberately
> don't), what each of the 20 test files proves, and where the coverage gaps are.
>
> All statements below were verified against the source on 2026-10-26. At that commit
> `npm test` runs **134 tests across 20 files, all green** in ~22–33 s on Windows.

## Purpose

The suite is a pure **unit/integration test layer over the domain logic** — no live
WhatsApp, Redis, Sheets, Blob, or AI-provider traffic ever happens. It exists to lock
down the invariants that money and correctness depend on: pricing math, the forward-only
status machines, formula-injection sanitizing, catalog referential integrity, and the
whole mockup quota / approval / durability state machine. It is explicitly *not* an
end-to-end conversation test (see "Coverage gaps").

## Test runner setup

There is **no jest, no vitest, no mocha, no coverage tool**. The suite uses Node's
built-in test runner (`node:test`) executed through tsx:

```jsonc
// package.json
"scripts": {
  "test": "node --import tsx --test \"tests/**/*.test.ts\"",
  "typecheck": "tsc --noEmit",
  "lint": "tsc --noEmit"
}
```

Consequences of this choice:

- Each test file is a separate Node process (the runner forks/streams per file), so
  **module-level state doesn't leak between files** — but it *does* leak between tests
  inside a file, which is why every stateful test file resets its fakes in
  `beforeEach`.
- Assertions use `node:assert/strict` (`assert.equal`, `assert.deepEqual`,
  `assert.throws`, `assert.rejects`). There is no expect/snapshot DSL.
- `beforeEach` (and `afterEach` where used) are imported from `node:test`, not globals.
- TypeScript is transpiled on the fly by tsx; there is no build step and no type
  checking during `npm test` (run `npm run typecheck` separately — it is also aliased
  as `lint`).
- The glob is quoted so Node expands it (Windows cmd doesn't expand globs).
- **No CI pipeline exists** — there is no `.github/` directory, so the suite only runs
  when someone runs `npm test` locally.

Import order matters: `tests/support/testEnv.ts` must be the **first import** in any
test that transitively reaches `getEnv()` (see below), because `getEnv()` validates
and caches env at cold start.

## Support fakes in depth (`tests/support/`)

Three helpers back the entire suite.

### `testEnv.ts` — env bootstrap + fetch stub

Runs at import time and does two things:

1. **Fills every env var `getEnv()` requires** with throwaway values, but only if not
   already set (`if (!process.env[k])`), so a developer's real `.env` won't leak in:

   | Var | Test value | Note |
   |---|---|---|
   | `CHANNEL` | `whatsapp` | |
   | `TELEGRAM_BOT_TOKEN` | `123456:TEST-token` | legacy-name env var still required by `env.ts` |
   | `WEBHOOK_SECRET` | `test-webhook-secret` | |
   | `ADMIN_CHAT_IDS` | `999` | single admin |
   | `MERCHANT_VPA` / `STATIC_QR_URL` | `test@upi` / `https://example.com/qr.png` | |
   | `REDIS_REST_URL` / `REDIS_REST_TOKEN` | example upstash URL / `test-redis-token` | never dialled — Redis is faked |
   | `GOOGLE_SERVICE_ACCOUNT_JSON` | minimal fake JSON | Sheets never touched |
   | `SHEET_ID` | `test-sheet-id` | |
   | `MOCKUP_FREE_PER_MONTH` | **`1`** | deliberately lower than prod default `3` so quota tests stay short |
   | `MOCKUP_PAID_PRICE_INR` | `20` | |
   | `META_API_TOKEN` / `META_PHONE_NUMBER_ID` / `META_BUSINESS_ACCOUNT_ID` / `META_WEBHOOK_SECRET` | test doubles | |

2. **Stubs `globalThis.fetch`**: any request whose URL contains `graph.facebook.com`
   returns a canned `{ messages: [{ id: "mock_wamid_test" }] }` 200; every other URL
   passes through to the real fetch. So a test that accidentally reaches the WhatsApp
   Graph API gets a harmless mock instead of a real send — but a test that reaches
   *any other* host (OpenAI, Upstash REST, Google) would still make a real call. The
   mockup tests avoid this by injecting fakes rather than relying on the stub.

Because it assigns `process.env` before `getEnv()` first runs, importing
`testEnv.js` first is load-bearing. Note it exports nothing (`export {}`) — it's
imported purely for side effects.

### `fakeRedis.ts` — `FakeRedis implements RedisLike`

An in-memory `Map`-backed fake faithful to the *semantics the app depends on*, not to
real Redis:

- **`set(key, value, { nx })`** — SETNX is honoured: with `nx` and an existing key it
  returns `null`; otherwise writes and returns `"OK"`. This is what makes all the
  idempotency tests (admin-action dedupe, quota decisions, generation records) work.
- **`set(key, value, { ex })`** — records the TTL in a side `ttlMap`, **but never
  expires anything in-test**. Time does not advance; a key with `ex: 60` stays
  readable for the whole test. `ttl()` returns the recorded seconds, or `-2` if the
  key has no TTL recorded.
- **`expire(key, s)`** — records a TTL, returns 1 if the key exists, 0 if not.
- **JSON round-trip** — every value is stored as `JSON.stringify` and returned via
  `JSON.parse`, mirroring `@upstash/redis`'s automatic JSON serialisation. `get()`
  falls back to the raw string if the value isn't valid JSON.
- **`incr(key)`** — treats a missing key as 0 (matches Redis), stores and returns the
  incremented number. Used by the order-id counter.
- **`del(...keys)`** — deletes from both maps, returns count.
- **`keys()`** — extra helper (not part of `RedisLike`) for raw inspection.

Because TTLs never expire, **no test can prove that a 24h session, 90s chat lock, or
60d generation record actually lapses** — only that a TTL was requested. This is the
single most important limitation of the fake (see "Coverage gaps").

### `fakeSheetStore.ts` — `FakeSheetStore implements MockupSheetStore`

An in-memory stand-in for the Google Sheets *MockupGenerations* tab:

- Backed by `Map<generationId, MockupGenerationsRow>` — **one row per Generation ID**,
  so `create` on an existing id overwrites rather than duplicates (real Sheets would
  append a second row, which is why the *production* code must look-before-create;
  the fake's `createCount`/`updateCount` counters are how tests prove the production
  code chose `update` over a second `create`).
- `rowCount` getter exposes total distinct rows.
- `find(generationId)` returns the stored row or `undefined`.

It implements only `MockupSheetStore` — the *Orders* and *CatalogSelections* tabs
(`MockupSheetStore`'s siblings in `src/sheets/`) have **no fake** and are not covered
at the client level.

### Injection seams used by tests

The app modules expose `__...ForTests` hooks purely for the suite (test-only exports,
not reachable from production call sites):

| Seam | Module | Purpose |
|---|---|---|
| `__setRedisForTests(redis)` | `src/session/redisClient.ts` | swap the whole Redis surface (the most-used seam) |
| `__setMockupSheetStoreForTests(store)` | `src/sheets/mockupGenerations.ts` | swap the audit-sheet store |
| `__setAfterApprovalDeliverForTests(fn\|undefined)` | `src/mockup/paidGeneration.ts` | replace the post-approval dispatch (which in prod fires an HTTP call to `/api/mockup-delivery`) with an inline synchronous run; reset to `undefined` in `beforeEach` to stop leaks |
| `__resetEnvForTests()` | `src/config/env.ts` | clear the cached env so a test can vary `META_API_TOKEN` etc. (used by `mockupOpenAi.test.ts`) |

A recurring pattern (`mockupWorkflow.test.ts`, `mockupDurability.test.ts`): tests
build a `MockupDeliveryDeps` bag of **capture fakes** — a fake compositor that counts
produced images instead of doing Sharp work, a fake `BlobUploader` returning
`https://blob.example/...`, a fake `sendPhoto` capturing filenames, and a
`fetchLogo` returning a `FAKE_PNG` buffer with a valid PNG magic number so
`validateLogoFile` accepts it — then assert on the captured counters. This lets them
exercise the *real* control flow of `startMockupGeneration` / `deliverMockupForOrder`
with zero I/O.

Note several fixtures still carry **Telegram-era names/ids** (`tg:5512345678`,
"prevents Telegram delivery") even though `channel: "whatsapp"` — harmless, but
confusing when reading tests.

## Per-test-file reference

20 files, 134 tests.

| File | Tests | What it proves | Notable edge cases |
|---|---|---|---|
| `pricing.test.ts` | 13 | The central pricing engine's math (PRD ACs tagged inline) | MOQ gate (AC2); bracket boundaries (AC12); advance = `Math.ceil(50%)` so odd totals never under-collect; Call Me hidden at 300 / shown at 301 (AC3); even + standard-mix splits sum *exactly* to qty (AC11); trial kit is 100% not 50%; variant rates from `pricing_options_template.csv` |
| `sanitize.test.ts` | 5 | Input sanitizers | Strips leading `= + - @` formula injection (AC7); name/city length caps; phone normalisation accepts `+91`/`0` prefixes; rejects invalid numbers; qty validation |
| `statusMachine.test.ts` | 4 | Forward-only order status machine | Terminal states reject everything; duplicate/no-op transitions rejected; backward transitions rejected |
| `catalog.test.ts` | 16 | The generated catalog manifest loads and is referentially closed | Every `groupId`/`itemId`/`variantId` resolves; validators reject unknown ids and cross-tier misuse; **placeholder-kind variants have no `localPath`** (never falsely "resolvable"); `resolveCatalogAssetPath` lands under `assets/catalog`; `variantHasDistinctImage` false for placeholder, true only when variant image ≠ item preview |
| `catalogDownloads.test.ts` | 4 | The catalog-download menu | All 12 PDFs present with valid Drive links; ordered rendering; COPY matches render; brand-keyword lookup |
| `catalogSelectionPersistence.test.ts` | 4 | Sheet row mapping for catalog selections | Every header column mapped; identity fields preserved exactly; tolerates colourless item; never throws on a minimal selection |
| `navigation.test.ts` | 7 | `determineStep`/`rollbackStep` over the draft | Sequential progress for both bulk and sample-kit flows; rollback at start returns false; rollback step-by-step; **auto-skipped single-quality items** handled on rollback; rollback strictly blocked from payment when a mockup was generated |
| `orderFlow.test.ts` | 8 | End-to-end conversation drives the real `orderFlow` | Greeting's 3 menu buttons incl. catalog download; catalog list + direct brand link; full bulk workflow to payment; sample-kit 100% payment; below-MOQ rejection clears draft; invalid phone reprompts without advancing; cancel → confirm → clears draft |
| `render.test.ts` | 4 | Quote/admin card rendering | Terminology lock: says "T-Shirt", never "garment"; bulk card shows pricing + size split + 50% advance; sample kit shows 100% |
| `mockup.test.ts` | 6 | Deterministic compositor's zone mapping | Every product maps to a known silhouette; each placement → exactly one view; left/right sleeve are mirrored but distinct; logo lands in the `left_chest` zone; upper_back renders the back view; output dims = template dims |
| `deterministicMockup.test.ts` | 3 | Pixel-exactness of the Sharp composite | Pixels **outside** the zone are byte-identical to the reference; a point *just outside* the box stays reference colour; front-only=1 output, front+back=2; legacy order uses the generic template |
| `exactGarmentMockup.test.ts` | 8 | Garment-reference resolution feeding the AI provider | All orders mockup-eligible; legacy (no catalog data) handled; the **white-shirt template bytes** are what reach the provider; brand/style/colour woven into the prompt; 1 image per view; order resolves the white silhouette template |
| `promptBuilder.test.ts` | 5 | AI mockup prompt construction | `getColorHex` resolves vision-extracted hexes; commercial studio lighting/photo specs present; white garments without logical contradictions; fabric texture adapts per garment; sleeve instructions only on the relevant view |
| `mockupOpenAi.test.ts` | 6 | OpenAI image provider client | Throws when no API key configured (via `__resetEnvForTests`); calls `/v1/images/edits` and parses `b64_json`; provider selectable by default/explicit value |
| `mockupQuota.test.ts` | 8 | Monthly free-quota accounting | **Reservation alone doesn't consume a slot — only commit does**; first success free, next paid (₹10 single / ₹20 front+back); quota per phone number; same `generationId` replays the identical decision (no re-charge); commit idempotent; paid stays paid (sticky); **month key uses Asia/Kolkata, not UTC**; per-chat fallback isolation when phone absent |
| `mockupWorkflow.test.ts` | 10 | The whole free/paid/approval state machine via `startMockupGeneration` | Free path durably stores; front+back = 1 generation, 2 stored images; **paid path generates nothing until approval**; approval generates, rejection never does; duplicate Approve doesn't regenerate/recharge; Reject-after-Approve refused; duplicate payment proof doesn't advance twice; two concurrent admins generate exactly once; completed generation returns cached URLs instead of regenerating |
| `mockupDurability.test.ts` | 5 | Failure/rollback behaviour of the same pipeline | Storage failure prevents (Telegram-named) delivery; failed free generation **releases the slot** — retry with same id stays free; a brand-new request after failure also stays free (failure didn't burn a slot); duplicate triggers update ONE sheet row (no dupes); paid generation stays ₹20 across an internal-failure retry (no second charge) |
| `mockupTiming.test.ts` | 4 | Structural ordering guarantees (no runtime clock) | Order id created → mockup step → payment, in that order; admin confirm handler no longer triggers a post-payment mockup (moved earlier in flow); **mockup generation never runs inline in the webhook budget**; over-quota path tells the *customer* payment is required |
| `adminApproval.test.ts` | 7 | The 6-digit admin approval-code flow | 6-digit code creation + single consumption; invalid code → null; `isAuthorizedAdmin` normalises `wa:`/`+` prefixes; a plain button click on Confirm is **rejected and prompts for the code**; direct `CONFIRM <orderId>` command likewise rejected; valid code confirms + DMs the customer; invalid/expired code rejected without confirming |
| `adminEmailApprovalPortal.test.ts` | 7 | The HMAC-token + OTP email approval portal | Token creation/verification round-trip; secondary OTP with cooldown fail-safe; GET rejects missing/invalid tokens; GET renders order details + OTP modal + fail-safe buttons; POST confirm validates OTP and confirms; POST `resend_otp` issues the fail-safe code; `notifyAdmins` snapshots the order + generates the OTP and **does not** send a WhatsApp approval to admins |

## Coverage gaps

What the suite does **not** cover, roughly in order of risk:

- **No end-to-end conversation test.** `orderFlow.test.ts` drives the flow module
  directly, but nothing exercises `api/webhook.ts`'s request path end-to-end: webhook
  signature verification, update dedupe (`upd:` SETNX), the fast 200-ACK, API
  timeouts, and the top-level `bot.on("message")` router in `src/bot/index.ts` are
  all untested. AGENTS.md itself flags a mock-transport e2e suite as a "known good
  future addition".
- **Time-dependent logic is untestable with the current fake.** `FakeRedis` records
  TTLs but never expires keys, so session expiry (24h), the chat-lock TTL (90s), the
  dedupe window, admin-action idempotency windows (90d), and generation-record TTLs
  (60d) are only ever tested as "a TTL was requested", never as "the key lapsed".
  Likewise the daily `oid:` counter rollover and the Asia/Kolkata month boundary are
  tested only via injected keys, not by advancing a clock.
- **`src/session/rateLimit.ts` has zero tests.** It's an in-memory sliding-window
  limiter with no injection seam — nothing in the suite proves its windowing,
  counter reset, or behaviour under burst.
- **Google Sheets client layer untested** beyond the mockup fake: `src/sheets/client.ts`,
  `safeAppend`, and the Orders/CatalogSelections writers (including the
  sheet-write-failure escalation path where the full order is sent to admin as text)
  have no fake and no tests — yet AGENTS.md invariant #3 says money events must never
  fail silently, making this the highest-value missing coverage.
- **`api/webhook.ts` + `api/mockup-delivery.ts` handlers** (secret check, `x-internal-secret`
  timing-safe compare, 200-ACK-on-error) are untested; the only structural guard is
  `mockupTiming.test.ts`, which reads the flow to assert generation isn't inline.
- **The catalog generation pipeline (`scripts/generate-catalog.ts`, 885 lines) has
  no tests** — its output is tested (`catalog.test.ts` checks referential integrity
  of whatever manifest exists), but a PDF layout change that mis-parses items would
  pass the suite as long as ids still resolve.
- **Webhook/crypto surface**: HMAC token verification is covered for the approval
  portal, but the webhook signature check and the UPI QR generation (`src/qr/`) are not.
- **No coverage measurement.** Node's test runner supports `--experimental-test-coverage`
  but it isn't wired into `npm test`, so there is no coverage number to track and no
  gate.
- **No CI.** Without a `.github/` workflow, nothing prevents a red suite or a
  typecheck error from being committed; the only enforcement is running `npm test` /
  `npm run typecheck` by hand.

## Risks & observations

- **`testEnv.ts` duplicates `env.ts`'s required-var list by hand.** If a new required
  env var is added to `src/config/env.ts` and not mirrored here, tests that reach
  `getEnv()` will fail with a validation error — but only the tests that touch it, so
  the breakage can look scattered rather than obvious.
- **The fetch stub is narrow.** Only `graph.facebook.com` is intercepted; any test that
  reaches another host would perform a real network call. Current tests avoid this via
  injected fakes, but a future test could silently dial OpenAI/Upstash.
- **`FakeRedis` TTL semantics diverge from reality** (documented above) — the single
  biggest fidelity gap. If you're adding logic that depends on a key expiring, you
  must add a fake-clock mechanism first, or the test will pass while production breaks.
- **`FakeSheetStore.create` overwrites instead of appending**, so it can't detect the
  real "duplicate row on retry" failure mode on its own; tests must assert via
  `createCount`/`updateCount` to be meaningful. Keep that in mind when writing new
  sheet-related tests.
- **Test-only exports (`__...ForTests`) are part of production bundles** — they're
  normal exports of `src/` modules, not stripped in the Vercel build. They're
  unreachable from production call sites but technically callable; don't repurpose them
  for non-test injection.
- **Telegram-era leftovers in test names/fixtures** (`tg:` chat ids, "prevents
  Telegram delivery") — cosmetic, but they make the WhatsApp-era behaviour harder to
  read.
- **Slow-ish suite.** Several mockup tests do real Sharp work (`mockup.test.ts`,
  `deterministicMockup.test.ts` composite actual pixels), which is why the run takes
  22–33 s. That's the price of pixel-exactness assertions; the workflow tests avoid it
  with the capture-compositor pattern.
- **The one scary log line is intentional.** A full `npm test` run prints
  `Failed to update sheet on confirm Error: error:1E08010C:DECODER routines::unsupported`
  — that's an adminApproval test deliberately exercising the sheet-write-failure
  fallback path (the fake TLS-ish error is thrown by the injected store), not a real
  failure. It's non-fatal, but it looks alarming if you don't know why it's there.
- **Coverage gaps cluster around the I/O boundary** — precisely where AGENTS.md
  invariants #3 (money never fails silently) and #5 (security gates) live. If only one
  thing is added to this suite next, make it a fake Sheets client + tests for the
  order-append and escalation paths.
