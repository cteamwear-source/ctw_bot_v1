# 09 — Mockup Core: Deterministic Compositing, Garment Reference & AI Visualization

Knowledge-transfer audit of the mockup subsystem's rendering core. Every number, path,
and behaviour below was read directly from the source files listed in
**Files covered**; where module header comments and actual code diverge, both are
reported explicitly.

## Purpose

Explain how the bot turns an order + customer-uploaded logo bytes into the image(s)
shown to the customer:

1. The **deterministic proof pipeline** (`composite.ts` + `zones.ts` +
   `garmentReference.ts`) — pixel-exact Sharp compositing, no AI, the only path that
   runs in production by default.
2. The **legacy compositor** (`generate.ts`) — the original single-logo
   template compositor, superseded by `composite.ts` but still exercised by
   `tests/mockup.test.ts` and `scripts/test-mockup-generator.ts`.
3. The **AI visualization path** (`generateAi.ts` → `imageProvider.ts` →
   `geminiClient.ts` / `openaiClient.ts` + `promptBuilder.ts`) — the single
   sanctioned AI exception in the codebase (AGENTS.md invariant #9), gated off in
   production behind `ENABLE_ONLINE_AI_MOCKUPS`.

## Files covered

| File | Role |
|---|---|
| `src/mockup/composite.ts` | Authoritative deterministic proof compositor (multi-logo, multi-view, reference-source aware) |
| `src/mockup/zones.ts` | The 5 placement zone rects (fractions of image W/H) + front/back view mapping |
| `src/mockup/garmentReference.ts` | Resolves which garment image bytes + descriptor an order renders onto |
| `src/mockup/generate.ts` | Legacy single-logo compositor (generic template only) |
| `src/mockup/generateAi.ts` | AI orchestrator: per-view parallel provider calls |
| `src/mockup/imageProvider.ts` | Provider abstraction + selection via `MOCKUP_IMAGE_PROVIDER` |
| `src/mockup/geminiClient.ts` | Gemini `generateContent` image client |
| `src/mockup/openaiClient.ts` | OpenAI `/v1/images/edits` client |
| `src/mockup/promptBuilder.ts` | Natural-language placement prompt builder |
| `tests/deterministicMockup.test.ts` | Pixel-exactness + view-count + legacy-fallback specs |
| `tests/exactGarmentMockup.test.ts` | AI-path specs (template bytes reaching provider, prompt weaving, view counts) |
| `tests/promptBuilder.test.ts` | Prompt content specs (colour hex, fabric, lighting, sleeve isolation) |

Supporting facts pulled from (not fully audited here): `src/pricing/priceBook.ts`
(`LogoPlacement`, `Silhouette`, `PRODUCT_SILHOUETTE`, `PrintMethod`),
`src/catalog/colorHex.ts`, `src/shared/types.ts` (`CatalogSelection`, `MockupView`),
`src/mockup/deliver.ts` (production gating of the AI path), `src/config/env.ts`.

---

## The deterministic proof pipeline

### Contract (composite.ts header, lines 1–20)

The deterministic image is the **authoritative print proof**. Its guarantees:

- **base** = the order's garment reference image, used verbatim — every pixel outside
  a logo zone is identical to the reference.
- **logo** = the customer's **original uploaded logo bytes**, only scaled to fit the
  placement zone ("contain": aspect ratio preserved, never cropped, never recoloured,
  never redrawn — including any circle/background the artwork ships with).
- **output** = base + logo composited at the zone. One output image per distinct view
  the assignments touch (front-only → 1, front+back → 2).
- Generative AI is explicitly never used here.

### Entry points

Two exported functions:

- `compositeLogosOntoBase(baseBuffer, view, assignments, logoBuffers): Promise<Buffer>`
  — low-level testable primitive; composites onto a caller-supplied base for a single
  view. Production calls it indirectly via `generateDeterministicMockups`; tests use
  it with fully controlled inputs to assert pixel-exact behaviour.
- `generateDeterministicMockups(order, assignments, logoBuffers): Promise<DeterministicMockupResult[]>`
  — the production pipeline. Throws `"At least one logo assignment is required."` if
  `assignments.length === 0`. For each view from `viewsForAssignments(assignments)`:
  resolve the garment reference (`resolveGarmentReference(order, view)`), composite,
  and push `{ view, buffer, referenceSource }`.

`DeterministicMockupResult = { view: MockupView; buffer: Buffer; referenceSource: GarmentReferenceSource }`.

### Compositing math (compositeView, `composite.ts` lines 57–96)

For each assignment whose `PLACEMENT_VIEWS[placement]` equals the current view:

```
base      = sharp(baseBuffer); meta = base.metadata()
width/height = meta.width/meta.height   (throws if either is missing:
             "Could not read garment reference image dimensions for deterministic compositing.")
zone      = getZoneForPlacement(placement)          // fractions 0..1
zoneW     = max(1, round(zone.width  * width))
zoneH     = max(1, round(zone.height * height))
zoneLeft  = round(zone.x * width)
zoneTop   = round(zone.y * height)

resizedLogo = sharp(logoBuffers[a.logoIndex])
                .resize(zoneW, zoneH, { fit: "contain",
                          background: { r:0, g:0, b:0, alpha:0 } })  // transparent pad
                .png().toBuffer()

overlays.push({ input: resizedLogo, left: zoneLeft, top: zoneTop })
...
return base.composite(overlays).png().toBuffer()
```

Key properties:

- **"contain" fit** means a logo whose aspect ratio differs from the zone box is
  transparent-padded and centered; it fills the box's shorter dimension only. A square
  logo in the non-square `left_chest` box fills the box height (the shorter side) and
  centers on the zone centre — this is exactly what the pixel tests rely on.
- `Math.max(1, …)` guards against zero-size zones on tiny images. Note the legacy
  `generate.ts` does **not** have this guard (see Risks).
- The whole output is re-encoded as **PNG** (`base.composite(overlays).png()`), so
  output dimensions always equal base dimensions and every pixel outside the overlaid
  logo boxes is byte-for-byte the base.

### Zone rects — all 5 placements (`zones.ts`)

All values are fractions 0..1 of template width/height (the single source of truth
per `docs/Mockup-Template-Generation.md` §7):

| Placement | x | y | width | height | View (`PLACEMENT_VIEWS`) |
|---|---|---|---|---|---|
| `left_chest` | 0.53 | 0.23 | 0.15 | 0.15 | front |
| `center_front` | 0.30 | 0.25 | 0.40 | 0.30 | front |
| `upper_back` | 0.25 | 0.15 | 0.50 | 0.20 | back |
| `left_sleeve` | 0.78 | 0.30 | 0.14 | 0.15 | front |
| `right_sleeve` | 0.08 | 0.30 | 0.14 | 0.15 | front |

Notes straight from the source:

- `left_sleeve` is at image-**right** (x 0.78) because "left sleeve = wearer's left
  arm = image-right in a front-facing photo"; `right_sleeve` mirrors it at x 0.08.
  Left/right are distinct zones (not one mirrored option) so two different logos can
  go on each arm in one order.
- `PLACEMENT_VIEWS` also accepts a legacy `"centre_front"` (British spelling) key,
  mapped to `center_front`/front; `getZoneForPlacement("centre_front")` returns
  `ZONES.center_front`, and unknown placements **fall back to `ZONES.center_front`**
  (`?? ZONES.center_front`).
- Both sleeve placements render on the **front** view only; `upper_back` is the only
  back-view placement. A customer wanting the same logo front+back creates two
  assignments (e.g. `left_chest` + `upper_back`) pointing at the same uploaded image
  (design note in `priceBook.ts` lines 236–245).

On the actual shipped templates (`assets/mockup-templates/*.png`, verified via Sharp:
all four are **1024×1024 PNG**), the zone pixel boxes resolve to e.g. `left_chest` =
left 543, top 236, 154×154 px; `center_front` = left 307, top 256, 410×307 px;
`upper_back` = left 256, top 154, 512×205 px; `left_sleeve` = left 799, top 307,
143×154 px; `right_sleeve` = left 82, top 307, 143×154 px (computed by the exact
`round()` formulas above).

### View mapping & view counting

- `TemplateView = "front" | "back"` (also `MockupView` in `src/shared/types.ts` line
  70 — structurally identical).
- `viewsForAssignments(assignments)` (`promptBuilder.ts` lines 193–196) returns the
  distinct views via a `Set` — insertion-ordered, so front assignments produce
  `["front"]`, front+back produce `["front", "back"]`.

### Determinism guarantees & pixel-exact tests (`tests/deterministicMockup.test.ts`)

The test suite builds solid-colour 1000×1000 bases and solid square logos, then reads
individual pixels via `sharp(...).raw()`:

1. **"reference pixels OUTSIDE the logo zone are preserved exactly; logo pixels appear INSIDE the zone"** —
   base RGB(200,30,30), 300px square logo RGB(20,40,220), `left_chest` on front:
   output keeps 1000×1000; pixel (5,5) (far corner, outside every zone) deep-equals
   the base colour; the zone centre pixel
   (`round((zone.x + zone.width/2)·W)`, `round((zone.y + zone.height/2)·H)`) deep-equals
   the logo colour.
2. **"a point just outside the zone box stays exactly the reference colour"** —
   5 px up-and-left of the zone's top-left corner is still the untouched base.
3. **View counts + legacy fallback** — a legacy order (`catalogSelection` absent,
   `productId: "cotton_round_neck"`) with a `left_chest` logo yields exactly 1 result,
   `view: "front"`, `referenceSource: "legacy-template"`; adding an `upper_back`
   logo yields exactly 2 results with views `{back, front}`.

These tests pin the two core invariants: **no pixel outside a logo box ever changes**,
and **the logo's original pixels (colour) appear at the zone centre, unaltered**.

---

## garmentReference.ts — how the garment image is resolved

### Templates on disk

`assets/mockup-templates/` contains exactly four files, all 1024×1024 PNG:
`polo_front.png`, `polo_back.png`, `round_neck_front.png`, `round_neck_back.png`.
The path is resolved relative to the module (`../../assets/mockup-templates`).

### Types

- `GarmentDescriptor = { garmentType: Silhouette; styleLabel?: string; colorName?: string }`
  — e.g. `styleLabel: "Adidas Dryfit Tshirt"`, `colorName: "Cool Navy"`.
- `GarmentReferenceSource = "catalog-exact" | "legacy-template" | "white-template"`.
- `GarmentReference = { buffer; descriptor; source }`.

### Resolution (`resolveGarmentReference(order, view)`)

```
catalogSel = order.catalogSelection
isLegacy   = catalogSel === undefined && !order.colorName   // (via loose `as any` access)

if isLegacy:
    silhouette = PRODUCT_SILHOUETTE[order.productId] || "polo"
    read assets/mockup-templates/<silhouette>_<view>.png
    descriptor = { garmentType: silhouette, styleLabel: undefined }
    source = "legacy-template"

else:
    silhouette = catalogSel?.garmentType
                 || order.garmentType
                 || PRODUCT_SILHOUETTE[order.productId]
                 || "polo"
    template  = polo  → (back ? polo_back : polo_front)
                else  → (back ? round_neck_back : round_neck_front)
    rawColor  = catalogSel?.colorName || order.colorName || ""
    colorName = rawColor ? normalizeColorName(rawColor) : undefined
    descriptor = {
      garmentType: silhouette,
      styleLabel: catalogSel?.itemLabel ?? order.qualityId,   // e.g. "Cotton Polo (UF 008)"
      colorName: resolvedColorName || rawColor || undefined,
    }
    source = "white-template"
```

So for any modern catalog order the reference image is the **clean white template**
for the correct silhouette/view, and the selected colour is carried only as a
descriptor (fed to the AI prompt as "recolor to hex #XXXXXX"), not baked into pixels.
`PRODUCT_SILHOUETTE` maps all four product IDs:
`dry_fit_round_neck`/`cotton_round_neck` → `round_neck`, `dry_fit_polo`/`cotton_polo`
→ `polo`.

### Eligibility helpers (and a notable stub)

- `isLegacyOrderWithoutCatalog(order)` = `order.catalogSelection === undefined`.
- `isMockupEligible(_order)` **always returns `true`** (parameter unused). The module
  header and `CatalogSelection.mockupEligible` (types.ts lines 50–58) describe a
  design where a modern order without a usable exact image must NOT fall back to a
  generic template and should surface "exact preview unavailable" — but the gating
  itself is **not enforced in this module**; every order passes. Tests
  (`exactGarmentMockup.test.ts`) assert this stub behaviour explicitly ("orders are
  always mockup-eligible").

### Header-comment vs implementation divergence (important)

The `garmentReference.ts` header (lines 1–19) and `composite.ts` header (lines 8–11)
both state the primary reference is the **exact catalog image the customer confirmed**
(`source: "catalog-exact"`), with generic templates only for legacy orders. The
**implemented** code has no `catalog-exact` branch at all: modern orders get
`"white-template"` + prompt-driven recolour, and the only two sources actually
returned are `"legacy-template"` and `"white-template"`. The `"catalog-exact"`
union member exists in the type but is never produced. Tests confirm the current
behaviour: `exactGarmentMockup.test.ts` ("the white shirt template (bytes) is what
reaches the AI provider", `referenceSource === "white-template"`, byte-equality
against `polo_front.png` for a `dry_fit_polo` order). Treat AGENTS.md invariant #9's
phrase "deterministic Sharp composite of the customer's confirmed catalog image" as
describing intent that has since been implemented as white-template compositing.

---

## generate.ts vs generateAi.ts vs composite.ts

| | `generate.ts` (legacy) | `composite.ts` (authoritative) | `generateAi.ts` (optional AI) |
|---|---|---|---|
| Input | `(productId, placement, logoBuffer)` — one logo, one placement | `(order, assignments[], logoBuffers[])` | `(order, assignments[], logoBuffers[], provider?)` |
| Base image | Always generic silhouette template from `PRODUCT_SILHOUETTE[productId]` | Resolved per order via `resolveGarmentReference` (white template for modern, generic for legacy) | Same resolution as composite |
| Multi-logo / multi-view | No (returns exactly 1 view) | Yes (one output per distinct view) | Yes (one AI call per distinct view, run in **parallel**) |
| `referenceSource` reported | No | Yes | Yes |
| `costUsd` | No | No | Yes (`number \| undefined`) |
| Empty-assignments guard | n/a | Throws | Throws |
| Pixel-exactness | Yes (same contain-fit math, but without `max(1,…)` guards) | Yes | **No** — generative output |
| Used in production | No — only `tests/mockup.test.ts` and `scripts/test-mockup-generator.ts` import it | Yes — `deliver.ts` default path | Only when explicitly enabled (below) |

`deliver.ts` (lines 85–119) is where the AI exception is enforced at runtime:

```
enableOnlineAi = process.env.ENABLE_ONLINE_AI_MOCKUPS === "true"   // read directly, not via getEnv()
if enableOnlineAi && (OPENAI_API_KEY || GEMINI_API_KEY):
    try  { return generateAiMockups(...) }        // AI result IS the delivered image
    catch{ log + notifyAdminsText("⚠️ AI mockup generation failed … falling back to deterministic proof") }
return generateDeterministicMockups(...)          // default production path
```

So in practice: **deterministic compositing is the always-available fallback and the
production default**; AI runs only when the env flag is flipped *and* a key exists,
and any AI failure degrades gracefully to the deterministic proof with an admin
notification (matching "escalation never fails silently"). One nuance vs invariant
#9's wording: when the flag is on, the AI image replaces the deterministic proof as
the delivered artefact rather than being sent alongside it — the determinstic proof
is authoritative by *default and on failure*, not simultaneously delivered.

`generateAi.ts` specifics:

- `MockupImageProvider` is injectable so tests capture exactly what reaches the
  provider (template bytes + prompt + logos) without a paid API call; defaults to
  `generateMockupImage`.
- Views are generated with `Promise.all` — deliberately **parallel**, because a
  front+back order makes two independent ~30–60 s AI calls and running them
  sequentially can exceed Vercel's `maxDuration` even after raising grammY's webhook
  timeout (comment lines 57–61). This is why slow generation is dispatched to
  `api/mockup-delivery.ts` (120 s `maxDuration`) rather than the webhook handler.
- Per view: read template dimensions via Sharp (throws
  `"Could not read dimensions of the garment reference image for order <id>."` if
  missing), build the prompt with the **actual** pixel dimensions and
  `logoRefOffset = 2`, call the provider with `{ templateImage, logoImages, prompt }`.

---

## Data contracts

```ts
// promptBuilder.ts — one (logo, placement) pair
interface LogoAssignment { logoIndex: number; placement: LogoPlacement }
// LogoPlacement = "left_chest" | "center_front" | "upper_back" | "left_sleeve" | "right_sleeve"

// imageProvider.ts — provider boundary
interface MockupGenerationInput {
  templateImage: Buffer;   // garment reference (front or back view), PNG/JPEG bytes
  logoImages: Buffer[];    // original customer logo bytes, order matches logoIndex
  prompt: string;          // natural-language placement instruction
}
interface MockupGenerationResult { imageBuffer: Buffer; costUsd: number | undefined; model: string }

// generateAi.ts
interface AiMockupResult { view: TemplateView; buffer: Buffer; costUsd?: number; referenceSource: GarmentReferenceSource }

// composite.ts
interface DeterministicMockupResult { view: MockupView; buffer: Buffer; referenceSource: GarmentReferenceSource }

// garmentReference.ts
interface GarmentDescriptor { garmentType: Silhouette; styleLabel?: string; colorName?: string }
type GarmentReferenceSource = "catalog-exact" | "legacy-template" | "white-template"  // "catalog-exact" never produced today
```

Env dependencies (`src/config/env.ts` lines 66–69, 183–186; plus one direct
`process.env` read):

| Var | Where used | Notes |
|---|---|---|
| `MOCKUP_IMAGE_PROVIDER` | `imageProvider.ts` | lowercased; `"gemini"` selects Gemini, **anything else (default `"openai"`) selects OpenAI**. Comment: "OpenRouter is explicitly not used" |
| `MOCKUP_IMAGE_MODEL` | both clients | overrides each client's default model |
| `GEMINI_API_KEY` | `geminiClient.ts` | required for gemini path; throws if absent |
| `OPENAI_API_KEY` | `openaiClient.ts` | env.ts falls back to legacy `OPENAI_API` name; throws if empty |
| `ENABLE_ONLINE_AI_MOCKUPS` | `deliver.ts` line 91 | read via raw `process.env`, not `getEnv()` (minor inconsistency with invariant #4) |

---

## Execution flow

### Deterministic proof (production default)

```
api/mockup-delivery.ts (202 + waitUntil, x-internal-secret gated)
  └─ deliverMockupForOrder(order, deps)
       ├─ deps.compositor ?? defaultCompositor
       │    └─ (AI flag off) generateDeterministicMockups(order, assignments, logoBuffers)
       │         └─ for each view in viewsForAssignments(assignments):
       │              resolveGarmentReference(order, view)   → white/legacy template bytes
       │              compositeView(base, view, assignments, logoBuffers)
       │                 └─ per relevant assignment: contain-fit logo into zone box → overlay
       │              push { view, buffer, referenceSource }
       ├─ upload buffers to Vercel Blob, send to customer via WhatsApp sendMedia
       └─ never throws — returns an outcome so failures escalate to the admin chat
```

### AI visualization (opt-in)

```
defaultCompositor → ENABLE_ONLINE_AI_MOCKUPS==="true" && (OPENAI_API_KEY||GEMINI_API_KEY)
  └─ generateAiMockups(order, assignments, logoBuffers)
       └─ Promise.all(views.map(view =>
            resolveGarmentReference → Sharp metadata (W×H)
            buildMockupPrompt(view, relevantAssignments, W, H, 2, descriptor, printMethod)
            provider({ templateImage, logoImages, prompt })
              imageProvider.generateMockupImage
                ├─ provider==="gemini" → generateGeminiMockup
                └─ else                → generateOpenAiMockup
          ))
  on any throw → log + admin notify → fall through to generateDeterministicMockups
```

---

## AI clients: request/response, retries, errors, cost settings

### imageProvider.ts

Pure dispatch: `getEnv().MOCKUP_IMAGE_PROVIDER`, lowercased; `"gemini"` → Gemini,
otherwise OpenAI (default). No retry, no timeout, no validation.

### geminiClient.ts

- Default model `gemini-3.1-flash-lite` (note: the file header still describes
  "~500 requests/day on gemini-2.5-flash-image / 'Nano Banana' free tier" — the
  header is stale relative to `DEFAULT_MODEL`).
- Endpoint: `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent?key=<GEMINI_API_KEY>`
  — the **API key travels in the URL query string**, so it can leak into error
  messages/logs via the request URL (the thrown HTTP error only includes status +
  body, but any fetch-level logging of the URL would expose it).
- Request body: single `user` role content with `[ {text: prompt}, ...inlineData parts ]`;
  garment template is inline part #1, logos follow (base64, `generationConfig:
  responseModalities: ["IMAGE"]`).
- MIME sniffing: PNG signature (`0x89 0x50`) → `image/png`; JPEG (`0xFF 0xD8`) →
  `image/jpeg`; **everything else (incl. WebP) defaults to `image/png`** —
  `openaiClient.ts` additionally detects WebP, `geminiClient.ts` does not.
- Response handling: non-OK → throw `Gemini image request failed (<status>): <body>`;
  `promptFeedback.blockReason` → throw `Gemini blocked the request: <reason>`;
  no `inlineData` in the first candidate's parts → throw
  `Gemini response did not contain image data (finishReason: <reason>)`.
- Success → `{ imageBuffer: base64-decoded part, costUsd: 0, model }` — cost is
  hard-coded `0` ("free tier; no per-request cost reported by the API").
- **No timeout/AbortController and no retries** — an unresponsive endpoint hangs
  until the platform-level timeout of the calling context.

### openaiClient.ts

- Default model `gpt-image-2.5-flare-2026-09-08`; endpoint
  `https://api.openai.com/v1/images/edits` (multipart form).
- Form: `model`, `prompt`, then `image[]` array-syntax file parts — template as
  reference #1 (`template.png`/`template.jpg`), each logo as `logo_1.*`,
  `logo_2.*` … with per-buffer MIME sniffing (PNG/JPEG/WebP, default PNG).
- **Timeout: 90 s** via `AbortController` (`setTimeout(() => controller.abort(), 90000)`),
  timer cleared both after a successful fetch and in the `catch` (double
  `clearTimeout` is intentional/harmless).
- Response handling: non-OK → throw `OpenAI image edit request failed (<status>): <body>`;
  empty `data[]` → throw; prefers `data[0].b64_json` (decoded to Buffer); falls back
  to downloading `data[0].url` (**the download fetch has no timeout and no auth
  header**); lacks both → throw.
- Success → `{ imageBuffer, costUsd: undefined, model }` — OpenAI cost is **not
  computed anywhere**; `usage.total_tokens` is typed in the response shape but never
  read.
- Missing key → throw `OPENAI_API_KEY (or OPENAI_API) is not configured in environment.`
- **No retries** on either client; a transient 5xx fails the whole view (and, on the
  AI path, the whole generation falls back to deterministic).

### Cost/quota-relevant settings

- Gemini reports `costUsd: 0` (free-tier assumption baked in; header warns Google can
  change the tier without notice). OpenAI reports `undefined`. Neither client
  computes real USD cost — `AiMockupResult.costUsd` is therefore effectively
  informational only today.
- The customer-facing mockup quota (3 free/month, ₹20 after, `MOCKUP_PAID_PRICE_INR`)
  lives in `src/mockup/quota.ts` (out of scope here); `priceBook.ts` also defines
  `MOCKUP_PRICES = { singleView: 10, frontAndBack: 20 }` (legacy pricing constant).
- Parallel view generation means a front+back AI order bills **two** provider calls.

---

## promptBuilder.ts — exact prompt construction

`buildMockupPrompt(view, assignments, templateWidth, templateHeight, logoRefOffset = 2, garment?, printMethod?): string`

Inputs: the view; the assignments (filtered internally to those whose
`PLACEMENT_VIEWS[placement] === view`); the **actual pixel dimensions of the template
image being sent as reference #1** (so pixel boxes are accurate); `logoRefOffset` =
1-based reference-image index of `logoIndex 0` (2, because the template is image #1);
the `GarmentDescriptor`; the `PrintMethod`.

Prompt is built as an array of lines joined with `\n\n`, empty lines filtered out.
Sections, in order:

1. `GARMENT SPECIFICATION: Reference image #1 shows the exact <polo shirt | round-neck t-shirt>[ (the "<styleLabel>" style)] (<front|back view>), exactly <W>x<H> pixels.`
2. `FABRIC TEXTILE: <fabricDescription>` — chosen by `getFabricTextureDescription`:
   - label (lowercased) contains `dry`/`poly`/`active`/`mars` → athletic micro-mesh
     polyester knit ("High-performance athletic micro-mesh…");
   - else `garmentType === "polo"` → honeycomb pique cotton;
   - else → combed ring-spun cotton jersey.
3. Colour instruction:
   - non-white colour → mandate recolouring the whole garment fabric to
     `solid <Name> (hex #<getColorHex(name)>)`, retaining folds/background, "NOT white";
   - white/absent colour → maintain natural studio white (#FFFFFF).
   (`getColorHex` maps ~90 catalog colour names/aliases to vision-extracted hex;
   unknown names return `null` and the hex clause is omitted, not an error.)
4. `PRINTING SPECIFICATION: <textureLanguage>` per `printMethod`:
   `embroidery` → high-density 3D machine embroidery (raised glossy thread stitches);
   `screen_print` → plastisol/water-based matte ink with weave showing through;
   `dtf` → direct-to-film transfer bonded to fibres;
   `sublimation` → dye infused into fibres, zero edge thickness;
   `none`/`not_sure`/undefined → generic "Professional garment print" wording.
5. `STUDIO_LIGHTING_SPEC` — a fixed multi-line constant: 3-point softbox lighting with
   45° key softbox, 5500K daylight-balanced strobes, CRI 98+, 85 mm prime at f/8,
   cyclorama background with contact shadow.
6. `SLEEVE PLACEMENT REQUIREMENT…` — included **only** when the current view has a
   `left_sleeve`/`right_sleeve` assignment (test-asserted: front prompt with
   `left_sleeve` includes it; back prompt with only `upper_back` must not).
7. `TASK: Photorealistic commercial apparel product mockup…`
8. `PHYSICAL PRINT REALISM REQUIREMENTS` — fabric deformation with folds, matching
   studio lighting/shadows ("must not look like a flat sticker"), tactile print
   surface finish.
9. Per-assignment placement lines:
   `- Logo reference image #<logoRefOffset + logoIndex>: print it on <PLACEMENT_DESCRIPTIONS[placement]>. In the <W>x<H>px output image, position the logo centered at pixel coordinate (<centerX>, <centerY>) measured from the top-left corner, scaled to fit within approximately <boxW>px wide by <boxH>px tall while strictly preserving its original aspect ratio. Only the graphic elements of the logo should be printed onto the garment — never print a bounding box, background rectangle, card, outline, or guide marks.`
   where the box comes from `zoneToPixelBox` (same `round()` math as the compositor:
   `left = round(x·W)`, `top = round(y·H)`, `w = round(width·W)`, `h = round(height·H)`,
   `centerX = round(left + w/2)`, `centerY = round(top + h/2)`). The
   `PLACEMENT_DESCRIPTIONS` map includes the mirrored-sleeve clarifier ("…appears on
   the RIGHT side of a front-facing photo" for the left sleeve).
10. `PRESERVATION RULES` — preserve cut/collar/seams/framing/background; colour line
    (white vs coloured); reproduce logo colours/typography exactly; no white
    square/border behind the logo.
11. `Output a single, high-definition, commercial e-commerce product photograph, exactly <W>x<H> pixels.`

A documented consistency fix in the header (lines 11–23): the phrase **"ghost
mannequin" was removed** because the model literally rendered a translucent
ghost-shaped figure; the prompt now frames generation as a minimal edit of the
existing template photo. The header also concedes generative models regenerate the
whole frame, so no provider guarantees pixel-exact preservation outside the logo —
hence the deterministic fallback.

### Test coverage (promptBuilder.test.ts + exactGarmentMockup.test.ts)

- `getColorHex` spot-checks 10 vision-extracted values (Navy Blue → `202335`, Black →
  `212126`, Rama Blue → `22456C`, Royal Blue → `324EB0`, Bottle Green → `213C3E`,
  Maroon → `8C1924`, Mustard → `DAA248`, Grey Melange → `B6BEC7`, Siemens Green →
  `4BDDCB`, Apple Green → `78AA9C`).
- Studio-lighting constants present verbatim (5500K, 85 mm f/8, cyclorama, 3-point
  softbox), `solid Navy Blue (hex #202335)` present for a Navy polo with embroidery;
  embroidery texture string present.
- White garments produce no logical contradiction: prompt must **not** contain
  `"solid white, NOT white"`, must contain the "maintain … studio white" phrasings.
- Fabric texture adapts: "UF 008" polo → honeycomb pique; "Finch Active Mars Dry
  Fit" round neck → athletic micro-mesh (via the `mars`/`active` label keywords);
  "Finch Bio Wash Cotton" → ring-spun cotton jersey.
- Sleeve instruction isolated to the correct view.
- Through the AI pipeline: the prompt weaves the catalog `itemLabel` ("Cotton Polo
  (UF 008)") and colour name ("Navy Blue") — asserted in
  `exactGarmentMockup.test.ts` ("brand/style/colour from the selection are woven into
  the prompt").

---

## Error handling

| Failure | Behaviour |
|---|---|
| Empty `assignments` | `composite.ts` / `generateAi.ts` both throw `"At least one logo assignment is required."` |
| Garment reference unreadable dimensions | composite: `"Could not read garment reference image dimensions…"`; generateAi: `"Could not read dimensions of the garment reference image for order <id>."` |
| Logo buffer index out of range / undecodable | Sharp throws on `sharp(logoBuffers[a.logoIndex])` — no explicit validation upstream in these modules (validation happens earlier in `deliver.ts`: ≤4 logos, ≤8 MB, jpeg/png/webp, 3/day) |
| Legacy template file missing on disk | `fs.readFileSync` throws synchronously inside `resolveGarmentReference` |
| Gemini missing key | throws `"GEMINI_API_KEY is not configured; Gemini mockup generation is disabled."` |
| Gemini HTTP error / safety block / no image part | throws with status+body / blockReason / finishReason respectively |
| OpenAI missing key | throws `"OPENAI_API_KEY (or OPENAI_API) is not configured in environment."` |
| OpenAI HTTP error / empty data / no b64+url / URL download failure | throws; 90 s AbortController converts a hang into an abort error |
| Any AI-path throw in production | caught in `deliver.ts` defaultCompositor → logged, admins notified via `notifyAdminsText` (failure of the notify itself swallowed with `.catch(() => {})`), then **falls back to `generateDeterministicMockups`** |
| Deterministic-path throw | `deliverMockupForOrder` never throws — returns an outcome; `api/mockup-delivery.ts` escalates skip/failure to the admin chat (invariant #3 analogue) |

---

## Risks & observations

1. **Doc-vs-code divergence on the "exact garment" base.** `composite.ts`,
   `garmentReference.ts` headers and AGENTS.md invariant #9 describe compositing onto
   the customer's *confirmed catalog image* (`source: "catalog-exact"`); the
   implementation always uses white/generic templates and recolours via prompt. The
   `"catalog-exact"` union member is dead. Anyone trusting the comments could assume
   colour/fit fidelity the pipeline does not actually provide — e.g. the deterministic
   proof for a "Navy Blue" polo is a **white** polo with a blue logo, not a navy polo.
2. **`isMockupEligible` is a stub returning `true`.** The `mockupEligible` flag on
   `CatalogSelection` and the "exact preview unavailable" flow described in comments
   are not enforced in this module; every order gets a template-based mockup.
3. **`ENABLE_ONLINE_AI_MOCKUPS` is read via raw `process.env`** in `deliver.ts`
   rather than `getEnv()` — inconsistent with invariant #4 (env validated once,
   fail-fast) and invisible to the env validation layer.
4. **When the AI flag is on, AI output replaces the deterministic proof** as the
   delivered image (with fallback on error). If "the proof remains authoritative"
   is meant absolutely, `deliver.ts` currently deviates from it under that flag.
5. **Gemini client has no timeout and no retries.** OpenAI has a 90 s timeout but
   also no retries. A slow Gemini call burns the calling context's wall-clock (the
   delivery worker's 120 s budget) — and front+back makes two parallel calls, so a
   single hung call still risks the budget.
6. **Gemini API key in URL query string** — leaks into any URL-level logging; consider
   `x-goog-api-key` header if hardening.
7. **MIME sniffing asymmetry:** `openaiClient` detects WebP, `geminiClient` does not
   and labels unknown formats `image/png`; a WebP logo sent to Gemini would be sent
   with a wrong MIME hint (inlineData may be rejected or mis-decoded).
8. **`generate.ts` is legacy but live.** Not used by the delivery pipeline, yet still
   imported by `tests/mockup.test.ts` and `scripts/test-mockup-generator.ts`. Its
   zone math lacks the `Math.max(1, …)` guards of `composite.ts` and it uses
   non-null assertions on template metadata (`templateMeta.width!`) — a missing
   dimension would produce NaN overlay coordinates instead of a clean error.
9. **Scaling edge cases in the contain-fit:** non-square logos are transparent-padded
   and appear smaller than the zone box (fills the shorter dimension only) — e.g. a
   very wide banner logo in `left_chest`'s square 0.15×0.15 zone renders short. Zone
   boxes are computed with `Math.round`, so on odd-sized images adjacent zones can be
   off-by-one pixel vs the prompt's stated coordinates (both sides use the same
   formula, so they agree with each other, but the base image's own content was never
   designed against these exact pixel values — zones are generic percentages).
10. **AI cost is untracked.** `costUsd` is `0` (Gemini) or `undefined` (OpenAI);
    `usage.total_tokens` is parsed-but-ignored. Any cost accounting against the ₹20
    paid-mockup quota cannot currently rely on these values.
11. **Free-tier fragility.** The Gemini free-tier assumption ("~500 requests/day, no
    credit card, can change without notice") is baked into the module header; a tier
    change turns every AI mockup into a failure (mitigated by the deterministic
    fallback + admin alert).
12. **Stale comments elsewhere:** `geminiClient.ts` header still references
    `openrouterClient.ts` and a `gemini-2.5-flash-image` model while
    `DEFAULT_MODEL` is `gemini-3.1-flash-lite`; AGENTS.md's `src/mockup/` tree lists
    `openrouterClient` while the repo has `openaiClient.ts`. Keep docs in sync when
    touching this area.
13. **Sleeve zones sit at the extreme image edges** (x 0.08 and 0.78 with width 0.14,
    i.e. right edge at 0.92) — if a template photo's sleeves are cropped differently
    than the assumed 1024×1024 studio framing, sleeve logos can land off-garment.
    The zones are tuned to the four shipped templates, not computed per-image.
