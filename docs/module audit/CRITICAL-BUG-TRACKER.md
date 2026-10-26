# Critical Bug Tracker

> Source: `docs/module audit/` (audit date 2026-10-26). This tracker converts the
> audit's risk findings into an executable backlog. **Each fix runs in its own
> isolated session and touches exactly one issue (CB-xx).** Do not bundle fixes.

## Session protocol (read this first, every session)

1. Pick the next `⏳ pending` P0 issue in ID order (or the one you were dispatched for).
2. **Verify the bug in code first** — the audit may be slightly stale; confirm the
   exact lines before editing. If the bug no longer exists, mark it
   ` ✅ (not reproducible)` with a note and stop.
3. Make the **minimal, focused fix**. Respect `AGENTS.md` non-negotiable invariants
   (centralized pricing, one shared renderer, money never fails silently, env via
   `getEnv()`, forward-only status machines, click-first UX).
4. Add/extend tests in `tests/` following the existing Node test-runner style and
   `tests/support/` fakes.
5. Run `npm run typecheck` and `npm test` — both must pass before finishing.
6. Update the issue's row below: status `✅`, date, one-line summary of what changed.
7. Commit with message style `fix(<area>): <summary> (CB-xx)` — one commit per issue.

## P0 — Critical (security vulnerabilities, money-path invariant violations, crash bugs)

| ID | Title | Primary files | Audit ref | Status | Fixed | Notes |
|----|-------|---------------|-----------|--------|-------|-------|
| CB-01 | Stored XSS: unescaped customer fields in admin portal + order emails | `api/admin-approve.ts`, `src/admin/email.ts` | 12#4, 01#5 | ✅ | 2026-10-26 | Added `src/shared/html.ts` (`escapeHtml` + `jsonForScript`) and applied it at render time to every customer/order-derived field in the portal HTML and both email HTML templates (text fallbacks keep raw values); `sanitizeForSheet` semantics unchanged. |
| CB-02 | Money black hole: simulated email success (`ok:true`) suppresses WhatsApp admin fallback | `src/admin/email.ts`, `src/admin/notify.ts` | 12#1, overview §2 | ✅ | 2026-10-26 | `sendEmailWithResend` now returns `simulated:true` when `RESEND_API_KEY` is missing/blank/`re_test_dummy`; `notifyAdmins` and both OTP paths (`admin-approve` POST/GET `resend_otp`) treat it as not delivered and fan out on WhatsApp (portal shows a warning banner, logs say "simulated"), with tests for simulated⇒fallback and real⇒no-fallback. |
| CB-03 | Unauthenticated `/api/health` leaks admin emails / key prefixes and triggers outbound email via `?test_resend=1` | `api/health.ts` | 01#6, overview §3 | ✅ | 2026-10-26 | `envStatus` reduced to presence booleans + `adminEmailsConfigured` count (emails/sender/prefixes removed); `?test_resend=1` now requires `INTERNAL_MOCKUP_SECRET` via `x-internal-secret` header or `?secret=` query param (timing-safe compare, 401 on mismatch, 503 fail-closed when unset) — covered by `tests/healthEndpoint.test.ts`. |
| CB-04 | Weak `ADMIN_PORTAL_SECRET` fallback (hardcoded `"ctw-portal-secret-key"`, reuses webhook secret) + trigger/endpoint secret asymmetry | `src/config/env.ts`, `src/mockup/deliverTrigger.ts` | 12#5, 03#1, 01#4, 10#7 | ✅ | 2026-10-26 | Removed the hardcoded `"ctw-portal-secret-key"` default — `getEnv()` now throws a clear validation error when neither `ADMIN_PORTAL_SECRET` nor `META_WEBHOOK_SECRET` is set (documented fallback chain kept for existing deployments); `deliverTrigger` sends only `INTERNAL_MOCKUP_SECRET` and skips the dispatch with a loud error when unset (endpoint stays fail-closed) — covered by `tests/envSecrets.test.ts`. |
| CB-05 | Unauthenticated heartbeat cron lets anyone trigger admin pings | `api/heartbeat.ts`, `vercel.json`, `src/config/env.ts` | overview §3, 01 | ⏳ pending | | Require `CRON_SECRET` (Vercel cron `Authorization: Bearer` pattern) and/or `x-vercel-cron` header; verify `vercel.json` crons config passes the secret. |
| CB-06 | Mockup free-quota phone counter has no month key → "monthly" allowance behaves as annual (billing correctness) | `src/mockup/quota.ts` | 10#1 | ⏳ pending | | `quotaCounterKey` must fold `monthKey` into the phone key (`mockupquota:phone:<last10>:<month>`). Update `tests/mockupQuota.test.ts`. |
| CB-07 | Quota cross-generation race: non-atomic `reserveGeneration` allows concurrent free double-spend | `src/mockup/quota.ts` | 10#2 | ⏳ pending | | Close the read-then-write window (atomic INCR-based check or short Redis SETNX lock per bucket) while preserving commit-on-success / no-consume-on-reservation semantics. Add a concurrency test. |
| CB-08 | Admin confirm/issue wedges order 90 days on sheet failure: claim (`admin-action:<id>`) committed before sheet update, error swallowed | `src/admin/actions.ts`, `api/admin-approve.ts` | 12#2, 12#3, 11#6 | ⏳ pending | | On sheet-update failure, best-effort delete the `admin-action:<orderId>` claim so a retry can succeed (both WhatsApp + portal paths). DM failure after a successful sheet write must NOT revert. |
| CB-09 | Dynamic UPI QR dead-coded (`if (false)`), static QR + hardcoded third-party Blob URL fallback; copy promises pre-filled amount | `src/conversation/orderFlow.ts`, `src/qr/*`, `src/storage/blob.ts` | 08#1, 06#3, 06#5, overview §2 | ⏳ pending | | Generate the QR from the real `advanceDue` (+ order note), upload via the Blob wrapper, send it; fall back to `STATIC_QR_URL` only when explicitly configured; delete the hardcoded third-party URL and the `if (false)` block. Tests must keep passing. |
| CB-10 | PII in logs: full raw WhatsApp message payloads logged; `metaClient` logs recipient phone numbers | `src/conversation/orderFlow.ts`, `src/whatsapp/metaClient.ts` | 06#2, 13#11, overview §3 | ⏳ pending | | Remove/replace raw-payload logging with minimal metadata (message type + chat id); mask phone numbers in metaClient logs to match webhook policy. |
| CB-11 | Gemini client: API key in URL query string (leaks into logs) and no timeout (can burn delivery worker's 120 s budget) | `src/mockup/geminiClient.ts` | 09#5, 09#6, overview §3 | ⏳ pending | | Move key to `x-goog-api-key` header; add AbortController timeout (align with OpenAI client's 90 s style, but ≤ delivery budget). |
| CB-12 | Sample orders crash the Sheets writer: `orderToRow` calls `getPrintMethod(undefined)` → throws while customer card renders fine | `src/sheets/client.ts`, `src/conversation/orderFlow.ts` | 05#1, 06#4 | ⏳ pending | | Guard `orderToRow` for missing `printMethod` (skip print columns) and/or stop building sample `OrderData` with a `printMethod!` non-null assertion. Add a regression test for a sample order row. |

## P1 — High (fix after P0; not part of this pass)

- OTP brute-force window on portal (no attempt counter) — 12#11
- `resend_otp` state change on GET + token-in-URL leakage — 12#7
- No size cap on Meta media downloads (memory pressure) — 13#3
- Non-idempotent Orders sheet append under retry (duplicate rows) — 11#1
- Chat lock has no TTL; in-memory dedupe clear-on-full — 04#3, 04#4
- `health`/webhook ACK ordering; dedupe-before-handle drops on transient failure — 01#2, 01#3
- Media chain single timeout; hard-coded graph.facebook.com first hop — 13#1, 13#2
- Hardcoded default admin email `cteamwear@gmail.com` in three places — 03#2
- MIME sniffing asymmetry (gemini misses WebP) — 09#7
- `decidedByChatId` records `"Admin"` instead of real admin id — 10#8
- Misleading OTP-expiry copy ("2 minutes" for 30-min order codes) — 12#9

## P2 — Medium / hygiene (backlog)

- In-memory dedupe/lock/rate-limit are per-instance (accepted perf trade-off; document or restore Redis) — 02#1, 04#1
- Draft persistence fire-and-forget (draft-loss window) — 06#1
- Generated catalog not wired into live flow; `catalogVersion: "v1"` fiction — 07#1, 06#10
- `assets/catalog` not committed/shipped (`includeFiles` missing) — 14
- `.env.example` stale (Telegram-era); webhook scripts target `api.telegram.org` — 14
- `package.json` still says "Telegram bot" — 14
- AGENTS.md/README staleness (steps dir, keyboards, admin buttons, quota default, `redisStorageAdapter`)
- `AGENTS.md` quota default (3) vs code default (1) — 03#3
- AI cost tracking untracked (`costUsd: 0`/`undefined`) — 09#10
- `isMockupEligible` stub; `"catalog-exact"` dead union member — 09#1, 09#2
- Email money formatting duplicated outside shared renderer — 05#2
- Loose keyword `includes` matching ("call" aborts orders) — 06#6
- Phone-step UX hole (no re-prompt on invalid input) — 06#7
- `peekUsage` fallback hardcodes "3 remaining" — 10#13
- `issue` on arbitrary ids claims Redis keys and reports success — 12#10
- Secondary OTP banner leaks code into HTML — 12#16
- `sendTemplate` / `renderAdminCard` dead code decisions — 13#7, 12#8
- Sheets header-drift validation; duplicated retry helpers — 11#3, 11#4
- Legacy naming (`ZaptiloWebhookPayload`, Telegram comments) — 13#9
- `HIGH_VALUE_CALLOUT_QTY` constant unused — 08#6
- Test-env duplication; fetch stub narrow; FakeRedis TTL fidelity — 15

---
*Tracker created 2026-10-26 from the module audit. Update rows per the session protocol.*
