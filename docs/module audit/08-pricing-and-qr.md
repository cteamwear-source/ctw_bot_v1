# 08 — Pricing Engine & QR Module (`src/pricing/`, `src/qr/`)

## Purpose

These two modules implement the money side of the bot under repo invariant #1 and #3:

- **`src/pricing/`** is the *only* place a rupee amount may be computed, and
  `src/pricing/priceBook.ts` is the *only* place a rupee figure may be hardcoded. Everything
  else (`orderFlow.ts`, `shared/render.ts`, Sheets writers, admin cards) merely transports or
  displays numbers produced here. `priceBook.ts` is pure DATA; `index.ts` is a set of pure
  functions over it (PRD §6.1–§6.3).
- **`src/qr/`** builds the UPI payment deep-link and renders it as a PNG QR code for the
  payment screen (PRD §7.4).

## Files covered

| File | Role |
|---|---|
| `src/pricing/priceBook.ts` | Data-only price book: tiers, products, variant rates, print methods, MOQ/brackets, sample-kit & mockup prices, logo placements, size mix weights |
| `src/pricing/index.ts` | Pure pricing engine: brackets, rates, totals, advance, estimates, size-split resolvers |
| `src/qr/index.ts` | `buildUpiUri()` + `generateUpiQrPng()` (qrcode package) |
| `tests/pricing.test.ts` | Pricing-engine tests (skimmed, summarised below) |
| `tests/render.test.ts` | Quote/admin card rendering tests that pin exact money strings (skimmed below) |

---

## The price book (`src/pricing/priceBook.ts`)

### Vocabulary types

- `Tier = "basic" | "standard" | "branded"` — catalog tiers reuse this exactly.
- `ProductId = "dry_fit_round_neck" | "dry_fit_polo" | "cotton_round_neck" | "cotton_polo"`.
- `Silhouette = "round_neck" | "polo"` — fabric doesn't change a mockup's shape, so every
  product maps to one of two silhouettes:

| ProductId | Silhouette (`PRODUCT_SILHOUETTE`) |
|---|---|
| `dry_fit_round_neck` | `round_neck` |
| `cotton_round_neck` | `round_neck` |
| `dry_fit_polo` | `polo` |
| `cotton_polo` | `polo` |

### Tier display data

| Constant | Value |
|---|---|
| `TIER_LABELS` | `basic: "Basic"`, `standard: "Standard"`, `branded: "Premium Branded"` |
| `TIER_PITCH` | basic: "Great choice. Basic tier — best value for events & colleges." / standard: "Better quality, better finish." / branded: "Global brands. Corporate prestige." |
| `TIER_FROM_RATE` (₹, cheapest 50+ rate per tier, used on S00 menu buttons) | basic **169**, standard **219**, branded **499** |

### Base garment rates — `PRODUCT_CATALOG` (ex-GST ₹ per piece)

Bracket 1 = qty 50–99, bracket 2 = qty 100+. Display label is tier-specific.

| ProductId | Basic 50–99 / 100+ | Standard 50–99 / 100+ | Branded 50–99 / 100+ | Labels (basic / standard / branded) |
|---|---|---|---|---|
| `dry_fit_round_neck` | 169 / 159 | 219 / 199 | 499 / 449 | Round Neck Dry Fit / Round Neck Dry Fit / Branded Dry Fit Tee |
| `dry_fit_polo` | 289 / 249 | 359 / 309 | 709 / 629 | Polo Dry Fit / Polo Dry Fit / Branded Polo Tee |
| `cotton_round_neck` | 259 / 239 | 319 / 289 | 599 / 529 | Round Neck Cotton / Round Neck Cotton / Branded Cotton Tee |
| `cotton_polo` | 389 / 359 | 469 / 429 | 869 / 789 | Cotton Polo / Cotton Polo / Branded Corporate Polo |

### Variant-specific rates — `VARIANT_RATES` (ex-GST ₹ per piece, `[50–99, 100+]`)

Derived from `pricing_options_template.csv`. **The keys are exactly the `QualityOption.id`s
in `src/catalog/options.ts`** (prefixed `val-` = Basic, `rec-` = Standard, `prem-` =
Premium) — that id-sharing is the catalog↔pricing seam for the live flow.

| VariantId (quality option) | 50–99 | 100+ | Notes |
|---|---|---|---|
| `val-cp-1-uf-008` … `val-cp-7-uf-009` (all 7 Basic cotton-polos) | 389 | 359 | Same as base `cotton_polo` basic |
| `val-dfp-1-uf-008` … `val-dfp-7-uf-009` (all 7 Basic dry-fit-polos) | 289 | 249 | Same as base `dry_fit_polo` basic |
| `val-crn-finch-bio-wash` (Basic cotton RN) | 259 | 239 | = base |
| `val-dfrn-finch-active-mars` (Basic dry-fit RN) | **199** | **179** | ⚠ *cheaper than the base basic RN rate (169/159 is base dry-fit RN — this variant is priced above base; see Risks)* |
| `rec-cp-finch-classic` (Std cotton polo) | 469 | 429 | = base |
| `rec-dfp-finch-classic-polo` (Std "Finch Classic Polo 260 GSM", keyed under cotton_polo in options) | 489 | 459 | Above base |
| `rec-dfp-finch-superia` (Std Finch Superia Mars) | 429 | 399 | Above base (359/309) |
| `rec-dfp-finch-piper` (Std Finch Piper Mars) | 489 | 459 | |
| `rec-dfp-finch-jacquard` (Std Finch Jacquard Mars) | 489 | 459 | |
| `rec-crn-finch-bio-wash` (Std cotton RN) | 319 | 289 | = base |
| `rec-dfrn-finch-active-mars` (Std dry-fit RN) | 219 | 199 | = base |
| `prem-vh-polo`, `prem-stellars-softberry` (Premium cotton polos) | 869 | 789 | = base |
| `prem-adidas-polo`, `prem-reebok-polo` (Premium dry-fit polos) | **789** | **769** | vs base 709/629 — branded polos cost *more* than the generic branded rate |
| `prem-stellars-nano-dry` | 709 | 689 | = base |
| `prem-vh-rn` (Premium VH cotton RN) | 599 | 529 | = base |
| `prem-adidas-rn`, `prem-reebok-rn` (Premium dry-fit RNs) | **599** | **579** | vs base 499/449 |

### Print methods — `PRINT_METHODS` (ex-GST ₹ per piece range; an **estimate**, never exact)

| id | Label | Range [low, high] | Hint |
|---|---|---|---|
| `screen_print` | Screen Print | 25 – 45 | Most economical; best for bold logos on cotton. |
| `dtf` | DTF Print | 35 – 70 | Vivid multi-colour, works on all fabrics. |
| `sublimation` | Sublimation | 30 – 60 | All-over prints; sportswear favourite. |
| `embroidery` | Embroidery | 50 – 120 | Premium; ideal for polos & corporate wear. |
| `not_sure` | Not sure — advise me | 25 – 120 | Agent recommends after artwork review. |
| `none` | Plain (No Print) | 0 – 0 | Plain blank sample T-shirts. |

### Business constants

| Constant | Value | Meaning |
|---|---|---|
| `MOQ` | 50 | Hard minimum order quantity (pieces) |
| `BRACKET_THRESHOLD` | 100 | Qty at which the discounted slab kicks in |
| `HIGH_VALUE_CALLOUT_QTY` | 300 | Reference value; the "📞 Call Me" gate is `qty > 300` (strict) |
| `SAMPLE_KIT_PRICES` | polyester **1999**, cotton **2499** | Fixed totals for the 3-piece trial kit |
| `MOCKUP_PRICES` | singleView **10**, frontAndBack **20** | Paid extra mockup generation (consumed by `src/mockup/quota.ts` via `computeMockupFee`) |

### Non-money product data also living in the price book

- `LOGO_PLACEMENTS` (5): `left_chest`, `center_front`, `upper_back`, `left_sleeve`,
  `right_sleeve`, each with label + hint. "Front + Back" is expressed by uploading the same
  logo twice through the multi-logo loop rather than being a placement value, so every
  placement maps to exactly one mockup template view.
- `APPLICATION_METHODS` (3): `print`, `embroidery`, `recommend` ("Not sure — recommend").
- `SIZE_KEYS`: `["S","M","L","XL","XXL","3XL"]`.
- `STANDARD_MIX_WEIGHTS` (PRD Appendix A, out of 100): S 10, M 25, L 30, XL 20, XXL 10, 3XL 5.

---

## The pricing engine (`src/pricing/index.ts`) — formula by formula

All functions are pure; the only inputs are price-book data + `(tier, productId, qty[, variantId])`.

| Function | Exact math |
|---|---|
| `meetsMoq(qty)` | `qty >= 50` (49 → false, 50 → true) |
| `getBracket(qty)` | `qty >= 100 ? "100+" : "50-99"` |
| `getProduct(productId)` | Linear find in `PRODUCT_CATALOG`; throws `Unknown productId` if absent |
| `getPrintMethod(id)` | Linear find in `PRINT_METHODS`; throws if absent |
| `getGarmentRate(tier, productId, qty, variantId?)` | **Override-first:** if `variantId` given and present in `VARIANT_RATES`, return `qty>=100 ? rate100 : rate50` from that pair. Otherwise use `PRODUCT_CATALOG[productId].rates[tier]` and the same bracket pick. Returns the **exact** per-piece figure (all rates are integers, so no rounding ever occurs here). |
| `getNextBracketRate(tier, productId, qty, variantId?)` | If already `"100+"` → `null`. Else: `currentRate = getGarmentRate(…, qty, …)`, `nextRate = getGarmentRate(…, 100, …)`, `savingsTotal = (currentRate − nextRate) × 100`. Drives the S2 upsell nudge ("bump to 100 and save ₹X"). Note `savingsTotal` is the saving for an order of **exactly 100** pcs, not for the customer's current qty. |
| `computeGarmentTotal(tier, productId, qty, variantId?)` | `{ ratePerPiece, qty, total: ratePerPiece × qty }` — **exact**, integer, ex-GST. |
| `computeSampleKitTotal(fabric)` | Fixed `total = 1999 (polyester) \| 2499 (cotton)`; `ratePerPiece = Math.round(total / 3)` → 666 (polyester) / 833 (cotton); `qty = 3`. |
| `computeMockupFee(views?)` | No/empty views → 10. Both `"front"` and `"back"` present → 20. Otherwise (single view) → 10. |
| `computePrintEstimate(printMethod, qty)` | `{ low: range[0] × qty, high: range[1] × qty }` — an **estimate range**, ex-GST. |
| `computeGrandEstimate(garmentTotal, printEstimate)` | `{ low: garmentTotal + print.low, high: garmentTotal + print.high }` — garment part is exact, print part is a band. **Excludes GST.** |
| `computeAdvanceDue(garmentTotal, {orderType})` | bulk (default): `Math.ceil(garmentTotal × 0.5)`. sample: `garmentTotal` (100% upfront). |
| `showsCallMe(qty)` | `qty > 300` (strict — 300 false, 301 true) |
| `resolveEvenSplit(qty)` | `base = floor(qty / 6)` in every size; remainder `qty − 6×base` distributed one piece at a time in order **M, L, S, XL, XXL, 3XL**. Sums exactly to `qty`. |
| `resolveStandardMix(qty)` | Proportional to `STANDARD_MIX_WEIGHTS` (sum 100): `exact_k = qty × w_k / 100`; take `floor` of each; leftover `qty − Σfloors` given out by the **largest-remainder method** (descending fractional part). Sums exactly to `qty`. |
| `sizeSplitSum(split)` | `Σ split[S..3XL] ?? 0` |
| `isSizeSplitComplete(split, qty)` | `sizeSplitSum(split) === qty` — the exact-sum invariant the S3 step enforces (incl. the "own split" fix-up). |

### Rounding rules (the complete set)

1. **Advance:** `Math.ceil` on `garmentTotal × 0.5` — never under-collect a fraction of a
   rupee (₹359 → 179.5 → **180**; ₹28721 → 14360.5 → **14361**).
2. **Sample kit per-piece display:** `Math.round(total / 3)` (₹1999 → 666, ₹2499 → 833) —
   display-only; the charged total stays the exact fixed price.
3. **Everything else is exact integer arithmetic** — every rate in the book is a whole-rupee
   integer, and totals are plain `rate × qty` or additive sums of integers. There is no
   GST handling anywhere in the engine (all figures are ex-GST, per the price book comments).

### How the advance / payment amounts are derived (end-to-end)

In `orderFlow.ts` (payment step and `assembleOrderData` — the two call sites are identical):

```
garment      = sample ? computeSampleKitTotal(fabric)
                      : computeGarmentTotal(tier, productId, qty, draft.qualityOptionId)
printEst     = sample ? {0,0} : computePrintEstimate(printMethod, qty)
grandEst     = sample ? {garment.total, garment.total}
                      : computeGrandEstimate(garment.total, printEst)
advanceDue   = computeAdvanceDue(garment.total, { orderType })
```

Key properties:

- The **advance is 50% of the garment total only** — the print-estimate band is *not*
  included in the advance, and GST is excluded everywhere.
- The quote card shows the exact garment line (`100 × ₹309 = ₹30,900`), the print band, the
  grand band, and `Pay today (T-Shirt advance ≈ 50%): ₹15,450`; sample kits show
  `Pay today (100% full payment): ₹2,499`.
- All seven money figures are frozen into the `OrderData` record
  (`garmentRate`, `garmentTotal`, `printEstLow`, `printEstHigh`, `grandEstLow`,
  `grandEstHigh`, `advanceDue`), saved as the Redis order snapshot, rendered by the shared
  renderer (`src/shared/render.ts` — customer quote + admin card from the same data, invariant
  #2), and appended to the Orders sheet. From that point on nothing recomputes money.
- The QR amount is derived from this same `advanceDue` (see QR section for how the live path
  actually uses it — or doesn't).

### Invariants (centralisation)

- No rupee figure may be hardcoded outside `priceBook.ts`; no rupee amount may be *computed*
  outside `index.ts`. `orderFlow.ts`, `copy.ts`, `render.ts`, Sheets writers, mockup quota,
  etc. import functions from `src/pricing/` and format the returned numbers.
- The catalog maps onto `ProductId`s so pricing is catalog-agnostic: brand/style affects the
  price **only** through the optional `variantId` override table, never through new logic.
- Money events must never fail silently (invariant #3): these computed values flow into the
  sheet-append path with the text-fallback escalation, so a pricing bug would be visible in
  the order data itself.

---

## The QR module (`src/qr/index.ts`)

```ts
buildUpiUri(merchantVpa, advanceDue, orderId)
  → `upi://pay?` + URLSearchParams({ pa: merchantVpa, am: String(advanceDue), tn: orderId, cu: "INR" })

generateUpiQrPng(merchantVpa, advanceDue, orderId)
  → QRCode.toBuffer(buildUpiUri(...), { type: "png", width: 512, margin: 2 })
```

- **Params:** `pa` = merchant VPA (from `env.MERCHANT_VPA`), `am` = amount as a plain decimal
  string (the advance due), `tn` = the order id reused as the UPI transaction note, `cu = INR`.
  `URLSearchParams` handles percent-encoding of any special characters.
- **PNG:** `qrcode` package, 512 px wide, quiet-zone margin 2 modules, returned as a `Buffer`
  suitable for sending as a WhatsApp media upload.
- **Static vs dynamic in the live flow — important:** the payment screen in
  `orderFlow.ts` currently sends a **static QR image URL**, not the dynamic PNG:
  - `qrUrl = env.STATIC_QR_URL` (both `MERCHANT_VPA` and `STATIC_QR_URL` are *required* env
    vars in `src/config/env.ts`), except when it contains `drive.google.com`, in which case
    it falls back to a hardcoded Vercel Blob URL
    `https://bkxivup64ugazlbe.public.blob.vercel-storage.com/payment-qr.jpg`.
  - The dynamic `generateUpiQrPng(env.MERCHANT_VPA, 1000, draft.orderId!)` call exists only
    inside an `if (false) { … }` block literally commented "To satisfy tests" — dead code at
    runtime (with a hardcoded `1000` amount, no less). The customer-facing copy in
    `copy.ts` still describes a "secure UPI link … amount pre-filled with your Order ID
    attached", which is only true of the dynamic encoding, not of the static image actually
    sent. The `buildUpiUri`/`generateUpiQrPng` functions themselves are correct and tested
    components awaiting (re-)wiring.
- The mockup ₹20 paid-generation flow does **not** use this module: it instructs the customer
  to pay `MOCKUP_PAID_PRICE_INR`/`computeMockupFee()` and send a screenshot, verified
  manually by admins (`src/mockup/paidGeneration.ts`).

---

## Tests covered (skimmed)

`tests/pricing.test.ts` (Node test runner, 12 tests):

- MOQ gate (49 false / 50 true) and bracket boundaries (99 → "50-99", 100 → "100+").
- Garment totals from the book: 60 × Basic dry-fit RN = ₹169 → 10,140; 100 × Std dry-fit
  polo uses the 100+ rate 309 → 30,900.
- Advance: 80 × ₹359 = ₹28,720 → advance ₹14,360; ceil behaviour pinned
  (359→180, 1→1, 28720→14360, 28721→14361); sample orders collect 100% (1999/2499), bulk of
  the same total collects 1000.
- Print estimate scales linearly (dtf × 80 → 2800–5600); grand estimate = exact garment + band.
- Call-Me gate (300 hidden / 301 shown).
- Even split and standard mix **always sum exactly to qty** across 50, 51, 55, 80, 100, 137,
  1000 with all sizes ≥ 0.
- Variant-rate overrides: Finch Superia 429/399, Finch Classic Polo 489/459, basic Finch
  Active Mars 199/179 — confirming `VARIANT_RATES` wins over base product rates at both
  brackets.

`tests/render.test.ts` (3+ tests, pins money formatting): quote/admin cards use "T-Shirt"
terminology and never "garment"; bulk card renders `100 × ₹309 = *₹30,900*`,
`Pay today (T-Shirt advance ≈ 50%): ₹15,450`, and the catalog selection line
(`Finch Superia Mars · White`); sample card renders the kit title and
`Pay today (100% full payment): ₹2,499` — i.e. the renderer must agree with the engine's
rounding and 100%-vs-50% rules exactly.

---

## Data contracts

- `GarmentTotal = { ratePerPiece, qty, total }` — the exact garment figure.
- `PrintEstimate = { low, high }`, `GrandEstimate = { low, high }` — bands, ex-GST.
- `OrderData` money fields (the persisted contract): `garmentRate`, `garmentTotal`,
  `printEstLow/High`, `grandEstLow/High`, `advanceDue` — computed once in the payment step /
  `assembleOrderData`, then consumed verbatim by the shared renderer, the order snapshot,
  the admin card and the Sheets append.
- `Bracket = "50-99" | "100+"`; `SizeKey` / `Record<SizeKey, number>` splits must satisfy
  `isSizeSplitComplete` before an order proceeds.
- `VARIANT_RATES` keys must equal the `QualityOption.id`s in `src/catalog/options.ts`
  (`val-*`/`rec-*`/`prem-*`) — an unenforced, stringly-typed coupling (see Risks).
- UPI URI contract: `upi://pay?pa=<vpa>&am=<advanceDue>&tn=<orderId>&cu=INR`.

---

## Execution flow

```
S00 tier ── TIER_FROM_RATE labels
S2 qty ──── meetsMoq gate; getBracket; getNextBracketRate upsell nudge
S3 sizes ── resolveEvenSplit | resolveStandardMix | manual + isSizeSplitComplete fix-up
S4 print ── PRINT_METHODS labels/hints
S10/S11 order assembly:
    garment   = computeGarmentTotal(tier, productId, qty, qualityOptionId)   [exact]
    printEst  = computePrintEstimate(printMethod, qty)                       [band]
    grandEst  = computeGrandEstimate(...)                                    [exact + band]
    advance   = computeAdvanceDue(garment.total, {orderType})                [ceil(50%) | 100%]
    → OrderData snapshot → renderQuoteCard → payment screen
Payment screen (today): static QR image (env.STATIC_QR_URL or hardcoded Blob fallback)
                        + "send payment screenshot" message
                        [dynamic generateUpiQrPng exists but is dead-coded behind if(false)]
Mockup quota (₹20 path): computeMockupFee(views) → 10 | 20
```

---

## Risks & observations

1. **Dynamic QR is dead code; the live payment QR is static.** `generateUpiQrPng` is only
   reachable inside `if (false)` with a hardcoded `1000` amount, and the payment screen sends
   a static image (`STATIC_QR_URL` or a hardcoded third-party Blob URL). Consequences: the
   pre-filled amount / order-id note promised by the copy never reaches the customer's UPI
   app; admins must match screenshots to orders manually; and a hardcoded Blob URL inside
   source is a config smell (it bypasses the env-validation invariant for this one asset).
   If dynamic QR is re-enabled, wire it to the *actual* `advanceDue` and upload the buffer
   (e.g. Blob) rather than the `1000` placeholder.
2. **Advance excludes print + GST.** `advanceDue = ceil(50% × garmentTotal)` ignores the
   print-estimate band and GST entirely. That's by design ("T-Shirt advance"), but staff and
   the admin card should treat `grandEstHigh` as the realistic upper bound of the final
   invoice; nothing in the system tracks a later "balance due" calculation.
3. **`VARIANT_RATES` is stringly-typed and duplicated with `options.ts`.** The variant keys
   must be kept in sync by hand with `CATALOG_OPTIONS` ids; a typo silently falls back to the
   base product rate (the lookup is `if (variantId && VARIANT_RATES[variantId])`) — i.e.
   under- or over-quoting with no error. There is also **no connection** between
   `VARIANT_RATES` keys and the *generated* catalog variant ids (`…-i39-v483` style), so if
   the flow ever moves fully to the generated manifest, variant-level pricing would silently
   stop applying.
4. **Suspicious/uneven variant pricing worth a human review.** Basic dry-fit RN base rate is
   169/159, but the `val-dfrn-finch-active-mars` variant is 199/179 (variant *above* base),
   while several branded variants price *above* their generic branded base
   (adidas/reebok polos 789/769 vs base 709/629). This may be intentional tiering, but
   nothing structurally prevents a bad row; the price-book is the single place to fix it.
5. **`getNextBracketRate` savings semantics.** `savingsTotal = (current − next) × 100` is the
   saving at exactly 100 pcs. For a customer at, say, 95 pcs the nudge implies a specific
   counterfactual ("order 100 and save ₹X") that isn't the saving on their *current* qty —
   fine for copy, wrong if anyone reuses it as a general savings calculator.
6. **`HIGH_VALUE_CALLOUT_QTY` (300) is unused as a constant** — `showsCallMe` hardcodes the
   strict `> 300` comparison rather than referencing it; the "300 hidden / 301 shown" test
   pins the behaviour. Minor duplication risk if one is changed without the other.
7. **No GST, no discounts beyond the 100+ slab, no rounding-to-paise** anywhere. All figures
   are integer rupees, ex-GST. If GST-inclusive quotes become a requirement, every band and
   the ceil rule need revisiting in this module only (which is exactly the point of the
   centralisation invariant).
8. **Print estimate is client-facing but arbitrary.** The `[low, high]` bands are static
   per-method numbers with no artwork/colour-count/size logic; `not_sure` spans the full
   25–120 envelope. The grand range therefore widens with qty (e.g. embroidery × 300 →
   ₹15,000–36,000 band) — the admin follow-up is what actually pins the print cost.
9. **Sample-kit "ratePerPiece" is cosmetic.** `Math.round(total/3)` (666/833) is display-only;
   the charged amount is the fixed kit price. Don't reuse `ratePerPiece × qty` for sample
   orders — the engine itself never does (it charges `total`).
