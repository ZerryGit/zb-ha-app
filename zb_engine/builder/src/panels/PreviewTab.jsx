/**
 * PreviewTab.jsx — Server-rendered image preview (core, platform-agnostic)
 *
 * Shows the latest rendered PNG from the server. Supports per-slot preview:
 * the segmented "Primary | Fullscreen" control selects which slot to render
 * and display. The Fullscreen tab is disabled when the active widget has no
 * companion entry.
 *
 * Refresh button triggers a new render then reloads the image.
 *
 * Uses store-injected handlers:
 *   - previewRenderer(payload, { slot }) → Promise<{ renderTime?: string }>
 *   - previewImageUrlGetter(slot)        → string
 */

import { useState, useCallback, useEffect } from 'react';
import {
  useDocStore,
  selectFocusedCompanionDoc,
  selectFocusedPrimaryDoc,
} from '../store/docStore.js';
import { useUiStore } from '../store/uiStore.js';
import { exportRuntimeJson } from '../models/mapper.js';

export default function PreviewTab() {
  const previewRenderer = useUiStore((s) => s.previewRenderer);
  const previewImageUrlGetter = useUiStore((s) => s.previewImageUrlGetter);
  const lastRenderAt = useUiStore((s) => s.lastRenderAt);
  // Warnings live in uiStore so every refresh path (this tab, TopBar ⟳, etc.)
  // updates the same source of truth. Local state would be wiped by the
  // `lastRenderAt` effect below before the user could read it.
  const renderWarnings = useUiStore((s) => s.lastRenderWarnings);

  // ── Slot selection ────────────────────────────
  const [previewSlot, setPreviewSlot] = useState('primary');
  // The preview tab's "Primary" tab always shows the primary widget,
  // "Fullscreen" always shows the paired companion, even when the
  // companion itself has focus.
  const primaryDoc = useDocStore(selectFocusedPrimaryDoc);
  const companionDoc = useDocStore(selectFocusedCompanionDoc);
  const hasCompanion = Boolean(companionDoc);

  // If the companion disappears while the Fullscreen tab is selected,
  // fall back to Primary so the UI stays consistent.
  useEffect(() => {
    if (previewSlot === 'fullscreen' && !hasCompanion) {
      setPreviewSlot('primary');
    }
  }, [previewSlot, hasCompanion]);

  const activeDoc = previewSlot === 'fullscreen' ? companionDoc : primaryDoc;

  const [imageUrl, setImageUrl] = useState(() =>
    previewImageUrlGetter ? previewImageUrlGetter(previewSlot) : null,
  );
  const [renderTime, setRenderTime] = useState(null);
  const [renderError, setRenderError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Reload image when another component (e.g. TopBar ⟳) triggers a render
  // OR when the user switches the active slot tab.
  // Warnings are NOT cleared here — the new render's `notifyRenderComplete`
  // call has already replaced them in the store.
  useEffect(() => {
    if (previewImageUrlGetter) {
      setImageUrl(previewImageUrlGetter(previewSlot));
      setRenderError(null);
    }
  }, [lastRenderAt, previewImageUrlGetter, previewSlot]);

  const handleRefresh = useCallback(async () => {
    if (!previewRenderer || !previewImageUrlGetter) return;
    if (!activeDoc) return;
    setRefreshing(true);
    setRenderError(null);
    const busyToken = useUiStore.getState().beginBusyTask('Rendering preview…');
    try {
      // For the fullscreen slot, pass the paired primary's sources so the
      // companion preview inherits them (merged in at export time, matching
      // what deploy/save ship). Ignored for the primary slot.
      const payload = exportRuntimeJson(activeDoc, {
        slot: previewSlot,
        primarySources: primaryDoc?.sources,
      });
      const result = await previewRenderer(payload, { slot: previewSlot });

      if (result?.renderTime) setRenderTime(result.renderTime);

      // Use the non-deploy preview blob returned by the renderer. Falling
      // back to the getter keeps older platform handlers functional.
      setImageUrl(result?.imageUrl ?? previewImageUrlGetter(previewSlot));
      useUiStore.getState().notifyRenderComplete(result?.renderWarnings);
    } catch (err) {
      setRenderError(err.message);
    } finally {
      setRefreshing(false);
      useUiStore.getState().endBusyTask(busyToken);
    }
  }, [previewRenderer, previewImageUrlGetter, activeDoc, previewSlot, primaryDoc]);

  if (!previewRenderer) {
    return (
      <div className="panel-body" style={{ padding: '16px' }}>
        <p style={{ color: 'var(--c-fg-muted)' }}>
          Preview is not available (no platform handler configured).
        </p>
      </div>
    );
  }

  return (
    <div className="panel-body" style={{ padding: '16px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '12px',
          gap: '8px',
        }}
      >
        <div className="preview-slot-tabs" role="tablist" style={{ display: 'flex', gap: '4px' }}>
          <button
            type="button"
            role="tab"
            aria-selected={previewSlot === 'primary'}
            className={`btn ${previewSlot === 'primary' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setPreviewSlot('primary')}
          >
            Primary
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={previewSlot === 'fullscreen'}
            className={`btn ${previewSlot === 'fullscreen' ? 'btn-primary' : 'btn-ghost'}`}
            disabled={!hasCompanion}
            title={hasCompanion ? 'Preview fullscreen companion' : 'No fullscreen companion for this widget'}
            onClick={() => setPreviewSlot('fullscreen')}
          >
            Fullscreen
          </button>
        </div>
        <button className="btn btn-primary" onClick={handleRefresh} disabled={refreshing || !activeDoc}>
          {refreshing ? 'Rendering…' : '⟳ Refresh'}
        </button>
      </div>

      {renderError ? (
        <div
          style={{
            padding: '8px',
            color: 'var(--c-danger)',
            background: 'var(--c-bg-danger-subtle)',
            borderRadius: '4px',
          }}
        >
          {renderError}
        </div>
      ) : imageUrl ? (
        <img
          style={{
            maxWidth: '100%',
            border: '1px solid var(--c-line)',
            borderRadius: '4px',
            background: 'var(--c-bg-subtle)',
            boxShadow: 'var(--shadow)',
          }}
          src={imageUrl}
          alt="Widget preview"
          onError={() => setRenderError('Failed to load preview image')}
        />
      ) : (
        <p style={{ color: 'var(--c-fg-muted)' }}>
          Click Refresh to generate a preview.
        </p>
      )}

      {renderTime && (
        <div style={{ marginTop: '8px', fontSize: '0.85em', color: 'var(--c-fg-muted)' }}>
          Render time: {renderTime}ms
        </div>
      )}

      {renderWarnings && renderWarnings.length > 0 && (
        <div
          style={{
            marginTop: '8px',
            padding: '8px',
            background: 'var(--c-bg-warning-subtle, #fff8e1)',
            border: '1px solid var(--c-warning, #f0a500)',
            borderRadius: '4px',
            fontSize: '0.8em',
            color: 'var(--c-warning-text, #7a4f00)',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '4px' }}>
            ⚠ One or more elements were skipped:
          </div>
          {renderWarnings.map((w, i) => (
            <div key={i} style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-word', marginTop: i > 0 ? '4px' : 0 }}>
              {typeof w === 'string' ? w : JSON.stringify(w)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
