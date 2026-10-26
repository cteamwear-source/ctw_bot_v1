# Tech Stack

## Runtime & Hosting
- **Vercel Serverless Functions** (webhook-only; no long polling), region `bom1` (Mumbai), Fluid compute ON.
- Channel is **WhatsApp** (Meta Cloud API via `META_API_BASE_URL`, e.g. Emovur), not Telegram. POSTs are verified with `X-Hub-Signature-256` HMAC when `META_APP_SECRET` is set (mismatch → 401).
- Fast 200: respond right after HMAC + JSON parse, process inside `waitUntil`. One Redis pipeline before the send (`hotPath.begin`: dedupe `upd:<msgId>`, token lock `lock:<chatId>`, flood control `rl:<chatId>:<minute>`, draft `sess:<chatId>`) and one after (`hotPath.finish`: save draft + release lock).
- AI mockups run only in `api/mockup-delivery` (worker); the webhook waits only for its 202.
- `GET /api/webhook?warm=1` → 204 (no Redis/Meta) for an uptime pinger.

## Core Libraries
| Purpose | Library |
|---|---|
| Telegram bot framework | grammY (`grammy`, `@grammyjs/conversations`) |
| Session & Cache store | Upstash Redis (`@upstash/redis`, HTTP client, 24h TTL) |
| Rate limiting | `@upstash/ratelimit` |
| Image processing / Mockups | `sharp` (pixel-accurate deterministic compositing) |
| Durable blob storage | `@vercel/blob` |
| QR generation | `qrcode` (renders `upi://pay` PNG data URLs) |
| CRM / Persistent ledger | `google-spreadsheet` + `google-auth-library` |
| PDF rasterization | `mupdf` (catalog extraction from quality/ PDFs) |
| Error alerting | `@sentry/node` |
| Test runner | Node.js native test runner (`node --import tsx --test`) |

**Zero AI for conversation and pricing.** System is 100% deterministic — no conversational LLMs, no hallucinated prices.

## Data Stores
- **Upstash Redis**:
  - `sess:<chat_id>`: order draft (24h TTL; Redis is the source of truth).
  - `order:<order_id>`: immutable order snapshot.
  - `oid:YYMMDD`: daily atomic order-ID sequence (`INCR` + `EXPIRE` in one pipeline).
  - `upd:<msg_id>`: webhook deduplication marker (24h TTL; deleted on failure).
  - `lock:<chat_id>`: token-owned per-chat lock (30s TTL).
  - `rl:<chat_id>:<epoch_minute>`: flood control, 20 msgs/min (120s TTL).
  - `mockup:quota:<chat_id>:<YYYY-MM>`: monthly mockup quota counter (Asia/Kolkata).
- **Google Sheets**:
  - `Orders` tab: CRM master ledger.
  - `Catalog Selections` tab: Detailed garment style/color audit.
  - `Mockup Generations` tab: Mockup lifecycle and admin payment proof log.
- **Vercel Blob**: Permanent image storage for rendered garment mockups.

## Verified Common Commands
- Install deps: `npm install`
- Run test suite (102+ tests): `npm test`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Local serverless dev: `vercel dev`
- Deploy to Vercel: `vercel deploy` / `vercel deploy --prod`
- Register webhook: `npm run set-webhook -- <deployment-url>`
- Inspect webhook status: `npm run webhook-info`
- Regenerate catalog from PDFs: `npm run generate-catalog`
- Measure WhatsApp API latency: `npm run latency-probe -- [N] [--compare]`

## Security Requirements
- Webhook signature (`X-Hub-Signature-256`) checked on every POST when `META_APP_SECRET` is set.
- All monetary values computed server-side in `src/pricing/`.
- Admin-only actions strictly gated by `chat_id ∈ ADMIN_CHAT_IDS` checked server-side.
- Formula-injection sanitizer (`sanitizeForSpreadsheet`) on every sheet-bound string.
