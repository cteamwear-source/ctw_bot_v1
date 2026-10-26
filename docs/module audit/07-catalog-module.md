# 07 — Catalog Module (`src/catalog/`)

## Purpose

The catalog module is the bot's product-data layer: it turns the shop's source PDFs
(`quality/**/*.pdf`) into a typed, versioned manifest (`src/catalog/data/catalog.generated.json`)
and exposes lookup/validation helpers plus a few hand-maintained supporting datasets
(quality options, colour→hex mapping, Google-Drive download links). Two hard rules govern it:

1. **The catalog never computes a price.** Every `CatalogItem` maps onto one of the pricing
   engine's four `ProductId`s (`src/pricing/priceBook.ts`) so pricing stays exclusively in
   `src/pricing/` (repo invariant #1). `src/catalog/types.ts` imports the `ProductId`,
   `Silhouette` and `Tier` types from the price book rather than redefining them.
2. **The generated JSON is never hand-edited.** It is fully overwritten on every
   `npm run generate-catalog`; human fixes go in `src/catalog/data/overrides.json`, which is
   shallow-merged over the auto-extracted data on each run.

## Files covered

| File | Role |
|---|---|
| `src/catalog/index.ts` | Runtime loader for the generated manifest + lookup/validation helpers |
| `src/catalog/types.ts` | Domain types (`CatalogManifest`, `CatalogGroup`, `CatalogItem`, `CatalogVariant`, `CatalogImageRef`, overrides schema) |
| `src/catalog/options.ts` | **Hand-maintained** quality/color option hierarchy (`CATALOG_OPTIONS`) + `resolveProductId()` — this is what the live S1 flow actually uses today |
| `src/catalog/colorHex.ts` | Colour-name → hex map (`getColorHex`) + `normalizeColorName` variant map, consumed by the AI mockup prompt builder |
| `src/catalog/downloads.ts` | Google-Drive catalog PDF links, WhatsApp list rendering, keyword search |
| `src/catalog/data/catalog.generated.json` | Generated manifest (~265 KB, `schemaVersion 1`, `catalogVersion 1.4d6c2133923c`, generated 2026-09-03) |
| `src/catalog/data/overrides.json` | Hand-maintained patch file — currently empty (`{"items":{},"variants":{}}`) |
| `scripts/generate-catalog.ts` | The ingestion pipeline (mupdf-based, ~990 lines) — the only producer of the generated JSON |
| `scripts/extract_all_catalog_colors.py`, `scripts/extract_stellar_images.py` | One-off Python analysis helpers used during catalog authoring (colour extraction / Stellars swatch image pulls); **not** part of the runtime or the npm pipeline — mentioned for completeness only |
| `tests/catalog.test.ts` | Invariant tests over the real checked-in manifest |

> **Important current-state note:** in the tree as it stands, `src/catalog/index.ts` is
> imported only by `tests/catalog.test.ts`. The live conversation flow
> (`src/conversation/orderFlow.ts`) drives step S1 from the **hand-maintained**
> `options.ts` (`CATALOG_OPTIONS` / `resolveProductId` / `getQualityOptionById`) and hardcodes
> `catalogVersion: "v1"` into `draft.catalogSelection`. The generated-manifest helpers
> (`getGroupsForTier`, `getSelectableItemsForGroup`, `isValidGroupForTier`, …) are fully
> built and tested but not yet wired into the flow. See *Risks* for the implications.

---

## Catalog data model (tiers → groups → items → colour variants)

Everything is declared in `src/catalog/types.ts`. The hierarchy mirrors the conversation
flow: pick tier → pick group → pick item → pick colour variant.

### `CatalogManifest` (root)

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `number` | Bump when the file **shape** changes in a breaking way (currently `1`) |
| `catalogVersion` | `string` | `"<schemaVersion>.<12-hex of content hash>"` — stamped onto orders for traceability (currently `1.4d6c2133923c`) |
| `generatedAt` | `string` | ISO timestamp of the generation run (currently `2026-09-03T11:02:59.827Z`) |
| `sources` | `CatalogSourceInfo[]` | One entry per ingested PDF |
| `groups` | `CatalogGroup[]` | Step-2 of the flow: brands (Premium) or categories (Basic/Standard) |
| `items` | `CatalogItem[]` | Flat list of all purchasable styles |

### `CatalogSourceInfo` (per source PDF)

| Field | Meaning |
|---|---|
| `id` | Stable slug of the PDF path, e.g. `basic-cotton-polo`, `premium-adidas-adidas-catalogue` |
| `relativePath` | Path relative to `quality/`, e.g. `Basic/cotton polo.pdf` |
| `sha256` | SHA-256 of the PDF bytes at ingestion — drift detection; also the input to `catalogVersion` |
| `pageCount` | Pages in the PDF |
| `extractionQuality` | `"text" | "image-only" | "partial"` — derived from total text length of the first 5 pages (`0` chars → `image-only`, `< 200 chars/page` → `partial`, else `text`) |

### `CatalogGroup` (step-2 choice)

| Field | Meaning |
|---|---|
| `id` | e.g. `basic-cotton-polo`, `branded-adidas` |
| `tier` | `CatalogTier` = pricing `Tier` = `"basic" \| "standard" \| "branded"` (no separate vocabulary) |
| `kind` | `"category"` (Basic/Standard garment categories) or `"brand"` (Premium brands) |
| `label` | Display label, e.g. `Cotton Polo`, `Adidas` |
| `itemIds` | Ordered ids of the member `CatalogItem`s |

Current manifest: 10 groups — 4 basic categories (13/5/10/10 items), 2 standard categories
(1 item each), 4 branded groups (Adidas 6, Reebok 35, Van Heusen 30, Stellars 3).

### `CatalogItem` (step-3 choice — one purchasable style)

| Field | Type | Meaning |
|---|---|---|
| `id` | `string` | e.g. `basic-cotton-polo-i1` — group slug + a **globally sequential** counter (see Risks) |
| `groupId` / `tier` | | Back-references |
| `label` | `string` | Display label, e.g. `Cotton Polo - Quality No. 380T`, `Adidas Dryfit Tshirt`, `Stellars Nano-Dry Golf Polo` |
| `productId` | `ProductId` | **The bridge to pricing** — one of `dry_fit_round_neck`, `dry_fit_polo`, `cotton_round_neck`, `cotton_polo` |
| `garmentType` | `Silhouette` | `"round_neck"` or `"polo"` (mockup silhouette) |
| `styleCode?` | `string` | e.g. `380T` (Basic tier "Quality No.") |
| `fabric?` | `string` | e.g. `100% COTTON`, `MARS 100% MICRO`, `Nano-Dry performance blend` |
| `gsm?` | `number` | e.g. `230` |
| `sourceId` | `string` | Which PDF it came from |
| `sourcePage` | `number` | 1-indexed primary page |
| `previewImage` | `CatalogImageRef` | Item hero image |
| `variants` | `CatalogVariant[]` | Colour options (may be empty) |
| `needsReview` | `boolean` | `true` = machine-produced by the image-only fallback parser (or with failed swatch downloads) and **not trustworthy for a real order until a human patches it via overrides.json** |

### `CatalogVariant` (a colour option)

| Field | Meaning |
|---|---|
| `id` | e.g. `basic-cotton-polo-i1-v1` — parent item id + **globally sequential** variant counter |
| `colorName` | e.g. `Navy Blue` |
| `colorCode?` | Article/SKU code (Adidas parser puts the article number here) |
| `sourcePage?` | 1-indexed page this colour's photo came from |
| `image` | `CatalogImageRef` — in Basic tier all variants of an item **share the item's single page photo**; Adidas/Stellars variants have distinct per-colour images |

### `CatalogImageRef`

| Field | Meaning |
|---|---|
| `kind` | `"rendered-page"` (PDF page rendered by mupdf), `"external-link"` (downloaded swatch, e.g. Stellars postimg.cc links), `"placeholder"` (download failed / nothing usable) |
| `localPath?` | Path relative to `assets/catalog/`, e.g. `basic-cotton-polo/page-001.jpg` |
| `sourceUrl?` | Original external URL, kept for traceability even after download |
| `width?`/`height?` | Pixel dimensions of rendered pages |

### Example entries from the checked-in manifest

**Basic tier** (one page = one item; variants share the page photo; note duplicate-ish colour
names "Navy Blue"/"Navy" produced by the swatch-grid heuristic):

```json
{
  "id": "basic-cotton-polo-i1",
  "groupId": "basic-cotton-polo",
  "tier": "basic",
  "label": "Cotton Polo - Quality No. 380T",
  "productId": "cotton_polo",
  "garmentType": "polo",
  "styleCode": "380T",
  "fabric": "100% COTTON",
  "gsm": 230,
  "sourceId": "basic-cotton-polo",
  "sourcePage": 1,
  "previewImage": { "kind": "rendered-page", "localPath": "basic-cotton-polo/page-001.jpg", "width": 1600, "height": 2265 },
  "variants": [
    { "id": "basic-cotton-polo-i1-v1", "colorName": "Navy Blue", "sourcePage": 1,
      "image": { "kind": "rendered-page", "localPath": "basic-cotton-polo/page-001.jpg", "width": 1600, "height": 2265 } },
    { "id": "basic-cotton-polo-i1-v2", "colorName": "Navy", "...": "..." },
    { "id": "basic-cotton-polo-i1-v3", "colorName": "Black Grey", "...": "..." },
    { "id": "basic-cotton-polo-i1-v4", "colorName": "White", "...": "..." }
  ],
  "needsReview": false
}
```

**Standard tier** (whole PDF = one design; one variant per colour-photo page):

```json
{
  "id": "standard-drifit-polo-i39",
  "label": "Polo Dry Fit - Finch Superia",
  "productId": "dry_fit_polo",
  "fabric": "MARS 100% MICRO",
  "gsm": 200,
  "previewImage": { "kind": "rendered-page", "localPath": "standard-polo-drifit-polo/page-002.jpg", "width": 1600, "height": 2400 },
  "variants": [
    { "id": "standard-drifit-polo-i39-v483", "colorName": "Coffee Brown", "sourcePage": 2, "image": { "...": "page-002.jpg" } },
    { "id": "standard-drifit-polo-i39-v484", "colorName": "Grey Melange", "sourcePage": 3, "image": { "...": "page-003.jpg" } }
  ],
  "needsReview": false
}
```

**Adidas (Premium)** — structured fields, article number reused as `colorCode`, distinct photo per colour:

```json
{
  "id": "branded-adidas-i41",
  "label": "Adidas Dryfit Tshirt",
  "productId": "dry_fit_round_neck",
  "fabric": "100% Polyester",
  "variants": [
    { "id": "branded-adidas-i41-v514", "colorName": "Black", "colorCode": "B30903", "sourcePage": 2,
      "image": { "kind": "rendered-page", "localPath": "premium-adidas-adidas-catalogue/page-002.jpg", "width": 981, "height": 698 } },
    { "id": "branded-adidas-i41-v515", "colorName": "Cool Navy", "colorCode": "B30904", "sourcePage": 3, "...": "..." }
  ],
  "needsReview": false
}
```

**Stellars (Premium)** — external swatch downloads; a failed download becomes a `placeholder`
variant and flips the whole item to `needsReview: true`:

```json
{
  "id": "branded-stellars-i112",
  "label": "Stellars Nano-Dry Golf Polo",
  "productId": "dry_fit_polo",
  "fabric": "Nano-Dry performance blend",
  "variants": [
    { "id": "branded-stellars-i112-v574", "colorName": "Magenta",
      "image": { "kind": "external-link", "localPath": "premium-stellars-stellers-nano-dry/ext-7c39b96d96ed.jpg",
                 "sourceUrl": "https://i.postimg.cc/HdR6hdVD/NANO-DRY-MG.jpg" } },
    { "id": "branded-stellars-i112-v598", "colorName": "Dresden Blue", "image": { "kind": "placeholder" } }
  ],
  "needsReview": true
}
```

Current manifest totals: **12 sources, 10 groups, 114 items, 69 items flagged `needsReview`**
(all 35 Reebok + all 30 Van Heusen from the image-only fallback parser, plus Stellars items
whose swatch downloads partially failed).

---

## How the generated JSON is loaded (`src/catalog/index.ts`)

- The manifest path is resolved relative to the module:
  `path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "catalog.generated.json")`.
- It is read **once at module load** with `fs.readFileSync(..., "utf-8")` + `JSON.parse`,
  cast to `CatalogManifest`. The code comment states the reason explicitly: the project's
  tsconfig `module` target doesn't support JSON import attributes, so a plain runtime read
  keeps the loader portable — the same pattern used for on-disk mockup template assets.
  AGENTS.md repeats this as a repo convention ("Keep that pattern").
- Three lookup indexes are built eagerly: `groupsById`, `itemsById`, `variantsById` (all
  `Map<string, …>`), so all helpers are O(1) map reads.
- Helpers exposed:
  - `getCatalogVersion()`, `getCatalogManifest()`
  - `getGroupsForTier(tier)`, `getGroup(id)`, `getItemsForGroup(groupId)` (manifest order)
  - `getItem(id)`, `getVariant(id)`, `getVariantsForItem(itemId)`
  - Selectability gates: `isItemSelectable(item)` (rejects `needsReview`, placeholder/no
    `localPath` preview, unknown `productId`, unknown `garmentType`),
    `getSelectableItemsForGroup`, `isVariantSelectable` (needs non-placeholder image),
    `getSelectableVariantsForItem`
  - Callback-payload validation (anti-forgery / anti-stale-keyboard):
    `isValidGroupForTier(groupId, tier)`, `isValidItemForGroup(itemId, groupId)`,
    `isValidVariantForItem(variantId, itemId)`
  - Image helpers: `getItemPreviewPath`, `getVariantImagePath` (falls back to parent item
    preview), `resolveCatalogAssetPath(localPath)` → absolute path under
    `<repo>/assets/catalog/`, `variantHasDistinctImage(item, variant)` (string-compare of
    `localPath`s — decides whether picking a colour warrants a second image-confirm step)
- It re-exports all types and `export * from "./downloads.js"`.

---

## The overrides mechanism (`src/catalog/data/overrides.json`)

Schema (`CatalogOverridesFile` in `types.ts`):

```ts
{
  items?:   Record<itemId,   Partial<Pick<CatalogItem,   "label"|"productId"|"garmentType"|"styleCode"|"fabric"|"gsm"|"needsReview">>>;
  variants?: Record<variantId, Partial<Pick<CatalogVariant, "colorName"|"colorCode">>>;
}
```

- Applied by `scripts/generate-catalog.ts` **after** all parsing and Stellars downloads,
  via a shallow `Object.assign(item, patch)` / `Object.assign(variant, patch)` per keyed
  entry. Only whitelisted fields are typed, but `Object.assign` at runtime will happily
  write any property the JSON contains.
- If the file doesn't exist the generator creates it with empty `items`/`variants`.
- The generator prints a warning listing how many items remain `needsReview=true` after
  overrides — the intended workflow is: run → patch overrides → re-run.
- The file is currently empty (`{ "items": {}, "variants": {} }`), which is why 69 items
  (all Reebok/Van Heusen + failed-download Stellars) remain unselectable via the
  generated-manifest path.

---

## `colorHex.ts` — colour-name → hex mapping

Purpose: give the **AI mockup prompt builder** (`src/mockup/promptBuilder.ts`) an exact
garment colour to preserve in the prompt instead of trusting the catalog photo's lighting.

- `getColorHex(colorName)`: builds a local `Record<string,string>` of ~86 canonical colour
  names → 6-hex-digit codes (no `#` prefix), e.g. `Black → 212126`, `Navy Blue → 202335`,
  `Royal Blue → 324EB0`, `Siemens Green → 4BDDCB`, plus ~17 alias/legacy entries
  (`Navy`, `Royal`, `Turquoise`, `Forest Green`, `F. Green`, …). Lookup order:
  1. `hexMap[normalizeColorName(name)]`, 2. `hexMap[name]` verbatim, 3. case-insensitive
     scan over all keys. Returns **`null`** for unknown colours — callers must degrade
     gracefully (omit the colour clause from the prompt).
- `normalizeColorName(name)`: trim + lowercase, then a ~65-entry variant map from lowercase
  spellings to canonical-cased names (`"navy" → "Navy Blue"`, `"forest green" → "F. Green"`,
  `"coffee" → "Coffee Brown"`, …); falls back to the trimmed original.
- Consumers today: `src/mockup/promptBuilder.ts` (`getColorHex`) and
  `src/mockup/garmentReference.ts` (`normalizeColorName`); also `scripts/mockup-ui-server.ts`
  and `tests/promptBuilder.test.ts`.

---

## `options.ts` — the hand-maintained quality/color hierarchy (what the live flow uses)

Separate from the generated manifest, this file is a hand-authored dataset that compiles the
`quality/` folder into `CATALOG_OPTIONS: Record<Tier, Record<ProductId, QualityOption[]>>`:

- `QualityOption = { id, name, colors: string[] }` — e.g. basic/`cotton_polo` has
  `UF 008`, `UF 010`, `UF 011`, `UF 007 - Plain`, `UF 007 - Tipping`, `UF Premium`,
  `UF 009`; standard has `Finch *` designs; branded has Van Heusen/Adidas/Reebok/Stellars entries.
- **The `QualityOption.id`s are the integration key to pricing**: ids are prefixed
  `val-*` (Basic), `rec-*` (Standard), `prem-*` (Premium) and are exactly the keys of
  `VARIANT_RATES` in `src/pricing/priceBook.ts`. In `orderFlow.ts`, `draft.qualityOptionId`
  is passed as the `variantId` argument of `computeGarmentTotal(tier, productId, qty, draft.qualityOptionId)`,
  so choosing "Finch Superia Mars" overrides the generic `dry_fit_polo` rate with 429/399.
- `resolveProductId(garment: "round_neck"|"collar", fabric: "cotton"|"polyester"): ProductId`
  maps the flow's collar/round-neck × cotton/polyester vocabulary onto the four pricing SKUs.
  Note this uses `"collar"` where the pricing type uses `"polo"` — the flow converts.
- Helpers: `getQualityOptions(tier, productId)`, `getQualityOptionById(tier, productId, qualityId)`.
- The S1 flow (`orderFlow.ts` cases `catalogQuality`/`catalogColor`) reads quality menus from
  this file and writes `draft.catalogSelection` with a hardcoded `catalogVersion: "v1"` and
  `referenceImageKind: "placeholder"` — i.e. the typed generated-manifest pipeline is not yet
  the source of truth for live orders.

---

## `downloads.ts` — catalog PDF links

- `CATALOG_DRIVE_FOLDER_URL` — one Google-Drive folder URL for all catalogs.
- `CATALOG_DOWNLOAD_ITEMS: CatalogDownloadItem[]` — 12 entries (`tier` uses the display
  casing `"Basic" | "Standard" | "Premium"`, **not** the pricing `Tier` lowercase union):
  4 Basic, 2 Standard, 6 Premium (Adidas, Reebok, Van Heusen, Stellars Nano-Dry, Softberry
  Men, Softberry Women). Each has `fileId`, `viewUrl`, `downloadUrl`
  (`https://drive.google.com/uc?export=download&id=…`) and `keywords[]`.
- `renderCatalogDownloadList()` — WhatsApp-flavoured Markdown message grouping the links
  under 🔹 Basic / 🔸 Standard / ⭐ Premium headers plus the Drive folder link. Rendered via
  `COPY` in `src/conversation/copy.ts`.
- `findCatalogByQuery(query)` — lowercase keyword match; ignores queries shorter than 3
  chars and a stoplist (`catalog`, `pdf`, `drive`, `download`, `view`, plurals); matches on
  name-substring or bidirectional keyword containment.
- Used by `orderFlow.ts` (`findCatalogByQuery`, `CATALOG_DRIVE_FOLDER_URL`) and
  `tests/catalogDownloads.test.ts` / `tests/orderFlow.test.ts`.

---

## The generation pipeline (`scripts/generate-catalog.ts`)

Run with `npm run generate-catalog`. It is the **only** producer of
`catalog.generated.json` and of the preview images under `assets/catalog/`. Core facts:

- **Engine:** the `mupdf` npm package (WASM build of MuPDF). Pages are loaded, rendered to
  RGB pixmaps and exported as JPEG, and text is extracted via `toStructuredText().asText()`.
  Pages/structured-text objects are explicitly `destroy()`ed in `finally` blocks and rendering
  targets a fixed `TARGET_WIDTH_PX = 1600` (scale derived per page, capped at ×2) precisely
  because some source PDFs are authored at ~3000×4500 pt and a fixed zoom would exhaust the
  WASM heap. JPEG quality 82.
- **Per-source parsing strategies** (registered as `specs[]` with per-PDF parser functions):
  - **Basic (4 PDFs)** — `parseBasicPdf`: one page = one `CatalogItem` labelled
    `"… — Quality No. <code>"`; regexes pull `styleCode` (`quality no.…`), `gsm`
    (`… | 210 gsm`), `fabric` (`NN% cotton/polyester`). Colour swatch names are heuristically
    extracted from page lines (length/charset filter + a stoplist of non-colour strings, plus
    merging of wrapped two-word names like `BOTTLE`+`GREEN`). All variants of an item share
    the item's single rendered page photo. `needsReview = !styleCode`.
  - **Standard (2 PDFs)** — `parseStandardPdf`: the whole PDF is one design
    (`Design No: …`); each colour-photo page (identified by having `design no:`/`fabric type`
    text and a colour-name first line; size-chart/cover pages skipped) becomes one
    `CatalogVariant` with its own rendered page image; the first colour page is the hero.
    `needsReview = variants.length === 0`.
  - **Adidas (151-page PDF)** — `parseAdidasPdf`: per page, regexes extract `Article No.`,
    `Color:`, `Material:`, `Sizes available:`; the **last text line** is the product name.
    Pages whose product name matches apparel keywords (`tshirt|polo|round neck`) and not the
    exclusion list (`shoe|sock|bag|cap|short|track|hoodie|…`) are grouped by product name into
    items; one variant per page, article number stored as `colorCode`. `garmentType` derived
    from `/polo/i` in the product name; `productId` inferred from the material text.
  - **Stellars (3 PDFs)** — `parseStellarsPdf`: no per-colour photos in the PDF; colour
    swatches are hyperlink targets to hosted JPEGs. Spaced-caps colour headings
    (`M A U V E`) are collapsed back to words via a greedy longest-prefix match against a
    `COLOR_WORD_HINTS` dictionary. Link URLs are paired with colour names positionally,
    **deduped by colour name** (these PDFs repeat whole swatch sections under fresh
    postimg.cc URLs). Downloads happen *after* all parsing, with **concurrency 6**, 15 s
    timeout, an in-run URL cache, and files saved as `ext-<sha256[:12]>.jpg|png`; a failed
    download yields `{kind:"placeholder"}` and sets `needsReview = true` on the item.
  - **Reebok + Van Heusen (35 + 30 pages)** — fully image-only PDFs (zero extractable text,
    `extractionQuality: "image-only"`). `parseFallbackImageOnlyPdf` makes one generic
    item per page (`"<Brand> — Style (page N)"`, dummy `productId: "dry_fit_round_neck"`,
    no variants) with **`needsReview: true`** — a human must patch these via overrides.json.
- **productId inference** (`inferProductId(garmentType, fabricText)`): if both `NN% cotton`
  and `NN% poly…` percentages are present, dry-fit iff poly% > cotton%; else keyword checks
  (`nano-dry|dri-fit|drifit` → dry-fit; `cotton` → cotton; `polyester|poly` → dry-fit;
  default cotton); finally combined with `garmentType` (`polo`/`round_neck`) to pick one of
  the four SKUs. Glyph-mangling fixes (`fixMangledGlyphs`) repair MuPDF ligature damage
  (`Dryﬁt` → `Dryfit`, `craed` → `crafted`, smart quotes, U+FFFD).
- **Version stamping:** `contentHash = sha256(sorted per-source sha256 joined by "|")`;
  `catalogVersion = "1." + contentHash.slice(0,12)` → e.g. `1.4d6c2133923c`. Changing any
  source PDF's bytes changes the version, which is what makes historic orders traceable.
- **Output:** pretty-printed (2-space) `catalog.generated.json` + warning summary. Preview
  images live under `assets/catalog/<sourceSlug>/page-NNN.jpg` / `ext-<hash>.jpg`.

---

## How the catalog connects to pricing `ProductId`s

Three seams, all pointing at `src/pricing/priceBook.ts` as the single source of truth:

1. **Types:** `CatalogTier = Tier`, `CatalogItem.productId: ProductId`,
   `CatalogItem.garmentType: Silhouette` — imported, not redefined.
2. **Generated manifest:** each parser assigns a `productId` (explicitly for Basic/Standard,
   via `inferProductId` for Adidas/Stellars). `index.ts` re-validates with its own
   `VALID_PRODUCT_IDS` / `VALID_GARMENT_TYPES` sets that must stay in sync with the price
   book's unions; items failing the check are simply not selectable.
3. **Live flow:** `options.ts` quality-option ids double as `VARIANT_RATES` keys, and
   `resolveProductId()` translates the flow's collar/round-neck × cotton/polyester choice
   into a `ProductId`. Pricing is then computed from `(tier, productId, qty, variantId)`
   exactly as if the catalog didn't exist — brand/style affects price only through the
   `variantId` override, never through new pricing logic.

---

## Execution flow

### Generation (offline, `npm run generate-catalog`)

```
quality/**/*.pdf
  → buildSourceInfo(): read bytes, sha256, open via mupdf, sniff extractionQuality from 5-page text sample
  → per-source parser (Basic/Standard/Adidas/Stellars/Fallback):
        renderPage() → assets/catalog/<slug>/page-NNN.jpg  (CatalogImageRef kind=rendered-page)
        text/link extraction → items + variants (heuristics per parser)
  → Stellars post-pass: bounded-concurrency download of swatch URLs → ext-<hash>.jpg (kind=external-link | placeholder)
  → apply overrides.json (shallow Object.assign per item/variant id)
  → catalogVersion = "1." + sha256(sorted source hashes)[:12]
  → write src/catalog/data/catalog.generated.json
```

### Runtime (import of `src/catalog/index.ts`)

```
cold start → readFileSync(catalog.generated.json) → JSON.parse → build 3 Maps
           → helpers served from Maps (isValidGroupForTier / getSelectableItemsForGroup / …)
assets are served from disk via resolveCatalogAssetPath() under assets/catalog/ 
  (requires vercel.json includeFiles: "assets/catalog/**" on the webhook function)
```

### Live S1 flow today (orderFlow.ts)

```
S00 tier → resolveProductId(collar|round_neck, cotton|polyester) → ProductId
         → getQualityOptions(tier, productId)  [options.ts, not the manifest]
         → user picks quality (draft.qualityOptionId = VARIANT_RATES key) → user picks color
         → draft.catalogSelection = { catalogVersion: "v1", …, referenceImageKind: "placeholder" }
later    → computeGarmentTotal(tier, productId, qty, draft.qualityOptionId)  [pricing override]
```

---

## Data contracts

- `CatalogManifest` is the on-disk contract between `scripts/generate-catalog.ts` (producer)
  and `src/catalog/index.ts` (consumer). `schemaVersion` guards shape changes;
  `catalogVersion` guards content drift and is intended to be stamped on every order
  (`OrderData.catalogSelection.catalogVersion`, `CatalogSelections` sheet tab).
  **Today the live flow hardcodes `"v1"` instead** — see Risks.
- `CatalogItem.productId` **must** be a member of the price book's `ProductId` union; the
  catalog's `VALID_PRODUCT_IDS` set is a runtime duplicate of that union.
- `QualityOption.id` (options.ts) **must** be a member of `VARIANT_RATES` keys
  (`val-*`/`rec-*`/`prem-*`); there is no compile-time check tying the two together.
- `CatalogImageRef.localPath` is always relative to `assets/catalog/` (repo-relative), and
  must exist on disk for WhatsApp image sending / mockup reference; `placeholder` kind
  guarantees `localPath === undefined` (asserted by tests).
- `overrides.json` keys reference `CatalogItem.id` / `CatalogVariant.id` from the generated
  manifest — i.e. they are coupled to generator output (see ID-stability risk below).

---

## Risks & observations

1. **Two parallel catalog systems, partially diverged.** The typed generated-manifest
   pipeline (`index.ts` + `catalog.generated.json`, fully tested) is currently *not* used by
   the live flow; the flow uses the hand-maintained `options.ts` and writes
   `catalogVersion: "v1"` into `catalogSelection`. Consequences: the real PDF-derived data
   (114 items, per-colour photos, `sourcePage` traceability) is unused in production;
   `getCatalogVersion()` has no production caller; and the promised per-order traceability to
   the exact PDF page is not actually recorded for live orders.
2. **69/114 items are `needsReview=true`** (all Reebok + Van Heusen from the image-only
   fallback parser, plus Stellars items with failed swatch downloads). Until a human patches
   `overrides.json` and regenerates, these items are correctly hidden by `isItemSelectable`
   — but that also means two whole Premium brands are effectively unorderable through the
   manifest path, and the checked-in manifest already contains at least one `placeholder`
   Stellars variant (failed `i.postimg.cc` download).
3. **Staleness.** The manifest (`generatedAt 2026-09-03`) is a commit-time artifact; there is
   no runtime check that it matches the current `quality/` PDFs. If someone replaces a PDF
   and forgets to regenerate, only the per-source `sha256` fields would reveal it. Similarly,
   `colorHex.ts` and `options.ts` drift silently from the generated data — e.g. the manifest
   contains colour names the hex map doesn't know (`Cool Navy`, `Blue`, `Yellow` from Adidas
   are covered by aliases, but new extraction output may not be), and Basic-tier duplicates
   like `"Navy Blue"` + `"Navy"` produce redundant variants.
4. **Generated IDs are not stable across regenerations.** Item/variant ids embed a *global*
   sequential counter (`<group>-i<n>`, `<item>-v<n>`) whose value depends on the position of
   a source in the `specs[]` array and on how many items previous sources produced. Inserting
   or reordering a PDF shifts every subsequent id, which silently orphans all
   `overrides.json` keys for later sources (the `Object.assign` patch just won't find a
   match). Overrides are only safe while the source list and per-source item counts stay
   fixed.
5. **Disk reads in serverless.** The manifest is read synchronously at import (cold-start
   cost ~265 KB parse) and catalog images are read from disk at send time. The webhook
   function therefore *must* ship `assets/catalog/**` via `includeFiles` in `vercel.json`
   (AGENTS.md calls this out); a deploy that drops that glob makes every image send fail at
   runtime with no compile-time signal. A corrupt/half-written manifest would crash the
   module at import (no try/catch around the `readFileSync`/`JSON.parse`), taking down every
   lambda that imports it.
6. **Heuristic extraction quality.** Colour detection for Basic PDFs is line-shape
   heuristics; the checked-in output shows real false positives (`"Navy"` vs `"Navy Blue"`,
   `"Black Grey"` vs `"Charcoal Grey"`). Stellars colour↔URL pairing is positional
   (`min(urls, colors)`), so a mis-count in the spaced-caps heading extraction can shift
   every colour name onto the wrong swatch image. Adidas product-name detection uses the
   page's *last* text line — layout changes in a new catalog edition could mis-group or drop
   products. All of these are the reasons `needsReview` and `overrides.json` exist; treat
   them as required workflow, not optional.
7. **`assets/catalog` growth.** Every regeneration renders every page of every PDF at 1600 px
   (12 PDFs, ~346 pages incl. the 151-page Adidas catalog); the images are committed, so the
   repo/deploy bundle grows with each re-ingest. No pruning of orphaned images from removed
   sources is performed by the generator (it only ever writes).
8. **Sync, blocking I/O.** `readFileSync` at import and `fs.writeFileSync` in the generator
   are fine for serverless cold starts and offline scripts respectively, but any future
   hot-reload path (e.g. admin-triggered regeneration) would block the event loop.
