import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';

import DataTree from './DataTree.jsx';
import Tabs from './Tabs.jsx';
import { Dropdown, TextInput } from './InspectorFields.jsx';
import { useDocStore, selectFocusedFeatures, selectFocusedSources } from '../store/docStore.js';
import { useUiStore } from '../store/uiStore.js';
import { evaluate, isBinding, isExpression, getExpressionOp } from '@zb/expressions';
import {
  buildPreviewContext,
  DEVICE_PREVIEW_PLACEHOLDER,
  DEVICE_HINT,
} from '../utils/expressionContext.js';

/** The telemetry context root. Not a source — see D6. */
const DEVICE_ID = 'device';
import {
  createStepArg,
  deserializeStepArg,
  getStepArgInputValue,
  getStepArgType,
  serializeStepArg,
  STEP_ARG_TYPES,
} from '../utils/bindingExpressionArgs.js';

// High-level timestamp format categories shown in the Format dropdown.
const TIMESTAMP_FORMATS = [
  { value: 'iso', label: 'ISO 8601 Timestamp' },
  { value: 'epoch', label: 'Epoch (Unix seconds)' },
  { value: 'seconds_from_midnight', label: 'Seconds from midnight (→ HH:MM:SS)' },
];

// ISO sub-format options shown when an ISO-family format is selected.
const ISO_SUB_FORMATS = [
  { value: 'iso', label: 'Full ISO 8601' },
  { value: 'date', label: 'Date (YYYY-MM-DD)' },
  { value: 'date_dmy', label: 'Date (DD-MM-YYYY)' },
  { value: 'time', label: 'Time (HH:MM:SS)' },
];

// Format values that belong to the ISO family.
const ISO_FAMILY = new Set(['iso', 'date', 'date_dmy', 'time']);

/** Map any ISO-family format back to the 'iso' dropdown key for the high-level selector. */
function toDropdownFormat(fmt) {
  return ISO_FAMILY.has(fmt) ? 'iso' : fmt;
}

// Operators available in the expression pipeline.
// args: how many EXTRA args (beyond the piped input) are needed.
const OPERATORS = [
  { value: 'timestamp', label: 'Timestamp', args: 2, category: 'timestamp' },
  { value: '+', label: '+ Add', args: 1, category: 'math' },
  { value: '-', label: '− Subtract', args: 1, category: 'math' },
  { value: '*', label: '× Multiply', args: 1, category: 'math' },
  { value: '/', label: '÷ Divide', args: 1, category: 'math' },
  { value: 'mod', label: '% Modulo', args: 1, category: 'math' },
  { value: 'round', label: '⌊⌉ Round', args: 0, category: 'math' },
  { value: 'floor', label: '⌊ Floor', args: 0, category: 'math' },
  { value: 'ceil', label: '⌈ Ceil', args: 0, category: 'math' },
  { value: 'abs', label: '|x| Absolute', args: 0, category: 'math' },
  { value: 'min', label: '↓ Min', args: 1, category: 'math' },
  { value: 'max', label: '↑ Max', args: 1, category: 'math' },
  { value: 'format', label: '.0 Format decimals', args: 1, category: 'format' },
  { value: 'concat', label: '+ Concatenate text', args: 1, category: 'format' },
  { value: 'slice', label: 'Slice text', args: 1, category: 'format' },
  { value: '==', label: '= Equals', args: 1, category: 'logic' },
  { value: '!=', label: '≠ Not Equals', args: 1, category: 'logic' },
  { value: '>', label: '> Greater Than', args: 1, category: 'logic' },
  { value: '<', label: '< Less Than', args: 1, category: 'logic' },
  { value: '>=', label: '>= Greater or Equal', args: 1, category: 'logic' },
  { value: '<=', label: '<= Less or Equal', args: 1, category: 'logic' },
  { value: 'if', label: '? If / Then / Else', args: 2, category: 'logic' },
];

const IF_CONDITION_OPTIONS = [
  { value: 'truthy', label: 'When value is truthy' },
  { value: '==', label: 'When value equals' },
  { value: '!=', label: 'When value does not equal' },
  { value: '>', label: 'When value is greater than' },
  { value: '<', label: 'When value is less than' },
  { value: '>=', label: 'When value is greater or equal' },
  { value: '<=', label: 'When value is less or equal' },
];

const IF_COMPARE_OPS = new Set(['==', '!=', '>', '<', '>=', '<=']);

function getOpDef(opValue) {
  return OPERATORS.find((o) => o.value === opValue);
}

function getArgLabel(op, index) {
  if (op === 'if') return ['Then', 'Else'][index] || `Arg ${index + 1}`;
  if (op === 'format') return 'Decimal places';
  if (op === 'concat') return 'Append text';
  if (op === 'slice') return 'Max characters';
  if (op === 'timestamp') return ['Format', 'UTC offset (hours)'][index] || 'Value';
  return 'Value';
}

function buildStepExpression(inputExpr, step) {
  if (!step?.op || step.op === 'none') return inputExpr;

  const opDef = getOpDef(step.op);
  if (!opDef) return inputExpr;

  if (opDef.args === 0) {
    return { [step.op]: [inputExpr] };
  }

  if (step.op === 'if') {
    const conditionOp = step.conditionOp || 'truthy';
    const conditionArg = serializeStepArg(step.conditionArg);
    const conditionExpr = IF_COMPARE_OPS.has(conditionOp)
      ? { [conditionOp]: [inputExpr, conditionArg] }
      : inputExpr;

    return {
      if: [
        conditionExpr,
        serializeStepArg(step.args[0]),
        serializeStepArg(step.args[1]),
      ],
    };
  }

  if (step.op === 'timestamp') {
    const tsArgs = [inputExpr, step.args[0] || 'iso'];
    const offset = serializeStepArg(step.args[1]);
    if (offset !== '' && offset !== 0) tsArgs.push(offset);
    return { timestamp: tsArgs };
  }

  if (step.op === 'concat') {
    return { concat: [inputExpr, serializeStepArg(step.args[0])] };
  }

  if (step.op === 'slice') {
    return { slice: [inputExpr, 0, serializeStepArg(step.args[0])] };
  }

  return { [step.op]: [inputExpr, serializeStepArg(step.args[0])] };
}

/** Build the full nested expression from a binding + step chain. */
function buildChainedExpression(binding, steps, defaultValue) {
  if (!binding) return null;

  // Start with the binding
  let expr = { $: binding };
  if (defaultValue !== undefined && defaultValue !== '' && steps.length === 0) {
    expr.default = defaultValue;
  }

  // Apply each step — each wraps the previous expression
  for (const step of steps) {
    expr = buildStepExpression(expr, step);
  }

  return expr;
}

/** Decompose a nested expression into a binding + list of steps. */
function decomposeExpression(value) {
  const steps = [];
  let current = value;

  // Walk the nesting from outer → inner, collecting steps
  while (current && typeof current === 'object' && !Array.isArray(current)) {
    if (isBinding(current)) {
      // Reached the leaf binding
      return {
        binding: current.$ || '',
        steps: steps.reverse(),
        defaultValue: current.default !== undefined ? String(current.default) : '',
      };
    }

    if (isExpression(current)) {
      const op = getExpressionOp(current);
      const rawArgs = current[op] || [];

      if (op === 'if' && rawArgs.length === 3) {
        const args = rawArgs.slice(1).map((a) => deserializeStepArg(a));
        const conditionExpr = rawArgs[0];
        const conditionOp = getExpressionOp(conditionExpr);

        if (conditionOp && IF_COMPARE_OPS.has(conditionOp)) {
          const conditionArgs = conditionExpr[conditionOp] || [];
          steps.push({
            op,
            args,
            conditionOp,
            conditionArg: deserializeStepArg(conditionArgs[1]),
          });
          current = conditionArgs[0];
        } else {
          steps.push({ op, args, conditionOp: 'truthy', conditionArg: '' });
          current = rawArgs[0];
        }
        continue;
      }

      // Slice: { "slice": [prev, 0, maxChars] } → show maxChars as only arg
      if (op === 'slice' && rawArgs.length >= 3) {
        const maxChars = typeof rawArgs[2] === 'object' && rawArgs[2] && rawArgs[2].$ ? rawArgs[2].$ : String(rawArgs[2] ?? '');
        steps.push({ op, args: [maxChars] });
        current = rawArgs[0];
        continue;
      }

      const opDef = getOpDef(op);
      if (opDef && opDef.args === 0 && rawArgs.length >= 1) {
        // Unary — input is first arg
        steps.push({ op, args: [] });
        current = rawArgs[0];
        continue;
      }

      if (rawArgs.length >= 2) {
        // Binary — input is first arg, rest are params
        const args = rawArgs.slice(1).map((a) =>
          typeof a === 'object' && a && a.$ ? a.$ : String(a ?? ''),
        );
        steps.push({ op, args });
        current = rawArgs[0];
        continue;
      }
    }

    break;
  }

  // If we couldn't decompose, return empty
  return { binding: '', steps: [], defaultValue: '' };
}

function parseValue(value) {
  if (value === null || value === undefined) {
    return { binding: '', steps: [], defaultValue: '' };
  }
  if (isBinding(value)) {
    return {
      binding: value.$ || '',
      steps: [],
      defaultValue: value.default !== undefined ? String(value.default) : '',
    };
  }
  if (isExpression(value)) {
    return decomposeExpression(value);
  }
  return { binding: '', steps: [], defaultValue: '' };
}

export default function BindingExpressionEditor({ value, onSave, onCancel }) {
  const parsed = parseValue(value);

  const [activeTab, setActiveTab] = useState('Data');
  const [binding, setBinding] = useState(parsed.binding);
  const [steps, setSteps] = useState(parsed.steps);
  const [defaultValue, setDefaultValue] = useState(parsed.defaultValue);

  // Auto-navigate: if binding already references a source, open that source's tree
  const initialSourceId = useMemo(() => {
    if (!parsed.binding) return null;
    const dotIdx = parsed.binding.indexOf('.');
    return dotIdx > 0 ? parsed.binding.slice(0, dotIdx) : parsed.binding;
  }, [parsed.binding]);

  // Extract the path after sourceId for DataTree highlighting (e.g. "attributes.temperature")
  const initialBoundPath = useMemo(() => {
    if (!parsed.binding) return '';
    const dotIdx = parsed.binding.indexOf('.');
    return dotIdx > 0 ? parsed.binding.slice(dotIdx + 1) : '';
  }, [parsed.binding]);

  const [selectedSourceId, setSelectedSourceId] = useState(initialSourceId);

  const features = useDocStore(selectFocusedFeatures);
  const sources = useDocStore(selectFocusedSources);
  const sourceResponsesById = useUiStore((s) => s.sourceResponsesById);
  const rawFeatureValues = useDocStore((s) => selectFocusedFeatures(s)?.values);

  const selectedSource = useMemo(
    () => sources.find((s) => s?.id === selectedSourceId) || null,
    [sources, selectedSourceId],
  );

  // `device` is a context ROOT, not a source, so it has no test response to
  // browse. Offer it as a pseudo-entry backed by the preview placeholder —
  // unless the doc already defines a real source with that id, in which case
  // the user's source wins here exactly as it wins in the render (shadow rule).
  const docHasDeviceSource = sources.some((s) => s?.id === DEVICE_ID);
  const showDeviceEntry = !docHasDeviceSource;
  const deviceSelected = showDeviceEntry && selectedSourceId === DEVICE_ID;

  const responseEntry = selectedSourceId ? sourceResponsesById?.[selectedSourceId] : null;
  const responseData = deviceSelected
    ? DEVICE_PREVIEW_PLACEHOLDER
    : (responseEntry?.data ?? null);

  // Build context for preview
  const context = useMemo(
    () => buildPreviewContext({
      sources,
      sourceResponsesById,
      features: rawFeatureValues || {},
    }),
    [rawFeatureValues, sourceResponsesById, sources],
  );

  // Build full expression from binding + steps
  const currentExpr = useMemo(() => {
    return buildChainedExpression(binding, steps, defaultValue);
  }, [binding, steps, defaultValue]);

  const previewValue = useMemo(() => {
    if (!currentExpr) return null;
    try {
      return evaluate(currentExpr, context);
    } catch {
      return '(error)';
    }
  }, [currentExpr, context]);

  // Compute intermediate preview at each step for display
  const stepPreviews = useMemo(() => {
    if (!binding) return [];
    const results = [];
    let expr = { $: binding };
    try {
      results.push(evaluate(expr, context));
    } catch {
      results.push(null);
    }
    for (const step of steps) {
      if (!step.op || step.op === 'none') { results.push(null); continue; }
      expr = buildStepExpression(expr, step);
      try {
        results.push(evaluate(expr, context));
      } catch {
        results.push(null);
      }
    }
    return results;
  }, [binding, steps, context]);

  const handleSelectFeature = (key) => {
    setBinding(`features.${key}`);
  };

  const handleSelectSourcePath = (path) => {
    if (!selectedSourceId || !path) return;
    setBinding(`${selectedSourceId}.${path}`);
  };

  const handleAddStep = () => {
    setSteps([...steps, { op: '/', args: [''] }]);
  };

  const handleClearBinding = () => {
    setBinding('');
    setSteps([]);
    setDefaultValue('');
    setSelectedSourceId(null);
    setActiveTab('Data');
  };

  const handleRemoveStep = (index) => {
    setSteps(steps.filter((_, i) => i !== index));
  };

  const handleStepOpChange = (index, newOp) => {
    const newSteps = [...steps];
    const opDef = getOpDef(newOp);
    const argCount = opDef ? opDef.args : 1;
    const newArgs = Array.from({ length: argCount }, (_, i) => {
      if (newSteps[index].args[i] !== undefined && newSteps[index].args[i] !== '') return newSteps[index].args[i];
      if (newOp === 'if') return createStepArg(STEP_ARG_TYPES.BOOLEAN, i === 0);
      if (newOp === 'timestamp') return i === 0 ? 'iso' : '0';
      return '';
    });
    newSteps[index] = {
      op: newOp,
      args: newArgs,
      conditionOp: newOp === 'if' ? (newSteps[index].conditionOp || 'truthy') : undefined,
      conditionArg: newOp === 'if'
        ? (newSteps[index].conditionArg || createStepArg(STEP_ARG_TYPES.TEXT, ''))
        : undefined,
    };
    setSteps(newSteps);
  };

  const handleStepArgChange = (stepIndex, argIndex, val) => {
    const newSteps = [...steps];
    const newArgs = [...newSteps[stepIndex].args];
    newArgs[argIndex] = val;
    newSteps[stepIndex] = { ...newSteps[stepIndex], args: newArgs };
    setSteps(newSteps);
  };

  const handleStepArgTypeChange = (stepIndex, argIndex, type) => {
    const nextType = type || STEP_ARG_TYPES.TEXT;
    const newSteps = [...steps];
    const currentArg = newSteps[stepIndex].args[argIndex];
    const currentValue = getStepArgInputValue(currentArg);
    const nextValue = nextType === STEP_ARG_TYPES.BOOLEAN
      ? currentValue === 'false' ? false : true
      : currentValue;

    newSteps[stepIndex] = {
      ...newSteps[stepIndex],
      args: newSteps[stepIndex].args.map((arg, index) => (
        index === argIndex ? createStepArg(nextType, nextValue) : arg
      )),
    };
    setSteps(newSteps);
  };

  const handleIfConditionOpChange = (stepIndex, conditionOp) => {
    const newSteps = [...steps];
    const currentStep = newSteps[stepIndex];
    newSteps[stepIndex] = {
      ...currentStep,
      conditionOp,
      conditionArg: IF_COMPARE_OPS.has(conditionOp)
        ? (currentStep.conditionArg || createStepArg(STEP_ARG_TYPES.TEXT, ''))
        : '',
    };
    setSteps(newSteps);
  };

  const handleIfConditionArgTypeChange = (stepIndex, type) => {
    const nextType = type || STEP_ARG_TYPES.TEXT;
    const newSteps = [...steps];
    const currentStep = newSteps[stepIndex];
    const currentValue = getStepArgInputValue(currentStep.conditionArg);
    const nextValue = nextType === STEP_ARG_TYPES.BOOLEAN
      ? (currentValue === 'false' ? false : true)
      : currentValue;

    newSteps[stepIndex] = {
      ...currentStep,
      conditionArg: createStepArg(nextType, nextValue),
    };
    setSteps(newSteps);
  };

  const handleIfConditionArgChange = (stepIndex, val) => {
    const newSteps = [...steps];
    const currentStep = newSteps[stepIndex];
    const argType = getStepArgType(currentStep.conditionArg);

    newSteps[stepIndex] = {
      ...currentStep,
      conditionArg: argType === STEP_ARG_TYPES.AUTO ? val : createStepArg(argType, val),
    };
    setSteps(newSteps);
  };

  const handleMoveStep = (index, dir) => {
    const newSteps = [...steps];
    const target = index + dir;
    if (target < 0 || target >= newSteps.length) return;
    [newSteps[index], newSteps[target]] = [newSteps[target], newSteps[index]];
    setSteps(newSteps);
  };

  const handleSave = () => {
    onSave(currentExpr);
  };

  const handleClear = () => {
    onSave(null);
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '650px', maxHeight: '85vh' }}
      >
        <div className="modal-header">
          <span className="modal-title">Bind to Data / Expression</span>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn" onClick={handleClear}>
              Clear
            </button>
            <button className="btn" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>

        <div
          className="modal-body"
          style={{ display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}
        >
          {/* Current binding display */}
          <div
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--c-bg)',
              borderBottom: '1px solid var(--c-border)',
            }}
          >
            <div style={{ fontSize: '11px', color: 'var(--c-text-muted)', marginBottom: '4px' }}>
              Bound to:
            </div>
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '13px',
                padding: '8px',
                background: 'var(--c-surface)',
                borderRadius: 'var(--radius)',
                minHeight: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {binding || (
                  <span style={{ opacity: 0.5, fontStyle: 'italic' }}>Select data below</span>
                )}
              </span>
              {binding && (
                <button
                  className="btn"
                  onClick={handleClearBinding}
                  style={{ padding: '2px 8px', fontSize: '11px', minWidth: 'auto' }}
                  title="Remove selected binding and reset the expression"
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {/* Data picker tabs */}
          <div style={{ borderBottom: '1px solid var(--c-border)', padding: 'var(--sp-3)' }}>
            <Tabs tabs={['Data', 'Expression']} activeTab={activeTab} onTabChange={setActiveTab} />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--sp-4)' }}>
            {activeTab === 'Data' && (
              <div>
                <div style={{ marginBottom: 'var(--sp-3)' }}>
                  <div
                    style={{
                      fontSize: '12px',
                      fontWeight: 'bold',
                      marginBottom: 'var(--sp-2)',
                    }}
                  >
                    Features
                  </div>
                  {Object.keys(features.definitions || {}).length === 0 && (
                    <div style={{ opacity: 0.5, fontStyle: 'italic', fontSize: '12px' }}>
                      No features defined
                    </div>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                    {Object.values(features.definitions || {}).map((f) => (
                      <button
                        key={f.key}
                        className="btn"
                        onClick={() => handleSelectFeature(f.key)}
                        style={{
                          padding: '4px 8px',
                          fontSize: '12px',
                          background:
                            binding === `features.${f.key}`
                              ? 'var(--c-accent)'
                              : 'var(--c-surface)',
                          color: binding === `features.${f.key}` ? '#fff' : 'inherit',
                        }}
                      >
                        {f.key}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: '12px',
                      fontWeight: 'bold',
                      marginBottom: 'var(--sp-2)',
                    }}
                  >
                    Sources
                  </div>

                  {!selectedSourceId && (
                    <div>
                      {sources.length === 0 && (
                        <div style={{ opacity: 0.5, fontStyle: 'italic', fontSize: '12px' }}>
                          No sources defined
                        </div>
                      )}
                      {showDeviceEntry && (
                        <div
                          key={DEVICE_ID}
                          style={{
                            padding: 'var(--sp-2)',
                            border: '1px solid var(--c-border)',
                            borderRadius: 'var(--radius)',
                            marginBottom: 'var(--sp-2)',
                            cursor: 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                          onClick={() => setSelectedSourceId(DEVICE_ID)}
                        >
                          <div>
                            <div style={{ fontWeight: 'bold', fontSize: '13px' }}>
                              Panel telemetry (sample)
                            </div>
                            <div style={{ fontSize: '11px', opacity: 0.7 }}>
                              device — battery, temperature, humidity
                            </div>
                          </div>
                          <span>&rsaquo;</span>
                        </div>
                      )}
                      {sources.map((s) => {
                        const hasResponse = !!sourceResponsesById?.[s.id];
                        return (
                          <div
                            key={s.id}
                            style={{
                              padding: 'var(--sp-2)',
                              border: '1px solid var(--c-border)',
                              borderRadius: 'var(--radius)',
                              marginBottom: 'var(--sp-2)',
                              cursor: hasResponse ? 'pointer' : 'default',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              opacity: hasResponse ? 1 : 0.5,
                            }}
                            onClick={() => {
                              if (hasResponse) setSelectedSourceId(s.id);
                            }}
                          >
                            <div>
                              <div style={{ fontWeight: 'bold', fontSize: '13px' }}>
                                {s.name || s.id || 'Unnamed'}
                              </div>
                              <div style={{ fontSize: '11px', opacity: 0.7 }}>
                                {hasResponse ? 'Click to browse' : 'Test source first'}
                              </div>
                            </div>
                            {hasResponse && <span>&rsaquo;</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {selectedSourceId && (
                    <div>
                      <button
                        className="btn"
                        onClick={() => setSelectedSourceId(null)}
                        style={{ marginBottom: 'var(--sp-2)' }}
                      >
                        &larr; Back
                      </button>
                      <div style={{ fontWeight: 'bold', marginBottom: 'var(--sp-1)' }}>
                        {deviceSelected ? 'Panel telemetry (sample)' : selectedSource?.name || selectedSourceId}
                      </div>
                      {deviceSelected && (
                        <div className="device-telemetry-hint">{DEVICE_HINT}</div>
                      )}
                      {responseData ? (
                        <DataTree
                          data={responseData}
                          onLeafPath={handleSelectSourcePath}
                          highlightPath={selectedSourceId === initialSourceId ? initialBoundPath : ''}
                        />
                      ) : (
                        <div style={{ opacity: 0.5 }}>No response data</div>
                      )}
                    </div>
                  )}
                </div>

                {/* Default value — only when no steps and a binding is selected */}
                {binding && steps.length === 0 && (
                  <div style={{ marginTop: 'var(--sp-3)' }}>
                    <label
                      style={{
                        fontSize: '11px',
                        color: 'var(--c-text-muted)',
                        display: 'block',
                        marginBottom: 'var(--sp-1)',
                      }}
                    >
                      Default value (if data is missing)
                    </label>
                    <TextInput
                      value={defaultValue}
                      onChange={setDefaultValue}
                      placeholder="e.g. -- or 0"
                    />
                  </div>
                )}
              </div>
            )}

            {activeTab === 'Expression' && (
              <div>
                {!binding && (
                  <div style={{ opacity: 0.5, fontStyle: 'italic', fontSize: '12px', marginBottom: 'var(--sp-3)' }}>
                    Select a data source in the Data tab first, then add operations here.
                  </div>
                )}

                {binding && (
                  <>
                    {/* Pipeline input */}
                    <div
                      style={{
                        padding: 'var(--sp-2)',
                        background: 'var(--c-surface)',
                        borderRadius: 'var(--radius)',
                        marginBottom: 'var(--sp-2)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <div>
                        <div style={{ fontSize: '10px', color: 'var(--c-text-muted)' }}>Input</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                          {binding}
                        </div>
                      </div>
                      {stepPreviews[0] !== undefined && stepPreviews[0] !== null && (
                        <div style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '11px',
                          opacity: 0.6,
                          padding: '2px 6px',
                          background: 'var(--c-bg)',
                          borderRadius: 'var(--radius)',
                        }}>
                          {String(stepPreviews[0])}
                        </div>
                      )}
                    </div>

                    {/* Step chain */}
                    {steps.map((step, idx) => {
                      const opDef = getOpDef(step.op);
                      const preview = stepPreviews[idx + 1];
                      return (
                        <div
                          key={idx}
                          style={{
                            padding: 'var(--sp-2)',
                            border: '1px solid var(--c-border)',
                            borderRadius: 'var(--radius)',
                            marginBottom: 'var(--sp-2)',
                            background: 'var(--c-bg)',
                          }}
                        >
                          <div style={{ display: 'flex', gap: '4px', alignItems: 'center', marginBottom: opDef && opDef.args > 0 ? 'var(--sp-2)' : 0 }}>
                            <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', minWidth: '24px' }}>
                              #{idx + 1}
                            </div>
                            <div style={{ flex: 1 }}>
                              <Dropdown
                                value={step.op}
                                onChange={(val) => handleStepOpChange(idx, val)}
                                options={OPERATORS.map((o) => ({ value: o.value, label: o.label }))}
                              />
                            </div>
                            {preview !== undefined && preview !== null && (
                              <div style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: '11px',
                                opacity: 0.6,
                                padding: '2px 6px',
                                background: 'var(--c-surface)',
                                borderRadius: 'var(--radius)',
                                whiteSpace: 'nowrap',
                              }}>
                                = {String(preview)}
                              </div>
                            )}
                            <div style={{ display: 'flex', gap: '2px' }}>
                              <button
                                className="btn"
                                onClick={() => handleMoveStep(idx, -1)}
                                disabled={idx === 0}
                                style={{ padding: '2px 6px', fontSize: '10px', minWidth: 'auto' }}
                                title="Move up"
                              >
                                ↑
                              </button>
                              <button
                                className="btn"
                                onClick={() => handleMoveStep(idx, 1)}
                                disabled={idx === steps.length - 1}
                                style={{ padding: '2px 6px', fontSize: '10px', minWidth: 'auto' }}
                                title="Move down"
                              >
                                ↓
                              </button>
                              <button
                                className="btn"
                                onClick={() => handleRemoveStep(idx)}
                                style={{ padding: '2px 6px', fontSize: '10px', minWidth: 'auto', color: 'var(--c-danger, #dc3545)' }}
                                title="Remove step"
                              >
                                ✕
                              </button>
                            </div>
                          </div>

                          {/* Step arguments */}
                          {opDef && opDef.args > 0 && (
                            <div style={{ paddingLeft: '28px' }}>
                              {step.op === 'timestamp' ? (
                                <>
                                  {/* Format category dropdown */}
                                  <div style={{ marginBottom: 'var(--sp-1)' }}>
                                    <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '2px' }}>
                                      Format
                                    </div>
                                    <Dropdown
                                      value={toDropdownFormat(step.args[0] || 'iso')}
                                      onChange={(val) => handleStepArgChange(idx, 0, val)}
                                      options={TIMESTAMP_FORMATS.map((f) => ({ value: f.value, label: f.label }))}
                                    />
                                  </div>

                                  {/* ISO sub-format picker — visible when an ISO-family format is active */}
                                  {ISO_FAMILY.has(step.args[0] || 'iso') && (
                                    <div style={{ marginBottom: 'var(--sp-1)' }}>
                                      <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '4px' }}>
                                        ISO output format
                                      </div>
                                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                        {ISO_SUB_FORMATS.map((sf) => (
                                          <button
                                            key={sf.value}
                                            className="btn"
                                            onClick={() => handleStepArgChange(idx, 0, sf.value)}
                                            style={{
                                              padding: '4px 8px',
                                              fontSize: '11px',
                                              background: 'var(--c-surface)',
                                              border: (step.args[0] || 'iso') === sf.value
                                                ? '2px solid var(--c-accent)'
                                                : '2px solid transparent',
                                              fontWeight: (step.args[0] || 'iso') === sf.value ? 'bold' : 'normal',
                                            }}
                                          >
                                            {(step.args[0] || 'iso') === sf.value ? `✓ ${sf.label}` : sf.label}
                                          </button>
                                        ))}
                                      </div>
                                    </div>
                                  )}

                                  {/* UTC offset */}
                                  <div>
                                    <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '2px' }}>
                                      UTC offset (hours)
                                    </div>
                                    <TextInput
                                      value={step.args[1] || ''}
                                      onChange={(val) => handleStepArgChange(idx, 1, val)}
                                      placeholder="e.g. 2 or -5"
                                    />
                                  </div>
                                </>
                              ) : (
                                /* Non-timestamp operators: generic arg inputs */
                                Array.from({ length: opDef.args }).map((_, ai) => (
                                  <div key={ai} style={{ marginBottom: ai < opDef.args - 1 ? 'var(--sp-1)' : 0 }}>
                                    {step.op === 'if' && ai === 0 && (
                                      <div style={{ marginBottom: 'var(--sp-2)' }}>
                                        <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '2px' }}>
                                          Condition
                                        </div>
                                        <Dropdown
                                          value={step.conditionOp || 'truthy'}
                                          onChange={(val) => handleIfConditionOpChange(idx, val)}
                                          options={IF_CONDITION_OPTIONS}
                                        />
                                        {IF_COMPARE_OPS.has(step.conditionOp || 'truthy') && (
                                          <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '6px', marginTop: '6px' }}>
                                            <Dropdown
                                              value={getStepArgType(step.conditionArg)}
                                              onChange={(val) => handleIfConditionArgTypeChange(idx, val)}
                                              options={[
                                                { value: STEP_ARG_TYPES.TEXT, label: 'Text' },
                                                { value: STEP_ARG_TYPES.NUMBER, label: 'Number' },
                                                { value: STEP_ARG_TYPES.BOOLEAN, label: 'Boolean' },
                                                { value: STEP_ARG_TYPES.BINDING, label: 'Binding' },
                                                { value: STEP_ARG_TYPES.AUTO, label: 'Auto detect' },
                                              ]}
                                            />
                                            {getStepArgType(step.conditionArg) === STEP_ARG_TYPES.BOOLEAN ? (
                                              <Dropdown
                                                value={getStepArgInputValue(step.conditionArg) || 'true'}
                                                onChange={(val) => handleIfConditionArgChange(idx, val === 'true')}
                                                options={[
                                                  { value: 'true', label: 'True' },
                                                  { value: 'false', label: 'False' },
                                                ]}
                                              />
                                            ) : (
                                              <TextInput
                                                value={getStepArgInputValue(step.conditionArg)}
                                                onChange={(val) => handleIfConditionArgChange(idx, val)}
                                                placeholder={getStepArgType(step.conditionArg) === STEP_ARG_TYPES.BINDING ? 'e.g. weather.expected' : 'Type the value to compare against'}
                                              />
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    )}
                                    <div style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '2px' }}>
                                      {getArgLabel(step.op, ai)}
                                    </div>
                                    {step.op === 'if' ? (
                                      <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '6px' }}>
                                        <Dropdown
                                          value={getStepArgType(step.args[ai])}
                                          onChange={(val) => handleStepArgTypeChange(idx, ai, val)}
                                          options={[
                                            { value: STEP_ARG_TYPES.BOOLEAN, label: 'Boolean' },
                                            { value: STEP_ARG_TYPES.NUMBER, label: 'Number' },
                                            { value: STEP_ARG_TYPES.TEXT, label: 'Text' },
                                            { value: STEP_ARG_TYPES.BINDING, label: 'Binding' },
                                            { value: STEP_ARG_TYPES.AUTO, label: 'Auto detect' },
                                          ]}
                                        />
                                        {getStepArgType(step.args[ai]) === STEP_ARG_TYPES.BOOLEAN ? (
                                          <Dropdown
                                            value={getStepArgInputValue(step.args[ai]) || 'true'}
                                            onChange={(val) => handleStepArgChange(idx, ai, createStepArg(STEP_ARG_TYPES.BOOLEAN, val === 'true'))}
                                            options={[
                                              { value: 'true', label: 'True' },
                                              { value: 'false', label: 'False' },
                                            ]}
                                          />
                                        ) : (
                                          <TextInput
                                            value={getStepArgInputValue(step.args[ai])}
                                            onChange={(val) => {
                                              const type = getStepArgType(step.args[ai]);
                                              handleStepArgChange(
                                                idx,
                                                ai,
                                                type === STEP_ARG_TYPES.AUTO ? val : createStepArg(type, val),
                                              );
                                            }}
                                            placeholder={getStepArgType(step.args[ai]) === STEP_ARG_TYPES.BINDING ? 'e.g. weather.condition' : 'Number, text, or path (e.g. 3600)'}
                                          />
                                        )}
                                      </div>
                                    ) : (
                                      <TextInput
                                        value={step.args[ai] || ''}
                                        onChange={(val) => handleStepArgChange(idx, ai, val)}
                                        placeholder="Number, text, or path (e.g. 3600)"
                                      />
                                    )}
                                  </div>
                                ))
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Add step button */}
                    <button
                      className="btn"
                      onClick={handleAddStep}
                      style={{ width: '100%', marginTop: 'var(--sp-1)' }}
                    >
                      + Add Step
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Preview */}
          <div
            style={{
              padding: 'var(--sp-3)',
              background: 'var(--c-bg)',
              borderTop: '1px solid var(--c-border)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: '16px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '2px' }}
                >
                  JSON Preview
                </div>
                <pre
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    background: 'var(--c-surface)',
                    padding: '8px',
                    borderRadius: 'var(--radius)',
                    margin: 0,
                    overflow: 'auto',
                    maxHeight: '80px',
                    overflowX: 'auto',
                  }}
                >
                  {currentExpr ? JSON.stringify(currentExpr, null, 2) : 'null'}
                </pre>
              </div>
              <div>
                <div
                  style={{ fontSize: '10px', color: 'var(--c-text-muted)', marginBottom: '2px' }}
                >
                  Live Value
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    padding: '8px 12px',
                    background: 'var(--c-surface)',
                    borderRadius: 'var(--radius)',
                    minWidth: '60px',
                    textAlign: 'center',
                  }}
                >
                  {previewValue !== null && previewValue !== undefined
                    ? String(previewValue)
                    : '--'}
                </div>
              </div>
            </div>
          </div>

          {/* Save button */}
          <div
            style={{
              padding: 'var(--sp-3)',
              borderTop: '1px solid var(--c-border)',
              display: 'flex',
              justifyContent: 'flex-end',
            }}
          >
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={!binding}
            >
              Apply Binding
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

BindingExpressionEditor.propTypes = {
  value: PropTypes.any,
  onSave: PropTypes.func.isRequired,
  onCancel: PropTypes.func.isRequired,
};

export {
  buildChainedExpression,
  decomposeExpression,
};
