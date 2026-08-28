/**
 * adapters.ts — Platform adapter interfaces
 *
 * These two interfaces define the boundary between the platform-agnostic
 * core server and the platform-specific adapter (e.g. Home Assistant, cloud).
 *
 * A new platform is created by implementing both interfaces and passing
 * them to the core `createApp()` factory.
 */

import type express from "express";
import type { DataContext } from "@zb/expressions";
import type { AnySourceDef } from "../data/sourceFetcher";
import { HttpError } from "../errors/httpError";

// ── Shared types ───────────────────────────────────────────────

/**
 * Render slots a widget can have.
 *
 * Every widget has a `primary` payload. A widget MAY additionally have a
 * `fullscreen` companion payload locked to grid `3x2` and the device's full
 * screen pixel dimensions. Both slots round-trip through the same render
 * pipeline and are served on parallel ESP32 endpoints.
 */
export type Slot = "primary" | "fullscreen";

/**
 * Device identity for multi-device storage addressing.
 *
 * A "device" is a widget document — `deviceId` IS the widget id, not a
 * separate registry entity. This is a NEW axis, orthogonal to `Slot`: the
 * storage key is the composite `(deviceId × slot)`. Never fold a device
 * into the `Slot` union above.
 */
export type DeviceId = string;

/** Charset every `DeviceId` must match — see `assertValidDeviceId`. */
const DEVICE_ID_RE = /^[a-z0-9_-]+$/;

/**
 * The implicit device that pre-multi-device singleton storage migrates to,
 * and that bare (non-prefixed) routes serve for single-device convenience.
 */
export const DEFAULT_DEVICE_ID: DeviceId = "default";

/**
 * Validate a `deviceId`'s charset before it is allowed to reach storage or a
 * route. `deviceId` flows directly into filesystem
 * paths, so an unvalidated value is a path-traversal vector.
 */
export function assertValidDeviceId(id: string): asserts id is DeviceId {
  if (!id || !DEVICE_ID_RE.test(id)) {
    throw new HttpError(400, `Invalid device ID: "${id}"`);
  }
}

/** Full widget document stored on disk / in database. */
export interface WidgetDoc {
  id: string;
  name: string;
  /**
   * Stored-envelope format version. Absent means `0` — the pre-versioning
   * baseline. Stamped on save, migrated on load; see `core/widgetMigrations.ts`.
   */
  schemaVersion?: number;
  doc: unknown;
  /** Optional non-renderer widget metadata. Never consumed by the draw engine. */
  metadata?: unknown;
  /**
   * Optional fullscreen companion payload. `null` (or missing) means the
   * widget has no companion. When present, the payload MUST satisfy
   * `fullscreenPayloadSchema` (`misc.gridSize === "3x2"`).
   */
  fullscreen?: unknown | null;
  /**
   * Server-assigned pairing ID for the PRIMARY slot (envelope-only,
   * additive). Random integer in [100_000_000, 4_294_967_295] (fits u32,
   * never 0), unique across all widgets and slots. Assigned lazily on save
   * and carried over on every re-save (`core/widgetService.ts`); never
   * enters `doc`/payload JSON or the render path.
   */
  pairingId?: number;
  /**
   * Pairing ID for the FULLSCREEN slot. Sticky: kept on the envelope when
   * the companion is removed (`fullscreen: null`) so a re-created
   * fullscreen resumes the same pairing (cloud/app entries stay valid).
   */
  fullscreenPairingId?: number;
  updatedAt: number;
}

/** Lightweight widget metadata returned by list operations. */
export interface WidgetMeta {
  id: string;
  name: string;
  updatedAt: number;
  /**
   * On-disk byte size of the stored widget record, when the adapter can
   * report it cheaply. Used by the widget storage quota (see
   * `core/widgetService.ts`). Adapters that cannot report a size omit it;
   * the quota then degrades to a count-only check.
   */
  size?: number;
  /** Pairing ID of the primary slot, when assigned (see `WidgetDoc.pairingId`). */
  pairingId?: number;
  /**
   * Pairing ID of the fullscreen slot, when assigned. Sticky — may be
   * present while the widget currently has no fullscreen payload.
   */
  fullscreenPairingId?: number;
}

/** Summary of a completed render pass. */
export interface RenderMeta {
  name: string;
  format: "png" | "bin";
  width: number;
  height: number;
  sourceCount: number;
  elementCount: number;
  renderTimeMs: number;
  sourceErrors: string[];
  renderErrors: string[];
  /**
   * True when this render was seeded with PRESENT device telemetry (D7).
   * Optional so every existing RenderMeta literal stays valid — absent and
   * `false` mean the same thing. A cached hit re-serves the original flag,
   * which is consistent because the D4 cache key includes the telemetry
   * state, so a hit can only come from a render in the same state.
   */
  deviceTelemetryApplied?: boolean;
}

// ── Device telemetry (plan 4 Part A) ───────────────────────────

/**
 * The `device` namespace seeded into the render context from a `.bin` POST
 * body's `telemetry` object (plan 4, D1/D2).
 *
 * REQUEST-SCOPED: this is built per request and influences only the frames
 * rendered for that response. Nothing is persisted, there is no per-device
 * store, and `mac` is never carried here (D5 exposure policy — `wakeReason`,
 * `delta` and `mac` are deliberately not exposed to expressions).
 *
 * Every field is nullable: an absent OR invalid field is `null` for that
 * field alone, while valid siblings still render (D1, per-field policy).
 * Key order is FIXED by `buildDeviceContext` — D4 makes the cache key the
 * `JSON.stringify` of this object, so construction order IS the canonical
 * form and no `canonicalJson` helper is needed.
 */
export interface DeviceTelemetryContext {
  /** True iff `telemetry` was a plain object AND at least one field validated. */
  present: boolean;
  battery: number | null;
  charging: boolean | null;
  units: "metric" | "imperial" | null;
  /**
   * Temperature and pressure arrive under DIFFERENT NAMES depending on the
   * panel's unit mode — the firmware sends `tempC`/`pressureHpa` when
   * `units:"metric"` and `tempF`/`pressureInhg` when `units:"imperial"`. Both
   * pairs are exposed RAW, exactly as sent; nothing is converted, so a value
   * here is always what the device actually reported.
   *
   * Consequence for widget authors: on any given panel ONE of each pair is
   * populated and the other is null. Bind both with defaults, or branch on
   * `device.units`.
   */
  tempC: number | null;
  tempF: number | null;
  humidity: number | null;
  pressureHpa: number | null;
  pressureInhg: number | null;
}

/** The validated telemetry values, without the derived `present` flag. */
export type DeviceTelemetryFields = Omit<DeviceTelemetryContext, "present">;

/**
 * The ONE constructor for `DeviceTelemetryContext` (D4).
 *
 * Called with nothing (or an empty set of validated fields) it returns the
 * canonical ABSENT state — all nulls, `present:false` — which is what every
 * telemetry-less render path seeds, so a port render with no telemetry and a
 * builder `/render` of the same payload hash to the same cache key.
 */
export function buildDeviceContext(
  fields?: Partial<DeviceTelemetryFields> | null,
): DeviceTelemetryContext {
  const battery = fields?.battery ?? null;
  const charging = fields?.charging ?? null;
  const units = fields?.units ?? null;
  const tempC = fields?.tempC ?? null;
  const tempF = fields?.tempF ?? null;
  const humidity = fields?.humidity ?? null;
  const pressureHpa = fields?.pressureHpa ?? null;
  const pressureInhg = fields?.pressureInhg ?? null;

  const present =
    battery !== null ||
    charging !== null ||
    units !== null ||
    tempC !== null ||
    tempF !== null ||
    humidity !== null ||
    pressureHpa !== null ||
    pressureInhg !== null;

  // Literal order below IS the canonical key order — do not reorder.
  return { present, battery, charging, units, tempC, tempF, humidity, pressureHpa, pressureInhg };
}

/** Precomputed absent state. Frozen so a caller cannot mutate the shared canon. */
export const ABSENT_DEVICE_CONTEXT: DeviceTelemetryContext = Object.freeze(buildDeviceContext());

// ── StorageAdapter ─────────────────────────────────────────────

/**
 * Abstraction over persistent storage.
 *
 * HA implementation: filesystem with writeIfChanged (SD-card safe).
 * Cloud implementation: database (S3, PostgreSQL, etc.).
 */
export interface StorageAdapter {
  /** Read a widget by ID. Returns null if not found. */
  readWidget(id: string): Promise<WidgetDoc | null>;

  /** Write (create or overwrite) a widget. */
  writeWidget(widget: WidgetDoc): Promise<void>;

  /** Delete a widget by ID. Returns false if it did not exist. */
  deleteWidget(id: string): Promise<boolean>;

  /** List all widgets (metadata only). Sorted newest-first. */
  listWidgets(): Promise<WidgetMeta[]>;

  /**
   * Read the current render payload for a slot. Returns null if none exists.
   * Defaults to the primary slot and the default device for backward
   * compatibility.
   */
  readPayload(slot?: Slot, deviceId?: DeviceId): Promise<unknown | null>;

  /**
   * Write the render payload for a slot. Returns true if content changed.
   * Defaults to the primary slot and the default device for backward
   * compatibility.
   */
  writePayload(data: Buffer, slot?: Slot, deviceId?: DeviceId): Promise<boolean>;

  /**
   * Write a cached image (PNG or BIN) for a slot. Returns true if content
   * changed. Defaults to the primary slot and the default device for
   * backward compatibility.
   */
  writeCachedImage(format: "png" | "bin", data: Buffer, slot?: Slot, deviceId?: DeviceId): Promise<boolean>;

  /**
   * Get the absolute path to a cached image for a slot, or null if not
   * available. Defaults to the primary slot and the default device for
   * backward compatibility.
   */
  getCachedImagePath(format: "png" | "bin", slot?: Slot, deviceId?: DeviceId): string | null;

  /**
   * Delete all on-disk artifacts for a slot (payload + cached images).
   * No-op for `primary` (primary widget deletion is a separate operation).
   * Idempotent — missing files are not errors. Optional on platforms that
   * do not implement slot deletion (callers must handle the absence).
   * Defaults to the default device for backward compatibility.
   */
  deleteSlot?(slot: Slot, deviceId?: DeviceId): Promise<void>;

  // ── User assets ──────────────────────────────────────────────
  // Optional on platforms that do not implement user-uploaded assets.
  // The HA platform implements them; cloud / standalone may leave them
  // unimplemented (callers must handle the absence gracefully).

  /** List all stored asset metadata, newest-first. Returns [] if unsupported. */
  listAssets?(): Promise<AssetMeta[]>;

  /**
   * Save asset bytes to disk. Returns the persisted metadata record.
   * Implementations MUST generate the stored filename (UUID-based) to
   * prevent path traversal via attacker-controlled names.
   */
  saveAsset?(
    originalName: string,
    bytes: Buffer,
    mimeType: string,
    ext: string,
  ): Promise<AssetMeta>;

  /** Delete an asset by its stored (UUID-based) filename. Returns false if missing. */
  deleteAsset?(filename: string): Promise<boolean>;

  /**
   * Read asset bytes by stored filename.
   * Implementations MUST validate the filename and reject path traversal,
   * symlink escape, and any access outside the asset directory.
   */
  readAsset?(filename: string): Promise<Buffer>;
}

/** Metadata for a user-uploaded asset. */
export interface AssetMeta {
  /** Stored filename — `<uuid>.<ext>`, server-generated. */
  filename: string;
  /** Original filename from upload. Display only — never used as a path. */
  originalName: string;
  /** Detected MIME type at upload time. */
  mimeType: string;
  /** Size in bytes of the persisted (sanitized / re-encoded) file. */
  size: number;
  /** Epoch ms when the asset was uploaded. */
  uploadedAt: number;
}

// ── PlatformAdapter ────────────────────────────────────────────

/**
 * Platform-specific integration layer.
 *
 * HA implementation: Ingress routes, entity proxy, Supervisor API sources.
 * Cloud implementation: OAuth routes, cloud-specific source handlers, etc.
 */
export interface PlatformAdapter {
  /** The storage backend for this platform. */
  storage: StorageAdapter;

  /**
   * Register platform-specific routes on the Express app.
   * Called once during app creation, after core routes are registered.
   */
  registerRoutes(app: express.Application): void;

  /** Hostnames to block in URL validation, in addition to the default set. */
  getBlockedHostnames(): string[];

  /**
   * Optional platform-specific source handler.
   * Called for sources whose `kind` is not "http".
   * Returns the fetched data, or null if the source kind is not handled.
   *
   * The handler receives the per-render `AbortSignal` owned by
   * `runPipeline` (when called from a render). Implementations MUST
   * forward the signal to any outbound `fetch()` so a render timeout
   * actually cancels the in-flight platform call.
   */
  getSourceHandler(): ((source: AnySourceDef, ctx: DataContext, signal?: AbortSignal) => Promise<unknown>) | null;
}
