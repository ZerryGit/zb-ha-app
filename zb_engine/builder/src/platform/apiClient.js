/**
 * apiClient.js — Platform API client for HA Ingress
 *
 * All server communication goes through this module.
 * Uses relative paths + session cookies (no tokens).
 *
 * ENGINEERING_CONSTRAINTS: NO ABSOLUTE PATHS — resolves endpoints relative to the
 * current document path for HA Ingress and reverse-proxy subpaths.
 * ENGINEERING_CONSTRAINTS: HA SESSION AUTH — uses credentials: 'same-origin'.
 */

import { z } from 'zod';
import { registerFontPack, markFontsReady } from '../utils/bitmapFont.js';

// ── Response validation schemas ───────────────────────────────

const widgetIdSchema = z.string().regex(/^[a-z0-9_-]+$/i);
const widgetMetaSchema = z.object({
  id: widgetIdSchema,
  name: z.string(),
  updatedAt: z.number().optional(),
}).passthrough();
const widgetListResponseSchema = z.union([
  z.array(widgetMetaSchema),
  z.object({ widgets: z.array(widgetMetaSchema) }).passthrough(),
]);
const widgetDocResponseSchema = z.object({
  id: widgetIdSchema.optional(),
  name: z.string().optional(),
  doc: z.unknown().optional(),
  fullscreen: z.unknown().nullable().optional(),
  updatedAt: z.number().optional(),
  // Server-assigned pairing IDs (widget envelope, additive). Optional:
  // widgets saved before the pairing feature have neither until re-saved.
  pairingId: z.number().int().positive().optional(),
  fullscreenPairingId: z.number().int().positive().optional(),
}).passthrough();
const widgetSaveResponseSchema = z.object({
  ok: z.literal(true),
  id: widgetIdSchema,
  name: z.string().optional(),
  updatedAt: z.number().optional(),
  // Echoed from the persisted envelope so the builder can render the
  // pairing QR without a follow-up GET.
  pairingId: z.number().int().positive().optional(),
  fullscreenPairingId: z.number().int().positive().optional(),
}).passthrough();
const okResponseSchema = z.object({ ok: z.literal(true) }).passthrough();
const newWidgetIdResponseSchema = z.object({ id: widgetIdSchema }).passthrough();
const expandedPayloadResponseSchema = z.object({
  misc: z.unknown(),
  features: z.unknown(),
  sources: z.unknown(),
  elements: z.array(z.record(z.unknown())),
}).passthrough();
const sourceTestResponseSchema = z.object({
  ok: z.literal(true),
  data: z.unknown().nullable(),
  errors: z.array(z.unknown()),
}).passthrough();
const assetMetaSchema = z.object({
  filename: z.string().regex(/^[a-f0-9-]+\.(svg|png|jpe?g|webp)$/),
  originalName: z.string(),
  mimeType: z.string(),
  size: z.number().nonnegative(),
  uploadedAt: z.number(),
}).passthrough();
const assetListResponseSchema = z.array(assetMetaSchema);
const entityListResponseSchema = z.array(z.unknown());
const historyResponseSchema = z.record(z.unknown());
const hostIpResponseSchema = z.object({
  ip: z.string().nullable(),
  candidates: z
    .array(
      z.object({
        interface: z.string(),
        ip: z.string(),
        primary: z.boolean(),
      }),
    )
    .default([]),
  // Host port the ESP32 image endpoint is mapped to (config.yaml ports:
  // 8000/tcp, remappable in the add-on Network settings). Null when the
  // Supervisor mapping can't be read — the client falls back to the default.
  port: z.number().int().positive().max(65535).nullable().default(null),
}).passthrough();
// Response from the guided self-host `/config` push proxy. `ok:true` means the
// proxy reached the device; `status` is the DEVICE's HTTP status (200 = stored,
// 400 = device rejected the config), so ok:true + status:400 is "device said no".
const deviceConfigResponseSchema = z.object({
  ok: z.literal(true),
  status: z.number().int(),
  configured: z.boolean().optional(),
  body: z.unknown().optional(),
}).passthrough();
const fontListResponseSchema = z.array(z.string().regex(/^[A-Za-z]+_\d+px_[A-Za-z]+\.json$/));

// ── Relative endpoint resolution ───────────────────────────────

/**
 * Return a relative URL for a server endpoint. The builder may be served at
 * the Ingress root (`./`) or under `/builder/`; endpoint paths must stay
 * relative so they remain inside the HA Ingress/reverse-proxy mount.
 */
function endpointPath(path) {
  const clean = String(path).replace(/^\/+/, '');
  const fromBuilderSubpath = /(?:^|\/)builder(?:\/|$)/.test(window.location.pathname);
  return `${fromBuilderSubpath ? '../' : './'}${clean}`;
}

// ── Core fetch wrapper ─────────────────────────────────────────

/**
 * Fetch a server endpoint with relative URL resolution and session cookies.
 *
 * @param {string} path   Server path (e.g. "api/widgets")
 * @param {RequestInit} options  Additional fetch options
 * @returns {Promise<Response>}
 */
export async function apiFetch(path, options = {}) {
  const url = endpointPath(path);
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res;
}

/**
 * Read and validate a JSON response using the shared builder-side pattern.
 * Recoverable malformed responses become ordinary thrown Errors so existing
 * store actions can surface them in UI state instead of crashing the SPA.
 */
export async function readValidatedJson(res, schema, label) {
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Invalid ${label} response from server: expected JSON.`);
  }

  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid ${label} response from server.`);
  }
  return parsed.data;
}

// ── Widget API ─────────────────────────────────────────────────

/** List all widgets (metadata only). */
export async function listWidgets() {
  const res = await apiFetch('api/widgets');
  return readValidatedJson(res, widgetListResponseSchema, 'widget list');
}

/** Load a full widget document by ID. */
export async function loadWidget(id) {
  const res = await apiFetch(`api/widgets/${encodeURIComponent(id)}`);
  return readValidatedJson(res, widgetDocResponseSchema, 'widget');
}

/** Save (create or overwrite) a widget.
 *
 * Accepts either:
 *   saveWidget(id, body)               // body: { name, doc, fullscreen? }
 *   saveWidget(id, name, doc)          // legacy 3-arg form
 *
 * The body form is required to send the optional `fullscreen` companion
 * payload. Pass `fullscreen: null` explicitly to
 * remove a previously-stored companion.
 */
export async function saveWidget(id, nameOrBody, maybeDoc) {
  let body;
  if (nameOrBody !== null && typeof nameOrBody === 'object' && !Array.isArray(nameOrBody)) {
    body = nameOrBody;
  } else {
    body = { name: nameOrBody, doc: maybeDoc };
  }
  const res = await apiFetch(`api/widgets/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return readValidatedJson(res, widgetSaveResponseSchema, 'widget save');
}

/** Delete a widget by ID. */
export async function deleteWidget(id) {
  const res = await apiFetch(`api/widgets/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  return readValidatedJson(res, okResponseSchema, 'widget delete');
}

/** Generate a new widget ID from the server. */
export async function newWidgetId() {
  const res = await apiFetch('api/widgets/new-id');
  const data = await readValidatedJson(res, newWidgetIdResponseSchema, 'new widget ID');
  return data.id;
}

// ── Render API ─────────────────────────────────────────────────

/**
 * Render a preview image from a payload.
 * Returns the raw Response (caller can read PNG blob or headers).
 *
 * @param {object} payload
 * @param {object} [opts]
 * @param {'primary'|'fullscreen'} [opts.slot] Render slot (default 'primary').
 */
export async function renderPreview(payload, opts = {}) {
  const slot = opts.slot ?? 'primary';
  const qs = slot === 'primary' ? '' : `?slot=${encodeURIComponent(slot)}`;
  const res = await fetch(endpointPath(`render${qs}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Render failed: HTTP ${res.status}`);
  }
  return res;
}

/**
 * Expand a payload — returns the full JSON after source resolution and
 * graph expansion, as it would be sent to the draw function.
 */
export async function expandPayload(payload) {
  const res = await fetch(endpointPath('render/expand'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Expand failed: HTTP ${res.status}`);
  }
  return readValidatedJson(res, expandedPayloadResponseSchema, 'expanded payload');
}

/**
 * Deploy a payload — renders and persists both the payload and the image
 * for the given slot.
 *
 * @param {object} payload          Runtime JSON for ONE slot.
 * @param {object} [opts]
 * @param {'primary'|'fullscreen'} [opts.slot]  Target slot. Defaults to
 *        `'primary'` (no query string sent — server applies its own default
 *        for backward compatibility with pre-fullscreen clients).
 *
 * Sends the X-Deploy header so the server persists payload + image cache
 * for that slot. Designed to be called once per slot when a widget has
 * multiple slots (e.g. primary + fullscreen companion).
 */
export async function deployPayload(payload, opts = {}) {
  const { slot } = opts;
  const qs = slot && slot !== 'primary' ? `?slot=${encodeURIComponent(slot)}` : '';
  const res = await fetch(endpointPath(`render${qs}`), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Deploy': 'true' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Deploy failed: HTTP ${res.status}`);
  }
  return res;
}

/** Get the URL for the latest cached PNG preview image.
 *  Slot-aware: pass `'fullscreen'` to read the companion image.
 */
export function getPreviewImageUrl(slot = 'primary') {
  const file = slot === 'fullscreen' ? 'image_fullscreen.png' : 'image.png';
  return endpointPath(`${file}?t=${Date.now()}`);
}

// ── Source test API ────────────────────────────────────────────

/**
 * Test a single source config against the server.
 *
 * @param {object} sourceConfig  Normalized source definition.
 */
export async function testSource(sourceConfig) {
  const res = await apiFetch('render/test-source', {
    method: 'POST',
    body: JSON.stringify(sourceConfig),
  });
  return readValidatedJson(res, sourceTestResponseSchema, 'source test');
}

// ── User asset API ─────────────────────────────────────────────
// Routes mounted by the HA platform adapter (`src/ha/haAssets.ts`).
// Asset references in the payload use the `asset:<uuid>.<ext>` token.
// The server-side render pre-pass resolves these from disk; the builder
// uses these endpoints for the picker UI and live thumbnails.

/**
 * Upload a single file to the asset store. Returns the persisted
 * AssetMeta (filename, originalName, mimeType, size, uploadedAt).
 *
 * Sent as multipart/form-data so the browser sets the boundary header
 * automatically — do NOT manually set Content-Type here, that would
 * strip the boundary and the server's multer parser would reject it.
 *
 * @param {File} file  The browser File object from <input type=file>.
 */
export async function uploadAsset(file) {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(endpointPath('api/assets'), {
    method: 'POST',
    credentials: 'same-origin',
    body: fd,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Upload failed: HTTP ${res.status}`);
  }
  return readValidatedJson(res, assetMetaSchema, 'asset upload');
}

/** List all stored assets, newest-first. Returns AssetMeta[]. */
export async function listAssets() {
  const res = await apiFetch('api/assets');
  return readValidatedJson(res, assetListResponseSchema, 'asset list');
}

/** Delete an asset by its stored (UUID-based) filename. */
export async function deleteAsset(filename) {
  await apiFetch(`api/assets/${encodeURIComponent(filename)}`, { method: 'DELETE' });
}

/**
 * Build the relative URL for the authenticated raw-bytes endpoint.
 * Suitable for `<img src>` thumbnails — browsers send the Ingress
 * session cookie automatically.
 */
export function assetRawUrl(filename) {
  return endpointPath(`api/assets/${encodeURIComponent(filename)}/raw`);
}

// ── HA Entity API ──────────────────────────────────────────────

/**
 * Fetch the full HA entity state list from the server.
 * Returns an array of entity objects with current state and attributes.
 * Only available when running as an HA add-on.
 */
export async function fetchEntities() {
  const res = await apiFetch('entities');
  return readValidatedJson(res, entityListResponseSchema, 'entity list');
}

/**
 * Fetch state history for one or more HA entities.
 *
 * @param {string[]} entityIds  Array of entity IDs (e.g. ["sensor.temp"])
 * @param {number}   hoursBack  Lookback window in hours (1–168, default 24)
 * @returns {Promise<Record<string, object>>} Map of entity_id → HaHistoryResult
 */
export async function fetchEntityHistory(entityIds, hoursBack = 24) {
  const params = new URLSearchParams({
    entity_ids: entityIds.join(','),
    hours: String(hoursBack),
  });
  const res = await apiFetch(`history?${params}`);
  return readValidatedJson(res, historyResponseSchema, 'entity history');
}

/**
 * Fetch the Home Assistant host's best-guess LAN IPv4 address (plus any
 * alternative interface candidates) so the UI can show ESP32 devices a
 * reachable "http://<ip>:8000/image.bin" URL. Devices generally cannot
 * resolve the "homeassistant.local" mDNS name, hence the numeric form.
 *
 * Only meaningful when running as an HA add-on (with hassio_api access);
 * the server route returns `{ ip: null, candidates: [] }` if no LAN
 * interface could be determined.
 *
 * @returns {Promise<{ ip: string|null, candidates: Array<{ interface: string, ip: string, primary: boolean }> }>}
 */
export async function fetchHostIp() {
  const res = await apiFetch('api/host-ip');
  return readValidatedJson(res, hostIpResponseSchema, 'host IP');
}

// ── Device config push API ─────────────────────────────────────
// Route mounted by the HA platform adapter on the Ingress port only
// (`src/ha/haDevice.ts`). Proxies the self-host `/config` POST to a LAN
// device so the browser never talks to the ESP32 directly.

/**
 * Proxy a self-host config POST to a LAN device via the add-on backend.
 * No `port`: the device setup server is fixed at :80 server-side.
 *
 * `apiFetch` throws a typed Error on any non-2xx proxy response (400 for a
 * bad IP/config, 502 when the device is unreachable), so callers can surface
 * `err.message` directly. A resolved value means the proxy reached the device;
 * inspect `.status`/`.configured` to learn whether the DEVICE accepted it.
 *
 * @param {{ deviceIp: string, config: object }} args
 * @returns {Promise<{ ok: true, status: number, configured?: boolean, body?: unknown }>}
 */
export async function pushDeviceConfig({ deviceIp, config }) {
  const res = await apiFetch('api/device/config', {
    method: 'POST',
    body: JSON.stringify({ deviceIp, config }),
  });
  return readValidatedJson(res, deviceConfigResponseSchema, 'device config push');
}

// ── Bitmap font loading ────────────────────────────────────────

/**
 * Load all bitmap font packs from the server and register them
 * into the bitmapFont cache for pixel-accurate text preview.
 *
 * Fetches /api/fonts (file list) then each font JSON in parallel.
 * Uses the platform-aware fetch wrapper to stay within the current
 * Ingress/reverse-proxy mount.
 */
export async function loadBitmapFonts() {
  try {
    const listRes = await apiFetch('api/fonts');
    const files = await readValidatedJson(listRes, fontListResponseSchema, 'font list');
    const pattern = /^(.+)_(\d+)px_(\w+)\.json$/;

    const tasks = files.map(async (file) => {
      const match = file.match(pattern);
      if (!match) return;
      const family = match[1].toLowerCase();
      const size = match[2];
      const weight = match[3];
      const key = `${family}-${size}-${weight}`;

      const fontRes = await apiFetch(`api/fonts/${encodeURIComponent(file)}`);
      const raw = await fontRes.json();
      registerFontPack(key, raw);
    });

    await Promise.all(tasks);
    markFontsReady();
  } catch (err) {
    console.warn('[apiClient] Bitmap font loading failed:', err);
    // Mark fonts as ready even on failure so the app doesn't hang
    // waiting for fonts indefinitely. Text preview will degrade gracefully.
    markFontsReady();
  }
}
