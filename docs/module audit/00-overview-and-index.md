# Module Audit — Overview & Index

> Part of the `docs/module audit/` series. This document is the entry point: it explains
> what the series covers, how to read it (developer-to-developer knowledge transfer),
> and consolidates the cross-cutting findings that span multiple modules.
>
> Audit date: **2026-10-26**. Every document was produced by reading the source code in
> this repository directly; where the code disagrees with `AGENTS.md` or older docs, the
> audit treats **the code as ground truth** and flags the discrepancy.

## What this system is

**Custom Teamwear — Bulk Order Bot.** A click-first WhatsApp bot for bulk apparel
orders (MOQ 50 pcs) built on the WhatsApp Cloud API. Users walk a guided order flow
(garment type → qty → contact details → timeline → tier/catalog → print → logos →
mockup → payment); a mockup subsystem composites customer logos onto garment images
(deterministically with Sharp, optionally AI-visualized); orders land in Google Sheets
as a CRM; admins approve payments and paid mockups. Deployed as Vercel serverless
functions with Upstash Redis for state.

**Stack:** TypeScript (ESM), WhatsApp Cloud API (Meta Graph v20.0), Vercel serverless
functions, Upstash Redis, Google Sheets, Sharp, Vercel Blob, `qrcode`, mupdf
(catalog pipeline), Sentry. Tests run on Node's built-in test runner via tsx.

## How to read this series

Read in numeric order if you are onboarding onto the codebase cold. Each document is
self-contained with this shape: **Purpose → Files covered → deep per-file sections →
Data contracts → Execution flow → Error handling → Security (where applicable) →
Risks & observations**. Numeric prefixes mirror the runtime path of a request:
HTTP ingress → bot routing → conversation → domain modules → persistence → tooling →
tests.

| # | Document | Covers | Start here when you want to… |
|---|----------|--------|------------------------------|
| 01 | [api-endpoints.md](01-api-endpoints.md) | `api/webhook.ts`, `mockup-delivery.ts`, `admin-approve.ts`, `heartbeat.ts`, `health.ts`, `vercel.json` | Understand the HTTP surface, auth gates, ACK strategy, background delivery |
| 02 | [bot-configuration.md](02-bot-configuration.md) | `src/bot/index.ts` | See how an inbound WhatsApp update is extracted, gated, and routed |
| 03 | [config.md](03-config.md) | `src/config/env.ts`, `sentry.ts`, `version.ts` | Know every env var, validation, feature flags, deploy stamp |
| 04 | [session-management.md](04-session-management.md) | `src/session/*` (redisClient, chatLock, dedupe, draftStore, orderId, orderStore, rateLimit, statusMachine) | Understand Redis keys/TTLs, locks, dedupe, order IDs, status transitions |
| 05 | [shared-types-render-sanitize.md](05-shared-types-render-sanitize.md) | `src/shared/types.ts`, `render.ts`, `sanitize.ts` | Learn the core type inventory, quote/admin card rendering, formula-injection defense |
| 06 | [conversation-flow.md](06-conversation-flow.md) | `src/conversation/*` (orderFlow, copy, draft, uiMapper) | Walk the full customer conversation step by step, exit taxonomy, resume logic |
| 07 | [catalog-module.md](07-catalog-module.md) | `src/catalog/*` + generation pipeline | Understand tiers→groups→items→variants, overrides, catalogVersion |
| 08 | [pricing-and-qr.md](08-pricing-and-qr.md) | `src/pricing/*`, `src/qr/*` | Learn the price book, exact math, advance computation, UPI QR generation |
| 09 | [mockup-core.md](09-mockup-core.md) | `src/mockup/composite.ts`, `zones.ts`, `garmentReference.ts`, `generate*.ts`, AI clients, `promptBuilder.ts` | Understand the deterministic Sharp compositing, zones, and the AI visualization path |
| 10 | [mockup-workflow-quota-delivery.md](10-mockup-workflow-quota-delivery.md) | `src/mockup/workflow.ts`, `generationStore.ts`, `quota.ts`, `deliver*.ts`, `paidGeneration.ts`, `rateLimit.ts` | Understand the generation state machine, free/paid quota, admin approval of ₹20 mockups, background delivery |
| 11 | [sheets-module.md](11-sheets-module.md) | `src/sheets/*` | See the 3-tab CRM schema, safeAppend, never-fail-silently invariant |
| 12 | [admin-module.md](12-admin-module.md) | `src/admin/*` (actions, notify, approvalCode/Token, email) | Understand admin gating, OTP + HMAC portal tokens, idempotency |
| 13 | [storage-and-whatsapp.md](13-storage-and-whatsapp.md) | `src/storage/blob.ts`, `src/whatsapp/*` | Learn the Blob wrapper, media download/upload, Meta client |
| 14 | [scripts-tooling.md](14-scripts-tooling.md) | `scripts/*` (catalog generator, webhook tools, dev testers, Python extractors) | Run or vet a script; understand the catalog pipeline |
| 15 | [tests-suite.md](15-tests-suite.md) | `tests/*` + `tests/support/*`, `package.json`, `tsconfig.json` | Understand the test runner, fakes, what's covered and what isn't |

## Module dependency map (simplified)

```
api/webhook.ts ──► bot/index.ts ──► conversation/orderFlow.ts ──┬──► catalog/*
        │                   │                                   ├──► pricing/* + qr/*
        │                   ├──► admin/* (callbacks, OTP)       ├──► mockup/workflow → deliver*
        │                   └──► mockup/paidGeneration          └──► sheets/* + shared/*
        └──► api/mockup-delivery.ts (background, x-internal-secret)
All state ──► session/* (Redis) ; storage/blob.ts (mockup PNGs) ; whatsapp/* (Graph API)
All rupee math ──► pricing/* (centralized, invariant #1)
customer & admin text ──► shared/render.ts from one OrderData (invariant #2)
```

## Cross-cutting findings (read this before trusting older docs)

The audit surfaced several systemic issues that no single module doc owns. Treat this
list as the top of the backlog for any future refactor:

### 1. `AGENTS.md` and older docs are partially stale
Multiple concrete divergences were verified against code:

- **Conversation steps:** AGENTS.md describes S00–S11 with catalog-first ordering and
  size-split steps; the real flow is a derived-state machine with steps in the order
  `orderType → garmentSilhouette → qty → city → name → phone → timeline → tier →
  catalogFabric/Quality/Color → printMethod → logo loop → mockupDecision → payment`,
  with **no size-split step**, no bracket/upsell reveal, and no `keyboards.ts` /
  `waitHelpers.ts` / `steps/` directory.
- **Admin buttons:** there are no WhatsApp ✅/🚩 buttons in production; admin approval
  happens via **email OTP + a web portal** (`/api/admin-approve`). `renderAdminCard`
  exists but has no production caller (email replaced it).
- **Concurrency/dedupe/rate-limit:** documented as Redis keys (`busy:<chatId>`,
  `upd:<updateId>`, `ratelimit:ctw*`) but implemented **in-memory per serverless
  instance** (dedupe Set capped at 10 000, in-memory busy lock, in-memory sliding
  window). This only works because a single webhook instance is assumed.
- **Mockup quota:** docs say 3 free/month; code default is
  `DEFAULT_MOCKUP_FREE_PER_MONTH = 1`, and pricing is now per-view
  (₹10 single-view / ₹20 front+back via `MOCKUP_PRICES`), not a flat
  `MOCKUP_PAID_PRICE_INR`.
- **Catalog traceability:** the rich generated catalog (114 items, PDF-page traceability,
  `catalogVersion` SHA-256) is **not wired into the live flow** — `orderFlow.ts` uses
  `CATALOG_OPTIONS` from `options.ts` with a hardcoded `catalogVersion: "v1"`.

### 2. Invariants that are currently weakened
- **"Money events never fail silently":** if `RESEND_API_KEY` is missing, the email path
  simulates `ok:true` and no WhatsApp fallback fires — payment approvals can vanish.
- **"Deterministic proof on the customer's confirmed catalog image":** the proof
  composites onto **white/generic garment templates**, not the confirmed catalog image;
  `"catalog-exact"` is a dead union member.
- **Dynamic UPI QR:** production renders the **static** payment QR; the dynamic
  amount-prefilled QR block is dead-coded behind `if (false)`, though customer copy
  promises a pre-filled amount.

### 3. Security / robustness flags (details in module docs)
- `admin-approve.ts` renders unescaped customer fields into HTML (stored-XSS risk) and
  `health.ts` is unauthenticated (exposes env/key prefixes; `?test_resend=1` triggers
  email).
- `heartbeat.ts` (cron) is unauthenticated.
- `ADMIN_PORTAL_SECRET` falls back to a weak hardcoded default `"ctw-portal-secret-key"`;
  `deliverTrigger` vs `mockup-delivery` disagree on secret fallback (one defaults, one
  fails closed) — can silently break HTTP-fallback mockup generation.
- Draft persistence is memory-first with **fire-and-forget** Redis sync (silent draft-loss
  window on cold starts).
- The per-phone mockup quota counter has **no month component** (1-year rolling TTL), so
  it disagrees with the customer-facing calendar-month counter; `reserveGeneration`'s
  free-slot check is non-atomic (concurrent double-spend window).
- Full raw WhatsApp message payloads are logged (PII).
- Gemini client has no timeout/retries and puts the API key in the URL; AI cost tracking
  is effectively untracked (`costUsd: 0` / `undefined`).

### 4. Repo hygiene
- `assets/catalog/` previews are neither committed nor shipped (no `includeFiles` in
  `vercel.json`, contradicting AGENTS.md); the catalog source `quality/` (~2.5 GB) is
  gitignored, so the generation pipeline is not reproducible from a clone.
- Legacy Telegram-era scripts still target `api.telegram.org`; `.env.example` lists only
  2 vars vs ~15 actually needed.
- No CI, no coverage tooling; zero tests for `rateLimit.ts`, the Sheets escalation path,
  and `api/webhook.ts`'s signature/dedupe/ACK logic.

## Suggested reading paths

- **New developer (day 1):** 00 → 06 (conversation) → 01 (webhook) → 04 (session) → 03 (config).
- **Working on pricing/quotes:** 08 → 05 → 11.
- **Working on mockups:** 09 → 10 → 13 (blob) → 01 (mockup-delivery).
- **Working on admin/approval:** 12 → 01 (admin-approve) → 10 (paid mockups).
- **Working on catalog data:** 07 → 14 (generator scripts).
- **QA/testing:** 15 → 14.

---
*Generated as part of the 2026-10-26 module audit. No source code was modified; this
series only documents the repository as it exists at that commit.*
