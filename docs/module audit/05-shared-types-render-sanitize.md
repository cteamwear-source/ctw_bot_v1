# Module Audit 05 — Shared Types, Renderer & Sanitizer (`src/shared/`)

> Knowledge-transfer review. Read `AGENTS.md` first for repo invariants; this
> document goes deeper on the three-file `src/shared/` layer only. All facts
> below are taken directly from the source files listed under "Files covered".

## Purpose

`src/shared/` is the bot's **common vocabulary layer**, three files with three
jobs:

- **`types.ts`** — the domain types every other module agrees on:
  `OrderData` (the money-bearing order record), `CatalogSelection` (the
  customer's confirmed PDF-catalog pick), `MockupGeneration` + its status
  machine, `OrderStatus`, `LogoUpload`, `Timeline`, `SizeSplit`.
- **`render.ts`** — the *single* renderer that produces both the customer
  quote card and the admin order card **from the same `OrderData`**, making
  disagreement between the two structurally impossible (AGENTS.md invariant
  #2, PRD §7.1). Also the customer confirmation DM.
- **`sanitize.ts`** — the Google-Sheets formula-injection sanitizer and input
  validators (AGENTS.md invariant #5's `sanitizeForSheet`, tech.md security
  requirement: strip leading `=`, `+`, `-`, `@` and control characters from
  every sheet-bound string; cap name 60 / city 40 / phone 15).

Together they underpin two of the repo's non-negotiable invariants: **#2 (one
shared renderer)** and **#5 (security gates, monetary values computed
server-side only)**. Pricing itself is *not* here — it lives in
`src/pricing/` and is consumed by `render.ts` via `getProduct` /
`getPrintMethod`.

## Files covered

| File | Role |
|---|---|
| `src/shared/types.ts` | Domain type inventory (185 lines, no runtime code) |
| `src/shared/render.ts` | `renderQuoteCard`, `renderAdminCard`, `renderConfirmationDm` + private helpers |
| `src/shared/sanitize.ts` | `sanitizeForSheet` + per-field sanitizers + `normalizeIndianPhone` + `isValidQty` |

## 1. `types.ts` — full type inventory

Pure type declarations (plus one non-exported nothing — there is no runtime
code in this file). It imports type-only symbols from
`../pricing/priceBook.js`: `LogoPlacement`, `PrintMethod`, `ProductId`,
`Silhouette`, `SizeKey`, `Tier`.

### `LogoUpload`

```ts
interface LogoUpload { fileId: string; placement: LogoPlacement; }
```

One uploaded logo and where it goes. `placement` is a pricing-book
`LogoPlacement` id. An order (or mockup generation) carries **zero or more**
of these — multi-logo, per-placement is supported (see `OrderData.logos`).

### `ReferenceImageKind` and `CatalogSelection`

```ts
type ReferenceImageKind = "rendered-page" | "external-link" | "placeholder";
```

Determines **how the mockup pipeline physically loads** the confirmed garment
reference (a locally rendered PDF page, an external Stellars swatch URL, or a
placeholder).

`CatalogSelection` is the customer's confirmed catalog pick, stored on the
order for **traceability even after the catalog is regenerated** — the header
comment is explicit that `catalogVersion` + `sourceId` + `sourcePage` always
point back to the exact PDF page the customer approved, independent of whether
that item survives a later catalog run. Fields:

| Field | Type | Meaning |
|---|---|---|
| `catalogVersion` | `string` | SHA-256 of source PDFs (per AGENTS.md) |
| `tier` | `Tier` | Pricing tier the pick belongs to |
| `groupId`, `groupLabel` | `string` | Catalog group |
| `itemId`, `itemLabel` | `string` | Catalog item |
| `productId` | `ProductId` | **Drives the existing pricing engine** — pricing itself is unaffected by which brand/style was picked (comment cites tech.md's pricing invariant) |
| `garmentType` | `Silhouette` | `round_neck` or `polo` — describes the garment in the mockup prompt and picks the legacy template only when no catalog reference exists |
| `sourceId` | `string` | Source identifier |
| `sourcePage` | `number` | PDF page the customer approved |
| `styleCode?`, `variantId?`, `colorName?`, `colorCode?` | optional strings | Variant detail |
| `referenceImagePath?` | string | Repo-relative path (under `assets/catalog/`) of the **exact image the customer confirmed** — the primary mockup garment reference. Present for locally available images; absent for placeholder/missing |
| `referenceImageUrl?` | string | Original external URL (Stellars swatch hyperlink), kept for traceability after local mirroring |
| `referenceImageKind` | `ReferenceImageKind` | Where the reference lives (above) |
| `mockupEligible` | `boolean` | **True only when a usable exact-garment reference exists.** When false, an exact preview cannot be produced; customer/admin are notified instead of falling back to a generic template — a generic template is reserved *strictly* for legacy orders with **no catalog selection at all** |

### `OrderStatus`

```ts
type OrderStatus =
  | "Pending Payment"
  | "Confirmed"
  | "Payment Issue"
  | "Lead — High-Value Callback"
  | "Lead — No Payment"
  | "Lead — Abandoned";
```

Six-value string union (note the em-dash in the lead statuses). Consumed by
`src/session/statusMachine.ts` (doc 04) and the sheets status column.

### `MockupView`, `MockupGenerationStatus`, `MockupOutputImage`, `MockupGeneration`

- `type MockupView = "front" | "back"` — which template view an image
  represents.
- `type MockupGenerationStatus = "reserved" | "awaiting_payment" |
  "awaiting_approval" | "approved" | "rejected" | "generating" | "completed" |
  "failed"` — lifecycle of a single mockup-generation **REQUEST** (a
  front+back request is **one** `MockupGeneration` yielding two images). The
  type's doc comment spells out the forward-only machines:
  - free path: `reserved → generating → completed | failed`
  - paid path: `reserved → awaiting_payment → awaiting_approval → approved →
    generating → completed | failed` (or `→ rejected` from
    `awaiting_approval`)
  - free generations skip the payment/approval states entirely; paid
    generations (#4+ in a Kolkata month) must pass payment proof + explicit
    admin approval first.
- `interface MockupOutputImage` — one durably stored generated image:
  `view: MockupView`; `url?: string` (durable Vercel Blob URL, absent if
  storage was unavailable); `pathname?: string` (Blob object pathname, stable
  id); `whatsappMessageId?: string` (delivery message id); `costUsd?: number`
  (provider cost when reported).
- `interface MockupGeneration` — the durable record the whole paid-generation
  workflow (quota, payment, admin approval, generation, storage) mutates:

  | Field | Type | Notes |
  |---|---|---|
  | `generationId` | `string` | **Idempotency key for the whole request** (stable across retries) |
  | `orderId` | `string` | Links to the order |
  | `customerChatId` | `string` | Channel-prefixed, e.g. `"tg:5512345678"` — matches `OrderData.customerChatId` |
  | `status` | `MockupGenerationStatus` | Forward-only (above) |
  | `free` | `boolean` | True once this generation consumed a free monthly slot |
  | `amountInr` | `number` | Whole rupees (0 for free generations) |
  | `monthKey` | `string` | **Asia/Kolkata** calendar-month key (`YYYY-MM`) reserved against |
  | `catalogSelection?` | `CatalogSelection` | Exact garment reference (traceability) |
  | `garmentReferenceRef?` | `string` | Repo-relative path or URL of the reference image used |
  | `requestedViews` | `MockupView[]` | e.g. `["front","back"]` |
  | `logos` | `LogoUpload[]` | What gets rendered |
  | `outputs` | `MockupOutputImage[]` | One per produced view |
  | `paymentProofMessageId?` | `string` | WhatsApp message id of the payment proof (paid only) |
  | `decidedByAdminChatId?` | `string` | Approving/rejecting admin (paid only) |
  | `createdAt`, `updatedAt` | `string` | ISO timestamps |
  | `completedAt?` | `string` | Set when status reaches `completed` |
  | `failureReason?` | `string` | Human-readable, when `status === "failed"` |

### `Timeline`, `SizeSplit`

```ts
type Timeline = "urgent" | "standard" | "flexible";
interface SizeSplit extends Record<SizeKey, number> {}
```

`SizeSplit` is a total map over the pricing book's `SizeKey` (S, M, L, XL,
XXL, 3XL) to counts — no optional keys.

### `OrderData` — field by field

The central money-bearing record; every renderer and sheet row derives from it.

| Field | Type | Notes |
|---|---|---|
| `orderId` | `string` | `CTW-YYMMDD-nn` (doc 04) |
| `status` | `OrderStatus` | Six-value union above |
| `orderType?` | `"bulk" \| "sample"` | Optional; **`"sample"` switches the entire card to sample-kit wording/100%-payment** (see renderer). Absent ⇒ bulk |
| `tier` | `Tier` | Pricing tier |
| `productId` | `ProductId` | Pricing product |
| `catalogSelection?` | `CatalogSelection` | Optional so pre-existing orders created before the feature continue to load/validate unchanged (comment) |
| `qty` | `number` | Piece count (MOQ 50 enforced upstream) |
| `sizeSplit` | `SizeSplit` | Per-size counts |
| `printMethod` | `PrintMethod` | **Declared non-optional** — but see Risks: sample orders may not set it |
| `city`, `name`, `phone` | `string` | Sanitized upstream (`sanitize.ts`) |
| `timeline` | `Timeline` | urgent/standard/flexible |
| `timelineUrgent` | `boolean` | Adds the ⚡ marker in the renderer |
| `logoReceived` | `boolean` | Legacy single-logo flag |
| `logos` | `LogoUpload[]` | Zero or more (logo, placement) pairs — customer can upload multiple logos, each at its own position |
| `garmentRate` | `number` | Per-piece garment rate |
| `garmentTotal` | `number` | `qty × garmentRate` (computed in pricing, not here) |
| `printEstLow`, `printEstHigh` | `number` | Print estimate range |
| `grandEstLow`, `grandEstHigh` | `number` | Grand estimate range |
| `advanceDue` | `number` | Amount due today |
| `customerChatId` | `string` | Channel-prefixed, e.g. `"wa:919876543210"` |
| `channel` | `"whatsapp"` | Literal union |
| `paymentScreenshotUrl?` | `string` | Payment proof |
| `catalogItemName?`, `catalogColor?` | `string` | Legacy string echoes (superseded by `catalogSelection`) |
| `createdAt?` | `string` | Optional timestamp |
| `adminNotes?` | `string` | **Optional** free-text admin annotation — the only `OrderData` field not written by the customer flow |

All monetary fields (`garmentRate`, `garmentTotal`, `printEst*`, `grandEst*`,
`advanceDue`) are **computed server-side by `src/pricing/`** and merely
*carried* by this type — invariant #5's "monetary values computed server-side
only" is satisfied because no client-supplied value ever populates them.

## 2. `render.ts` — the one shared renderer

Module header quotes PRD §7.1 verbatim: *"One shared renderer produces the
customer quote card AND the admin card — disagreement between the two is
structurally impossible."* Both functions **read only from `OrderData`**; they
take no other inputs and perform no I/O.

Imports: `LOGO_PLACEMENTS`, `TIER_LABELS` from `../pricing/priceBook.js`;
`getProduct`, `getPrintMethod` from `../pricing/index.js`.

### Private helpers

- `placementLabel(order)` — joins the human labels of every logo placement
  (`LOGO_PLACEMENTS.find(p => p.id === logo.placement)?.label ?? logo.placement`),
  or returns `"none"` when `order.logos` is empty.
- `formatRupees(n)` — `` `₹${n.toLocaleString("en-IN")}` `` (Indian digit
  grouping). **Only used inside this file** — see Risks for the divergent
  formatting in `src/admin/email.ts`.
- `sizeSplitLine(order)` —
  `S:.. M:.. L:.. XL:.. XXL:.. 3XL:..` from `order.sizeSplit`.
- `catalogSelectionLine(order)` — customer-facing: `🎽 Selected: <itemLabel> · <colorName>`;
  empty string for legacy orders with no selection (filtered out of the card).
  Comment: "Ensures the customer/admin see the EXACT garment, never just the
  generic tier product label."
- `catalogSelectionAdminLine(order)` — admin-facing full detail:
  `Catalog: <itemLabel> · Colour: <colorName> (<colorCode>) · Page <sourcePage> · Ref: <referenceImagePath ?? referenceImageUrl ?? "n/a">`.
- `timelineLabel(order)` — `Urgent (≤7d)` / `Standard (8–15d)` /
  `Flexible (15+d)`, with ` ⚡` appended when `order.timelineUrgent` is true.

### `renderQuoteCard(order): string` — customer quote card (S10)

- Looks up `product = getProduct(order.productId)` and
  `printMethod = order.printMethod ? getPrintMethod(order.printMethod) : undefined`
  — **note the guard**: a missing/undefined `printMethod` yields `undefined`,
  not a throw (contrast with `orderToRow` in the sheets module, Risks below).
- `productLabel = product.label[order.tier]`, `tierLabel = TIER_LABELS[order.tier]`,
  `isSample = order.orderType === "sample"`.
- Builds a `lines` array then `.filter(l => l !== "")` — empty optional lines
  (e.g. no catalog selection, no print line for samples) simply vanish.
- Output shape (joined with `\n`, `*...*` = WhatsApp bold, `　` = full-width
  space, `_..._` = italic):

  ```
  🧾 *Your Estimate* · #<orderId>
  <bulk>:  <tierLabel> · <productLabel> · <qty> pcs
  <sample>: 🧪 Trial Sample Kit (3 pcs: 1 Value + 1 Recommended + 1 Premium)
  [🎽 Selected: <item> · <colour>]        ← only when catalogSelection exists
  ─────────────────────
  <bulk>:  👕 T-Shirt: <qty> × ₹<garmentRate> = *₹<garmentTotal>*
  <sample>: 👕 T-Shirts (3 pcs Sample Kit · Plain): *₹<garmentTotal>*
  [🖼 Printing (<label>): <qty> × ₹<low>–<high> = *₹<printEstLow> – ₹<printEstHigh>*]
           ← omitted for samples and when no print method
  [　　⚠️ _estimate — finalized after you approve the artwork_]  ← omitted for samples
  ─────────────────────
  <bulk>:  *Est. Total: ₹<grandEstLow> – ₹<grandEstHigh> (+GST)*
  <sample>: *Total: ₹<garmentTotal> (All-Inclusive)*
  💳 *Pay today (T-Shirt advance ≈ 50%): ₹<advanceDue>*      ← bulk
  💳 *Pay today (100% full payment): ₹<advanceDue>*          ← sample
  <remaining-balance disclaimer — bulk / sample dispatch line — sample>
  ```

  The bulk disclaimer reads: "Remaining T-Shirt balance + printing + GST
  invoiced after artwork approval — before production begins. *No hidden
  charges.*" The sample line reads: "Sample kit will be dispatched to your
  delivery address once payment is verified."

### `renderAdminCard(order): string` — admin card (S11, screenshot receipt; PRD §8.3)

Same data, admin-verbosity view. Output shape:

```
🛒 *NEW ORDER — PENDING PAYMENT VERIFICATION*
──────────────────
`<orderId>` · <bulk: tierLabel · productLabel · qty pcs | sample: 🧪 Trial Sample Kit (3 pcs: 1 Value + 1 Recommended + 1 Premium · Plain)>
[Catalog: <itemLabel> · Colour: <name> (<code>) · Page <n> · Ref: <path|url|n/a>]
Sizes: S:.. M:.. L:.. XL:.. XXL:.. 3XL:..
<bulk: Print: <label|Plain> · Placement: <placements> · Timeline: <tl> · City: <city>
 sample: Timeline: <tl> · City: <city>>
<bulk: T-Shirt ₹<garmentTotal> · Est. print ₹<low>–<high> · Advance due (≈50%) *₹<advanceDue>*
 sample: T-Shirt ₹<garmentTotal> · Total (100%) *₹<advanceDue>*>
Customer: <name> · <phone> · <customerChatId> · Logos: <n received ✔ | not provided>
──────────────────
```

Note the admin card's print line also guards: `order.printMethod ?
getPrintMethod(order.printMethod).label : "Plain"`.

**Production caller status:** as of this writing, `renderAdminCard` has **no
production caller** — only tests exercise it. Actual admin alerting flows
through `src/admin/notify.ts`, which calls `sendAdminOrderAlertEmail` /
the email portal rather than sending this Markdown card to admin chats. The
function remains the PRD §8.3 rendering of record (and the doc-vs-code drift
is called out in Risks).

### `renderConfirmationDm(orderId): string` — customer confirmation DM (PRD Appendix A)

Fires **only** on an authorized admin ✅. Takes just the id (not the whole
order):

```
🎉 *Order <orderId> confirmed!* Production planning begins. Our team will reach out shortly with your artwork proof & next steps.
```

### How invariant #2 is upheld (and where it could break)

Both cards call the **same** `getProduct` / `getPrintMethod` / `TIER_LABELS`
/ `formatRupees` primitives on the **same** `OrderData` — so rate, total and
advance figures cannot diverge *between these two functions*. The invariant's
real exposure is **third renderers elsewhere**: `src/admin/email.ts`
re-formats rupees itself (Risk 2), and the sheets row writer re-derives its
own columns. The invariant is safe *inside* `src/shared/render.ts`; it is only
partially enforced repo-wide.

## 3. `sanitize.ts` — formula-injection defense & validators

Header: *"tech.md security requirement: strip leading = + - @ and control
characters from every sheet-bound string; cap name 60 / city 40 / phone 15."*

### Constants

```ts
const LEADING_FORMULA_CHARS = /^[=+\-@]+/;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;   // eslint-disable-next-line no-control-regex
```

- `LEADING_FORMULA_CHARS` — a **character-class-plus** anchored at the start:
  one or more of `=`, `+`, `-`, `@`. This is the CSV/Sheets formula-injection
  payload set: a cell beginning with any of these can be interpreted by Google
  Sheets (and Excel/CSV consumers) as a formula — the classic
  `=IMPORTXML(...)`/`=HYPERLINK(...)`/DDE exfiltration vector. Note `+` and
  `-` also catch phone-number-ish strings that Sheets could coerce.
- `CONTROL_CHARS` — the full C0 range plus DEL. Stripped **globally**
  (`/g`), not just at the edges, so embedded newlines/tabs/control bytes
  cannot smuggle extra rows or break the single-line row model.

### `sanitizeForSheet(input: string, maxLen: number): string`

The core function, in order:

1. `input.replace(CONTROL_CHARS, "")` — remove every control character
   everywhere;
2. `.replace(LEADING_FORMULA_CHARS, "")` — remove leading formula triggers
   (once, from the front — interior `=`/`-` are left intact, which is fine for
   non-formula cells);
3. `.trim()` — trim surrounding whitespace;
4. `.slice(0, maxLen)` — hard length cap.

Returns a plain string; never throws. It is **lossy by design** — a customer
named "=John" becomes "John"; a city of "@home" becomes "home".

### Per-field wrappers

| Function | Cap | Rationale |
|---|---|---|
| `sanitizeName(input)` | 60 | `sanitizeForSheet(input, 60)` |
| `sanitizeCity(input)` | 40 | `sanitizeForSheet(input, 40)` |
| `sanitizePhoneDigitsForSheet(input)` | 15 | `sanitizeForSheet(input, 15)` |

### `normalizeIndianPhone(input): string | null`

Validation + normalization of an Indian mobile number:

1. strip separators `[\s\-()]`;
2. remove an optional leading `+91`/`91` (`/^\+?91/`) **and** an optional
   leading `0` (`/^0/`);
3. strip any remaining non-digits (`/\D/g`);
4. require exactly **10 digits**;
5. require the first digit to be in **`6-9`** (`/^[6-9]/`);
6. return the bare 10-digit number, or `null` if any check fails.

(The two-step prefix handling means `+91 98765-43210`, `09876543210`,
`919876543210` and `9876543210` all normalize identically; a number like
`+92...` — after the `91` strip fails — will fail the 10-digit/6-9 checks as
intended.)

### `isValidQty(input: string): number | null`

1. `/^\d+$/` on the trimmed input (digits only, no sign/decimal/space inside);
2. `Number(...)`, require `Number.isInteger` and `1 <= n <= 100_000`;
3. return the number, else `null`.

### How invariant #5 is upheld here

`sanitizeForSheet` is the designated function AGENTS.md invariant #5 names:
it "strips spreadsheet formula injection from all user text". It is applied at
the **sheet boundaries** — the sheets writers (`src/sheets/*.ts`) run user
text through the per-field sanitizers before append. It is *not* a
conversation-time input filter: the draft stores raw-ish text; sanitization is
the last mile before the CRM. Validators (`normalizeIndianPhone`,
`isValidQty`) run earlier, at input time, to reject bad input outright.

## Data contracts / execution flow (end to end)

1. Customer supplies qty → `isValidQty` gates it (MOQ 50 enforced further up
   the flow).
2. Customer supplies phone → `normalizeIndianPhone` normalizes/validates.
3. `OrderDraft` accumulates fields; `orderFlow.ts` assembles an `OrderData`
   (pricing computed by `src/pricing/`, then attached).
4. `orderFlow.ts` S10 calls **`renderQuoteCard(order)`** to send the customer
   the estimate, then the payment screen; on payment-screenshot receipt,
   `notifyAdmins` (via `src/admin/notify.ts`) stores the snapshot and alerts
   admins (email portal — not `renderAdminCard`, see Risk 3).
5. Sheets writers append the order row, running `sanitizeName` /
   `sanitizeCity` / `sanitizePhoneDigitsForSheet` (and the generic
   `sanitizeForSheet`) on every user-text column.
6. Admin ✅ → `renderConfirmationDm(orderId)` DMs the customer.

## Error handling

- `render.ts` **throws** on unknown `productId` / `printMethod` — it calls
  `getProduct(order.productId)` and (conditionally) `getPrintMethod(...)`
  unguarded for the product, and the print method only through the
  `order.printMethod ?` guard. An invalid `productId` therefore throws out of
  the renderer; the guard does not protect the product lookup.
- `sanitize.ts` is total — every function returns a string (or `null` for the
  two validators) and cannot throw on any input, including empty strings
  (`""` stays `""`).
- `types.ts` has no runtime behaviour and cannot error.

## Risks & observations

1. **`OrderData.printMethod` is declared non-optional, but sample orders may
   not populate it.** The flow builds `printMethod: draft.printMethod!` (a
   non-null assertion) in `orderFlow.ts`; `renderQuoteCard` happens to guard
   (`order.printMethod ? getPrintMethod(...) : undefined`) and skips the
   printing line for samples. But `orderToRow` in `src/sheets/client.ts` does
   **not** guard — `getPrintMethod(undefined)` throws
   `Unknown print method: undefined` (empirically verified). A sample order
   that reaches the sheet writer without a `printMethod` will therefore throw
   in the sheets path while the customer card renders fine. Either set
   `printMethod` for samples or guard `orderToRow`.
2. **Divergent rupee formatting outside the shared renderer.**
   `src/admin/email.ts` formats money itself via its own
   `toLocaleString("en-IN")` rather than `render.ts`'s private `formatRupees`
   — verified. Today both use `"en-IN"`, so output matches; but they are two
   copies of the formatting rule. Invariant #2 ("they can never disagree")
   holds *within* `render.ts`; the email formatter is a second implementation
   that could drift.
3. **`renderAdminCard` appears to be dead in production.** Only tests call it;
   real admin alerting goes through `src/admin/notify.ts` →
   `sendAdminOrderAlertEmail` / the email portal. The PRD §8.3 admin card is
   thus not what admins actually receive. Either wire it back in or document
   the email portal as the intended replacement — currently the code and the
   PRD/AGENTS.md description disagree.
4. **Sanitization is applied only at some sheet boundaries.** `sanitize.ts`'s
   guards protect the Sheets CRM, but any *new* code path that writes user
   text to a sheet, a shell command, or an HTML email must remember to call
   the sanitizer — there is no central choke point enforcing it. The email
   portal path in particular should be checked for unescaped user text
   (HTML-injection, distinct from the formula-injection vector this module
   addresses).
5. **`renderQuoteCard`'s product lookup is unguarded** (only the print method
   is). An unknown `productId` throws `getProduct`'s error out of the
   renderer; acceptable today because `productId` is pricing-book-controlled,
   but it means the "optional printMethod" guard is asymmetric.
6. **`sanitizeForSheet` strips only *leading* formula chars.** A value like
   `foo=IMPORTXML(...)` keeps its interior `=`, which is harmless in a plain
   cell but would matter if any downstream consumer re-evaluates cells. Also,
   `slice(0, maxLen)` runs *after* stripping, so a long safe string is cut,
   not padded — trimming is lossy but deterministic.
7. **`OrderStatus` em-dashes.** The lead statuses use `—` (U+2014), not a
   hyphen. Any string comparison, sheet lookup, or transition table must use
   the exact same character; a hyphenated `"Lead - Abandoned"` will not match
   `statusMachine`'s table (`?? false`) and would be treated as an unknown
   status.
8. **`adminNotes?` is the only admin-authored free-text field on `OrderData`.**
   It is not produced by the customer flow and its sanitization before any
   sheet write should be confirmed wherever it is persisted.

## Related tests

- `tests/render.test.ts` — asserts both cards render from the same
  `OrderData` (invariant #2's executable check).
- `tests/sanitize.test.ts` — formula-prefix stripping, control-character
  removal, per-field caps, phone normalization, qty validation.
- `tests/statusMachine.test.ts` — the `OrderStatus` transition matrix that
  consumes the six-value union from `types.ts`.
