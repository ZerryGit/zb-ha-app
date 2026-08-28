/**
 * imageApp.ts — On-demand image serving app for port 8000
 *
 * Extracted from ha/index.ts for testability. Encapsulates the image
 * buffer state, cooldown logic, and on-demand render triggering in a
 * dependency-injected factory that can be exercised with mock adapters.
 *
 * Security invariants (ENGINEERING_CONSTRAINTS HA3, §11, §13):
 *   - Unauthenticated by design (ESP32 has no auth capability)
 *   - Strictest CSP: default-src 'none'
 *   - X-Frame-Options: DENY (no legitimate framing use)
 *   - GET/HEAD only on `.png` (preview); POST only on `.bin` (device reply).
 *     Method handling is per-route (see `registerImageRoutes`) — the bare
 *     app from `createImageApp()` no longer enforces a blanket method
 *     guard, since the multi-device design requires POST to be
 *     valid on some paths and not others.
 *   - The `.bin` POST body is size-capped and parsed ONLY as an optional
 *     Zod-validated render selector (`requestedInstances` — the pairing
 *     multi-frame path). There is still no telemetry→render channel: any
 *     other body — empty, non-JSON, the ESP32 telemetry blob — is drained
 *     and ignored, byte-identical to the pre-pairing contract, and nothing
 *     from the body is ever persisted.
 */

import express from "express";
import { createHash } from "crypto";
import { z } from "zod";
import type { RenderGuard } from "../core/renderService";
import type {
  RenderMeta,
  Slot,
  DeviceId,
  WidgetDoc,
  DeviceTelemetryContext,
  DeviceTelemetryFields,
} from "../core/adapters";
import {
  DEFAULT_DEVICE_ID,
  assertValidDeviceId,
  buildDeviceContext,
  ABSENT_DEVICE_CONTEXT,
} from "../core/adapters";
import {
  MAX_DEVICE_REQUEST_BODY_BYTES,
  MAX_PAIRING_BUFFER_CACHE,
  MAX_REQUESTED_INSTANCES,
} from "../limits";
import { buildFramedReply } from "./imageFrame";
import type { ResolvePairing } from "./pairingResolver";
import { logInfo, logWarn } from "../core/logger";

// ── Pairing multi-frame request classification ─────────────────

/**
 * Body schema for the pairing-based multi-frame request. The per-ID floor
 * of 1 is DELIBERATELY wider than the generator's 100_000_000 floor
 * (`core/widgetService.ts`) — a low ID is a well-formed request that
 * answers `status = 0`, not a 400; request validation stays decoupled
 * from ID-generation policy. Length is validated on the RAW array, before
 * dedup.
 */
const requestedInstancesSchema = z.object({
  requestedInstances: z
    .array(z.number().int().min(1).max(4_294_967_295))
    .min(1)
    .max(MAX_REQUESTED_INSTANCES),
});

// ── Device telemetry extraction (plan 4, D1) ───────────────────

/**
 * ONE small schema PER FIELD, applied independently — an object-level
 * `.safeParse` would be all-or-nothing, which is exactly what D1 forbids.
 * Bounds are the owner-locked ranges: an out-of-range value is a sensor
 * glitch, not a firmware contract change, so it nulls its own field and
 * leaves its siblings alone.
 *
 * Field NAMES and types are frozen by the firmware contract; VALUES are not.
 *
 * Temperature and pressure come in TWO SHAPES: the firmware sends
 * `tempC`/`pressureHpa` when `units:"metric"` and `tempF`/`pressureInhg` when
 * `units:"imperial"`. Both pairs are read RAW — no conversion, and no
 * branching on `units`, so whichever keys are present simply validate. A panel
 * populates one of each pair and leaves the other null.
 *
 * The imperial bounds are the metric ones expressed in the other unit
 * (−90…90 °C = −130…194 °F; 300…1200 hPa ≈ 8.85…35.45 inHg), so both shapes
 * accept exactly the same physical range.
 */
const telemetryFieldSchemas = {
  battery: z.number().finite().min(0).max(100),
  charging: z.boolean(),
  units: z.enum(["metric", "imperial"]),
  tempC: z.number().finite().min(-90).max(90),
  tempF: z.number().finite().min(-130).max(194),
  humidity: z.number().finite().min(0).max(100),
  pressureHpa: z.number().finite().min(300).max(1200),
  pressureInhg: z.number().finite().min(8.85).max(35.45),
} as const;

/** Telemetry pulled from one already-parsed body. */
interface ExtractedTelemetry {
  device: DeviceTelemetryContext;
  /** Field NAMES that failed validation — never values (D7). */
  rejectedFields: string[];
}

const ABSENT_TELEMETRY: ExtractedTelemetry = {
  device: ABSENT_DEVICE_CONTEXT,
  rejectedFields: [],
};

/**
 * Canonical telemetry identity — the SAME string D4 feeds into the
 * render-result cache key, so "different telemetry" means exactly the same
 * thing on both sides. `buildDeviceContext`'s fixed key order is what makes a
 * plain `JSON.stringify` canonical here; a caller passing nothing hashes
 * identically to the explicit absent state.
 */
function deviceStateKey(device?: DeviceTelemetryContext | null): string {
  return JSON.stringify(device ?? ABSENT_DEVICE_CONTEXT);
}

/**
 * Extract the `device` namespace from an already-parsed `.bin` POST body.
 *
 * Runs for BOTH body classes off the SAME single parse — a legacy telemetry
 * wake and a `requestedInstances` request are treated identically here.
 *
 * `telemetry` missing or not a plain object → the absent state. Otherwise each
 * KNOWN field validates on its own; unknown keys are ignored (the body already
 * grew `requestedInstances` once, so never assume it stops growing). An absent
 * field is simply null and is NOT reported as rejected — only a field that was
 * present and failed its schema is.
 */
function extractDeviceTelemetry(parsed: Record<string, unknown>): ExtractedTelemetry {
  const telemetry = parsed["telemetry"];
  if (typeof telemetry !== "object" || telemetry === null || Array.isArray(telemetry)) {
    return ABSENT_TELEMETRY;
  }

  const raw = telemetry as Record<string, unknown>;
  const fields: Partial<DeviceTelemetryFields> = {};
  const rejectedFields: string[] = [];

  for (const [name, schema] of Object.entries(telemetryFieldSchemas)) {
    if (!Object.prototype.hasOwnProperty.call(raw, name)) continue;
    const result = schema.safeParse(raw[name]);
    if (result.success) {
      // Each key is its own schema, so the union widens to unknown here.
      (fields as Record<string, unknown>)[name] = result.data;
    } else {
      rejectedFields.push(name);
    }
  }

  return { device: buildDeviceContext(fields), rejectedFields };
}

/** Classification of a `.bin` POST body. */
type DeviceBodyClass =
  | ({ kind: "legacy" } & ExtractedTelemetry)
  | { kind: "invalid" }
  | ({ kind: "instances"; ids: number[] } & ExtractedTelemetry);

/**
 * Decide which path a `.bin` POST body takes, and pull the `device` telemetry
 * namespace out of the SAME single parse:
 *  - a JSON object WITH `requestedInstances` that validates → the streamed
 *    multi-frame path (duplicates deduped, first occurrence wins);
 *  - a JSON object WITH the key but INVALID → 400. Only new firmware/app
 *    code can produce this — fail loud, no internal detail in the message;
 *  - everything else — empty body, non-JSON, JSON without the key (today's
 *    ESP32 telemetry blob) → the legacy single-frame path, byte-identical
 *    to the pre-pairing contract. Old firmware is never 4xx'd.
 *
 * Telemetry NEVER changes the classification and never rescues a bad
 * selector: the `requestedInstances` 400 rule takes precedence and is
 * unchanged (D1). A body that cannot yield telemetry simply carries the
 * canonical absent state, so every caller gets a `device` object.
 *
 * Exported for testing.
 */
export function classifyDeviceRequestBody(body: unknown): DeviceBodyClass {
  if (!Buffer.isBuffer(body) || body.length === 0) return { kind: "legacy", ...ABSENT_TELEMETRY };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return { kind: "legacy", ...ABSENT_TELEMETRY };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "legacy", ...ABSENT_TELEMETRY };
  }

  const telemetry = extractDeviceTelemetry(parsed as Record<string, unknown>);

  if (!Object.prototype.hasOwnProperty.call(parsed, "requestedInstances")) {
    return { kind: "legacy", ...telemetry };
  }

  const result = requestedInstancesSchema.safeParse(parsed);
  if (!result.success) return { kind: "invalid" };
  return { kind: "instances", ids: [...new Set(result.data.requestedInstances)], ...telemetry };
}

// ── Bare image app (security middleware only) ──────────────────

/**
 * Create the image-port Express app with security middleware.
 *
 * Exported for testing. The middleware stack is self-contained: security
 * headers only. Method handling is a per-route concern — routes are
 * registered by the caller after creation (see `registerImageRoutes` for
 * the get+all-405-catchall / post+all-405-catchall pattern this app uses).
 */
export function createImageApp(): express.Application {
  const app = express();

  // Express auto-generates a weak ETag on any res.send() that doesn't
  // already carry one. Disabling it here means only routes that explicitly
  // set their own (the GET .png strong SHA1 ETag) ever emit one — the POST
  // .bin framed reply and every error response (405/413/503) stay free of
  // an incidental, functionally-inert caching header.
  app.disable("etag");

  // Prevent MIME sniffing and add security headers (ENGINEERING_CONSTRAINTS §11, §13)
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // DENY — image-only endpoint has no legitimate framing use
    res.setHeader("X-Frame-Options", "DENY");
    // No resource loading needed — strictest possible CSP
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
  });

  return app;
}

// ── Full on-demand image app ───────────────────────────────────

/** Dependencies injected into the on-demand image app factory. */
export interface OnDemandDeps {
  renderGuard: RenderGuard;
  /** Read the persisted payload for a device + slot. */
  readPayload: (slot: Slot, deviceId: DeviceId) => Promise<unknown | null>;
  runPipeline: (
    raw: unknown,
    device?: DeviceTelemetryContext | null,
  ) => Promise<{ pngBuffer: Buffer; binBuffer: Buffer; meta: RenderMeta }>;
  /**
   * Per-(device,slot) minimum interval between on-demand renders triggered
   * by a port-8000 request. Defaults to 4000 ms (legacy behavior).
   * Configurable via the HA add-on `image_port_cooldown_ms` option.
   */
  cooldownMs?: number;
  /**
   * Render policy for port 8000:
   *  - `"on-demand"` (default): each request may trigger a fresh render
   *    once the per-(device,slot) cooldown elapses.
   *  - `"cache-only"`: requests only serve whatever buffer is currently in
   *    memory; rendering is driven by the Ingress UI and the periodic
   *    re-render timer. Configurable via the HA add-on `image_port_mode`
   *    option.
   */
  mode?: "on-demand" | "cache-only";
  /**
   * Resolve a pairing ID to its (widget, slot) target for the
   * `requestedInstances` POST body (see `ha/pairingResolver.ts`).
   * Optional: when absent, every requested instance is unavailable
   * (`status = 0`).
   */
  resolvePairing?: ResolvePairing;
  /**
   * Read a SAVED widget envelope by ID (`core/widgetService.readWidget`
   * bound to the platform storage). Used only by the pairing render path —
   * paired widgets render from their saved doc, no deploy step involved.
   */
  readWidget?: (widgetId: string) => Promise<WidgetDoc | null>;
}

/** Handle returned by the factory — includes the app and buffer controls. */
export interface OnDemandImageApp {
  app: express.Application;
  /**
   * Pre-set the in-memory image buffer for a device + slot and reset its
   * cooldown (startup warm-up). `meta` is cached alongside the buffers
   * because the framed device reply needs `width`/`height` at serve time,
   * potentially long after the render that produced them. `slot`/`deviceId`
   * default to `"primary"`/the default device for backward compatibility.
   */
  setBuffer(png: Buffer, bin: Buffer, meta: RenderMeta, slot?: Slot, deviceId?: DeviceId): void;
  /**
   * Get the current in-memory image buffer for a device + slot, or null if
   * it has not yet been rendered.
   */
  getBuffer(slot?: Slot, deviceId?: DeviceId): { png: Buffer; bin: Buffer } | null;
  /**
   * Drop a device + slot's in-memory buffer and reset its cooldown. Used
   * when a companion is removed so the next request starts cleanly.
   */
  evictSlot(slot: Slot, deviceId?: DeviceId): void;
}

/** Composite key so a render of one device/slot never collides with another. */
function bufferKey(deviceId: DeviceId, slot: Slot): string {
  return `${deviceId}:${slot}`;
}

/**
 * Create the full on-demand image app with the bare `/image.*` routes for
 * both the primary and fullscreen slots (a single device on port 8000).
 *
 * `GET .png` is the read-only builder/ESP32 preview path. `POST .bin` is the
 * device-facing framed reply: the *cached* rendered
 * bin buffer is wrapped with a fresh 25-byte header (including the live
 * clock) on every response — never cached itself, and never subject to a
 * 304, since the clock makes every response body unique.
 *
 * Each slot has its own in-memory buffer and cooldown timestamp so a render
 * of one does not affect serving or cooldown of the other. The process-global
 * `RenderGuard` still serializes actual renders (ENGINEERING_CONSTRAINTS §12)
 * — only the per-response framing is cheap enough to redo on every request.
 */
export function createOnDemandImageApp(deps: OnDemandDeps): OnDemandImageApp {
  const {
    renderGuard,
    readPayload,
    runPipeline,
    cooldownMs = 4_000,
    mode = "on-demand",
    resolvePairing,
    readWidget,
  } = deps;

  const buffers = new Map<string, { png: Buffer; bin: Buffer; meta: RenderMeta }>();
  const lastRenderAt = new Map<string, number>();
  /**
   * Telemetry identity of the buffer currently cached for each key — the same
   * canonical string D4 uses for the render-result cache key.
   *
   * Drives the cooldown bypass (plan 4, D4 case 1 — REVISED 2026-08-26, owner):
   * a wake must be answered with a frame rendered from ITS OWN telemetry, never
   * the previous wake's. When an incoming POST's telemetry differs from what
   * the cached buffer was rendered with, the per-key cooldown is skipped so the
   * device gets its own data back. Identical repeats still dedupe normally, so
   * a panel that keeps reporting the same readings costs nothing extra.
   *
   * Kept in lockstep with `lastRenderAt` — every site that sets or deletes one
   * does the same to the other, so this cannot outgrow the buffer map.
   */
  const lastRenderDeviceKey = new Map<string, string>();
  /**
   * Strong ETag per (device, slot, format). Recomputed on every buffer
   * mutation (setBuffer + on-demand render success). Used only by the GET
   * `.png` route — the POST `.bin` route never does conditional-GET (see
   * `registerImageRoutes`), since the live clock in every framed reply
   * makes the body unique regardless of image content.
   */
  const etags = new Map<string, string>(); // key = `${deviceId}:${slot}:${format}`

  function etagKey(key: string, format: "png" | "bin"): string {
    return `${key}:${format}`;
  }
  function computeEtag(buf: Buffer): string {
    return `"sha1-${createHash("sha1").update(buf).digest("hex")}"`;
  }
  function refreshEtags(key: string, png: Buffer, bin: Buffer): void {
    etags.set(etagKey(key, "png"), computeEtag(png));
    etags.set(etagKey(key, "bin"), computeEtag(bin));
  }

  const app = createImageApp();

  /**
   * Bound and capture the `.bin` POST body (4 KiB cap). The body is read
   * for exactly one purpose: `classifyDeviceRequestBody` may recognise a
   * `requestedInstances` render selector. Everything else — the ESP32
   * telemetry blob included — is ignored; there is no telemetry→render
   * channel. `type: () => true` accepts any (or no) Content-Type so the
   * body is always drained up to the cap and never left to grow unbounded.
   */
  const captureDeviceRequestBody = express.raw({ limit: MAX_DEVICE_REQUEST_BODY_BYTES, type: () => true });

  /**
   * Attempt a fresh on-demand render for a device + slot. Updates that
   * pair's in-memory buffer and cooldown timestamp on success. Cooldowns
   * are tracked per (device, slot) so devices/slots never rate-limit each
   * other; the RenderGuard is process-global (one render at a time across
   * everything, per ENGINEERING_CONSTRAINTS §12).
   */
  async function tryOnDemandRender(
    deviceId: DeviceId,
    slot: Slot,
    device?: DeviceTelemetryContext | null,
  ): Promise<boolean> {
    // Cache-only mode: the unauthenticated port never drives renders.
    // The Ingress UI and the periodic re-render timer remain the only
    // render triggers. Stops a LAN-side flood from creating CPU load.
    if (mode === "cache-only") return false;

    const key = bufferKey(deviceId, slot);
    const deviceKey = deviceStateKey(device);

    // Gate 1: per-(device,slot) cooldown — skip if this pair rendered recently.
    // BYPASSED when the incoming telemetry differs from what the cached buffer
    // was rendered with (D4 case 1, revised): a wake must be answered with its
    // OWN readings, not the previous wake's. Repeats carrying identical
    // telemetry still hit the cooldown, so a quiet panel costs nothing.
    //
    // Only a caller that actually REPORTS a telemetry state may bypass. A
    // caller that passes nothing — the GET `.png` preview, the timer, the
    // startup warm-up — is not reporting an absent panel, it is not reporting
    // at all, and reading its `undefined` as "telemetry changed" is a bug: a
    // `.png` GET after a telemetry wake rendered straight through the cooldown
    // and then stamped the absent state, so the NEXT wake differed from THAT
    // and bypassed too. The two endpoints ping-ponged the recorded key and the
    // cooldown stopped applying to either. A wake whose body carries no
    // telemetry still reports (the absent context object), so it is unaffected.
    const cooled = Date.now() - (lastRenderAt.get(key) ?? 0) >= cooldownMs;
    const telemetryChanged = device != null && lastRenderDeviceKey.get(key) !== deviceKey;
    if (!cooled && !telemetryChanged) return false;

    // Gate 2: global concurrency — skip if any render is in progress
    const release = renderGuard.tryAcquire();
    if (!release) return false;

    try {
      const payload = await readPayload(slot, deviceId);
      if (!payload) {
        // Payload missing on disk → companion/device was removed (or never
        // existed). Drop any cached buffer so subsequent requests get the
        // canonical 503 response instead of a stale image. Cheap to call
        // when there is nothing cached.
        buffers.delete(key);
        etags.delete(etagKey(key, "png"));
        etags.delete(etagKey(key, "bin"));
        return false;
      }

      logInfo("render.start", {
        surface: "image",
        slot,
        deviceId,
        deviceTelemetryApplied: device?.present === true,
      });
      const { pngBuffer, binBuffer, meta } = await runPipeline(payload, device);
      buffers.set(key, { png: pngBuffer, bin: binBuffer, meta });
      lastRenderAt.set(key, Date.now());
      lastRenderDeviceKey.set(key, deviceKey);
      refreshEtags(key, pngBuffer, binBuffer);

      logInfo("render.finish", {
        surface: "image",
        slot,
        deviceId,
        deviceTelemetryApplied: meta.deviceTelemetryApplied,
        renderTimeMs: meta.renderTimeMs,
        sourceErrorCount: meta.sourceErrors.length,
        renderErrorCount: meta.renderErrors.length,
        pngBytes: pngBuffer.length,
        binBytes: binBuffer.length,
      });
      if (meta.renderErrors.length > 0) {
        logWarn("render.element.warning", {
          surface: "image",
          slot,
          deviceId,
          count: meta.renderErrors.length,
          errors: meta.renderErrors,
        });
      }
      if (meta.sourceErrors.length > 0) {
        logWarn("source.fetch.failure", {
          surface: "image",
          slot,
          deviceId,
          count: meta.sourceErrors.length,
          errors: meta.sourceErrors,
        });
      }
      return true;
    } catch (err) {
      logWarn("render.failed", { surface: "image", slot, deviceId, error: err });
      return false;
    } finally {
      release();
    }
  }

  // ── Pairing-based multi-frame path ───────────────────────────

  /**
   * Cache key for a paired instance. Shares the `buffers` map with the
   * `<deviceId>:<slot>` keys from `bufferKey`, and two SEPARATE arguments keep
   * the two namespaces apart — they are not the same argument:
   *
   *  - EXACT keys never collide, because `slot` is only ever
   *    "primary"/"fullscreen", never numeric.
   *  - The `pairing:` PREFIX is unambiguous only because this port serves the
   *    single hardcoded `DEFAULT_DEVICE_ID`. `assertValidDeviceId` accepts the
   *    id "pairing" quite happily, and `bufferKey("pairing", "primary")` then
   *    starts with this prefix too — so `evictPairingOverflow`'s prefix scan is
   *    what breaks FIRST if the port ever grows per-device routes. Give the
   *    pairing entries their own Map at that point; a longer prefix only moves
   *    the same trap.
   */
  function pairingKey(pairingId: number): string {
    return `pairing:${pairingId}`;
  }

  /**
   * Drop the least-recently-rendered pairing-cache entries above
   * `MAX_PAIRING_BUFFER_CACHE` (head of Map iteration order, which
   * `tryPairingRender` keeps in LRU order by re-inserting on every write) so
   * hundreds of paired widgets cannot grow RAM unbounded. Device-slot keys are never
   * touched — see `pairingKey` for why the prefix alone is enough to tell the
   * two namespaces apart today, and what would invalidate that.
   */
  function evictPairingOverflow(): void {
    const pairingKeys = [...buffers.keys()].filter((k) => k.startsWith("pairing:"));
    let excess = pairingKeys.length - MAX_PAIRING_BUFFER_CACHE;
    for (const key of pairingKeys) {
      if (excess <= 0) break;
      buffers.delete(key);
      lastRenderAt.delete(key);
      lastRenderDeviceKey.delete(key);
      excess--;
    }
  }

  /**
   * Attempt a fresh render for one paired instance. Mirrors
   * `tryOnDemandRender` (cache-only short-circuit, per-instance cooldown,
   * global RenderGuard), but renders from the SAVED widget doc resolved
   * via the pairing ID — no deploy step for paired widgets. No ETags:
   * pairing buffers are only ever served inside a framed multi-frame
   * reply, never via conditional GET.
   */
  async function tryPairingRender(
    pairingId: number,
    device?: DeviceTelemetryContext | null,
  ): Promise<void> {
    // This function is the ONLY writer of `pairing:*` buffers — `setBuffer`
    // fills device-slot keys only — so in cache-only mode a pairing buffer can
    // never exist and EVERY paired instance answers `status = 0` for as long
    // as the mode is set. That is the mode working as specified (the port
    // renders nothing), not a warm-up window that eventually fills: the two
    // features are incompatible by construction. `ha/index.ts` warns at
    // startup when paired widgets exist under this mode; see DOCS.md →
    // "Widget pairing (QR)".
    if (mode === "cache-only") return;
    if (!resolvePairing || !readWidget) return;

    const key = pairingKey(pairingId);
    const deviceKey = deviceStateKey(device);
    // Same cooldown bypass as tryOnDemandRender, including the "only a caller
    // that reports may bypass" rule — see the comment there. Today the only
    // call site is the POST stream, which always reports, but the predicate is
    // kept identical so a future caller cannot reintroduce the ping-pong.
    const cooled = Date.now() - (lastRenderAt.get(key) ?? 0) >= cooldownMs;
    const telemetryChanged = device != null && lastRenderDeviceKey.get(key) !== deviceKey;
    if (!cooled && !telemetryChanged) return;

    const release = renderGuard.tryAcquire();
    if (!release) return;

    try {
      const target = await resolvePairing(pairingId);
      if (!target) {
        // Unknown ID, or the widget was deleted: drop any stale cache so
        // the reply is status = 0 rather than a ghost frame.
        buffers.delete(key);
        lastRenderAt.delete(key);
        lastRenderDeviceKey.delete(key);
        return;
      }

      const widget = await readWidget(target.widgetId);
      const payload = target.slot === "fullscreen" ? widget?.fullscreen : widget?.doc;
      if (payload == null) {
        // A sticky fullscreen ID whose companion is currently removed
        // lands here: resolvable, but nothing to render.
        buffers.delete(key);
        lastRenderAt.delete(key);
        lastRenderDeviceKey.delete(key);
        return;
      }

      logInfo("render.start", {
        surface: "image",
        slot: target.slot,
        deviceId: DEFAULT_DEVICE_ID,
        pairingId,
        widgetId: target.widgetId,
        deviceTelemetryApplied: device?.present === true,
      });
      const { pngBuffer, binBuffer, meta } = await runPipeline(payload, device);
      // Promote on write: `Map.set` on an EXISTING key keeps its original
      // position, so without the delete `evictPairingOverflow` (which drops
      // from the head) would evict the HOTTEST instance first once the cache
      // is full. Deleting first re-inserts at the tail, making it a real LRU.
      buffers.delete(key);
      buffers.set(key, { png: pngBuffer, bin: binBuffer, meta });
      lastRenderAt.set(key, Date.now());
      lastRenderDeviceKey.set(key, deviceKey);
      evictPairingOverflow();

      logInfo("render.finish", {
        surface: "image",
        slot: target.slot,
        deviceId: DEFAULT_DEVICE_ID,
        pairingId,
        widgetId: target.widgetId,
        deviceTelemetryApplied: meta.deviceTelemetryApplied,
        renderTimeMs: meta.renderTimeMs,
        sourceErrorCount: meta.sourceErrors.length,
        renderErrorCount: meta.renderErrors.length,
        pngBytes: pngBuffer.length,
        binBytes: binBuffer.length,
      });
      if (meta.renderErrors.length > 0) {
        logWarn("render.element.warning", {
          surface: "image",
          slot: target.slot,
          pairingId,
          widgetId: target.widgetId,
          count: meta.renderErrors.length,
          errors: meta.renderErrors,
        });
      }
      if (meta.sourceErrors.length > 0) {
        logWarn("source.fetch.failure", {
          surface: "image",
          slot: target.slot,
          pairingId,
          widgetId: target.widgetId,
          count: meta.sourceErrors.length,
          errors: meta.sourceErrors,
        });
      }
    } catch (err) {
      logWarn("render.failed", { surface: "image", pairingId, error: err });
    } finally {
      release();
    }
  }

  /**
   * Stream the multi-frame reply: for each requested ID (request order,
   * post-dedup), a 5-byte preamble — `u32 LE pairingId` echo + `u8 status`
   * (1 = frame follows, 0 = unavailable) — then, on status 1 only, the
   * unchanged `buildFramedReply` frame (self-delimiting via its
   * `payloadLen`; the clock is stamped at write time, same as the legacy
   * path). Sections are written to the socket AS EACH RENDER COMPLETES —
   * never buffered together — and one bad ID never fails the response.
   */
  async function streamRequestedInstances(
    res: express.Response,
    ids: number[],
    device?: DeviceTelemetryContext | null,
  ): Promise<void> {
    res.status(200);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    for (const pairingId of ids) {
      // Client gone — stop burning renders for a dead socket.
      if (res.destroyed) break;

      // ONE parse of the request body feeds every frame of the stream —
      // all instances in a wake share the device's telemetry, because they
      // are all being rendered FOR that device.
      await tryPairingRender(pairingId, device);
      const buf = buffers.get(pairingKey(pairingId));

      const preamble = Buffer.alloc(5);
      preamble.writeUInt32LE(pairingId, 0);
      preamble.writeUInt8(buf ? 1 : 0, 4);

      if (buf) {
        const frame = buildFramedReply({ width: buf.meta.width, height: buf.meta.height, binBuffer: buf.bin });
        res.write(Buffer.concat([preamble, frame]));
      } else {
        res.write(preamble);
      }
    }
    res.end();
  }

  /**
   * Register one GET `.png` + POST `.bin` route pair for a given slot and
   * path shape. `resolveDeviceId` resolves the target device — always the
   * constant `DEFAULT_DEVICE_ID`, the single device served on this port.
   *
   * Method handling is per-route: `app.get`/`app.post` match only their
   * intended verb; a trailing `app.all` on the same literal path catches
   * every other method with a clean 405 + Allow header.
   */
  function registerImageRoutes(
    slot: Slot,
    paths: { pngPath: string; binPath: string },
    resolveDeviceId: (req: express.Request) => string,
  ): void {
    function resolveValidDeviceId(req: express.Request, res: express.Response): DeviceId | null {
      const raw = resolveDeviceId(req);
      try {
        assertValidDeviceId(raw);
      } catch {
        res.status(404).json({ error: "Unknown device." });
        return null;
      }
      return raw;
    }

    // ── GET .png — read-only preview, unchanged behavior, now per-device ──
    app.get(paths.pngPath, async (req, res) => {
      const deviceId = resolveValidDeviceId(req, res);
      if (deviceId === null) return;
      const key = bufferKey(deviceId, slot);

      // Conditional GET fast path: skip BOTH the render trigger AND the
      // body write when the client already has the current ETag. Crucial
      // on the unauthenticated port — a polling client does not need to
      // drive a render every cycle.
      const currentEtag = etags.get(etagKey(key, "png"));
      if (currentEtag && req.headers["if-none-match"] === currentEtag) {
        res.setHeader("ETag", currentEtag);
        res.status(304).end();
        return;
      }

      await tryOnDemandRender(deviceId, slot);
      const buf = buffers.get(key);
      if (!buf) {
        res.status(503).json({ error: "No image available yet." });
        return;
      }
      // Re-check after the render — a successful render rotates the ETag.
      const refreshedEtag = etags.get(etagKey(key, "png"));
      if (refreshedEtag && req.headers["if-none-match"] === refreshedEtag) {
        res.setHeader("ETag", refreshedEtag);
        res.status(304).end();
        return;
      }
      if (refreshedEtag) res.setHeader("ETag", refreshedEtag);
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.send(buf.png);
    });
    app.all(paths.pngPath, (_req, res) => {
      res.status(405).setHeader("Allow", "GET, HEAD").json({ error: "Method not allowed." });
    });

    // ── POST .bin — device-facing framed reply ─────────────────────────
    app.post(paths.binPath, captureDeviceRequestBody, async (req, res) => {
      const deviceId = resolveValidDeviceId(req, res);
      if (deviceId === null) return;

      // Pairing-based multi-frame path: ONLY a JSON object body carrying
      // `requestedInstances` diverges from the legacy contract (identical
      // on both `.bin` endpoints — each pairing ID names its own slot).
      const classified = classifyDeviceRequestBody(req.body);
      if (classified.kind === "invalid") {
        res.status(400).json({ error: "Invalid requestedInstances." });
        return;
      }
      // ONE warn per request, field NAMES only — a sensor glitch must never
      // put a reading into the logs (D7).
      if (classified.rejectedFields.length > 0) {
        logWarn("telemetry.field_reject", {
          surface: "image",
          slot,
          deviceId,
          fields: classified.rejectedFields,
        });
      }
      if (classified.kind === "instances") {
        await streamRequestedInstances(res, classified.ids, classified.device);
        return;
      }

      // Legacy single-frame path — byte-identical to the pre-pairing
      // contract for a body-less, non-JSON, or telemetry-JSON POST.
      const key = bufferKey(deviceId, slot);

      // No conditional-GET path here: the live clock in every framed reply
      // makes the body unique regardless of image content, and the device
      // expects a fresh image (and a fresh clock) on every wake.
      await tryOnDemandRender(deviceId, slot, classified.device);
      const buf = buffers.get(key);
      if (!buf) {
        res.status(503).json({ error: "No image available yet." });
        return;
      }
      const body = buildFramedReply({ width: buf.meta.width, height: buf.meta.height, binBuffer: buf.bin });
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.send(body);
    });
    app.all(paths.binPath, (_req, res) => {
      res.status(405).setHeader("Allow", "POST").json({ error: "Method not allowed." });
    });
  }

  const defaultDeviceId = (): string => DEFAULT_DEVICE_ID;

  registerImageRoutes("primary", { pngPath: "/image.png", binPath: "/image.bin" }, defaultDeviceId);
  registerImageRoutes(
    "fullscreen",
    { pngPath: "/image_fullscreen.png", binPath: "/image_fullscreen.bin" },
    defaultDeviceId,
  );

  // Terminal error handler — catches the body-parser's 413 (oversized POST
  // body, see `captureDeviceRequestBody`) and anything else that reaches
  // `next(err)`, returning bounded JSON instead of Express's default HTML
  // error page. Must be registered after all routes; Express identifies an
  // error handler by its 4-argument arity.
  app.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const candidate = err as { status?: unknown; statusCode?: unknown } | null;
    const rawStatus =
      typeof candidate?.status === "number"
        ? candidate.status
        : typeof candidate?.statusCode === "number"
          ? candidate.statusCode
          : 500;
    const status = rawStatus >= 400 && rawStatus < 500 ? rawStatus : 500;
    logWarn("image_app.error", { statusCode: status, error: err });
    res.status(status).json({ error: status === 413 ? "Request body too large." : "Request could not be processed." });
  });

  return {
    app,
    setBuffer(png: Buffer, bin: Buffer, meta: RenderMeta, slot: Slot = "primary", deviceId: DeviceId = DEFAULT_DEVICE_ID) {
      const key = bufferKey(deviceId, slot);
      buffers.set(key, { png, bin, meta });
      lastRenderAt.set(key, Date.now());
      // The timer and the startup warm-up render without telemetry, so record
      // the ABSENT state here. A wake carrying real readings then differs from
      // it and bypasses the cooldown instead of being served this frame — which
      // is what stops a scheduled re-render from masking a fresh wake (D4 case 2).
      lastRenderDeviceKey.set(key, deviceStateKey(null));
      refreshEtags(key, png, bin);
    },
    getBuffer(slot: Slot = "primary", deviceId: DeviceId = DEFAULT_DEVICE_ID) {
      const buf = buffers.get(bufferKey(deviceId, slot));
      return buf ? { png: buf.png, bin: buf.bin } : null;
    },
    evictSlot(slot: Slot, deviceId: DeviceId = DEFAULT_DEVICE_ID) {
      const key = bufferKey(deviceId, slot);
      buffers.delete(key);
      lastRenderAt.delete(key);
      lastRenderDeviceKey.delete(key);
      etags.delete(etagKey(key, "png"));
      etags.delete(etagKey(key, "bin"));
    },
  };
}
