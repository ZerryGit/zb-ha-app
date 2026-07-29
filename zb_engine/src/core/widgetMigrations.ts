/**
 * widgetMigrations.ts — Stored-envelope version stamping and migration chain
 *
 * `schemaVersion` lives on the stored widget ENVELOPE (a sibling of `id` /
 * `name` / `updatedAt` in `/data/widgets/<id>.json`), never inside `doc`,
 * `elements`, `sources`, or `fullscreen`. The payload schema and the render
 * pipeline stay version-agnostic.
 *
 * Saves stamp the current version (`core/widgetService.ts:writeWidget`); loads
 * route the envelope through `migrateWidgetDoc` (`readWidget`). Migration is
 * in-memory only — a read NEVER writes back to disk (SD-card wear, and a
 * pre-versioning file must stay byte-identical until the user saves it).
 *
 * Platform-agnostic by design: nothing here may import from `src/ha/`.
 */

import type { WidgetDoc } from "./adapters";

/** The envelope format version written by this build. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Migration N transforms an envelope at version N to version N+1. */
type WidgetMigration = (widget: WidgetDoc) => WidgetDoc;

/**
 * Version-keyed migration chain. Empty on purpose: 0→1 is the identity step,
 * because pre-versioning documents are already valid under the current schema.
 * A breaking envelope change must add its step here, keyed by the version it
 * migrates FROM.
 */
const MIGRATIONS: Partial<Record<number, WidgetMigration>> = {};

/**
 * Bring a stored envelope up to `CURRENT_SCHEMA_VERSION`.
 *
 * A missing `schemaVersion` is treated as `0` (pre-versioning baseline). An
 * envelope already at — or ahead of — the current version passes through
 * untouched, so a downgraded add-on cannot mangle files written by a newer one.
 */
export function migrateWidgetDoc(widget: WidgetDoc): WidgetDoc {
  const from = typeof widget.schemaVersion === "number" ? widget.schemaVersion : 0;
  if (from >= CURRENT_SCHEMA_VERSION) return widget;

  let out = widget;
  for (let v = from; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) out = step(out);
  }
  return { ...out, schemaVersion: CURRENT_SCHEMA_VERSION };
}
