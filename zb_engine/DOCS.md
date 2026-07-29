# ZerryBit Engine — Documentation

**Version 0.1.2**

> **Note.** For the builder SPA API, see [`BUILDER_API.md`](BUILDER_API.md).
> Port `8000` is read-only (image serving for ESP32 devices). All write
> operations use port `8099` (HA Ingress).

---

## Overview

ZerryBit Engine (v0.1.2) is a self-contained TypeScript rendering pipeline
built into a Home Assistant Add-on. It accepts a declarative JSON payload,
optionally fetches live data from HA entities and external APIs, and renders a
1-bit dithered image for E-ink displays (ESP32 and similar devices). Includes a
built-in Widget Builder SPA for visual dashboard design — everything runs
locally.

---

## 1. Dual-Port System Architecture

### Port 8099 (Ingress)

Serves the Widget Builder SPA (the default view at `/`), the management panel at
`/panel/`, and all entity/widget APIs. Access is proxied and authenticated by
Home Assistant.

```text
GET http://<your-ha-ip>:8099/          # Widget Builder SPA — default view
GET http://<your-ha-ip>:8099/panel/    # Management panel
GET http://<your-ha-ip>:8099/builder/  # Widget Builder SPA
```

### Port 8000 (Static side-door)

Provides a constant, unauthenticated URL for ESP32 devices.

```text
GET  http://<your-ha-ip>:8000/image.png   # PNG preview
POST http://<your-ha-ip>:8000/image.bin   # framed 1-bit device reply
```

---

## 2. Directory Structure

```text
/zb_engine/
  ├── config.yaml           (Add-on manifest, port mapping)
  ├── Dockerfile            (Multi-stage build: builder+server+runner)
  ├── package.json          (Dependencies: Express, Sharp, Zod)
  ├── tsconfig.json         (TypeScript config, src/ -> dist/)
  ├── vitest.config.ts      (Server test config)
  ├── payload.json          (Active render config for ESP32 GETs)
  ├── fonts/latin/          (Sora bitmap font JSON files)
  ├── public/               (Static HTML assets)
  │   └── index.html        (Management panel — self-contained, inline styles)
  ├── src/                  (TypeScript source)
  │   ├── limits.ts         (Shared payload/render limits)
  │   ├── core/             (Platform-agnostic server core)
  │   │   ├── adapters.ts       (StorageAdapter + PlatformAdapter interfaces)
  │   │   ├── server.ts         (Express app factory — all routes)
  │   │   ├── renderService.ts  (Render pipeline + RenderGuard mutex)
  │   │   ├── widgetService.ts  (Widget CRUD handlers)
  │   │   └── rateLimiter.ts    (Rate-limiting middleware)
  │   ├── ha/               (Home Assistant adapter)
  │   │   ├── index.ts          (HA entrypoint, dual-port startup)
  │   │   ├── haStorage.ts      (Filesystem + writeIfChanged)
  │   │   ├── haEntities.ts     (Entity & history proxy routes)
  │   │   ├── haNetwork.ts      (Host LAN IP route — /api/host-ip)
  │   │   ├── haSources.ts      (haState + haHistory source handlers)
  │   │   └── haOptions.ts      (/data/options.json loader)
  │   ├── schema/           (Zod schemas)
  │   │   ├── payloadSchema.ts  (Top-level payload validation)
  │   │   ├── elementSchema.ts  (Element type schemas)
  │   │   └── sourceSchema.ts   (Source config schemas)
  │   ├── data/             (Data layer)
  │   │   ├── sourceFetcher.ts      (HTTP source fetcher)
  │   │   ├── dataFieldExtractor.ts (Dot-path field extraction)
  │   │   ├── featureResolver.ts    (Feature variable resolution)
  │   │   ├── textAutoSize.ts       (Auto-sizing text helper)
  │   │   ├── urlValidator.ts       (SSRF protection)
  │   │   └── graph/                (Graph element expansion)
  │   │       ├── normalizer.ts     (Data normalization)
  │   │       ├── layout.ts         (Graph layout calculations)
  │   │       ├── axisBuilder.ts    (Axis element generation)
  │   │       ├── expander.ts       (Graph -> primitive expansion)
  │   │       ├── types.ts          (Graph type definitions)
  │   │       └── charts/           (Chart type renderers)
  │   │           ├── lineChart.ts
  │   │           └── barChart.ts
  │   ├── expressions/      (Re-export shims -> @zb/expressions; kept only
  │   │   │                  because the frozen src/engine/ imports from here.
  │   │   │                  Canonical engine lives in packages/ — see below)
  │   │   ├── bindingResolver.ts    ($ binding resolution)
  │   │   └── context.ts            (Data context builder)
  │   ├── engine/           (Render engine — FROZEN, do not modify)
  │   │   ├── primitives/   (rect, circle, line, text, img, svg, group)
  │   │   └── fonts/        (Font loader, glyph renderer)
  │   ├── encoder/          (Output encoders)
  │   │   ├── pngEncoder.ts (PNG output)
  │   │   └── binEncoder.ts (1-bit binary output)
  │   └── errors/           (Error types)
  │       ├── sourceError.ts
  │       ├── renderError.ts
  │       └── httpError.ts
  ├── builder/              (Widget Builder SPA — React/Vite)
  │   ├── package.json      (Builder dependencies)
  │   ├── vite.config.js    (Vite build config, base: './')
  │   ├── vitest.config.js  (Builder test config)
  │   └── src/
  │       ├── App.jsx        (Root layout)
  │       ├── main.jsx       (React entry point)
  │       ├── limits.js      (Shared limits — mirrored from server)
  │       ├── index.css      (Global styles)
  │       ├── theme.css      (Accent theme)
  │       ├── store/         (Zustand state management)
  │       │   ├── docStore.js           (Document state — single source of truth)
  │       │   ├── uiStore.js            (UI interaction state)
  │       │   └── displayConfigStore.js (Display settings)
  │       ├── models/        (Document model & defaults)
  │       │   ├── document.js       (Document structure)
  │       │   ├── elementDefaults.js (Element type defaults)
  │       │   └── mapper.js         (Import/export serialization)
  │       ├── editor/        (Konva canvas & tools)
  │       │   ├── CanvasArea.jsx    (Main canvas)
  │       │   ├── CanvasToolbox.jsx (Tool palette)
  │       │   ├── GraphPreview.jsx  (Graph overlay)
  │       │   └── PreviewOverlay.jsx(Preview layer)
  │       ├── panels/        (UI panels)
  │       │   ├── LeftPanel.jsx         (Element tree + tabs)
  │       │   ├── RightPanel.jsx        (Inspector container)
  │       │   ├── InspectorPanel.jsx    (Property inspector)
  │       │   ├── GraphInspectorPanel.jsx (Graph properties)
  │       │   ├── SettingsPanel.jsx     (Canvas settings)
  │       │   ├── SourcesPanel.jsx      (Source editor)
  │       │   ├── FeaturesPanel.jsx     (Feature variables)
  │       │   ├── DataExplorerPanel.jsx (Live data browser)
  │       │   └── PreviewTab.jsx        (Preview panel)
  │       ├── components/    (Shared UI components)
  │       │   ├── BindingExpressionEditor.jsx (Binding/expression UI)
  │       │   ├── AssetPickerModal.jsx  (Asset upload/picker)
  │       │   ├── BitmapText.jsx        (Canvas text preview)
  │       │   ├── ConfirmModal.jsx      (Confirm dialog)
  │       │   ├── DataTree.jsx          (Data tree view)
  │       │   ├── GridSizeSelector.jsx  (Grid settings)
  │       │   ├── IconPickerModal.jsx   (Icon browser)
  │       │   ├── ImagePreview.jsx      (Image preview)
  │       │   ├── InspectorFields.jsx   (Inspector field widgets)
  │       │   ├── PanelResizeHandle.jsx (Resizable panels)
  │       │   ├── TablerIcon.jsx        (Tabler icon component)
  │       │   ├── Tabs.jsx             (Tab bar)
  │       │   └── ValueEditor.jsx       (Value input)
  │       ├── platform/      (HA integration layer)
  │       │   ├── apiClient.js      (API client + Ingress detection)
  │       │   ├── widgetStore.js    (Widget persistence store)
  │       │   ├── autoSaveStore.js  (Auto-save logic)
  │       │   ├── entityStore.js    (Entity state cache)
  │       │   ├── useAutoSave.js    (Auto-save hook)
  │       │   ├── TopBar.jsx        (Widget selector + actions)
  │       │   ├── WelcomeScreen.jsx (First-run welcome)
  │       │   ├── EntityBrowser.jsx (Entity picker)
  │       │   ├── HaStateSourceFields.jsx  (haState config fields)
  │       │   └── HaHistorySourceFields.jsx(haHistory config fields)
  │       └── utils/         (Shared utilities)
  │           ├── expressionContext.js (Expression context builder)
  │           ├── bitmapFont.js    (Font rendering)
  │           ├── fontCatalog.js   (Font catalog)
  │           ├── iconRegistry.js  (Icon registry)
  │           ├── tablerCatalog.js (Tabler icon catalog)
  │           ├── ids.js           (ID generation)
  │           ├── names.js         (Name generation)
  │           └── snapping.js      (Grid snapping)
  ├── packages/             (Shared npm workspace packages)
  │   └── zb-expressions/   (Canonical binding/expression engine — @zb/expressions)
  │       ├── package.json  (Dual CJS/ESM build; consumed by server + builder)
  │       └── src/
  │           ├── index.ts             (Public API barrel)
  │           ├── bindingResolver.ts   ($ binding resolution)
  │           ├── expressionEvaluator.ts (if/math expression eval)
  │           ├── context.ts           (Data context builder)
  │           ├── constants.ts         (Shared BLOCKED_KEYS)
  │           ├── budget.ts            (Expression evaluation budget)
  │           └── pipeSyntax.ts        (Pipe-syntax parsing)
  └── dist/                 (Compiled JS output — do not edit)
```

---

## 3. API Endpoints

### Port 8000 — unauthenticated, ESP32-facing, read-only

> **LAN trust assumption.** Port 8000 has no authentication — it is intended for
> ESP32 devices that cannot speak HA's auth protocol. The **operator** is
> responsible for keeping it on a trusted LAN (do **not** port-forward, do
> **not** expose via reverse proxy without an auth shim). The add-on adds three
> safeguards:
>
> 1. **Per-slot cooldown** (`image_port_cooldown_ms`, default 4000 ms). A burst
>    of GETs from a single client triggers at most one render per slot per
>    cooldown window.
> 2. **Conditional GET** (`If-None-Match` / `304`). Every response carries a
>    strong ETag (sha1 over the body). A polling client that already holds the
>    bytes gets a `304` without driving a render.
> 3. **Cache-only mode** (`image_port_mode: cache-only`). When set, port 8000
>    **never** drives a render — it only serves whatever the Ingress UI /
>    periodic re-render timer has produced. Use this when the LAN side cannot be
>    fully trusted.

#### Data & credential storage

Widgets, uploaded assets, and the deployed payload live on the HA persistent
volume under `/data` (`/data/widgets`, `/data/assets`).

Data-source authentication — bearer tokens, API keys, basic-auth passwords — is
stored **in plaintext** inside the widget JSON so the add-on can replay the
source fetch when it renders. Anyone with host or volume access can read these
files. The add-on masks these secrets when a widget is read back over the panel
API (`GET /api/widgets/:id`, `GET /payload`) and restores them on save, so one
panel user cannot read another's stored credentials — but the values are **not**
encrypted at rest. Treat the HA host as the trust boundary and prefer scoped /
read-only API keys for data sources.

Storage is bounded: widgets and assets are capped by count and total bytes, so a
client cannot exhaust the `/data` volume. The container runs as a non-root user
(su-exec privilege drop) under an AppArmor profile (`apparmor.txt`) applied
automatically by the Supervisor.

#### Endpoints

**`GET :8000/image.png`**
Serves the cached PNG written on the last deploy or the most recent on-demand
render. Returns `503` if no payload has been deployed yet. `Cache-Control:
no-cache`. Sends ETag; honors `If-None-Match` with `304`.

**`POST :8000/image.bin`**
Returns the ESP32 self-host **framed reply**: a 25-byte header (magic,
dimensions, placement, refresh flags, next-wake, payload length, and a
big-endian sidebar clock) followed by the 1-bit image. Image bytes are
MSB-first, 8 pixels/byte, row-major, with bit polarity matched to the ESP32
wire format (`1` = white). Total size = `25 + ceil(width/8) * height` bytes.
Returns `503` if no payload has been deployed yet. `Cache-Control: no-cache`.
The request body is ignored, and — because the live clock makes every reply
unique — there is no ETag / conditional-request path on this endpoint.

**`GET :8000/image_fullscreen.png`**
**`POST :8000/image_fullscreen.bin`**
Same shape as the primary endpoints, but for the fullscreen companion slot.
Independent buffer and cooldown.

### Port 8099 — authenticated via HA Ingress session

**`GET :8099/`**
Widget Builder SPA — the default add-on view.

**`GET :8099/panel/`**
Management panel — entity picker, preview, ESP32 setup.

**`GET :8099/builder/`**
Widget Builder SPA — visual dashboard designer.

**`GET :8099/api/widgets`**
List all saved widgets (metadata: `id`, `name`, `updatedAt`).

**`GET :8099/api/widgets/new-id`**
Generate a unique widget ID.

**`GET :8099/api/widgets/:id`**
Load a widget document by ID.

**`PUT :8099/api/widgets/:id`**
Save or overwrite a widget (Zod-validated body).

**`DELETE :8099/api/widgets/:id`**
Delete a widget by ID.

**`GET :8099/api/fonts`**
List available bitmap font files.

**`GET :8099/api/fonts/:filename`**
Serve a single font JSON file (immutable cache).

**`GET :8099/payload`**
Returns the current `payload.json` contents (read-only).

**`PUT :8099/payload`**
Deploy a new payload from the widget builder. Saves `payload.json`, renders,
writes `image.png` + `image.bin`.

- Returns: `{ ok, name, width, height, renderTimeMs, sourceErrors[], renderErrors[] }`
- Optional warning headers on partial failures:
  - `X-Source-Errors`: base64-encoded JSON string array
  - `X-Render-Errors`: base64-encoded JSON string array
- Note: `409` if a render is already in progress.

**`POST :8099/render`**
Accepts a full JSON payload in the request body. Returns the rendered image (PNG
or BIN per `misc.format`). Does **not** update cached files. Useful for one-off
tests and builder preview.

**`POST :8099/render/expand`**
Accepts a JSON body with graph elements and returns the expanded primitive
elements (line, rect, text, circle). Used by the builder for client-side graph
preview.

**`POST :8099/render/test-source`**
Test a single source configuration. Fetches the source and returns the extracted
data. Rate-limited. Used by the builder's source editor "Test" button.

**`POST :8099/export`**
Accepts a JSON object body of selected entity data. Stores it in memory with a
crypto-random token (5-minute TTL).

- Returns: `{ token, expiresIn }`
- The sidebar navigates to `./builder/?export=TOKEN`.

**`GET :8099/export/:token`**
Redeem a temporary export token created by the sidebar. Token must be a
32-character hex string. Token is single-use (deleted after fetch) and expires
after 5 minutes. Returns `400` if malformed, `404` if not found, `410` if
expired.

**`GET :8099/api/host-ip`**
Returns the host's best-guess LAN IPv4 address, read from the Supervisor
`/network/info` endpoint, so the builder's Settings tab can show ESP32 devices a
reachable `http://<ip>:8000/image.bin` URL (devices cannot resolve the
`homeassistant.local` mDNS name). Requires `hassio_api: true`.

- Returns: `{ ip: string|null, candidates: [{ interface, ip, primary }] }`
- Loopback, Docker, link-local, and VPN/tunnel interfaces are excluded; the
  primary interface is preferred. Rate-limited under the shared Supervisor-proxy
  budget.

**`GET :8099/entities`**
Proxies the full HA entity list from the Supervisor API. Used by the sidebar
entity picker and builder.

**`GET :8099/history?entity_ids=COMMA_LIST&hours=N`**
Batch-fetches state history for the given entity IDs. `hours`: 1–168 (default
24).

- Returns a map of `entity_id -> HaHistoryResult`:
  `{ points[], min, max, avg, latest, latestState, count, hoursBack, entity_id }`
- `points` entries: `{ t (Unix ms), v (number|null), s (string) }`

**`GET :8099/image.png`**
Returns the last rendered PNG. Useful for builder preview. `Cache-Control:
no-cache, no-store, must-revalidate`.

---

## 4. Payload Structure

Every render is driven by a JSON payload with four sections:

```jsonc
{
  "misc":     { ... },  // Canvas size, format, metadata
  "features": { ... },  // User-defined variables
  "sources":  [ ... ],  // HTTP data sources (fetched in parallel)
  "elements": [ ... ]   // Drawing commands (index 0 = bottom layer)
}
```

### `misc` (required)

- `size.width` / `size.height` — canvas dimensions in pixels (max 4096 each)
- `format` — `"png"` (default) or `"bin"`
- `name`, `type`, `gridSize`, `tags` — optional metadata

### `features`

Flat key-value map. Resolved **before** sources so they can drive source URLs
and query parameters.

Example: `{ "city": "Helsinki", "showBorder": true }`

### `sources` (`kind: "http"` or omitted)

Each source fetches one HTTP endpoint and exposes named fields to the drawing
phase via dot-path extraction.

- Supported response types: `json`, `xml`, `csv`, `text`
- Auth types: `none`, `apiKey`, `bearer`, `basic`
- Fields fall back to `defaultValue` if the source fails.
- Note: source URLs must be public (RFC1918 blocked).
- Max 500 sources per payload. Per-source timeout: 10s. Past 50 the builder
  warns once that a pool this large can slow saves and refreshes on low-power
  hardware.

### HA state sources (`kind: "haState"`)

Fetches the current state snapshot of one HA entity. Use for live readings,
binary states, attribute values.

**Required fields:**

- `entity_id` — HA entity, e.g. `sensor.living_room_temp`

**Optional fields:**

- `attribute` — promotes this attribute to state/value

**Data context** exposed as `{sourceId.*}`:

- `state` — raw state string (`"23.5"`, `"on"`, ...)
- `value` — numeric parse of state, or `null`
- `attributes.<key>` — any HA attribute
- `last_changed` — ISO timestamp of last state change
- `last_updated` — ISO timestamp of last update

**Example:**

```json
{ "id": "temp", "kind": "haState",
  "entity_id": "sensor.living_room_temperature" }
```

Binding: `"{{temp.state}}°C"` or `"{{temp.value}}"`

### HA history sources (`kind: "haHistory"`)

Fetches state history directly from the HA Supervisor API at render time using
`SUPERVISOR_TOKEN` internally. No URL field — RFC1918 restrictions do not apply.

**Required fields:**

- `entity_id` — HA entity to read, e.g. `sensor.living_room_temperature`
- `hoursBack` — window size in hours (1–168, default 24)

**Data context** exposed as `{sourceId.*}`:

- `latest` — most recent numeric value
- `latestState` — most recent raw state string
- `min` / `max` — range across the window
- `avg` — mean (rounded to 2 dp)
- `count` — number of data points
- `points` — array `[{t, v, s}]` oldest -> newest; `t` = Unix ms,
  `v` = number|null, `s` = string. `v` is null for non-numeric states such as
  `"unavailable"` (use for graph gaps).

**Example:**

```json
{ "id": "temp", "kind": "haHistory",
  "entity_id": "sensor.temperature",
  "hoursBack": 10 }
```

- Binding: `"{{temp.latest}}°C"`
- Graph: use `temp.points` array in a graph element.

### `elements`

- Supported types: `rect`, `circle`, `line`, `text`, `img`, `svg`, `group`
- All types support: `pos`, `rotationDeg`, `scale`, `origin`, `opacity`, `visible`
- Drawn in order — first element is the bottom layer.

---

## 5. Bindings & Expressions

Any field in elements or sources can be a dynamic value:

```jsonc
{ "$": "weather.temperature" }              // read from context
{ "$": "features.city", "default": "-" }    // with fallback
{ "if": [{ "==": [{"$":"x"}, "Rain"] }, 100, 0] }
{ "if": [{ "!=": [{"$":"x"}, "ok"]   }, 100, 0] }
{ "if": [{ ">":  [{"$":"x"}, 20]     }, 100, 0] }
{ "if": [{ "<":  [{"$":"x"}, 0]      }, 100, 0] }
{ "if": [{ ">=": [{"$":"x"}, 90]     }, 100, 0] }
{ "if": [{ "<=": [{"$":"x"}, 10]     }, 100, 0] }
{ "+": [{ "$": "weather.temp" }, 5] }       // math (+, -, *, /)
"Temp: {{weather.temperature}}°C"           // string interpolation
```

**Available context roots:**

- `misc.*` — canvas metadata
- `features.*` — user variables
- `[sourceId].*` — extracted data fields

---

## 6. Fill & Dithering

The canvas is strictly 1-bit. Shading is simulated with Bayer 8×8 ordered
dithering.

- `fill: 0` — all white
- `fill: 100` — solid black
- `fill: 50` — 50% dither pattern (checkerboard-like)

`strokeDither` works the same way for outlines. `opacity` applies a separate
dither mask for transparency — pixels behind the element show through the
pattern.

---

## 7. Font System

Pre-rasterized Sora bitmap fonts. No runtime rendering.

Weights: Light (300), Regular (400), SemiBold (600).

Not every size × weight combination ships. Available files:

| Size  | Light (300) | Regular (400) | SemiBold (600) |
|:-----:|:-----------:|:-------------:|:--------------:|
| 10 px |             |       ✓       |                |
| 12 px |      ✓      |               |        ✓       |
| 16 px |      ✓      |       ✓       |        ✓       |
| 20 px |      ✓      |       ✓       |        ✓       |
| 26 px |             |       ✓       |                |
| 34 px |             |       ✓       |        ✓       |
| 44 px |      ✓      |       ✓       |                |
| 56 px |      ✓      |       ✓       |        ✓       |

The engine snaps `fontSize` and `fontWeight` to the nearest available variant
automatically. Examples: 14px snaps to 12px; a 12px Regular request snaps to
12px Light.

---

## 8. Error Handling

Errors are collected, not thrown. The image always renders.

| Condition | Behavior |
|-----------|----------|
| Source fails | Fields use `defaultValue`; reported in `X-Source-Errors` header |
| Element fails | Element is skipped; reported in `X-Render-Errors` header |
| Timeout (30s pipeline, 10s per source) | `500` response |

---

## 9. Troubleshooting

**`Dockerfile is missing` (Supervisor Logs)**
- **Cause:** Files moved while HA was running.
- **Fix:** Run `ha supervisor reload`, then reinstall the add-on.

**`image.png` returns 500**
- **Cause:** `payload.json` is missing or contains invalid JSON.
- **Fix:** Check `payload.json` exists in the add-on root and is valid JSON with
  `misc.size.width`/`height` defined.

**Text not rendering / wrong size**
- **Cause:** Requested `fontSize` has no exact match.
- **Fix:** Engine snaps to nearest size. Available sizes: 10, 12, 16, 20, 26, 34,
  44, 56 px. Note: 14px snaps to 12px. 12px Regular snaps to Light.

**`image.bin` wrong size**
- **Cause:** The `POST` reply is framed — a 25-byte header precedes the image —
  and each row's width is padded up to a byte boundary.
- **Fix:** Expected size = `25 + ceil(width/8) * height` bytes. For 200×200:
  `25 + ceil(200/8)*200 = 25 + 5000 = 5025` bytes.

---

## 10. Development

```bash
# Server
npm install              # install server dependencies
npm run build            # build @zb/expressions + compile src/ to dist/

# Builder (separate terminal)
cd builder && npm install  # install builder dependencies
npm run dev                # Vite dev server on :5173

# Tests
npx vitest run             # run server tests (from root)
cd builder && npx vitest run  # run builder tests
```

- Ports: 8099 (ingress UI + builder), 8000 (ESP32 endpoint)
- Fonts: loaded from `fonts/latin/` at startup
- Payload: edit `payload.json`, then hit `/image.png`
