/**
 * textAutoSize.ts — Lay out text elements against their resolved content
 *
 * After data sources are fetched and bindings can be resolved, a text element's
 * live value is rarely the size the payload was deployed with. What happens
 * next depends on the element's `textFlow`:
 *
 *   auto  (default, and every widget saved before 0.1.4) — measure the resolved
 *         string and GROW sizeX/sizeY to fit it, never shrinking, so the user's
 *         centre/right alignment anchoring survives a shorter live value.
 *
 *   fixed — the author owns the width. Wrap the resolved string to sizeX by
 *         inserting "\n", leave sizeX alone, and treat sizeY as a MINIMUM: the
 *         rendered box is max(authored, content), so a value that gains a line
 *         grows downward instead of running off the side.
 *
 * The measuring and line breaking both live in `textLayout.ts`, shared with the
 * builder. This module only decides what to do with the numbers — the two trees
 * apply deliberately different clamp policies (grow-only here, exact there).
 *
 * This runs in the render pipeline (renderService.ts), between source fetching
 * and the engine's render() call. It does NOT modify any engine code — it only
 * patches the element records that are passed into the engine.
 */

import { resolveValue, type DataContext } from "@zb/expressions";
import { getFontForFamily, fontsReady } from "../engine/fonts/fontManager";
import { layoutTextElement } from "./textLayout";

// ── Helpers ────────────────────────────────────────────────────

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && !isNaN(v)) return v;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}

function str(v: unknown, fallback: string): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return fallback;
  return String(v);
}

// ── Resolve text value (mirrors engine elementResolver.ts) ─────

/**
 * Resolve a text element's display string the same way the engine does:
 * resolve the binding, fall back to fallbackText, then coerce to string.
 */
function resolveTextValue(el: Record<string, unknown>, ctx: DataContext): string {
  let text = resolveValue(el.text, ctx);
  const fallback = str(resolveValue(el.fallbackText, ctx) as string, "");

  if (text === null || text === undefined || text === "") {
    text = fallback;
  }

  return str(text, "");
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Walk the element array and lay out every text element against its resolved
 * content. Non-text elements are returned unchanged, as is any text element
 * the layout leaves alone — unchanged elements keep their reference, so
 * byte-identical renders stay cacheable.
 *
 * `errors` carries human-readable warnings for `meta.renderErrors`, alongside
 * the graph, user-asset and pre-raster passes that already contribute there.
 */
export async function expandTextBounds(
  elements: Record<string, unknown>[],
  ctx: DataContext,
): Promise<{ elements: Record<string, unknown>[]; errors: string[] }> {
  await fontsReady;

  const errors: string[] = [];

  const laidOut = elements.map((el, index) => {
    if (el.type !== "text") return el;

    const textStr = resolveTextValue(el, ctx);
    if (!textStr) return el;

    const fontSize = num(el.fontSize, 16);
    const fontWeight = num(el.fontWeight, 400);
    const fontFamily = str(el.fontFamily, "sans-serif");
    const lineHeight = num(el.lineHeight, 1.2);

    const font = getFontForFamily(fontFamily, fontSize, fontWeight);
    if (!font) return el;

    const currentW = num(el.sizeX, 0);
    const currentH = num(el.sizeY, 0);

    const layout = layoutTextElement({
      text: textStr,
      font,
      fontSize,
      lineHeight,
      textFlow: el.textFlow,
      sizeX: currentW,
    });

    if (layout.wrapSkipped) {
      errors.push(
        `Element #${index} (text): wrap skipped — resolved value contains "{{"`,
      );
    }

    // A skipped wrap falls all the way through to the auto policy: no rewrite,
    // and the box grows on both axes as it always has.
    if (el.textFlow === "fixed" && !layout.wrapSkipped) {
      const sizeY = Math.max(currentH, layout.contentHeight);
      // Only write the wrapped string when the breaks actually moved. Leaving
      // an unwrapped element's template in place keeps the engine's single
      // resolution pass, which is the safe side of §2a.
      if (layout.text === textStr && sizeY === currentH) return el;
      return { ...el, text: layout.text, sizeY };
    }

    // Expand only — never shrink
    if (layout.contentWidth <= currentW && layout.contentHeight <= currentH) return el;

    return {
      ...el,
      sizeX: Math.max(currentW, layout.contentWidth),
      sizeY: Math.max(currentH, layout.contentHeight),
    };
  });

  return { elements: laidOut, errors };
}
