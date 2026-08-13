import { current } from 'immer';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

import { createNewDocument, gridSizeToSize, normalizeGridSize, REF_COLS, REF_ROWS } from '../models/document.js';
import { createElement } from '../models/elementDefaults.js';
import { isFramedTextFlow } from '@shared/textLayout';
import { createNameGeneratorFromElements, importRuntimeJson, mergeInheritedSources } from '../models/mapper.js';
import { getDisplayConfig } from './displayConfigStore.js';
import { createId } from '../utils/ids.js';
import { isBinding, isExpression } from '@zb/expressions';
import { fullscreenIdFor, isFullscreenId, primaryIdOf } from './companionId.js';

const HISTORY_LIMIT = 100;

// Max sources per widget. Mirrors MAX_SOURCES in the server's `src/limits.ts`
// (surfaced through payloadSchema.ts) so the shared pool can never grow past
// what either slot's export accepts. The two install trees share no code —
// change both together.
export const MAX_SOURCES = 500;

// Above this many sources the builder warns the user once per widget that
// fetching this many on low-power hardware can slow saves and refreshes. It is
// advisory only — adding past it is allowed, all the way to MAX_SOURCES.
export const SOURCE_WARN_THRESHOLD = 50;

// ── Fallback constants (stable references for unfocused state) ───────
// Module-level singletons so Zustand's === equality check returns the
// same reference every call when no doc is focused, preventing re-renders.
const EMPTY_DOC = Object.freeze({ misc: {}, elements: [], sources: [], features: {} });
const EMPTY_HISTORY = Object.freeze({ past: [], future: [] });

/**
 * Temporary doc ID used during the grid-size-selector flow.
 * Cleaned up by closeDoc() once the real widget ID is assigned.
 */
export const PENDING_DOC_ID = '__pending';

// ── Selector helpers ─────────────────────────────────────────────────
// All consumers MUST use these instead of deep-path access.

/** Returns the focused doc object, or a frozen empty doc if nothing focused. */
export const selectFocusedDoc = (state) =>
  state.focusedDocId ? state.docs[state.focusedDocId]?.doc ?? EMPTY_DOC : EMPTY_DOC;

/** Returns the focused doc's history { past, future }. */
export const selectFocusedHistory = (state) =>
  state.focusedDocId ? state.docs[state.focusedDocId]?.history ?? EMPTY_HISTORY : EMPTY_HISTORY;

/** Returns the focused doc's elements array. */
export const selectFocusedElements = (state) =>
  selectFocusedDoc(state).elements;

/** Returns the focused doc's misc object. */
export const selectFocusedMisc = (state) =>
  selectFocusedDoc(state).misc;

/**
 * Returns the SHARED source pool for the focused widget.
 *
 * A widget's primary view and its optional fullscreen companion share ONE
 * source pool, physically anchored on the always-present primary entry (the
 * companion is optional and may be absent, so it can't host the pool). Both
 * screens read this same array — so a source added/edited on either screen is
 * immediately visible on the other. Stable `EMPTY_DOC.sources` reference avoids
 * re-renders when nothing is focused.
 */
export const selectSharedSources = (state) => {
  const focused = state.focusedDocId;
  if (!focused) return EMPTY_DOC.sources;
  return state.docs[primaryIdOf(focused)]?.doc?.sources ?? EMPTY_DOC.sources;
};

/**
 * Returns the focused widget's sources. Delegates to the shared pool so the
 * companion sees the same sources as its primary. This is the canonical
 * selector every source-consuming UI (SourcesPanel, BindingExpressionEditor,
 * ValueEditor, DataExplorerPanel, GraphInspectorPanel) subscribes to, so the
 * delegation alone unifies the read side on both screens.
 */
export const selectFocusedSources = (state) => selectSharedSources(state);

/** Returns the focused doc's features object. */
export const selectFocusedFeatures = (state) =>
  selectFocusedDoc(state).features;

/** Returns the focused widget ID. */
export const selectFocusedDocId = (state) => state.focusedDocId;

/** Returns the primary doc paired with the focused widget/companion. */
export const selectFocusedPrimaryDoc = (state) => {
  const focused = state.focusedDocId;
  if (!focused) return null;
  return state.docs[primaryIdOf(focused)]?.doc ?? null;
};

/** Returns the fullscreen companion doc paired with the focused widget. */
export const selectFocusedCompanionDoc = (state) => {
  const focused = state.focusedDocId;
  if (!focused) return null;
  const companionId = fullscreenIdFor(primaryIdOf(focused));
  return state.docs[companionId]?.doc ?? null;
};

/** Returns array of all open widget IDs. */
export const selectOpenDocIds = (state) => Object.keys(state.docs);

/** Returns true if ANY open doc has unsaved changes. */
export const selectHasUnsavedChanges = (state) =>
  Object.values(state.docs).some((entry) => entry.dirty);

// ── Companion-pane selectors ─────────────────────────────────────────
//
// A widget MAY have a fullscreen companion stored as a second entry under
// `<widgetId>::fullscreen` (see `companionId.js`). The selectors below let
// the right-hand pane render that companion without inventing per-id
// factory selectors — they always look up the companion paired with the
// CURRENTLY-FOCUSED widget.

/**
 * Returns the focused widget's companion doc ID, or `null` when:
 *   - nothing is focused, OR
 *   - the focused id is itself a companion (no nesting), OR
 *   - no companion entry exists in the docs map for this widget.
 */
export const selectCompanionDocId = (state) => {
  const focused = state.focusedDocId;
  if (!focused || isFullscreenId(focused)) return null;
  const companionId = fullscreenIdFor(focused);
  return state.docs[companionId] ? companionId : null;
};

/**
 * Returns the companion doc's elements array, or an empty array when no
 * companion is present. Stable empty-array reference avoids re-renders.
 */
export const selectCompanionElements = (state) => {
  const id = selectCompanionDocId(state);
  return id ? state.docs[id].doc.elements : EMPTY_DOC.elements;
};

// ── Internal helpers ─────────────────────────────────────────────────

function applyDeepishPatch(target, patch) {
  if (!patch) return;

  for (const [key, value] of Object.entries(patch)) {
    // Binding / expression objects are atomic values — replace, never merge.
    if (value && typeof value === 'object' && !Array.isArray(value)
        && !isBinding(value) && !isExpression(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) {
        target[key] = {};
      }
      Object.assign(target[key], value);
      continue;
    }

    target[key] = value;
  }
}

function cloneDoc(doc) {
  // Use immer's current() to get a plain object from a draft, then deep-clone
  const plain = current(doc);
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(plain);
  }
  return JSON.parse(JSON.stringify(plain));
}

function screenSizeForDocId(docId) {
  // Primary and companion read independent size settings (widgetMode vs
  // displayMode), so resizing one never reflows the other. Both default to
  // panel = 720×480 and can be switched to full = 800×480 (companion also
  // supports custom) via the Settings tab.
  return getDisplayConfig().getScreenSize(isFullscreenId(docId) ? 'companion' : 'primary');
}

function normalizeDoc(doc, screenSize) {
  const gridSize = normalizeGridSize(doc?.misc?.gridSize);
  doc.misc.gridSize = gridSize;
  doc.misc.size = gridSizeToSize(gridSize, screenSize);
  if (!Array.isArray(doc.misc.tags)) doc.misc.tags = [];
}

/** Record current doc into the entry's undo history stack. */
function recordHistory(entry) {
  entry.history.past.push(cloneDoc(entry.doc));
  entry.history.future = [];

  if (entry.history.past.length > HISTORY_LIMIT) {
    entry.history.past.splice(0, entry.history.past.length - HISTORY_LIMIT);
  }
}

/** Create a fresh doc entry for the docs map. */
function createEntry(doc) {
  return {
    doc,
    history: { past: [], future: [] },
    dirty: false,
    lastSavedHash: null,
  };
}

/**
 * Get the focused doc entry from state. Returns null if nothing focused.
 * Used by mutation actions to scope operations to the active document.
 */
function getFocusedEntry(state) {
  return state.focusedDocId ? state.docs[state.focusedDocId] ?? null : null;
}

/**
 * Get the SOURCE-OWNING entry for the focused doc — always the primary entry,
 * even when a fullscreen companion is focused (`primaryIdOf` strips the
 * `::fullscreen` suffix). Source CRUD and source-undo scope here so both
 * screens mutate the one shared pool anchored on the always-present primary.
 * Returns null when no primary entry exists.
 */
function getPrimaryEntryFor(state) {
  return state.focusedDocId ? state.docs[primaryIdOf(state.focusedDocId)] ?? null : null;
}

/**
 * Mark the fullscreen companion paired with the focused widget dirty (when one
 * exists). A source mutation always targets the primary entry (dirtied by the
 * caller); flipping the companion too guarantees auto-save re-exports the
 * fullscreen payload, whose merged sources just changed. No-op when there is no
 * companion.
 */
function markCompanionDirty(state) {
  const companion = state.docs[fullscreenIdFor(primaryIdOf(state.focusedDocId))];
  if (companion) companion.dirty = true;
}

/**
 * Order-independent fingerprint of a source pool, keyed by source id. Binding
 * resolution is keyed by id (not order), so a pure reorder must NOT read as a
 * change — used by the migration fold to dirty the primary only on a real change.
 */
function sourcePoolFingerprint(sources) {
  const byId = {};
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && s.id != null) byId[s.id] = s;
  }
  return Object.keys(byId).sort().map((id) => JSON.stringify(byId[id])).join('|');
}

export const useDocStore = create(
  immer((set) => ({
    focusedDocId: null,
    docs: {},

    // ── Lifecycle actions ────────────────────────────────────────────

    /**
     * Create a new blank document for the given widget ID.
     * The screen size argument is required — without it the document
     * has no pixel dimensions.
     * Does NOT change focus — caller must call switchFocus() separately
     * (consistent with openDoc behavior).
     */
    newDoc(widgetId) {
      set((state) => {
        state.docs[widgetId] = createEntry(
          createNewDocument(screenSizeForDocId(widgetId)),
        );
      });
      getDisplayConfig().resetGridSizeConfirmation();
    },

    /**
     * Open (or re-open) a widget from parsed JSON.
     * Creates an entry in docs[widgetId] with empty history and dirty: false.
     * If the entry already exists, replaces doc + resets history.
     */
    openDoc(widgetId, json) {
      set((state) => {
        const slot = isFullscreenId(widgetId) ? 'fullscreen' : 'primary';
        state.docs[widgetId] = createEntry(importRuntimeJson(json, { slot }));
      });
      getDisplayConfig().confirmGridSize();
    },

    /**
     * Remove an entry from the docs map.
     * If the closed doc was focused, focus shifts to another open doc or null.
     */
    closeDoc(widgetId) {
      set((state) => {
        delete state.docs[widgetId];
        if (state.focusedDocId === widgetId) {
          const remaining = Object.keys(state.docs);
          state.focusedDocId = remaining.length > 0 ? remaining[0] : null;
        }
      });
    },

    /**
     * Remove a primary widget and its fullscreen companion in one state
     * transaction. This prevents transient focus on a deleted companion.
     */
    closeWidgetDocs(widgetId) {
      set((state) => {
        const primaryId = primaryIdOf(widgetId);
        const companionId = fullscreenIdFor(primaryId);
        delete state.docs[companionId];
        delete state.docs[primaryId];
        if (state.focusedDocId === primaryId || state.focusedDocId === companionId) {
          const remaining = Object.keys(state.docs);
          state.focusedDocId = remaining.length > 0 ? remaining[0] : null;
        }
      });
    },

    /**
     * Set the focused document. No-op if widgetId is not in docs.
     * Does NOT flush auto-save — that is the platform layer's responsibility.
     */
    switchFocus(widgetId) {
      set((state) => {
        if (!state.docs[widgetId]) return;
        state.focusedDocId = widgetId;
      });
    },

    /**
     * Mark a widget's entry as clean after a successful save.
     * Resets dirty flag and records the serialized doc hash.
     */
    markClean(widgetId, hash) {
      set((state) => {
        const entry = state.docs[widgetId];
        if (!entry) return;
        entry.dirty = false;
        entry.lastSavedHash = hash ?? null;
      });
    },

    /**
     * Migration: consolidate a fullscreen companion's OWN sources onto the
     * shared pool on the primary, then empty the companion's own array so the
     * pool stays the single editable copy. Call once after both docs are opened.
     *
     * Folds via `mergeInheritedSources(primary, companion)` — companion wins on
     * id collision, reproducing the legacy deploy/render result so migrated
     * widgets look identical on screen. Uses plain snapshots (immer `current`)
     * so no cross-draft references leak between the two entries.
     *
     * Idempotent: a no-op when the companion is absent or has no own sources,
     * and a re-fold of an already-consolidated pool produces no change. Marks
     * the primary dirty ONLY on a real change (not a pure reorder), so a clean
     * load never triggers a spurious auto-save.
     */
    mergeCompanionSourcesIntoPrimary(widgetId) {
      set((state) => {
        const primaryId = primaryIdOf(widgetId);
        const primary = state.docs[primaryId];
        const companion = state.docs[fullscreenIdFor(primaryId)];
        if (!primary || !companion) return;
        if (!Array.isArray(companion.doc.sources) || companion.doc.sources.length === 0) return;

        const primaryPlain = current(primary.doc.sources);
        const ownPlain = current(companion.doc.sources);
        const merged = mergeInheritedSources(primaryPlain, ownPlain);

        if (merged.length > MAX_SOURCES) {
          // Legacy widgets could store a full cap's worth of sources on EACH blob
          // independently, so the fold may exceed the per-payload cap. Folding
          // anyway would dirty the primary, auto-save, and 400 on every save while
          // the companion's own sources are already gone from memory. Leave the
          // widget in its valid legacy shape (each blob within the cap) and
          // surface the problem instead.
          console.error(
            `[docStore] Widget "${primaryId}" would have ${merged.length} sources after merging its `
            + `fullscreen companion (cap ${MAX_SOURCES}). Skipping consolidation — reduce sources to unify.`,
          );
          return;
        }

        primary.doc.sources = merged;
        companion.doc.sources = [];

        if (sourcePoolFingerprint(primaryPlain) !== sourcePoolFingerprint(merged)) {
          primary.dirty = true;
        }
      });
    },

    /**
     * Replace the focused document's content from parsed JSON.
     * Used by the JSON editor (LeftPanel) for inline edits.
     * Resets undo history. Marks dirty.
     */
    replaceDocFromJson(json) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const imported = importRuntimeJson(json);
        // The shared pool is capped at MAX_SOURCES. Refuse a JSON edit that would
        // push it past the cap (the companion JSON tab shows the MERGED pool, so
        // an over-cap legacy widget can surface >50 here) rather than build a
        // pool that 400s on every save. Mirrors the guard on addSource / the
        // migration fold; applies to both primary and companion JSON edits.
        if ((imported.sources?.length ?? 0) > MAX_SOURCES) {
          console.error(
            `[docStore] JSON edit would set ${imported.sources.length} sources `
            + `(cap ${MAX_SOURCES}); edit not applied.`,
          );
          return;
        }
        // Sources are a shared pool on the primary. When a COMPANION's JSON is
        // edited, route its sources to the primary pool (keeping the companion's
        // own array empty) so the JSON editor stays consistent with the rest of
        // the unified-pool UI. The companion JSON is shown WITH the merged pool
        // (LeftPanel passes primarySources), so `imported.sources` already holds
        // the intended pool contents.
        if (isFullscreenId(state.focusedDocId)) {
          const primary = getPrimaryEntryFor(state);
          if (primary && primary !== entry) {
            primary.doc.sources = imported.sources;
            primary.dirty = true;
            imported.sources = [];
          }
        }
        entry.doc = imported;
        entry.history = { past: [], future: [] };
        normalizeDoc(entry.doc, screenSizeForDocId(state.focusedDocId));
        entry.dirty = true;
      });
    },

    // ── Mutation actions ─────────────────────────────────────────────

    /** Recalculate document size from grid + current display mode (derived, does NOT dirty). */
    refreshSize() {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        normalizeDoc(entry.doc, screenSizeForDocId(state.focusedDocId));
      });
    },

    /**
     * Force the focused PRIMARY widget to occupy the FULL device screen at an
     * explicit pixel size, PER WIDGET — deliberately bypassing the global
     * widgetMode-derived normalize (which would re-read the shared setting).
     *
     * Self-host widgets are always full screen; the sidebar toggle only picks
     * the drawable width: 720×480 (HA sidebar column reserved) vs 800×480
     * (whole screen). Flipping the GLOBAL widgetMode would reflow every open
     * widget, so we instead pin THIS doc's own misc: gridSize to the full-screen
     * reference grid (REF_COLS×REF_ROWS) and size to the passed preset. Marks
     * the doc dirty so auto-save persists it, and records history so it's undoable.
     *
     * @param {{width:number,height:number}} size — the full-screen preset to pin.
     */
    setFocusedFullScreen(size) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry || !size) return;
        const width = Number(size.width);
        const height = Number(size.height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
        const gridSize = `${REF_COLS}x${REF_ROWS}`; // full-screen reference grid
        // The reference grid maps 1:1 to the full screen, so gridSizeToSize here
        // returns exactly {width, height} — i.e. the passed preset, written
        // directly instead of re-derived from the global widgetMode.
        const nextSize = gridSizeToSize(gridSize, { width, height });
        const misc = entry.doc.misc;
        // No-op when the widget already IS full-screen at this size (the common
        // sidebar-on path: a fresh 'panel' widget is already 3x2 / 720×480).
        // Skips a redundant auto-save and a confusing no-op undo step.
        if (misc.gridSize === gridSize && misc.size?.width === nextSize.width
            && misc.size?.height === nextSize.height) {
          return;
        }
        recordHistory(entry);
        misc.gridSize = gridSize;
        misc.size = nextSize;
        if (!Array.isArray(misc.tags)) misc.tags = [];
        entry.dirty = true;
      });
    },

    /**
     * Re-derive the size of EVERY open fullscreen companion from the current
     * Display Mode and mark each touched companion dirty so auto-save persists
     * the new size. Display Mode sizes only the companion, so primary docs are
     * intentionally skipped — toggling the setting must never reflow a primary.
     * Walks all docs (not just the focused one) because the companion is
     * usually rendered in an unfocused pane when the user changes the setting.
     */
    refreshCompanionSizes() {
      set((state) => {
        for (const [docId, entry] of Object.entries(state.docs)) {
          if (!isFullscreenId(docId)) continue;
          normalizeDoc(entry.doc, screenSizeForDocId(docId));
          entry.dirty = true;
        }
      });
    },

    /**
     * Re-derive the size of EVERY open PRIMARY widget from the current widget
     * size mode and mark each touched doc dirty so auto-save persists it. The
     * companion is intentionally skipped — the two sizes are independent, so
     * changing the widget size must never reflow the fullscreen companion.
     */
    refreshPrimarySizes() {
      set((state) => {
        for (const [docId, entry] of Object.entries(state.docs)) {
          if (isFullscreenId(docId)) continue;
          normalizeDoc(entry.doc, screenSizeForDocId(docId));
          entry.dirty = true;
        }
      });
    },

    commit() {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        recordHistory(entry);
        entry.dirty = true;
      });
    },

    undo() {
      set((state) => {
        // Focused-entry-scoped: each screen undoes its OWN history. Source edits
        // are recorded on the primary entry, so a source change made from the
        // fullscreen screen is undone from the PRIMARY screen (one consistent
        // timeline per entry — no cross-stack ordering hazards).
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const previous = entry.history.past.pop();
        if (!previous) return;

        entry.history.future.unshift(cloneDoc(entry.doc));
        entry.doc = previous;
        entry.dirty = true;
      });
    },

    redo() {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const next = entry.history.future.shift();
        if (!next) return;

        entry.history.past.push(cloneDoc(entry.doc));
        entry.doc = next;
        entry.dirty = true;
      });
    },

    updateMisc(patch) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        recordHistory(entry);
        applyDeepishPatch(entry.doc.misc, patch);
        // Only re-derive the pixel size when the GRID actually changed. A plain
        // metadata edit (name/type/subcategory/tags) must NOT reflow the canvas:
        // re-running normalizeDoc would recompute misc.size from the GLOBAL
        // widgetMode and silently clobber any per-widget size that intentionally
        // differs from it — e.g. a self-host full-screen widget pinned to 800×480
        // (via setFocusedFullScreen) while widgetMode is 'panel' (720×480). A
        // gridSize edit still normalizes (the grid is what size derives from).
        if ('gridSize' in patch) {
          normalizeDoc(entry.doc, screenSizeForDocId(state.focusedDocId));
        } else {
          entry.doc.misc.gridSize = normalizeGridSize(entry.doc.misc.gridSize);
          if (!Array.isArray(entry.doc.misc.tags)) entry.doc.misc.tags = [];
        }
        entry.dirty = true;
      });
    },

    addElement(type, overrides) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        recordHistory(entry);
        const nextName = createNameGeneratorFromElements(entry.doc.elements);
        const name = nextName(type);
        entry.doc.elements.push(createElement(type, { name, ...overrides }));
        entry.dirty = true;
      });
    },

    /**
     * Paste element templates into the focused document.
     * Each template is a deep-cloned element object. New IDs and unique names
     * are assigned. Positions are offset to avoid overlap with originals.
     */
    pasteElements(templates, offset = { x: 10, y: 10 }) {
      const ids = [];
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        if (!Array.isArray(templates) || templates.length === 0) return;
        recordHistory(entry);
        const nextName = createNameGeneratorFromElements(entry.doc.elements);
        for (const tpl of templates) {
          const newId = createId();
          const name = nextName(tpl.type ?? 'rect');
          const el = { ...tpl, id: newId, name };
          if (el.pos) {
            el.pos = { x: (el.pos.x ?? 0) + offset.x, y: (el.pos.y ?? 0) + offset.y };
          }
          entry.doc.elements.push(el);
          ids.push(newId);
        }
        entry.dirty = true;
      });
      return ids;
    },

    updateElement(id, patch) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const element = entry.doc.elements.find((e) => e?.id === id);
        if (!element) return;
        recordHistory(entry);
        applyDeepishPatch(element, patch);
        entry.dirty = true;
      });
    },

    /**
     * Apply a render-derived patch (e.g. measured text bounds) without
     * recording history or marking the document dirty. The patch is
     * limited to a small allowlist of fields that the renderer owns; any
     * other key is dropped with a dev-time warning so this mutation
     * cannot become a back-door for arbitrary writes.
     *
     * Allowlist (per Task 7; narrowed by the text-frame work):
     *   - auto-flow text elements: `sizeX`, `sizeY`
     *   - framed (fixed/clip) text elements: nothing — both sizes are
     *     authored, so the renderer owns no field on them; the display box
     *     is computed where the element renders and never stored
     *
     * Auto-driven hooks (e.g. `useAutoSizeText`) MUST use this mutation.
     * Treating measured bounds as authored content corrupts undo and
     * triggers spurious auto-saves on data-bound text.
     */
    updateElementDerived(id, patch) {
      if (!patch || typeof patch !== 'object') return;
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const element = entry.doc.elements.find((e) => e?.id === id);
        if (!element) return;

        const allowed = element.type === 'text' && !isFramedTextFlow(element.textFlow)
          ? new Set(['sizeX', 'sizeY'])
          : new Set();

        const filtered = {};
        let dropped = false;
        for (const [key, value] of Object.entries(patch)) {
          if (allowed.has(key)) {
            filtered[key] = value;
          } else {
            dropped = true;
          }
        }
        if (dropped && typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(
            'updateElementDerived: dropped non-allowlisted keys for element',
            id,
            'type',
            element.type,
            'patch',
            patch,
          );
        }
        if (Object.keys(filtered).length === 0) return;

        applyDeepishPatch(element, filtered);
        // No recordHistory — derived values must not push undo entries.
        // No `entry.dirty = true` — derived values must not trigger auto-save.
      });
    },

    removeElement(id) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        if (!entry.doc.elements.some((e) => e?.id === id)) return;
        recordHistory(entry);
        entry.doc.elements = entry.doc.elements.filter((e) => e?.id !== id);
        entry.dirty = true;
      });
    },

    /**
     * Remove multiple elements in a single mutation so a multi-select
     * delete gesture produces ONE undo entry instead of N (Task 8).
     * No-op if `ids` is empty or no requested IDs exist in the focused
     * document.
     */
    removeElements(ids) {
      if (!Array.isArray(ids) || ids.length === 0) return;
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const idSet = new Set(ids);
        const willRemove = entry.doc.elements.some((e) => e?.id && idSet.has(e.id));
        if (!willRemove) return;
        recordHistory(entry);
        entry.doc.elements = entry.doc.elements.filter((e) => !(e?.id && idSet.has(e.id)));
        entry.dirty = true;
      });
    },

    /**
     * Apply position-only patches to multiple elements in a single
     * mutation so a multi-select drag commit produces ONE undo entry
     * instead of N (Task 8). Each update must be `{ id, pos: { x, y } }`;
     * other keys are ignored. No-op if no update targets an existing
     * element with a real position change.
     */
    updateElementsPositions(updates) {
      if (!Array.isArray(updates) || updates.length === 0) return;
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;

        // Pre-compute which updates actually change something so we can
        // skip the recordHistory + dirty flip on a no-op call.
        const elementsById = new Map();
        for (const el of entry.doc.elements) {
          if (el?.id) elementsById.set(el.id, el);
        }

        const effective = [];
        for (const u of updates) {
          if (!u || typeof u !== 'object') continue;
          const el = elementsById.get(u.id);
          if (!el) continue;
          const pos = u.pos;
          if (!pos || typeof pos !== 'object') continue;
          const nx = Number(pos.x);
          const ny = Number(pos.y);
          if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
          const cx = el.pos?.x ?? 0;
          const cy = el.pos?.y ?? 0;
          if (nx === cx && ny === cy) continue;
          effective.push({ el, x: nx, y: ny });
        }
        if (effective.length === 0) return;

        recordHistory(entry);
        for (const { el, x, y } of effective) {
          el.pos = { x, y };
        }
        entry.dirty = true;
      });
    },

    reorderElements(fromIndex, toIndex) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        recordHistory(entry);
        const elements = entry.doc.elements;
        if (fromIndex < 0 || fromIndex >= elements.length) return;
        if (toIndex < 0 || toIndex >= elements.length) return;

        const [moved] = elements.splice(fromIndex, 1);
        elements.splice(toIndex, 0, moved);
        entry.dirty = true;
      });
    },

    addFeature(def) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        recordHistory(entry);
        if (!entry.doc.features) entry.doc.features = { definitions: {}, values: {} };
        if (!entry.doc.features.definitions) entry.doc.features.definitions = {};

        // Ensure unique key
        let key = def.key || 'feature';
        let counter = 1;
        while (entry.doc.features.definitions[key]) {
          key = `${def.key || 'feature'}_${counter++}`;
        }

        entry.doc.features.definitions[key] = { ...def, key };
        // Set default value
        if (!entry.doc.features.values) entry.doc.features.values = {};
        entry.doc.features.values[key] = def.default ?? null;
        entry.dirty = true;
      });
    },

    updateFeature(key, patch) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        const defs = entry.doc.features?.definitions;
        if (!defs || !defs[key]) return;

        recordHistory(entry);

        // If renaming
        if (patch.key && patch.key !== key) {
          const newKey = patch.key;
          if (defs[newKey]) return; // Collision check

          const oldDef = defs[key];
          const newDef = { ...oldDef, ...patch };

          delete defs[key];
          defs[newKey] = newDef;

          // Move value
          const val = entry.doc.features.values?.[key];
          if (entry.doc.features.values) {
            delete entry.doc.features.values[key];
            entry.doc.features.values[newKey] = val;
          }
        } else {
          applyDeepishPatch(defs[key], patch);
        }
        entry.dirty = true;
      });
    },

    removeFeature(key) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        if (!entry.doc.features?.definitions?.[key]) return;
        recordHistory(entry);
        delete entry.doc.features.definitions[key];
        if (entry.doc.features.values) {
          delete entry.doc.features.values[key];
        }
        entry.dirty = true;
      });
    },

    setFeatureValue(key, value) {
      set((state) => {
        const entry = getFocusedEntry(state);
        if (!entry) return;
        // DESIGN: Feature values are preview-time overrides used during editing
        // (e.g. typing into a feature input to see the result live). They are
        // intentionally excluded from undo history to avoid spamming the undo
        // stack on every keystroke. They DO persist with the document on save.
        if (!entry.doc.features) entry.doc.features = { definitions: {}, values: {} };
        if (!entry.doc.features.values) entry.doc.features.values = {};
        entry.doc.features.values[key] = value;
        entry.dirty = true;
      });
    },

    // Source CRUD targets the PRIMARY entry (the shared pool's home) via
    // getPrimaryEntryFor, NOT the focused entry — so add/edit/delete from EITHER
    // the primary or the fullscreen screen mutates the one shared pool. History
    // and dirty are recorded on the primary; the companion is also dirtied so
    // auto-save re-exports the fullscreen payload.

    addSource(source) {
      set((state) => {
        const entry = getPrimaryEntryFor(state);
        if (!entry) return;
        if (entry.doc.sources.length >= MAX_SOURCES) {
          // Refuse rather than build a pool the export schema rejects.
          // Surfaced via console so it is not a silent no-op.
          console.warn(`[docStore] Source pool is at the ${MAX_SOURCES}-source limit; not adding.`);
          return;
        }
        recordHistory(entry);
        const next = source && typeof source === 'object' ? { ...source } : {};
        if (!next.id) next.id = createId();
        entry.doc.sources.push(next);
        entry.dirty = true;
        markCompanionDirty(state);
      });
    },

    updateSource(id, patch) {
      set((state) => {
        const entry = getPrimaryEntryFor(state);
        if (!entry) return;
        const source = entry.doc.sources.find((s) => s?.id === id);
        if (!source) return;
        recordHistory(entry);
        // Direct assignment (not applyDeepishPatch) so that object-valued
        // properties like query, headers, auth are fully REPLACED rather
        // than merged. KeyValueEditor passes the entire new object on every
        // change, so merge semantics would silently preserve deleted keys.
        for (const [k, v] of Object.entries(patch)) {
          source[k] = v;
        }
        entry.dirty = true;
        markCompanionDirty(state);
      });
    },

    removeSource(id) {
      set((state) => {
        const entry = getPrimaryEntryFor(state);
        if (!entry) return;
        const idx = entry.doc.sources.findIndex((s) => s?.id === id);
        if (idx === -1) return;
        recordHistory(entry);
        entry.doc.sources.splice(idx, 1);
        entry.dirty = true;
        markCompanionDirty(state);
      });
    },
  })),
);

// ── Imperative accessors (for getState() call sites in platform/) ────

/** Returns the focused doc object. Use in platform/ code that can't use hooks. */
export function getFocusedDoc() {
  const state = useDocStore.getState();
  return state.focusedDocId ? state.docs[state.focusedDocId]?.doc ?? EMPTY_DOC : EMPTY_DOC;
}

/** Returns the doc object for a specific widget ID. */
export function getDocById(widgetId) {
  return useDocStore.getState().docs[widgetId]?.doc ?? null;
}

/**
 * Returns the primary widget's sources to be INHERITED by the given doc, or
 * `undefined` when `docId` is not a fullscreen companion. Pass the result as
 * `exportRuntimeJson(companionDoc, { slot: 'fullscreen', primarySources })` so
 * a companion render/deploy inherits its primary's sources (see
 * `mergeInheritedSources`). Returns `undefined` for primary docs so the same
 * call site works for both slots without branching.
 */
export function getInheritedPrimarySources(docId) {
  if (!isFullscreenId(docId)) return undefined;
  return useDocStore.getState().docs[primaryIdOf(docId)]?.doc?.sources;
}
