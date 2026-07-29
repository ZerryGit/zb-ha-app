/**
 * docStore.test.js — Unit tests for the normalized multi-doc store (B2).
 *
 * Tests cover: selector helpers, lifecycle actions, mutation scoping,
 * dirty tracking, undo/redo, and edge cases (null focus, unknown IDs).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock dependencies before importing docStore ──────────────────────

// displayConfigStore — getDisplayConfig returns an object with helpers.
vi.mock('../displayConfigStore.js', () => {
  const confirmGridSize = vi.fn();
  const resetGridSizeConfirmation = vi.fn();
  const getScreenSize = vi.fn(() => ({ width: 800, height: 480 }));

  return {
    getDisplayConfig: () => ({
      getScreenSize,
      confirmGridSize,
      resetGridSizeConfirmation,
    }),
    // Expose mocks for assertions
    __mocks: { confirmGridSize, resetGridSizeConfirmation, getScreenSize },
  };
});

// ids — deterministic IDs for tests
let _idCounter = 0;
vi.mock('../../utils/ids.js', () => ({
  createId: () => `test-id-${++_idCounter}`,
}));

import {
  useDocStore,
  selectFocusedDoc,
  selectFocusedHistory,
  selectFocusedElements,
  selectFocusedMisc,
  selectFocusedSources,
  selectSharedSources,
  selectFocusedFeatures,
  selectFocusedPrimaryDoc,
  selectFocusedCompanionDoc,
  selectFocusedDocId,
  selectOpenDocIds,
  selectHasUnsavedChanges,
  selectCompanionDocId,
  selectCompanionElements,
  getFocusedDoc,
  getDocById,
  PENDING_DOC_ID,
  MAX_SOURCES,
  SOURCE_WARN_THRESHOLD,
} from '../docStore.js';

import { getDisplayConfig } from '../displayConfigStore.js';
import { fullscreenIdFor } from '../companionId.js';

// ── Helpers ──────────────────────────────────────────────────────────

/** Reset the store to a clean slate between tests. */
function resetStore() {
  // Only reset data — preserve action functions in the store.
  useDocStore.setState({ focusedDocId: null, docs: {} });
  _idCounter = 0;
}

/** Get raw store state. */
const state = () => useDocStore.getState();

/** Shortcut: open a widget with minimal valid JSON. */
function openWidget(id, overrides = {}) {
  const json = {
    misc: { gridSize: '1x1', ...overrides.misc },
    elements: overrides.elements ?? [],
    sources: overrides.sources ?? [],
    features: overrides.features ?? {},
  };
  state().openDoc(id, json);
}

// ── Tests ────────────────────────────────────────────────────────────

describe('docStore', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  // ── PENDING_DOC_ID constant ──────────────────────────────────────

  describe('PENDING_DOC_ID', () => {
    it('is the string __pending', () => {
      expect(PENDING_DOC_ID).toBe('__pending');
    });
  });

  // ── Selector helpers ─────────────────────────────────────────────

  describe('selectors', () => {
    it('selectFocusedDoc returns EMPTY_DOC when nothing focused', () => {
      const doc = selectFocusedDoc(state());
      expect(doc).toEqual({ misc: {}, elements: [], sources: [], features: {} });
      expect(Object.isFrozen(doc)).toBe(true);
    });

    it('selectFocusedDoc returns stable reference when unfocused', () => {
      const a = selectFocusedDoc(state());
      const b = selectFocusedDoc(state());
      expect(a).toBe(b); // same frozen singleton
    });

    it('selectFocusedHistory returns EMPTY_HISTORY when nothing focused', () => {
      const h = selectFocusedHistory(state());
      expect(h).toEqual({ past: [], future: [] });
      expect(Object.isFrozen(h)).toBe(true);
    });

    it('selectFocusedElements returns empty array when unfocused', () => {
      expect(selectFocusedElements(state())).toEqual([]);
    });

    it('returns correct data after openDoc + switchFocus', () => {
      openWidget('w1', { elements: [{ id: 'e1', type: 'rect' }] });
      state().switchFocus('w1');

      expect(selectFocusedDoc(state()).elements).toHaveLength(1);
      expect(selectFocusedElements(state())[0].id).toBe('e1');
      expect(selectFocusedMisc(state()).gridSize).toBe('1x1');
      expect(selectFocusedSources(state())).toEqual([]);
      expect(selectFocusedFeatures(state())).toEqual({ definitions: {}, values: {} });
      expect(selectFocusedDocId(state())).toBe('w1');
    });

    it('selectFocusedPrimaryDoc returns the primary doc when a companion is focused', () => {
      const cid = fullscreenIdFor('w1');
      openWidget('w1', { elements: [{ id: 'primary-el', type: 'rect' }] });
      openWidget(cid, { misc: { gridSize: '3x2' }, elements: [{ id: 'companion-el', type: 'text' }] });
      state().switchFocus(cid);

      expect(selectFocusedPrimaryDoc(state()).elements[0].id).toBe('primary-el');
    });

    it('selectFocusedCompanionDoc returns the paired companion for primary or companion focus', () => {
      const cid = fullscreenIdFor('w1');
      openWidget('w1');
      openWidget(cid, { misc: { gridSize: '3x2' }, elements: [{ id: 'companion-el', type: 'text' }] });

      state().switchFocus('w1');
      expect(selectFocusedCompanionDoc(state()).elements[0].id).toBe('companion-el');

      state().switchFocus(cid);
      expect(selectFocusedCompanionDoc(state()).elements[0].id).toBe('companion-el');
    });

    it('selectOpenDocIds returns all open IDs', () => {
      openWidget('w1');
      openWidget('w2');
      expect(selectOpenDocIds(state()).sort()).toEqual(['w1', 'w2']);
    });

    it('selectHasUnsavedChanges returns false when all clean', () => {
      openWidget('w1');
      expect(selectHasUnsavedChanges(state())).toBe(false);
    });

    it('selectHasUnsavedChanges returns true after mutation', () => {
      openWidget('w1');
      state().switchFocus('w1');
      state().addElement('rect');
      expect(selectHasUnsavedChanges(state())).toBe(true);
    });
  });

  // ── Imperative accessors ─────────────────────────────────────────

  describe('imperative accessors', () => {
    it('getFocusedDoc returns EMPTY_DOC when unfocused', () => {
      const doc = getFocusedDoc();
      expect(Object.isFrozen(doc)).toBe(true);
    });

    it('getFocusedDoc returns focused doc after switchFocus', () => {
      openWidget('w1', { elements: [{ id: 'e1', type: 'text' }] });
      state().switchFocus('w1');
      const doc = getFocusedDoc();
      expect(doc.elements).toHaveLength(1);
    });

    it('getDocById returns doc for known ID', () => {
      openWidget('w1');
      expect(getDocById('w1')).not.toBeNull();
    });

    it('getDocById returns null for unknown ID', () => {
      expect(getDocById('nonexistent')).toBeNull();
    });
  });

  // ── Lifecycle actions ────────────────────────────────────────────

  describe('lifecycle: newDoc', () => {
    it('creates entry without changing focus', () => {
      state().newDoc('w1');
      expect(state().docs['w1']).toBeDefined();
      expect(state().focusedDocId).toBeNull(); // no auto-focus
    });

    it('creates doc with valid structure', () => {
      state().newDoc('w1');
      const doc = state().docs['w1'].doc;
      expect(doc.misc).toBeDefined();
      expect(doc.elements).toEqual([]);
      expect(doc.sources).toEqual([]);
    });

    it('calls resetGridSizeConfirmation', () => {
      const { resetGridSizeConfirmation } = getDisplayConfig();
      state().newDoc('w1');
      expect(resetGridSizeConfirmation).toHaveBeenCalled();
    });
  });

  describe('lifecycle: openDoc', () => {
    it('creates entry from JSON without changing focus', () => {
      openWidget('w1');
      expect(state().docs['w1']).toBeDefined();
      expect(state().focusedDocId).toBeNull();
    });

    it('creates entry with dirty: false and empty history', () => {
      openWidget('w1');
      const entry = state().docs['w1'];
      expect(entry.dirty).toBe(false);
      expect(entry.lastSavedHash).toBeNull();
      expect(entry.history).toEqual({ past: [], future: [] });
    });

    it('replaces existing entry on re-open', () => {
      openWidget('w1', { elements: [{ id: 'e1', type: 'rect' }] });
      state().switchFocus('w1');
      state().addElement('text'); // dirty + history

      // Re-open same widget
      openWidget('w1', { elements: [{ id: 'e2', type: 'line' }] });
      const entry = state().docs['w1'];
      expect(entry.dirty).toBe(false);
      expect(entry.history.past).toHaveLength(0);
      expect(entry.doc.elements).toHaveLength(1);
      expect(entry.doc.elements[0].id).toBe('e2');
    });

    it('calls confirmGridSize', () => {
      const { confirmGridSize } = getDisplayConfig();
      openWidget('w1');
      expect(confirmGridSize).toHaveBeenCalled();
    });
  });

  describe('lifecycle: closeDoc', () => {
    it('removes entry from docs map', () => {
      openWidget('w1');
      state().closeDoc('w1');
      expect(state().docs['w1']).toBeUndefined();
    });

    it('closeWidgetDocs removes primary and companion atomically', () => {
      openWidget('w1');
      openWidget(fullscreenIdFor('w1'), { misc: { gridSize: '3x2' } });
      openWidget('w2');
      state().switchFocus(fullscreenIdFor('w1'));

      state().closeWidgetDocs('w1');

      expect(state().docs['w1']).toBeUndefined();
      expect(state().docs[fullscreenIdFor('w1')]).toBeUndefined();
      expect(state().focusedDocId).toBe('w2');
    });

    it('shifts focus to another doc if closed doc was focused', () => {
      openWidget('w1');
      openWidget('w2');
      state().switchFocus('w1');
      state().closeDoc('w1');

      expect(state().focusedDocId).toBe('w2');
    });

    it('sets focus to null if last doc is closed', () => {
      openWidget('w1');
      state().switchFocus('w1');
      state().closeDoc('w1');

      expect(state().focusedDocId).toBeNull();
    });

    it('does not affect focus when closing a non-focused doc', () => {
      openWidget('w1');
      openWidget('w2');
      state().switchFocus('w1');
      state().closeDoc('w2');

      expect(state().focusedDocId).toBe('w1');
    });

    it('cleans up PENDING_DOC_ID entry', () => {
      state().newDoc(PENDING_DOC_ID);
      state().switchFocus(PENDING_DOC_ID);
      state().closeDoc(PENDING_DOC_ID);

      expect(state().docs[PENDING_DOC_ID]).toBeUndefined();
    });
  });

  describe('lifecycle: switchFocus', () => {
    it('sets focusedDocId for known widget', () => {
      openWidget('w1');
      state().switchFocus('w1');
      expect(state().focusedDocId).toBe('w1');
    });

    it('no-ops for unknown widget ID', () => {
      openWidget('w1');
      state().switchFocus('w1');
      state().switchFocus('unknown');
      expect(state().focusedDocId).toBe('w1');
    });
  });

  describe('lifecycle: markClean', () => {
    it('resets dirty flag and stores hash', () => {
      openWidget('w1');
      state().switchFocus('w1');
      state().addElement('rect'); // dirty = true
      expect(state().docs['w1'].dirty).toBe(true);

      state().markClean('w1', 'hash-abc');
      expect(state().docs['w1'].dirty).toBe(false);
      expect(state().docs['w1'].lastSavedHash).toBe('hash-abc');
    });

    it('no-ops for unknown widget ID', () => {
      state().markClean('nonexistent', 'hash');
      // Should not throw
    });
  });

  describe('lifecycle: replaceDocFromJson', () => {
    it('replaces focused doc content and marks dirty', () => {
      openWidget('w1');
      state().switchFocus('w1');

      state().replaceDocFromJson({
        misc: { gridSize: '2x2' },
        elements: [{ id: 'new-e1', type: 'rect' }],
        sources: [],
        features: {},
      });

      const entry = state().docs['w1'];
      expect(entry.dirty).toBe(true);
      expect(entry.history.past).toHaveLength(0); // history reset
      expect(entry.doc.elements).toHaveLength(1);
    });

    it('no-ops when nothing is focused', () => {
      state().replaceDocFromJson({ misc: {}, elements: [], sources: [], features: {} });
      // Should not throw; no docs exist
    });
  });

  // ── Mutation actions ─────────────────────────────────────────────

  describe('mutations', () => {
    beforeEach(() => {
      openWidget('w1', {
        elements: [
          { id: 'e1', type: 'rect', name: 'Rect 1' },
          { id: 'e2', type: 'text', name: 'Text 1' },
        ],
      });
      state().switchFocus('w1');
    });

    it('addElement adds to elements and sets dirty', () => {
      state().addElement('rect');
      const { doc, dirty } = state().docs['w1'];
      expect(doc.elements).toHaveLength(3);
      expect(dirty).toBe(true);
    });

    it('updateElement patches element and sets dirty', () => {
      state().updateElement('e1', { fill: '#ff0000' });
      const el = state().docs['w1'].doc.elements.find((e) => e.id === 'e1');
      expect(el.fill).toBe('#ff0000');
      expect(state().docs['w1'].dirty).toBe(true);
    });

    it('updateElement no-ops for unknown element', () => {
      state().updateElement('unknown', { fill: '#ff0000' });
      // No error, dirty not set
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('removeElement removes and sets dirty', () => {
      state().removeElement('e1');
      expect(state().docs['w1'].doc.elements).toHaveLength(1);
      expect(state().docs['w1'].dirty).toBe(true);
    });

    it('removeElement no-ops for unknown element', () => {
      state().removeElement('unknown');
      expect(state().docs['w1'].doc.elements).toHaveLength(2);
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('updateElementDerived patches text bounds without history or dirty', () => {
      const before = state().docs['w1'].history.past.length;
      state().updateElementDerived('e2', { sizeX: 64, sizeY: 18 });
      const el = state().docs['w1'].doc.elements.find((e) => e.id === 'e2');
      expect(el.sizeX).toBe(64);
      expect(el.sizeY).toBe(18);
      expect(state().docs['w1'].history.past.length).toBe(before);
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('updateElementDerived drops non-allowlisted keys (no back-door writes)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      state().updateElementDerived('e2', { sizeX: 50, fill: '#ff0000' });
      const el = state().docs['w1'].doc.elements.find((e) => e.id === 'e2');
      expect(el.sizeX).toBe(50);
      expect(el.fill).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('updateElementDerived rejects all keys for non-text elements', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      state().updateElementDerived('e1', { sizeX: 50 }); // e1 is a rect
      const el = state().docs['w1'].doc.elements.find((e) => e.id === 'e1');
      expect(el.sizeX).toBeUndefined();
      expect(state().docs['w1'].dirty).toBe(false);
      warn.mockRestore();
    });

    it('updateElementDerived no-ops for unknown element', () => {
      state().updateElementDerived('unknown', { sizeX: 10 });
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('removeElements removes many in a single undo entry', () => {
      const before = state().docs['w1'].history.past.length;
      state().removeElements(['e1', 'e2']);
      expect(state().docs['w1'].doc.elements).toHaveLength(0);
      expect(state().docs['w1'].dirty).toBe(true);
      expect(state().docs['w1'].history.past.length).toBe(before + 1);

      // Undo restores both
      state().undo();
      expect(state().docs['w1'].doc.elements).toHaveLength(2);
    });

    it('removeElements no-ops for empty/unknown ids', () => {
      state().removeElements([]);
      expect(state().docs['w1'].dirty).toBe(false);
      state().removeElements(['nope']);
      expect(state().docs['w1'].dirty).toBe(false);
      expect(state().docs['w1'].doc.elements).toHaveLength(2);
    });

    it('updateElementsPositions moves many in a single undo entry', () => {
      const before = state().docs['w1'].history.past.length;
      state().updateElementsPositions([
        { id: 'e1', pos: { x: 10, y: 20 } },
        { id: 'e2', pos: { x: 30, y: 40 } },
      ]);
      const els = state().docs['w1'].doc.elements;
      expect(els.find((e) => e.id === 'e1').pos).toEqual({ x: 10, y: 20 });
      expect(els.find((e) => e.id === 'e2').pos).toEqual({ x: 30, y: 40 });
      expect(state().docs['w1'].history.past.length).toBe(before + 1);
      expect(state().docs['w1'].dirty).toBe(true);

      state().undo();
      const after = state().docs['w1'].doc.elements;
      expect(after.find((e) => e.id === 'e1').pos).toBeUndefined();
      expect(after.find((e) => e.id === 'e2').pos).toBeUndefined();
    });

    it('updateElementsPositions no-ops when no change', () => {
      state().updateElementsPositions([]);
      expect(state().docs['w1'].dirty).toBe(false);
      state().updateElementsPositions([{ id: 'nope', pos: { x: 1, y: 1 } }]);
      expect(state().docs['w1'].dirty).toBe(false);
      // Set position then call again with same coords — should still be a no-op
      state().updateElementsPositions([{ id: 'e1', pos: { x: 5, y: 5 } }]);
      const beforePast = state().docs['w1'].history.past.length;
      state().updateElementsPositions([{ id: 'e1', pos: { x: 5, y: 5 } }]);
      expect(state().docs['w1'].history.past.length).toBe(beforePast);
    });

    it('reorderElements moves element and sets dirty', () => {
      state().reorderElements(0, 1);
      const els = state().docs['w1'].doc.elements;
      expect(els[0].id).toBe('e2');
      expect(els[1].id).toBe('e1');
      expect(state().docs['w1'].dirty).toBe(true);
    });

    it('refreshSize does NOT set dirty', () => {
      state().refreshSize();
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('updateMisc patches misc and sets dirty', () => {
      state().updateMisc({ name: 'My Widget' });
      expect(state().docs['w1'].doc.misc.name).toBe('My Widget');
      expect(state().docs['w1'].dirty).toBe(true);
    });

    it('mutations no-op when focusedDocId is null', () => {
      state().switchFocus('w1'); // focus something
      useDocStore.setState({ focusedDocId: null }); // manually clear
      state().addElement('rect'); // should not throw
      expect(state().docs['w1'].doc.elements).toHaveLength(2); // unchanged
    });
  });

  // ── Undo / Redo ──────────────────────────────────────────────────

  describe('undo / redo', () => {
    beforeEach(() => {
      openWidget('w1', { elements: [] });
      state().switchFocus('w1');
    });

    it('undo restores previous state', () => {
      state().addElement('rect'); // records history snapshot (empty)
      expect(state().docs['w1'].doc.elements).toHaveLength(1);

      state().undo();
      expect(state().docs['w1'].doc.elements).toHaveLength(0);
    });

    it('redo re-applies undone state', () => {
      state().addElement('rect');
      state().undo();
      expect(state().docs['w1'].doc.elements).toHaveLength(0);

      state().redo();
      expect(state().docs['w1'].doc.elements).toHaveLength(1);
    });

    it('undo no-ops when history is empty', () => {
      state().undo(); // no crash, no state change
      expect(state().docs['w1'].doc.elements).toHaveLength(0);
    });

    it('redo no-ops when future is empty', () => {
      state().redo();
      expect(state().docs['w1'].doc.elements).toHaveLength(0);
    });

    it('new edit clears redo future', () => {
      state().addElement('rect');
      state().undo();
      state().addElement('text'); // should clear future
      expect(state().docs['w1'].history.future).toHaveLength(0);
    });

    it('undo/redo sets dirty', () => {
      state().addElement('rect');
      state().markClean('w1', 'h1');
      expect(state().docs['w1'].dirty).toBe(false);

      state().undo();
      expect(state().docs['w1'].dirty).toBe(true);
    });
  });

  // ── Multi-doc isolation ──────────────────────────────────────────

  describe('multi-doc isolation', () => {
    it('mutations only affect focused doc', () => {
      openWidget('w1', { elements: [] });
      openWidget('w2', { elements: [] });
      state().switchFocus('w1');

      state().addElement('rect');
      expect(state().docs['w1'].doc.elements).toHaveLength(1);
      expect(state().docs['w2'].doc.elements).toHaveLength(0);
      expect(state().docs['w1'].dirty).toBe(true);
      expect(state().docs['w2'].dirty).toBe(false);
    });

    it('switching focus changes which doc receives mutations', () => {
      openWidget('w1', { elements: [] });
      openWidget('w2', { elements: [] });

      state().switchFocus('w1');
      state().addElement('rect');

      state().switchFocus('w2');
      state().addElement('text');
      state().addElement('line');

      expect(state().docs['w1'].doc.elements).toHaveLength(1);
      expect(state().docs['w2'].doc.elements).toHaveLength(2);
    });

    it('undo history is per-widget', () => {
      openWidget('w1', { elements: [] });
      openWidget('w2', { elements: [] });

      state().switchFocus('w1');
      state().addElement('rect');

      state().switchFocus('w2');
      state().addElement('text');

      // Undo on w2 should not affect w1
      state().undo();
      expect(state().docs['w2'].doc.elements).toHaveLength(0);
      expect(state().docs['w1'].doc.elements).toHaveLength(1);
    });
  });

  describe('companion selectors', () => {
    beforeEach(resetStore);

    it('selectCompanionDocId returns null when nothing is focused', () => {
      expect(selectCompanionDocId(state())).toBeNull();
    });

    it('selectCompanionDocId returns null when no companion entry exists', () => {
      openWidget('w1');
      state().switchFocus('w1');
      expect(selectCompanionDocId(state())).toBeNull();
    });

    it('selectCompanionDocId returns the derived id when companion entry exists', () => {
      openWidget('w1');
      const cid = fullscreenIdFor('w1');
      openWidget(cid, { misc: { gridSize: '3x2' } });
      state().switchFocus('w1');
      expect(selectCompanionDocId(state())).toBe(cid);
    });

    it('selectCompanionDocId returns null when the focused doc is itself a companion', () => {
      const cid = fullscreenIdFor('w1');
      openWidget(cid, { misc: { gridSize: '3x2' } });
      state().switchFocus(cid);
      expect(selectCompanionDocId(state())).toBeNull();
    });

    it('selectCompanionElements returns the companion elements when present', () => {
      openWidget('w1');
      const cid = fullscreenIdFor('w1');
      openWidget(cid, { misc: { gridSize: '3x2' } });
      state().switchFocus(cid);
      state().addElement('rect');
      state().switchFocus('w1');

      const els = selectCompanionElements(state());
      expect(els).toHaveLength(1);
      expect(els[0].type).toBe('rect');
    });

    it('selectCompanionElements returns a stable empty array when no companion exists', () => {
      openWidget('w1');
      state().switchFocus('w1');
      const a = selectCompanionElements(state());
      const b = selectCompanionElements(state());
      expect(a).toEqual([]);
      // Stable reference avoids spurious re-renders in subscribed components.
      expect(a).toBe(b);
    });
  });

  // ── Shared source pool (primary + fullscreen companion) ──────────
  // Sources are ONE pool anchored on the primary entry; both the primary and
  // its fullscreen companion read and write it.
  describe('shared source pool', () => {
    const CID = fullscreenIdFor('w1');

    function openPair(primarySources = []) {
      openWidget('w1', { sources: primarySources });
      openWidget(CID, { misc: { gridSize: '3x2' } });
    }

    it('selectSharedSources returns the primary pool whether primary or companion is focused', () => {
      openPair([{ id: 'temp', kind: 'haState' }]);
      state().switchFocus('w1');
      const fromPrimary = selectSharedSources(state()).map((s) => s.id);
      state().switchFocus(CID);
      const fromCompanion = selectSharedSources(state()).map((s) => s.id);
      expect(fromPrimary).toEqual(['temp']);
      expect(fromCompanion).toEqual(['temp']);
    });

    it('selectFocusedSources delegates to the shared pool on the companion', () => {
      openPair([{ id: 'temp', kind: 'haState' }]);
      state().switchFocus(CID);
      expect(selectFocusedSources(state()).map((s) => s.id)).toEqual(['temp']);
    });

    it('addSource from the companion lands on the primary pool, not the companion', () => {
      openPair();
      state().switchFocus(CID);
      state().addSource({ id: 'added', kind: 'http' });
      expect(getDocById('w1').sources.map((s) => s.id)).toEqual(['added']);
      expect(getDocById(CID).sources).toEqual([]);
      state().switchFocus('w1');
      expect(selectSharedSources(state()).map((s) => s.id)).toEqual(['added']);
    });

    it('addSource keeps going past the warn threshold and stops at MAX_SOURCES', () => {
      expect(SOURCE_WARN_THRESHOLD).toBeLessThan(MAX_SOURCES);
      openWidget('w1');
      state().switchFocus('w1');

      // The threshold is advisory (the warning lives in SourcesPanel) — the
      // store itself must not refuse an add until the hard cap.
      for (let i = 0; i < SOURCE_WARN_THRESHOLD + 1; i++) {
        state().addSource({ id: `s${i}`, kind: 'http' });
      }
      expect(getDocById('w1').sources).toHaveLength(SOURCE_WARN_THRESHOLD + 1);

      for (let i = SOURCE_WARN_THRESHOLD + 1; i < MAX_SOURCES; i++) {
        state().addSource({ id: `s${i}`, kind: 'http' });
      }
      expect(getDocById('w1').sources).toHaveLength(MAX_SOURCES);

      // At the cap the add is refused, not silently truncated elsewhere.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      state().addSource({ id: 'over-cap', kind: 'http' });
      expect(getDocById('w1').sources).toHaveLength(MAX_SOURCES);
      expect(getDocById('w1').sources.some((s) => s.id === 'over-cap')).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('updateSource from the companion edits the shared pool', () => {
      openPair([{ id: 'temp', kind: 'haState', entity_id: 'sensor.a' }]);
      state().switchFocus(CID);
      state().updateSource('temp', { entity_id: 'sensor.b' });
      expect(getDocById('w1').sources[0].entity_id).toBe('sensor.b');
    });

    it('removeSource from the companion removes from the shared pool', () => {
      openPair([{ id: 'temp', kind: 'haState' }]);
      state().switchFocus(CID);
      state().removeSource('temp');
      expect(getDocById('w1').sources).toEqual([]);
    });

    it('a source mutation dirties both the primary and the companion entry', () => {
      openPair();
      state().switchFocus(CID);
      state().addSource({ id: 'added', kind: 'http' });
      expect(state().docs['w1'].dirty).toBe(true);
      expect(state().docs[CID].dirty).toBe(true);
      expect(selectHasUnsavedChanges(state())).toBe(true);
    });

    it('replaceDocFromJson on a companion routes its sources to the primary pool', () => {
      openPair([{ id: 'temp', kind: 'haState' }]);
      state().switchFocus(CID);
      // The companion JSON editor shows the merged pool; applying it must route
      // sources to the primary and keep the companion's own array empty.
      state().replaceDocFromJson({
        misc: { gridSize: '3x2' },
        elements: [{ id: 'c-el', type: 'text' }],
        sources: [{ id: 'temp', kind: 'haState' }, { id: 'added', kind: 'http' }],
      });
      expect(getDocById('w1').sources.map((s) => s.id).sort()).toEqual(['added', 'temp']);
      expect(getDocById(CID).sources).toEqual([]);
      expect(getDocById(CID).elements.map((e) => e.id)).toEqual(['c-el']);
    });

    it('rejects a JSON edit that would push the shared pool past the cap', () => {
      openPair([{ id: 'temp', kind: 'haState' }]);
      state().switchFocus(CID);
      const tooMany = Array.from({ length: MAX_SOURCES + 1 }, (_, i) => ({ id: `s${i}`, kind: 'http' }));
      state().replaceDocFromJson({ misc: { gridSize: '3x2' }, elements: [], sources: tooMany });
      // Edit not applied: pool unchanged, companion own still empty.
      expect(getDocById('w1').sources.map((s) => s.id)).toEqual(['temp']);
      expect(getDocById(CID).sources).toEqual([]);
    });

    it('records a companion source edit on the primary; it is undone from the primary screen', () => {
      openPair([{ id: 'temp', kind: 'haState', entity_id: 'sensor.a' }]);
      state().switchFocus(CID);
      state().updateSource('temp', { entity_id: 'sensor.b' });
      expect(getDocById('w1').sources[0].entity_id).toBe('sensor.b');
      // Undo while the companion is focused does NOT touch the primary's history —
      // each screen undoes only its own entry, avoiding cross-stack ordering bugs.
      state().undo();
      expect(getDocById('w1').sources[0].entity_id).toBe('sensor.b');
      // The edit is undoable from the primary screen, where its history lives.
      state().switchFocus('w1');
      state().undo();
      expect(getDocById('w1').sources[0].entity_id).toBe('sensor.a');
    });
  });

  // ── Migration: consolidate legacy companion-own sources ──────────
  describe('mergeCompanionSourcesIntoPrimary', () => {
    const CID = fullscreenIdFor('w1');

    it('folds companion-only sources onto the primary and empties the companion', () => {
      openWidget('w1', { sources: [{ id: 'p', kind: 'http' }] });
      openWidget(CID, { misc: { gridSize: '3x2' }, sources: [{ id: 'c', kind: 'http' }] });
      state().mergeCompanionSourcesIntoPrimary('w1');
      expect(getDocById('w1').sources.map((s) => s.id).sort()).toEqual(['c', 'p']);
      expect(getDocById(CID).sources).toEqual([]);
      expect(state().docs['w1'].dirty).toBe(true);
    });

    it('lets the companion override the primary on an id collision (companion wins)', () => {
      openWidget('w1', { sources: [{ id: 'temp', kind: 'haState', entity_id: 'sensor.primary' }] });
      openWidget(CID, {
        misc: { gridSize: '3x2' },
        sources: [{ id: 'temp', kind: 'haState', entity_id: 'sensor.companion' }],
      });
      state().mergeCompanionSourcesIntoPrimary('w1');
      const pool = getDocById('w1').sources;
      expect(pool).toHaveLength(1);
      expect(pool[0].entity_id).toBe('sensor.companion');
    });

    it('is a no-op (and does not dirty) when the companion has no own sources', () => {
      openWidget('w1', { sources: [{ id: 'p', kind: 'http' }] });
      openWidget(CID, { misc: { gridSize: '3x2' } });
      state().mergeCompanionSourcesIntoPrimary('w1');
      expect(getDocById('w1').sources.map((s) => s.id)).toEqual(['p']);
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('is idempotent — re-running after consolidation makes no change and does not re-dirty', () => {
      openWidget('w1', { sources: [{ id: 'p', kind: 'http' }] });
      openWidget(CID, { misc: { gridSize: '3x2' }, sources: [{ id: 'c', kind: 'http' }] });
      state().mergeCompanionSourcesIntoPrimary('w1');
      state().markClean('w1'); // simulate the post-migration save
      state().mergeCompanionSourcesIntoPrimary('w1'); // companion now empty → no-op
      expect(state().docs['w1'].dirty).toBe(false);
      expect(getDocById('w1').sources.map((s) => s.id).sort()).toEqual(['c', 'p']);
    });

    it('does nothing when there is no companion entry', () => {
      openWidget('w1', { sources: [{ id: 'p', kind: 'http' }] });
      expect(() => state().mergeCompanionSourcesIntoPrimary('w1')).not.toThrow();
      expect(getDocById('w1').sources.map((s) => s.id)).toEqual(['p']);
    });

    it('skips the fold (leaving both blobs valid, primary not dirtied) when the pool would exceed the cap', () => {
      // Each blob is individually within the cap, but the two together are not —
      // the legacy shape a fold has to leave alone.
      const primaryCount = MAX_SOURCES - 10;
      const companionCount = 20;
      const primarySources = Array.from({ length: primaryCount }, (_, i) => ({ id: `p${i}`, kind: 'http' }));
      const companionSources = Array.from({ length: companionCount }, (_, i) => ({ id: `c${i}`, kind: 'http' }));
      openWidget('w1', { sources: primarySources });
      openWidget(CID, { misc: { gridSize: '3x2' }, sources: companionSources });
      state().mergeCompanionSourcesIntoPrimary('w1');
      // Sum exceeds the cap → no mutation, widget stays in its valid legacy shape.
      expect(primaryCount + companionCount).toBeGreaterThan(MAX_SOURCES);
      expect(getDocById('w1').sources).toHaveLength(primaryCount);
      expect(getDocById(CID).sources).toHaveLength(companionCount);
      expect(state().docs['w1'].dirty).toBe(false);
    });
  });

  // ── setFocusedFullScreen + per-widget size durability ────────────────
  //
  // The mocked global getScreenSize returns 800×480, so a fresh newDoc is
  // 3x2 / 800×480. Pinning to 720×480 is therefore an off-global size — the
  // exact condition under which the "size reverts on the next misc edit" bug
  // manifested before updateMisc stopped re-deriving size on metadata edits.
  describe('setFocusedFullScreen + size durability', () => {
    beforeEach(() => {
      state().newDoc('w1');
      state().switchFocus('w1');
    });

    it('pins the focused doc to the full-screen grid at the given size (dirty + history)', () => {
      state().setFocusedFullScreen({ width: 720, height: 480 });
      const misc = state().docs['w1'].doc.misc;
      expect(misc.gridSize).toBe('3x2');
      expect(misc.size).toEqual({ width: 720, height: 480 });
      expect(state().docs['w1'].dirty).toBe(true);
      expect(state().docs['w1'].history.past.length).toBe(1);
    });

    it('is a no-op when the widget is already full-screen at that size', () => {
      // Fresh newDoc is already 3x2 / 800×480 (the mocked global). Re-pinning to
      // the identical size must not dirty the doc or push a no-op undo entry.
      expect(state().docs['w1'].doc.misc.size).toEqual({ width: 800, height: 480 });
      state().setFocusedFullScreen({ width: 800, height: 480 });
      expect(state().docs['w1'].dirty).toBe(false);
      expect(state().docs['w1'].history.past.length).toBe(0);
    });

    it('ignores an invalid size (NaN / non-positive / missing)', () => {
      const before = state().docs['w1'].doc.misc.size;
      state().setFocusedFullScreen({ width: NaN, height: 480 });
      state().setFocusedFullScreen({ width: -1, height: 480 });
      state().setFocusedFullScreen(null);
      expect(state().docs['w1'].doc.misc.size).toEqual(before);
      expect(state().docs['w1'].dirty).toBe(false);
    });

    it('no-ops (without throwing) when nothing is focused', () => {
      useDocStore.setState({ focusedDocId: null });
      expect(() => state().setFocusedFullScreen({ width: 720, height: 480 })).not.toThrow();
    });

    it('resizes ONLY the focused doc, never other open widgets (per-widget, not global)', () => {
      state().newDoc('w2'); // second primary, stays at the global 800×480
      state().switchFocus('w1');
      state().setFocusedFullScreen({ width: 720, height: 480 });
      expect(state().docs['w1'].doc.misc.size).toEqual({ width: 720, height: 480 });
      expect(state().docs['w2'].doc.misc.size).toEqual({ width: 800, height: 480 });
      expect(state().docs['w2'].dirty).toBe(false);
    });

    it('a metadata edit (name) does NOT revert a pinned off-global size', () => {
      state().setFocusedFullScreen({ width: 720, height: 480 }); // 720 ≠ global 800
      state().updateMisc({ name: 'Living room' });
      // Regression guard: a name edit must keep 720×480, not snap back to the
      // global-derived 800×480 via normalizeDoc.
      expect(state().docs['w1'].doc.misc.name).toBe('Living room');
      expect(state().docs['w1'].doc.misc.size).toEqual({ width: 720, height: 480 });
    });

    it('a gridSize edit DOES re-derive the size from the global screen', () => {
      state().setFocusedFullScreen({ width: 720, height: 480 });
      state().updateMisc({ gridSize: '2x2' });
      // gridSize changed → recompute from the mocked global 800×480:
      // round(2/3*800)=533, round(2/2*480)=480.
      expect(state().docs['w1'].doc.misc.size).toEqual({ width: 533, height: 480 });
    });
  });
});
