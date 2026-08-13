import { createNewDocument, gridSizeToSize, normalizeGridSize } from './document.js';
import { getDisplayConfig } from '../store/displayConfigStore.js';
import { typeDisplayNames } from './elementDefaults.js';
import { createId } from '../utils/ids.js';
import { circlePosToCenter, centerToCirclePos } from '../utils/circleGeometry.js';

/**
 * Parse a "key=value" line-separated or "&"-separated string into a
 * Record<string, string> for form-encoded POST bodies.
 */
function parseFormString(str) {
  const result = {};
  if (!str) return result;
  // Support both newline-separated and &-separated entries
  const pairs = str.includes('&') ? str.split('&') : str.split('\n');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key) result[key] = value;
  }
  return result;
}

export function createNameGeneratorFromElements(elements) {
  const countersByType = Object.create(null);

  for (const element of elements) {
    if (!element || typeof element !== 'object') continue;
    const type = element.type;
    const name = element.name;
    if (typeof type !== 'string' || typeof name !== 'string') continue;

    const match = name.match(/\s(\d+)$/);
    if (!match) continue;

    const number = Number(match[1]);
    if (!Number.isFinite(number) || number <= 0) continue;

    countersByType[type] = Math.max(countersByType[type] ?? 0, number);
  }

  return function nextNameForType(type) {
    const displayName = typeDisplayNames[type] ?? 'Element';
    const next = (countersByType[type] ?? 0) + 1;
    countersByType[type] = next;
    return `${displayName} ${next}`;
  };
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractExtra(obj, knownKeys) {
  const extra = {};

  for (const [key, value] of Object.entries(obj)) {
    if (key === 'extra') continue;
    if (!knownKeys.has(key)) {
      extra[key] = value;
    }
  }

  return Object.keys(extra).length ? extra : null;
}

function stripToKnown(obj, knownKeys) {
  const out = {};
  for (const key of knownKeys) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      out[key] = obj[key];
    }
  }
  return out;
}

function mergeExtraForExport(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const { extra, ...rest } = obj;

  if (!extra || typeof extra !== 'object') return rest;

  // Unknown fields survive, but known fields win on conflicts.
  return { ...extra, ...rest };
}

function resolveRuntimeFeatures(editorDoc) {
  const features = editorDoc?.features;
  if (!features || typeof features !== 'object') return {};

  // If we later add runtime values under `features.values`, export those.
  if (features.values && typeof features.values === 'object') return features.values;

  // If some caller sets `features` as a plain key-value map, allow that.
  if (!('definitions' in features)) return features;

  return {};
}

function isPositiveSize(size) {
  return size
    && typeof size === 'object'
    && Number.isFinite(Number(size.width))
    && Number(size.width) > 0
    && Number.isFinite(Number(size.height))
    && Number(size.height) > 0;
}

function normalizeSize(size) {
  return {
    width: Math.round(Number(size.width)),
    height: Math.round(Number(size.height)),
  };
}

/**
 * The screen size a fullscreen companion's 3×2 grid is mapped against. The
 * companion tracks the Display Mode setting (panel = 720×480 by default,
 * switchable to full = 800×480 or custom), so it always fills the chosen
 * screen. An explicit `options.screenSize` wins (keeps the mapper injectable
 * and testable); otherwise read the live display config.
 */
function fullscreenScreenSize(options = {}) {
  if (isPositiveSize(options.screenSize)) return normalizeSize(options.screenSize);
  return getDisplayConfig().getScreenSize();
}

function resolveExportSize(doc, gridSize, options = {}) {
  if (options.slot === 'fullscreen') {
    return gridSizeToSize('3x2', fullscreenScreenSize(options));
  }
  if (isPositiveSize(options.size)) return normalizeSize(options.size);
  if (isPositiveSize(options.screenSize)) return gridSizeToSize(gridSize, normalizeSize(options.screenSize));
  if (isPositiveSize(doc?.misc?.size)) return normalizeSize(doc.misc.size);
  return gridSizeToSize(gridSize);
}

function resolveImportSize(miscIn, gridSize, options = {}) {
  if (options.slot === 'fullscreen') {
    return gridSizeToSize('3x2', fullscreenScreenSize(options));
  }
  if (isPositiveSize(options.screenSize)) return gridSizeToSize(gridSize, normalizeSize(options.screenSize));
  if (isPositiveSize(miscIn?.size)) return normalizeSize(miscIn.size);
  return gridSizeToSize(gridSize);
}

const ELEMENT_KNOWN_KEYS = new Set([
  'id',
  'type',
  'name',
  'visible',
  'opacity',
  'pos',
  'rotationDeg',
  'scale',
  'origin',

  'sizeX',
  'sizeY',

  'enableFill',
  'fill',

  'enableStroke',
  'strokeDither',
  'strokeWidth',
  'strokeDash',
  'strokeRadius',
  'strokeCap',
  'strokePosition',

  'points',

  'innerSize',
  'arcStartDeg',
  'arcEndDeg',

  'src',
  'svg',
  'bwMode',
  'bwLevel',

  'text',
  'fallbackText',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'textAlign',
  'lineHeight',
  'textFlow',

  // Graph-specific (consumed by the graph expander at render time)
  'chartType',
  'sourceId',
  'dataPath',
  'valuePath',
  'timePath',
  'resolution',
  'dataRangeStart',
  'dataRangeEnd',
  'showAxes',
  'showGrid',
  'gridLines',
  'showLabels',
  'labelFontSize',
  'labelFontWeight',
  'yMin',
  'yMax',
  'lineStrokeWidth',
  'lineStrokeDither',
  'lineStrokeRadius',
  'barGap',
  'barFillDither',
  'barStrokeEnabled',
  'barStrokeDither',
  'axisDither',
  'gridDither',
  'gridDash',
  'labelDither',
  'showXEndLabel',
  'xLabelInterval',
  'xLabelRotation',
  'showDateLabels',
  'showTitle',
  'titleText',
  'titleFontSize',
  'titleFontWeight',
  'titleDither',

  'extra',
]);

const SOURCE_KNOWN_KEYS = new Set([
  'id',
  'name',
  'kind',
  'enabled',
  'method',
  'url',
  'query',
  'headers',
  'auth',
  'body',
  'bodyType',
  'timeoutMs',
  'retries',
  'response',
  'responseType',
  'dataFields',
  'extra',
  // HA source keys
  'entity_id',
  'hoursBack',
  'attribute',
]);

/**
 * Convert an editor-format source into the server-expected shape.
 *
 * Editor uses flat keys (responseType, bodyType, body-as-string, auth-as-kv-map).
 * Server schemas expect nested objects (response.type, body.type, auth.type).
 */
export function normalizeSourceForExport(source) {
  const out = mergeExtraForExport(source);

  // responseType → response: { type }
  if (out.responseType && !out.response) {
    out.response = { type: out.responseType };
  }
  delete out.responseType;

  // bodyType + body (string) → body: { type, json/form/text } or omit
  // The server's buildBody() reads body.json, body.form, or body.text
  // depending on body.type — NOT a generic "content" key.
  if (out.bodyType && out.bodyType !== 'none') {
    const content = typeof out.body === 'string' ? out.body : '';
    const bodyObj = { type: out.bodyType };
    switch (out.bodyType) {
      case 'json':
        try { bodyObj.json = JSON.parse(content); }
        catch { bodyObj.json = content; }   // raw string – server sends as-is
        break;
      case 'form':
        bodyObj.form = parseFormString(content);
        break;
      case 'text':
        bodyObj.text = content;
        break;
    }
    out.body = bodyObj;
  } else if (!out.body || typeof out.body === 'string') {
    delete out.body;
  }
  delete out.bodyType;

  // auth: {} (empty object) → omit; auth without type → omit
  if (out.auth && typeof out.auth === 'object' && !out.auth.type) {
    delete out.auth;
  }

  // Keep `name` — it's a user-facing label that must survive round-trips
  // so sources are identifiable when the widget is reloaded.

  return out;
}

/**
 * Merge a primary widget's sources into a fullscreen companion's own sources.
 *
 * A companion is a SEPARATE document, so by default it cannot see the sources
 * declared on its primary widget — the user would have to add them twice. To
 * avoid that, the companion INHERITS the primary's sources. The merge is live
 * (computed at preview/export time, never persisted as a copy), so the primary
 * stays the single source of truth and the two docs can never drift.
 *
 * Precedence: a companion-own source whose `id` matches an inherited one
 * OVERRIDES it (companion wins) — a companion-defined `temp` is an intentional
 * override of the primary's `temp`. Dedup-by-id is mandatory: two sources
 * sharing an `id` in one payload would make `{{id.state}}` bind to whichever
 * the renderer reaches first.
 *
 * Inherited (non-overridden) primary sources come first, companion-own sources
 * (including overrides) after. Order is irrelevant to binding resolution, which
 * is keyed by `id`.
 */
export function mergeInheritedSources(primarySources, ownSources) {
  const own = normalizeArray(ownSources);
  const ownIds = new Set(own.map((s) => s?.id).filter((id) => id != null));
  const inherited = normalizeArray(primarySources).filter((s) => !ownIds.has(s?.id));
  return [...inherited, ...own];
}

export function exportRuntimeJson(editorDoc, options = {}) {
  const doc = editorDoc ?? createNewDocument();

  const gridSize = options.slot === 'fullscreen'
    ? '3x2'
    : normalizeGridSize(doc.misc?.gridSize);
  const { displayMode: _displayMode, ...miscIn } = doc.misc ?? {};
  const misc = {
    ...miscIn,
    gridSize,
    size: resolveExportSize(doc, gridSize, options),
  };

  // A fullscreen companion inherits its primary widget's sources so the same
  // source need not be declared twice. The caller passes the live primary
  // sources; we merge them in at export time only (nothing extra persisted —
  // the resulting payload is self-contained for the renderer, but the docStore
  // keeps a single copy on the primary). See `mergeInheritedSources`.
  const sources = options.slot === 'fullscreen' && options.primarySources
    ? mergeInheritedSources(options.primarySources, doc.sources)
    : normalizeArray(doc.sources);

  return {
    misc,
    features: resolveRuntimeFeatures(doc),
    sources: sources.map((source) => normalizeSourceForExport(source)),
    elements: normalizeArray(doc.elements).map((element) => {
      const exported = mergeExtraForExport(element);

      // Circle: builder stores pos as top-left of bounding box,
      // but the engine expects pos as the ellipse center.
      if (exported.type === 'circle') {
        const { cx, cy } = circlePosToCenter(
          exported.pos?.x ?? 0, exported.pos?.y ?? 0,
          exported.sizeX ?? 0, exported.sizeY ?? 0,
        );
        exported.pos = { x: cx, y: cy };
      }

      return exported;
    }),
  };
}

// ── Source ID migration (load-time) ───────────────────────────────
//
// A source ID becomes an expression-context root and must satisfy the server's
// `sourceSchema` (`/^[a-zA-Z][a-zA-Z0-9_-]*$/`, src/schema/sourceSchema.ts).
// Widgets saved before `createId()` guaranteed a letter-leading ID carry IDs
// the server rejects at POST /render/test-source with HTTP 400 "Invalid source
// config schema." — the old generator used a bare `crypto.randomUUID()`, which
// starts with a digit ~62% of the time — so those sources never fetch and any
// element bound to them shows "(no data)". We cannot re-key a source without
// also re-pointing everything that references it, so on import we rewrite each
// invalid source ID AND every reference to it: a graph's `element.sourceId`,
// `{{id.path|op}}` template bindings, and `{ "$": "id.path" }` binding objects.
// Already-valid IDs (including hyphenated ones — both the schema and the
// expression `resolvePath` accept hyphens) are left untouched so working
// widgets are not churned.

const SOURCE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function sourceIdNeedsMigration(id) {
  return typeof id !== 'string' || id.length === 0 || id.length > 64 || !SOURCE_ID_RE.test(id);
}

/** Deterministically derive a schema-valid source ID from an invalid one. */
function sanitizeSourceId(oldId) {
  let s = typeof oldId === 'string' ? oldId.replace(/[^a-zA-Z0-9_-]/g, '') : '';
  if (!/^[a-zA-Z]/.test(s)) s = `id_${s}`; // must start with a letter
  if (s.length > 64) s = s.slice(0, 64); // schema caps the ID at 64 chars
  if (!SOURCE_ID_RE.test(s)) s = createId(); // degenerate input → fresh ID
  return s;
}

/**
 * Build an `oldId → newId` map for every source whose ID the server schema
 * would reject. New IDs are unique across the whole source set — including IDs
 * that were already valid and are staying put — so a sanitized ID never
 * collides with an untouched one.
 */
function buildSourceIdMigration(sources) {
  const taken = new Set();
  for (const s of sources) {
    if (s && typeof s.id === 'string' && !sourceIdNeedsMigration(s.id)) taken.add(s.id);
  }
  const map = new Map();
  for (const s of sources) {
    if (!s || typeof s.id !== 'string' || !sourceIdNeedsMigration(s.id)) continue;
    let candidate = sanitizeSourceId(s.id);
    if (taken.has(candidate)) {
      const base = candidate.slice(0, 60);
      let n = 2;
      candidate = `${base}_${n}`;
      while (taken.has(candidate)) candidate = `${base}_${(n += 1)}`;
    }
    taken.add(candidate);
    map.set(s.id, candidate);
  }
  return map;
}

/** Rewrite the root segment of a dot/bracket path when it names a migrated source. */
function rewritePathRoot(path, idMap) {
  const m = /^(\s*)([A-Za-z0-9_-]+)([\s\S]*)$/.exec(path);
  if (!m) return path;
  const [, lead, root, tail] = m;
  return idMap.has(root) ? `${lead}${idMap.get(root)}${tail}` : path;
}

/** Rewrite `{{ root.path|ops }}` template bindings that name a migrated source. */
function rewriteTemplateString(str, idMap) {
  if (!str.includes('{{')) return str;
  return str.replace(/\{\{([^}]+)\}\}/g, (full, content) => {
    // Only the path (before the first `|` pipe-op) can hold the source root.
    const pipe = content.indexOf('|');
    const pathPart = pipe === -1 ? content : content.slice(0, pipe);
    const opsPart = pipe === -1 ? '' : content.slice(pipe);
    const rewritten = rewritePathRoot(pathPart, idMap);
    return rewritten === pathPart ? full : `{{${rewritten}${opsPart}}}`;
  });
}

/** Deep-rewrite every source reference inside one element value. */
function rewriteElementSourceRefs(value, idMap) {
  if (typeof value === 'string') return rewriteTemplateString(value, idMap);
  if (Array.isArray(value)) return value.map((v) => rewriteElementSourceRefs(v, idMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (key === 'sourceId' && typeof val === 'string' && idMap.has(val)) {
        out[key] = idMap.get(val); // graph element → source link
      } else if (key === '$' && typeof val === 'string') {
        out[key] = rewritePathRoot(val, idMap); // binding-object path
      } else {
        out[key] = rewriteElementSourceRefs(val, idMap);
      }
    }
    return out;
  }
  return value;
}

export function importRuntimeJson(runtimeJson, options = {}) {
  const baseDoc = createNewDocument();

  const miscIn = runtimeJson?.misc && typeof runtimeJson.misc === 'object' ? runtimeJson.misc : {};
  const { displayMode: _displayMode, ...miscRest } = miscIn;

  const gridSize = normalizeGridSize(miscIn.gridSize ?? baseDoc.misc.gridSize);
  const misc = {
    ...baseDoc.misc,
    ...miscRest,
    tags: Array.isArray(miscIn.tags) ? miscIn.tags : baseDoc.misc.tags,
    gridSize: options.slot === 'fullscreen' ? '3x2' : gridSize,
    size: resolveImportSize(miscIn, gridSize, options),
  };
  const runtimeFeatures =
    runtimeJson?.features && typeof runtimeJson.features === 'object' ? runtimeJson.features : {};

  const sourcesIn = normalizeArray(runtimeJson?.sources);
  const elementsIn = normalizeArray(runtimeJson?.elements);

  const nextNameForType = createNameGeneratorFromElements(elementsIn);

  const sources = sourcesIn
    .filter((s) => s && typeof s === 'object')
    .map((source) => {
      const known = stripToKnown(source, SOURCE_KNOWN_KEYS);
      const extra = extractExtra(source, SOURCE_KNOWN_KEYS);

      // Server → Editor: response.type → responseType
      if (known.response && typeof known.response === 'object' && known.response.type) {
        known.responseType = known.response.type;
      }
      delete known.response;

      // Server → Editor: body.type → bodyType, body.json/form/text → body (string)
      if (known.body && typeof known.body === 'object') {
        known.bodyType = known.body.type || 'none';
        switch (known.body.type) {
          case 'json':
            known.body = typeof known.body.json === 'string'
              ? known.body.json
              : known.body.json != null ? JSON.stringify(known.body.json, null, 2) : '';
            break;
          case 'form':
            known.body = known.body.form && typeof known.body.form === 'object'
              ? Object.entries(known.body.form).map(([k, v]) => `${k}=${v}`).join('\n')
              : '';
            break;
          case 'text':
            known.body = typeof known.body.text === 'string' ? known.body.text : '';
            break;
          default:
            // Fallback: try legacy "content" key for old payloads
            known.body = typeof known.body.content === 'string' ? known.body.content : '';
            break;
        }
      }

      return {
        ...known,
        extra: extra ?? undefined,
      };
    });

  const elements = elementsIn
    .filter((e) => e && typeof e === 'object')
    .map((element) => {
      const known = stripToKnown(element, ELEMENT_KNOWN_KEYS);
      const extra = extractExtra(element, ELEMENT_KNOWN_KEYS);

      const type =
        typeof known.type === 'string'
          ? known.type
          : typeof element.type === 'string'
            ? element.type
            : 'rect';

      const withBackfills = {
        ...known,
        type,
        id: typeof known.id === 'string' && known.id ? known.id : createId(),
        name: typeof known.name === 'string' && known.name ? known.name : nextNameForType(type),
      };

      // Circle: engine stores pos as center, builder uses top-left of bounding box.
      if (type === 'circle' && withBackfills.pos) {
        const { x: tlX, y: tlY } = centerToCirclePos(
          withBackfills.pos.x ?? 0, withBackfills.pos.y ?? 0,
          withBackfills.sizeX ?? 0, withBackfills.sizeY ?? 0,
        );
        withBackfills.pos = { x: tlX, y: tlY };
      }

      if (extra) withBackfills.extra = extra;

      return withBackfills;
    });

  // Migrate legacy schema-invalid source IDs (and re-point every reference) so
  // sources saved before createId() guaranteed a valid ID start fetching again.
  // No-op for the common case where every ID is already valid.
  const idMap = buildSourceIdMigration(sources);
  const migratedSources = idMap.size === 0
    ? sources
    : sources.map((s) =>
        s && typeof s.id === 'string' && idMap.has(s.id) ? { ...s, id: idMap.get(s.id) } : s,
      );
  const migratedElements = idMap.size === 0
    ? elements
    : elements.map((e) => rewriteElementSourceRefs(e, idMap));

  return {
    ...baseDoc,
    misc,

    // Keep editor-side definitions (for later). Store runtime features separately.
    features: {
      ...baseDoc.features,
      values: runtimeFeatures,
    },

    sources: migratedSources,
    elements: migratedElements,
  };
}
