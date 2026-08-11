/**
 * limits.ts — Centralised runtime limits and thresholds
 *
 * Every tunable constant that controls request sizes, timeouts, capacities,
 * or processing bounds lives here. This file MUST NOT import from any other
 * src/ module to avoid circular dependencies.
 *
 * Grouped by domain so security audits and configuration reviews can scan
 * a single file.
 */

// ── Request / body limits ──────────────────────────────────────

/** Maximum JSON request body size accepted by Express. */
export const MAX_REQUEST_BODY = "2mb";

/**
 * Maximum body size accepted on the device-facing `POST /image.bin`
 * endpoint (port 8000). The ESP32 self-host contract sends a small JSON
 * telemetry body, but this add-on has no telemetry→render
 * channel — the body is never parsed for meaning, only drained up to this
 * bound to prevent a large POST from exhausting resources on the
 * unauthenticated port.
 */
export const MAX_DEVICE_REQUEST_BODY_BYTES = 4 * 1024; // 4 KiB

// ── Export tokens ──────────────────────────────────────────────

/** How long an export token remains valid (ms). */
export const EXPORT_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum number of live (unexpired) export tokens. */
export const MAX_EXPORT_TOKENS = 20;

/** Interval between automatic export-token purge sweeps (ms). */
export const EXPORT_PURGE_INTERVAL_MS = 60_000; // 1 minute

// ── Payload structure ──────────────────────────────────────────
// Structural bounds enforced on the raw payload BEFORE the recursive Zod
// parse, so a deeply nested or pathologically large `group` tree cannot
// blow the stack (RangeError) or exhaust memory during validation.

/**
 * Maximum `group` nesting depth (top-level elements are depth 1). Real
 * widgets nest a handful of levels at most; 32 is far above any legitimate
 * layout while still bounding stack usage during the recursive parse.
 */
export const MAX_ELEMENT_NESTING_DEPTH = 32;

/**
 * Maximum total element count across the whole tree, counting every nested
 * `group` child. The top-level array is separately capped at 2000; this
 * bounds the fan-out a nested tree can add on top of that.
 */
export const MAX_TOTAL_ELEMENTS = 10_000;

/**
 * Maximum `sources[]` entries in one payload. Mirrored in the builder as
 * `MAX_SOURCES` in `builder/src/store/docStore.js` (the two install trees
 * don't share code — keep them in sync).
 */
export const MAX_SOURCES = 500;

// ── Render pipeline ────────────────────────────────────────────

/** Abort a render if it exceeds this duration (ms). */
export const RENDER_TIMEOUT_MS = 30_000; // 30 seconds

/** Maximum elements after graph expansion — prevents OOM. */
export const MAX_EXPANDED_ELEMENTS = 50_000;

/**
 * Maximum lines one text element may be wrapped into. Far above any real
 * layout, far below the million-entry array a 200 KB value in a 20 px frame
 * would otherwise build before the render timeout noticed. On hitting it,
 * `data/textLayout.ts` stops wrapping and emits the remainder as one line.
 */
export const MAX_WRAPPED_LINES = 4096;

// ── Geometry bounds ────────────────────────────────────────────

/**
 * COARSE, SCHEMA-ONLY absolute cap for LITERAL geometry values
 * (sizeX/sizeY/strokeWidth/pos/line points), enforced at Zod validation to
 * fail-fast on non-finite / absurd numeric literals. Deliberately LOOSER than
 * the render-time clamp so an in-band-but-oversize literal (e.g. a line point
 * of 5000 used with a negative pos) is ACCEPTED and then bounded by the
 * pre-render geometry clamp rather than rejected outright.
 *
 * The pre-render geometry clamp (`data/geometryClamp.ts`) bounds RESOLVED
 * sizes, strokeWidth AND coordinates to `MAX_RASTER_AXIS` (canvas scale), so
 * this constant is NOT used at runtime — only by `schema/elementSchema.ts`.
 */
export const MAX_GEOMETRY_COORD = 100_000;

// ── Source fetching ────────────────────────────────────────────

/** Maximum per-source fetch timeout (ms). */
export const MAX_SOURCE_TIMEOUT_MS = 10_000; // 10 seconds

/** Maximum total time to receive and read one source response body (ms). */
export const MAX_SOURCE_TOTAL_TIMEOUT_MS = 30_000; // 30 seconds

/** Maximum automatic retries for a failing source fetch. */
export const MAX_SOURCE_RETRIES = 3;

/** Maximum response body size for a single source fetch (bytes). */
export const MAX_SOURCE_RESPONSE_BYTES = 1 * 1024 * 1024; // 1 MiB

/** Maximum source fetches in flight during one render/source-test pipeline. */
export const MAX_SOURCE_CONCURRENCY = 4;

// ── HA Supervisor history fetches ──────────────────────────────
// HA history calls go through the local supervisor and not arbitrary
// external hosts, so the byte ceiling is larger than `MAX_SOURCE_RESPONSE_BYTES`.
// Per-entity and total-batch point caps still bound memory + CPU on a Pi.

/** Maximum response body size for ONE HA Supervisor history call (bytes). */
export const MAX_HA_HISTORY_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MiB

/** Maximum data points kept per entity AFTER LTTB downsampling. */
export const MAX_HA_HISTORY_POINTS_PER_ENTITY = 2_000;

/** Maximum data points kept across all entities in one /history batch. */
export const MAX_HA_HISTORY_TOTAL_POINTS = 20_000;

// ── CSV parsing ────────────────────────────────────────────────

/** Maximum columns (headers) allowed in CSV parsing. */
export const MAX_CSV_COLUMNS = 500;

/** Maximum data rows (excluding header) allowed in CSV parsing. */
export const MAX_CSV_ROWS = 50_000;

// ── Expressions ────────────────────────────────────────────────
//
// Note: `MAX_RESOLVE_DEPTH` is owned by the `@zb/expressions` workspace
// package and exported from there. It used to live here as well, but
// that created two competing definitions of the same limit. Import it
// from `@zb/expressions` if you need it.

// ── DNS resolution ─────────────────────────────────────────────

/** Timeout for DNS lookups during URL validation (ms). */
export const DNS_LOOKUP_TIMEOUT_MS = 5_000; // 5 seconds

// ── Rate limiting ──────────────────────────────────────────────

/** Sliding window for the rate limiter (ms). */
export const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

/** Maximum requests per window for mutation endpoints (write, render, export). */
export const RATE_LIMIT_MUTATION = 60;

/** Maximum requests per window for source-test endpoint (triggers outbound HTTP). */
export const RATE_LIMIT_SOURCE_TEST = 30;

/** Maximum requests per window for render expansion endpoint (source resolution + graph expansion). */
export const RATE_LIMIT_RENDER_EXPAND = RATE_LIMIT_SOURCE_TEST;

/**
 * Maximum requests per window for the HA Supervisor proxy routes
 * (`/entities`, `/history`). Each call fans out to the Supervisor API, so the
 * cap protects both this add-on and the Supervisor from being hammered by a
 * misbehaving (but authenticated) Ingress client.
 */
export const RATE_LIMIT_HA_PROXY = 60;

/**
 * Maximum requests per window for the guided Self-Host device-config proxy
 * (`POST /api/device/config`). Each call makes the server POST to a LAN device,
 * so the cap bounds the outbound blast radius even for an authenticated caller.
 */
export const RATE_LIMIT_DEVICE_CONFIG = 20;

/** Timeout for the guided device `/config` POST proxy fetch (ms). */
export const DEVICE_CONFIG_TIMEOUT_MS = 10_000; // 10 seconds

// ── Graph normalisation ────────────────────────────────────────

/** Default maximum data points after LTTB downsampling. */
export const DEFAULT_MAX_GRAPH_POINTS = 200;

/** Maximum horizontal grid divisions a graph can expand into. */
export const MAX_GRAPH_GRID_LINES = 100;

/** Maximum manually requested X-axis label ticks per graph. */
export const MAX_GRAPH_X_AXIS_LABELS = 500;

// ── Widget storage ─────────────────────────────────────────────
// Bound the number and aggregate size of stored widget documents so an
// authenticated user cannot exhaust the /data volume (host disk DoS).
// Enforced in `core/widgetService.ts:writeWidget` under a write mutex.

/** Maximum number of stored widgets. */
export const MAX_WIDGET_COUNT = 500;

/** Total disk budget across all stored widget documents (bytes). */
export const MAX_WIDGETS_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB

// ── User assets ────────────────────────────────────────────────
// Limits for user-uploaded image / SVG assets (Home Assistant platform).
// Centralised here per ENGINEERING_CONSTRAINTS §6 (single source of truth).

/** Per-file upload cap (bytes). */
export const MAX_ASSET_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB

/** Total disk budget across all stored assets (bytes). */
export const MAX_ASSETS_TOTAL_BYTES = 50 * 1024 * 1024; // 50 MiB

/** Maximum number of stored assets. */
export const MAX_ASSET_COUNT = 200;

/**
 * Hard cap on user-uploaded SVG source size.
 * Lower than the engine's `MAX_INLINE_SVG_BYTES` (1 MiB) so user-supplied
 * SVGs are bounded more tightly than payload-embedded ones — matches the
 * 500 KB ceiling called out in ENGINEERING_CONSTRAINTS XML §9.
 */
export const MAX_USER_SVG_BYTES = 500 * 1024;

/** Maximum upload requests per window per session. */
export const RATE_LIMIT_UPLOAD = 20;
