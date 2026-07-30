# ZerryBit Engine

**Version 0.1.3 (Beta)** · Home Assistant Add-on for E-ink Displays

> ⚠️ **Beta software.** ZerryBit Engine — including the Widget Builder — is in **beta**. Expect rough edges, breaking changes between releases, and APIs/payload formats that may change without notice. Not yet recommended for unattended production use. Please [report issues](https://github.com/ZerryGit/zb-ha-app/issues) and back up any widgets you create.

A local-first Home Assistant add-on that renders **1-bit dithered images** from a declarative JSON payload and serves them over HTTP for E-ink displays (ESP32 and similar embedded devices). Includes a built-in **Widget Builder** for visual dashboard design — everything runs on your HA host, no cloud required.

---

## Quick Start

1. **Install** — in Home Assistant go to **Settings → Add-ons → Add-on Store → ⋮ → Repositories**, add `https://github.com/ZerryGit/zb-ha-app`, then install **ZerryBit Engine** from the store.
2. **Start** the add-on.
3. Open the **ZB Engine** panel from the HA sidebar.
4. Select entities → click **Open Builder** → design your dashboard → **Deploy**.
5. Point your ESP32 at `http://<HA_IP>:8000/image.bin` — it polls this endpoint with `POST`.

> **Repository layout.** This is a Home Assistant **add-on repository**. The add-on
> itself lives in [`zb_engine/`](zb_engine/) — its `config.yaml`, `Dockerfile`,
> source, and docs. Adding the repository URL above lets the Supervisor discover it
> automatically. For local development, work inside `zb_engine/` (see
> [Development](#development)).

---

## How It Works

1. You design a dashboard in the **built-in Widget Builder** (served locally from the add-on).
2. The builder sends a JSON payload to the rendering engine.
3. The engine fetches live data (HA entities, external APIs), resolves dynamic bindings, and draws shapes/text/images onto a 1-bit canvas.
4. The rendered image is cached to disk as both **PNG** (preview) and **BIN** (ESP32).
5. Your ESP32 polls `POST /image.bin` on a timer. The image port returns the latest in-memory image as a framed device reply — a 25-byte header (dimensions, refresh flags, next-wake, sidebar clock) followed by the 1-bit image — and can optionally perform bounded on-demand rendering.

---

## Ports

| Port | Purpose | Auth |
|------|---------|------|
| **8099** (Ingress) | HA sidebar, Widget Builder, entity APIs | HA session (automatic) |
| **8000** (Image) | ESP32 image endpoint | None |

> **Changing the image port.** `8000` is the *default* host port. If it's already
> in use on your Home Assistant host, change it under the add-on's
> **Configuration → Network** section — your ESP32 then polls the port you chose
> (e.g. `http://<HA_IP>:9001/image.bin`). The add-on always listens on `8000`
> inside its container; only the host-facing port changes, so nothing else needs
> reconfiguring.

---

## Endpoints

### Port 8000 — ESP32 (unauthenticated, read-only)

> **LAN trust assumption.** Port 8000 has no authentication — it is intended for
> ESP32 devices that cannot speak HA's auth protocol. The operator is
> responsible for keeping it on a trusted LAN. The add-on adds three
> safeguards: a configurable per-slot cooldown
> (`image_port_cooldown_ms`), strong-ETag conditional GETs on the PNG preview
> (`If-None-Match` → `304`), and an `image_port_mode: cache-only` switch that disables on-demand
> rendering entirely. See [`DOCS.md`](zb_engine/DOCS.md) for full details.

| Method | URL | Description |
|--------|-----|-------------|
| `GET` | `/image.png` | Cached PNG (primary slot) — sends `ETag`, honors `If-None-Match` |
| `POST` | `/image.bin` | Framed 1-bit reply for ESP32 — 25-byte header + image; no ETag (a live clock makes every reply unique) |
| `GET` | `/image_fullscreen.png` | Cached PNG (fullscreen companion slot) |
| `POST` | `/image_fullscreen.bin` | Framed 1-bit reply (fullscreen companion slot) |

### Port 8099 — HA Ingress (session-authenticated)

| Method | URL | Description |
|--------|-----|-------------|
| `GET` | `/` | Widget Builder entrypoint (SPA fallback) |
| `GET` | `/panel/` | Management panel static UI |
| `GET` | `/builder/` | Widget Builder — visual dashboard designer |
| `GET` | `/health` | Ingress readiness and renderer status |
| `GET` | `/entities` | Proxy HA entity list |
| `GET` | `/history` | Batch-fetch HA state history |
| `GET` | `/api/widgets` | List all saved widgets (metadata) |
| `GET` | `/api/widgets/new-id` | Generate a unique widget ID |
| `GET` | `/api/widgets/:id` | Load a widget document |
| `PUT` | `/api/widgets/:id` | Save or overwrite a widget |
| `DELETE` | `/api/widgets/:id` | Delete a widget |
| `POST` | `/api/assets` | Upload a user image/SVG asset |
| `GET` | `/api/assets` | List uploaded asset metadata |
| `DELETE` | `/api/assets/:filename` | Delete an uploaded asset |
| `GET` | `/api/assets/:filename/raw` | Serve authenticated raw asset bytes for builder thumbnails |
| `GET` | `/api/fonts` | List available bitmap font files |
| `GET` | `/api/fonts/:filename` | Serve a single font JSON (cached) |
| `GET` | `/payload` | Current primary payload JSON |
| `PUT` | `/payload?slot=fullscreen` | Deploy one slot payload → render → cache images |
| `POST` | `/render?slot=fullscreen` | One-shot render from request body; with `X-Deploy: true`, persists that slot |
| `POST` | `/render/expand` | Expand graph elements into primitives (builder preview) |
| `POST` | `/render/test-source` | Test a single source config and return fetched data |
| `POST` | `/export` | Create a one-time export token from a JSON object body (sidebar → builder handoff) |
| `GET` | `/export/:token` | Redeem 32-char hex export token (single-use, 5 min TTL) |
| `GET` | `/image.png` | Preview cached PNG (primary slot) |
| `GET` | `/image_fullscreen.png` | Preview cached PNG (fullscreen companion slot) |

For slot-aware routes, omit `slot` for the primary payload or pass `?slot=fullscreen` for the fullscreen companion.

---

## Configuration

Set these in the add-on's **Configuration** tab:

| Option | Default | Description |
|--------|---------|-------------|
| `allowed_source_domains` | `[]` | Optional allowlist for HTTP data source URLs. Empty = all external allowed. |
| `re_render_minutes` | `0` | Auto re-render interval (0 = disabled, 1–60 minutes). Fetches fresh source data and re-renders on a timer. Uses hash-before-write to avoid unnecessary SD card writes. |
| `image_port_cooldown_ms` | `4000` | Per-slot minimum interval between unauthenticated image-port on-demand renders. |
| `image_port_mode` | `on-demand` | `on-demand` allows bounded image-port renders; `cache-only` serves only already-rendered in-memory images. |

---

## Security & data handling

This add-on is designed to run on a trusted Home Assistant host. A few things
operators should know:

- **Port 8000 is unauthenticated (LAN-trust).** Keep it on a trusted LAN — do
  not port-forward or expose it to the internet. See the
  [Port 8000](#port-8000--esp32-unauthenticated-read-only) note above and
  [`DOCS.md`](zb_engine/DOCS.md) for the mitigations (cooldown, conditional GETs,
  `cache-only` mode).
- **Source credentials are stored at rest in plaintext.** Data-source auth
  (bearer tokens, API keys, basic-auth passwords) is saved inside the widget
  JSON under `/data/widgets/` on the HA volume so the add-on can replay the
  fetch at render time. Anyone with host/volume access can read these. The
  add-on **masks these secrets** when a widget is read back over the panel API
  (`GET /api/widgets/:id`, `GET /payload`) and restores them on save, so a
  panel user cannot read another user's stored credentials — but it does not
  encrypt them on disk. Treat the HA host as the trust boundary, and prefer
  scoped/read-only API keys for data sources.
- **Outbound fetches can reach any public host by default.** Out of the box
  (`allowed_source_domains: []`), the add-on will fetch any public URL you
  configure for data sources, images, and SVGs. Private and reserved IP ranges
  are **always** blocked (SSRF protection, with redirect re-validation), but
  public egress is open until you list specific hosts in
  `allowed_source_domains` (subdomains of a listed host are also allowed). For a
  hardened deployment, set that allowlist. Note a residual DNS-rebinding window
  exists between hostname validation and the actual fetch; see
  [SECURITY.md](SECURITY.md).
- **Storage is bounded.** Widgets and uploaded assets are capped (count and
  total bytes) so a misbehaving client cannot exhaust the `/data` volume.
- **Hardening.** The add-on runs as a non-root user, drops privileges via
  su-exec, and ships an AppArmor profile (`apparmor.txt`) that the Supervisor
  applies automatically.

---

## Payload — Minimal Example

Deploy via the builder or `PUT /payload`. The HA adapter persists the active primary payload as `/data/payload.json`:

```json
{
  "misc": { "size": { "width": 480, "height": 800 }, "format": "png" },
  "features": {},
  "sources": [],
  "elements": [
    {
      "type": "rect",
      "pos": { "x": 0, "y": 0 }, "sizeX": 480, "sizeY": 800,
      "enableFill": true, "fill": 0,
      "enableStroke": true, "strokeDither": 100, "strokeWidth": 2
    },
    {
      "type": "text",
      "pos": { "x": 20, "y": 30 }, "sizeX": 440, "sizeY": 60,
      "text": "Hello from ZerryBit",
      "fontSize": 34, "fontWeight": 600,
      "enableFill": true, "fill": 100
    }
  ]
}
```

### Payload Structure

| Section | Purpose |
|---------|---------|
| `misc` | Canvas size, output format, metadata |
| `features` | User-defined variables (resolved before sources) |
| `sources` | HTTP APIs, HA state, or HA entity history — fetched at render time |
| `elements` | Ordered drawing commands (index 0 = bottom layer) |

---

## Element Types

| Type | Description |
|------|-------------|
| `rect` | Rectangle — fill, stroke, rounded corners, dash |
| `circle` | Ellipse — arc segment, donut ring |
| `line` | Polyline — dash, butt/round caps, rounded joints |
| `text` | Bitmap text — Sora family, 8 sizes × 3 weights |
| `img` | Fetch & rasterize image → 1-bit |
| `svg` | Rasterize inline/URL SVG → 1-bit |
| `graph` | Builder/schema element expanded into primitive shapes before render |
| `group` | Container with shared offset, recursive nesting |

All elements support: `pos`, `rotationDeg`, `scale`, `origin`, `opacity`, `visible`. Image and SVG sources can also reference uploaded assets with `asset:<filename>` tokens created by the builder asset picker.

---

## HA Entity Data

Two source kinds pull live HA data into your dashboard at render time:

### `haState` — Current state of an entity

```json
{
  "id": "temp",
  "kind": "haState",
  "entity_id": "sensor.living_room_temperature"
}
```

Exposes `{{temp.state}}` and all entity attributes (e.g. `{{temp.unit_of_measurement}}`).

### `haHistory` — Time-series history

```json
{
  "id": "temp_hist",
  "kind": "haHistory",
  "entity_id": "sensor.living_room_temperature",
  "hoursBack": 24
}
```

Exposes bindings like `{{temp_hist.latest}}`, `{{temp_hist.min}}`, `{{temp_hist.max}}`, `{{temp_hist.avg}}`, and `temp_hist.points` (full time-series array for graphs).

---

## Bindings & Expressions

Any element field can use dynamic values:

```json
{ "$": "temp.latest" }                          // read from data context
{ "$": "features.city", "default": "Unknown" }  // with fallback
{ "if": [{ "==": [{"$":"temp.latest"}, null] }, "N/A", {"$":"temp.latest"}] }
"Temperature: {{temp.latest}}°C"                // string interpolation
```

---

## Font System

Pre-rasterized **Sora** bitmap fonts — no runtime dependencies. Eight sizes
across three weights, though not every size × weight combination ships:

| Size (px) | Light (300) | Regular (400) | SemiBold (600) |
|----------:|:-----------:|:-------------:|:--------------:|
| 10 | – | ✓ | – |
| 12 | ✓ | – | ✓ |
| 16 | ✓ | ✓ | ✓ |
| 20 | ✓ | ✓ | ✓ |
| 26 | – | ✓ | – |
| 34 | – | ✓ | ✓ |
| 44 | ✓ | ✓ | – |
| 56 | ✓ | ✓ | ✓ |

The engine snaps `fontSize` and `fontWeight` to the nearest available variant,
so a request for a missing combination (e.g. 26 px SemiBold) renders in the
closest shipped one rather than failing.

---

## Error Handling

Errors are collected, not thrown — the image always renders.

| Failure | Behavior |
|---------|-----------|
| Source fetch fails | Fields use `defaultValue`; reported in `X-Source-Errors` header |
| Element fails | Element skipped; reported in `X-Render-Errors` header |
| Pipeline timeout (30s) | Render is aborted and an error response is returned |

---

## Development

All commands below run from the `zb_engine/` add-on directory (`cd zb_engine` after cloning).

```bash
# Server (from zb_engine/)
npm install            # Install server dependencies
npm run build          # Compile expressions + server TypeScript

# Builder (separate terminal)
cd builder && npm install   # Install builder dependencies
npm run dev                 # Vite dev server on :5173 (proxies API to Express)

# Production build (both)
npm run build                     # Compile expressions + server
cd builder && npm run build      # Compile builder SPA
```

```bash
# Tests
npx vitest run                      # Server tests
cd builder && npx vitest run        # Builder tests
```

```bash
# Quick manual tests
curl -o test.png http://localhost:8000/image.png
curl -X POST -o test.bin http://localhost:8000/image.bin && wc -c test.bin
curl http://localhost:8099/api/widgets          # List saved widgets
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Dockerfile is missing" in Supervisor logs | Run `ha supervisor reload`, then reinstall the add-on |
| `image.png` returns 500 | Check `payload.json` exists and is valid JSON with `misc.size` defined |
| Text wrong size | Engine snaps to nearest font. Use 10, 12, 16, 20, 26, 34, 44, or 56 for exact results |
| `image.bin` unexpected size | The `POST` reply is a 25-byte header + `⌈width/8⌉ × height` image bytes (width padded to a byte boundary). |
| Deploy returns 403 | Ensure you're accessing via HA Ingress (sidebar). Direct port 8099 access without HA session will fail. |

---

## Architecture & Internals

The codebase is split into a platform-agnostic core and per-platform adapters (paths below are relative to the `zb_engine/` add-on directory):

```
src/
├── limits.ts       # Shared payload/render limits
├── core/           # Platform-agnostic server core
│   ├── adapters.ts       # StorageAdapter + PlatformAdapter interfaces
│   ├── server.ts         # Express app factory (createIngressApp)
│   ├── renderService.ts  # Render pipeline + RenderGuard mutex
│   ├── widgetService.ts  # Widget CRUD handlers
│   └── rateLimiter.ts    # Rate-limiting middleware
├── ha/             # Home Assistant adapter (swap this for other platforms)
│   ├── index.ts          # HA entrypoint (dual-port: 8099 + 8000)
│   ├── haStorage.ts      # Filesystem storage + writeIfChanged
│   ├── haAssets.ts       # Authenticated user-asset routes
│   ├── haEntities.ts     # HA entity/history proxy
│   ├── haSources.ts      # haState + haHistory source handlers
│   └── haOptions.ts      # /data/options.json loader
├── engine/         # Render engine — FROZEN (do not modify)
├── data/           # Generic data layer
│   ├── sourceFetcher.ts      # HTTP source fetcher
│   ├── dataFieldExtractor.ts # Dot-path field extraction
│   ├── featureResolver.ts    # Feature variable resolution
│   ├── textAutoSize.ts       # Auto-sizing text helper
│   ├── urlValidator.ts       # SSRF protection
│   └── graph/                # Graph element expansion
├── expressions/    # Thin compatibility shims that re-export @zb/expressions
├── encoder/        # PNG + BIN encoding
├── errors/         # Error types
└── schema/         # Zod schemas (payload, elements, sources)

packages/
└── zb-expressions/ # Canonical binding/expression engine shared by server + builder

builder/src/
├── platform/       # HA integration layer (swap this for other platforms)
│   ├── apiClient.js          # API client with Ingress prefix detection
│   ├── widgetStore.js        # Zustand store for widget persistence
│   ├── autoSaveStore.js      # Auto-save logic
│   ├── entityStore.js        # Entity state cache
│   ├── AssetPickerProvider.jsx # User asset picker integration
│   ├── useAutoSave.js        # Auto-save hook
│   ├── TopBar.jsx            # Widget selector + Save/Deploy/Refresh
│   ├── WelcomeScreen.jsx     # First-run welcome screen
│   ├── EntityBrowser.jsx     # Entity picker UI
│   ├── HaStateSourceFields.jsx   # haState config fields
│   └── HaHistorySourceFields.jsx # haHistory config fields
├── models/         # Document model, element defaults, import/export
├── store/          # docStore, uiStore, displayConfigStore (Zustand)
├── editor/         # Konva canvas, toolbox, graph preview
├── components/     # Shared UI — inspector fields, data tree, modals
├── panels/         # Left/right panels, inspector, sources, features
└── utils/          # Expression helpers, font rendering, snapping
```

**Platform seam:** To target a different platform (cloud, self-hosted), replace `src/ha/` with a new adapter directory and `builder/src/platform/` with a new platform layer. Everything else stays identical.

---

## For Developers

| Document | Description |
|----------|-------------|
| [CONTRIBUTING.md](CONTRIBUTING.md) | Building and running the add-on from source — setup, prerequisites, and local checks |
| [ARCHITECTURE.md](zb_engine/ARCHITECTURE.md) | System design, platform seam, and extension guides |
| [ENGINEERING_CONSTRAINTS.md](zb_engine/ENGINEERING_CONSTRAINTS.md) | Mandatory rules for all contributors |
| [zb_engine/builder/src/store/STORE_ARCHITECTURE.md](zb_engine/builder/src/store/STORE_ARCHITECTURE.md) | docStore data model, selector conventions, save pipeline |
| [SECURITY.md](SECURITY.md) | Vulnerability disclosure policy and supported versions |
| [THIRD-PARTY-NOTICES.md](zb_engine/THIRD-PARTY-NOTICES.md) | Licenses and attributions for bundled third-party components |

---

## FAQ

**Q: I run Home Assistant in Docker (Container) / a venv (Core). Can I install this?**
A: Not yet. Use **Home Assistant OS (HAOS)**, the supported way to run add-ons. Native standalone-container support is planned.

---

## License

MIT — see [LICENSE](LICENSE). Bundled third-party components and their licenses are listed in [THIRD-PARTY-NOTICES.md](zb_engine/THIRD-PARTY-NOTICES.md).
