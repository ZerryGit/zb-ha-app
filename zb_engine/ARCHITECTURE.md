# ARCHITECTURE

This document describes the structural boundaries, platform seam, and build pipeline for ZerryBit Engine.
For engineering constraints and security requirements, see `ENGINEERING_CONSTRAINTS.md`.
For the builder's docStore data model and save pipeline, see `builder/src/store/STORE_ARCHITECTURE.md`.


## Server Structure

```
src/
  core/          Platform-agnostic server (Express factory, widgetService, renderService, adapters)
  ha/            Home Assistant adapter (filesystem storage, Supervisor proxy, Ingress auth)
  engine/        FROZEN render core — stable, do not modify (see ENGINEERING_CONSTRAINTS.md §1)
  data/          Data fetching, feature resolution, URL validation
  encoder/       PNG / binary encoding
  expressions/   Compatibility shims that re-export from @zb/expressions
                 (frozen src/engine/ imports from here; see Expression Engine — Shared Package)
  errors/        Error types
  schema/        Zod schemas
```

**Import rules:**
- `src/core/` MUST NOT import from `src/ha/` or reference any HA-specific concept.
- `src/ha/` implements `StorageAdapter` + `PlatformAdapter` from `src/core/adapters.ts`.
- `src/data/`, `src/encoder/`, `src/expressions/`, `src/errors/`, `src/schema/` are shared generic modules — MUST NOT import from `src/ha/`.
- `src/engine/` is frozen. See ENGINEERING_CONSTRAINTS.md §1.

**Known engine exception (audited & accepted):**
`src/engine/fonts/fontManager.ts` carries ~30 lines of font-weight fallback logic that predates the freeze policy. Accepted as-is; no further changes permitted.


## Builder Structure

```
builder/src/
  models/        Data model (mapper.js — export/import, ELEMENT_KNOWN_KEYS)
  store/         Core Zustand+Immer stores (docStore, uiStore, displayConfigStore)
  editor/        Canvas (CanvasArea.jsx with Konva), selection, drag, resize
  components/    Shared UI components (ConfirmModal, InspectorFields, AssetPickerModal, BindingExpressionEditor, DataTree, ValueEditor, etc.)
  panels/        Panel layouts
  utils/         Pure utility functions
  data/          Generated asset data (tabler-icons.json)
  platform/      HA integration layer — see Platform Seam below for full file list
```

**Import rules:**
- `models/`, `store/`, `editor/`, `components/`, `panels/`, `utils/` are the **core**. They MUST NOT import from `platform/`, call `fetch()`, or reference HA APIs.
- `platform/` imports FROM core. Core MUST NEVER import from `platform/`.
- The core IS allowed to evolve (new element types, panels, editor features, refactors) — the restriction is on platform coupling, not on change.
- `builder/dist/` is compiled output. NEVER edit directly.


## Core ↔ Platform Data Flow

Core components get platform-provided data or actions through exactly three patterns:

1. **Callback props** — Platform passes handler functions (e.g., `onTestSource`, `onDelete`) as props. Core calls them without knowing the implementation.
2. **Store injection** — Platform populates a Zustand store (e.g., `widgetStore`) that core reads. The store and its async actions live in `platform/`.
3. **Composition** — Platform wraps core components (e.g., `TopBar` wraps `docStore` export + `apiClient.save()`). Core is unaware of the wrapping.

The core MUST function as a standalone editor (canvas, inspector, panels) with no server connection. Persistence, preview rendering, and deployment are platform concerns.


## Platform Seam — Server

Interfaces: `StorageAdapter` and `PlatformAdapter` in `src/core/adapters.ts`.

To create a new platform (e.g., cloud):
1. Create `src/cloud/` alongside `src/ha/`.
2. Implement `StorageAdapter` (S3, PostgreSQL instead of filesystem).
3. Implement `PlatformAdapter` (OAuth instead of Ingress session).
4. Create an entrypoint calling the same `createIngressApp()` from `src/core/server.ts`.

**Unchanged:** `src/core/`, `src/engine/`, `src/data/`, `src/encoder/`, `src/expressions/`, `src/errors/`, `src/schema/`.
**Replaced:** Everything in `src/ha/`.


## Adapter Startup Configuration

Platform entrypoints must wire shared configuration before calling `createIngressApp()`.
The HA adapter (`src/ha/index.ts`) performs the following startup sequence:

1. **`configureUrlValidator(domains)`** — From `src/data/urlValidator.ts`. Sets the domain allowlist for SSRF protection.
2. **`configureBlockedHostnames(hostnames)`** — From `src/data/urlValidator.ts`. Merges platform-specific blocked hostnames (e.g., `supervisor`, `hassio`, `homeassistant`) with the core default (`localhost`).
3. **`createIngressApp(adapter)`** — From `src/core/server.ts`. Builds the Express app with all routes wired.

Both URL validator configurations must happen before `app.listen()`. A new platform adapter must call steps 1–2 with its own values before step 3.


## Runtime Boundaries

The HA add-on runs two HTTP surfaces:

- **Ingress app (`8099`)** — authenticated Home Assistant UI/API surface. It
  serves the Builder and handles widget, payload, source-test, render, asset,
  entity, history, and font routes.
- **Image app (`8000`)** — unauthenticated image-only ESP32/e-ink surface. It
  serves the PNG/BIN image endpoints only (`.png` accepts `GET`/`HEAD`, `.bin`
  accepts `POST` — the firmware POSTs for its frame) and has no mutation
  routes; the `.bin` body is parsed only as an optional Zod-validated render
  selector plus an optional per-field-validated `telemetry` object, neither of
  which is ever persisted. In the default `on-demand` mode a request may
  trigger a fresh render subject to the per-slot cooldown and global
  `RenderGuard`; in `cache-only` mode it only serves the already-warmed
  in-memory image buffer.

Pairing-based instance requests extend the image app without changing that
trust model: widgets carry server-assigned numeric pairing IDs on their
envelope (additive optional fields, one per slot), and a `.bin` POST body of
`{ requestedInstances: [ids] }` streams one framed section per ID in request
order (u32 ID echo + status byte, then the unchanged frame when available).
Resolution goes through a `resolvePairing` function injected from `src/ha/`
(core never imports the HA layer), backed by a short-lived read-path-only
cache over the widget metadata; instances render sequentially from the SAVED
widget documents through the same pipeline as deploys, with per-instance
cooldowns and a size-capped pairing buffer cache. Unresolvable or failing
instances degrade to a status-0 section instead of failing the response.

Panel telemetry rides the same body and the same single parse: a `telemetry`
object is validated field by field into a request-scoped `device` expression
namespace that lives only for the frames of that one response — there is no
per-device store, and `mac` / `wakeReason` / `delta` are never exposed or
logged. A widget that **declares** a source with id `device` is not seeded at
all, so that source owns the root; the namespace shadows on declaration rather
than through a migration.

Persistent HA runtime state lives under `/data`. The HA storage adapter owns
payloads, widgets, cached images, uploaded assets, and legacy artifact
migration. Writes that affect SD-card-backed artifacts go through
compare-before-write behavior for wear reduction.

External HTTP(S) source fetches are resolved through `src/data/`, not through
the renderer or Builder. URL validation, source response limits, XML parsing,
CSV parsing, and source-specific platform handlers live outside `src/engine/`.

The route trust model assumes a trusted LAN: the Ingress UI is authenticated by
Home Assistant, while the ESP32 render endpoints are unauthenticated and rely on
network isolation. Outbound source/image/SVG fetches are guarded by an SSRF
validator (private/reserved IP ranges are always blocked; an optional
`allowed_source_domains` allowlist restricts public hosts) with redirect
re-validation. A residual DNS-rebinding window exists between validation and the
actual fetch — see [SECURITY.md](../SECURITY.md) and the README "Security & data
handling" section.

Resource limits target a Raspberry Pi: source fan-out is bounded, graph
expansion and the render cache are size-capped, and widget/asset storage quotas
are enforced. See the README "Security & data handling" section for the
operator-facing summary.


## Slot-Aware Rendering

Every widget has a **`primary`** payload and MAY have an optional **`fullscreen`**
companion payload locked to grid `3x2` and the device's full-screen pixel
dimensions. Both slots round-trip through the same render pipeline and are
served on parallel ESP32 endpoints.

**Type:** `Slot = "primary" | "fullscreen"` (`src/core/adapters.ts`).

**HTTP API.** Slot is selected via `?slot=fullscreen` query (or `body.slot`):

| Route | Effect |
|---|---|
| `PUT /payload?slot=fullscreen` | Stores and renders the companion payload, then writes its cached PNG/BIN artifacts. The body must be a valid payload object; deletion is handled by widget save with `fullscreen: null`. |
| `POST /render?slot=fullscreen` | Renders the companion payload through the **same `RenderGuard` mutex** as primary — slots never render in parallel. With `X-Deploy: true`, it also persists the slot payload and cached images. Response includes `X-Render-Slot` header. |
| `GET /image_fullscreen.png` (port 8000) | Cached PNG for the companion; `GET`/`HEAD` only. Same `If-None-Match` / cooldown / `cache-only` semantics as `/image.png`. |
| `POST /image_fullscreen.bin` (port 8000) | Framed binary reply for the companion; `POST` only, with the same optional body (render selector + telemetry) as `/image.bin`. |

**Storage layout.** `StorageAdapter` methods accept an optional `slot?: Slot`
parameter (default `"primary"`):

- `readPayload(slot)`, `writePayload(data, slot)`
- `writeCachedImage(format, data, slot)`, `getCachedImagePath(format, slot)`
- `deleteSlot(slot)` — removes payload + cached image files for a slot
  (no-op for `primary`; idempotent).

The HA adapter writes companions to `payload.fullscreen.json`, `image_fullscreen.png`,
and `image_fullscreen.bin` alongside the primary files. All writes go through
`writeIfChanged` for SD-card safety.

**Widget round-trip.** `WidgetDoc.fullscreen?: unknown | null` carries the
companion payload. `widgetService.writeWidget` validates it against
`fullscreenPayloadSchema` (which refines `payloadSchema` with
`misc.gridSize === "3x2"`) before persisting; explicit `null` after a prior
companion triggers `storage.deleteSlot("fullscreen")` so on-disk artifacts
are cleaned up. The render loop in `src/ha/index.ts` iterates both slots on
startup and on the periodic re-render timer.

**Builder companion ID.** The Builder represents a companion as a sibling
docStore entry under the synthetic ID `<widgetId>::fullscreen`
(`builder/src/store/companionId.js`). The suffix is builder-internal — it
never appears in payload JSON, on disk, or on the wire.

**Builder UI.** A single canvas (`CanvasArea`) renders one slot at a time
against a single flat viewport (`uiStore.viewport = { panX, panY, zoom }`).
Users switch between primary and the optional companion via slot-tab pills
in `CanvasToolbox`. The companion is created via the `+ Fullscreen` pill
(dispatched through `uiStore.ensureFullscreenCompanionHandler`, registered
by `widgetStore`) and removed via the × on the active companion tab
(`uiStore.deleteFullscreenCompanionHandler`). Selection, history, and
inspector follow the focused doc; the data layer is unchanged.


## Platform Seam — Builder

Directory: `builder/src/platform/`.

| Responsibility | HA Implementation | Cloud Equivalent (example) |
|---|---|---|
| API client | `apiClient.js` (relative fetch + Ingress prefix) | HTTPS + OAuth bearer |
| Widget persistence | `widgetStore.js` (widget CRUD + activeWidgetId) | Cloud API / database SDK |
| Auto-save state | `autoSaveStore.js` (toggle, persisted to localStorage) | Same or cloud-specific |
| Auto-save hook | `useAutoSave.js` (debounced save on doc change) | Same pattern, different transport |
| HA entity cache | `entityStore.js` (Supervisor entity list) | Cloud entity/data source |
| User assets | `AssetPickerProvider.jsx` + `apiClient.js` asset helpers + HA asset routes | Object storage / signed uploads / media library |
| Auth / session | Ingress cookies (implicit) | OAuth login + token refresh |
| Navigation | `TopBar.jsx` (widget dropdown + save/deploy) | Add user menu, sharing, etc. |
| Welcome screen | `WelcomeScreen.jsx` (initial setup / grid select) | Cloud onboarding flow |
| HA source fields | `HaStateSourceFields.jsx`, `HaHistorySourceFields.jsx` | Cloud-specific source UI |
| Entity browser | `EntityBrowser.jsx` (HA entity picker) | Cloud data source picker |

> **Note:** `ConfirmModal.jsx` lives in `builder/src/components/` (core), not platform — it is platform-agnostic.

To swap platforms: replace `builder/src/platform/` and update the import path in `App.jsx`. Nothing else changes.

**Unchanged:** `models/`, `store/`, `editor/`, `components/`, `panels/`, `utils/`, all CSS.


## Build Pipeline

- **Server:** `npm run build` — TypeScript from `src/` → `dist/`.
- **Builder:** `cd builder && npm run build` — Vite SPA from `builder/src/` → `builder/dist/`.
- Both MUST compile clean (zero errors) before deployment.


## CSS Convention

- All builder files currently use vanilla CSS + CSS custom properties (`index.css`, `theme.css`).
- New `platform/` components MAY introduce Tailwind in the future but MUST NOT break existing core styles.


## JSON Output Format

Output payload: `{ misc, features, sources[], elements[] }`. The payload shape is
documented in the README payload section and enforced by `src/schema/payloadSchema.ts`.
`exportRuntimeJson()` in `builder/src/models/mapper.js` is the single source of truth for export. Do NOT create alternative export paths.


## Tech Stack

- **Server:** TypeScript, Express, Zod, sharp, fast-xml-parser
- **Builder:** React, Zustand+Immer, react-konva (Konva), vanilla CSS + CSS custom properties
- **Icons:** Tabler Icons (rendered as inline SVG from bundled path data)
- **HA data:** Home Assistant WebSocket / Supervisor API


## Expression Engine — Shared Package

The expression evaluation system (bindings, operators, pipe syntax, `BLOCKED_KEYS`)
lives in a single workspace package consumed by both the server and the Builder.

| Component | Location |
|---|---|
| Canonical source | `packages/zb-expressions/src/` (TypeScript) |
| Server consumption | `import { ... } from "@zb/expressions"` (resolves to package CJS build) |
| Builder consumption | `import { ... } from "@zb/expressions"` (Vite alias to TS source) |
| Server shims | `src/expressions/{bindingResolver,context}.ts` — thin re-exports retained ONLY because the frozen `src/engine/` imports them per ENGINEERING_CONSTRAINTS.md §1 |
| Tests | `packages/zb-expressions/test/parity.test.ts` (152 fixture vectors) |

**Rules:**

- New code MUST import the expression engine from `@zb/expressions`. ESLint enforces this in both `eslint.config.mjs` (server) and `builder/eslint.config.js` via `no-restricted-imports`.
- `src/expressions/` is a shim-only compatibility layer. Do not add logic to those files.
- Changes to expression semantics happen in `packages/zb-expressions/src/` and MUST be accompanied by fixture updates in `test/fixtures/expressionVectors.json`.
- The package builds dual ESM + CJS so the CommonJS server build and the ESM builder bundle both consume it natively.


## Extension Guides

Step-by-step instructions for common extension tasks.

### Adding an Element Type

1. **Element defaults** — Add default properties in `builder/src/models/elementDefaults.js`. Follow the existing `createElement()` switch pattern with a new case for your type. Include all required fields with sensible defaults.
2. **Zod schema** — Add a schema variant in `src/schema/elementSchema.ts`. Use `z.unknown()` for fields that support data bindings.
3. **Canvas preview** — Add rendering logic in `builder/src/editor/CanvasArea.jsx` (in the element rendering section). Handle the new type in the existing type switch.
4. **Inspector fields** — Add type-specific property controls in `builder/src/panels/InspectorPanel.jsx`.
5. **Export/import mapping** — Update `ELEMENT_KNOWN_KEYS` in `builder/src/models/mapper.js` with all new property names. Add any type-specific normalization inline within `exportRuntimeJson()` and `importRuntimeJson()` (e.g. the circle pos top-left/center conversion).
6. **Engine constraint** — `src/engine/` is frozen (ENGINEERING_CONSTRAINTS.md §1). New element types MUST be composable from existing engine primitives: `rect`, `circle`, `line`, `text`, `img`, `svg`, `group` (ENGINEERING_CONSTRAINTS.md §6).
    The existing `graph` element follows this pattern: it is a builder/schema element expanded into primitives before it reaches the frozen renderer.

### Adding a Source Type

1. **Zod schema** — Add a schema variant in `src/schema/sourceSchema.ts`.
2. **Platform handler** — Implement the handler in the platform adapter (e.g., `src/ha/haSources.ts` for HA-specific sources). The handler receives the source config and returns fetched data.
3. **Register handler** — Wire the handler into `PlatformAdapter.getSourceHandler()` in the platform's adapter implementation.
4. **Builder UI** — Add source configuration fields. For HA-specific sources, add a new component in `builder/src/platform/` (e.g., `HaStateSourceFields.jsx`). Register it through `uiStore.setSourceFieldRenderer()` from the platform composition layer (currently `App.jsx`); `SourcesPanel` consumes the injected renderer.
5. **Known keys** — Update `SOURCE_KNOWN_KEYS` in `builder/src/models/mapper.js` with any new source properties.
6. **Tests** — Add server-side tests for the new source handler and schema validation.

### Adding a New Platform

Reference `src/ha/` as the canonical implementation.

1. **Create platform directory** — e.g., `src/cloud/` alongside `src/ha/`.
2. **Implement `StorageAdapter`** — From `src/core/adapters.ts`. Provides widget CRUD, payload I/O, and image caching. The HA adapter uses filesystem + `writeIfChanged`; a cloud adapter would use a database or object storage.
3. **Implement `PlatformAdapter`** — From `src/core/adapters.ts`. Provides `registerRoutes()` for platform-specific endpoints, `getBlockedHostnames()` for SSRF protection, and `getSourceHandler()` for platform-specific data sources.
4. **Configure URL validation** — Call `configureUrlValidator()` and `configureBlockedHostnames()` from `src/data/urlValidator.ts` before `createIngressApp()`. See the **Adapter Startup Configuration** section above.
5. **Create entrypoint** — Call `createIngressApp(adapter)` from `src/core/server.ts` with your adapter. See `src/ha/index.ts` for the startup sequence pattern.
6. **Builder platform layer** — Replace `builder/src/platform/` with a new platform directory. Implement `apiClient.js` (with your auth scheme), `widgetStore.js`, and any platform-specific UI components. Core builder code (`models/`, `store/`, `editor/`, `components/`, `panels/`, `utils/`) stays untouched.
