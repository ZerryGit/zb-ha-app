import { useEffect, useRef } from 'react';
import { evaluate, isBinding, isExpression, buildPipeExpression } from '@zb/expressions';
import { isFramedTextFlow } from '@shared/textLayout';
import { layoutTextBounds, fontsReady } from '../utils/bitmapFont.js';

/**
 * Concise, human-readable placeholder for a binding the canvas can't resolve
 * (e.g. a secret-protected source whose live data isn't available in the
 * builder). Shows the bound field's leaf name — `realtimeDeparture` — instead
 * of the full `{{sourceId.long.path}}` template, which is unreadable on the
 * canvas. Strips pipe operators and the source-id prefix so the designer sees
 * the meaningful field, not the plumbing.
 */
function bindingFieldLabel(tokenContent) {
  const path = String(tokenContent).split('|')[0].trim();
  const segments = path.split(/[.[\]]/).filter(Boolean);
  // Drop the leading source-id segment when there's a deeper path; for a bare
  // `sourceId` (or `features`) keep it so the token is never blank.
  const meaningful = segments.length > 1 ? segments.slice(1) : segments;
  return meaningful[meaningful.length - 1] || path;
}

/**
 * Resolve a text value for canvas display.
 *
 * If the value is a binding or expression, attempt to evaluate it using the
 * live data context (tested source responses + feature values). Falls back to
 * fallbackText, then a binding label like `{source.path}`.
 */
export function resolveDisplayText(textValue, fallbackText, ctx) {
  if (textValue === null || textValue === undefined) return '';

  // Plain string — check for template interpolation (e.g. "Temp: {{source.value|round}}°C")
  if (typeof textValue === 'string') {
    if (!textValue.includes('{{')) return textValue;
    return textValue.replace(/\{\{([^}]+)\}\}/g, (match, content) => {
      const trimmed = content.trim();
      const expr = trimmed.includes('|') ? buildPipeExpression(trimmed) : { $: trimmed };
      let resolved;
      try {
        resolved = evaluate(expr, ctx);
      } catch {
        resolved = undefined; // evaluation error — treat as unresolved
      }
      if (resolved !== null && resolved !== undefined) return String(resolved);
      // Unresolved in the builder (no live data yet, or a secret-protected
      // source the builder can't fetch). Show the author's fallback if set,
      // otherwise a concise field label — never the raw {{…}} template.
      if (fallbackText) return String(fallbackText);
      return bindingFieldLabel(trimmed);
    });
  }

  // Binding or expression object — evaluate against live context
  if (isBinding(textValue) || isExpression(textValue)) {
    try {
      const resolved = evaluate(textValue, ctx);
      if (resolved !== null && resolved !== undefined) return String(resolved);
    } catch {
      // Evaluation failed — fall through to fallback
    }
    // Show fallback text or a human-readable binding label
    if (fallbackText) return String(fallbackText);
    if (isBinding(textValue)) return `{${textValue.$}}`;
    return '(expr)';
  }

  return String(textValue);
}

/**
 * Keep text element hitboxes aligned with rendered bitmap text bounds.
 *
 * This hook preserves the previous CanvasArea behavior while isolating the
 * auto-size effect from pointer/rendering code. It only writes when measured
 * bounds change by more than one pixel, so normal canvas interactions do not
 * incur redundant docStore mutations.
 */
export function useAutoSizeText({ elements, bitmapFontsLoaded, bindingCtx, updateElementDerived }) {
  const prevTextFingerprintRef = useRef({});

  useEffect(() => {
    if (!bitmapFontsLoaded || !fontsReady() || !elements) return;

    const prev = prevTextFingerprintRef.current;
    const next = {};

    for (const el of elements) {
      if (el.type !== 'text') continue;

      // A framed element's sizes are authored — the renderer owns nothing
      // on it, so the hook writes nothing. Skipping the fingerprint too means
      // a later framed → auto flip re-measures on its first auto pass.
      if (isFramedTextFlow(el.textFlow)) continue;

      // Resolve the actual display text — handles plain strings, bindings,
      // expressions, and template interpolation identically to the render path.
      const displayText = resolveDisplayText(el.text, el.fallbackText, bindingCtx) || 'Text';

      const fp = `${displayText}|${el.fontSize}|${el.fontWeight}|${el.fontFamily}|${el.lineHeight}`;
      next[el.id] = fp;

      // Only recalculate if text-affecting properties actually changed.
      if (prev[el.id] === fp) continue;

      const bounds = layoutTextBounds({
        text: displayText,
        fontSize: el.fontSize ?? 20,
        fontWeight: el.fontWeight ?? 400,
        fontFamily: el.fontFamily ?? 'Sora',
        lineHeight: el.lineHeight ?? 1.2,
      });
      if (!bounds) continue;

      // Only update if the measured size differs from the current size.
      const curW = el.sizeX ?? 0;
      const curH = el.sizeY ?? 0;
      if (Math.abs(curW - bounds.width) > 1 || Math.abs(curH - bounds.height) > 1) {
        updateElementDerived(el.id, { sizeX: bounds.width, sizeY: bounds.height });
      }
    }

    prevTextFingerprintRef.current = next;
  }, [elements, bitmapFontsLoaded, updateElementDerived, bindingCtx]);
}
