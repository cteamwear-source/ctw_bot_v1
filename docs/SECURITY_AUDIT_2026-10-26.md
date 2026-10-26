# Security audit: public launch readiness (2026-10-26)

Scope: `api/*` endpoints, `src/` (admin, mockup, session, sheets, whatsapp, shared), deploy config (`vercel.json`, `.vercelignore`), dependencies (`npm audit`), git history and local repo config. Baseline: 166 tests passing. After fixes: 181 passing (15 new in `tests/securityHardening.test.ts`), `npm run typecheck` clean.

No secret values are reproduced in this document.

## Fixed in code

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Critical | `/api/webhook` accepted unsigned POSTs whenever `META_APP_SECRET` was empty, and it is empty in the production env file. Admin rights are decided by the sender phone in the payload, so anyone could forge messages "from" an admin (flag orders as Payment Issue, guess WhatsApp approval codes, approve/reject paid mockups) or from any customer (make the bot message arbitrary numbers). | Production now fails closed (503) unless `META_APP_SECRET` (HMAC) or the new `META_WEBHOOK_URL_TOKEN` (`?token=` on the registered webhook URL, ≥24 chars) is set. Bodies over 1 MB get 413. GET handshake uses a timing-safe compare and echoes only a sanitized challenge. |
| 2 | High | `triggerMockupDelivery` ran generation in-process via `deliverMockupForOrder`, which never reserves quota. No quota decision existed, so `commitFreeGeneration` was a no-op: every customer got unlimited free AI mockups (OpenAI cost), and the call could block the webhook for up to 90s. | Removed the in-process leg. Generation always goes through `/api/mockup-delivery` → `startMockupGeneration` (quota + ₹20 paid flow). |
| 3 | High | Free-mockup quota was keyed only on the typed contact phone when present. Typing a different phone per order reset the allowance. | Quota is measured as the max of the WhatsApp-sender counter and the typed-phone counter; a free commit increments both. `wa:` prefixes are normalized. |
| 4 | High | Admin portal OTP: unlimited guesses, codes looked up globally (a wrong guess could match and burn another order's code), and when email was unconfigured or failed the code was printed in the portal page and JSON. The link alone was enough to confirm a payment. | Codes are checked against the portal's own order only, 5 wrong guesses burn the code, fresh codes are capped at 10 per order per day, and codes are never returned to the browser (fallback goes to admin WhatsApp). |
| 5 | Medium | Portal pages (token in URL) had no security headers. The payment-screenshot `<img>` leaked the full tokenised URL to the Blob host via `Referer`. | `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, CSP with a script nonce, `X-Frame-Options: DENY`, `nosniff`, `noindex`. |
| 6 | Medium | `sanitizeForSheet` stripped `= + - @` before trimming, so `" =HYPERLINK(...)"` became `=HYPERLINK(...)`. `google-spreadsheet` writes with USER_ENTERED, so formulas execute in the CRM. | Leading whitespace is stripped together with formula characters. |
| 7 | Medium | `/api/heartbeat` was open because `CRON_SECRET` is not set in production: anyone could spam every admin number. | Production returns 503 without `CRON_SECRET`. |
| 8 | Medium | `notifyAdminsText` logged full messages, including approval codes and token-bearing portal URLs, to Vercel logs. The simulated-email log printed OTP subjects. | Codes and `token=` values are redacted before logging. |
| 9 | Low | Media download buffered any size (WhatsApp documents up to 100 MB) and interpolated the media id into a URL called with the bearer token. | 16 MB cap (Content-Length precheck + post-check); media ids restricted to `[A-Za-z0-9_-]`. |
| 10 | Low | `.vercelignore` did not exclude `.env`, `.env.client`, `.env.vercel`, `.env.test` (Vercel's defaults only skip `.env.local` / `.env.*.local`), so CLI deploys uploaded them as deployment source. | Excluded `.env*` and local tooling folders. |
| 11 | High (dep) | `sharp` < 0.35.5 (librsvg CVE); `brace-expansion`. | `sharp@0.35.5`; `npm audit fix` (non-breaking). |

## Needs action from you (not code)

1. **GitHub token in the `origin` remote URL** (`.git/config`). Revoke it at GitHub → Settings → Developer settings → Tokens, then run `git remote set-url origin https://github.com/surajlm925-bit/custom_team_wear.git` and use Git Credential Manager.
2. **OpenRouter API key in git history.** Commit `6ec00f5` hard-coded a base64-encoded `sk-or-v1-…` key as `FALLBACK_KEY`; the commit is on `origin/main` and `client/main`. Revoke it in the OpenRouter dashboard. Rewriting history is optional once the key is dead.
3. **Set production env vars before deploying this build** (otherwise the webhook and heartbeat return 503 by design):
   - `META_APP_SECRET`, or, if Emovur does not forward `X-Hub-Signature-256`, `META_WEBHOOK_URL_TOKEN` and register the webhook as `https://ctwbotv1.vercel.app/api/webhook?token=<value>`.
   - `CRON_SECRET`.
4. **`MOCKUP_FREE_PER_MONTH` is not set in production**, so the code default of 1 applies. Your confirmed decision and `.env.example` say 3.

## Open risks (not fixed)

- **Dedupe, rate limit and chat lock are in-memory** (`src/session/dedupe.ts`, `rateLimit.ts`, `chatLock.ts`), so they do not hold across Vercel instances. A Meta retry landing on another instance can process the same payment screenshot twice (duplicate sheet row and admin alert). The flood limit is per instance only. `plan.md` task T2 already covers moving these to Redis.
- **Payment screenshots are public Vercel Blob objects** (`proofs/…`). The URLs are hard to guess (timestamp + media id) but never expire.
- **"Flag Payment Issue" in the portal needs only the link**, not the OTP. Low impact (reversible, admin-visible).
- **`npm audit` still reports** `@vercel/node` (used only for types and the local dev server) and `@vercel/functions` → `@vercel/oidc` → `zod`. Fixes require major-version changes; neither path handles attacker input at runtime.
- **`/api/health?test_resend=1&secret=…`** accepts `INTERNAL_MOCKUP_SECRET` in the query string, which ends up in request logs. Prefer the `x-internal-secret` header.
- Payment verification stays manual by design: a forged screenshot is caught only by the admin checking the bank/UPI statement.

## Verified behaviour (tests)

`tests/securityHardening.test.ts`: webhook 503/401/200 matrix for HMAC and URL token, short-token rejection, 413 cap, handshake sanitizing; heartbeat 503/401 in production; sanitizer whitespace bypass; quota per sender; per-order code matching, lockout and resend cap; no code in portal output; no in-process generation; log redaction. `tests/adminEmailApprovalPortal.test.ts` was updated: two CB-02 tests previously required the code to appear in the portal response, which is the leak fixed in #4.
