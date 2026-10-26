# Module Audit 14 — Scripts & Tooling

> Companion to the module audits of `src/` and `api/`. This doc covers everything in
> `scripts/` (and the npm/package.json plumbing around it): what each script does,
> how to run it, which environment it touches, and whether it is safe for production.
>
> All statements below were verified against the source on 2026-10-26. The repo is
> mid-migration from a **Telegram/grammY** prototype to the current **WhatsApp Cloud
> API** bot, and the `scripts/` folder preserves a lot of that earlier history.

## Purpose

`scripts/` holds developer tooling for the CTW project. It is deliberately excluded
from the Vercel deployment (`vercel.json` only configures `api/*` functions), so none
of these files ship to production. They fall into five families:

1. **Catalog pipeline** — ingest the source PDFs in `quality/` into
   `src/catalog/data/catalog.generated.json` + `assets/catalog/` previews.
2. **Webhook management** — a *legacy Telegram-era* set/delete/info trio for the
   grammY bot. **Not used by the current WhatsApp bot** (see "Stale tooling" below).
3. **Ad-hoc integration testers** — standalone TS scripts that hit the *real* Redis,
   Vercel Blob, OpenAI/Gemini, and WhatsApp Cloud API using credentials read from a
   local `.env`. These are developer harnesses, not CI tests.
4. **One-off Python extractors** — scratch utilities used during catalog/mockup
   development to pull colors and garment imagery out of the source PDFs.
5. **The mockup UI dev server** — a small local HTTP server used to build the
   `assets/mockup-templates/` back/front images.

The production code **never imports anything from `scripts/`** — the only script with
a real contract with production code is `generate-catalog.ts`, whose *outputs*
(`catalog.generated.json`, `assets/catalog/*.jpg`) are read at runtime by
`api/webhook.ts` and the `src/catalog` domain module.

## How scripts are invoked

All TypeScript scripts are executed directly through **tsx** (an npm dev dependency),
which strips types and transpiles on the fly. There is no build step and no bundler
for them. The two ways to invoke:

```bash
npm run <script>     # only for the 6 npm-registered commands
npx tsx scripts/<name>.<ext> [args]
```

npm-registered commands (from `package.json`):

| Command | File | Extra dependencies |
|---|---|---|
| `npm test` | — | runs `node --import tsx --test "tests/**/*.test.ts"` (see audit 15) |
| `npm run typecheck` | — | `tsc --noEmit` (aliased as `lint`) |
| `npm run generate-catalog` | `scripts/generate-catalog.ts` | `mupdf` (native); reads `quality/*.pdf` |
| `npm run set-webhook` | `scripts/set-webhook.ts` | — |
| `npm run delete-webhook` | `scripts/delete-webhook.ts` | — |
| `npm run webhook-info` | `scripts/webhook-info.ts` | — |
| `npm run test-admin-trigger` | `scripts/test-admin-trigger.ts` | — |
| `npm run mockup-ui` | `scripts/mockup-ui-server.ts` | — |

Everything else must be run with `npx tsx scripts/<file>` directly. The Python
scripts need a local Python 3 environment with the packages listed in their headers
(`opencv-python`, `numpy`, `pypdf`, `pillow`, `requests`).

### Environment variables

Scripts read env vars via `node:process`. `scripts/generate-catalog.ts` and
`scripts/live-test.ts` explicitly `import "dotenv/config"`. The `test-*.ts` family
mostly does **not** call `dotenv/config` and instead hand-parses `.env` itself
(assigning into `process.env` without overriding existing keys). In practice you need
a populated local `.env` (`.env.example` is stale — see below) before running any
integration script.

`.env.example` currently lists only `TELEGRAM_BOT_TOKEN` and `WEBHOOK_SECRET` — a
leftover from the Telegram era. It does **not** document the vars the current
WhatsApp bot actually needs (`WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WEBHOOK_VERIFY_TOKEN`, `ADMIN_CHAT_IDS`, `REDIS_URL`, `UPSTASH_REDIS_REST_URL`/
`..._TOKEN`, `GOOGLE_SHEET_ID`+`GOOGLE_SERVICE_ACCOUNT_JSON`, `PUBLIC_BASE_URL`,
Blob vars, `MOCKUP_*`). The authoritative list lives in `src/config/env.ts`.

## Script-by-script reference

### Catalog pipeline

| File | Lines | Command | Reads | Writes |
|---|---|---|---|---|
| `generate-catalog.ts` | 885 | `npm run generate-catalog` | `quality/*.pdf`, `src/catalog/data/overrides.json` | `src/catalog/data/catalog.generated.json`, `assets/catalog/<pdfStem>-p<N>.jpg` |

**Full details of the catalog generation pipeline are in the next section.**

### Webhook management (legacy — Telegram era)

| File | Lines | Command | Hits |
|---|---|---|---|
| `set-webhook.ts` | 35 | `npm run set-webhook` | `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=...` |
| `delete-webhook.ts` | 19 | `npm run delete-webhook` | `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/deleteWebhook` |
| `webhook-info.ts` | 22 | `npm run webhook-info` | `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo` |

**⚠️ These are stale.** The deployed bot is a WhatsApp Cloud API bot
(`api/webhook.ts`, grammY `Bot` configured in `src/bot/index.ts`), whose webhook is
registered via Meta's Graph API (`POST
https://graph.facebook.com/v21.0/<PHONE_NUMBER_ID>/whatsapp_webhook` with
`WHATSAPP_TOKEN`), not via Telegram. Nothing in the WhatsApp path calls these three
scripts, and running `set-webhook` with a real Telegram token will point a *Telegram*
bot at this Vercel deployment, which will 200-ACK but fail to parse the update. Treat
the whole trio as documentation debt.

### Integration testers (dev-only — hit real services)

Every script in this table reads secrets from the local environment and talks to a
real backend. They are **never** run in CI and must never be run against production
without understanding the side effects (they write Redis keys, append Sheets rows,
send real WhatsApp messages, upload real Blobs).

| File | Lines | Command | Hits | Hardcoded / notable IDs |
|---|---|---|---|---|
| `live-test.ts` | 186 | `npx tsx scripts/live-test.ts` | deployed webhook (`https://custom-teamwear-bot.vercel.app` by default; override with arg) | `wa:918660055898` |
| `test-full-user-flow.ts` | 370 | `npx tsx scripts/test-full-user-flow.ts` | deployed webhook | `wa:919742595677`, `wa:918660055898`, `wa:918660099382` |
| `test-mockup-generator.ts` | 223 | `npx tsx scripts/test-mockup-generator.ts` | local Redis, Vercel Blob, `api/mockup-delivery` local endpoint | `wa:919742595677` |
| `test-mockup.ts` | 88 | `npx tsx scripts/test-mockup.ts` | Redis, Vercel Blob, WhatsApp Graph send | admin `wa:919742595677`; uploads `C:/Users/Suraj/Downloads/whatsapp_logo.png` |
| `test-media-upload.ts` | 44 | `npx tsx scripts/test-media-upload.ts` | WhatsApp Graph upload + send | admin `wa:919742595677` |
| `test-media-fetch.ts` | 28 | `npx tsx scripts/test-media-fetch.ts` | WhatsApp Graph media download | message id `wamid.HBgLOT...` |
| `test-admin-trigger.ts` | 127 | `npm run test-admin-trigger` | local Redis, mockup delivery HTTP endpoint | customer `wa:918660055898` |
| `test-admin-email-portal.ts` | 104 | `npx tsx scripts/test-admin-email-portal.ts` | local Redis + Blob | customer `wa:918660099382`, order `CTW-250929-05` |
| `test-ai-mockup.mjs` | 106 | `npx tsx scripts/test-ai-mockup.mjs` | OpenAI-compatible chat endpoint (via `ANTIGRAVITY_URL`+`ANTIGRAVITY_API_KEY`) | — |
| `test-ai-mockup-studio.ts` | 134 | `npx tsx scripts/test-ai-mockup-studio.ts` | Gemini (`GOOGLE_API_KEY`) | **absolute path** `C:/Users/Suraj/.gemini/antigravity-ide/brain/975e2ef0-.../input_6.png` |
| `list-colors.ts` | 12 | `npx tsx scripts/list-colors.ts` | — (imports `CATALOG_OPTIONS` from `src/catalog/options.ts`, prints the sorted union of every color across tiers/products/qualities) | — |

Observations on this family:

- `test-admin-trigger.ts` and `test-admin-email-portal.ts` use the **same
  `loadEnv()`** helper (hand-rolled `.env` parser) and require `MOCKUP_INTERNAL_SECRET`
  to match `api/mockup-delivery.ts`'s timing-safe gate.
- `test-mockup-generator.ts` calls `globalThis.waitUntil ?? ((p:unknown)=>void p)` —
  a local shim of the Vercel `waitUntil` global so it can drive the real
  dispatch-worker path outside the Vercel runtime.
- Several scripts default `customerChatId`/`adminChatId` to **real phone-derived
  WhatsApp JIDs**. If you run them as-is you will message a real person. Treat these
  values as placeholders and override at the call site.
- `test-ai-mockup-studio.ts` is **not portable** — it hardcodes an absolute path on
  the original author's Windows machine (`C:/Users/Suraj/.gemini/antigravity-ide/...`).

### Mockup UI dev server

| File | Lines | Command | Ports / env |
|---|---|---|---|
| `mockup-ui-server.ts` | 375 | `npm run mockup-ui` | `MOCKUP_UI_PORT` (default 3456); `OPENAI_API_KEY` optional |

A standalone Node `http` server that serves a browser page for interactively
positioning/sizing the 5 mockup placement zones on the back and front garment
images. It exposes a tiny JSON API (`/api/zones`, `POST /api/save` →
`src/mockup/zones.json`, optional `POST /api/ai-variant` → OpenAI image edit). This
is how the committed `assets/mockup-templates/back.jpg` / `front.jpg` and the
`src/mockup/zones.json` placement constants were produced. Dev-only; the production
runtime never starts it.

### Python one-offs (dev-only)

| File | Lines | Deps | Purpose |
|---|---|---|---|
| `extract_all_catalog_colors.py` | 77 | `opencv-python`, `numpy`, `requests` | Iterates a **hardcoded Windows path outside the repo** (`C:\Users\Suraj\...\aa\new\quality`), renders each PDF page to PNG at 150 DPI via `PyMuPDF`, runs a K-means color clustering pass on the page, and saves crops + a JSON of dominant hex colors per page. Produces a human-reviewable color report. |
| `extract_stellar_images.py` | 75 | `pypdf`, `pillow` | Uses `pypdf`'s image extraction on the *Stellars* brand PDFs (`quality/*.pdf`), filters images > 100×100 px, and writes each embedded raster to a local `extracted_images/` folder. One-off helper for finding garment product shots inside the PDFs. |
| `classify_and_sort_poses.py` | 120 | `opencv-python`, `numpy`, `shutil` | Classifies model/pose images into `front/`, `back/`, `other/` subfolders using skin-tone masking + a central-body heuristic, then copies them to a destination folder. Used once to build the mockup template source set. |

All three contain absolute paths tied to the original developer's machine and are
**not portable as-is**; they are kept as provenance for how the catalog color data
and mockup templates were derived.

## The catalog generation pipeline

`scripts/generate-catalog.ts` (885 lines) is the single source of truth for the
catalog data the bot sells from. It is **the only supported way** to regenerate
`src/catalog/data/catalog.generated.json`; the file is gitignored as "GENERATED — do
not edit by hand" and is read at runtime by `api/webhook.ts` via `fs.readFileSync`.

### Inputs

- **Source PDFs** — a `SourceSpec[]` at the top of the script lists the brand PDFs to
  ingest: `Basic.pdf`, `Standard.pdf`, `Adidas.pdf`, `Stellars.pdf`, plus
  `Stellars-2.pdf`/`Stellars-3.pdf`/`Stellars-4.pdf`. All are read from a local
  `quality/` directory that is **gitignored** (~2.5 GB of brand catalogs). The
  pipeline cannot run from a fresh clone without re-supplying that folder.
- **Overrides** — `src/catalog/data/overrides.json` (a checked-in 36-byte file,
  currently `{}`) is a shallow-merged manual-fixup layer: parse a bad page, add an
  entry keyed by `sourcePage`, and the generator will prefer it.
- **Env** — none required. The script runs fully offline except for nothing; it only
  touches the local filesystem.

### What it does, step by step

1. **Parse each PDF with a brand-specific parser.** `Basic`/`Standard`/`Adidas` are
   handled by dedicated extractors (t-shirt → sublimation → full-sleeve grouping,
   size tables, price detection with an `MRP:`/`₹`-aware regex); `Stellars` pages use
   a `StellarsParser`; anything that doesn't match falls back to a generic
   page-text-based parser.
2. **Build the domain graph** — `Tier → Group → Item → ColourVariant → ImageRef`,
   assigning stable `itemId`/`variantId` slugs and recording `sourcePage` +
   `catalogVersion` for traceability.
3. **Apply overrides** — any page in `overrides.json` replaces the parsed item for
   that `sourcePage`.
4. **Render preview images** — each page is rasterized to a **1600 px-wide JPEG at
   quality 82** (`TARGET_WIDTH_PX`/`JPEG_QUALITY` constants) and written to
   `assets/catalog/<pdfStem>-p<pageNumber>.jpg`. These are the catalog images the
   bot sends during S1 and the compositing surface the mockup module overlays logos
   onto.
5. **Compute `catalogVersion`** — a `sha256` of all the rendered page images, so an
   order's snapshot can pin exactly which catalog revision it referenced.
6. **Write `catalog.generated.json`** — the full domain graph (tiers, groups,
   items, variants, image paths, catalog version) that `src/catalog` loads at
   runtime.

### Outputs and how production consumes them

- `src/catalog/data/catalog.generated.json` → read by `src/catalog/index.ts` (via
  `fs.readFileSync`) inside `api/webhook.ts` at cold start.
- `assets/catalog/*.jpg` → referenced by `ImageRef` paths in the generated JSON,
  read from disk at request time when the bot sends a product image, and used as the
  base layer by `src/mockup/composite.ts`.

**⚠️ Stale README claim:** `AGENTS.md` states that `api/webhook.ts` declares
`includeFiles: "assets/catalog/**"` in `vercel.json` so that catalog images ship to
the serverless function. The actual `vercel.json` contains **no `includeFiles`
directive** — only the two `maxDuration` settings. Likewise `assets/catalog/` is
**not present in this working tree and is not tracked in git** (`git ls-files assets`
returns only `assets/mockup-templates/*` and `assets/payment-qr.jpg`), despite the
README §7 stating that previews are committed. The net effect: **catalog image
delivery and mockup compositing depend on an untracked, unshipped asset directory**;
any fresh clone / clean Vercel build will produce a catalog JSON whose image paths
resolve to files that don't exist. This should be reconciled (either commit
`assets/catalog/**` or regenerate it in the build).

### When to re-run it

Per README §7: whenever the brand PDFs in `quality/` change. The generated JSON and
the image assets must stay in lockstep — regenerating one without the other will
leave image paths pointing at stale page numbers.

## Production-safe vs one-off classification

| Script | Classification | Notes |
|---|---|---|
| `generate-catalog.ts` | **Production-relevant tooling** (offline) | Produces artifacts consumed by the deployed bot. Safe to run — writes only repo files. Needs `quality/`. |
| `set/delete/webhook-info.ts` | **Stale — legacy Telegram** | Targets `api.telegram.org`; the current bot is WhatsApp. Do not use. |
| `mockup-ui-server.ts` | Dev-only (local) | Local HTTP server; `OPENAI_API_KEY` only if using the AI-variant feature. |
| `live-test.ts` | Dev-only (hits deployed prod URL by default) | Override the target before running, or you'll message production. |
| `test-full-user-flow.ts`, `test-mockup-generator.ts`, `test-mockup.ts`, `test-media-upload.ts`, `test-media-fetch.ts`, `test-admin-trigger.ts`, `test-admin-email-portal.ts`, `test-ai-mockup.mjs`, `test-ai-mockup-studio.ts` | Dev-only (real services) | Need real Redis/Blob/WhatsApp/OpenAI/Gemini credentials; several hardcode real chat IDs or absolute Windows paths. |
| `list-colors.ts` | Dev-only (offline) | Imports `src/catalog/options.ts` and prints color keys; harmless. |
| `extract_all_catalog_colors.py`, `extract_stellar_images.py`, `classify_and_sort_poses.py` | One-off scratch | Hardcoded dev-machine paths; kept for provenance of the color/template assets. |

**None of these scripts are imported by production code or by `api/`.** The only
coupling to production is *file output* from `generate-catalog.ts`.

## Risks & observations

- **Webhook scripts target the wrong platform.** `set/delete/webhook-info.ts` talk to
  `api.telegram.org`; the deployed bot is WhatsApp Cloud API. This is confusing
  documentation debt — running them has no effect on (or could interfere with) the
  WhatsApp bot, and `.env.example` still documents only the two Telegram vars.
- **`.env.example` is stale.** It lists only `TELEGRAM_BOT_TOKEN`/`WEBHOOK_SECRET`,
  while `src/config/env.ts` requires ~15 WhatsApp/Redis/Sheets/Blob vars. A new
  developer following `.env.example` cannot run anything.
- **`assets/catalog/` is not in git and not shipped.** `vercel.json` has no
  `includeFiles` (contradicting `AGENTS.md`), and the preview JPEGs aren't tracked
  despite README §7 saying they are. Catalog image serving and mockup compositing
  will break on any fresh build. Highest-priority repo-hygiene fix.
- **`quality/` (2.5 GB) is gitignored**, so the catalog pipeline is not reproducible
  from the repo alone; the per-PDF parser constants (`TARGET_WIDTH_PX`, page groupings)
  encode assumptions about those specific PDFs that can't be validated without them.
- **Integration testers default to real prod URLs and real chat IDs.**
  `live-test.ts` defaults to `https://custom-teamwear-bot.vercel.app`; several
  `test-*` scripts embed `wa:91...` JIDs (both admin and customer). Running them
  unchanged sends real messages and writes real Redis/Sheet rows. There's no guard or
  `--dry-run` flag.
- **No `dotenv/config` consistency.** `generate-catalog.ts`/`live-test.ts` use the
  `dotenv` package; `test-admin-trigger.ts`/`test-admin-email-portal.ts` hand-roll
  `.env` parsing; `mockup-ui-server.ts` reads `process.env` directly without loading
  `.env`. Behavior differs per script — if a var "doesn't load", check which loader
  that script uses.
- **Python scripts hardcode dev-machine paths** (`C:\Users\Suraj\...`,
  `C:\aa\new\quality`) and are non-portable; they're provenance artifacts, not tools.
- **`package.json` description still says "Telegram bot"** and lists `grammY` —
  the same staleness as the webhook scripts.
- **No script is covered by the test suite** (see audit 15); `generate-catalog.ts`
  is 885 lines of parser logic with zero automated coverage, so a brand PDF layout
  change will only be caught by manually inspecting the regenerated JSON.
