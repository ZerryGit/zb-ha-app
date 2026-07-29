/**
 * widgetService.ts — Widget CRUD operations via StorageAdapter
 *
 * Platform-agnostic widget management. All filesystem/database details
 * are delegated to the StorageAdapter interface.
 */

import * as crypto from "crypto";
import type { StorageAdapter, WidgetDoc, WidgetMeta } from "./adapters";
import { fullscreenPayloadSchema, payloadSchema } from "../schema/payloadSchema";
import { HttpError } from "../errors/httpError";
import { AsyncMutex } from "./asyncMutex";
import { restoreWidgetSecrets } from "./sourceSecrets";
import { CURRENT_SCHEMA_VERSION, migrateWidgetDoc } from "./widgetMigrations";
import { MAX_WIDGET_COUNT, MAX_WIDGETS_TOTAL_BYTES } from "../limits";

/** Regex for valid widget IDs: alphanumeric, underscore, hyphen only. */
const WIDGET_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * Serialises the read → quota-check → write window so two concurrent saves
 * cannot both pass the storage quota before either persists (mirror of the
 * asset-upload guard in `ha/haAssets.ts`).
 */
const widgetWriteMutex = new AsyncMutex();

/**
 * Reject the write if it would push stored widgets past the count or
 * aggregate-byte budget. Overwriting an existing widget never trips the count
 * cap and replaces (rather than adds to) that widget's byte contribution.
 *
 * The projected size mirrors the HA adapter's pretty-printed JSON encoding so
 * the budget reflects real disk use; adapters that omit `size` from their
 * metadata degrade gracefully to a count-only guard.
 */
async function enforceWidgetQuota(storage: StorageAdapter, widget: WidgetDoc): Promise<void> {
  const metas = await storage.listWidgets();
  const isNew = !metas.some((m) => m.id === widget.id);
  if (isNew && metas.length >= MAX_WIDGET_COUNT) {
    throw new HttpError(
      409,
      `Widget limit reached (${MAX_WIDGET_COUNT}). Delete unused widgets before creating new ones.`,
    );
  }
  const projected = Buffer.byteLength(JSON.stringify(widget, null, 2), "utf8");
  const otherBytes = metas.reduce(
    (acc, m) => acc + (m.id === widget.id ? 0 : (m.size ?? 0)),
    0,
  );
  if (otherBytes + projected > MAX_WIDGETS_TOTAL_BYTES) {
    throw new HttpError(409, "Widget storage quota exceeded.");
  }
}

/**
 * Validate a widget ID. Throws HttpError(400) if the ID contains path
 * traversal characters or other dangerous patterns.
 */
export function validateWidgetId(id: string): void {
  if (!id || !WIDGET_ID_RE.test(id)) {
    throw new HttpError(400, `Invalid widget ID: "${id}"`);
  }
}

/**
 * Generate a collision-resistant widget ID matching the builder's convention.
 * Format: widget_XXXXXXXX_YYYYYY (hex chars).
 */
export function generateWidgetId(): string {
  const a = crypto.randomBytes(5).toString("hex").slice(0, 8);
  const b = crypto.randomBytes(4).toString("hex").slice(0, 6);
  return `widget_${a}_${b}`;
}

/**
 * Read a single widget by ID. Validates the ID before accessing storage.
 *
 * The stored envelope is brought up to `CURRENT_SCHEMA_VERSION` in memory
 * (`migrateWidgetDoc`) — a document saved before envelope versioning existed
 * reads back as version-current. Nothing is written back: the file on disk is
 * left exactly as it was until the user saves.
 */
export async function readWidget(
  storage: StorageAdapter,
  id: string,
): Promise<WidgetDoc | null> {
  validateWidgetId(id);
  const widget = await storage.readWidget(id);
  return widget ? migrateWidgetDoc(widget) : null;
}

/**
 * Write (create or overwrite) a widget. Validates the ID before writing.
 *
 * If the incoming widget carries a `fullscreen` payload, it MUST satisfy
 * `fullscreenPayloadSchema` (`misc.gridSize === "3x2"`). When `fullscreen`
 * is explicitly `null` AND the widget previously had a fullscreen payload
 * on disk, the storage adapter's `deleteSlot("fullscreen")` is invoked so
 * the on-disk artifacts (payload + cached images) are cleaned up. Deletion
 * is idempotent.
 */
export async function writeWidget(
  storage: StorageAdapter,
  widget: WidgetDoc,
): Promise<void> {
  validateWidgetId(widget.id);

  const primaryParse = payloadSchema.safeParse(widget.doc);
  if (!primaryParse.success) {
    throw new HttpError(
      400,
      `Invalid widget payload: ${JSON.stringify(primaryParse.error.flatten())}`,
    );
  }
  widget = { ...widget, doc: primaryParse.data };

  // Validate the optional fullscreen payload BEFORE touching disk so an
  // invalid companion never half-persists.
  if (widget.fullscreen != null) {
    const parsed = fullscreenPayloadSchema.safeParse(widget.fullscreen);
    if (!parsed.success) {
      throw new HttpError(
        400,
        `Invalid fullscreen payload: ${JSON.stringify(parsed.error.flatten())}`,
      );
    }
    // Persist the Zod-cleaned shape, not the raw input — strips unknown keys.
    widget = { ...widget, fullscreen: parsed.data };
  }

  // Stamp the stored-envelope format version. This is the single choke point
  // for widget writes, so every persisted record carries it — routes and
  // storage adapters never stamp it themselves. Done before the quota check so
  // the byte projection matches what actually lands on disk.
  widget = { ...widget, schemaVersion: CURRENT_SCHEMA_VERSION };

  // Detect "companion removed" before we overwrite the on-disk record.
  const explicitlyCleared = Object.prototype.hasOwnProperty.call(widget, "fullscreen") && widget.fullscreen == null;

  // The whole read → quota → write sequence runs under one mutex so concurrent
  // saves cannot race the quota check.
  await widgetWriteMutex.run(async () => {
    const existing = await storage.readWidget(widget.id);

    // Restore sentinel-masked source credentials from the persisted copy
    // (mask-on-read / restore-on-save). Runs inside the mutex, after the
    // atomic read of `existing`, so the read-modify-write stays consistent and
    // both the doc and fullscreen slots are covered before the quota check.
    if (existing) restoreWidgetSecrets(widget, existing as WidgetDoc);

    // Storage quota (host disk DoS guard) — checked inside the mutex against
    // the incoming record so the byte projection is accurate.
    await enforceWidgetQuota(storage, widget);

    await storage.writeWidget(widget);

    // Clean up companion artifacts after the widget write succeeds. Doing the
    // cleanup AFTER the write means a deleteSlot failure cannot leave the
    // widget JSON in an inconsistent state. deleteSlot is idempotent.
    if (explicitlyCleared && existing?.fullscreen != null && storage.deleteSlot) {
      await storage.deleteSlot("fullscreen");
    }
  });
}

/**
 * Delete a widget by ID. Validates the ID before deleting.
 * Returns false if the widget did not exist.
 */
export async function deleteWidget(
  storage: StorageAdapter,
  id: string,
): Promise<boolean> {
  validateWidgetId(id);
  return storage.deleteWidget(id);
}

/**
 * List all widgets (metadata only, no doc field). Sorted newest-first.
 */
export async function listWidgets(
  storage: StorageAdapter,
): Promise<WidgetMeta[]> {
  return storage.listWidgets();
}
