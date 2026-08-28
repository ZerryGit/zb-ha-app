import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';

import Tabs from '../components/Tabs.jsx';
import { exportRuntimeJson } from '../models/mapper.js';
import { useDocStore, selectFocusedDoc, selectFocusedDocId, selectFocusedMisc, selectSharedSources, getInheritedPrimarySources, declaresTelemetrySourceId } from '../store/docStore.js';
import { useUiStore } from '../store/uiStore.js';
import { isFullscreenId } from '../store/companionId.js';

import FeaturesPanel from './FeaturesPanel.jsx';
import SourcesPanel from './SourcesPanel.jsx';
import DataExplorerPanel from './DataExplorerPanel.jsx';
import PreviewTab from './PreviewTab.jsx';
import SettingsPanel from './SettingsPanel.jsx';

const MonacoEditor = lazy(() => import('@monaco-editor/react').then((mod) => {
  // Configure Monaco to serve from the locally copied AMD build instead of the
  // default CDN. Keeping this inside the lazy import preserves HA offline
  // operation without pulling Monaco into the initial Builder bundle.
  mod.loader.config({ paths: { vs: './monaco-editor/min/vs' } });
  return { default: mod.default };
}));

function JsonEditorFallback() {
  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--c-text-muted)',
        fontSize: '12px',
      }}
    >
      Loading JSON editor…
    </div>
  );
}

function JsonEditor(props) {
  return (
    <Suspense fallback={<JsonEditorFallback />}>
      <MonacoEditor {...props} />
    </Suspense>
  );
}

export default function LeftPanel() {
  const leftPanelTab = useUiStore((s) => s.leftPanelTab);
  const setLeftPanelTab = useUiStore((s) => s.setLeftPanelTab);
  const jsonFullscreen = useUiStore((s) => s.jsonFullscreen);
  const setJsonFullscreen = useUiStore((s) => s.setJsonFullscreen);

  const doc = useDocStore(selectFocusedDoc);
  const focusedDocId = useDocStore(selectFocusedDocId);
  const exportSlot = isFullscreenId(focusedDocId) ? 'fullscreen' : 'primary';
  // Sources are a shared pool anchored on the primary. Subscribe so the JSON tab
  // re-renders the merged sources when the pool changes from any screen.
  const sharedSources = useDocStore(selectSharedSources);
  const misc = useDocStore(selectFocusedMisc);
  const updateMisc = useDocStore((s) => s.updateMisc);
  const replaceDocFromJson = useDocStore((s) => s.replaceDocFromJson);

  const tabs = ['Widget', 'Sources', 'Data', 'Features', 'Preview', 'Settings', 'JSON'];

  const gridSizeOptions = useMemo(
    () => ['1x1', '1x2', '2x1', '2x2', '3x2'],
    [],
  );

  const [tagsDraft, setTagsDraft] = useState(null);
  const tagsDisplay = tagsDraft ?? (Array.isArray(misc?.tags) ? misc.tags.join(', ') : '');

  const sizeText = `${misc?.size?.width ?? 0} × ${misc?.size?.height ?? 0}`;

  const exportedMiscText = useMemo(() => {
    try {
      const exported = exportRuntimeJson(doc, { slot: exportSlot });
      return JSON.stringify(exported.misc, null, 2);
    } catch {
      return '';
    }
  }, [doc, exportSlot]);

  // The editable JSON shows — and writes back — the SHARED source pool. For a
  // companion, primarySources folds the pool in so the displayed sources match
  // the canvas / SourcesPanel; replaceDocFromJson then routes any edited sources
  // back onto the primary. A primary export ignores primarySources, so this is a
  // no-op there (its own doc.sources already IS the pool).
  const exportedJsonText = useMemo(() => {
    try {
      const exported = exportRuntimeJson(doc, {
        slot: exportSlot,
        primarySources: exportSlot === 'fullscreen' ? sharedSources : undefined,
      });
      return JSON.stringify(exported, null, 2);
    } catch (err) {
      console.error('Export failed', err);
      return '{}';
    }
  }, [doc, exportSlot, sharedSources]);

  const payloadExpander = useUiStore((s) => s.payloadExpander);
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState(null);
  const isSyncingFromJson = useRef(false);
  const debounceTimer = useRef(null);

  // Draw JSON mode: shows the fully expanded payload (read-only)
  const [showDrawJson, setShowDrawJson] = useState(false);
  const [drawJsonText, setDrawJsonText] = useState('');
  const [drawJsonLoading, setDrawJsonLoading] = useState(false);
  const [drawJsonError, setDrawJsonError] = useState(null);

  useEffect(() => {
    if (isSyncingFromJson.current) {
      isSyncingFromJson.current = false;
      return;
    }
    // Intentional: syncing derived prop → local state for controlled editor
    setJsonText(exportedJsonText);
    setError(null);
  }, [exportedJsonText]);

  const fetchDrawJson = async () => {
    if (!payloadExpander) {
      setDrawJsonError('Expand not available (no platform handler).');
      return;
    }
    setDrawJsonLoading(true);
    setDrawJsonError(null);
    try {
      // Read-only "what gets drawn" view: merge the shared pool so it faithfully
      // mirrors the deployed companion render (no-op for primary).
      const payload = exportRuntimeJson(doc, {
        slot: exportSlot,
        primarySources: getInheritedPrimarySources(focusedDocId),
      });
      const expanded = await payloadExpander(payload);
      setDrawJsonText(JSON.stringify(expanded, null, 2));
    } catch (err) {
      setDrawJsonError(err.message || 'Expand failed');
    } finally {
      setDrawJsonLoading(false);
    }
  };

  const handleToggleDrawJson = () => {
    const next = !showDrawJson;
    setShowDrawJson(next);
    if (next) fetchDrawJson();
  };

  const handleJsonChange = (value) => {
    setJsonText(value);

    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    debounceTimer.current = setTimeout(() => {
      try {
        const parsed = JSON.parse(value);

        if (
          parsed != null &&
          typeof parsed === 'object' &&
          parsed.misc?.size?.width > 0 &&
          parsed.misc?.size?.height > 0 &&
          Array.isArray(parsed.elements) &&
          Array.isArray(parsed.sources)
        ) {
          // `device` is the panel-telemetry namespace (plan 4, D6). Surfaced
          // inline rather than through a notice modal: this runs on a debounce
          // after every pause in typing, and a modal would re-open on each one.
          // Only an edit that INTRODUCES the id is refused — a widget that
          // already has a `device` source stays fully editable (shadow rule),
          // which is why the baseline is the shared pool, not `parsed.sources`.
          if (
            declaresTelemetrySourceId(parsed.sources)
            && !declaresTelemetrySourceId(sharedSources)
          ) {
            setError('"device" is reserved for panel telemetry — rename this source.');
            return;
          }
          setError(null);
          isSyncingFromJson.current = true;
          replaceDocFromJson(parsed);
        } else {
          setError('Validation error: missing required fields (misc.size, elements, sources)');
        }
      } catch (e) {
        setError(`JSON Error: ${e.message}`);
      }
    }, 600);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && jsonFullscreen) {
        setJsonFullscreen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [jsonFullscreen, setJsonFullscreen]);

  function renderWidgetTab() {
    return (
      <div className="panel-body">
        <div className="field-stack">
          <label className="field">
            <span className="field-label">Name</span>
            <input
              className="input"
              value={misc?.name ?? ''}
              onChange={(e) => updateMisc({ name: e.target.value })}
              placeholder="Widget name"
            />
          </label>

          <label className="field">
            <span className="field-label">Type</span>
            <input
              className="input"
              value={misc?.type ?? ''}
              onChange={(e) => updateMisc({ type: e.target.value })}
              placeholder="Type"
            />
          </label>

          <label className="field">
            <span className="field-label">Subcategory</span>
            <input
              className="input"
              value={misc?.subcategory ?? ''}
              onChange={(e) => updateMisc({ subcategory: e.target.value })}
              placeholder="Subcategory"
            />
          </label>

          <label className="field">
            <span className="field-label">Tags</span>
            <input
              className="input"
              value={tagsDisplay}
              onChange={(e) => setTagsDraft(e.target.value)}
              onBlur={() => {
                const nextTags = tagsDisplay
                  .split(',')
                  .map((t) => t.trim())
                  .filter(Boolean);
                updateMisc({ tags: nextTags });
                setTagsDraft(null);
              }}
              placeholder="tag1, tag2"
            />
          </label>

          <label className="field">
            <span className="field-label">Grid Size</span>
            <select
              className="select"
              value={misc?.gridSize ?? '1x1'}
              onChange={(e) => updateMisc({ gridSize: e.target.value })}
            >
              {gridSizeOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span className="field-label">Derived Size</span>
            <input className="input input-readonly" value={sizeText} readOnly />
          </div>

          <div className="field">
            <span className="field-label">Exported misc (preview)</span>
            <textarea className="textarea" readOnly value={exportedMiscText} rows={8} />
          </div>
        </div>
      </div>
    );
  }

  function renderBody() {
    if (leftPanelTab === 'Widget') return renderWidgetTab();
    if (leftPanelTab === 'JSON') {
      return (
        <div
          className="panel-body"
          style={{
            padding: 0,
            height: '100%',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: '8px',
              borderBottom: '1px solid var(--c-border)',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '6px',
            }}
          >
            <button
              className={`btn${showDrawJson ? ' btn-primary' : ''}`}
              onClick={handleToggleDrawJson}
              disabled={drawJsonLoading}
              title="Show the fully expanded JSON sent to the draw function"
            >
              {drawJsonLoading ? 'Loading…' : showDrawJson ? 'Draw JSON ✓' : 'Draw JSON'}
            </button>
            {showDrawJson && (
              <button
                className="btn"
                onClick={fetchDrawJson}
                disabled={drawJsonLoading}
                title="Refresh the expanded draw JSON"
              >
                ⟳
              </button>
            )}
            <button className="btn" onClick={() => setJsonFullscreen(true)}>
              Fullscreen
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0 }}>
            {showDrawJson ? (
              <JsonEditor
                key="draw-json"
                height="100%"
                defaultLanguage="json"
                value={drawJsonText}
                options={{
                  readOnly: true,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  wordWrap: 'on',
                }}
              />
            ) : (
              <JsonEditor
                key="edit-json"
                height="100%"
                defaultLanguage="json"
                value={jsonText}
                onChange={handleJsonChange}
                options={{
                  readOnly: false,
                  minimap: { enabled: false },
                  scrollBeyondLastLine: false,
                  fontSize: 12,
                  wordWrap: 'on',
                }}
              />
            )}
          </div>
          {(showDrawJson ? drawJsonError : error) && (
            <div
              style={{
                padding: '8px',
                color: 'var(--c-danger)',
                borderTop: '1px solid var(--c-border)',
                fontSize: '0.85em',
                background: 'var(--c-bg-danger-subtle)',
              }}
            >
              {showDrawJson ? drawJsonError : error}
            </div>
          )}
        </div>
      );
    }
    if (leftPanelTab === 'Features') {
      return <FeaturesPanel />;
    }
    if (leftPanelTab === 'Data') {
      return <DataExplorerPanel />;
    }
    if (leftPanelTab === 'Sources') {
      return <SourcesPanel />;
    }
    if (leftPanelTab === 'Preview') {
      return <PreviewTab />;
    }
    if (leftPanelTab === 'Settings') {
      return <SettingsPanel />;
    }
    return <div className="placeholder">{leftPanelTab} — coming soon</div>;
  }

  // Monaco Editor requires a fixed-height parent (overflow: hidden, display: flex).
  // When any tab uses an editor, switch the panel to fixed layout mode.
  const useFixedLayout = leftPanelTab === 'JSON';

  return (
    <aside className={`panel panel-left${useFixedLayout ? ' panel--fixed' : ''}`}>
      <div className="panel-brand">
        Widget Builder<span className="panel-beta-badge">BETA</span>
      </div>
      <div className="panel-header">
        <Tabs tabs={tabs} activeTab={leftPanelTab} onTabChange={setLeftPanelTab} />
      </div>
      {renderBody()}

      {jsonFullscreen && (
        <div className="modal-overlay" onClick={() => setJsonFullscreen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span className="modal-title">
                {showDrawJson ? 'Draw JSON (read-only)' : 'JSON Export'}
              </span>
              <button className="btn" onClick={() => setJsonFullscreen(false)}>
                Close
              </button>
            </div>
            <div className="modal-body">
              {showDrawJson ? (
                <JsonEditor
                  key="fs-draw-json"
                  height="100%"
                  defaultLanguage="json"
                  value={drawJsonText}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 14,
                    wordWrap: 'on',
                  }}
                />
              ) : (
                <JsonEditor
                  key="fs-edit-json"
                  height="100%"
                  defaultLanguage="json"
                  value={jsonText}
                  onChange={handleJsonChange}
                  options={{
                    readOnly: false,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 14,
                    wordWrap: 'on',
                  }}
                />
              )}
              {(showDrawJson ? drawJsonError : error) && (
                <div
                  style={{
                    padding: '12px',
                    color: 'var(--c-danger)',
                    borderTop: '1px solid var(--c-border)',
                    background: 'var(--c-bg-danger-subtle)',
                  }}
                >
                  {showDrawJson ? drawJsonError : error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
