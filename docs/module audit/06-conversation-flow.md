# 06 — Conversation Flow Module (`src/conversation/`)

> Knowledge-transfer audit based on a full read of `orderFlow.ts`, `copy.ts`, `draft.ts`,
> `uiMapper.ts`, `tests/orderFlow.test.ts`, `tests/navigation.test.ts`, plus the directly
> coupled modules (`src/bot/index.ts`, `src/session/draftStore.ts`, `src/pricing/index.ts`,
> `src/admin/notify.ts`, `src/catalog/options.ts`). Every statement below is sourced from
> the code as it exists in this repo today. Where repo reality contradicts `AGENTS.md`,
> the contradiction is called out explicitly (see “Discrepancies with AGENTS.md”).

## Purpose

This module owns the entire customer-facing order conversation on WhatsApp:

- Parses the raw WhatsApp Cloud API `message` object into a single `input` string.
- Interprets global commands (`/start`, `cancel`, `back`, `catalog…`) before any step logic.
- Derives the *current step* purely from which fields are missing on the persisted
  `OrderDraft` (`determineStep`), processes the user’s input for that step
  (`processStep`), and renders the next prompt (`promptNext`).
- Collects order data (type, garment, qty, contact, timeline, tier, catalog pick,
  branding, logos, mockup decision, payment proof), assembles an `OrderData` object,
  and hands it off to pricing, Redis snapshots, Google Sheets, and admin notification.

It is deliberately **stateless per message**: there is no session-scoped cursor or plugin
state machine — the draft document *is* the state, and the step is recomputed from it on
every inbound message. That makes resume free (any partial draft lands on its first
missing field) and makes rollback a matter of deleting fields (`rollbackStep`).

## Files covered

| File | Lines (approx.) | Role |
|---|---|---|
| `src/conversation/orderFlow.ts` | 1,118 | The whole flow: input parsing, global commands, `determineStep`, `rollbackStep`, `processStep`, `promptNext`, `assembleOrderData`, `completeOrder` |
| `src/conversation/draft.ts` | 47 | `OrderDraft` interface + unused `isDraftResumable()` helper |
| `src/conversation/copy.ts` | 164 | `COPY` — all authoritative customer/admin wording (many keys orphaned) |
| `src/conversation/uiMapper.ts` | 52 | `sendMenu()` — maps ≤3 options → buttons, 4–10 → list, >10/error → plain text |
| `tests/orderFlow.test.ts` | 392 | Behavioral spec of `handleWhatsAppMessage` end-to-end (FakeRedis + fetch stub) |
| `tests/navigation.test.ts` | 302 | Spec of `determineStep` sequencing and `rollbackStep` per step |

**Not present in this repo (despite AGENTS.md listing them):** `keyboards.ts`,
`waitHelpers.ts`, `src/conversation/steps/` (no `catalogSelection.ts`, no `sizeSplit.ts`).
The module directory contains exactly the four source files above.

## Architecture

### Dispatch chain (no grammY)

There is **no grammY / conversations plugin** wired anywhere in this module. The chain is:

```
api/webhook.ts
  └─ handleMessage(chatId, message)            src/bot/index.ts
       ├─ checkRateLimit → COPY.floodCooldown  (20 msg/min sliding window)
       ├─ acquireChatLock → COPY.busyReprompt  (in-memory Set, 90s-ish lock)
       ├─ input startsWith "admin:"     → handleAdminAction()        (admin)
       ├─ input startsWith "mockupgen:" → handleMockupGenAction()    (admin)
       ├─ admin typed command (6-digit OTP etc.) → handleAdminTextCommand()
       ├─ image while paid-mockup pending → attachPaymentProof() + COPY.mockupPaidProofAck
       └─ handleWhatsAppMessage(chatId, message)   src/conversation/orderFlow.ts
            └─ processStep() / promptNext()
       finally: releaseChatLock(); catch: captureException (Sentry)
```

Only the last branch is this module. Rate limiting, chat locking, admin routing, and
paid-mockup proof interception all happen **before** the conversation flow is entered —
the flow can therefore assume it has the chat to itself.

### Input normalization

`handleWhatsAppMessage` flattens every message shape into one string:

1. `message.text.body`
2. `message.interactive.button_reply.id` / `.title`
3. `message.interactive.list_reply.id` / `.title`
4. `message.button.payload` / `.text`
5. If `message.image` or `message.document` exists: `input` is **overwritten** with the
   media `id`, and `isMedia = true`.

If there is no input and no media → silent `return` (nothing sent to the customer).

### The derived state machine

```ts
const step = determineStep(draft);   // first missing field wins
await processStep(ctx, draft, step); // validate + write the field + saveDraft
await promptNext(chatId, draft);     // re-derive step, render its prompt
```

- `determineStep(draft)` is a pure function over draft presence — exported and unit-tested.
- `processStep` is one `switch`; each case parses `input` loosely (button payload first,
  then keyword `includes`, then bare index like `"1"`), mutates the draft, `saveDraft`,
  and calls `promptNext` for the next step. Unrecognized input → `promptNext(..., isReprompt=true)`
  which prefixes `COPY.genericReprompt` (“Sorry, I didn’t get that…”).
- `promptNext` re-derives the step (steps can advance *inside* the prompt, e.g. the
  single-quality auto-select in `catalogQuality`) and renders that step’s menu.
- Exceptions from `processStep` are caught in `handleWhatsAppMessage` and answered with
  the hardcoded string `"An error occurred. Please try again."`.

### Persistence model (`src/session/draftStore.ts`)

- Key `sess:<chatId>`, TTL 24h, value = the whole `OrderDraft` + `updatedAt`.
- **Memory-first**: every save writes a per-isolate `Map` synchronously; the Redis write
  is *fire-and-forget* unless `saveDraft(chatId, draft, /* persistToRedis */ true)` is
  called. Only two flow sites force the blocking save: the `mockupDecision` step (both
  branches) and first-time `orderId` assignment at the payment prompt.
- `loadDraft` checks the memory cache first and only hits Redis on a miss; the cache is
  invalidated whenever the Redis client instance changes (`checkRedisInstance`).
- Consequence: the “instant menu navigation” latency the code comments mention is bought
  with a window where a lost Redis write (warned, not retried) or a different serverless
  isolate can drop/miss draft progress.

### Resume / skip-if-set

Resume is implicit: `loadDraft` + `determineStep` means a half-filled draft always lands
on its first missing field, no matter when or from which isolate the message arrives.
There is **no** “Resume my quote?” UX: `COPY.resumePrompt` and `isDraftResumable()`
(draft must have `qty` and be < 24h old) are defined but never called anywhere in `src/`
or `api/`. `/start` unconditionally clears the draft and restarts at `orderType`.

## `OrderDraft` — field by field

| Field | Type | Written by step | Notes |
|---|---|---|---|
| `orderType` | `"bulk" \| "sample"` | `orderType` | Branches the whole flow |
| `garmentSilhouette` | `"round_neck" \| "collar"` | `garmentSilhouette` | Drives `productId` resolution and `catalogSelection.garmentType` |
| `tier` | `Tier` | `tier` (bulk), `sampleFabric` (`"standard"`) | Button `tier:premium` stores **`"branded"`** |
| `fabric` | `"cotton" \| "polyester"` | `sampleFabric` / `catalogFabric` | |
| `productId` | `ProductId` | `sampleFabric`, `catalogFabric` | Via `resolveProductId(silhouette, fabric)` or hardcoded sample kit ids |
| `qualityOptionId` / `qualityOptionName` | `string` | `catalogQuality` (or auto in `promptNext`) | |
| `colorName` | `string` | `catalogColor` (or auto `"Default"`) | |
| `catalogSelection` | `CatalogSelection` | `catalogColor` (or auto path) | Full object; see Data contracts |
| `catalogGroupId`, `catalogItemId` | `string` | **never** | Leftovers from an older group→item catalog flow; declared only |
| `qty` | `number` | `qty` (bulk, MOQ-gated), `sampleFabric` (`3`) | |
| `sizeSplit` | `Partial<Record<SizeKey, number>>` | auto: `resolveEvenSplit(qty)` in `qty` / `sampleFabric` | **No user-facing size-split step exists** |
| `printMethod` | `PrintMethod` | `printMethod` | `"screen_print" \| "embroidery"` |
| `city`, `name`, `phone` | `string` | `city`, `name`, `phone` | `sanitizeCity` / `sanitizeName` / `normalizeIndianPhone` |
| `timeline` | `Timeline` | `timeline` | `"urgent" \| "standard" \| "flexible"` |
| `timelineUrgent` | `boolean` | `timeline` | `true` only for urgent; `false` for standard/flexible |
| `logoReceived` | `boolean \| undefined` | `logoPlacement` (`false` on skip), `logoMore` (`true` on done) | `undefined` = logo phase still open; gates `determineStep` |
| `logos` | `LogoUpload[]` | `logoPlacement` (push `{placement, fileId:""}`), `logoUpload` (set `fileId`), `logoMore` | Undo pops/patches this array |
| `mockupDecision` | `"skip" \| "generate"` | `mockupDecision` | |
| `mockupGenerated` | `boolean` | `mockupDecision` (`true` only on **generate**) | Blocks all back navigation |
| `paymentScreenshotId` | `string` | `payment` | Completes the flow |
| `orderId` | `string` | `mockupDecision`, payment prompt, `completeOrder` | `nextOrderId()` → `CTW-YYMMDD-nn` (Redis `INCR`, `oid:<YYMMDD>`, 48h) |
| `confirmingCancel` | `boolean` | global cancel handler | Two-phase cancel |
| `choosingPlacement` | `boolean` | `logoPlacement` / `logoUpload` / `logoMore` | Drives the “add another logo” sub-loop |
| `updatedAt` | `number` | `saveDraft` (always) | Timestamp only; no expiry logic in the flow itself |

## The real step sequence

`determineStep` returns these step names in this exact order (from
`tests/navigation.test.ts` and the source):

**Bulk (`orderType = "bulk"`):**

```
orderType → garmentSilhouette → qty → city → name → phone → timeline
→ tier → catalogFabric → catalogQuality → catalogColor → printMethod
→ logoPlacement → logoUpload → logoMore (sub-loop back to logoPlacement)
→ mockupDecision (only if logoReceived===true && logos.length>0)
→ payment → completed
```

**Sample (`orderType = "sample"`):**

```
orderType → garmentSilhouette → sampleFabric → city → name → phone
→ timeline → payment → completed
```

Sample kits hard-set `qty=3`, `sizeSplit=resolveEvenSplit(3)`, `tier="standard"` and a
`productId` inside the `sampleFabric` step, then skip tier/catalog/print/logo/mockup
entirely.

> **The S00–S11 numbering in AGENTS.md does not match this code.** AGENTS.md puts
> tier/catalog first and qty second (`tier → catalog → qty → sizes → print → contact →
> timeline → logo → mockup → quote → payment`); the actual order is
> `qty → city → name → phone → timeline → tier → catalog…`, sizes are never asked, and
> quote+payment are a single step. `docs/STATE_MACHINE_AND_FLOWS.md` in turn claims
> S00–S12 (three different schemes in three documents). For clarity this document uses
> its own sequential numbers **C0–C15** below, keyed to the real `determineStep` names.

## Step-by-step walkthrough

### C0 — `orderType`

- **Prompt:** `COPY.greetingAsk` + 3 buttons: `order:bulk` “Bulk Order (50+)”,
  `order:sample` “Order Sample Kit”, `order:catalogs` `COPY.catalogsMenuTitle`.
- **Accepts:**
  - Bulk: `order:bulk`, text contains “bulk”, or `"1"` → `orderType="bulk"`.
  - Sample: `order:sample`, text contains “sample”, or `"2"` → `orderType="sample"`.
  - Catalog: `order:catalogs` / `catalog:download`, text contains catalog/catalogue/pdf/download, or `"3"`
    → sends `COPY.catalogsListMessage`, re-prompts **without** advancing and without the
    generic-reprompt preface.
  - Any other text → `findCatalogByQuery()`; a brand/keyword hit (e.g. “adidas”) sends a
    direct Google Drive link + the catalog folder URL, still without advancing.
  - Greetings `hi|hello|hey|hola` re-render the menu silently; anything else unrecognized
    gets `COPY.genericReprompt` first (note: `start`/`/start` never reach here — the
    global `/start` handler intercepts them earlier).
- **Back:** no Back button; `rollbackStep` at `orderType` returns `false`.

### C1 — `garmentSilhouette`

- **Prompt:** `COPY.garmentSilhouetteAsk` + buttons `garment:collar` (Collared Neck),
  `garment:round_neck` (Round Neck), `nav:back`.
- **Accepts:** “round…”/`"1"` → `round_neck`; “collar”/“polo”/`"2"` → `collar`; else reprompt.
- **Back:** button deletes `orderType`.

### C2a — `sampleFabric` (sample branch)

- **Prompt:** `COPY.sampleKitFabricAsk` (Dry Fit Kit ₹1,999 / Cotton Kit ₹2,499) + buttons
  `fabric:polyester`, `fabric:cotton`, `nav:back`.
- **Writes (in one shot):** `fabric`, `qty=3`, `sizeSplit=resolveEvenSplit(3)`,
  `tier="standard"`, `productId` = `cotton_polo|cotton_round_neck` or
  `dry_fit_polo|dry_fit_round_neck` depending on silhouette.
- **Back:** deletes `garmentSilhouette`.

### C2b — `qty` (bulk branch)

- **Prompt:** `COPY.qtyAsk` + `nav:back` button (single button).
- **Input:** strips all non-digits (`input.replace(/[^0-9]/g,'')`) then `Number(...)`.
  “50 pcs” → 50; “-60” → 60 (minus sign stripped); “abc” → NaN/0 → reprompt
  (`COPY.qtyInvalid` exists but is **never used** — reprompt uses `COPY.genericReprompt`).
- **MOQ gate:** `meetsMoq(n)` = `n >= MOQ (50)`. Below MOQ → `COPY.rejection` +
  `clearDraft()` + return. Terminal, no sheet row, no admin ping (matches AGENTS.md
  invariant 7 — this one is accurate).
- **On success:** `qty` + `sizeSplit = resolveEvenSplit(qty)` (auto even split;
  no bracket/upsell message — `getNextBracketRate` is exported from pricing but unused).

### C3 — `city`

- **Prompt:** `COPY.cityAsk` + `nav:back`.
- **Input:** length > 2 → `draft.city = sanitizeCity(input)`; else reprompt.
- **Back (bulk):** deletes `qty` + `sizeSplit`. **Back (sample):** deletes `fabric`,
  `qty`, `sizeSplit`, `tier`, `productId` (all the sampleFabric side effects).

### C4 — `name`

- **Prompt:** `COPY.nameAsk` + `nav:back`. Length > 2 → `sanitizeName`; else reprompt.
- **Back:** deletes `city`.

### C5 — `phone`

- **Prompt:** `COPY.phoneAsk` + `nav:back`.
- **Input:** `normalizeIndianPhone`; on failure sends `COPY.phoneInvalid` and does
  **not** re-render the prompt (the `promptNext(..., true)` call is commented out) — the
  original phone menu stays on screen and the user simply replies again.
- **Back:** deletes `name`.

### C6 — `timeline`

- **Prompt:** `COPY.timelineAsk` + 3 buttons `timeline:urgent` (Urgent 1-2 days),
  `timeline:standard` (Standard 3-4 days), `timeline:flexible` (Flexible 6-7 days).
  **No Back button** (the uiMapper footer still hints “Reply 'back' to undo…”).
- **Writes:** `timeline` + `timelineUrgent` (`true` only for urgent).
- **Back:** deletes `phone`.

### C7 — `tier` (bulk only)

- **Prompt:** `COPY.welcome` (“Pick a quality tier to see products:”) + buttons
  `tier:basic`, `tier:standard`, `tier:premium`. No Back button.
- **Mapping quirk:** `tier:premium` → `draft.tier = "branded"`; basic→`basic`,
  standard→`standard`. Numeric/keyword matching: “basic”/`"1"`, “standard”/`"2"`,
  “premium”/`"3"`.
- **Back:** deletes `timeline` + `timelineUrgent`.

### C8 — `catalogFabric`

- **Prompt:** `COPY.fabricAsk` + buttons `fabric:polyester` (Dry Fit), `fabric:cotton`
  (100% Cotton), `nav:back`.
- **Writes:** `fabric` + `productId = resolveProductId(garmentSilhouette, fabric)`.
- **Back:** deletes `tier`.

### C9 — `catalogQuality`

- **Prompt side-effect (auto-skip):** `getQualityOptions(tier, productId)`; if **≤1**
  option, the option is auto-written into `qualityOptionId/Name`, saved, and
  `promptNext` recurses — the customer never sees this screen. Otherwise a menu of
  `optquality:<id>` rows (+ Back appended only if the menu has <10 rows) with
  `COPY.catalogQualityAsk`.
- **Input matching:** exact `optquality:` payload, id equality (case-insensitive), name
  equality/`includes`, or a 1-based index (“1”, “2”, …).
- **Back:** deletes `fabric` + `productId`.

### C10 — `catalogColor`

- **Prompt side-effect (auto path):** if the quality has no colors (or is missing), it
  sets `colorName = "Default"`, builds the full `catalogSelection` placeholder, saves,
  and recurses — again never shown to the customer.
- **Otherwise:** list of `color:<Color>` rows with the **hardcoded** title
  “Now choose your T-shirt colour:” (`COPY.catalogColorAsk` is unused) + Back when
  <10 rows.
- **Input:** `color:` prefix → exact (case-insensitive); else name equality/`includes`
  or 1-based index.
- **Writes:** `colorName` + `catalogSelection` (see Data contracts).
- **Back:** deletes `qualityOptionId/Name`; if the product has ≤1 quality option it also
  deletes `fabric` + `productId` (cascades past the auto-skip, covered by a dedicated
  navigation test).

### C11 — `printMethod`

- **Prompt:** `COPY.brandingTypeAsk` + buttons `branding:print` (Print Screen/DTF),
  `branding:embroidery`, `nav:back`.
- **Input:** “print”/“screen”/“dtf”/`"1"` → `screen_print`; “embroidery”/`"2"` →
  `embroidery`.
- **Back:** deletes `colorName` + `catalogSelection`; and — because rolling back past
  color may bypass the color step — conditionally also `qualityOptionId/Name`
  (when the selected quality has no colors) and `fabric`/`productId` (when ≤1 quality
  options).

### C12 — logo sub-loop (`logoPlacement` → `logoUpload` → `logoMore`)

Entered only when `logoReceived === undefined` (bulk only).

- **`logoPlacement` prompt:** `COPY.placementAsk` as a **list** (7 rows → list, list
  button “View Placements”): `placement:left_chest`, `placement:center_front`,
  `placement:upper_back`, `placement:left_sleeve`, `placement:right_sleeve`,
  `logo:skip` (Skip – no artwork), `nav:back`.
  - **Skip** → `logoReceived=false`, `logos=[]`; the flow then falls straight through
    (no mockup — `determineStep` requires `logoReceived===true`) to `payment`.
  - **Placement input:** `placement:` payload or keyword inference
    (chest/left→`left_chest`, front/center/centre→`center_front`, back→`upper_back`,
    “left sleeve”→`left_sleeve`, “right sleeve”→`right_sleeve`, or index 1–5), plus alias
    normalization (`centre_front`, `chest_left`, `back_center`, `sleeve_left`).
    Pushes `{ placement, fileId: "" }` and clears `choosingPlacement`.
  - **Back:** if `choosingPlacement` is set (i.e. user chose “Add another logo”), back
    just clears the flag; otherwise deletes `printMethod`.
- **`logoUpload`:** prompted with `COPY.logoUploadPrompt` + `nav:back`.
  Only `ctx.message.image` is accepted → sets `lastLogo.fileId = <media id>` and deletes
  `choosingPlacement`. A document or text gets the copy + a hardcoded
  “_(Reply 'back' to go back, 'cancel' to restart)_” hint.
  **Back:** pops the last logo entry.
- **`logoMore`:** buttons `logo:more` (Add another logo), `logo:done` (No more,
  continue), `nav:back`; text matches “more”/“add” vs “done”/“continue”/“no”.
  - more → `choosingPlacement=true` (loop back to placement).
  - done → `logoReceived=true`.
  - **Back:** deletes `fileId` of the last logo (stays on upload re-do).

### C13 — `mockupDecision`

Reached only when `!mockupDecision && logoReceived && logos.length > 0`.

- **Prompt:** hardcoded text (not `COPY.mockupOfferAsk`) with the live free-quota count
  from `peekUsage(`wa:${chatId}`, { phone })` (fallback 3, errors swallowed) + buttons
  `mockup:generate`, `mockup:skip`, `nav:back`.
- **`mockup:generate`:**
  1. `mockupDecision="generate"`, `mockupGenerated=true`.
  2. `orderId ??= await nextOrderId()`.
  3. Sends hardcoded free-quota/“Generating your preview…” text.
  4. `assembleOrderData` → `saveOrderSnapshot` (errors swallowed).
  5. `triggerMockupDelivery(orderId)` — fire-and-forget HTTP dispatch to
     `/api/mockup-delivery` (this is the mandated seam; slow Sharp generation never runs
     in the webhook handler — enforced by `tests/mockupTiming.test.ts`); errors are
     logged, not rethrown.
  6. `saveDraft(..., persistToRedis=true)` (blocking Redis write) → `promptNext` → payment.
- **`mockup:skip`:** `mockupDecision="skip"`, `orderId ??= nextOrderId()`, snapshot,
  force-save → payment.
- **Back:** allowed only if `mockupDecision === "skip"` (clears `logoReceived`, returning
  to `logoMore`). Once generated/`mockupGenerated`, rollback is hard-blocked (global back
  handler answers with the hardcoded “Your mockup preview has already been generated! You
  cannot go back from this step…” message).

### C14 — `payment` (quote + QR + screenshot, one step)

There is **no separate quote step and no separate screenshot step** — the payment prompt
does all three jobs:

1. **Price assembly (server-side only):** `tier ??= "standard"`, `productId ??=
   dry_fit_polo|dry_fit_round_neck` by silhouette, `qty ??= (sample ? 3 : 50)`;
   `computeGarmentTotal`/`computeSampleKitTotal` → `computePrintEstimate` (0 for sample)
   → `computeGrandEstimate` → `computeAdvanceDue`.
2. `orderId ??= nextOrderId()` + force-save.
3. Builds `OrderData` inline (`status: "Pending Payment"`, `customerChatId: "wa:<chatId>"`,
   `channel: "whatsapp"`) and `saveOrderSnapshot` (errors swallowed).
4. Sends `renderQuoteCard(order)` (catch → log).
5. **Dead code:** `if (false) { generateUpiQrPng(env.MERCHANT_VPA, 1000, …);
   triggerMockupDelivery(…) }` with the comment “To satisfy tests” — the dynamic
   amount-bearing UPI QR is imported but never generated.
6. Sends the **static** QR image: `env.STATIC_QR_URL`, unless unset or containing
   `drive.google.com`, in which case a hardcoded Vercel Blob URL is used.
7. Payment instructions (hardcoded `payMessage`); if `showsCallMe(qty)` (qty **> 300**,
   per `tests/pricing.test.ts`) the instructions go out as a menu with a single
   `📞 Request Callback` (`callme`) button instead of plain text.
8. **Screenshot intake happens here:** an `image`/`document` message sets
   `paymentScreenshotId` → `completeOrder()`. The literal `callme`/text containing
   “call” → `COPY.callMeAck` + `clearDraft()`. Anything else → generic reprompt.
9. **No Back button**, and typed `back` is blocked while `mockupDecision==="generate" ||
   mockupGenerated` (asserted by tests).

### C15 — `completeOrder` (exit into persistence + admin)

1. `COPY.screenshotAck` sent immediately.
2. `orderId ??= nextOrderId()`.
3. `assembleOrderData()` (second builder — see “Data contracts” for its differences from
   the inline builder at the payment prompt) → `saveOrderSnapshot` (catch → log).
4. `safeAppendOrderRow(order)` → Google Sheets **Orders** tab; on throw, sets
   `sheetWriteFailed` (the helper itself already escalated the full order text to admin
   chats with 3 retries before rethrowing).
5. `notifyAdmins(order, paymentScreenshotId)` — email via Resend to `ADMIN_EMAILS` with
   6-digit approval code (30 min), portal URL + OTP-resend URL, and a WhatsApp fallback
   containing the code + portal link if email fails. Screenshot media id is resolved to
   a public URL (`getPublicMediaUrl`) first and attached to the order snapshot.
6. If the sheet write failed, an extra hardcoded apology is sent to the customer.
7. `clearDraft()` — flow ends; the draft is gone.

## Back / Cancel / Restart handling (global, pre-step)

All of these run **before** `determineStep`, in this order:

| Input | Behavior |
|---|---|
| While `confirmingCancel`: `cancel:confirm` / “yes” / “cancel” / “y” / contains “yes, cancel” / “confirm cancel” | `clearDraft` + `COPY.discardGoodbye` |
| While `confirmingCancel`: anything else (incl. `cancel:resume`) | flag cleared, hardcoded “▶️ Order resumed! Let's continue:” + re-prompt current step |
| `cancel` / `exit` / `/cancel` / `stop` / `back_to_start` | sets `confirmingCancel=true` and shows a 2-button confirm menu (hardcoded warning text): `cancel:confirm` ❌ / `cancel:resume` ▶️ |
| `/start` / `start` / `restart` / `reset` | `clearDraft` + fresh `orderType` prompt — **no resume offer at any stage** |
| `back` / `b` / `undo` / `prev` / `previous` / `nav:back` / `⬅️ back` | blocked (hardcoded message) if mockup generated; else `rollbackStep` → save → re-prompt; if rollback impossible → “You're already at the beginning…” |
| `catalog…` (9 aliases incl. `order:catalogs`, `catalog:download`) | `COPY.catalogsListMessage`, then re-prompt current step (draft untouched) |

`rollbackStep(draft)` deletes the *previous* step’s field(s) by current step (full table
is exercised in `tests/navigation.test.ts`):

| Current step | What Back deletes → lands on |
|---|---|
| `orderType` | *(nothing — returns false)* |
| `garmentSilhouette` | `orderType` |
| `sampleFabric` | `garmentSilhouette` |
| `qty` | `garmentSilhouette` |
| `city` | bulk: `qty`,`sizeSplit` / sample: `fabric`,`qty`,`sizeSplit`,`tier`,`productId` |
| `name` | `city` |
| `phone` | `name` |
| `timeline` | `phone` |
| `tier` | `timeline`,`timelineUrgent` |
| `catalogFabric` | `tier` |
| `catalogQuality` | `fabric`,`productId` |
| `catalogColor` | `qualityOptionId/Name` (+ `fabric`,`productId` if ≤1 quality option) |
| `printMethod` | `colorName`,`catalogSelection` (+ conditional `qualityOptionId/Name`, `fabric`,`productId`) |
| `logoPlacement` | clears `choosingPlacement`, else deletes `printMethod` |
| `logoUpload` | pops last logo |
| `logoMore` | deletes last logo’s `fileId` |
| `mockupDecision` | `logoReceived = undefined` |
| `payment` | sample: `timeline(+Urgent)` / with logos: `mockupDecision` / else: `logoReceived` |
| `completed` (default) | *(returns false)* |

Global hard-block: if `mockupDecision === "generate"` or `mockupGenerated`,
`rollbackStep` returns `false` immediately (no field is touched).

## Exit taxonomy

| Exit | Trigger | Draft | Sheet row | Admin notice | Status written |
|---|---|---|---|---|---|
| Below-MOQ rejection | bulk qty < 50 | cleared | **none** | **none** | none |
| Confirmed cancel | `cancel` → `cancel:confirm` | cleared | **none** | **none** | none |
| `/start` mid-flow | `/start`/`restart`/`reset` | cleared silently at any stage | none | none | none |
| Callback requested | payment screen `callme` (shown only when qty > 300) | cleared after `COPY.callMeAck` | **none** (a Redis `order:<id>` snapshot from the payment prompt survives, but no Sheets row and no admin message are produced) | none | none |
| Payment proof received | image/document at `payment` | cleared after `completeOrder` | row with `status: "Pending Payment"` | admin email (+WhatsApp fallback) | `"Pending Payment"` |
| Rate-limited / locked | upstream in `bot/index.ts` | untouched | none | none | none |
| Empty message | silent return | untouched | none | none | none |

`Status` in `src/shared/types.ts` also defines `"Lead — Abandoned"`,
`"Lead — No Payment"`, `"Lead — High-Value Callback"`, and `statusMachine.ts` marks all
three terminal — but **no code anywhere in this repo ever sets them** (grep confirms only
the type/status-machine/test references). AGENTS.md’s claim that “post-qty cancels write a
Lead — Abandoned row”, “no-payment cancel → Lead — No Payment”, and “qty > 300 → Lead —
High-Value Callback” rows is **not implemented**.

## Copy inventory (`src/conversation/copy.ts`)

**Used keys (referenced from src/api):**

| Key | Consumer |
|---|---|
| `welcome`, `greetingAsk`, `catalogsMenuTitle`, `catalogsListMessage`, `garmentSilhouetteAsk`, `fabricAsk`, `sampleKitFabricAsk`, `brandingTypeAsk`, `placementAsk`, `logoUploadPrompt`, `addAnotherLogoAsk`, `qtyAsk`, `cityAsk`, `nameAsk`, `phoneAsk`, `phoneInvalid`, `timelineAsk`, `catalogQualityAsk`, `rejection`, `discardGoodbye`, `screenshotAck`, `callMeAck`, `genericReprompt` | `orderFlow.ts` |
| `floodCooldown`, `busyReprompt`, `mockupPaidProofAck` | `bot/index.ts` |
| `alreadyProcessed`, `adminUnauthorized` | `admin/actions.ts` |
| `mockupPaidRequired` | `api/mockup-delivery.ts` |
| `mockupPaidApprovedNote`, `mockupPaidRejected` | `mockup/paidGeneration.ts` |

**Orphaned keys (defined, referenced nowhere in src/api/tests):** `qtyAskSample`,
`resumePrompt`, `qtyInvalid`, `catalogProductAsk`, `catalogGroupAsk`, `catalogNoGroups`,
`catalogItemAsk`, `catalogNoItems`, `catalogImageConfirmAsk`, `catalogImageMissing`,
`catalogColorAsk`, `catalogColorConfirmAsk`, `catalogColorConfirmMissing`,
`catalogSelectionEcho`, `catalogAssistedSelection`, `sizeSplitAsk`, `sizeSplitOwnPrompt`,
`sizeSplitOwnInvalid`, `sizeSplitMismatch`, `sizeSplitSurplus`, `printAsk`, `printEcho`,
`placementEcho`, `paymentIntro`, `abandonedGoodbye`, `mockupEtaNote`, `mockupOfferAsk`,
`mockupGeneratingNote`, `mockupProofCaption`, `mockupUnavailable`, `orderNotFound`.

Conversely, `orderFlow.ts` ships **hardcoded customer-facing strings outside COPY**
(cancel warning, “Order resumed!”, back-blocked-after-mockup warning,
“Now choose your T-shirt colour:”, the mockup offer/free-quota texts, `payMessage`,
the sheet-failure apology, “An error occurred…”, “Flow complete.”,
“▶️ Order resumed!”, “You’re already at the beginning…”), which cuts against AGENTS.md
invariant 8 (“copy lives in copy.ts”).

## `uiMapper.ts` role

`sendMenu(to, text, options, listButtonText="View Options",
footerText="Reply 'back' to undo • 'cancel' to exit")`:

- `0` options → plain `sendMessage`.
- `≤3` options → `sendInteractiveButtons` (WhatsApp hard cap of 3).
- `4–10` options → `sendInteractiveList` (one section, ≤10 rows cap).
- `>10` options → plain-text numbered list fallback.
- Any interactive-send failure → `console.warn` + plain-text numbered list fallback.

It carries no flow logic — no option matching, no validation — only WhatsApp-format
selection. Matching lives in `processStep`. The default footer is why even screens
without a `nav:back` button (timeline, tier) still tell users they can type “back”.

## Data contracts

### Inbound (WhatsApp Cloud API → flow)

Consumed fields of the `message` object: `text.body`, `interactive.button_reply.id|.title`,
`interactive.list_reply.id|.title`, `button.payload`, `button.text`, `image.id`,
`document.id`. Everything else on the object is ignored except `console.log`-ed verbatim
at entry (the full message JSON is logged on every message).

### Outbound callback-payload namespace (customer buttons)

`order:*`, `garment:*`, `fabric:*`, `timeline:*`, `tier:*`, `optquality:*`, `color:*`,
`branding:*`, `placement:*`, `logo:*`, `mockup:*`, `nav:back`, `cancel:confirm`,
`cancel:resume`, `callme`. (`admin:*` and `mockupgen:*` are consumed upstream in
`bot/index.ts` and never reach this module.)

### Draft persistence

- Key `sess:<chatId>` (chat ids are bare WhatsApp ids here; the `wa:` prefix is applied
  when building `OrderData.customerChatId` / quota keys), TTL 24h, whole-document JSON.

### Outbound `OrderData` (two builders — must be kept in sync)

| Aspect | Inline builder in `promptNext`/`payment` | `assembleOrderData()` (mockup step + `completeOrder`) |
|---|---|---|
| `printMethod` | `draft.printMethod ?? "screen_print"` | `draft.printMethod!` → **`undefined` for sample orders** |
| `customerChatId` | always `` `wa:${chatId}` `` | `chatId.startsWith("wa:") ? chatId : `wa:<id>`` |
| `createdAt` | absent | `new Date().toISOString()` |
| `catalogItemName` / `catalogColor` | absent | derived from `catalogSelection` |

Common fields: `orderId`, `status: "Pending Payment"`, `orderType`, `tier`, `productId`,
`catalogSelection`, `qty`, `sizeSplit`, `city`, `name`, `phone`, `timeline`,
`timelineUrgent`, `logoReceived`, `logos`, `garmentRate`, `garmentTotal`,
`printEstLow/High`, `grandEstLow/High`, `advanceDue`, `channel: "whatsapp"`.

Downstream consumers of `OrderData`: `renderQuoteCard` (customer quote), `saveOrderSnapshot`
(`order:<orderId>`, 14d), `safeAppendOrderRow` (Sheets Orders tab), `notifyAdmins`
(email OTP + portal). Pricing is **only** ever computed through `src/pricing/*` inside
these builders — nothing user-typed reaches money fields.

### `catalogSelection` written at C10

```ts
{
  catalogVersion: "v1",            // hardcoded
  tier, groupId: fabric ?? "polyester", groupLabel: fabric ?? "Polyester",
  itemId: qualityOptionId ?? "standard", itemLabel: qualityOptionName ?? "Standard Quality",
  productId, garmentType: collar ? "polo" : "round_neck",
  sourceId: "catalog", sourcePage: 1,      // hardcoded — not the real PDF page
  colorName, referenceImageKind: "placeholder", mockupEligible: true,
}
```

AGENTS.md’s promise that orders store `catalogVersion` (SHA-256 of source PDFs) and the
exact `sourcePage`/`itemId` from the CatalogSelections tab does not match this writer.

## Error handling

| Layer | Mechanism |
|---|---|
| Per-message | `handleWhatsAppMessage` wraps `processStep` in try/catch → hardcoded “An error occurred. Please try again.” |
| Whole message | `bot/index.ts` catch-all → `captureException` (Sentry); lock released in `finally` |
| Draft saves | non-blocking Redis `set(...).catch(warn)` unless force flag; `clearDraft` awaits `del` |
| Order snapshot | every `saveOrderSnapshot` call site `.catch()`es (log or swallow) |
| Mockup dispatch | `triggerMockupDelivery` try/catch → log only; flow proceeds to payment regardless |
| Sheets write | `safeAppendOrderRow` retries 3× → escalates full order text to admin chats → rethrow → `completeOrder` sets `sheetWriteFailed` → customer apology → flow still completes (draft cleared) |
| Admin notify | try/catch → log only (internal email failure already falls back to WhatsApp inside `notifyAdmins`) |
| Quote / QR send | each `.catch()`es individually so a failed QR image doesn’t suppress the payment instructions |
| Quota peek | `peekUsage().catch(() => undefined)` → assume 3 free remaining |
| Menus | `sendMenu` catches interactive-send failures → plain-text numbered fallback |

Money never fails silently: sheet failure escalates and the customer is told; quote-card
send failure is logged; all monetary values are computed server-side before rendering.

## Discrepancies with AGENTS.md / existing docs

1. **Step numbering & order.** AGENTS.md S00–S11 (`tier → catalog → qty → sizes → print →
   contact → timeline → logo → mockup → quote → payment`) does not match the code
   (`orderType → garmentSilhouette → qty → city → name → phone → timeline → tier →
   catalogFabric → catalogQuality → catalogColor → printMethod → logos → mockupDecision →
   payment`). `docs/STATE_MACHINE_AND_FLOWS.md` claims S00–S12 — three schemes, none
   matching.
2. **Missing files.** `keyboards.ts`, `waitHelpers.ts`, `src/conversation/steps/*` are
   listed in AGENTS.md but do not exist; keyboard construction is inlined in `promptNext`.
3. **No grammY.** The repo (and `draft.ts`/`draftStore.ts` doc-comments) reference “the
   conversations plugin” and `conv:` storage, but no grammY dependency is wired; the flow
   is a hand-rolled handler behind `bot/index.ts`.
4. **No size-split step.** AGENTS.md’s S3 (even / standard mix / own with exact-sum
   fix-up) is not implemented — `sizeSplit` is always `resolveEvenSplit(qty)` and the
   whole `COPY.sizeSplit*` family is unused.
5. **No bracket reveal / qty upsell** (AGENTS.md S2c) — `getNextBracketRate` is exported
   but never called.
6. **Simplified catalog selection.** AGENTS.md describes group → item → image-confirm →
   colour with `sourcePage` traceability; actual flow is fabric → quality → colour with
   hardcoded `catalogVersion:"v1"`, `sourceId:"catalog"`, `sourcePage:1`,
   `referenceImageKind:"placeholder"`. `catalogGroupId`/`catalogItemId` are dead fields.
7. **Admin card buttons.** AGENTS.md says the admin card carries WhatsApp
   `✅ Confirm / 🚩 Issue` buttons. No code constructs `admin:confirm:<orderId>` /
   `admin:issue:<orderId>` callbacks — `handleAdminAction` parses them (only a test
   invokes them), while real approval flows through the Resend email OTP + web portal
   (`api/admin-approve.ts`) and typed admin commands.
8. **Resume prompt.** AGENTS.md: `/start` offers Resume/Fresh when a <24h draft has qty.
   Actual: `/start` always nukes the draft; `isDraftResumable`/`COPY.resumePrompt` are dead.
9. **Lead statuses.** The three `Lead — *` statuses are defined and terminal but never
   written (no abandoned/no-payment/high-value-callback rows are produced anywhere).
10. **Payment QR.** AGENTS.md: dynamic UPI QR with `amount=50% advance` + static QR.
    Actual: static QR only; `generateUpiQrPng` sits behind `if (false)`.
11. **Order-ID timing.** AGENTS.md: order ID created at S10 order assembly. Actual:
    created at `mockupDecision` (or lazily at the payment prompt / `completeOrder`).
12. **Back/Cancel “on every screen.”** Back is absent from `orderType`, `tier`,
    `timeline`, and the payment screen (the last one intentionally); the uiMapper footer
    hint is what those screens get instead.
13. **`package.json` description** still says “Click-first **Telegram** bot …
    (WhatsApp-portable core)” — Telegram remnants in a WhatsApp-only repo.

## Risks & observations

1. **Serverless draft-loss window.** `saveDraft` is memory-first with fire-and-forget
   Redis writes (only 3 call sites force the blocking path). A failed/lost write is only
   `console.warn`ed; a different isolate won’t see the memory cache. Mid-flow customers
   can silently regress to an earlier step.
2. **Full message logging.** `handleWhatsAppMessage` logs the entire raw webhook message
   (and every subsequent step parse) at `console.log` — PII (names, phone numbers,
   media ids) in logs, plus noise/latency on hot paths.
3. **Dead code in the money path.** The `if (false) { generateUpiQrPng(...); ... }`
   block exists “to satisfy tests” — dead imports (`generateUpiQrPng`) and a
   never-generated dynamic QR contradict the documented payment UX.
4. **Two divergent `OrderData` builders.** The inline payment-prompt builder and
   `assembleOrderData()` disagree on `printMethod` (defaulted vs `!`), `customerChatId`
   normalization, `createdAt`, and catalog denormalizations — sample orders get
   `printMethod: undefined` in snapshots/sheets. Any field added to `OrderData` must be
   added twice; nothing enforces that.
5. **Hardcoded payment fallbacks.** Missing/`drive.google.com` `STATIC_QR_URL` silently
   swaps in a third-party Blob URL for payment QR; qty/tier/productId silently default
   (50 / standard / dry-fit) at the payment prompt instead of failing fast.
6. **Loose input matching.** Keyword `includes` matching (e.g. “print”/“no”/“call”/“more”)
   means free text containing those words can trigger unintended branches —
   notably any text containing “call” at the payment screen aborts the order
   (`callMeAck` + `clearDraft`) even for a sub-300 order where the callback button
   wasn’t shown.
7. **Phone-step UX hole.** Invalid phone sends an error but never re-renders the prompt
   (commented-out `promptNext`), leaving the previous menu as the only context.
8. **Reproach/attribution of copy.** ~30 orphaned COPY keys and ~15 hardcoded strings in
   `orderFlow.ts` mean “edit copy.ts only” (AGENTS.md common task #1) is no longer true;
   product wording changes must be searched across both.
9. **MOQ/cancel exits discard silently.** No Lead capture (row or admin ping) on
   below-MOQ rejection, cancel, or `/start` — all abandonment data AGENTS.md promised is
   unavailable to the business.
10. **`catalogColor` writes source traceability fiction** (`sourcePage: 1`,
    `catalogVersion: "v1"`) into every order row — downstream audits against the
    CatalogSelections tab will be misleading until the real PDF page mapping is wired.
11. **Back-button coverage is inconsistent** (missing on tier/timeline/orderType) —
    relies on the footer hint + typed “back”; discoverability depends on the footer
    surviving WhatsApp’s truncation.
12. **Recursion in `promptNext`** (auto-skip in `catalogQuality`/`catalogColor` recurses
    instead of looping) — safe today (each recursion strictly advances the draft) but a
    future auto-skip that fails to persist could loop.
13. **No per-step timeouts/expiry** beyond the 24h draft TTL; `timelineUrgent` and
    `timeline` are redundant duplicates that must always be written together (they are,
    in both `processStep` and `rollbackStep`).
14. **Testing coverage.** Strong for sequencing (`determineStep`/`rollbackStep`) and the
    happy paths (bulk to payment, sample to payment, MOQ, invalid phone, cancel, back,
    generate-blocks-back); nothing covers `completeOrder` failure paths, `callme` exit,
    catalog free-text matching, or media-as-document input at `logoUpload`.

*Audit snapshot: based on repo state read on 2026-10-25 (`orderFlow.ts` = 1,118 lines;
file references to `keyboards.ts`/`steps/` reflect their absence in this checkout).*
