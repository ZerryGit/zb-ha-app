import PropTypes from 'prop-types';
import { useMemo, useRef, useState } from 'react';
import { useDocStore, selectFocusedElements } from '../store/docStore.js';
import { useUiStore } from '../store/uiStore.js';
import {
  ArrayEditor,
  Dropdown,
  Field,
  NumberInput,
  PointsEditor,
  Slider,
  TextInput,
  Toggle,
} from '../components/InspectorFields.jsx';
import ValueEditor from '../components/ValueEditor.jsx';
import TablerIcon from '../components/TablerIcon.jsx';
import BindingExpressionEditor from '../components/BindingExpressionEditor.jsx';
import { isBinding, isExpression, composePipeSyntax, buildPipeExpression } from '@zb/expressions';
import GraphInspectorPanel from './GraphInspectorPanel.jsx';
import IconPickerModal from '../components/IconPickerModal.jsx';
import { toSvgString, parseIconRef } from '../utils/iconRegistry.js';
import {
  FONT_FAMILIES,
  getSizesForFamily,
  getWeightsForFamilySize,
} from '../utils/fontCatalog.js';
import { isFramedTextFlow } from '@shared/textLayout';

function CommonFields({ element, updateElement }) {
  const isLine = element.type === 'line';
  const isText = element.type === 'text';
  const isFixedText = isText && element.textFlow === 'fixed';
  const isLocked = useUiStore((s) => !!s.lockedElementIds[element.id]);
  const toggleLock = useUiStore((s) => s.toggleElementLock);

  // Typing a size into a text element authors that dimension, which only
  // holds if the element is framed — otherwise the auto-size hook clobbers
  // the typed value on its next pass. An auto element converts to the
  // default framed mode ('clip', box locked), keeping its hugged sizes as
  // the box. Both writes go in ONE updateElement call: one undo entry, and
  // no window where the hook sees an auto element with a hand-typed size.
  const sizePatch = (patch) => {
    if (!isText) return updateElement(element.id, patch);
    const full = { ...patch };
    if (!isFramedTextFlow(element.textFlow)) full.textFlow = 'clip';
    return updateElement(element.id, full);
  };

  return (
    <div className="field-stack">
      <Field label="Name">
        <ValueEditor
          value={element.name}
          onChange={(val) => updateElement(element.id, { name: val })}
          renderInput={(val, onChange) => <TextInput value={val} onChange={onChange} />}
        />
      </Field>

      <div className="field-row">
        <Field>
          <ValueEditor
            value={element.visible}
            onChange={(val) => updateElement(element.id, { visible: val })}
            clearValue={true}
            disableLiteralEditWhenBound
            bindButtonTitle="Bind visibility to data"
            boundHelpText="Visible when expression resolves to true"
            renderInput={(val, onChange, meta) => (
              <Toggle
                label="Visible"
                value={val}
                onChange={onChange}
                disabled={meta?.inputDisabled}
                onDisabledClick={meta?.onBoundInputAttempt}
                title={meta?.inputTitle}
              />
            )}
          />
        </Field>
        <Field>
          <Toggle label="Locked" value={isLocked} onChange={() => toggleLock(element.id)} />
        </Field>
      </div>

      <div className="field-row">
        <Field label="X" row>
          <ValueEditor
            value={element.pos?.x}
            onChange={(val) => updateElement(element.id, { pos: { x: val } })}
            renderInput={(val, onChange) => <NumberInput value={val} onChange={onChange} />}
          />
        </Field>
        <Field label="Y" row>
          <ValueEditor
            value={element.pos?.y}
            onChange={(val) => updateElement(element.id, { pos: { y: val } })}
            renderInput={(val, onChange) => <NumberInput value={val} onChange={onChange} />}
          />
        </Field>
      </div>

      <div className="field-row">
        <Field label="Rotation" row>
          <ValueEditor
            value={element.rotationDeg}
            onChange={(val) => updateElement(element.id, { rotationDeg: val })}
            renderInput={(val, onChange) => <NumberInput value={val} onChange={onChange} />}
          />
        </Field>
      </div>

      <Field label="Opacity (0-100)">
        <ValueEditor
          value={element.opacity}
          onChange={(val) => updateElement(element.id, { opacity: val })}
          renderInput={(val, onChange) => (
            <Slider value={val ?? 100} onChange={onChange} min={0} max={100} />
          )}
        />
      </Field>

      {!isLine && (
        <div className="field-row">
          <Field label="Width" row>
            <ValueEditor
              value={element.sizeX}
              onChange={(val) => sizePatch({ sizeX: val })}
              renderInput={(val, onChange) => (
                <NumberInput value={val} onChange={onChange} min={0} />
              )}
            />
          </Field>
          {/* On a fixed text frame the vertical size is a floor, not a
              height — content past it grows the box downward. */}
          <Field label={isFixedText ? 'Min height' : 'Height'} row>
            <ValueEditor
              value={element.sizeY}
              onChange={(val) => sizePatch({ sizeY: val })}
              renderInput={(val, onChange) => (
                <NumberInput value={val} onChange={onChange} min={0} />
              )}
            />
          </Field>
        </div>
      )}
    </div>
  );
}

function FillPanel({ element, updateElement }) {
  return (
    <div className="field-group">
      <div className="field-group-header">
        <ValueEditor
          value={element.enableFill}
          onChange={(val) => updateElement(element.id, { enableFill: val })}
          renderInput={(val, onChange) => <Toggle label="Fill" value={val} onChange={onChange} />}
        />
      </div>
      {element.enableFill && (
        <Field label="Intensity (0-100)">
          <ValueEditor
            value={element.fill}
            onChange={(val) => updateElement(element.id, { fill: val })}
            renderInput={(val, onChange) => (
              <Slider value={val} onChange={onChange} min={0} max={100} />
            )}
          />
        </Field>
      )}
    </div>
  );
}

function StrokePanel({ element, updateElement }) {
  return (
    <div className="field-group">
      <div className="field-group-header">
        <ValueEditor
          value={element.enableStroke}
          onChange={(val) => updateElement(element.id, { enableStroke: val })}
          renderInput={(val, onChange) => <Toggle label="Stroke" value={val} onChange={onChange} />}
        />
      </div>
      {element.enableStroke && (
        <>
          <Field label="Intensity (0-100)">
            <ValueEditor
              value={element.strokeDither}
              onChange={(val) => updateElement(element.id, { strokeDither: val })}
              renderInput={(val, onChange) => (
                <Slider value={val} onChange={onChange} min={0} max={100} />
              )}
            />
          </Field>
          <div className="field-row">
            <Field label="Width" row>
              <ValueEditor
                value={element.strokeWidth}
                onChange={(val) => updateElement(element.id, { strokeWidth: val })}
                renderInput={(val, onChange) => (
                  <NumberInput value={val} onChange={onChange} min={0} />
                )}
              />
            </Field>
            <Field label="Cap" row>
              <ValueEditor
                value={element.strokeCap}
                onChange={(val) => updateElement(element.id, { strokeCap: val })}
                renderInput={(val, onChange) => (
                  <Dropdown
                    value={val}
                    onChange={onChange}
                    options={[
                      { value: 'butt', label: 'Butt' },
                      { value: 'round', label: 'Round' },
                    ]}
                  />
                )}
              />
            </Field>
          </div>
          {['rect', 'circle', 'svg'].includes(element.type) && (
            <Field label="Position">
              <ValueEditor
                value={element.strokePosition}
                onChange={(val) => updateElement(element.id, { strokePosition: val })}
                renderInput={(val, onChange) => (
                  <Dropdown
                    value={val ?? 'center'}
                    onChange={onChange}
                    options={[
                      { value: 'inside', label: 'Inside' },
                      { value: 'center', label: 'Center' },
                      { value: 'outside', label: 'Outside' },
                    ]}
                  />
                )}
              />
            </Field>
          )}
          <Field label="Dash Pattern">
            <ValueEditor
              value={element.strokeDash}
              onChange={(val) => updateElement(element.id, { strokeDash: val })}
              renderInput={(val, onChange) => <ArrayEditor value={val} onChange={onChange} />}
            />
          </Field>
        </>
      )}
    </div>
  );
}

/** Rect-only geometry: corner radius (engine reads strokeRadius). */
function RectGeometryPanel({ element, updateElement }) {
  return (
    <div className="field-group">
      <div className="field-group-header">Geometry</div>
      <Field label="Corner radius">
        <ValueEditor
          value={element.strokeRadius}
          onChange={(val) => updateElement(element.id, { strokeRadius: val })}
          renderInput={(val, onChange) => (
            <NumberInput value={val ?? 0} onChange={onChange} min={0} />
          )}
        />
      </Field>
    </div>
  );
}

/** Circle-only geometry: donut inner size + arc sweep (pie/wedge/gauge). */
function CircleGeometryPanel({ element, updateElement }) {
  return (
    <div className="field-group">
      <div className="field-group-header">Geometry</div>
      <Field label="Inner size (donut %)">
        <ValueEditor
          value={element.innerSize}
          onChange={(val) => updateElement(element.id, { innerSize: val })}
          renderInput={(val, onChange) => (
            <Slider
              value={Math.round((Number(val) || 0) * 100)}
              onChange={(v) => onChange(v / 100)}
              min={0}
              max={100}
            />
          )}
        />
      </Field>
      <div className="field-row">
        <Field label="Arc start°" row>
          <ValueEditor
            value={element.arcStartDeg}
            onChange={(val) => updateElement(element.id, { arcStartDeg: val })}
            renderInput={(val, onChange) => (
              <NumberInput value={val ?? 0} onChange={onChange} min={0} max={360} />
            )}
          />
        </Field>
        <Field label="Arc end°" row>
          <ValueEditor
            value={element.arcEndDeg}
            onChange={(val) => updateElement(element.id, { arcEndDeg: val })}
            renderInput={(val, onChange) => (
              <NumberInput value={val ?? 0} onChange={onChange} min={0} max={360} />
            )}
          />
        </Field>
      </div>
    </div>
  );
}

// Symbols available in the Sora bitmap font, curated for dashboard use.
const SYMBOL_SHORTCUTS = [
  ['°C', '°C'],
  ['°F', '°F'],
  ['°', '°'],
  ['²', '²'],
  ['³', '³'],
  ['µ', 'µ'],
  ['±', '±'],
];

function TextPanel({ element, updateElement }) {
  const textareaRef = useRef(null);
  const [showBindingEditor, setShowBindingEditor] = useState(false);
  const [editingTokenIndex, setEditingTokenIndex] = useState(null);

  // Migrate: if the current text value is a binding/expression object,
  // convert it to template syntax so the textarea becomes editable.
  const rawText = (() => {
    const val = element.text;
    if (isBinding(val)) return `{{${val.$}}}`;
    if (isExpression(val)) {
      const pipe = composePipeSyntax(val);
      return pipe ? `{{${pipe}}}` : '';
    }
    return val ?? '';
  })();

  // Parse all {{...}} tokens from the text for the per-binding sections
  const bindingTokens = useMemo(() => {
    const tokens = [];
    const regex = /\{\{([^}]+)\}\}/g;
    let m;
    while ((m = regex.exec(rawText)) !== null) {
      tokens.push({ full: m[0], content: m[1].trim(), index: m.index });
    }
    return tokens;
  }, [rawText]);

  /** Insert text at the textarea cursor position. */
  const insertAtCursor = (chars) => {
    const ta = textareaRef.current;
    const pos = ta?.selectionStart ?? rawText.length;
    const newText = rawText.slice(0, pos) + chars + rawText.slice(pos);
    updateElement(element.id, { text: newText });
    const newPos = pos + chars.length;
    requestAnimationFrame(() => {
      if (ta) {
        ta.selectionStart = newPos;
        ta.selectionEnd = newPos;
        ta.focus();
      }
    });
  };

  /** Replace the Nth {{...}} token in the text. */
  const replaceToken = (tokenIdx, newPipe) => {
    let count = 0;
    const newText = rawText.replace(/\{\{[^}]+\}\}/g, (match) => {
      if (count === tokenIdx) { count++; return `{{${newPipe}}}`; }
      count++;
      return match;
    });
    updateElement(element.id, { text: newText });
  };

  /** Remove the Nth {{...}} token from the text. */
  const removeToken = (tokenIdx) => {
    let count = 0;
    const newText = rawText.replace(/\{\{[^}]+\}\}/g, (match) => {
      if (count === tokenIdx) { count++; return ''; }
      count++;
      return match;
    });
    updateElement(element.id, { text: newText });
  };

  /** Handle binding save — compose pipe syntax and insert/replace. */
  const handleSaveBinding = (expr) => {
    if (expr === null) {
      setShowBindingEditor(false);
      setEditingTokenIndex(null);
      return;
    }
    const pipe = composePipeSyntax(expr);
    if (!pipe) {
      setShowBindingEditor(false);
      setEditingTokenIndex(null);
      return;
    }
    if (editingTokenIndex !== null) {
      replaceToken(editingTokenIndex, pipe);
    } else {
      insertAtCursor(`{{${pipe}}}`);
    }
    setShowBindingEditor(false);
    setEditingTokenIndex(null);
  };

  /** Open editor for an existing binding token. */
  const handleEditToken = (tokenIdx) => {
    setEditingTokenIndex(tokenIdx);
    setShowBindingEditor(true);
  };

  /** Open editor for a new binding (insert mode). */
  const handleAddBinding = () => {
    setEditingTokenIndex(null);
    setShowBindingEditor(true);
  };

  // Build the expression value to pass to BindingExpressionEditor when editing
  const editingValue = useMemo(() => {
    if (editingTokenIndex === null || !bindingTokens[editingTokenIndex]) return null;
    const content = bindingTokens[editingTokenIndex].content;
    return content.includes('|') ? buildPipeExpression(content) : { $: content };
  }, [editingTokenIndex, bindingTokens]);

  const hasBindings = bindingTokens.length > 0;

  return (
    <div className="field-group">
      <div className="field-group-header">Typography</div>
      <Field label="Content">
        <div style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', gap: '4px', alignItems: 'flex-start', width: '100%' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <textarea
                ref={textareaRef}
                className="input"
                rows={3}
                value={rawText}
                onChange={(e) => updateElement(element.id, { text: e.target.value })}
              />
            </div>
            {/* Bind-to-data button — opens BindingExpressionEditor,
                inserts result as a {{path|op:arg}} template token. */}
            <button
              className="btn"
              onClick={handleAddBinding}
              title={hasBindings ? 'Insert another data binding' : 'Bind to data or expression'}
              style={{
                padding: '4px 8px',
                fontSize: '11px',
                minWidth: 'auto',
                background: 'transparent',
                color: hasBindings ? 'var(--c-accent)' : 'var(--c-text-muted)',
                border: '1px solid var(--c-border)',
              }}
            >
              {hasBindings ? <TablerIcon name="bolt" size={14} /> : <TablerIcon name="chart-bar-popular" size={14} />}
            </button>
          </div>
          {/* Symbol shortcuts */}
          <div style={{ display: 'flex', gap: '4px', marginTop: '4px', flexWrap: 'wrap', alignItems: 'center' }}>
            {SYMBOL_SHORTCUTS.map(([label, chars]) => (
              <button
                key={label}
                type="button"
                className="btn"
                title={`Insert ${label}`}
                onClick={() => insertAtCursor(chars)}
                style={{ padding: '1px 6px', fontSize: '0.8em', lineHeight: 1.4, minWidth: 0 }}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Per-binding sections — one row per {{...}} token */}
          {hasBindings && (
            <div style={{ marginTop: '6px', overflow: 'hidden', minWidth: 0 }}>
              <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '4px' }}>
                Data Bindings
              </div>
              {bindingTokens.map((token, idx) => {
                const parts = token.content.split('|');
                const path = parts[0];
                const ops = parts.slice(1);
                return (
                  <div
                    key={idx}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '4px 6px',
                      marginBottom: '2px',
                      background: 'var(--c-surface)',
                      borderRadius: 'var(--radius)',
                      fontSize: '11px',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {path}
                      {ops.length > 0 && (
                        <span style={{ color: 'var(--c-accent)', marginLeft: '4px' }}>
                          {ops.map((o) => '\u2192 ' + o).join(' ')}
                        </span>
                      )}
                    </span>
                    <button
                      className="btn"
                      onClick={() => handleEditToken(idx)}
                      title="Edit this binding's expressions"
                      style={{ padding: '1px 6px', fontSize: '10px', minWidth: 'auto' }}
                    >
                      <TablerIcon name="bolt" size={12} />
                    </button>
                    <button
                      className="btn"
                      onClick={() => removeToken(idx)}
                      title="Remove this binding"
                      style={{ padding: '1px 6px', fontSize: '10px', minWidth: 'auto', color: 'var(--c-danger, #dc3545)' }}
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {showBindingEditor && (
          <BindingExpressionEditor
            value={editingValue}
            onSave={handleSaveBinding}
            onCancel={() => { setShowBindingEditor(false); setEditingTokenIndex(null); }}
          />
        )}
      </Field>
      <div className="field-row">
        <Field label="Size" row>
          <ValueEditor
            value={element.fontSize}
            onChange={(val) => updateElement(element.id, { fontSize: val })}
            renderInput={(val, onChange) => {
              const family = element.fontFamily || FONT_FAMILIES[0];
              const sizes = getSizesForFamily(family);
              return (
                <Dropdown
                  value={String(val)}
                  onChange={(v) => onChange(Number(v))}
                  options={sizes.map((s) => ({ value: String(s), label: `${s}px` }))}
                />
              );
            }}
          />
        </Field>
        <Field label="Line Height" row>
          <ValueEditor
            value={element.lineHeight}
            onChange={(val) => updateElement(element.id, { lineHeight: val })}
            renderInput={(val, onChange) => (
              <NumberInput value={val} onChange={onChange} step={0.1} />
            )}
          />
        </Field>
      </div>
      <Field label="Font Family">
        <ValueEditor
          value={element.fontFamily}
          onChange={(val) => updateElement(element.id, { fontFamily: val })}
          renderInput={(val, onChange) => (
            <Dropdown
              value={val}
              onChange={onChange}
              options={FONT_FAMILIES.map((f) => ({ value: f, label: f }))}
            />
          )}
        />
      </Field>
      <div className="field-row">
        <Field label="Weight" row>
          <ValueEditor
            value={String(element.fontWeight ?? 400)}
            onChange={(val) => updateElement(element.id, { fontWeight: Number(val) })}
            renderInput={(val, onChange) => {
              const family = element.fontFamily || FONT_FAMILIES[0];
              const size = element.fontSize || 16;
              const weights = getWeightsForFamilySize(family, size);
              return (
                <Dropdown
                  value={String(val)}
                  onChange={onChange}
                  options={weights.map((w) => ({ value: String(w.value), label: w.name }))}
                />
              );
            }}
          />
        </Field>
        <Field label="Align" row>
          <ValueEditor
            value={element.textAlign}
            onChange={(val) => updateElement(element.id, { textAlign: val })}
            renderInput={(val, onChange) => (
              <Dropdown
                value={val}
                onChange={onChange}
                options={[
                  { value: 'left', label: 'Left' },
                  { value: 'center', label: 'Center' },
                  { value: 'right', label: 'Right' },
                ]}
              />
            )}
          />
        </Field>
      </div>
      <div className="field-row">
        {/* "…width" on both labels: with overflow ON the height is elastic,
            and with it OFF the label still describes the wrap width. */}
        <Field label="Sizing" row>
          <Dropdown
            value={isFramedTextFlow(element.textFlow) ? 'fixed' : 'auto'}
            onChange={(val) => {
              if (val === 'fixed') {
                if (isFramedTextFlow(element.textFlow)) return;
                // Convert to the default framed mode: a locked box (overflow
                // unticked) at the current measured size — a visual no-op,
                // since auto sizes already hug the content.
                const patch = { textFlow: 'clip' };
                if (typeof element.sizeX === 'number') patch.sizeX = element.sizeX;
                if (typeof element.sizeY === 'number') patch.sizeY = element.sizeY;
                updateElement(element.id, patch);
              } else {
                // Back to hugging: the auto-size hook re-measures on its
                // next pass and shrink-wraps the box.
                updateElement(element.id, { textFlow: 'auto' });
              }
            }}
            options={[
              { value: 'auto', label: 'Auto width' },
              { value: 'fixed', label: 'Fixed width' },
            ]}
          />
        </Field>
        {isFramedTextFlow(element.textFlow) && (
          <Field row>
            <Toggle
              label="Text overflow"
              value={element.textFlow === 'fixed'}
              onChange={(checked) => {
                // Ticked: the box grows downward past its height (the Height
                // input becomes "Min height"). Unticked: the box is locked
                // and text past it is cut, with a dashed hint on the bottom
                // edge while designing.
                updateElement(element.id, { textFlow: checked ? 'fixed' : 'clip' });
              }}
            />
          </Field>
        )}
      </div>
      <FillPanel element={element} updateElement={updateElement} />
    </div>
  );
}

function ImgPanel({ element, updateElement }) {
  const openAssetPicker = useUiStore((s) => s.openAssetPicker);
  return (
    <div className="field-group">
      <div className="field-group-header">Image</div>
      <Field label="Source URL">
        <ValueEditor
          value={element.src}
          onChange={(val) => updateElement(element.id, { src: val })}
          renderInput={(val, onChange) => (
            <TextInput value={val} onChange={onChange} placeholder="https://..." />
          )}
        />
      </Field>
      {openAssetPicker && (
        <Field label="Custom Image">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openAssetPicker((token) => updateElement(element.id, { src: token }))}
          >
            <TablerIcon name="folder-open" />
            <span>Choose Custom Image…</span>
          </button>
        </Field>
      )}
      <Field label="B/W Mode">
        <ValueEditor
          value={element.bwMode}
          onChange={(val) => updateElement(element.id, { bwMode: val })}
          renderInput={(val, onChange) => (
            <Dropdown value={val} onChange={onChange} options={[
              { value: 'threshold', label: 'Threshold' },
              { value: 'dither', label: 'Dither' },
            ]} />
          )}
        />
      </Field>
      {element.bwMode && (
        <Field label="B/W Level">
          <ValueEditor
            value={element.bwLevel}
            onChange={(val) => updateElement(element.id, { bwLevel: val })}
            renderInput={(val, onChange) => (
              <Slider value={val} onChange={onChange} min={0} max={100} />
            )}
          />
        </Field>
      )}
    </div>
  );
}

function SvgContentPanel({ element, updateElement }) {
  const openAssetPicker = useUiStore((s) => s.openAssetPicker);
  return (
    <div className="field-group">
      <div className="field-group-header">SVG Content</div>
      <Field label="Source URL">
        <ValueEditor
          value={element.src}
          onChange={(val) => updateElement(element.id, { src: val })}
          renderInput={(val, onChange) => (
            <TextInput value={val} onChange={onChange} placeholder="https://..." />
          )}
        />
      </Field>
      {openAssetPicker && (
        <Field label="Custom SVG">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => openAssetPicker((token) => updateElement(element.id, { src: token, svg: '' }))}
          >
            <TablerIcon name="folder-open" />
            <span>Choose Custom SVG…</span>
          </button>
        </Field>
      )}
      <Field label="Inline SVG">
        <ValueEditor
          value={element.svg ?? ''}
          onChange={(val) => updateElement(element.id, { svg: val })}
          renderInput={(val, onChange) => (
            <textarea
              className="input"
              rows={4}
              value={val}
              placeholder="<svg>...</svg>"
              onChange={(e) => onChange(e.target.value)}
            />
          )}
        />
      </Field>
      <Field label="B/W Mode">
        <ValueEditor
          value={element.bwMode}
          onChange={(val) => updateElement(element.id, { bwMode: val })}
          renderInput={(val, onChange) => (
            <Dropdown value={val} onChange={onChange} options={[
              { value: 'threshold', label: 'Threshold' },
              { value: 'dither', label: 'Dither' },
            ]} />
          )}
        />
      </Field>
      {element.bwMode && (
        <Field label="B/W Level">
          <ValueEditor
            value={element.bwLevel}
            onChange={(val) => updateElement(element.id, { bwLevel: val })}
            renderInput={(val, onChange) => (
              <Slider value={val} onChange={onChange} min={0} max={100} />
            )}
          />
        </Field>
      )}
    </div>
  );
}

function IconPanel({ element, updateElement }) {
  const [pickerOpen, setPickerOpen] = useState(false);

  /** Extract current icon ref from element name (e.g. "Icon: mdi:weather-sunny") */
  const currentIconRef = element.name?.startsWith('Icon: ')
    ? element.name.slice(6)
    : null;

  function handleIconSelect(ref) {
    const parsed = parseIconRef(ref);
    if (!parsed) return;
    const svgStr = toSvgString(parsed.providerId, parsed.iconName);
    if (!svgStr) return;
    updateElement(element.id, {
      svg: svgStr,
      src: '',
      name: `Icon: ${ref}`,
    });
  }

  return (
    <div className="field-group">
      <div className="field-group-header">Icon</div>
      {currentIconRef && (
        <Field label="Current">
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--c-text-muted)' }}>
            {currentIconRef}
          </span>
        </Field>
      )}
      <Field>
        <button
          className="btn btn-secondary"
          style={{ width: '100%' }}
          onClick={() => setPickerOpen(true)}
        >
          {currentIconRef ? 'Change Icon' : 'Choose Icon'}
        </button>
      </Field>
      <Field label="B/W Mode">
        <ValueEditor
          value={element.bwMode}
          onChange={(val) => updateElement(element.id, { bwMode: val })}
          renderInput={(val, onChange) => (
            <Dropdown value={val} onChange={onChange} options={[
              { value: 'threshold', label: 'Threshold' },
              { value: 'dither', label: 'Dither' },
            ]} />
          )}
        />
      </Field>
      {element.bwMode && (
        <Field label="B/W Level">
          <ValueEditor
            value={element.bwLevel}
            onChange={(val) => updateElement(element.id, { bwLevel: val })}
            renderInput={(val, onChange) => (
              <Slider value={val} onChange={onChange} min={0} max={100} />
            )}
          />
        </Field>
      )}
      <IconPickerModal
        isOpen={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handleIconSelect}
      />
    </div>
  );
}

export default function InspectorPanel() {
  const selectedElementId = useUiStore((s) => s.selectedElementId);
  const selectedElementIds = useUiStore((s) => s.selectedElementIds);
  const element = useDocStore((s) => selectFocusedElements(s).find((e) => e.id === selectedElementId));
  const updateElement = useDocStore((s) => s.updateElement);

  if (selectedElementIds.length > 1) {
    return <div className="placeholder">{selectedElementIds.length} elements selected</div>;
  }

  if (!element) {
    return <div className="placeholder">No element selected</div>;
  }

  return (
    <div className="inspector" style={{ padding: 'var(--sp-3)' }}>
      <CommonFields element={element} updateElement={updateElement} />

      <hr className="separator" />

      {element.type === 'rect' && (
        <>
          <FillPanel element={element} updateElement={updateElement} />
          <StrokePanel element={element} updateElement={updateElement} />
          <RectGeometryPanel element={element} updateElement={updateElement} />
        </>
      )}

      {element.type === 'circle' && (
        <>
          <FillPanel element={element} updateElement={updateElement} />
          <StrokePanel element={element} updateElement={updateElement} />
          <CircleGeometryPanel element={element} updateElement={updateElement} />
        </>
      )}

      {element.type === 'text' && <TextPanel element={element} updateElement={updateElement} />}

      {element.type === 'line' && (
        <>
          <div className="field-group">
            <div className="field-group-header">Points</div>
            <Field>
              <ValueEditor
                value={element.points}
                onChange={(val) => updateElement(element.id, { points: val })}
                renderInput={(val, onChange) => <PointsEditor value={val} onChange={onChange} />}
              />
            </Field>
          </div>
          <StrokePanel element={element} updateElement={updateElement} />
        </>
      )}

      {element.type === 'img' && <ImgPanel element={element} updateElement={updateElement} />}

      {element.type === 'svg' && element.name?.startsWith('Icon: ') && (
        <>
          <IconPanel element={element} updateElement={updateElement} />
          <FillPanel element={element} updateElement={updateElement} />
          <StrokePanel element={element} updateElement={updateElement} />
        </>
      )}

      {element.type === 'svg' && !element.name?.startsWith('Icon: ') && (
        <>
          <SvgContentPanel element={element} updateElement={updateElement} />
          <FillPanel element={element} updateElement={updateElement} />
          <StrokePanel element={element} updateElement={updateElement} />
        </>
      )}

      {element.type === 'graph' && (
        <GraphInspectorPanel element={element} updateElement={updateElement} />
      )}
    </div>
  );
}

CommonFields.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

FillPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

StrokePanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

RectGeometryPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

CircleGeometryPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

TextPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

ImgPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

SvgContentPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};

IconPanel.propTypes = {
  element: PropTypes.object.isRequired,
  updateElement: PropTypes.func.isRequired,
};
