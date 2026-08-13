/**
 * mapper.test.js — Tests for the editor ↔ server payload mapper
 *
 * Covers: createNameGeneratorFromElements, normalizeSourceForExport,
 * exportRuntimeJson → importRuntimeJson round-trip, unknown key preservation,
 * circle pos center ↔ top-left conversion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock dependencies ───────────────────────────────────────────

vi.mock('../document.js', () => {
  const normalizeGridSize = (gs) => {
    if (typeof gs !== 'string') return '1x1';
    const m = gs.trim().match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!m) return '1x1';
    return `${Math.max(1, +m[1])}x${Math.max(1, +m[2])}`;
  };
  const gridSizeToSize = (gs, screenSize) => {
    const m = normalizeGridSize(gs).match(/^(\d+)x(\d+)$/);
    if (screenSize) {
      return {
        width: Math.round((+m[1] / 3) * screenSize.width),
        height: Math.round((+m[2] / 2) * screenSize.height),
      };
    }
    return { width: +m[1] * 240, height: +m[2] * 240 };
  };
  return {
    SCREEN_WIDTH: 800,
    SCREEN_HEIGHT: 480,
    normalizeGridSize,
    gridSizeToSize,
    createNewDocument: () => ({
      misc: {
        name: '',
        type: '',
        subcategory: '',
        tags: [],
        gridSize: '3x2',
        size: { width: 720, height: 480 },
      },
      features: { definitions: {} },
      sources: [],
      elements: [],
    }),
  };
});

vi.mock('../elementDefaults.js', () => ({
  typeDisplayNames: {
    rect: 'Rectangle',
    circle: 'Circle',
    text: 'Text',
    line: 'Line',
    image: 'Image',
    graph: 'Graph',
  },
}));

// The fullscreen companion is sized against the current Display Mode; the
// default is 'panel' (720×480). The mapper now reads this for the fullscreen
// slot, so the mock returns the panel size.
vi.mock('../../store/displayConfigStore.js', () => ({
  getDisplayConfig: () => ({
    getScreenSize: () => ({ width: 720, height: 480 }),
  }),
}));

let _idCounter = 0;
vi.mock('../../utils/ids.js', () => ({
  createId: () => `test-id-${++_idCounter}`,
}));

import {
  createNameGeneratorFromElements,
  normalizeSourceForExport,
  mergeInheritedSources,
  exportRuntimeJson,
  importRuntimeJson,
} from '../mapper.js';

beforeEach(() => {
  _idCounter = 0;
});

// ── createNameGeneratorFromElements ────────────────────────────

describe('createNameGeneratorFromElements', () => {
  it('generates names starting at 1 for empty elements', () => {
    const next = createNameGeneratorFromElements([]);
    expect(next('rect')).toBe('Rectangle 1');
    expect(next('rect')).toBe('Rectangle 2');
  });

  it('continues numbering from existing elements', () => {
    const elements = [
      { type: 'rect', name: 'Rectangle 3' },
      { type: 'rect', name: 'Rectangle 1' },
    ];
    const next = createNameGeneratorFromElements(elements);
    expect(next('rect')).toBe('Rectangle 4');
  });

  it('tracks different types independently', () => {
    const elements = [
      { type: 'rect', name: 'Rectangle 2' },
      { type: 'text', name: 'Text 5' },
    ];
    const next = createNameGeneratorFromElements(elements);
    expect(next('rect')).toBe('Rectangle 3');
    expect(next('text')).toBe('Text 6');
  });

  it('skips invalid elements (null, missing type/name)', () => {
    const elements = [null, {}, { type: 'rect' }, { name: 'test' }];
    const next = createNameGeneratorFromElements(elements);
    expect(next('rect')).toBe('Rectangle 1');
  });

  it('uses "Element" for unknown types', () => {
    const next = createNameGeneratorFromElements([]);
    expect(next('unknown_type')).toBe('Element 1');
  });
});

// ── normalizeSourceForExport ───────────────────────────────────

describe('normalizeSourceForExport', () => {
  it('converts responseType → response.type', () => {
    const source = { id: 's1', responseType: 'json' };
    const out = normalizeSourceForExport(source);
    expect(out.response).toEqual({ type: 'json' });
    expect(out.responseType).toBeUndefined();
  });

  it('converts bodyType json with string body', () => {
    const source = { id: 's1', bodyType: 'json', body: '{"key":"val"}' };
    const out = normalizeSourceForExport(source);
    expect(out.body).toEqual({ type: 'json', json: { key: 'val' } });
    expect(out.bodyType).toBeUndefined();
  });

  it('converts bodyType form', () => {
    const source = { id: 's1', bodyType: 'form', body: 'a=1\nb=2' };
    const out = normalizeSourceForExport(source);
    expect(out.body).toEqual({ type: 'form', form: { a: '1', b: '2' } });
  });

  it('converts bodyType text', () => {
    const source = { id: 's1', bodyType: 'text', body: 'raw content' };
    const out = normalizeSourceForExport(source);
    expect(out.body).toEqual({ type: 'text', text: 'raw content' });
  });

  it('removes body when bodyType is none', () => {
    const source = { id: 's1', bodyType: 'none', body: '' };
    const out = normalizeSourceForExport(source);
    expect(out.body).toBeUndefined();
  });

  it('removes auth without type', () => {
    const source = { id: 's1', auth: {} };
    const out = normalizeSourceForExport(source);
    expect(out.auth).toBeUndefined();
  });

  it('keeps auth with type', () => {
    const source = { id: 's1', auth: { type: 'bearer', token: 'abc' } };
    const out = normalizeSourceForExport(source);
    expect(out.auth).toEqual({ type: 'bearer', token: 'abc' });
  });
});

// ── mergeInheritedSources ──────────────────────────────────────

describe('mergeInheritedSources', () => {
  it('returns the primary sources verbatim when the companion has none', () => {
    const primary = [{ id: 'a' }, { id: 'b' }];
    expect(mergeInheritedSources(primary, [])).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('appends companion-own sources after inherited ones', () => {
    const primary = [{ id: 'a' }];
    const own = [{ id: 'b' }];
    expect(mergeInheritedSources(primary, own)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('lets a companion source override a primary source with the same id (companion wins, no duplicate)', () => {
    const primary = [{ id: 'temp', url: 'primary' }];
    const own = [{ id: 'temp', url: 'companion' }];
    const merged = mergeInheritedSources(primary, own);
    expect(merged).toEqual([{ id: 'temp', url: 'companion' }]);
    // Exactly one source per id — never two `temp`s in the payload.
    expect(merged.filter((s) => s.id === 'temp')).toHaveLength(1);
  });

  it('tolerates missing/non-array inputs', () => {
    expect(mergeInheritedSources(undefined, undefined)).toEqual([]);
    expect(mergeInheritedSources(null, [{ id: 'a' }])).toEqual([{ id: 'a' }]);
    expect(mergeInheritedSources([{ id: 'a' }], null)).toEqual([{ id: 'a' }]);
  });
});

// ── exportRuntimeJson ──────────────────────────────────────────

describe('exportRuntimeJson', () => {
  it('exports a minimal document', () => {
    const doc = {
      misc: { gridSize: '1x1' },
      features: { values: { temp: 22 } },
      sources: [],
      elements: [],
    };
    const out = exportRuntimeJson(doc);
    expect(out.misc.gridSize).toBe('1x1');
    expect(out.features).toEqual({ temp: 22 });
    expect(out.sources).toEqual([]);
    expect(out.elements).toEqual([]);
  });

  it('does not export editor-only displayMode', () => {
    const doc = {
      misc: { gridSize: '1x1', displayMode: 'panel', size: { width: 240, height: 240 } },
      sources: [],
      elements: [],
    };

    const out = exportRuntimeJson(doc);

    expect(out.misc.displayMode).toBeUndefined();
    expect(out.misc.size).toEqual({ width: 240, height: 240 });
  });

  it('sizes fullscreen companions to the display-mode screen size (panel default 720×480)', () => {
    const doc = {
      misc: { gridSize: '1x1', size: { width: 240, height: 240 } },
      sources: [],
      elements: [],
    };

    const out = exportRuntimeJson(doc, { slot: 'fullscreen' });

    // Companion is always the full 3×2 grid, mapped against the current
    // display mode (panel = 720×480 by default), regardless of the doc's
    // own gridSize/size.
    expect(out.misc.gridSize).toBe('3x2');
    expect(out.misc.size).toEqual({ width: 720, height: 480 });
  });

  it('honors an explicit options.screenSize for the fullscreen slot (full = 800×480)', () => {
    const doc = {
      misc: { gridSize: '1x1', size: { width: 240, height: 240 } },
      sources: [],
      elements: [],
    };

    const out = exportRuntimeJson(doc, { slot: 'fullscreen', screenSize: { width: 800, height: 480 } });

    expect(out.misc.gridSize).toBe('3x2');
    expect(out.misc.size).toEqual({ width: 800, height: 480 });
  });

  it('merges primary sources into a fullscreen companion payload', () => {
    const companion = {
      misc: { gridSize: '1x1', size: { width: 240, height: 240 } },
      sources: [{ id: 'companionOnly', kind: 'http', url: 'https://c.example' }],
      elements: [],
    };
    const primarySources = [{ id: 'shared', kind: 'http', url: 'https://p.example' }];

    const out = exportRuntimeJson(companion, { slot: 'fullscreen', primarySources });

    const ids = out.sources.map((s) => s.id);
    expect(ids).toContain('shared');
    expect(ids).toContain('companionOnly');
  });

  it('does not inherit primary sources for the primary slot', () => {
    const doc = {
      misc: { gridSize: '1x1' },
      sources: [{ id: 'own', kind: 'http', url: 'https://x.example' }],
      elements: [],
    };
    // primarySources is ignored unless slot === 'fullscreen'.
    const out = exportRuntimeJson(doc, { primarySources: [{ id: 'shared' }] });
    expect(out.sources.map((s) => s.id)).toEqual(['own']);
  });

  it('converts circle pos to center', () => {
    const doc = {
      misc: { gridSize: '1x1' },
      sources: [],
      elements: [{ type: 'circle', pos: { x: 10, y: 20 }, sizeX: 40, sizeY: 60 }],
    };
    const out = exportRuntimeJson(doc);
    expect(out.elements[0].pos).toEqual({ x: 30, y: 50 });
  });

  it('merges extra fields into element on export', () => {
    const doc = {
      misc: { gridSize: '1x1' },
      sources: [],
      elements: [{ type: 'rect', pos: { x: 0, y: 0 }, extra: { customProp: 42 } }],
    };
    const out = exportRuntimeJson(doc);
    expect(out.elements[0].customProp).toBe(42);
    expect(out.elements[0].extra).toBeUndefined();
  });
});

// ── importRuntimeJson ──────────────────────────────────────────

describe('importRuntimeJson', () => {
  it('strips legacy displayMode on import but preserves saved size', () => {
    const doc = importRuntimeJson({
      misc: { gridSize: '2x1', displayMode: 'panel', size: { width: 480, height: 240 } },
      sources: [],
      elements: [],
    });

    expect(doc.misc.displayMode).toBeUndefined();
    expect(doc.misc.size).toEqual({ width: 480, height: 240 });
  });

  it('assigns IDs to elements without one', () => {
    const json = {
      misc: { gridSize: '1x1' },
      sources: [],
      elements: [{ type: 'rect' }],
    };
    const doc = importRuntimeJson(json);
    expect(doc.elements[0].id).toBe('test-id-1');
  });

  it('preserves existing element IDs', () => {
    const json = {
      misc: {},
      sources: [],
      elements: [{ type: 'rect', id: 'my-id', name: 'My Rect' }],
    };
    const doc = importRuntimeJson(json);
    expect(doc.elements[0].id).toBe('my-id');
  });

  it('generates names for elements without one', () => {
    const json = {
      misc: {},
      sources: [],
      elements: [{ type: 'rect' }, { type: 'rect' }],
    };
    const doc = importRuntimeJson(json);
    expect(doc.elements[0].name).toBe('Rectangle 1');
    expect(doc.elements[1].name).toBe('Rectangle 2');
  });

  it('converts circle center pos to top-left', () => {
    const json = {
      misc: {},
      sources: [],
      elements: [{ type: 'circle', pos: { x: 30, y: 50 }, sizeX: 40, sizeY: 60 }],
    };
    const doc = importRuntimeJson(json);
    expect(doc.elements[0].pos).toEqual({ x: 10, y: 20 });
  });

  it('captures unknown element keys in extra', () => {
    const json = {
      misc: {},
      sources: [],
      elements: [{ type: 'rect', id: 'e1', name: 'R', customField: 'hello' }],
    };
    const doc = importRuntimeJson(json);
    expect(doc.elements[0].extra).toEqual({ customField: 'hello' });
  });

  it('imports source response.type → responseType', () => {
    const json = {
      misc: {},
      sources: [{ id: 's1', response: { type: 'json' } }],
      elements: [],
    };
    const doc = importRuntimeJson(json);
    expect(doc.sources[0].responseType).toBe('json');
    expect(doc.sources[0].response).toBeUndefined();
  });

  it('imports source body.json → body string + bodyType', () => {
    const json = {
      misc: {},
      sources: [{ id: 's1', body: { type: 'json', json: { key: 'val' } } }],
      elements: [],
    };
    const doc = importRuntimeJson(json);
    expect(doc.sources[0].bodyType).toBe('json');
    expect(doc.sources[0].body).toBe('{\n  "key": "val"\n}');
  });
});

// ── Legacy source-ID migration ─────────────────────────────────

describe('importRuntimeJson — legacy source ID migration', () => {
  it('rewrites a schema-invalid (digit-leading) source ID and every reference', () => {
    // Old createId() produced bare UUIDs like this — digit-leading, so the
    // server rejected the source with "Invalid source config schema."
    const bad = '3f4a9c1e-2b6d-4f8a-9c0e-1a2b3c4d5e6f';
    const json = {
      misc: {},
      sources: [{ id: bad, kind: 'haState', entity_id: 'sensor.temp' }],
      elements: [
        { type: 'text', id: 'e1', name: 'T', text: `{{${bad}.state}}°C` },
        { type: 'graph', id: 'e2', name: 'G', sourceId: bad },
        { type: 'text', id: 'e3', name: 'P', text: `{{${bad}.state|round|format:1}}` },
      ],
    };
    const doc = importRuntimeJson(json);
    const newId = doc.sources[0].id;

    // New ID is schema-valid (letter-leading, ≤64) and no longer the old one.
    expect(newId).not.toBe(bad);
    expect(newId).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
    expect(newId.length).toBeLessThanOrEqual(64);

    // Every reference now points at the new ID.
    expect(doc.elements[0].text).toBe(`{{${newId}.state}}°C`);
    expect(doc.elements[1].sourceId).toBe(newId);
    expect(doc.elements[2].text).toBe(`{{${newId}.state|round|format:1}}`);
  });

  it('rewrites { "$": "id.path" } binding-object references', () => {
    const bad = '0abc-def';
    const json = {
      misc: {},
      sources: [{ id: bad, kind: 'haState', entity_id: 'sensor.temp' }],
      elements: [{ type: 'text', id: 'e1', name: 'T', visible: { $: `${bad}.state` } }],
    };
    const doc = importRuntimeJson(json);
    const newId = doc.sources[0].id;
    expect(newId).not.toBe(bad);
    expect(doc.elements[0].visible).toEqual({ $: `${newId}.state` });
  });

  it('leaves already-valid source IDs (including hyphenated) untouched', () => {
    const json = {
      misc: {},
      sources: [
        { id: 'src_1', kind: 'haState', entity_id: 'sensor.a' },
        { id: 'src-2-v3', kind: 'haState', entity_id: 'sensor.b' },
      ],
      elements: [{ type: 'text', id: 'e1', name: 'T', text: '{{src_1.state}} {{src-2-v3.state}}' }],
    };
    const doc = importRuntimeJson(json);
    expect(doc.sources.map((s) => s.id)).toEqual(['src_1', 'src-2-v3']);
    // No new object identity churn for the text either — references unchanged.
    expect(doc.elements[0].text).toBe('{{src_1.state}} {{src-2-v3.state}}');
  });

  it('avoids collisions when a sanitized ID would clash with an existing valid one', () => {
    const json = {
      misc: {},
      sources: [
        { id: 'id_99', kind: 'haState', entity_id: 'sensor.a' }, // already valid, reserved
        { id: '99', kind: 'haState', entity_id: 'sensor.b' }, // sanitizes to id_99 → must differ
      ],
      elements: [],
    };
    const doc = importRuntimeJson(json);
    expect(doc.sources[0].id).toBe('id_99');
    expect(doc.sources[1].id).not.toBe('id_99');
    expect(doc.sources[1].id).toMatch(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
  });
});

// ── Round-trip ─────────────────────────────────────────────────

describe('export → import round-trip stability', () => {
  it('round-trip preserves rect elements', () => {
    const original = {
      misc: { gridSize: '1x1' },
      features: { values: { temp: 22 } },
      sources: [],
      elements: [
        { type: 'rect', id: 'r1', name: 'Rectangle 1', pos: { x: 0, y: 0 }, sizeX: 100, sizeY: 50 },
      ],
    };
    const exported = exportRuntimeJson(original);
    const imported = importRuntimeJson(exported);
    const reExported = exportRuntimeJson(imported);

    // Second export should match first
    expect(reExported.elements[0].type).toBe('rect');
    expect(reExported.elements[0].id).toBe('r1');
    expect(reExported.elements[0].pos).toEqual(exported.elements[0].pos);
  });

  it('round-trip preserves circle center conversion', () => {
    const original = {
      misc: { gridSize: '1x1' },
      sources: [],
      elements: [
        { type: 'circle', id: 'c1', name: 'Circle 1', pos: { x: 10, y: 20 }, sizeX: 40, sizeY: 60 },
      ],
    };
    const exported = exportRuntimeJson(original);
    // Export converts to center: (10+20, 20+30) = (30, 50)
    expect(exported.elements[0].pos).toEqual({ x: 30, y: 50 });

    const imported = importRuntimeJson(exported);
    // Import converts back to top-left
    expect(imported.elements[0].pos).toEqual({ x: 10, y: 20 });

    const reExported = exportRuntimeJson(imported);
    expect(reExported.elements[0].pos).toEqual({ x: 30, y: 50 });
  });

  it('round-trip keeps textFlow a top-level field (fixed frames must survive reopen)', () => {
    // Regression: textFlow was missing from ELEMENT_KNOWN_KEYS, so reopening
    // a saved widget shunted it into `extra`. Every reader coerces an absent
    // textFlow to auto, so the auto-size hook shrink-wrapped the frame to one
    // long line and the authored width was clobbered on the next save.
    const original = {
      misc: { gridSize: '1x1' },
      sources: [],
      elements: [
        { type: 'text', id: 't1', name: 'Text 1', pos: { x: 4, y: 4 }, sizeX: 80, sizeY: 40, text: 'hello world', textFlow: 'fixed' },
      ],
    };
    const exported = exportRuntimeJson(original);
    expect(exported.elements[0].textFlow).toBe('fixed');

    const imported = importRuntimeJson(exported);
    expect(imported.elements[0].textFlow).toBe('fixed'); // top level, where readers look
    expect(imported.elements[0].extra).toBeUndefined(); // not smuggled through extra
    expect(imported.elements[0].sizeX).toBe(80);
    expect(imported.elements[0].sizeY).toBe(40);

    const reExported = exportRuntimeJson(imported);
    expect(reExported.elements[0].textFlow).toBe('fixed');
  });

  it('round-trip preserves sources with JSON body', () => {
    const original = {
      misc: { gridSize: '1x1' },
      sources: [{ id: 's1', name: 'API', responseType: 'json', bodyType: 'json', body: '{"a":1}' }],
      elements: [],
    };
    const exported = exportRuntimeJson(original);
    const imported = importRuntimeJson(exported);
    const reExported = exportRuntimeJson(imported);

    expect(reExported.sources[0].response).toEqual({ type: 'json' });
    expect(reExported.sources[0].body.type).toBe('json');
    expect(reExported.sources[0].body.json).toEqual({ a: 1 });
  });
});
