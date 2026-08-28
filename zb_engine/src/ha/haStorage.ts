/**
 * haStorage.ts — Filesystem-based storage adapter for Home Assistant
 *
 * Implements StorageAdapter using the HA persistent data volume (/data/).
 * Uses writeIfChanged to prevent SD card wear — a critical concern for
 * Raspberry Pi-based HA installations.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { StorageAdapter, WidgetDoc, WidgetMeta, AssetMeta, Slot, DeviceId } from "../core/adapters";
import { DEFAULT_DEVICE_ID, assertValidDeviceId } from "../core/adapters";
import { logError, logWarn } from "../core/logger";

// ── File paths ────────────────────────────────────────────

const ROOT = path.resolve(__dirname, "../..");
const DATA_ROOT = "/data";

/**
 * On-disk filenames per slot. Snake_case the fullscreen variant to mirror
 * the HTTP route names (`/image_fullscreen.png`, `/image_fullscreen.bin`)
 * served by the on-demand image port.
 */
const PAYLOAD_FILES: Record<Slot, string> = {
  primary: path.join(DATA_ROOT, "payload.json"),
  fullscreen: path.join(DATA_ROOT, "payload.fullscreen.json"),
};
const CACHE_PNG_FILES: Record<Slot, string> = {
  primary: path.join(DATA_ROOT, "image.png"),
  fullscreen: path.join(DATA_ROOT, "image_fullscreen.png"),
};
const CACHE_BIN_FILES: Record<Slot, string> = {
  primary: path.join(DATA_ROOT, "image.bin"),
  fullscreen: path.join(DATA_ROOT, "image_fullscreen.bin"),
};

const LEGACY_PAYLOAD_FILES: Record<Slot, string> = {
  primary: path.join(ROOT, "payload.json"),
  fullscreen: path.join(ROOT, "payload.fullscreen.json"),
};
const LEGACY_CACHE_PNG_FILES: Record<Slot, string> = {
  primary: path.join(ROOT, "image.png"),
  fullscreen: path.join(ROOT, "image_fullscreen.png"),
};
const LEGACY_CACHE_BIN_FILES: Record<Slot, string> = {
  primary: path.join(ROOT, "image.bin"),
  fullscreen: path.join(ROOT, "image_fullscreen.bin"),
};

/**
 * Per-device artifact root. Each device (== widget id, see adapters.ts
 * `DeviceId`) gets its own subdirectory so render payloads/images never
 * collide across devices. This is the CURRENT on-disk layout; the flat
 * `PAYLOAD_FILES`/`CACHE_*_FILES` and `LEGACY_*` maps above become a
 * two-tier migration source, for the default device only.
 */
const DEVICES_DIR = path.join(DATA_ROOT, "devices");

/**
 * On-disk basename for an artifact, independent of device. Pure function.
 * Exported (alongside the other path helpers below) so the derivation logic
 * is unit-testable without touching the real filesystem — `HaStorageAdapter`
 * hardcodes `/data`, which is unsafe to exercise outside its real container.
 */
export function artifactBasename(format: "payload" | "png" | "bin", slot: Slot): string {
  if (format === "payload") return slot === "fullscreen" ? "payload.fullscreen.json" : "payload.json";
  return slot === "fullscreen" ? `image_fullscreen.${format}` : `image.${format}`;
}

/**
 * Absolute path to a device's artifact file. Pure function of
 * `(deviceId, format, slot)`. The sole chokepoint where a `deviceId` turns
 * into a filesystem path — validated here so no call path can reach storage
 * with an unchecked id.
 */
export function deviceArtifactPath(deviceId: DeviceId, format: "payload" | "png" | "bin", slot: Slot): string {
  assertValidDeviceId(deviceId);
  return path.join(DEVICES_DIR, deviceId, artifactBasename(format, slot));
}

/** Absolute path to a device's artifact directory. */
function deviceDir(deviceId: DeviceId): string {
  assertValidDeviceId(deviceId);
  return path.join(DEVICES_DIR, deviceId);
}

/** The flat (pre-multi-device) path for an artifact — migration source only. */
export function flatArtifactPath(format: "payload" | "png" | "bin", slot: Slot): string {
  if (format === "payload") return PAYLOAD_FILES[slot];
  return format === "png" ? CACHE_PNG_FILES[slot] : CACHE_BIN_FILES[slot];
}

/**
 * Per-user widget documents are stored in /data/widgets/ as individual JSON
 * files (one per widget). This directory lives on the HA persistent data
 * volume so widgets survive container restarts and add-on updates.
 */
const WIDGETS_DIR = "/data/widgets";

/**
 * User-uploaded image / SVG assets live alongside widgets on the HA
 * persistent data volume. Files are named `<uuid>.<ext>` (server-generated)
 * with a sibling `<uuid>.meta.json` sidecar for original-name display.
 */
const ASSETS_DIR = "/data/assets";

/**
 * Strict whitelist of allowed asset filename shapes. Used both to validate
 * incoming filenames at the route layer and to filter directory listings —
 * any other entry (sidecar, hidden file, partial write) is ignored.
 *
 * The leading character class is intentionally `[a-f0-9-]` (lowercase only)
 * because `crypto.randomUUID()` returns lowercase hex — accepting uppercase
 * would let a request smuggle in a near-duplicate filename that bypasses
 * case-sensitive equality checks elsewhere.
 */
const ASSET_FILENAME_RE = /^[a-f0-9-]+\.(svg|png|jpe?g|webp)$/;

// ── SD-card safe write ─────────────────────────────────────────

/**
 * Write a buffer to disk ONLY if it differs from the current file content.
 * Returns true if the file was actually written, false if unchanged (skipped).
 * Uses Buffer.equals() for fast binary comparison — no hashing overhead.
 */
async function writeIfChanged(filePath: string, data: Buffer): Promise<boolean> {
  try {
    const existing = await fs.promises.readFile(filePath);
    if (existing.equals(data)) return false;
  } catch {
    // File doesn't exist yet — always write
  }
  try {
    await fs.promises.writeFile(filePath, data);
  } catch (err) {
    logError("storage.error", { operation: "write", error: err });
    throw err;
  }
  return true;
}

// ── Widget file helpers ────────────────────────────────────────

/** Path to a widget's JSON file on disk. ID is already validated by widgetService. */
function widgetFilePath(id: string): string {
  return path.join(WIDGETS_DIR, `${id}.json`);
}

function compareBeforeWriteSync(filePath: string, data: Buffer): boolean {
  try {
    const existing = fs.readFileSync(filePath);
    if (existing.equals(data)) return false;
  } catch {
    // missing/unreadable destination — write below
  }
  fs.writeFileSync(filePath, data);
  return true;
}

function migrateLegacyFile(target: string, legacy: string): void {
  if (fs.existsSync(target) || !fs.existsSync(legacy)) return;
  try {
    const data = fs.readFileSync(legacy);
    compareBeforeWriteSync(target, data);
  } catch (err) {
    logWarn("storage.error", { operation: "migrate_legacy_artifact", error: err });
  }
}

function legacyArtifactPath(format: "payload" | "png" | "bin", slot: Slot): string {
  if (format === "payload") return LEGACY_PAYLOAD_FILES[slot];
  if (format === "png") return LEGACY_CACHE_PNG_FILES[slot];
  return LEGACY_CACHE_BIN_FILES[slot];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the effective on-disk path for an artifact, honoring the
 * migration fallback chain for the DEFAULT device only:
 *   1. the per-device path (current layout)
 *   2. the flat `DATA_ROOT` path (pre-multi-device layout)
 *   3. the oldest repo-root legacy path
 * Non-default devices never fall back — they have no pre-multi-device
 * history, so a missing device path simply means "nothing rendered yet".
 * The returned path is not guaranteed to exist; callers check that.
 */
export async function resolveArtifactPath(deviceId: DeviceId, format: "payload" | "png" | "bin", slot: Slot): Promise<string> {
  const devicePath = deviceArtifactPath(deviceId, format, slot);
  if (deviceId !== DEFAULT_DEVICE_ID || (await fileExists(devicePath))) return devicePath;
  const flatPath = flatArtifactPath(format, slot);
  if (await fileExists(flatPath)) return flatPath;
  return legacyArtifactPath(format, slot);
}

/** Synchronous counterpart of {@link resolveArtifactPath}, for `getCachedImagePath`. */
export function resolveArtifactPathSync(deviceId: DeviceId, format: "payload" | "png" | "bin", slot: Slot): string {
  const devicePath = deviceArtifactPath(deviceId, format, slot);
  if (deviceId !== DEFAULT_DEVICE_ID || fs.existsSync(devicePath)) return devicePath;
  const flatPath = flatArtifactPath(format, slot);
  if (fs.existsSync(flatPath)) return flatPath;
  return legacyArtifactPath(format, slot);
}

// ── StorageAdapter implementation ──────────────────────────────

export class HaStorageAdapter implements StorageAdapter {
  constructor() {
    try {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
    } catch (err) {
      logWarn("storage.error", { operation: "create_data_directory", error: err });
    }
    // Ensure the widgets directory exists at startup (non-fatal if it fails).
    try {
      fs.mkdirSync(WIDGETS_DIR, { recursive: true });
    } catch (err) {
      logWarn("storage.error", { component: "widgets", operation: "create_directory", error: err });
    }
    // Same for the user-asset directory.
    try {
      fs.mkdirSync(ASSETS_DIR, { recursive: true });
    } catch (err) {
      logWarn("storage.error", { component: "assets", operation: "create_directory", error: err });
    }

    for (const slot of ["primary", "fullscreen"] as const) {
      migrateLegacyFile(PAYLOAD_FILES[slot], LEGACY_PAYLOAD_FILES[slot]);
      migrateLegacyFile(CACHE_PNG_FILES[slot], LEGACY_CACHE_PNG_FILES[slot]);
      migrateLegacyFile(CACHE_BIN_FILES[slot], LEGACY_CACHE_BIN_FILES[slot]);
    }

    // Multi-device migration: fold the pre-existing single-device flat
    // layout into the default device's directory — exactly once, exactly
    // the default device. This runs per SLOT, never per
    // device — there is no device list to iterate at this layer. Idempotent
    // via migrateLegacyFile's existing "skip if target exists" guard.
    try {
      fs.mkdirSync(deviceDir(DEFAULT_DEVICE_ID), { recursive: true });
    } catch (err) {
      logWarn("storage.error", { component: "devices", operation: "create_directory", error: err });
    }
    for (const slot of ["primary", "fullscreen"] as const) {
      migrateLegacyFile(deviceArtifactPath(DEFAULT_DEVICE_ID, "payload", slot), PAYLOAD_FILES[slot]);
      migrateLegacyFile(deviceArtifactPath(DEFAULT_DEVICE_ID, "png", slot), CACHE_PNG_FILES[slot]);
      migrateLegacyFile(deviceArtifactPath(DEFAULT_DEVICE_ID, "bin", slot), CACHE_BIN_FILES[slot]);
    }
  }

  async readWidget(id: string): Promise<WidgetDoc | null> {
    try {
      const raw = await fs.promises.readFile(widgetFilePath(id), "utf-8");
      return JSON.parse(raw) as WidgetDoc;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async writeWidget(widget: WidgetDoc): Promise<void> {
    const data = Buffer.from(JSON.stringify(widget, null, 2), "utf-8");
    await writeIfChanged(widgetFilePath(widget.id), data);
  }

  async deleteWidget(id: string): Promise<boolean> {
    try {
      await fs.promises.unlink(widgetFilePath(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  }

  async listWidgets(): Promise<WidgetMeta[]> {
    let files: string[];
    try {
      files = await fs.promises.readdir(WIDGETS_DIR);
    } catch (err) {
      logWarn("storage.error", { component: "widgets", operation: "list", error: err });
      return [];
    }

    const results: WidgetMeta[] = [];

    await Promise.all(
      files
        .filter((f) => f.endsWith(".json"))
        .map(async (f) => {
          try {
            const raw = await fs.promises.readFile(path.join(WIDGETS_DIR, f), "utf-8");
            const { id, name, updatedAt, pairingId, fullscreenPairingId } = JSON.parse(raw) as WidgetDoc;
            // Report the on-disk byte size so the widget storage quota can
            // bound aggregate disk use (see core/widgetService.ts). Pairing
            // IDs ride along for the uniqueness scan and the image-port
            // pairing resolver.
            results.push({ id, name, updatedAt, pairingId, fullscreenPairingId, size: Buffer.byteLength(raw, "utf8") });
          } catch (err) {
            // Skip corrupt/unreadable widget files — do not crash the list
            logWarn("storage.error", { component: "widgets", operation: "read_widget_meta", error: err });
          }
        }),
    );

    return results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async readPayload(slot: Slot = "primary", deviceId: DeviceId = DEFAULT_DEVICE_ID): Promise<unknown | null> {
    const filePath = await resolveArtifactPath(deviceId, "payload", slot);
    if (!(await fileExists(filePath))) return null;
    try {
      const raw = await fs.promises.readFile(filePath, "utf-8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async writePayload(data: Buffer, slot: Slot = "primary", deviceId: DeviceId = DEFAULT_DEVICE_ID): Promise<boolean> {
    const filePath = deviceArtifactPath(deviceId, "payload", slot);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return writeIfChanged(filePath, data);
  }

  async writeCachedImage(
    format: "png" | "bin",
    data: Buffer,
    slot: Slot = "primary",
    deviceId: DeviceId = DEFAULT_DEVICE_ID,
  ): Promise<boolean> {
    const filePath = deviceArtifactPath(deviceId, format, slot);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    return writeIfChanged(filePath, data);
  }

  getCachedImagePath(format: "png" | "bin", slot: Slot = "primary", deviceId: DeviceId = DEFAULT_DEVICE_ID): string | null {
    const filePath = resolveArtifactPathSync(deviceId, format, slot);
    return fs.existsSync(filePath) ? filePath : null;
  }

  /**
   * Remove a slot's on-disk artifacts (payload JSON + cached PNG/BIN).
   *
   * No-op for `primary` — the primary slot is the widget itself, and its
   * lifecycle is owned by the widget CRUD path (`deleteWidget`). For
   * `fullscreen`, this is the cleanup hook used when a user removes the
   * companion: each missing file is treated as already-deleted, so the
   * call is fully idempotent. For the default device only, this also
   * sweeps the pre-multi-device flat/legacy tiers so an old install can't
   * leave an orphaned companion file behind after migration.
   */
  async deleteSlot(slot: Slot, deviceId: DeviceId = DEFAULT_DEVICE_ID): Promise<void> {
    if (slot === "primary") return;
    const targets = [
      deviceArtifactPath(deviceId, "payload", slot),
      deviceArtifactPath(deviceId, "png", slot),
      deviceArtifactPath(deviceId, "bin", slot),
    ];
    if (deviceId === DEFAULT_DEVICE_ID) {
      targets.push(
        PAYLOAD_FILES[slot],
        CACHE_PNG_FILES[slot],
        CACHE_BIN_FILES[slot],
        LEGACY_PAYLOAD_FILES[slot],
        LEGACY_CACHE_PNG_FILES[slot],
        LEGACY_CACHE_BIN_FILES[slot],
      );
    }
    await Promise.all(
      targets.map(async (p) => {
        try {
          await fs.promises.unlink(p);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }),
    );
  }

  // ── User assets ──────────────────────────────────────────────

  /**
   * Build the on-disk path for a sidecar metadata file. Filename is the
   * stored asset filename (`<uuid>.<ext>`); the sidecar shares the UUID
   * stem with `.meta.json` appended so listings can pair them by stem.
   */
  private sidecarPath(assetFilename: string): string {
    return path.join(ASSETS_DIR, `${assetFilename}.meta.json`);
  }

  async listAssets(): Promise<AssetMeta[]> {
    let entries: string[];
    try {
      entries = await fs.promises.readdir(ASSETS_DIR);
    } catch (err) {
      logWarn("storage.error", { component: "assets", operation: "list", error: err });
      return [];
    }

    const results: AssetMeta[] = [];
    await Promise.all(
      entries
        .filter((f) => ASSET_FILENAME_RE.test(f))
        .map(async (filename) => {
          try {
            const raw = await fs.promises.readFile(this.sidecarPath(filename), "utf-8");
            const meta = JSON.parse(raw) as AssetMeta;
            // Defensive: ensure the sidecar refers to the same filename
            // we found on disk. Skip any orphan / mismatched record.
            if (meta && meta.filename === filename) {
              results.push(meta);
            }
          } catch {
            // Orphan asset (no sidecar) or corrupt sidecar — skip silently.
          }
        }),
    );

    return results.sort((a, b) => (b.uploadedAt ?? 0) - (a.uploadedAt ?? 0));
  }

  async saveAsset(
    originalName: string,
    bytes: Buffer,
    mimeType: string,
    ext: string,
  ): Promise<AssetMeta> {
    // Normalise extension to the same lowercase set the filename regex accepts.
    const lowerExt = ext.toLowerCase().replace(/^\./, "");
    if (!/^(svg|png|jpe?g|webp)$/.test(lowerExt)) {
      throw new Error("Unsupported asset extension.");
    }

    const filename = `${crypto.randomUUID()}.${lowerExt}`;
    const assetPath = path.join(ASSETS_DIR, filename);
    const meta: AssetMeta = {
      filename,
      originalName,
      mimeType,
      size: bytes.length,
      uploadedAt: Date.now(),
    };

    await writeIfChanged(assetPath, bytes);
    try {
      const sidecar = Buffer.from(JSON.stringify(meta, null, 2), "utf-8");
      await writeIfChanged(this.sidecarPath(filename), sidecar);
    } catch (err) {
      // Sidecar write failed — roll back the asset file so we don't leave
      // an unlistable orphan that still consumes quota.
      try {
        await fs.promises.unlink(assetPath);
      } catch {
        // ignore secondary failure
      }
      throw err;
    }

    return meta;
  }

  async deleteAsset(filename: string): Promise<boolean> {
    if (!ASSET_FILENAME_RE.test(filename)) return false;
    let removed = false;
    try {
      await fs.promises.unlink(path.join(ASSETS_DIR, filename));
      removed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // Best-effort sidecar removal — non-fatal so a missing sidecar can't
    // block deletion of a real asset file.
    try {
      await fs.promises.unlink(this.sidecarPath(filename));
    } catch {
      // ignore
    }
    return removed;
  }

  async readAsset(filename: string): Promise<Buffer> {
    // Three-layer defence against escaping the asset directory.
    if (!ASSET_FILENAME_RE.test(filename)) {
      throw new Error("Invalid asset filename.");
    }
    const resolved = path.resolve(ASSETS_DIR, filename);
    if (path.dirname(resolved) !== ASSETS_DIR) {
      throw new Error("Path traversal rejected.");
    }
    // realpath resolves symlinks; the prefix check ensures the final
    // target is still inside ASSETS_DIR, blocking symlink escape.
    const real = await fs.promises.realpath(resolved);
    if (real !== resolved && !real.startsWith(ASSETS_DIR + path.sep)) {
      throw new Error("Symlink escape rejected.");
    }
    return fs.promises.readFile(real);
  }
}
