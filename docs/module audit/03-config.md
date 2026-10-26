# Module Audit — 03: Configuration (`src/config/`)

## Purpose

Reference for the entire configuration layer: every environment variable the app
reads, how/when it's validated (fail-fast at cold start, cached thereafter), the
Sentry wiring, and the `BUILD_STAMP`/feature-flag build markers exposed on
`/api/health`. Invariant #4 of the repo: **env is validated once, fail-fast, and
accessed only via `getEnv()`** — this document records where that holds, where it's
bypassed, and every default/fallback in the code.

## Files covered

- `src/config/env.ts` (199 lines) — loader/validator + `Env` interface + test seam
- `src/config/sentry.ts` (21 lines) — Sentry init/capture no-op wrapper
- `src/config/version.ts` (45 lines) — `BUILD_STAMP`, `BuildInfo`, feature flags
- `.env.example` (68 lines) — variable-name inventory (names only; no real values)

---

## 1. `src/config/env.ts` — central env loader/validator

### Purpose

Single source of truth for configuration. `getEnv()` reads `process.env`, validates
required vars, applies defaults/normalization, and **caches the result per cold
start** so validation happens once and every call site gets the same object. Throws
a descriptive `Error` on the first missing/invalid required var so failures surface
at cold start rather than deep inside a handler.

### Helpers

| Helper | Behavior |
|---|---|
| `required(name)` | Throws `Missing required environment variable: <name>` if unset or whitespace-only; returns trimmed-in-place value (returns raw value, note: no `.trim()` applied to the return) |
| `optional(name)` | Returns the value if non-empty after trim, else `undefined` |
| `optionalPositiveInt(name, fallback)` | Empty → fallback; else `Number(raw)` must be an **integer ≥ 0** or throws `<name> must be a non-negative integer (got "<raw>")`. Despite the name, 0 is allowed |
| `__resetEnvForTests()` | Test seam: clears the module-level `cached` so `process.env` overrides take effect |

Constants: `DEFAULT_META_API_BASE_URL = "https://graph.facebook.com"`,
`DEFAULT_MOCKUP_PAID_PRICE_INR = 20`, `DEFAULT_MOCKUP_FREE_PER_MONTH = 1`.

### The `Env` interface — complete variable inventory

#### Required (throw if missing/empty)

| Var | Type | Notes |
|---|---|---|
| `CHANNEL` | `"whatsapp"` | Must equal `whatsapp` exactly, else `Unsupported CHANNEL "<x>". Only "whatsapp" is supported.` (legacy multi-channel scaffold) |
| `META_API_TOKEN` | string | Bearer token for outbound Cloud API calls |
| `META_PHONE_NUMBER_ID` | string | Folded into the outbound URL path |
| `META_BUSINESS_ACCOUNT_ID` | string | Required even though not directly consumed by the webhook path (kept for parity/validation) |
| `META_WEBHOOK_SECRET` | string | GET-handshake verify token; also the last-resort fallback for `ADMIN_PORTAL_SECRET` (see below) |
| `ADMIN_CHAT_IDS` | string[] | Comma-split, trimmed, non-empty entries; throws if the result is empty (`ADMIN_CHAT_IDS must contain at least one chat id.`). Server-side admin gating for every admin action |
| `MERCHANT_VPA` | string | UPI VPA for the payment QR |
| `STATIC_QR_URL` | string | Static brand QR image URL |
| `REDIS_REST_URL` | string | Upstash Redis REST endpoint |
| `REDIS_REST_TOKEN` | string | Upstash token |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | string | Service-account JSON for Sheets |
| `SHEET_ID` | string | Target spreadsheet id |

#### Optional (undefined if unset/empty)

| Var | Type | Notes |
|---|---|---|
| `META_APP_SECRET` | string? | HMAC key for `X-Hub-Signature-256` verification. Unset = webhook accepts unverified POSTs with a once-per-cold-start WARN (documented temporary posture for Tech Providers that don't share the secret) |
| `SENTRY_DSN` | string? | Unset = Sentry fully no-op |
| `EMOVUR_CONNECTOR_ID` | string? | When set, Meta client adds `collector-id` and `connector-id` headers for the Emovur BSP wrapper |
| `OPENROUTER_API_KEY` | string? | AI mockup provider key |
| `OPENAI_API_KEY` | string? | Falls back to `optional("OPENAI_API")` — supports either env name |
| `MOCKUP_IMAGE_MODEL` | string? | e.g. `bytedance-seed/seedream-4.5` or `gpt-image-2.5-flare-2026-09-08` |
| `GEMINI_API_KEY` | string? | Only when `MOCKUP_IMAGE_PROVIDER=gemini` (documented non-functional tier) |
| `MOCKUP_IMAGE_PROVIDER` | string? | `openrouter` (tested) / `gemini` / `openai` — free-form string, no enum validation |
| `INTERNAL_MOCKUP_SECRET` | string? | Header secret for `/api/mockup-delivery`; **fail-closed** at that endpoint when unset; must differ from `META_WEBHOOK_SECRET` (separate trust boundary, audit finding C4) |
| `PUBLIC_BASE_URL` | string? | Override base URL for internal dispatch + portal links; falls back to Vercel's system env vars at call sites |
| `BLOB_READ_WRITE_TOKEN` | string? | Vercel Blob token; the Env doc-comment is internally contradictory — one paragraph says images are "still sent to WhatsApp but not persisted," the corrected paragraph says storage is **mandatory** (generation fails gracefully and escalates when unset). The corrected reading matches `src/storage/blob.ts` behavior per `.env.example` |
| `RESEND_API_KEY` | string? | `re_...` key; when unset or equal to `re_test_dummy`, `sendEmailWithResend` **simulates** dispatch (`ok:true`, `id:"mock-<ts>"`) and logs the would-be recipients |

#### Optional with defaults / transformations

| Var | Default / transform |
|---|---|
| `META_API_BASE_URL` | Default `https://graph.facebook.com`; trailing slashes stripped (`/\/+$/`); must match `/^https:\/\//i` or throws (`Refusing to send the bearer token over a non-TLS endpoint.`). Version segment is folded in at the call site: `${base}/v20.0/${phoneId}/messages` |
| `ADMIN_EMAILS` | Default `"cteamwear@gmail.com"`; comma-split/trimmed; if the split yields zero entries, falls back to `["cteamwear@gmail.com"]` |
| `ADMIN_EMAIL_FROM` | Default `"Custom Teamwear <onboarding@resend.dev>"` |
| `ADMIN_PORTAL_SECRET` | **Fallback chain:** `ADMIN_PORTAL_SECRET` → `META_WEBHOOK_SECRET` → literal `"ctw-portal-secret-key"`. Used to HMAC-sign admin portal tokens (7-day validity) |
| `MOCKUP_PAID_PRICE_INR` | Integer, default **20** (₹ per paid generation) |
| `MOCKUP_FREE_PER_MONTH` | Integer, default **1** — note `.env.example` sets `3`, and AGENTS.md quotes 3; the *code* default is 1 |

### Caching & fail-fast semantics

```ts
let cached: Env | undefined;
export function getEnv(): Env {
  if (cached) return cached;
  /* validate everything, build object */ cached = { ... };
  return cached;
}
```

- Validation runs **once per cold start** (module-level `cached`). Every endpoint and
  the bot core call `getEnv()`; the first call validates.
- Failure mode: the throw propagates to whichever handler called first — the webhook
  still 200-ACKs to Meta (log-only), `/api/health` would 500 (it avoids `getEnv()`
  and reads `process.env` directly, ironically making it the one endpoint that survives
  a broken env). This is why pre-flight checking via `/api/health` matters.
- `__resetEnvForTests()` clears the cache for tests (used with `tests/support/testEnv`).

### Risks & observations

1. **`ADMIN_PORTAL_SECRET` fallback weakens trust separation.** In practice the
   chain lands on `META_WEBHOOK_SECRET` (since that var is required), so the webhook
   secret doubles as the portal-token signing key unless `ADMIN_PORTAL_SECRET` is set
   explicitly. Anyone who learns the webhook secret can mint 7-day portal tokens for
   any orderId. The final hardcoded `"ctw-portal-secret-key"` literal would only ever
   apply if `META_WEBHOOK_SECRET` were somehow empty (impossible given it's required),
   but it's still a hardcoded secret in source.
2. **Hardcoded default admin email** `cteamwear@gmail.com` appears in three places
   (`env.ts` twice, `health.ts` once) — a forgotten `ADMIN_EMAILS` silently routes
   order alerts/OTPs to it.
3. `required()` doesn't trim its return value (only checks trim for emptiness) — a
   var with accidental trailing whitespace passes validation and is used verbatim.
4. `optionalPositiveInt` allows `0` (e.g. `MOCKUP_FREE_PER_MONTH=0` = every mockup is
   paid immediately); the name suggests positivity but the guard is non-negativity.
5. `MOCKUP_IMAGE_PROVIDER` is unvalidated free text — a typo (`"openrouter"`) fails
   later in the provider selection, not at startup.
6. `GOOGLE_SERVICE_ACCOUNT_JSON` is validated only for presence, not JSON-ness; a
   malformed value fails at first Sheets write.
7. **Code default vs docs:** `MOCKUP_FREE_PER_MONTH` default 1 in code, 3 in
   `.env.example`/AGENTS.md — deployments that omit the var get the stricter value.

---

## 2. `src/config/sentry.ts` — error reporting

### Purpose

Minimal Sentry wrapper (free-tier, PRD §10.4). Two exports; both effectively no-ops
when Sentry isn't configured, so local/dev runs are unaffected.

### API

```ts
export function initSentry(): void
export function captureException(err: unknown): void
```

### Behavior

- `initSentry()`:
  1. Guard: module-level `initialized` flag — returns immediately if already run.
  2. `getEnv()` — note this means calling `initSentry()` also performs env validation.
  3. If `!env.SENTRY_DSN` → **return without setting `initialized`** — Sentry stays
     permanently off for this cold start (by design).
  4. `Sentry.init({ dsn, tracesSampleRate: 0 })` — errors only, zero performance
     tracing (free tier), then `initialized = true`.
- `captureException(err)`:
  - Calls `Sentry.captureException(err)` **only if** `initialized` is true. Because a
    missing DSN never sets the flag, capture is a true no-op in that case.
  - Never throws; safe in catch blocks.

### Who calls it

`src/bot/index.ts` (`initSentry()` on first message per cold start; `captureException`
in the unhandled-error catch). No other module imports it — endpoints like
`api/webhook.ts` and `api/mockup-delivery.ts` rely on `console.error` + admin
WhatsApp escalations instead, so **errors outside `handleMessage` never reach Sentry**.

### Risks & observations

- Coverage gap: webhook-level failures (bad signature storms, unparseable payloads,
  snapshot-load failures in mockup-delivery, Sheets errors in admin-approve) are
  log-only. If Sentry is your alerting surface, know it only sees the bot core.
- `initSentry` triggering `getEnv()` couples error reporting to env validity: on a
  broken deployment Sentry can't even initialize to report the problem.
- `tracesSampleRate: 0` is hardcoded — no env knob for sampling.

---

## 3. `src/config/version.ts` — build markers & feature flags

### Purpose

Non-secret identifiers to prove **which build** a deployment serves (the deploy-lag
diagnosis), exposed via `/api/health` and logged once per cold start by
`api/webhook.ts`. Safe to publish.

### Exports

```ts
export const BUILD_STAMP = "2026-10-26-deterministic-online-mockup-local-testing-only";

export interface BuildInfo {
  buildStamp: string; commitSha: string; commitRef: string; commitMessage: string;
  features: { catalogColourFlow: boolean; fiftyPercentAdvance: boolean;
              deterministicMockup: boolean; mockupBeforePayment: boolean };
}

export function getBuildInfo(): BuildInfo
```

### Semantics

- **`BUILD_STAMP`** is bumped **by hand** whenever you want an unambiguous marker in
  running code (per AGENTS.md "Common tasks": update it to verify a deploy actually
  shipped). Current value: `2026-10-26-deterministic-online-mockup-local-testing-only`.
  The webhook logs it once per cold start:
  `build=<stamp> commit=<sha> ref=<ref>`.
- **`commitSha` / `commitRef` / `commitMessage`** come from Vercel-injected
  `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_COMMIT_REF` / `VERCEL_GIT_COMMIT_MESSAGE`,
  defaulting to `"unknown"` (e.g. local `vercel dev`).
- **`features`** is a hardcoded `{true, true, true, true}` — these flags advertise
  capabilities compiled into *this* build (`catalogColourFlow`, `fiftyPercentAdvance`,
  `deterministicMockup`, `mockupBeforePayment`). They are compile-time constants, not
  runtime switches: there is no code path that turns any of them off. Their value is
  purely diagnostic — if `/api/health` ever shows `catalogColourFlow:false` you're
  hitting a stale deployment or the wrong project (per the health endpoint's header
  comment).

### Risks & observations

- Flags can rot: nothing prevents someone from adding a feature without flipping its
  flag, making `/api/health` lie. Treat them as a manual contract.
- BUILD_STAMP strings are free-form; keep the date prefix convention
  (`YYYY-MM-DD-<slug>`) so deploy lag is readable at a glance.

---

## 4. `.env.example` — variable-name inventory

Names only (never copy real `.env` values into docs/repos). Marked **required** if
`env.ts` throws without it; **optional** otherwise.

| Var | Required? | Purpose |
|---|---|---|
| `CHANNEL` | required | Must be `whatsapp` |
| `META_API_TOKEN` | required | Cloud API bearer token |
| `META_PHONE_NUMBER_ID` | required | Sender phone-number id |
| `META_BUSINESS_ACCOUNT_ID` | required | WABA business account id |
| `META_WEBHOOK_SECRET` | required | GET-handshake verify token (+ portal-secret fallback) |
| `META_API_BASE_URL` | optional | Default `https://graph.facebook.com`; Emovur example `https://metagraph.backendprod.com` |
| `META_APP_SECRET` | optional | POST HMAC verification key |
| `ADMIN_CHAT_IDS` | required | Comma-separated admin chat ids |
| `MERCHANT_VPA` | required | UPI VPA |
| `STATIC_QR_URL` | required | Static QR image URL |
| `REDIS_REST_URL` / `REDIS_REST_TOKEN` | required | Upstash Redis |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | required | Sheets service account (JSON string) |
| `SHEET_ID` | required | Spreadsheet id |
| `SENTRY_DSN` | optional | Sentry errors |
| `MOCKUP_IMAGE_PROVIDER` | optional | `openrouter` \| `gemini` \| `openai` |
| `GEMINI_API_KEY` | optional | Gemini provider key (currently non-functional tier) |
| `OPENROUTER_API_KEY` | optional | OpenRouter provider key (tested default) |
| `OPENAI_API_KEY` | optional | OpenAI provider key (or `OPENAI_API`) |
| `MOCKUP_IMAGE_MODEL` | optional | Model id per provider |
| `INTERNAL_MOCKUP_SECRET` | optional* | *Fail-closed endpoint — effectively required for HTTP fallback delivery |
| `PUBLIC_BASE_URL` | optional | Internal-dispatch/portal base override |
| `BLOB_READ_WRITE_TOKEN` | optional* | *Mandatory in practice: without it mockups fail-escalate |
| `MOCKUP_FREE_PER_MONTH` | optional | Code default 1; example sets 3 |
| `MOCKUP_PAID_PRICE_INR` | optional | Code default 20 |

**Vars `env.ts` reads but `.env.example` omits:** `ADMIN_EMAILS`, `ADMIN_EMAIL_FROM`,
`ADMIN_PORTAL_SECRET`, `RESEND_API_KEY`, `EMOVUR_CONNECTOR_ID`, `OPENAI_API`
(secondary name). Anyone setting up from `.env.example` alone will hit silent
defaults (admin email `cteamwear@gmail.com`, portal secret = webhook secret,
simulated email dispatch).

**Defects in `.env.example` itself:** `MOCKUP_IMAGE_PROVIDER` is defined **twice**
(line 37 `openrouter`, line 65 `openai`) and `MOCKUP_IMAGE_MODEL` twice
(line 40 `bytedance-seed/seedream-4.5`, line 67 `gpt-image-2.5-flare-2026-09-08`) —
the later definition wins in most dotenv loaders, contradicting the earlier
"openrouter is the tested, working default" comment.

---

## Data contracts/types

- **`Env`** (env.ts lines 29–101) — the full typed config object; the only sanctioned
  way to read configuration. Field-by-field inventory above.
- **`BuildInfo`** (version.ts) — health/log payload shape
  (`buildStamp`, `commitSha`, `commitRef`, `commitMessage`, `features{4}`).

## Execution flow (step-by-step)

**First `getEnv()` call per cold start:**
1. Return `cached` if present (subsequent calls are free).
2. `required("CHANNEL")` → must be `"whatsapp"`.
3. `required("ADMIN_CHAT_IDS")` → split/trim/filter → must be non-empty.
4. `ADMIN_EMAILS` / `ADMIN_EMAIL_FROM` / `ADMIN_PORTAL_SECRET` defaults + fallback chain.
5. `META_API_BASE_URL` normalize (strip trailing slashes) + HTTPS check.
6. All remaining `required(...)` reads; all `optional(...)` reads;
   `optionalPositiveInt` for the two mockup numeric knobs.
7. Cache and return.

**Sentry first init:** `initSentry()` → guard → `getEnv()` → DSN check →
`Sentry.init({tracesSampleRate: 0})` → `initialized = true`.

**Health/build info:** `getBuildInfo()` → constants + Vercel git env reads
(defaults `"unknown"`) + hardcoded feature flags.

## Error handling

- `getEnv()` throws `Error` with actionable messages (`Missing required environment
  variable: X`, `X must be a non-negative integer (got "Y")`, `META_API_BASE_URL must
  be an https:// URL...`, `Unsupported CHANNEL "Y"...`, `ADMIN_CHAT_IDS must contain
  at least one chat id.`). No try/catch inside — callers see the throw; the webhook's
  always-200 policy means these surface only in logs/Sentry.
- `initSentry` / `captureException` never throw (`captureException` guards on
  `initialized`).

## Security

- Secrets are read but never logged by these modules (only `/api/health` exposes
  prefixes — see doc 01 risks).
- HTTPS enforcement on `META_API_BASE_URL` prevents bearer-token exfiltration over
  plaintext.
- Fail-fast validation prevents running with partially-configured security gates
  (e.g., missing webhook secret aborts cold start).
- Known weakening: `ADMIN_PORTAL_SECRET` → `META_WEBHOOK_SECRET` → hardcoded literal
  fallback chain (see risks).

## Risks & observations (consolidated)

1. Portal-secret fallback chain couples two trust boundaries; set
   `ADMIN_PORTAL_SECRET` explicitly and distinctly in production.
2. Hardcoded default admin email (`cteamwear@gmail.com`) can silently receive
   production order alerts/OTPs.
3. Code default `MOCKUP_FREE_PER_MONTH = 1` disagrees with docs (3) — deployments
   omitting the var get stricter-than-expected quota.
4. `.env.example` is stale/incomplete (missing 6 vars; duplicated provider/model
   entries with conflicting values) relative to `env.ts`.
5. `BLOB_READ_WRITE_TOKEN` Env doc-comment contains contradictory paragraphs
   (send-anyway vs mandatory-fail) — the mandatory reading is correct.
6. Sentry coverage is limited to the bot core; endpoint-level failures are log-only.
7. `MOCKUP_IMAGE_PROVIDER` and `GOOGLE_SERVICE_ACCOUNT_JSON` are validated for
   presence only — typos/malformed values fail later, mid-flow.
8. `optionalPositiveInt` allows 0 despite its name; `required()` doesn't trim its
   return value.
