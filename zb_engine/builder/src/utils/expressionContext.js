/**
 * expressionContext.js — builder helper that constructs the runtime data
 * context consumed by `@zb/expressions` for live canvas/preview
 * evaluation.
 *
 * Returns the canonical FLAT shape (matching the server runtime):
 *   { misc, features, [sourceId]: data }
 *
 * This single helper is the only place in the builder that materializes
 * a preview context. Components MUST NOT inline `{ features, sources: {...} }`
 * objects — that nested shape was the legacy builder-only convention and
 * is no longer supported by the unified expression engine.
 *
 * Reserved source IDs (`misc`, `features`, `__proto__`, `constructor`,
 * `prototype`) are silently dropped here — payload validation rejects
 * them at save time, but live preview must not crash if a malformed
 * draft is in flight.
 */

import { createDataContext, validateContextKey } from '@zb/expressions';

/** The telemetry context root. Mirrors `DEVICE_CONTEXT_ROOT` server-side. */
const DEVICE_SOURCE_ID = 'device';

/**
 * Stand-in panel telemetry for LIVE canvas preview (plan 4, D6).
 *
 * The real values only exist while a paired panel is awake and POSTing, so the
 * builder shows plausible ones instead of an empty namespace nobody can bind
 * against. Deliberately NOT the absent state: an author needs to see the shape
 * to click a path out of the DataTree.
 *
 * `device` is NOT a reserved context root — seeding it here mirrors the
 * server's shadow rule exactly (see `renderService.preparePipeline`): a doc
 * that DECLARES its own `device` source is never seeded at all, so the user's
 * source owns the root in the preview just as it does at render time.
 *
 * BOTH unit shapes are seeded (`tempC`+`tempF`, `pressureHpa`+`pressureInhg`)
 * so every bindable path is visible in the DataTree. A REAL panel never
 * populates both: the firmware sends the metric pair or the imperial pair
 * according to its `units` setting, and the other is null. The placeholder is
 * an authoring aid, not a simulation of one device.
 */
export const DEVICE_PREVIEW_PLACEHOLDER = Object.freeze({
  present: true,
  battery: 87,
  charging: false,
  units: 'metric',
  tempC: 21.7,
  tempF: 71.1,
  humidity: 43.5,
  pressureHpa: 1012.3,
  pressureInhg: 29.89,
});

/**
 * Inline hint shown wherever `device` surfaces in the UI. REQUIRED, not
 * polish: without it an author writes `{{device.tempC|round}}`, sees the
 * placeholder render fine, and ships a widget that shows a confident "0" on
 * a panel that has never woken. `toNumber(null) === 0` is pre-existing engine
 * behaviour and is not changing, so the UI has to steer around it.
 */
export const DEVICE_HINT =
  'Panel telemetry — sample values, not live readings; empty until a panel wakes. '
  + 'Bind with a default: { "$": "device.battery", "default": "--" }. '
  + 'Temperature and pressure depend on the panel\'s unit mode: a metric panel '
  + 'fills tempC/pressureHpa, an imperial one fills tempF/pressureInhg, and the '
  + 'other of each pair stays empty — bind both, or branch on device.units.';

/**
 * @param {Object}   args
 * @param {Array}    args.sources               Doc sources array (`[{id, ...}]`).
 * @param {Object}   args.sourceResponsesById   `{ [sourceId]: { data, ... } }` from uiStore.
 * @param {Object}   [args.features]            Resolved feature values (`features.values`).
 * @param {Object}   [args.misc]                Optional misc bag (defaults to `{}`).
 * @returns {import('@zb/expressions').DataContext}
 */
export function buildPreviewContext({ sources, sourceResponsesById, features, misc } = {}) {
  const ctx = createDataContext();
  ctx.misc = misc ?? {};
  ctx.features = features ?? {};
  // Seeded BEFORE the source loop, and ONLY when the doc declares no `device`
  // source of its own — see DEVICE_PREVIEW_PLACEHOLDER. Keyed off the
  // DECLARATION, not the cached response: a `device` source that has not been
  // tested yet (or whose fetch failed) leaves no entry in
  // `sourceResponsesById`, and seeding anyway would show the canvas plausible
  // telemetry for a widget the panel will render from the user's source.
  const docDeclaresDevice =
    Array.isArray(sources) && sources.some((s) => s?.id === DEVICE_SOURCE_ID);
  if (!docDeclaresDevice) ctx.device = DEVICE_PREVIEW_PLACEHOLDER;

  if (Array.isArray(sources) && sourceResponsesById) {
    for (const source of sources) {
      const id = source?.id;
      if (typeof id !== 'string' || !id) continue;
      if (!validateContextKey(id)) continue; // skip reserved roots
      const entry = sourceResponsesById[id];
      if (entry && 'data' in entry) {
        ctx[id] = entry.data;
      }
    }
  }

  return ctx;
}
