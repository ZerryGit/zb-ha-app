/**
 * TopBar.jsx — Main navigation/action bar
 *
 * Sits above the 3-panel editor layout.
 * Widget dropdown, name editor, Save / Deploy / Preview buttons.
 */

import { useState, useEffect, useCallback } from 'react';
import { useWidgetStore } from './widgetStore.js';
import { useUiStore } from '../store/uiStore.js';
import { useAutoSaveStore } from './autoSaveStore.js';
import { useAutoSave } from './useAutoSave.js';
import { renderFocusedPreview } from '../utils/renderPreview.js';
import { formatTimeAgo } from '../utils/timeAgo.js';
import * as api from './apiClient.js';
import { deployActiveWidget } from './deploy.js';
import ConfirmModal from '../components/ConfirmModal.jsx';

// Default ESP32 image host port (config.yaml maps container 8000/tcp -> 8000).
// Used when the Supervisor-reported host-port mapping is unavailable.
const DEFAULT_IMAGE_HOST_PORT = 8000;

export default function TopBar() {
  const {
    widgets,
    activeWidgetId,
    activeWidgetName,
    loading,
    saving,
    error,
    fetchWidgets,
    openWidget,
    saveCurrentWidget,
    createNewWidget,
    deleteWidget,
    setActiveWidgetName,
    clearError,
  } = useWidgetStore();

  const autoSaveEnabled = useAutoSaveStore((s) => s.enabled);
  const autoSaveLastSaved = useAutoSaveStore((s) => s.lastSavedAt);
  const autoSaveError = useAutoSaveStore((s) => s.lastError);
  const autoSaveToggle = useAutoSaveStore((s) => s.toggle);

  // Resolved HA host LAN IP + image host port — shown as an always-visible
  // "http://<ip>:<port>" device-endpoint readout.
  const hostIp = useUiStore((s) => s.hostIp);
  const hostPort = useUiStore((s) => s.hostPort);

  // Activate auto-save subscription (debounced docStore listener).
  useAutoSave();

  const [deploying, setDeploying] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [, setTick] = useState(0);

  // Fetch widget list on mount
  useEffect(() => {
    fetchWidgets();
  }, [fetchWidgets]);

  // Re-render every 30s to keep "Xm ago" label current.
  useEffect(() => {
    if (!autoSaveEnabled || !autoSaveLastSaved) return;
    const id = setInterval(() => setTick((t) => t + 1), 30000);
    return () => clearInterval(id);
  }, [autoSaveEnabled, autoSaveLastSaved]);

  // Auto-dismiss error after 5 seconds
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(clearError, 5000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  const handleDeploy = useCallback(async () => {
    setDeploying(true);
    // Deploy renders both slots server-side, so it waits on the same remote
    // asset fetches the preview does — show the centered spinner rather than
    // leave a disabled button as the only sign of life.
    const busyToken = useUiStore.getState().beginBusyTask('Deploying…');
    try {
      const { activeWidgetId } = useWidgetStore.getState();
      const results = await deployActiveWidget(activeWidgetId);
      // Surface the first per-slot failure (if any) so the user sees it
      // even when other slots succeeded.
      const failure = results.find((r) => !r.ok);
      if (failure) {
        useWidgetStore.setState({
          error: `Deploy failed (${failure.slot}): ${failure.error}`,
        });
      }
    } catch (err) {
      useWidgetStore.setState({ error: err.message });
    } finally {
      setDeploying(false);
      useUiStore.getState().endBusyTask(busyToken);
    }
  }, []);

  const handlePreviewRefresh = useCallback(async () => {
    const busyToken = useUiStore.getState().beginBusyTask('Rendering preview…');
    try {
      // Renders the slot the user is currently editing so the cached image
      // for that slot (image.png vs image_fullscreen.png) is refreshed, and
      // publishes any per-element warnings to the store for PreviewTab.
      await renderFocusedPreview();
    } catch (err) {
      useWidgetStore.setState({ error: err.message });
    } finally {
      useUiStore.getState().endBusyTask(busyToken);
    }
  }, []);

  const handleWidgetSelect = useCallback(
    (id) => {
      setDropdownOpen(false);
      if (id !== activeWidgetId) {
        openWidget(id);
      }
    },
    [activeWidgetId, openWidget],
  );

  const handleNewWidget = useCallback(() => {
    setDropdownOpen(false);
    createNewWidget({ resetDoc: true });
  }, [createNewWidget]);

  const handleDeleteConfirm = useCallback(() => {
    if (confirmDelete) {
      deleteWidget(confirmDelete);
      setConfirmDelete(null);
    }
  }, [confirmDelete, deleteWidget]);

  const busy = loading || saving || deploying;

  return (
    <div className="topbar">
      {/* Widget selector */}
      <div className="topbar-widget-selector">
        <button
          className="topbar-dropdown-btn"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          disabled={busy}
        >
          {activeWidgetName || 'No widget selected'} ▾
        </button>

        {dropdownOpen && (
          <div className="topbar-dropdown">
            {widgets.map((w) => (
              <div
                key={w.id}
                className={`topbar-dropdown-item${w.id === activeWidgetId ? ' active' : ''}`}
              >
                <button className="topbar-dropdown-item-btn" onClick={() => handleWidgetSelect(w.id)}>
                  {w.name || w.id}
                </button>
                <button
                  className="topbar-dropdown-delete-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmDelete(w.id);
                    setDropdownOpen(false);
                  }}
                  title="Delete widget"
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="topbar-dropdown-item-btn topbar-new-btn" onClick={handleNewWidget}>
              + New Widget
            </button>
          </div>
        )}
      </div>

      {/* Widget name editor */}
      {activeWidgetId && (
        <input
          className="topbar-name-input"
          value={activeWidgetName}
          onChange={(e) => setActiveWidgetName(e.target.value)}
          placeholder="Widget name"
          disabled={busy}
        />
      )}

      {/* Device image endpoint — always visible once the HA IP resolves */}
      {hostIp && (
        <span className="topbar-endpoint" title="ESP32 image endpoint">
          http://{hostIp}:{hostPort || DEFAULT_IMAGE_HOST_PORT}
        </span>
      )}

      {/* Action buttons */}
      <div className="topbar-actions">
        {/* Auto-save timestamp or error */}
        {autoSaveEnabled && autoSaveError && (
          <span
            className="topbar-autosave-time"
            style={{ color: '#fff', textDecoration: 'underline', cursor: 'pointer' }}
            title={`Auto-save failed: ${autoSaveError}`}
            onClick={() => useAutoSaveStore.getState().clearError()}
          >
            save failed
          </span>
        )}
        {autoSaveEnabled && !autoSaveError && autoSaveLastSaved && (
          <span className="topbar-autosave-time">
            {formatTimeAgo(autoSaveLastSaved)}
          </span>
        )}

        {/* Auto-save toggle */}
        <label className="topbar-autosave-toggle" title="Toggle auto-save">
          <input
            type="checkbox"
            checked={autoSaveEnabled}
            onChange={autoSaveToggle}
          />
          <span className="topbar-autosave-slider" />
          <span className="topbar-autosave-label">Auto</span>
        </label>

        <button
          className="topbar-btn"
          onClick={saveCurrentWidget}
          disabled={busy || !activeWidgetId}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          className="topbar-btn topbar-btn-accent"
          onClick={handleDeploy}
          disabled={busy || !activeWidgetId}
        >
          {deploying ? 'Deploying…' : 'Deploy'}
        </button>
        <button
          className="topbar-btn"
          onClick={handlePreviewRefresh}
          disabled={busy}
          title="Refresh preview"
        >
          ⟳
        </button>
      </div>

      {/* Status */}
      {error && <span className="topbar-error">{error}</span>}

      {/* Confirm delete modal */}
      {confirmDelete && (
        <ConfirmModal
          message="Delete this widget? This cannot be undone."
          onConfirm={handleDeleteConfirm}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
