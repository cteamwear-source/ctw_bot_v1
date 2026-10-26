# Module Audit 11 — Google Sheets (`src/sheets/`)

> Knowledge-transfer review. Read `AGENTS.md` first for repo invariants; this document
> goes deeper on the Sheets CRM layer only. All facts below are taken directly from the
> source files listed under "Files covered".

## Purpose

The Sheets module is the bot's **CRM of record**. Every conversation outcome (real
order or lead) is appended as one row in a Google Spreadsheet, and admin decisions
(Confirm / Payment Issue) mutate the `Status` column of the existing row. Two
additional audit tabs — `CatalogSelections` and `MockupGenerations` — were added later
as *separate tabs* deliberately, so the original `Orders` header/behaviour is never
disturbed (external tooling reading `Orders` keeps working unchanged; per the header
comment in `catalogSchema.ts`).

The module implements the repo invariant **"Money events never fail silently"**
(AGENTS.md invariant #3): the Orders writer retries 3×, then escalates the *complete
order as plain text* to every admin chat and re-throws so the customer gets a generic
apology instead of a false success message (PRD §8.4 / AC9, quoted in
`safeAppend.ts`).

## Files covered

All seven expected files exist:

| File | Role |
|---|---|
| `src/sheets/client.ts` | Orders-tab writer: auth, row mapping, retries, status update |
| `src/sheets/schema.ts` | `Orders` tab header (32 columns) + `OrdersRow` type |
| `src/sheets/safeAppend.ts` | Orders outage fallback: escalate-to-admin + re-throw |
| `src/sheets/catalogSchema.ts` | `CatalogSelections` tab header (15 columns) |
| `src/sheets/catalogSelections.ts` | `CatalogSelections` writer (escalate-and-swallow) |
| `src/sheets/mockupSchema.ts` | `MockupGenerations` tab header (19 columns) |
| `src/sheets/mockupGenerations.ts` | `MockupGenerations` upsert writer + injectable row-store seam |

## Client auth & connection handling

Each of the three writer modules (`client.ts`, `catalogSelections.ts`,
`mockupGenerations.ts`) contains **its own duplicated** connection helper (the code is
copy-pasted, not shared):

1. `getEnv()` supplies `GOOGLE_SERVICE_ACCOUNT_JSON` (a JSON string) which is
   `JSON.parse`d into `{ client_email, private_key }`, and `SHEET_ID`.
2. A `JWT` from `google-auth-library` is created with scope
   `https://www.googleapis.com/auth/spreadsheets`.
3. `new GoogleSpreadsheet(SHEET_ID, auth)` + `await doc.loadInfo()`.
4. Tab lookup by title (`doc.sheetsByTitle["Orders" | "CatalogSelections" |
   "MockupGenerations"]`). **If the tab does not exist it is auto-created** via
   `addSheet({ title, headerValues: [...HEADER] })`. If it exists, `loadHeaderRow()`
   is attempted; on failure the header row is (re-)written with `setHeaderRow`.
5. The worksheet is cached in a module-level `let cachedSheet` — per warm serverless
   invocation the auth/`loadInfo()` round-trip happens once. Three warm modules means
   three JWT/doc instances against the same spreadsheet (accepted cost).

There is no explicit token refresh handling; the JWT client manages its own token
lifecycle. There is no connection pooling or batching beyond the worksheet cache.

## Tab 1: "Orders" — column schema

`ORDERS_HEADER` (`schema.ts`) — one row per interaction outcome; **orders AND leads
share this schema**:

| # | Column | Value written by `orderToRow()` |
|---|---|---|
| 1 | `Timestamp` | `new Date().toISOString()` at write time |
| 2 | `Order ID` | `order.orderId` (e.g. `CTW-261012-01`) |
| 3 | `Status` | `order.status` (`OrderStatus` union) |
| 4 | `Tier` | `TIER_LABELS[order.tier]` (priceBook label) |
| 5 | `Product` | `getProduct(order.productId).label[order.tier]` |
| 6 | `Qty` | `order.qty` |
| 7–12 | `S`, `M`, `L`, `XL`, `XXL`, `3XL` | `order.sizeSplit.S … ["3XL"]` |
| 13 | `Print Method` | `getPrintMethod(order.printMethod).label` |
| 14 | `Logo Placement` | comma-joined human labels of each logo placement (`LOGO_PLACEMENTS` lookup; falls back to raw placement id); `""` when no logos |
| 15 | `City` | `order.city` |
| 16 | `Name` | `order.name` |
| 17 | `Phone` | `order.phone` |
| 18 | `Timeline` | `order.timeline` (`urgent`/`standard`/`flexible`) |
| 19 | `Timeline Urgent Y/N` | `"Y"` / `"N"` |
| 20 | `Logo Received Y/N` | `"Y"` / `"N"` |
| 21 | `Logo File ID` | comma-joined WhatsApp media ids (`order.logos[].fileId`) |
| 22 | `Garment Rate/pc` | `order.garmentRate` (server-computed, priceBook) |
| 23 | `Garment Total` | `order.garmentTotal` |
| 24 | `Est Print Low` | `order.printEstLow` |
| 25 | `Est Print High` | `order.printEstHigh` |
| 26 | `Est Grand Low` | `order.grandEstLow` |
| 27 | `Est Grand High` | `order.grandEstHigh` |
| 28 | `Advance Due` | `order.advanceDue` |
| 29 | `Customer Chat ID` | `order.customerChatId` (`wa:<id>` prefixed) |
| 30 | `Channel` | `order.channel` — always `"whatsapp"` |
| 31 | `Admin Notes` | `order.adminNotes ?? ""` |
| 32 | `Last Updated` | `new Date().toISOString()` at write time |

Notes:

- All monetary columns come from `OrderData`, which is built exclusively by the
  server-side pricing engine (`src/pricing/`) — the sheet never computes money
  (invariant #1/#5).
- The payment screenshot URL is **not** a column here — it lives on the Redis order
  snapshot (`order.paymentScreenshotUrl`, set in `notifyAdmins`) and in the
  `MockupGenerations`/admin email surfaces.
- `OrdersRow` is `Record<(typeof ORDERS_HEADER)[number], string | number>`.

### Orders writes

- `appendOrderRow(order)` — maps via `orderToRow()` and `sheet.addRow(...)` wrapped in
  `withRetries` (3 attempts). **Throws** the last error after exhausting retries.
- `updateOrderRowStatus(orderId, status, adminNotes?)` — `withRetries(3)`, loads *all*
  rows (`sheet.getRows()`), finds the row where `"Order ID" === orderId`, sets
  `Status` + `Last Updated` (+ `Admin Notes` when provided), `row.save()`. Throws
  `Order ${orderId} not found in sheet` if no row matches.

### Retry helper

`withRetries(fn, retries = 3)` is duplicated verbatim in `client.ts`,
`catalogSelections.ts` and `mockupGenerations.ts`: linear backoff
`300 * attempt` ms between attempts (300 ms, 600 ms), rethrows the last error. It
retries **any** error indiscriminately (no distinction between 429/quota and
permanent errors, no jitter).

## safeAppend mechanics (Orders)

`safeAppendOrderRow(order)` (`safeAppend.ts`):

1. Calls `appendOrderRow` (which already retried 3×).
2. On failure: serializes the full row as `Key: Value` newline text via
   `orderToRow(order)`, then calls
   `notifyAdminsText("🚨 SHEET WRITE FAILED for <orderId> — full order below (please log manually):\n\n<rowText>")`,
   which fans the text out to **every** chat in `ADMIN_CHAT_IDS` (see doc 12).
3. Re-throws as `SheetWriteFailedError` (carries the `order` and `cause` as
   properties) so the caller knows the money event was not persisted to CRM.

Caller behaviour (`orderFlow.ts::completeOrder`, step 2/3/4):

1. Redis order snapshot saved first (`saveOrderSnapshot`, best-effort).
2. `safeAppendOrderRow` — on `SheetWriteFailedError` the flow sets
   `sheetWriteFailed = true` but **continues** to `notifyAdmins(...)` (email/OTP path
   still runs — the admin can still verify payment even without the sheet row).
3. Finally the customer gets the apology copy: *"Sorry, we hit a small hiccup
   recording your order in our database — our team has been notified and will verify
   your payment shortly…"* (hard-coded in `orderFlow.ts`, not in `copy.ts`).

### Formula-injection defense

`src/shared/sanitize.ts::sanitizeForSheet(input, maxLen)` strips:

- all control chars `[\x00-\x1F\x7F]`,
- leading formula-trigger characters `/^[=+\-@]+/`,
- then trims and caps length.

Wrappers: `sanitizeName` (60), `sanitizeCity` (40), `sanitizePhoneDigitsForSheet` (15).
However — important nuance — **the Sheets writers do not sanitize at write time**.
Sanitization happens at *input capture*: `orderFlow.ts` applies `sanitizeCity` (S5)
and `sanitizeName` (S6) as the customer types, and the phone is normalized to bare
10-digit form by `normalizeIndianPhone` (rejects anything that isn't a valid Indian
mobile). The remaining Orders columns are either enums/ids (tier, status, timeline),
server-computed numbers, or ids — so the invariant "strip formula injection from all
user text" is upheld by input-time sanitization rather than by the writer. If a new
free-text column is ever added to `Orders`, it must be sanitized at capture or in
`orderToRow`.

## Tab 2: "CatalogSelections" — column schema

`CATALOG_SELECTIONS_HEADER` (`catalogSchema.ts`), one row per order that went through
the PDF-driven catalog flow, linked to Orders by `Order ID`:

| # | Column | Value written by `catalogSelectionToRow(orderId, selection)` |
|---|---|---|
| 1 | `Timestamp` | `new Date().toISOString()` |
| 2 | `Order ID` | passed-in `orderId` |
| 3 | `Catalog Version` | `selection.catalogVersion` (SHA-256 of source PDFs) |
| 4 | `Tier` | `TIER_LABELS[selection.tier]` |
| 5 | `Group` | `selection.groupLabel` |
| 6 | `Item` | `selection.itemLabel` |
| 7 | `Style Code` | `selection.styleCode ?? ""` |
| 8 | `Source PDF` | `selection.sourceId` |
| 9 | `Source Page` | `selection.sourcePage` |
| 10 | `Variant ID` | `selection.variantId ?? ""` |
| 11 | `Colour` | `selection.colorName ?? ""` |
| 12 | `Colour Code` | `selection.colorCode ?? ""` |
| 13 | `Reference Image` | `referenceImagePath ?? referenceImageUrl ?? ""` |
| 14 | `Reference Image Kind` | `selection.referenceImageKind` (`rendered-page` \| `external-link` \| `placeholder`) |
| 15 | `Mockup Eligible` | `"Y"` / `"N"` |

`appendCatalogSelectionRow(orderId, selection)`:

- Wraps `addRow` in `withRetries(3)`.
- **Never throws.** On final failure it escalates the full row as
  `⚠️ CatalogSelections write failed for <orderId> — full row below (please log manually):\n\n…`
  via `notifyAdminsText(...).catch(() => {})`, logs `console.error`, and swallows the
  error. Rationale (file header): this is supplementary trace data and must never
  block the customer's order/payment flow; the "escalate rather than vanish" rule is
  kept for consistency with Orders.

⚠️ **Finding:** as of this audit, `appendCatalogSelectionRow` has **no production call
site** — only the pure mapper `catalogSelectionToRow` is imported (by
`tests/catalogSelectionPersistence.test.ts`). The tab writer is fully implemented but
apparently not yet wired into the order-completion path.

## Tab 3: "MockupGenerations" — column schema

`MOCKUP_GENERATIONS_HEADER` (`mockupSchema.ts`), one row per mockup-generation
request, **updated in place** by Generation ID (durable audit trail that outlives the
Redis TTL):

| # | Column | Value written by `generationToRow(record)` |
|---|---|---|
| 1 | `Generation ID` | `record.generationId` (upsert key) |
| 2 | `Order ID` | `record.orderId` |
| 3 | `Chat ID` | `record.customerChatId` |
| 4 | `Status` | `record.status` (forward-only lifecycle, see doc on mockup module) |
| 5 | `Free/Paid` | `"Free"` / `"Paid"` from `record.free` |
| 6 | `Amount INR` | `record.amountInr` (0 for free, ₹20 default for paid) |
| 7 | `Month Key` | `record.monthKey` (Asia/Kolkata `YYYY-MM`) |
| 8 | `Catalog Item` | `record.catalogSelection?.itemLabel ?? ""` |
| 9 | `Colour` | `record.catalogSelection?.colorName ?? ""` |
| 10 | `Style Code` | `record.catalogSelection?.styleCode ?? ""` |
| 11 | `Reference Image` | `record.garmentReferenceRef ?? ""` |
| 12 | `Requested Views` | `record.requestedViews.join(", ")` (e.g. `front, back`) |
| 13 | `Output URLs` | comma-joined non-empty `record.outputs[].url` |
| 14 | `Payment Proof File ID` | `record.paymentProofMessageId ?? ""` |
| 15 | `Admin Decision By` | `record.decidedByAdminChatId ?? ""` |
| 16 | `Failure Reason` | `record.failureReason ?? ""` |
| 17 | `Created At` | `record.createdAt` (ISO) |
| 18 | `Updated At` | `record.updatedAt` (ISO) |
| 19 | `Completed At` | `record.completedAt ?? ""` |

### Injectable row-store seam

The upsert is written against a minimal interface so tests never touch Google Sheets:

```ts
export interface MockupSheetStore {
  find(generationId: string): Promise<MockupGenerationsRow | undefined>;
  create(row: MockupGenerationsRow): Promise<void>;
  update(generationId: string, row: MockupGenerationsRow): Promise<void>;
}
```

- Production implementation `googleSheetStore` uses the real worksheet:
  `find` = scan `getRows()` for `"Generation ID"`; `update` = `set()` every key +
  `save()`, **falling back to `addRow` if the row vanished** (so an update can
  self-heal into a create).
- Test seam: `__setMockupSheetStoreForTests(fake | undefined)` swaps the module-level
  `store` (undefined restores the real one). `tests/support/fakeSheetStore.ts`
  implements the fake (per AGENTS.md).

`upsertMockupGenerationRow(record)`:

- `withRetries(3)` around `find → update | create` — idempotent per Generation ID, so
  duplicate webhook callbacks/retries never create duplicate rows.
- **Never throws**: on failure it escalates the full row as
  `⚠️ MockupGenerations write failed for <genId> (order <orderId>) — full row below (log manually):…`
  (`notifyAdminsText(...).catch(() => {})`), logs, swallows. File header is explicit:
  *"the durable state of record is Redis + Blob; this sheet is the human-readable
  audit copy and must not block the flow."*
- Call sites: `src/mockup/generationStore.ts` mirrors every authoritative Redis save
  (`save()`) and initial creation (`createGenerationIfAbsent`) to the sheet with an
  extra defensive `.catch(() => {})`.

## Data contracts

- **Input contract:** `OrderData` (`src/shared/types.ts`) — all 32 Orders columns are
  derived from it; `CatalogSelection` feeds CatalogSelections; `MockupGeneration`
  feeds MockupGenerations. The sheets modules never mutate these objects.
- **Row contract:** `OrdersRow` / `CatalogSelectionsRow` / `MockupGenerationsRow` are
  `Record<HeaderLiteral, string | number>`; writers cast to
  `Record<string, string | number>` for `google-spreadsheet`'s `addRow`.
- **Escalation contract:** failure text is always a full `Key: Value\n…` dump of the
  would-be row, prefixed 🚨 (Orders) or ⚠️ (audit tabs), sent through
  `notifyAdminsText(text: string)` fan-out to `ADMIN_CHAT_IDS`.

## Execution flow

**New order/lead (from `orderFlow.ts::completeOrder`):**

```
customer sends payment screenshot
 → COPY.screenshotAck to customer
 → nextOrderId() if missing (oid:<YYMMDD> counter, doc 10/session)
 → assembleOrderData()  (pricing engine only — server-side money)
 → saveOrderSnapshot(order)          [Redis order:<orderId>, 14d, best-effort]
 → safeAppendOrderRow(order)         [Orders: retry 3× → escalate → throw]
 → notifyAdmins(order, screenshotId) [email + OTP; runs even if sheet failed]
 → on sheet failure: apology message to customer
 → clearDraft(chatId)
```

**Admin decision (from `admin/actions.ts` or `/api/admin-approve`):**

```
executeOrderConfirm / executeOrderIssue
 → Redis SETNX admin-action:<orderId> (idempotency)
 → updateOrderRowStatus(orderId, "Confirmed" | "Payment Issue")
     [getRows() scan → find by Order ID → set Status/Last Updated/Admin Notes → save]
 → sheet error here is only console.error'd (.catch in actions.ts) — the admin
   decision is NOT rolled back if the status update fails
```

**Mockup generation lifecycle:** every `generationStore.save()` (status transition)
mirrors to `upsertMockupGenerationRow` — create on first `reserved`, in-place update
on each subsequent transition (`awaiting_payment → awaiting_approval → approved →
generating → completed | failed`).

## Error handling

| Failure | Behaviour |
|---|---|
| Orders `addRow` transient error | retried up to 3× (300/600 ms backoff) |
| Orders `addRow` permanent failure | full order escalated to all admin chats (🚨), `SheetWriteFailedError` thrown → customer gets generic apology; admin email/OTP path still runs |
| Orders status-update row not found | throws `Order <id> not found in sheet`; caller in `actions.ts`/`admin-approve.ts` catches and only logs — decision still acked |
| CatalogSelections write failure | retried 3×, then escalated (⚠️) + logged + **swallowed** |
| MockupGenerations write failure | retried 3×, then escalated (⚠️) + logged + **swallowed** (Redis remains authoritative) |
| `notifyAdminsText` itself failing | per-admin `sendMessage` failures are caught inside notify.ts; the escalation call never throws |
| Missing tab | auto-created with canonical header |
| Existing tab with empty header | header row re-written via `setHeaderRow` |

## Security

- Service-account credentials arrive as one env var (`GOOGLE_SERVICE_ACCOUNT_JSON`),
  validated once at cold start by `getEnv()`; never logged.
- Formula-injection defense (`sanitizeForSheet`) is enforced at input time
  (name/city capture; phone normalized to digits) — see nuance in the dedicated
  section above.
- Monetary columns are copied from server-computed `OrderData`; nothing in this module
  accepts client-supplied amounts.
- Escalation text (full order dump incl. customer name/phone) goes only to
  `ADMIN_CHAT_IDS` and console.

## Risks & observations

1. **Non-idempotent Orders append under retry.** `addRow` can succeed server-side and
   still throw (timeout); the retry then appends a *duplicate* row. MockupGenerations
   is protected by its upsert key; Orders has no such dedupe.
2. **O(n) status updates.** `updateOrderRowStatus` loads every row and scans by
   `"Order ID"` on each admin action; fine for early-stage volume, will slow as the
   tab grows. Same for `googleSheetStore.find/update`.
3. **Duplicated auth/retry helpers** in three modules — drift risk (e.g. one module's
   backoff changed, others not).
4. **Header drift risk.** If an existing tab's headers don't match the constants,
   `loadHeaderRow()` succeeds and `addRow` will silently drop mismatched keys — no
   validation that on-sheet headers equal the constants.
5. **`appendCatalogSelectionRow` is currently unwired** (no production caller; see
   finding above). Either dead code or a missed integration point for the catalog
   trace tab.
6. **Sheet-update failures after admin confirm are swallowed** (logged only) —
   the sheet can permanently say `Pending Payment` after a successful confirm if the
   Sheets API fails at that moment. There is no reconciliation job; admins are told
   "Order … marked as confirmed" regardless.
7. **No sanitization inside writers** — reliance on input-time sanitization (see
   Security). Any new free-text column must be handled explicitly.
8. **`withRetries` retries all errors equally** — a 400-type permanent error burns 3
   attempts (~900 ms) inside the webhook budget on every failure.
9. **Timezone note:** `Timestamp`/`Last Updated` are UTC ISO strings; the mockup
   quota month key is Asia/Kolkata — sheet readers filtering "by day" should account
   for the 5:30 h offset.
