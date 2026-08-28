/**
 * widgetStore.test.js — Companion-aware widget lifecycle tests.
 *
 * Covers the fullscreen companion feature: opening / closing / saving widgets that
 * carry the optional fullscreen companion, plus ensureFullscreenCompanion
 * and deleteFullscreenCompanion.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock platform deps ──────────────────────────────────────────────

vi.mock('../apiClient.js', () => ({
  listWidgets: vi.fn(() => Promise.resolve({ widgets: [] })),
  loadWidget: vi.fn(),
  saveWidget: vi.fn(() => Promise.resolve()),
  newWidgetId: vi.fn(() => Promise.resolve('w_new')),
  deleteWidget: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../store/displayConfigStore.js', () => ({
  getDisplayConfig: () => ({
    getScreenSize: () => ({ width: 800, height: 480 }),
    confirmGridSize: vi.fn(),
    resetGridSizeConfirmation: vi.fn(),
  }),
}));

let _idCounter = 0;
vi.mock('../../utils/ids.js', () => ({
  createId: () => `test-id-${++_idCounter}`,
}));

vi.mock('../../models/mapper.js', () => ({
  importRuntimeJson: (json) => ({
    misc: { gridSize: '1x1', size: { width: 240, height: 240 }, tags: [], ...json?.misc },
    elements: json?.elements ?? [],
    sources: json?.sources ?? [],
    features: json?.features ?? { definitions: {}, values: {} },
  }),
  exportRuntimeJson: (doc) => ({ ...doc }),
  createNameGeneratorFromElements: () => (type) => `${type}_1`,
  // Faithful stand-in for the real merge (companion wins on id collision) so the
  // docStore migration fold works under this mocked mapper.
  mergeInheritedSources: (primary, own) => {
    const o = Array.isArray(own) ? own : [];
    const ids = new Set(o.map((s) => s?.id));
    const inherited = (Array.isArray(primary) ? primary : []).filter((s) => !ids.has(s?.id));
    return [...inherited, ...o];
  },
}));

import { useDocStore } from '../../store/docStore.js';
import { useWidgetStore } from '../widgetStore.js';
import { useAutoSaveStore } from '../autoSaveStore.js';
import { fullscreenIdFor } from '../../store/companionId.js';
import * as api from '../apiClient.js';

function reset() {
  useDocStore.setState({ focusedDocId: null, docs: {} });
  useWidgetStore.setState({
    widgets: [],
    activeWidgetId: null,
    activeWidgetName: '',
    activePairingId: null,
    activeFullscreenPairingId: null,
    loading: false,
    saving: false,
    error: null,
  });
  useAutoSaveStore.setState({
    enabled: false,
    lastSavedAt: null,
    saving: false,
    lastError: null,
  });
  _idCounter = 0;
  vi.clearAllMocks();
  // Default fetchWidgets returns an empty list so saveCurrentWidget's
  // post-save refresh does not blow up.
  api.listWidgets.mockResolvedValue({ widgets: [] });
}

describe('widgetStore — companion lifecycle', () => {
  beforeEach(reset);

  it('openWidget hydrates a fullscreen companion entry when present', async () => {
    api.loadWidget.mockResolvedValue({
      name: 'A',
      doc: { misc: { gridSize: '1x1' }, elements: [] },
      fullscreen: { misc: { gridSize: '3x2' }, elements: [] },
    });

    await useWidgetStore.getState().openWidget('w1');

    const docs = useDocStore.getState().docs;
    expect(docs['w1']).toBeDefined();
    expect(docs[fullscreenIdFor('w1')]).toBeDefined();
    expect(useWidgetStore.getState().activeWidgetId).toBe('w1');
  });

  it('openWidget consolidates legacy companion-own sources onto the primary pool', async () => {
    api.loadWidget.mockResolvedValue({
      name: 'A',
      doc: { misc: { gridSize: '1x1' }, elements: [], sources: [{ id: 'p' }] },
      fullscreen: { misc: { gridSize: '3x2' }, elements: [], sources: [{ id: 'c' }] },
    });

    await useWidgetStore.getState().openWidget('w1');

    const docs = useDocStore.getState().docs;
    expect(docs['w1'].doc.sources.map((s) => s.id).sort()).toEqual(['c', 'p']);
    expect(docs[fullscreenIdFor('w1')].doc.sources).toEqual([]);
  });

  it('openWidget without a companion leaves the companion entry absent', async () => {
    api.loadWidget.mockResolvedValue({
      name: 'A',
      doc: { misc: { gridSize: '1x1' }, elements: [] },
    });

    await useWidgetStore.getState().openWidget('w1');

    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeUndefined();
  });

  it('openWidget closes the previous widget\'s companion entry', async () => {
    // First widget WITH a companion.
    api.loadWidget.mockResolvedValueOnce({
      name: 'A',
      doc: { misc: {}, elements: [] },
      fullscreen: { misc: { gridSize: '3x2' }, elements: [] },
    });
    await useWidgetStore.getState().openWidget('w1');
    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeDefined();

    // Switch to a second widget WITHOUT a companion.
    api.loadWidget.mockResolvedValueOnce({
      name: 'B',
      doc: { misc: {}, elements: [] },
    });
    await useWidgetStore.getState().openWidget('w2');

    // The previous companion entry must be gone — no ghost dirty state.
    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeUndefined();
  });

  it('openWidget flushes dirty companion changes before switching widgets', async () => {
    useDocStore.getState().openDoc('w1', {
      misc: {},
      elements: [{ id: 'primary-element', type: 'rect' }],
    });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), {
      misc: { gridSize: '3x2' },
      elements: [{ id: 'dirty-fullscreen-element', type: 'text' }],
    });
    useDocStore.getState().switchFocus(fullscreenIdFor('w1'));
    useDocStore.setState((s) => {
      s.docs[fullscreenIdFor('w1')].dirty = true;
    });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'Widget 1',
      widgets: [{ id: 'w1', name: 'Widget 1' }, { id: 'w2', name: 'Widget 2' }],
    });
    useAutoSaveStore.setState({ enabled: true });
    api.loadWidget.mockResolvedValueOnce({
      name: 'Widget 2',
      doc: { misc: {}, elements: [] },
    });

    await useWidgetStore.getState().openWidget('w2');

    expect(api.saveWidget).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        fullscreen: expect.objectContaining({
          elements: [expect.objectContaining({ id: 'dirty-fullscreen-element' })],
        }),
      }),
    );
    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeUndefined();
    expect(useWidgetStore.getState().activeWidgetId).toBe('w2');
  });

  it('openWidget blocks switching away from dirty docs when auto-save is disabled', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w1');
    useDocStore.setState((s) => {
      s.docs.w1.dirty = true;
    });
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'Widget 1' });

    await useWidgetStore.getState().openWidget('w2');

    expect(api.loadWidget).not.toHaveBeenCalled();
    expect(useWidgetStore.getState().activeWidgetId).toBe('w1');
    expect(useWidgetStore.getState().error).toContain('Unsaved changes');
  });

  it('saveCurrentWidget sends fullscreen=null when no companion exists', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w1');
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });

    await useWidgetStore.getState().saveCurrentWidget();

    expect(api.saveWidget).toHaveBeenCalledTimes(1);
    expect(api.saveWidget).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({ name: 'A', fullscreen: null }),
    );
  });

  it('saveCurrentWidget sends the companion doc when present', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), {
      misc: { gridSize: '3x2' },
      elements: [{ type: 'rect' }],
    });
    useDocStore.getState().switchFocus('w1');
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });

    await useWidgetStore.getState().saveCurrentWidget();

    expect(api.saveWidget).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        name: 'A',
        fullscreen: expect.objectContaining({ misc: expect.objectContaining({ gridSize: '3x2' }) }),
      }),
    );
  });

  it('saveCurrentWidget keeps primary and fullscreen separate when fullscreen is focused', async () => {
    useDocStore.getState().openDoc('w1', {
      misc: {},
      elements: [{ id: 'primary-element', type: 'rect' }],
    });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), {
      misc: { gridSize: '3x2' },
      elements: [{ id: 'fullscreen-element', type: 'text' }],
    });
    useDocStore.getState().switchFocus(fullscreenIdFor('w1'));
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });

    await useWidgetStore.getState().saveCurrentWidget();

    expect(api.saveWidget).toHaveBeenCalledWith(
      'w1',
      expect.objectContaining({
        doc: expect.objectContaining({
          elements: [expect.objectContaining({ id: 'primary-element' })],
        }),
        fullscreen: expect.objectContaining({
          elements: [expect.objectContaining({ id: 'fullscreen-element' })],
        }),
      }),
    );
  });

  it('ensureFullscreenCompanion creates a companion entry and marks both dirty', () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });

    const companionId = useWidgetStore.getState().ensureFullscreenCompanion();

    expect(companionId).toBe(fullscreenIdFor('w1'));
    const docs = useDocStore.getState().docs;
    expect(docs[companionId]).toBeDefined();
    expect(docs['w1'].dirty).toBe(true);
    expect(docs[companionId].dirty).toBe(true);
  });

  it('ensureFullscreenCompanion is a no-op when companion already exists', () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), { misc: { gridSize: '3x2' }, elements: [] });
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    // Manually un-dirty the primary so we can prove it's NOT re-marked.
    useDocStore.setState((s) => { s.docs['w1'].dirty = false; });

    const result = useWidgetStore.getState().ensureFullscreenCompanion();

    expect(result).toBe(fullscreenIdFor('w1'));
    expect(useDocStore.getState().docs['w1'].dirty).toBe(false);
  });

  it('ensureFullscreenCompanion returns null when no widget is active', () => {
    expect(useWidgetStore.getState().ensureFullscreenCompanion()).toBeNull();
  });

  it('deleteFullscreenCompanion removes the entry and marks primary dirty', () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), { misc: { gridSize: '3x2' }, elements: [] });
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    useDocStore.setState((s) => { s.docs['w1'].dirty = false; });

    useWidgetStore.getState().deleteFullscreenCompanion();

    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeUndefined();
    expect(useDocStore.getState().docs['w1'].dirty).toBe(true);
  });

  it('deleteFullscreenCompanion is a no-op when no companion exists', () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    useDocStore.setState((s) => { s.docs['w1'].dirty = false; });

    useWidgetStore.getState().deleteFullscreenCompanion();

    expect(useDocStore.getState().docs['w1'].dirty).toBe(false);
  });

  it('deleteWidget removes an active widget and its companion doc', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), { misc: { gridSize: '3x2' }, elements: [] });
    useDocStore.getState().switchFocus(fullscreenIdFor('w1'));
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    api.listWidgets.mockResolvedValue({ widgets: [] });

    await useWidgetStore.getState().deleteWidget('w1');

    expect(useDocStore.getState().docs.w1).toBeUndefined();
    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeUndefined();
    expect(useDocStore.getState().focusedDocId).toBeNull();
    expect(useWidgetStore.getState().activeWidgetId).toBeNull();
  });

  it('pairing IDs: openWidget adopts them from the load response', async () => {
    api.loadWidget.mockResolvedValue({
      name: 'A',
      doc: { misc: {}, elements: [] },
      pairingId: 482915637,
      fullscreenPairingId: 193847265,
    });

    await useWidgetStore.getState().openWidget('w1');

    expect(useWidgetStore.getState().activePairingId).toBe(482915637);
    expect(useWidgetStore.getState().activeFullscreenPairingId).toBe(193847265);
  });

  it('QR size: openWidget adopts the STORED primary size, not the editor doc', async () => {
    api.loadWidget.mockResolvedValue({
      name: 'A',
      doc: { misc: { size: { width: 533, height: 240 } }, elements: [] },
      pairingId: 482915637,
    });

    await useWidgetStore.getState().openWidget('w1');

    expect(useWidgetStore.getState().activeWidgetWidth).toBe(533);
    expect(useWidgetStore.getState().activeWidgetHeight).toBe(240);
  });

  it('QR size: an envelope with no misc.size loads with both dimensions null', async () => {
    useWidgetStore.setState({ activeWidgetWidth: 240, activeWidgetHeight: 240 });
    api.loadWidget.mockResolvedValue({
      name: 'Sizeless',
      doc: { misc: {}, elements: [] },
    });

    await useWidgetStore.getState().openWidget('w1');

    expect(useWidgetStore.getState().activeWidgetWidth).toBeNull();
    expect(useWidgetStore.getState().activeWidgetHeight).toBeNull();
  });

  it('pairing IDs: a pre-pairing envelope loads with both IDs null', async () => {
    useWidgetStore.setState({ activePairingId: 111111111, activeFullscreenPairingId: 222222222 });
    api.loadWidget.mockResolvedValue({
      name: 'Old',
      doc: { misc: {}, elements: [] },
    });

    await useWidgetStore.getState().openWidget('w1');

    expect(useWidgetStore.getState().activePairingId).toBeNull();
    expect(useWidgetStore.getState().activeFullscreenPairingId).toBeNull();
  });

  it('pairing IDs: saveCurrentWidget adopts them from the save response', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w1');
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    api.saveWidget.mockResolvedValue({
      ok: true, id: 'w1', name: 'A', updatedAt: 1, pairingId: 482915637,
    });

    await useWidgetStore.getState().saveCurrentWidget();

    expect(useWidgetStore.getState().activePairingId).toBe(482915637);
    expect(useWidgetStore.getState().activeFullscreenPairingId).toBeNull();
  });

  it('pairing IDs: a save response without them is tolerated (legacy server)', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w1');
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    api.saveWidget.mockResolvedValue(undefined);

    await useWidgetStore.getState().saveCurrentWidget();

    expect(useWidgetStore.getState().error).toBeNull();
    expect(useWidgetStore.getState().activePairingId).toBeNull();
  });

  it('pairing IDs: applySavedWidgetInfo ignores saves for non-active widgets', () => {
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activePairingId: 482915637,
      activeFullscreenPairingId: null,
      activeWidgetWidth: 240,
      activeWidgetHeight: 240,
    });

    useWidgetStore.getState().applySavedWidgetInfo('w2', {
      ok: true, id: 'w2', pairingId: 999999999, width: 800, height: 480,
    });

    expect(useWidgetStore.getState().activePairingId).toBe(482915637);
    expect(useWidgetStore.getState().activeWidgetWidth).toBe(240);
    expect(useWidgetStore.getState().activeWidgetHeight).toBe(240);
  });

  it('QR size: an old backend that omits width/height does NOT wipe the loaded size', async () => {
    // Regression: the builder can run against a deployed add-on too old to
    // echo width/height. openWidget already learned the size from
    // doc.misc.size; a silent response must leave it alone, or the QR loses
    // w/h on the first auto-save.
    api.loadWidget.mockResolvedValue({
      name: 'A',
      doc: { misc: { size: { width: 240, height: 240 } }, elements: [] },
      pairingId: 482915637,
    });
    await useWidgetStore.getState().openWidget('w1');
    expect(useWidgetStore.getState().activeWidgetWidth).toBe(240);

    useWidgetStore.getState().applySavedWidgetInfo('w1', {
      ok: true, id: 'w1', name: 'A', updatedAt: 2, pairingId: 482915637,
    });

    expect(useWidgetStore.getState().activeWidgetWidth).toBe(240);
    expect(useWidgetStore.getState().activeWidgetHeight).toBe(240);
    // Pairing IDs keep their old behaviour — the server is their only source.
    expect(useWidgetStore.getState().activePairingId).toBe(482915637);
  });

  it('QR size: a save response refreshes the persisted primary size', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w1');
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'A' });
    api.saveWidget.mockResolvedValue({
      ok: true, id: 'w1', name: 'A', updatedAt: 1, pairingId: 482915637, width: 533, height: 240,
    });

    await useWidgetStore.getState().saveCurrentWidget();

    expect(useWidgetStore.getState().activeWidgetWidth).toBe(533);
    expect(useWidgetStore.getState().activeWidgetHeight).toBe(240);
  });

  it('pairing IDs: createNewWidget adopts the freshly minted ID', async () => {
    useDocStore.getState().openDoc('seed', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('seed');
    api.saveWidget.mockResolvedValue({
      ok: true, id: 'w_new', name: 'Untitled 1', updatedAt: 1, pairingId: 271828182,
    });

    await useWidgetStore.getState().createNewWidget({ resetDoc: true });

    expect(useWidgetStore.getState().activeWidgetId).toBe('w_new');
    expect(useWidgetStore.getState().activePairingId).toBe(271828182);
    expect(useWidgetStore.getState().activeFullscreenPairingId).toBeNull();
  });

  it('pairing IDs: deleting the active widget clears them', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w1');
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'A',
      activePairingId: 482915637,
      activeFullscreenPairingId: 193847265,
    });
    api.listWidgets.mockResolvedValue({ widgets: [] });

    await useWidgetStore.getState().deleteWidget('w1');

    expect(useWidgetStore.getState().activePairingId).toBeNull();
    expect(useWidgetStore.getState().activeFullscreenPairingId).toBeNull();
  });

  it('deleteWidget removes an inactive widget and its companion without changing active focus', async () => {
    useDocStore.getState().openDoc('w1', { misc: {}, elements: [] });
    useDocStore.getState().openDoc(fullscreenIdFor('w1'), { misc: { gridSize: '3x2' }, elements: [] });
    useDocStore.getState().openDoc('w2', { misc: {}, elements: [] });
    useDocStore.getState().switchFocus('w2');
    useWidgetStore.setState({ activeWidgetId: 'w2', activeWidgetName: 'B' });
    api.listWidgets.mockResolvedValue({ widgets: [{ id: 'w2', name: 'B' }] });

    await useWidgetStore.getState().deleteWidget('w1');

    expect(useDocStore.getState().docs.w1).toBeUndefined();
    expect(useDocStore.getState().docs[fullscreenIdFor('w1')]).toBeUndefined();
    expect(useDocStore.getState().focusedDocId).toBe('w2');
    expect(useWidgetStore.getState().activeWidgetId).toBe('w2');
  });
});
