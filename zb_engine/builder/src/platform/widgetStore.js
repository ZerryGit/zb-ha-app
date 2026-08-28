/**
 * widgetStore.js — Zustand store for widget list management
 *
 * Coordinates between apiClient (server) and docStore (editor document).
 * State: widgets[], activeWidgetId, loading, saving, error.
 */

import { create } from 'zustand';
import * as api from './apiClient.js';
import { useDocStore, getFocusedDoc, getDocById, PENDING_DOC_ID } from '../store/docStore.js';
import { useUiStore } from '../store/uiStore.js';
import { useAutoSaveStore } from './autoSaveStore.js';
import { fullscreenIdFor } from '../store/companionId.js';
import { exportRuntimeJson } from '../models/mapper.js';
import { nextAvailableName } from '../utils/names.js';

export function collectWidgetSavePayload(widgetId, widgetName) {
  const primaryDoc = getDocById(widgetId);
  if (!primaryDoc) return null;

  const companionId = fullscreenIdFor(widgetId);
  const companionDoc = getDocById(companionId);
  const runtimeJson = exportRuntimeJson(primaryDoc);
  // Primary and companion share ONE source pool anchored on the primary, so the
  // saved fullscreen blob is stamped with the full pool (via primarySources) to
  // be self-contained: it round-trips back on reload, where the migration fold
  // (`mergeCompanionSourcesIntoPrimary`) re-consolidates it onto the primary and
  // empties the companion's own array — so no stale copy can drift. The device
  // likewise renders from the DEPLOY cache (`payload.fullscreen.json`), merged
  // self-contained by `collectDeployTargets`.
  const fullscreenJson = companionDoc
    ? exportRuntimeJson(companionDoc, { slot: 'fullscreen', primarySources: primaryDoc.sources })
    : null;

  return {
    companionId,
    runtimeJson,
    fullscreenJson,
    body: {
      name: widgetName,
      doc: runtimeJson,
      fullscreen: fullscreenJson,
    },
  };
}

function getWidgetName(widgetId) {
  const widgetState = useWidgetStore.getState();
  return widgetId === widgetState.activeWidgetId
    ? widgetState.activeWidgetName
    : widgetState.widgets.find((w) => w.id === widgetId)?.name ?? widgetId;
}

function hasDirtyWidgetDocs(widgetId) {
  const docs = useDocStore.getState().docs;
  return Boolean(
    docs[widgetId]?.dirty || docs[fullscreenIdFor(widgetId)]?.dirty,
  );
}

async function persistWidgetById(widgetId, widgetName = getWidgetName(widgetId)) {
  const docStore = useDocStore.getState();
  const savePayload = collectWidgetSavePayload(widgetId, widgetName);
  if (!savePayload) throw new Error('No widget document to save.');

  const saveResponse = await api.saveWidget(widgetId, savePayload.body);
  useWidgetStore.getState().applySavedWidgetInfo(widgetId, saveResponse);

  docStore.markClean(widgetId, JSON.stringify(savePayload.runtimeJson));
  if (docStore.docs[savePayload.companionId]) {
    docStore.markClean(
      savePayload.companionId,
      JSON.stringify(savePayload.fullscreenJson),
    );
  }
}

async function flushDirtyWidgetBeforeSwitch(widgetId) {
  if (!widgetId || !hasDirtyWidgetDocs(widgetId)) return;

  if (!useAutoSaveStore.getState().enabled) {
    throw new Error('Unsaved changes exist. Save or enable auto-save before switching widgets.');
  }

  await persistWidgetById(widgetId);
}

export const useWidgetStore = create((set, get) => ({
  widgets: [],
  activeWidgetId: null,
  activeWidgetName: '',
  // Server-assigned pairing IDs for the ACTIVE widget (envelope fields,
  // never part of the doc payload). Null until the widget has been saved
  // at least once under the pairing feature. `activeFullscreenPairingId`
  // is sticky server-side: it stays set even while no fullscreen companion
  // exists — the QR layer reports `fs: 0` based on companion PRESENCE.
  activePairingId: null,
  activeFullscreenPairingId: null,
  // Pixel size of the ACTIVE widget's PRIMARY payload as the server PERSISTED
  // it — the QR's `w`/`h`. Deliberately not read from the live editor doc: the
  // QR must advertise the size the device will actually be served, not one the
  // user is mid-way through changing. Refreshed on load and on every save.
  activeWidgetWidth: null,
  activeWidgetHeight: null,
  loading: false,
  saving: false,
  error: null,

  // ── Actions ────────────────────────────────────────────────

  /** Fetch widget list from server. */
  async fetchWidgets() {
    set({ loading: true, error: null });
    try {
      const data = await api.listWidgets();
      set({ widgets: data.widgets ?? data, loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  /** Load a widget document into the editor (docStore). */
  async openWidget(id) {
    set({ loading: true, error: null });
    try {
      const prevId = get().activeWidgetId;
      if (prevId && prevId !== id) {
        await flushDirtyWidgetBeforeSwitch(prevId);
      }

      const data = await api.loadWidget(id);
      const docStore = useDocStore.getState();

      // Persisted primary size for the QR. Read off the stored payload the GET
      // already returns — the same authority as the save response's
      // width/height, so no extra round-trip and no second source of truth.
      const savedSize = (data.doc ?? data)?.misc?.size;

      // Close the previous widget's companion entry (if any) to prevent
      // ghost dirty state from a stale companion lingering in docs[].
      if (prevId && prevId !== id) {
        const prevCompanion = fullscreenIdFor(prevId);
        if (useDocStore.getState().docs[prevCompanion]) {
          docStore.closeDoc(prevCompanion);
        }
      }

      // Add new entry to docs map (or replace if re-opening).
      docStore.openDoc(id, data.doc ?? data);

      // If the saved widget includes a fullscreen companion, hydrate it so
      // the dual-pane layout can show it without a refetch, then consolidate any
      // legacy companion-own sources onto the shared pool on the primary so both
      // screens edit one list (no-op for already-unified widgets).
      if (data.fullscreen) {
        docStore.openDoc(fullscreenIdFor(id), data.fullscreen);
        docStore.mergeCompanionSourcesIntoPrimary(id);
      }

      // Switch canvas focus to the new widget.
      docStore.switchFocus(id);

      // Update active widget AFTER the doc is loaded so there is no
      // window where activeWidgetId points to a missing doc entry.
      // The widget-switch auto-save subscription (#2) fires here and
      // will flush any pending save for the departing widget.
      set({
        activeWidgetId: id,
        activeWidgetName: data.name ?? id,
        activePairingId: data.pairingId ?? null,
        activeFullscreenPairingId: data.fullscreenPairingId ?? null,
        activeWidgetWidth: savedSize?.width ?? null,
        activeWidgetHeight: savedSize?.height ?? null,
        loading: false,
      });
    } catch (err) {
      set({ error: err.message, loading: false });
    }
  },

  /**
   * Adopt the QR-relevant facts echoed by a successful widget save: the
   * pairing IDs and the persisted primary size.
   * Guarded on the ACTIVE widget so a background auto-save (e.g. a timer
   * firing for a previously-focused widget) never clobbers what is shown
   * for the widget the user is looking at. Tolerates an absent response —
   * the values then simply refresh on the next load — and tolerates a
   * response from a backend too old to echo the size (see below).
   */
  applySavedWidgetInfo(widgetId, saveResponse) {
    if (!saveResponse || widgetId !== get().activeWidgetId) return;
    const patch = {
      activePairingId: saveResponse.pairingId ?? null,
      activeFullscreenPairingId: saveResponse.fullscreenPairingId ?? null,
    };
    // Size is the one field with a SECOND source — openWidget reads it from the
    // stored doc.misc.size — so a response that omits it carries no
    // information and must not overwrite what we already know. An older
    // backend that doesn't echo width/height (e.g. this builder run against a
    // deployed 0.1.3) would otherwise wipe w/h out of the QR on the first
    // auto-save. The pairing IDs above are different: the server is their only
    // source, so absent legitimately means "none yet".
    if (saveResponse.width != null && saveResponse.height != null) {
      patch.activeWidgetWidth = saveResponse.width;
      patch.activeWidgetHeight = saveResponse.height;
    }
    set(patch);
  },

  /** Save the current editor document back to the server. */
  async saveCurrentWidget() {
    const { activeWidgetId, activeWidgetName } = get();
    if (!activeWidgetId) return;

    set({ saving: true, error: null });
    try {
      await persistWidgetById(activeWidgetId, activeWidgetName);

      set({ saving: false });
      // Refresh list so updatedAt etc. are current
      await get().fetchWidgets();
    } catch (err) {
      set({ error: err.message, saving: false });
    }
  },

  /**
   * Create a new widget and persist it to the server.
   *
   * @param {object} [opts]
   * @param {string} [opts.name]     Custom name. If empty/omitted, auto-generates "Untitled 1", "Untitled 2", …
   * @param {boolean} [opts.resetDoc] If true, creates a fresh blank doc (used by TopBar "New Widget").
   *                                   If false (default), copies the current focused doc (preserves
   *                                   grid-size from GridSizeSelector).
   */
  async createNewWidget({ name, resetDoc } = {}) {
    set({ loading: true, error: null });
    try {
      const id = await api.newWidgetId();
      const docStore = useDocStore.getState();

      if (resetDoc) {
        // TopBar "New Widget" — create a fresh blank doc under the real ID.
        docStore.newDoc(id);
        docStore.switchFocus(id);
      } else {
        // Welcome → GridSizeSelector flow — copy the current focused doc
        // (from '__pending') into the real widget entry, then clean up.
        const currentDoc = getFocusedDoc();
        docStore.openDoc(id, exportRuntimeJson(currentDoc));

        // Remove the temporary entry if it exists.
        const focusedId = useDocStore.getState().focusedDocId;
        if (focusedId === PENDING_DOC_ID) {
          docStore.closeDoc(PENDING_DOC_ID);
        }
      }

      // Resolve the widget name
      const existingNames = get().widgets.map((w) => w.name);
      const resolvedName = name && name.trim()
        ? name.trim()
        : nextAvailableName('Untitled', existingNames);

      const doc = useDocStore.getState().docs[id]?.doc;
      const runtimeJson = exportRuntimeJson(doc);
      const saveResponse = await api.saveWidget(id, resolvedName, runtimeJson);

      set({
        activeWidgetId: id,
        activeWidgetName: resolvedName,
        // A brand-new widget gets its pairing ID on this first save; the
        // fullscreen ID stays null until a companion is saved.
        activePairingId: saveResponse?.pairingId ?? null,
        activeFullscreenPairingId: saveResponse?.fullscreenPairingId ?? null,
        activeWidgetWidth: saveResponse?.width ?? null,
        activeWidgetHeight: saveResponse?.height ?? null,
        loading: false,
      });

      docStore.switchFocus(id);
      await get().fetchWidgets();
    } catch (err) {
      set({ error: err.message, loading: false });
      throw err;
    }
  },

  /** Delete a widget from the server and refresh the list.
   *  If the deleted widget was active:
   *    - Other widgets remain → auto-switch to the first one.
   *    - No widgets remain   → set activeWidgetId to null
   *      (App.jsx detects this and returns to the welcome screen).
   */
  async deleteWidget(id) {
    set({ loading: true, error: null });
    try {
      await api.deleteWidget(id);
      const wasActive = get().activeWidgetId === id;

      // Remove the primary and companion entries as one lifecycle operation.
      useDocStore.getState().closeWidgetDocs(id);
      useUiStore.getState().clearSelection();

      // If the deleted widget was active, clear activeWidgetId so the UI
      // doesn't reference a stale widget while fetchWidgets and openWidget run.
      if (wasActive) {
        set({
          activeWidgetId: null,
          activeWidgetName: '',
          activePairingId: null,
          activeFullscreenPairingId: null,
          activeWidgetWidth: null,
          activeWidgetHeight: null,
        });
      }

      await get().fetchWidgets();

      if (wasActive) {
        const remaining = get().widgets;
        if (remaining.length > 0) {
          // Auto-switch to the first remaining widget
          await get().openWidget(remaining[0].id);
        }
        // If no widgets remain, docStore is already empty (closeDoc handled it).
        // App.jsx's safety-net will show the welcome screen.
      }

      set({ loading: false });
    } catch (err) {
      set({ error: err.message, loading: false });
      // Refresh widget list even on failure to sync with server state
      // (the delete may have succeeded server-side before the response failed).
      try { await get().fetchWidgets(); } catch { /* best-effort */ }
    }
  },

  /** Update the active widget name (local only until saved).
   *  Also patches the widgets[] list so the dropdown reflects
   *  the new name immediately without a server round-trip. */
  setActiveWidgetName(name) {
    set((state) => ({
      activeWidgetName: name,
      widgets: state.widgets.map((w) =>
        w.id === state.activeWidgetId ? { ...w, name } : w,
      ),
    }));
  },

  /** Clear the error state. */
  clearError() {
    set({ error: null });
  },

  // ── Fullscreen-companion lifecycle ────────────

  /**
   * Ensure the active widget has a fullscreen companion entry in docStore.
   * If one already exists, no-op. Otherwise create a fresh blank 3x2 doc
   * under `<widgetId>::fullscreen` and mark the widget dirty so the next
   * auto-save persists the companion to disk.
   *
   * @param {string} [widgetId] Defaults to the active widget id.
   * @returns {string|null} The companion doc id, or null if no widget active.
   */
  ensureFullscreenCompanion(widgetId) {
    const id = widgetId ?? get().activeWidgetId;
    if (!id) return null;
    const companionId = fullscreenIdFor(id);
    const docStore = useDocStore.getState();
    if (docStore.docs[companionId]) return companionId;

    docStore.newDoc(companionId);
    // Mark the PRIMARY widget dirty so auto-save fires and includes the new
    // companion in the body. The companion entry itself is created clean by
    // newDoc(); marking it dirty too is harmless and ensures the companion
    // hash baseline updates on save.
    useDocStore.setState((state) => {
      if (state.docs[id]) state.docs[id].dirty = true;
      if (state.docs[companionId]) state.docs[companionId].dirty = true;
    });
    return companionId;
  },

  /**
   * Remove the active widget's fullscreen companion. Marks the widget
   * dirty so the next auto-save writes `fullscreen: null` and the server
   * deletes the slot files (companion presence MUST trigger a save even if
   * no other edit follows).
   */
  deleteFullscreenCompanion(widgetId) {
    const id = widgetId ?? get().activeWidgetId;
    if (!id) return;
    const companionId = fullscreenIdFor(id);
    const docStore = useDocStore.getState();
    if (!docStore.docs[companionId]) return;
    docStore.closeDoc(companionId);
    useDocStore.setState((state) => {
      if (state.docs[id]) state.docs[id].dirty = true;
    });
  },
}));

// ── Platform handler registration ─────────────────────────────────────
//
// Inject the companion-creation and companion-deletion handlers into
// uiStore so the core CanvasToolbox slot tabs can dispatch without
// importing the platform layer. Mirrors the pattern used by
// sourceTestHandler and previewRenderer.
useUiStore.getState().setEnsureFullscreenCompanionHandler((widgetId) =>
  useWidgetStore.getState().ensureFullscreenCompanion(widgetId),
);
useUiStore.getState().setDeleteFullscreenCompanionHandler((widgetId) =>
  useWidgetStore.getState().deleteFullscreenCompanion(widgetId),
);
