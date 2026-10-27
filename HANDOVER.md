# Custom Teamwear WhatsApp Bot — Production Handover Documentation

**Last Updated:** 2026-10-27  
**Build Stamp:** `2026-10-27-perf-fast-replies`  
**Production URL:** https://ctwbotv1.vercel.app  
**Repository:** https://github.com/cteamwear-source/ctw_bot_v1.git (branch: `main`)

---

## 1. System Overview

**Custom Teamwear (CTW) WhatsApp Bot** is a high-performance, click-first bulk apparel ordering system (Minimum Order Quantity: 50 pieces). It automates the customer journey from tier browsing to catalog selection, quantity brackets, size distribution, printing preferences, address collection, logo uploading, deterministic mockup generation, quotation rendering, and UPI payment collection.

Once a payment screenshot is submitted, the bot notifies administrators via **Resend Email** with an OTP and a secure HMAC-signed Admin Review Portal link to verify and confirm orders into **Google Sheets CRM**.

---

## 2. Infrastructure & Connected Services

| Service | Provider / Host | Account / ID | Purpose |
|---|---|---|---|
| **Web & API Hosting** | Vercel (Serverless, `bom1` Mumbai) | Project: `ctw_bot_v1` (Team: `ctw13`) | Runs webhook, background workers, and admin portal |
| **WhatsApp Tech Provider** | Emovur (`backendprod.com`) | WABA: `1595948008687111`<br>Phone ID: `1404775792711749`<br>Number: `+91 91879 51540` | Outbound WhatsApp API gateway & inbound webhook forwarder |
| **Session & State Store** | Upstash Redis | `REDIS_REST_URL` | Fast locks, draft sessions, deduplication, rate limits, quota |
| **CRM & Order Records** | Google Sheets API | `SHEET_ID` via Service Account | 3 Tabs: `Orders`, `CatalogSelections`, `MockupGenerations` |
| **Admin Notifications & OTP** | Resend API | `RESEND_API_KEY` | Sends payment verification emails with OTP & secure portal links |
| **Mockup & Proof Storage** | Vercel Blob | `BLOB_READ_WRITE_TOKEN` | Stores uploaded customer logos and generated mockup proof images |
| **AI Mockup Engine** | OpenAI (`gpt-image-2.5-flare`) | `OPENAI_API_KEY` | Stylized apparel mockup visualization (proof is deterministic Sharp) |
| **Error Monitoring** | Sentry | `SENTRY_DSN` | Real-time crash and error reporting |

---

## 3. Architecture & Data Flow

```
[Customer WhatsApp]
       │
       ▼
 [Emovur Tech Provider: metagraph.backendprod.com]
       │ (HTTP POST forwarded to https://ctwbotv1.vercel.app/api/webhook)
       ▼
[api/webhook.ts]  ──► (Immediate 200 OK via @vercel/functions waitUntil)
       │
       ▼
[src/session/hotPath.ts]  ──► Upstash Redis (Dedupe check, Lock acquire, Rate limit)
       │
       ▼
[src/conversation/orderFlow.ts]  (S00–S11 State Machine)
  ├── S00: Tier (Basic / Standard / Branded)
  ├── S01: Catalog Group & Item Selection
  ├── S02: Quantity (Hard gate: MOQ 50)
  ├── S03: Size Split (Even, Standard Mix, or Custom)
  ├── S04: Print Method (Screen, DTF, Embroidery)
  ├── S05–S07: City, Contact Name, Phone
  ├── S08: Delivery Timeline
  ├── S09: Multi-logo Upload Loop (Placements: chest, back, sleeves)
  ├── S10: Order Assembly & Deterministic Sharp Mockup Preview
  └── S11: 50% Advance Quotation Card + Dynamic UPI QR
       │
       ▼ (Customer uploads payment screenshot)
[src/admin/notify.ts]
  ├── Sends customer acknowledgement ("Payment under review")
  ├── Appends raw order row to Google Sheets (3 retries with fallback)
  └── Dispatches Email to Admin (via Resend) with OTP + 7-day signed Portal Link
       │
       ▼
[Admin Email Portal: api/admin-portal.ts]
  └── Admin inputs OTP to verify payment ──► Order marked Confirmed in CRM
```

---

## 4. Repository Structure & Key Files

```
├── api/
│   ├── webhook.ts            # WhatsApp webhook entry (200-ACK in <50ms; processes in waitUntil)
│   ├── mockup-delivery.ts    # Background worker for AI mockup rendering (120s execution budget)
│   ├── heartbeat.ts          # Daily cron health-check (protected by CRON_SECRET)
│   └── health.ts             # Public status/diagnostics endpoint (/api/health)
├── src/
│   ├── admin/
│   │   ├── notify.ts         # Resend email dispatcher + WhatsApp alert fallback
│   │   ├── approvalCode.ts   # OTP generator, failed-attempt lockout, daily resend caps
│   │   └── portalToken.ts    # HMAC-SHA256 7-day token minting for admin review URLs
│   ├── bot/
│   │   └── index.ts          # Incoming message router and payload unmarshaler
│   ├── catalog/              # Generated apparel catalog (tiers, fabrics, colors, styles)
│   │   └── data/             # catalog.generated.json + overrides.json
│   ├── config/
│   │   ├── env.ts            # Central fail-fast environment validator (getEnv())
│   │   └── version.ts        # BUILD_STAMP and active feature flags
│   ├── conversation/
│   │   ├── orderFlow.ts      # Core state machine steps (S00 through S11)
│   │   ├── copy.ts           # Authoritative user-facing copywriting (never improvise)
│   │   ├── draft.ts          # OrderDraft state definition
│   │   └── uiMapper.ts       # WhatsApp interactive button & list payload builder
│   ├── mockup/
│   │   ├── composite.ts      # Pixel-exact Sharp compositing (authoritative proof)
│   │   ├── zones.ts          # Garment coordinates for 5 print placements
│   │   ├── quota.ts          # Monthly free quota (3/month per user; ₹20/mockup after)
│   │   └── deliverTrigger.ts # Dispatches background worker for slow renders
│   ├── pricing/
│   │   ├── priceBook.ts      # ONLY place rupee base prices and bracket discounts live
│   │   └── index.ts          # Pure pricing calculation engine (MOQ, split math, GST)
│   ├── session/
│   │   ├── hotPath.ts        # Optimized Redis pipelines (begin, finish, abort)
│   │   ├── redisClient.ts    # Upstash Redis connection wrapper
│   │   └── statusMachine.ts  # Forward-only order status transitions
│   ├── shared/
│   │   ├── render.ts         # Shared renderer for Customer Quote Card & Admin Summary Card
│   │   └── sanitize.ts       # Spreadsheet formula injection protection (=, +, -, @)
│   └── sheets/
│       ├── client.ts         # Google Sheets service client
│       └── safeAppend.ts     # Resilient sheet append with retry and admin escalation
├── assets/
│   └── catalog/              # Pre-rendered apparel images (committed to repository)
└── tests/                    # 236 Node.js test-runner suites (node --import tsx --test)
```

---

## 5. Environment Variables & Secret Configuration

All production variables are configured in Vercel under Project `ctw13/ctw_bot_v1`:

| Environment Variable | Source / Value Description | Required? |
|---|---|:---:|
| `CHANNEL` | `"whatsapp"` | Yes |
| `META_API_TOKEN` | Emovur Permanent Bearer Token | Yes |
| `META_PHONE_NUMBER_ID` | `1404775792711749` | Yes |
| `META_BUSINESS_ACCOUNT_ID` | `1595948008687111` | Yes |
| `META_WEBHOOK_SECRET` | Webhook verification handshake token | Yes |
| `META_API_BASE_URL` | `https://metagraph.backendprod.com` (Emovur wrapper) | Yes |
| `ALLOW_UNVERIFIED_WEBHOOK` | `"true"` (allows Emovur forwarder without Meta HMAC header) | Yes |
| `CRON_SECRET` | 32-byte hex secret securing `/api/heartbeat` | Yes |
| `INTERNAL_MOCKUP_SECRET` | Secret securing `/api/mockup-delivery` background worker | Yes |
| `ADMIN_PORTAL_SECRET` | Secret key used to sign Admin Review Portal URLs | Yes |
| `ADMIN_EMAILS` | Comma-separated admin emails receiving payment alerts | Yes |
| `ADMIN_EMAIL_FROM` | Verified sender (e.g., `Custom Teamwear <orders@customteamwear.in>`) | Yes |
| `RESEND_API_KEY` | Resend API key for transactional emails | Yes |
| `MERCHANT_VPA` | UPI Virtual Payment Address for dynamic payment QR | Yes |
| `STATIC_QR_URL` | Fallback UPI QR image URL | Yes |
| `REDIS_REST_URL` | Upstash Redis REST endpoint URL | Yes |
| `REDIS_REST_TOKEN` | Upstash Redis REST access token | Yes |
| `GOOGLE_SERVICE_ACCOUNT_JSON`| Google Cloud Service Account JSON credentials | Yes |
| `SHEET_ID` | Google Spreadsheet ID for order CRM | Yes |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob access token for mockup and logo storage | Yes |
| `OPENAI_API_KEY` | OpenAI API key for AI mockup style generation | Yes |
| `MOCKUP_IMAGE_PROVIDER` | `"openai"` | Yes |
| `MOCKUP_IMAGE_MODEL` | `"gpt-image-2.5-flare-2026-09-08"` | Yes |
| `MOCKUP_FREE_PER_MONTH` | `3` (Free mockups per chat per calendar month) | Yes |
| `MOCKUP_PAID_PRICE_INR` | `20` (Cost per mockup after free quota) | Yes |
| `PUBLIC_BASE_URL` | `https://ctwbotv1.vercel.app` | Yes |
| `SENTRY_DSN` | Sentry DSN for production monitoring | Optional |

---

## 6. Critical Invariants (Rules of the Codebase)

1. **Pricing Centralization:** All rupee calculations occur inside `src/pricing/index.ts`. All base rates are stored strictly in `src/pricing/priceBook.ts`. Never hardcode prices in UI copy or order flows.
2. **Identical Quotation & Admin Rendering:** `src/shared/render.ts` renders both the customer quote card and admin email card from the exact same `OrderData` model to guarantee numbers never diverge.
3. **Fail-Safe Accounting:** If writing to Google Sheets fails after 3 retries, `src/sheets/safeAppend.ts` immediately logs the complete order payload to admin alerts and throws.
4. **Formula Injection Sanitization:** Every user-supplied text field (name, city, address) is sanitized through `src/shared/sanitize.ts` to prevent spreadsheet formula execution (`=`, `+`, `-`, `@`).
5. **Deterministic Mockups for Print Proofs:** Generative AI is strictly optional for artistic previews. The authoritative print proof is always generated deterministically by Sharp in `src/mockup/composite.ts`.
6. **Forward-Only State Machine:** Orders and Mockup Generations follow strict forward-only transitions (`Pending Payment → Confirmed | Payment Issue`). Invalid state jumps throw errors.

---

## 7. Operational Runbook & Maintenance

### Daily Monitoring & Verification
- **Health Check:** `curl https://ctwbotv1.vercel.app/api/health`
  - Expected: `{"ok": true, "buildStamp": "2026-10-27-perf-fast-replies", ...}`
- **Heartbeat:** Runs daily via Vercel Cron at 08:00 IST with bearer `CRON_SECRET`.
- **Live Logs:** In Vercel Dashboard or via CLI:
  ```powershell
  vercel logs https://ctwbotv1.vercel.app -n 50
  ```

### Emovur Forward Webhook Setup
If the webhook URL ever needs to be re-entered in Emovur:
1. Log in to [admin.emovur.com](https://admin.emovur.com).
2. Go to **WhatsApp → Forward Webhooks**.
3. Set URL to: `https://ctwbotv1.vercel.app/api/webhook`.
4. Click **Update** (must return 200 within 1.5 seconds).

### Code Validation & Deployment
Before pushing any code changes:
```powershell
# 1. Typecheck
npm run typecheck

# 2. Run All Unit & Integration Tests (236 tests)
npm test

# 3. Push to Git
git push client main

# 4. Deploy to Vercel Production
vercel deploy --prod
```

### Catalog Updates
When new garment styles or pricing PDFs are provided:
1. Place source PDFs in `quality/`.
2. Update manual overrides in `src/catalog/data/overrides.json` if needed.
3. Run `npm run generate-catalog` to rebuild catalog JSON and image assets.
4. Commit both `catalog.generated.json` and `assets/catalog/**`.