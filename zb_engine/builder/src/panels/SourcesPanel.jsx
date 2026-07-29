import { useState, useEffect, useRef } from 'react';
import {
  useDocStore,
  selectSharedSources,
  selectFocusedElements,
  selectFocusedMisc,
  selectFocusedDocId,
  SOURCE_WARN_THRESHOLD,
} from '../store/docStore.js';
import { primaryIdOf } from '../store/companionId.js';
import { useUiStore } from '../store/uiStore.js';
import { useNoticeStore } from '../store/noticeStore.js';
import { normalizeSourceForExport } from '../models/mapper.js';
import { createId } from '../utils/ids.js';
import {
  Field,
  TextInput,
  Dropdown,
  Toggle,
  NumberInput,
  ArrayEditor,
  KeyValueEditor,
} from '../components/InspectorFields.jsx';
import ConfirmModal from '../components/ConfirmModal.jsx';
import { normalizeResponseData } from '../utils/responseData.js';

// Shown once per widget when its source pool grows past SOURCE_WARN_THRESHOLD.
// Advisory only — the add still goes through, and the user can keep going up to
// the hard cap.
const MANY_SOURCES_NOTICE = {
  title: "That's a lot of data sources.",
  message:
    'This widget now has more than 50 data sources. On low-power hardware like a '
    + 'Raspberry Pi, fetching and refreshing this many sources can slow down saves '
    + 'and cause stuttering or delayed screen updates. You can keep adding sources '
    + '(up to 500) — just know performance may suffer.',
  buttonLabel: 'Got it',
};

export default function SourcesPanel() {
  // Primary and companion share ONE source pool, so this list is identical and
  // fully editable on both screens — no more read-only "inherited" rows.
  const sources = useDocStore(selectSharedSources);
  const addSource = useDocStore((s) => s.addSource);
  const updateSource = useDocStore((s) => s.updateSource);
  const removeSource = useDocStore((s) => s.removeSource);
  const addElement = useDocStore((s) => s.addElement);
  const updateElement = useDocStore((s) => s.updateElement);
  const elements = useDocStore(selectFocusedElements);
  const size = useDocStore((s) => selectFocusedMisc(s).size);
  const focusedDocId = useDocStore(selectFocusedDocId);

  const setSelectedSourceId = useUiStore((s) => s.setSelectedSourceId);
  const setSourceResponse = useUiStore((s) => s.setSourceResponse);
  const entityCatalogStore = useUiStore((s) => s.entityCatalogStore);
  const sourceFieldRenderers = useUiStore((s) => s.sourceFieldRenderers);

  const [selectedId, setSelectedId] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // 'list' = source list view, 'typePicker' = choosing source type to add
  const [view, setView] = useState('list');

  const selectedSource = sources.find((s) => s.id === selectedId);
  const hasEntityCatalog = entityCatalogStore != null;

  // Determine the kind of the selected source for rendering the correct edit form.
  const sourceKind = selectedSource?.kind || 'http';

  // ── Sync text element units when entity changes on an haState source ──
  // When the user browses entities in the EntityBrowser, the binding value
  // updates automatically ({{sourceId.state}} resolves to the new entity),
  // but the hardcoded unit suffix stays stale. This effect patches text
  // elements whose text is exactly `{{sourceId.state}}OLD_UNIT` to use
  // the newly selected entity's unit.
  const prevEntityIdRef = useRef(selectedSource?.entity_id);
  useEffect(() => {
    const prevEntityId = prevEntityIdRef.current;
    const curEntityId = selectedSource?.entity_id;
    prevEntityIdRef.current = curEntityId;

    if (!curEntityId || !prevEntityId || curEntityId === prevEntityId) return;
    if (sourceKind !== 'haState' || !entityCatalogStore) return;

    const sourceId = selectedSource.id;
    const oldEntity = entityCatalogStore.getState().getEntityById(prevEntityId);
    const newEntity = entityCatalogStore.getState().getEntityById(curEntityId);
    const oldUnit = oldEntity?.attributes?.unit_of_measurement || '';
    const newUnit = newEntity?.attributes?.unit_of_measurement || '';
    if (oldUnit === newUnit) return;

    // Build the expected old text and new text
    const bindingPrefix = `{{${sourceId}.state}}`;
    const oldText = oldUnit ? `${bindingPrefix}${oldUnit}` : bindingPrefix;
    const newText = newUnit ? `${bindingPrefix}${newUnit}` : bindingPrefix;

    for (const el of elements ?? []) {
      if (el.type === 'text' && el.text === oldText) {
        updateElement(el.id, { text: newText });
      }
    }
  }, [selectedSource?.entity_id, selectedSource?.id, sourceKind, entityCatalogStore, elements, updateElement]);

  // ── Add source by type ──

  // Warn once per widget when an add would push the pool past the threshold.
  // Keyed by PRIMARY doc ID, since a widget and its fullscreen companion share
  // one pool and should share one warning. Never blocks the add.
  const warnIfManySources = () => {
    if (sources.length + 1 <= SOURCE_WARN_THRESHOLD) return;
    const primaryId = primaryIdOf(focusedDocId);
    if (!primaryId) return;
    const ui = useUiStore.getState();
    if (ui.sourceWarnAcknowledged[primaryId]) return;
    ui.acknowledgeSourceWarn(primaryId);
    useNoticeStore.getState().showNotice(MANY_SOURCES_NOTICE);
  };

  const handleAddHttp = () => {
    warnIfManySources();
    const id = createId();
    addSource({
      id,
      name: 'New Source',
      kind: 'http',
      enabled: true,
      method: 'GET',
      url: 'https://api.example.com/data',
      query: {},
      headers: {},
      auth: {},
      body: '',
      timeoutMs: 5000,
      retries: 0,
      responseType: 'json',
    });
    setSelectedId(id);
    setSelectedSourceId(id);
    setView('list');
  };

  const handleAddHaState = () => {
    warnIfManySources();
    const id = createId();
    addSource({
      id,
      name: 'New Entity State',
      kind: 'haState',
      entity_id: '',
      attribute: '',
    });
    setSelectedId(id);
    setSelectedSourceId(id);
    setView('list');
  };

  const handleAddHaHistory = () => {
    warnIfManySources();
    const id = createId();
    addSource({
      id,
      name: 'New Entity History',
      kind: 'haHistory',
      entity_id: '',
      hoursBack: 24,
    });
    setSelectedId(id);
    setSelectedSourceId(id);
    setView('list');
  };

  const handleAdd = () => {
    // If no entity catalog is available, skip the type picker and add HTTP directly
    if (!hasEntityCatalog) {
      handleAddHttp();
      return;
    }
    setView('typePicker');
  };

  // ── Test source (works for all kinds) ──

  const handleTest = async () => {
    if (!selectedSource) return;
    setTesting(true);
    setTestResult(null);
    try {
      const testHandler = useUiStore.getState().sourceTestHandler;
      if (!testHandler) {
        setTestResult({ error: 'Source testing is not available (no platform handler configured).' });
        return;
      }
      const result = await testHandler(normalizeSourceForExport(selectedSource));
      setTestResult(result);

      // Store the response data for the data explorer
      const responseType = selectedSource.responseType || 'json';
      const normalized = normalizeResponseData(responseType, result.data);
      if (normalized != null) {
        setSourceResponse(selectedSource.id, {
          receivedAt: new Date().toISOString(),
          responseType,
          data: normalized,
        });
      }
    } catch (err) {
      setTestResult({ error: err.message });
    } finally {
      setTesting(false);
    }
  };

  if (selectedId && !selectedSource) {
    setSelectedId(null);
  }

  // ── Source Type Picker View ──

  if (view === 'typePicker') {
    return (
      <div className="panel-body" style={{ padding: '16px' }}>
        <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
          <button className="btn" onClick={() => setView('list')}>
            &larr; Back
          </button>
          <div style={{ flex: 1, fontWeight: 'bold', alignSelf: 'center' }}>Add Source</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            className="btn"
            onClick={handleAddHttp}
            style={{
              padding: '12px',
              textAlign: 'left',
              border: '1px solid var(--c-border)',
              borderRadius: 'var(--radius)',
            }}
          >
            <div style={{ fontWeight: 600 }}>HTTP API</div>
            <div style={{ fontSize: 'var(--text-xs)', opacity: 0.6 }}>
              Fetch data from a public URL
            </div>
          </button>

          {hasEntityCatalog && (
            <>
              <button
                className="btn"
                onClick={handleAddHaState}
                style={{
                  padding: '12px',
                  textAlign: 'left',
                  border: '1px solid var(--c-border)',
                  borderRadius: 'var(--radius)',
                }}
              >
                <div style={{ fontWeight: 600 }}>HA Entity State</div>
                <div style={{ fontSize: 'var(--text-xs)', opacity: 0.6 }}>
                  Current value of a Home Assistant entity
                </div>
              </button>

              <button
                className="btn"
                onClick={handleAddHaHistory}
                style={{
                  padding: '12px',
                  textAlign: 'left',
                  border: '1px solid var(--c-border)',
                  borderRadius: 'var(--radius)',
                }}
              >
                <div style={{ fontWeight: 600 }}>HA Entity History</div>
                <div style={{ fontSize: 'var(--text-xs)', opacity: 0.6 }}>
                  Time-series data for graphs and statistics
                </div>
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Edit Source View ──

  if (selectedSource) {
    return (
      <div className="panel-body" style={{ padding: '16px' }}>
        <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
          <button className="btn" onClick={() => setSelectedId(null)}>
            &larr; Back
          </button>
          <div style={{ flex: 1, fontWeight: 'bold', alignSelf: 'center' }}>Edit Source</div>
          <button
            className="btn btn-danger"
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </button>
        </div>

        {confirmDelete && (
          <ConfirmModal
            message="Delete this source? This action cannot be undone."
            onConfirm={() => {
              removeSource(selectedId);
              setSelectedId(null);
              setConfirmDelete(false);
            }}
            onCancel={() => setConfirmDelete(false)}
          />
        )}

        <Field label="Name">
          <TextInput
            value={selectedSource.name}
            onChange={(val) => updateSource(selectedId, { name: val })}
          />
        </Field>

        {/* Kind badge (read-only, informational) */}
        <div
          style={{
            fontSize: 'var(--text-xs)',
            opacity: 0.6,
            marginBottom: '12px',
            fontFamily: 'var(--font-mono)',
          }}
        >
          Kind: {sourceKind}
        </div>

        {/* ── HTTP source fields ── */}
        {(sourceKind === 'http' || !sourceKind) && (
          <HttpSourceFields
            source={selectedSource}
            sourceId={selectedId}
            updateSource={updateSource}
          />
        )}

        {/* ── Platform-injected source field renderers (e.g. haState, haHistory) ── */}
        {sourceKind !== 'http' && sourceKind && (() => {
          const FieldRenderer = sourceFieldRenderers?.[sourceKind];
          if (!FieldRenderer) return null;
          return (
            <FieldRenderer
              source={selectedSource}
              sourceId={selectedId}
              updateSource={updateSource}
              entityCatalogStore={entityCatalogStore}
            />
          );
        })()}

        {/* ── Test button + Add to Canvas ── */}
        <div
          style={{ marginTop: '24px', borderTop: '1px solid var(--c-border)', paddingTop: '16px', display: 'flex', gap: '8px' }}
        >
          <button className="btn btn-primary" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing...' : 'Test Source'}
          </button>
          {/* Add to Canvas: haState → text element, haHistory → graph element, http → hidden (data too varied) */}
          {sourceKind !== 'http' && (
            <button
              className="btn"
              title={sourceKind === 'haState'
                ? 'Add a text element bound to this entity state'
                : 'Add a graph element bound to this source'}
              onClick={() => {
                const w = size?.width ?? 240;
                const h = size?.height ?? 240;
                if (sourceKind === 'haState') {
                  // Auto-detect unit from HA entity metadata for display formatting
                  let unit = '';
                  if (entityCatalogStore && selectedSource.entity_id) {
                    const entity = entityCatalogStore.getState().getEntityById(selectedSource.entity_id);
                    unit = entity?.attributes?.unit_of_measurement || '';
                  }
                  addElement('text', {
                    text: unit
                      ? `{{${selectedSource.id}.state}}${unit}`
                      : `{{${selectedSource.id}.state}}`,
                    fallbackText: '(no data)',
                    pos: { x: w / 2 - 30, y: h / 2 - 15 },
                  });
                } else {
                  // haHistory — graph with pre-matched data paths
                  addElement('graph', {
                    sourceId: selectedSource.id,
                    pos: { x: w / 2 - 140, y: h / 2 - 80 },
                  });
                }
              }}
            >
              Add to Canvas
            </button>
          )}
        </div>

        {testResult && (
          <div
            style={{
              marginTop: '16px',
              background: 'var(--c-bg-subtle, var(--c-bg))',
              padding: '8px',
              borderRadius: '4px',
            }}
          >
            <strong>Result:</strong>
            <pre style={{ fontSize: '0.85em', overflow: 'auto', maxHeight: '200px' }}>
              {JSON.stringify(testResult, null, 2)}
            </pre>
          </div>
        )}
      </div>
    );
  }

  // ── Source List View ──

  return (
    <div className="panel-body" style={{ padding: '16px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '16px',
        }}
      >
        <h3>Sources</h3>
        <button className="btn btn-primary" onClick={handleAdd}>
          + Add
        </button>
      </div>

      <div className="list-group">
        {sources.map((s) => (
          <div
            key={s.id}
            className="list-item"
            onClick={() => {
              setSelectedId(s.id);
              setSelectedSourceId(s.id);
              setTestResult(null);
            }}
            style={{
              padding: '8px',
              border: '1px solid var(--c-border)',
              marginBottom: '8px',
              cursor: 'pointer',
              borderRadius: '4px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div style={{ overflow: 'hidden' }}>
              <div style={{ fontWeight: 'bold' }}>{s.name || 'Unnamed Source'}</div>
              <div
                className="source-subtitle"
                title={sourceSubtitle(s)}
              >
                {sourceSubtitle(s)}
              </div>
            </div>
            <div style={{ fontSize: '1.2em' }}>&rsaquo;</div>
          </div>
        ))}
        {sources.length === 0 && (
          <div style={{ opacity: 0.5, fontStyle: 'italic' }}>No sources defined.</div>
        )}
      </div>
    </div>
  );
}

// ── Subtitle helper for the source list ──

function sourceSubtitle(source) {
  const kind = source.kind || 'http';
  if (kind === 'haState') {
    return `HA State · ${source.entity_id || '(no entity)'}`;
  }
  if (kind === 'haHistory') {
    return `HA History · ${source.entity_id || '(no entity)'} · ${source.hoursBack || 24}h`;
  }
  return `${source.method || 'GET'} ${source.url || ''}`;
}

// ── HTTP Source Edit Fields ──

function HttpSourceFields({ source, sourceId, updateSource }) {
  return (
    <>
      <Field label="Enabled" row>
        <Toggle
          label=""
          value={source.enabled}
          onChange={(val) => updateSource(sourceId, { enabled: val })}
        />
      </Field>

      <Field label="Method">
        <Dropdown
          value={source.method}
          onChange={(val) => updateSource(sourceId, { method: val })}
          options={[
            { value: 'GET', label: 'GET' },
            { value: 'POST', label: 'POST' },
          ]}
        />
      </Field>

      <Field label="URL">
        <TextInput
          value={source.url}
          onChange={(val) => updateSource(sourceId, { url: val })}
          placeholder="https://api.example.com..."
        />
      </Field>

      <Field label="Response Type">
        <Dropdown
          value={source.responseType}
          onChange={(val) => updateSource(sourceId, { responseType: val })}
          options={[
            { value: 'json', label: 'JSON' },
            { value: 'text', label: 'Text' },
            { value: 'xml', label: 'XML' },
            { value: 'csv', label: 'CSV' },
          ]}
        />
      </Field>

      <div className="field-row">
        <Field label="Timeout (ms)" row>
          <NumberInput
            value={source.timeoutMs}
            onChange={(val) => updateSource(sourceId, { timeoutMs: val })}
            min={0}
            step={100}
          />
        </Field>
        <Field label="Retries" row>
          <NumberInput
            value={source.retries}
            onChange={(val) => updateSource(sourceId, { retries: val })}
            min={0}
            max={5}
            step={1}
          />
        </Field>
      </div>

      <Field label="Query Params">
        <KeyValueEditor
          value={source.query}
          onChange={(val) => updateSource(sourceId, { query: val })}
        />
      </Field>

      <Field label="Headers">
        <KeyValueEditor
          value={source.headers}
          onChange={(val) => updateSource(sourceId, { headers: val })}
        />
      </Field>

      <Field label="Auth (Basic/Bearer)">
        <KeyValueEditor
          value={source.auth}
          onChange={(val) => updateSource(sourceId, { auth: val })}
        />
      </Field>

      <Field label="Body Type">
        <Dropdown
          value={source.bodyType || 'none'}
          onChange={(val) => updateSource(sourceId, { bodyType: val })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'json', label: 'JSON' },
            { value: 'form', label: 'Form Data' },
            { value: 'text', label: 'Raw Text' },
          ]}
        />
      </Field>

      {source.bodyType && source.bodyType !== 'none' && (
        <Field label="Body Content">
          <textarea
            className="input"
            rows={5}
            value={source.body || ''}
            onChange={(e) => updateSource(sourceId, { body: e.target.value })}
            placeholder={source.bodyType === 'json' ? '{}' : ''}
            style={{ fontFamily: 'monospace', fontSize: '0.9em' }}
          />
        </Field>
      )}
    </>
  );
}
