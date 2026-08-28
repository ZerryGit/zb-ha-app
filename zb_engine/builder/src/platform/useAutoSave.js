/**
 * useAutoSave.js — Auto-save hook
 *
 * Subscribes to docStore changes (outside React) and triggers
 * a debounced save via widgetStore when auto-save is enabled.
 *
 * Dirty tracking uses docStore's per-entry `dirty` flag — the single
 * source of truth for "has the doc changed since last save?". Both
 * auto-save and manual save read/write the same flag via `markClean`.
 *
 * ENGINEERING_CONSTRAINTS: Lives in platform/ — persistence is a platform concern.
 * ENGINEERING_CONSTRAINTS: Core store (docStore) is observed, not modified.
 */

import { useEffect, useRef } from 'react';
import { useDocStore } from '../store/docStore.js';
import { collectWidgetSavePayload, useWidgetStore } from './widgetStore.js';
import { useAutoSaveStore } from './autoSaveStore.js';
import { fullscreenIdFor } from '../store/companionId.js';
import { saveWidget } from './apiClient.js';
import { AUTOSAVE_DEBOUNCE_MS } from '../limits.js';

const DEBOUNCE_MS = AUTOSAVE_DEBOUNCE_MS;

// Module-level name baseline — tracks the last-saved widget name so
// name-only changes can be detected and persisted.  Safe as module state
// because useAutoSave is activated in exactly one top-level component.
let _lastSavedName = null;

/**
 * Activate in a top-level component (e.g. TopBar or App).
 * Subscribes to docStore, widgetStore, and autoSaveStore outside React
 * for efficiency.
 *
 * Four triggers managed here:
 *   1. Doc change    → debounced save after DEBOUNCE_MS ms (per-widget timer)
 *   2. Widget switch → flush departing widget's pending save immediately
 *   3. Autosave toggled ON → immediately schedule a save if the focused doc is dirty
 *   4. Widget name change  → debounced save so renames are persisted even
 *                            when the doc content itself hasn't changed
 *                            (uses force flag to bypass dirty check)
 */
export function useAutoSave() {
  // Per-widget debounce timers: Map<widgetId, timeoutId>
  const timersRef = useRef(new Map());

  useEffect(() => {
    // ── 1. Doc-change subscription (debounced per-widget trigger) ────────
    const unsubDoc = useDocStore.subscribe((state, prev) => {
      const focusedId = state.focusedDocId;
      if (!focusedId) return;

      // Resolve the PRIMARY widget id — a focused companion still saves
      // through its primary's debounce timer.
      const { activeWidgetId } = useWidgetStore.getState();
      if (!activeWidgetId) return;

      const companionId = fullscreenIdFor(activeWidgetId);

      // Detect change in primary doc, companion doc, OR companion presence
      // (created/removed). Presence change is a required trigger — deleting a
      // companion must save even with no further edits.
      const primaryChanged =
        state.docs[activeWidgetId]?.doc !== prev.docs[activeWidgetId]?.doc;
      const companionChanged =
        state.docs[companionId]?.doc !== prev.docs[companionId]?.doc;
      const presenceChanged =
        Boolean(state.docs[companionId]) !== Boolean(prev.docs[companionId]);

      if (!primaryChanged && !companionChanged && !presenceChanged) return;

      const { enabled } = useAutoSaveStore.getState();
      if (!enabled) return;

      // Always schedule under the PRIMARY widget id so saves coalesce
      // regardless of which pane currently has focus.
      scheduleSave(timersRef, activeWidgetId);
    });

    // ── 2. Widget-switch subscription (flush departing widget) ───────────
    const unsubWidget = useWidgetStore.subscribe((state, prev) => {
      if (state.activeWidgetId === prev.activeWidgetId) return;

      // If autosave is on and there was a pending timer for the OLD widget,
      // cancel it and flush immediately so changes aren't lost on switch.
      if (prev.activeWidgetId && timersRef.current.has(prev.activeWidgetId)) {
        clearTimeout(timersRef.current.get(prev.activeWidgetId));
        timersRef.current.delete(prev.activeWidgetId);

        const { enabled } = useAutoSaveStore.getState();
        if (enabled) {
          _doSave(prev.activeWidgetId);
        }
      }

      // Initialize saved name baseline from the new widget so a
      // subsequent rename is detected as a real change.
      _lastSavedName = state.activeWidgetName ?? null;
    });

    // ── 3. Autosave toggle-on subscription ──────────────────────────────
    const unsubToggle = useAutoSaveStore.subscribe((state, prev) => {
      if (!state.enabled || prev.enabled === state.enabled) return;

      // Autosave was just turned on — schedule an immediate save if EITHER
      // the primary doc OR its companion is dirty so changes made while
      // disabled aren't lost.
      const { activeWidgetId } = useWidgetStore.getState();
      if (!activeWidgetId) return;

      const docState = useDocStore.getState();
      const primaryEntry = docState.docs[activeWidgetId];
      const companionEntry = docState.docs[fullscreenIdFor(activeWidgetId)];
      if (primaryEntry?.dirty || companionEntry?.dirty) {
        scheduleSave(timersRef, activeWidgetId, /* immediate= */ true);
      }
    });

    // ── 4. Widget name change subscription ──────────────────────────────
    const unsubName = useWidgetStore.subscribe((state, prev) => {
      // Only trigger on name edits, not widget switches.
      if (state.activeWidgetId !== prev.activeWidgetId) return;
      if (state.activeWidgetName === prev.activeWidgetName) return;

      const { enabled } = useAutoSaveStore.getState();
      if (!enabled) return;
      if (!state.activeWidgetId) return;

      // Skip if the name reverted back to the last-saved value
      // (e.g. user typed, saved, then reverted via undo/backspace).
      if (state.activeWidgetName === _lastSavedName) return;

      // Force save even if doc isn't dirty — the name change itself
      // needs to be persisted to the server.
      scheduleSave(timersRef, state.activeWidgetId, /* immediate= */ false, /* forceNameSave= */ true);
    });

    return () => {
      unsubDoc();
      unsubWidget();
      unsubToggle();
      unsubName();
      // Clear all pending timers on unmount
      for (const timerId of timersRef.current.values()) {
        clearTimeout(timerId);
      }
      timersRef.current.clear();
    };
  }, []);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Schedule a debounced save for a specific widget.
 * Resets that widget's timer on every call.
 * @param {boolean} [immediate] If true, use a 0ms delay (next tick).
 * @param {boolean} [forceNameSave] If true, save even when doc is not dirty (name-only change).
 */
function scheduleSave(timersRef, widgetId, immediate = false, forceNameSave = false) {
  const existing = timersRef.current.get(widgetId);
  if (existing) clearTimeout(existing);
  const timerId = setTimeout(
    () => {
      timersRef.current.delete(widgetId);
      _doSave(widgetId, { forceNameSave });
    },
    immediate ? 0 : DEBOUNCE_MS,
  );
  timersRef.current.set(widgetId, timerId);
}

/**
 * Perform the actual auto-save for a specific widget.
 * Uses docStore's per-entry dirty flag as the single source of truth.
 * Reads the doc by widget ID so it works for both focused and background widgets.
 *
 * @param {string} widgetId
 * @param {object} [opts]
 * @param {boolean} [opts.forceNameSave] Skip dirty check — used for name-only changes.
 */
async function _doSave(widgetId, { forceNameSave = false } = {}) {
  // Bail out if another auto-save is already in flight.
  const { saving: autoSaving } = useAutoSaveStore.getState();
  if (autoSaving) return;

  const { enabled } = useAutoSaveStore.getState();
  if (!enabled) return;

  const entry = useDocStore.getState().docs[widgetId];
  if (!entry) return;

  const companionId = fullscreenIdFor(widgetId);
  const companionEntry = useDocStore.getState().docs[companionId];
  const anyDirty = entry.dirty || (companionEntry?.dirty ?? false);

  // For name-only saves, verify the name actually differs from the
  // last-saved baseline.  The subscription may have scheduled a save
  // that is no longer needed if the user reverted the name.
  if (forceNameSave && !anyDirty) {
    const { activeWidgetId, activeWidgetName } = useWidgetStore.getState();
    const currentName = (widgetId === activeWidgetId) ? activeWidgetName : null;
    if (currentName === _lastSavedName) return;
  }
  if (!anyDirty && !forceNameSave) return;

  // Look up the widget name — may not be the active widget if this is
  // a background timer firing for a previously-focused widget.
  const { activeWidgetId, activeWidgetName, widgets, saving: widgetSaving } = useWidgetStore.getState();
  if (widgetSaving) return;

  const widgetName = (widgetId === activeWidgetId)
    ? activeWidgetName
    : widgets.find((w) => w.id === widgetId)?.name ?? widgetId;

  try {
    // Resolve the payload BEFORE flagging a save in progress: a missing doc
    // entry yields a null payload, and bailing here must not leave the
    // `saving` guard stuck true (which would wedge auto-save until reload).
    const savePayload = collectWidgetSavePayload(widgetId, widgetName);
    if (!savePayload) return;

    useAutoSaveStore.getState().setSaving(true);
    const saveResponse = await saveWidget(widgetId, savePayload.body);

    // Adopt the server-assigned pairing IDs (first save mints them). The
    // store action ignores saves for non-active widgets, so a late
    // background timer can't clobber the active widget's IDs.
    useWidgetStore.getState().applySavedWidgetInfo(widgetId, saveResponse);

    // Mark clean in docStore for both entries — single source of truth.
    const serialized = JSON.stringify(savePayload.runtimeJson);
    useDocStore.getState().markClean(widgetId, serialized);
    if (companionEntry) {
      useDocStore.getState().markClean(
        companionId,
        JSON.stringify(savePayload.fullscreenJson),
      );
    }

    // Update name baseline so future renames are detected correctly.
    _lastSavedName = widgetName;

    useAutoSaveStore.getState().markSaved();
  } catch (err) {
    console.warn('[AUTO-SAVE] Failed:', err.message);
    useAutoSaveStore.getState().markFailed(err.message);
  }
}

