# ZerryBit Engine — Web Builder API Reference

> **Audience:** Frontend/fullstack engineers building or modifying the ZerryBit widget builder.  
> **Version:** Engine v0.1.3  
> **Last updated:** 2026-07-08

---

## Overview

The ZerryBit Engine runs as a Home Assistant add-on. The builder SPA is **served locally by the engine** at `/builder/` on port 8099 (HA Ingress). All builder API calls use **relative URLs** — there is no HA IP address to configure, no API token, and no CORS complexity.

| Port | Audience | Auth | Purpose |
|------|----------|------|---------|
| **8099** | Builder SPA + HA sidebar | HA Ingress session (transparent) | All management APIs, entity data, deploy |
| **8000** | ESP32 firmware | None (read-only) | Serve cached PNG and BIN images only |

The builder **only ever talks to port 8099** via relative URLs. Port 8000 is a read-only static file server for ESP32 devices — the builder never calls it directly.

---

## 1. Authentication — HA Ingress Session

No token configuration is required. The builder SPA is served from `/builder/` through HA's Ingress proxy. HA enforces session authentication transparently before any request reaches the engine — the browser's HA session cookie is forwarded automatically.

**What this means for the builder:**
- No `X-ZB-Token` header
- No `api_token` add-on configuration
- No `localStorage` token management
- All `fetch()` calls use **relative URLs** — never `http://<HA_IP>:8000/...`

```js
// Correct — relative URL, works through HA Ingress
const res = await fetch('../payload', { method: 'PUT', ... });

// Wrong — absolute URL bypasses Ingress, breaks in all HA environments
const res = await fetch(`http://192.168.1.50:8000/payload`, { method: 'PUT', ... });
```

---

## 2. Port 8099 — Management API (Builder + Sidebar)

Base URL: relative to the builder's own origin (e.g., `../payload` from `/builder/`)

---

### `PUT ../payload` — Deploy a dashboard

The primary builder endpoint. Validates the payload schema, saves it, renders `image.png` and `image.bin` to disk, and returns metadata.

**Request**

```
PUT ../payload
Content-Type: application/json

{ ...payload JSON... }
```

**Success response — `200 OK`**

```json
{
  "ok": true,
  "name": "Living Room",
  "width": 296,
  "height": 128,
  "renderTimeMs": 420,
  "sourceErrors": [],
  "renderErrors": []
}
```

**Optional warning headers** (present only when non-empty):

| Header | Encoding | Meaning |
|--------|----------|---------|
| `X-Source-Errors` | base64-encoded JSON string array | One or more data sources failed to fetch |
| `X-Render-Errors` | base64-encoded JSON string array | One or more elements had render errors |

> A `200` response with non-empty `sourceErrors` or `renderErrors` means the image was still generated but with fallback/default values for the failed parts. Show these as warnings, not blockers.
>
> Decode with: `JSON.parse(atob(res.headers.get('X-Source-Errors')))`

**Error responses**

| Status | Meaning |
|--------|---------|
| 400 | Missing/invalid body or payload schema violation |
| 409 | A render is already in progress — retry in a moment |
| 500 | Render pipeline failure (timeout, crash) |

**Timeout:** The engine enforces a **30-second** render deadline. Per-source timeout is capped at **10 seconds**.

**Slot routing.** A widget may carry a second, **fullscreen** companion payload (locked to `misc.gridSize === "3x2"`). Pass `?slot=fullscreen` (query string) or `"slot": "fullscreen"` (request body) to deploy that slot; omitting it defaults to `"primary"`. An invalid `slot` value returns `400`. The fullscreen preview render is served at `GET ../image_fullscreen.png`.

---

### `GET ../payload` — Read current payload

Returns the `payload.json` currently stored on the engine (the **primary** slot). Use this to load the user's last-saved dashboard into the builder on startup.

```
GET ../payload
```

No auth required beyond HA Ingress session. Returns `404` if no payload has been deployed yet.

> **Source secrets are returned verbatim.** Source `auth` secrets (bearer token, `apiKey.value`, basic-auth password) and any credentials placed in custom `headers` / `query` are stored and returned in clear text — they are **not** masked or encrypted. In a multi-user Home Assistant, any user with panel access can read another user's third-party credentials. The same applies to `GET ../api/widgets/:id`.

---

### `GET ../image.png` — Preview image

Returns the last rendered PNG. Cache-bust with a timestamp query param.

```
GET ../image.png?t=<timestamp>
```

- `Content-Type: image/png`
- `Cache-Control: no-cache, no-store, must-revalidate`
- `404` if no image has been rendered yet

---

### `GET ../api/host-ip` — Host LAN IP for device URLs

Returns the Home Assistant host's best-guess LAN IPv4 (read from the Supervisor
`/network/info` endpoint), so the builder's Settings tab can show ESP32 devices
a reachable `http://<ip>:8000/image.bin` URL — devices generally cannot resolve
the `homeassistant.local` mDNS name. Requires `hassio_api: true` in the add-on
config (default Supervisor role, read-only).

```
GET ../api/host-ip
```

```json
{
  "ip": "192.168.1.50",
  "candidates": [
    { "interface": "eth0", "ip": "192.168.1.50", "primary": true },
    { "interface": "wlan0", "ip": "192.168.1.77", "primary": false }
  ]
}
```

- `ip` is `null` when no LAN interface could be determined (loopback, Docker,
  link-local, and VPN/tunnel interfaces are excluded).
- `candidates` lists every usable interface, primary first, so the UI can offer
  a picker when the host has more than one (e.g. Ethernet + Wi-Fi).
- Rate-limited under the shared Supervisor-proxy budget (alongside `../entities`
  and `../history`).
- `500` if the Supervisor call fails (e.g. `hassio_api` not granted).

---

### `GET ../export/:token` — Redeem export token

Single-use token redemption. The HA sidebar POSTs entity data to `POST ../export`, receives a token, and opens the builder at `./builder/?export=<token>`. The builder redeems it here on load.

```
GET ../export/<token>
```

| Status | Meaning |
|--------|---------|
| 200 | Token valid — returns export data JSON, token deleted (single-use) |
| 400 | Token malformed |
| 404 | Token not found or already used |
| 410 | Token expired (5-minute TTL) |

---

### Widget storage API

The builder persists named widgets (each a document with a `primary` payload and an optional `fullscreen` companion) through a small CRUD API. All routes are on port 8099 behind the HA Ingress session; write routes are rate-limited.

| Method & path | Purpose |
|---------------|---------|
| `GET ../api/widgets` | List widget metadata (`id`, `name`, `updatedAt`, …). |
| `GET ../api/widgets/new-id` | Returns `{ "id": "<fresh-id>" }` for a new widget. |
| `GET ../api/widgets/:id` | Read one widget: `{ id, name, doc, metadata?, fullscreen?, updatedAt, schemaVersion }`. `404` `{ error, code: "NOT_FOUND" }` if absent. |
| `PUT ../api/widgets/:id` | Create/replace a widget. Body: `{ name, doc, metadata?, fullscreen? }`. Omitting `fullscreen` leaves any existing companion unchanged; `null` removes it. Returns `{ ok, id, name, updatedAt }`; `400` on schema violation. |
| `DELETE ../api/widgets/:id` | Delete a widget. |

> **Source secrets** are stored and returned in clear text over `GET ../api/widgets/:id`, exactly as for `GET ../payload` (see that note above).

> **`schemaVersion`** is the stored-envelope format version (currently `1`), owned by the server: it is stamped on every save and returned on read, so `PUT` bodies neither send nor need it. A record saved before envelope versioning existed has no field on disk and reads back as the current version — the file itself is not rewritten. Clients should ignore the field unless they persist widget records themselves.

---

## 3. Entity Data Flow

### Step 1 — Export from HA sidebar

The HA sidebar panel has an **"Open Builder ↗"** button. When clicked, it:

1. Calls `GET ../entities` to get the full HA entity list (optional — for the entity picker)
2. User selects entities (optionally with history data)
3. Sidebar `POST`s the selection as a JSON object to `POST ../export`
4. Engine stores the data in memory with a crypto-random token (32-char hex, single-use, 5-minute TTL)
5. Sidebar navigates to `./builder/?export=<token>` using `window.location.href`

### Step 2 — Builder redeems the token

The builder reads the `export` query param on load, then redeems via relative URL:

```js
async function initFromUrlParams() {
  const params = new URLSearchParams(location.search);
  const exportToken = params.get('export');

  if (exportToken) {
    try {
      const res = await fetch(`../export/${exportToken}`);

      if (res.status === 404) {
        showError('Export token not found — it may have already been used. Try exporting again from Home Assistant.');
        return;
      }
      if (res.status === 410) {
        showError('Export token expired. Go back to Home Assistant and export again (tokens last 5 minutes).');
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const exportData = await res.json();
      setEntities(exportData.entities);
      if (exportData.history) {
        setHistory(exportData.history);
        setHistoryHours(exportData.hoursBack);
      }
    } catch (err) {
      showError(`Could not redeem export token — ${err.message}`);
    }

    // Clean URL so token isn't accidentally re-used or bookmarked
    const cleanUrl = new URL(location.href);
    cleanUrl.searchParams.delete('export');
    history.replaceState(null, '', cleanUrl.toString());
  }
}
```

### Token properties

| Property | Value |
|----------|-------|
| Length | 32 hex characters (128-bit) |
| TTL | 5 minutes from creation |
| Usage | **Single-use** — deleted after first successful GET |
| Auth | HA Ingress session (same-origin) |

### Step 3 — Entity shape

```json
{
  "entity_id": "sensor.living_room_temperature",
  "state": "21.5",
  "attributes": {
    "unit_of_measurement": "°C",
    "friendly_name": "Living Room Temperature",
    "device_class": "temperature"
  },
  "last_changed": "2025-01-01T12:00:00Z",
  "last_updated": "2025-01-01T12:00:00Z"
}
```

### Step 4 — Builder writes source definitions (not values!)

The builder does NOT embed live entity values into the payload. It embeds **fetch instructions** that tell the engine how to retrieve values at render time. Use `haState` for current values, `haHistory` for time-series.

---

## 4. Payload JSON Schema

The payload is a JSON object with four top-level keys. Maximum size: **2 MB**.

```ts
{
  misc:     MiscConfig,
  features: Record<string, string | number | boolean>,
  sources:  SourceDef[],    // max 500
  elements: ElementDef[],   // max 2000 top-level (10,000 total incl. nested)
}
```

---

### `misc` — Canvas configuration

```json
{
  "misc": {
    "size": { "width": 296, "height": 128 },
    "format": "png",
    "name": "Living Room",
    "type": "dashboard",
    "subcategory": "eink-2.9inch",
    "gridSize": "3x2",
    "tags": ["temperature", "weather"]
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `size.width` | `number` | Yes | Max **4096** |
| `size.height` | `number` | Yes | Max **4096** |
| `format` | `"png"` \| `"bin"` | — | Default `"png"`. `PUT ../payload` always produces both. |
| `name` | `string` | — | Displayed in sidebar |
| `gridSize` | `"NxM"` | — | Exposes `misc.grid.cols` / `misc.grid.rows` in bindings |

---

### `sources` — Data fetch instructions

Max **500** sources per payload. Three kinds are supported:

#### `http` source — Public HTTP API

```json
{
  "id": "weather",
  "kind": "http",
  "method": "GET",
  "url": "https://api.open-meteo.com/v1/forecast?latitude=48.85&longitude=2.35&current_weather=true",
  "timeoutMs": 5000,
  "retries": 1,
  "response": { "type": "json" },
  "dataFields": [
    { "id": "temp", "name": "Temperature", "path": "current_weather.temperature", "type": "number", "defaultValue": 0 },
    { "id": "code", "name": "Weather Code",  "path": "current_weather.weathercode",  "type": "number", "defaultValue": 0 }
  ]
}
```

> **SSRF protection:** Source URLs are always validated against the RFC1918 blocklist. Private IPs (`10.x`, `192.168.x`, `172.16–31.x`), localhost, and internal HA hostnames (`supervisor`, `homeassistant`) are blocked by default. An add-on operator may exempt specific private IPv4 addresses via the `allow_private_hosts` add-on option, which ships empty — it is not configurable from the builder. Localhost, link-local, and the internal HA hostnames are never exemptable, and the exemption never applies to a redirect target or to a hostname.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | Yes | Referenced in bindings as `{id.fieldId}` |
| `method` | `"GET"` \| `"POST"` | Yes | |
| `url` | `string` \| binding | Yes | Must be a public URL |
| `timeoutMs` | `number` | — | Default 10000, **max 10000** |
| `retries` | `number` | — | Default 0, max 3 |
| `response.type` | `"json"` \| `"xml"` \| `"csv"` \| `"text"` | Yes | |
| `dataFields` | `DataFieldDef[]` | — | Dot-path extraction. If omitted, entire response stored under `{sourceId}` |

#### `haState` source — Current HA entity state

Fetches the current state snapshot of a single HA entity via the Supervisor API. Use this for live sensor readings, binary states, and attribute values.

```json
{
  "id": "temp",
  "kind": "haState",
  "entity_id": "sensor.living_room_temperature",
  "attribute": "unit_of_measurement"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | `string` | Yes | |
| `kind` | `"haState"` | Yes | |
| `entity_id` | `string` | Yes | Format: `domain.object_id` (e.g. `sensor.temperature`) |
| `attribute` | `string` | — | If set, promotes this attribute to `state`/`value` |

**Data context exposed as `{id.*}`:**

| Binding path | Type | Description |
|-------------|------|-------------|
| `{id}.state` | `string` | Raw state string (`"23.5"`, `"on"`, `"unavailable"`) |
| `{id}.value` | `number \| null` | Numeric parse of state, or null if non-numeric |
| `{id}.attributes.<key>` | `any` | Any HA attribute value |
| `{id}.last_changed` | `string` | ISO timestamp of last state change |
| `{id}.last_updated` | `string` | ISO timestamp of last update |

#### `haHistory` source — HA entity time-series

Fetches the state history of an entity for the given time window. Use this for graphs, sparklines, min/max, and averages.

```json
{
  "id": "temp_hist",
  "kind": "haHistory",
  "entity_id": "sensor.living_room_temperature",
  "hoursBack": 24
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `entity_id` | `string` | Yes | Format: `domain.object_id` |
| `hoursBack` | `number` | — | 1–168, default 24 |

**Data context exposed as `{id.*}`:**

| Binding path | Type | Description |
|-------------|------|-------------|
| `{id}.latest` | `number \| null` | Most recent numeric value |
| `{id}.latestState` | `string` | Most recent raw state string |
| `{id}.min` / `.max` | `number \| null` | Range across the window |
| `{id}.avg` | `number \| null` | Mean value (2 decimal places) |
| `{id}.count` | `number` | Number of data points |
| `{id}.points` | `array` | Full `[{t, v, s}]` array oldest→newest. `t`=Unix ms, `v`=number\|null, `s`=string |

> **Array indexing in bindings:** `{id}.points.0.v` resolves to the first point's value. Useful for fixed-structure bar charts (`points.0.v` through `points.6.v` for a 7-bar weekly chart).

---

### `elements` — Drawing commands

Max **2000** top-level elements (**10,000** total including nested group children). Rendered in order (painter's model — later elements draw on top).

Common fields on all element types:

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `type` | `string` | — | `rect` \| `circle` \| `line` \| `text` \| `img` \| `svg` \| `group` |
| `pos` | `{x, y}` | `{0,0}` | Top-left position (or center for circle) |
| `visible` | `boolean` \| binding | `true` | Hides element if false |
| `opacity` | `number` \| binding | `100` | 0–100 dither mask |
| `rotationDeg` | `number` \| binding | `0` | Rotation in degrees |

> **Text visibility:** Text elements require **`enableFill: true`** and **`fill: 100`** to render as solid black. The schema default is `enableFill: false` — without explicitly setting this, text is rendered as invisible white pixels. Always set both fields when creating text elements.

> **Text sizing (`textFlow`):** `"auto"` (the default, and the behaviour of every payload written before 0.1.4) hugs the resolved text — at render time the box grows to fit a longer live value and never shrinks. `"fixed"` wraps instead: `sizeX` is the authored wrap width (line breaks are inserted into the string by a pre-render pass; the engine and fonts are untouched), and `sizeY` is an authored **minimum** — the rendered box is `max(sizeY, wrapped content height)`, growing downward, never clipping. A `sizeY` of `0` (or absent) declares no minimum at all: the frame simply hugs its wrapped content. The builder stores `0` whenever a resize lands snug against the text, and whenever a side-handle drag changes the width — a minimum chosen against the old wrap width is a stale number after the re-wrap, so the reserve is authored after the width, not carried across it. Any other value is treated as `"auto"`, so the field cannot break an old widget. Breaks fall after whitespace runs and after hyphens; a single word wider than the frame is split character by character; line count is capped at 4096, past which the remainder renders as one final (clipping) line. If the **resolved** value itself contains `{{`, wrapping is skipped for that element (it falls back to `"auto"`) and a warning is pushed to `renderErrors` — writing the resolved string back would otherwise let the engine interpolate data as an expression.

> **`circle.innerSize`:** This is a **fraction of the outer radius (0.0–1.0)**, not a pixel diameter. `innerSize: 0.5` creates a stroke whose inner edge is halfway to the center. `innerSize: 1.0` = fully hollow. Use a 0–100% slider in the builder UI, divide by 100 before writing to the payload.

> **`group` children:** Child element positions are relative to the group's `pos`. When grouping selected canvas elements, subtract the group's top-left from each child's absolute canvas position: `child.pos = originalAbsolutePos − group.pos`.

> **Sparklines / polylines:** `line.points` is a static `[[x,y], ...]` array. The engine cannot expand bindings into a variable-length array. To create a sparkline from `haHistory` data, compute the `[x,y]` coordinates at build/deploy time using the snapshot data and bake them into `line.points`. Re-deploy to refresh (re-compute from fresh data).

> **`strokeCap` vs `strokeRadius`:** These are independent properties. `strokeCap: "round"` rounds only the first and last endpoint of a polyline. `strokeRadius` rounds intermediate joints with bezier curves. Expose them as separate controls in the builder UI.

The full element schema is defined in `src/schema/elementSchema.ts`.

---

## 5. Binding Expressions

Many element fields accept binding expressions resolved at render time.

| Syntax | Description |
|--------|-------------|
| `"{{sourceId.field}}"` | String interpolation: `"Temp: {{temp.state}}°C"` |
| `{ "$": "sourceId.field" }` | Binding reference |
| `{ "$": "sourceId.field", "default": "-" }` | Binding with fallback |
| `{ "if": [cond, then, else] }` | Conditional branch |
| `{ "==": [a, b] }` | Equality → `boolean` |
| `{ "!=": [a, b] }` | Inequality → `boolean` |
| `{ ">": [a, b] }` | Greater than → `boolean` |
| `{ "<": [a, b] }` | Less than → `boolean` |
| `{ ">=": [a, b] }` | Greater than or equal → `boolean` |
| `{ "<=": [a, b] }` | Less than or equal → `boolean` |
| `{ "+": [a, b] }` | Addition → `number` |
| `{ "-": [a, b] }` | Subtraction → `number` |
| `{ "*": [a, b] }` | Multiplication → `number` |
| `{ "/": [a, b] }` | Division → `number` (returns 0 if divisor is 0) |

Available context roots: `misc.*`, `features.*`, `[sourceId].*`

---

## 6. Complete Deploy Example

```js
async function deployPayload(payload) {
  // No HA IP, no token — builder is same-origin via Ingress
  const res = await fetch('../payload', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (res.status === 400) {
    const err = await res.json();
    throw new Error(`Schema error: ${JSON.stringify(err.details)}`);
  }
  if (res.status === 409) throw new Error('Render already in progress — please wait and retry.');
  if (!res.ok) throw new Error(`Render failed: HTTP ${res.status}`);

  const data = await res.json();

  // Decode base64 warning headers if present
  const rawSourceErr = res.headers.get('X-Source-Errors');
  const rawRenderErr = res.headers.get('X-Render-Errors');
  if (rawSourceErr) console.warn('Source warnings:', JSON.parse(atob(rawSourceErr)));
  if (rawRenderErr) console.warn('Render warnings:', JSON.parse(atob(rawRenderErr)));

  return data; // { ok, name, width, height, renderTimeMs, sourceErrors, renderErrors }
}
```

**Minimal valid payload:**

```json
{
  "misc": { "size": { "width": 296, "height": 128 }, "name": "My Dashboard" },
  "features": {},
  "sources": [],
  "elements": [
    {
      "type": "text",
      "pos": { "x": 10, "y": 50 },
      "sizeX": 276, "sizeY": 30,
      "text": "Hello, ESP32!",
      "fontFamily": "Sora", "fontSize": 16, "fontWeight": 600,
      "enableFill": true, "fill": 100
    }
  ]
}
```

---

## 7. Security Model Summary

| Threat | Mitigation |
|--------|------------|
| Unauthenticated payload deploy | HA Ingress session required on port 8099 — no API token needed |
| SSRF via source URLs | RFC1918 + internal hostname blocklist always enforced; not configurable from the builder — operator-only, via the `allow_private_hosts` add-on configuration option |
| SSRF via img/svg elements | Same RFC1918 blocklist applied to all URL-fetching element types, and the same operator-only `allow_private_hosts` exemption |
| HA entity data leaking | Entities only served on port 8099 (HA session-authenticated); never on port 8000 |
| Oversized payloads | 2 MB body limit; max 500 sources, 2000 top-level / 10,000 total elements, canvas **4096×4096** |
| Runaway render | 30-second pipeline timeout; 10-second per-source timeout |
| Export token abuse | 128-bit cryptographically random token; single-use; 5-minute TTL; max 20 concurrent |

---

## 8. ESP32 Endpoint URLs

**Port 8000 is read-only.** The builder does not call it. These URLs are provided to the user in the HA sidebar so they can configure their ESP32 firmware:

```
GET   http://<HA_IP>:8000/image.png    # PNG preview
POST  http://<HA_IP>:8000/image.bin    # framed 1-bit device reply
```

Both endpoints:
- Return `503` until the first deploy via `PUT ../payload`
- Return `Cache-Control: no-cache` — always serve the latest render
- No auth required (ESP32 devices cannot handle auth headers)

---

## 9. Render / Preview Endpoint

`POST ../render` accepts a full payload and returns the rendered image. By default it renders **without persisting anything to disk** — ideal for live preview during editing. The payload schema is validated at the route boundary before rendering.

```js
const res = await fetch('../render', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
// Returns image/png (or application/octet-stream for misc.format: "bin")
const blob = await res.blob();
const url = URL.createObjectURL(blob);
previewImg.src = url;
```

**Deploy-on-render (`X-Deploy: true`).** Send the request header `X-Deploy: true` to persist the rendered (Zod-validated) payload and its cached image to the target slot in addition to returning the image — equivalent to a deploy. Without the header, nothing is written.

**Slot routing.** Like `PUT ../payload`, `POST ../render` honors `?slot=fullscreen` (query string) or `"slot": "fullscreen"` (body) to target the fullscreen companion; the default is `"primary"`, and an invalid value returns `400`.

`POST ../render/expand` is a related helper that returns the expanded element graph (used by the builder's graph preview); it is rate-limited and validates `payloadSchema` before expansion.

