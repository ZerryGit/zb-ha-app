/**
 * textLayout.ts — Shared text measurement and word wrapping
 *
 * Single source of truth for how a text element's resolved content is measured
 * and broken into lines (ENGINEERING_CONSTRAINTS.md §5). The server pre-render
 * pass imports this file directly; the builder imports the same file through
 * the `@shared/textLayout` Vite alias, so the two trees cannot drift.
 *
 * Wrapping works by inserting "\n" into the resolved string here, in the
 * pre-render layer. Every glyph loop in the product already renders "\n" with
 * correct per-line alignment, so no renderer — least of all the frozen engine —
 * has to learn about wrapping. Do not add a wrapping loop to one: two places
 * deciding line breaks will disagree, and the symptom is "the preview doesn't
 * match the panel".
 *
 * `layoutTextElement` returns a CONTENT box, never a final element size. Each
 * caller applies its own clamp policy — the server grows and never shrinks, the
 * builder writes the exact box for `auto` elements and nothing at all for
 * `fixed` ones. That split is deliberate and pinned by tests on both sides.
 *
 * Pure: no Node and no DOM imports. `../limits` is import-free, so it
 * transpiles cleanly through the builder's alias.
 */

import { MAX_WRAPPED_LINES } from "../limits";

// ── Font duck-type ─────────────────────────────────────────────

/**
 * The subset of a font pack this module needs. The server's `FontPack`
 * (`engine/fonts/fontTypes.ts`) and the builder's (`utils/bitmapFont.js`)
 * both satisfy it structurally, so one signature serves both with no adapter.
 */
export interface TextLayoutGlyph {
  xAdvance: number;
  xOffset: number;
  width: number;
}

export interface TextLayoutFont {
  meta: { letterSpacing: number; fontSize: number };
  glyphs: Map<string, TextLayoutGlyph>;
}

/** Horizontal/vertical margin added to a measured box so glyphs don't clip. */
const TEXT_BOX_PADDING = 4;

/**
 * The two framed text modes — both wrap to the authored `sizeX`; they differ
 * only in what the caller does with `sizeY` ("fixed" treats it as a minimum
 * and grows past it, "clip" treats it as the box and lets the renderer cut).
 * Anything else — including absent, which is every widget saved before
 * 0.1.4 — means "auto", the shrink-to-fit behaviour.
 */
export function isFramedTextFlow(textFlow: unknown): boolean {
  return textFlow === "fixed" || textFlow === "clip";
}

// ── Measurement ────────────────────────────────────────────────

/** Cursor advance for one code point, including the inter-glyph spacing. */
function charAdvance(char: string, font: TextLayoutFont): number {
  const glyph = font.glyphs.get(char);
  if (glyph) return glyph.xAdvance + font.meta.letterSpacing;
  const space = font.glyphs.get(" ");
  return space?.xAdvance ?? Math.round(font.meta.fontSize * 0.3);
}

/** Pixels the glyph paints beyond its own advance (0 for a missing glyph). */
function charOverhang(char: string, font: TextLayoutFont): number {
  const glyph = font.glyphs.get(char);
  if (!glyph) return 0;
  return Math.max(0, glyph.xOffset + glyph.width - glyph.xAdvance);
}

/**
 * Measure the visual pixel width of a single line, including the last glyph's
 * overhang beyond its xAdvance. This is the measure the engine's
 * `blitGlyphClipped()` actually cuts against — do not substitute the builder's
 * `measureLine()`, which omits the overhang and wraps one pixel late.
 */
export function measureLineVisual(line: string, font: TextLayoutFont): number {
  let width = 0;
  let lastChar = "";

  for (const char of line) {
    width += charAdvance(char, font);
    lastChar = char;
  }

  if (line.length === 0) return 0;
  return width - font.meta.letterSpacing + charOverhang(lastChar, font);
}

/**
 * Measure the box a "\n"-separated block needs, with the padding both trees
 * have always applied.
 */
function measureBlock(
  lines: string[],
  font: TextLayoutFont,
  lineSpacing: number,
): { width: number; height: number } {
  let maxLineWidth = 0;
  for (const line of lines) {
    const w = measureLineVisual(line, font);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  return {
    width: maxLineWidth + TEXT_BOX_PADDING,
    height: lines.length * lineSpacing + TEXT_BOX_PADDING,
  };
}

// ── Wrapping ───────────────────────────────────────────────────

interface TokenMetrics {
  /** Σ advance over every code point, trailing whitespace included. */
  advance: number;
  /** Σ advance up to and including the last non-whitespace code point. */
  advanceTrimmed: number;
  /** Overhang of that last non-whitespace code point. */
  overhang: number;
}

/**
 * Measure a token once so the greedy fill below stays O(1) per token. A
 * re-measure of the whole candidate line per token is quadratic, which is
 * exactly the cost `MAX_WRAPPED_LINES` exists to avoid paying.
 */
function tokenMetrics(token: string, font: TextLayoutFont): TokenMetrics {
  let advance = 0;
  let advanceTrimmed = 0;
  let overhang = 0;

  for (const char of token) {
    advance += charAdvance(char, font);
    if (!/\s/.test(char)) {
      advanceTrimmed = advance;
      overhang = charOverhang(char, font);
    }
  }

  return { advance, advanceTrimmed, overhang };
}

/** `measureLineVisual`'s formula, from an already-accumulated advance sum. */
function visualWidth(
  advance: number,
  overhang: number,
  font: TextLayoutFont,
): number {
  if (advance === 0) return 0;
  return advance - font.meta.letterSpacing + overhang;
}

/**
 * Split a paragraph into break units: a run of non-space characters plus the
 * whitespace that follows it, further divided after any `-` that is followed by
 * a non-space (the second break opportunity).
 *
 * The leading `\s*` is deliberate — the literal "\S+\s*" form would silently
 * delete an authored indent on the first token. Only the first token can carry
 * leading whitespace; every later one starts where the previous token's
 * trailing run ended.
 */
function tokenize(paragraph: string): string[] {
  const tokens: string[] = [];
  const re = /\s*\S+\s*/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(paragraph)) !== null) {
    const unit = match[0];
    let start = 0;
    for (let i = 0; i < unit.length - 1; i++) {
      if (unit[i] === "-" && !/\s/.test(unit[i + 1])) {
        tokens.push(unit.slice(start, i + 1));
        start = i + 1;
      }
    }
    tokens.push(unit.slice(start));
  }

  return tokens;
}

/**
 * Break one token that is wider than the whole frame, greedily over code points
 * so surrogate pairs survive. A single character wider than the frame is
 * emitted alone, so the walk always advances.
 */
function hardSplitToken(
  token: string,
  font: TextLayoutFont,
  maxWidth: number,
): string[] {
  // Split the visible part only; the trailing whitespace rides on the last
  // chunk, where the emitting caller trims it as it would any other line.
  const body = token.replace(/\s+$/, "");
  const trailing = token.slice(body.length);
  const chars = Array.from(body);
  const chunks: string[] = [];

  let start = 0;
  let advance = 0;

  for (let i = 0; i < chars.length; i++) {
    const next = advance + charAdvance(chars[i], font);

    if (visualWidth(next, charOverhang(chars[i], font), font) > maxWidth && i > start) {
      chunks.push(chars.slice(start, i).join(""));
      start = i;
      advance = charAdvance(chars[i], font);
      continue;
    }
    advance = next;
  }

  chunks.push(chars.slice(start).join("") + trailing);
  return chunks;
}

/**
 * Break `text` so no line exceeds `maxWidth` pixels. Author-typed "\n" breaks
 * are preserved verbatim and each paragraph wraps independently.
 *
 * Break opportunities are after a whitespace run and after a `-` followed by a
 * non-space. CJK has neither; if it ever matters, "between two ideographs" is
 * the fourth opportunity to add here — out of scope today.
 *
 * On reaching `maxLines` the untreated remainder is emitted verbatim as the
 * final entry: the array stays bounded and the over-long tail clips at render
 * time exactly as an over-long line does today.
 */
export function wrapTextToWidth(
  text: string,
  font: TextLayoutFont,
  maxWidth: number,
  opts?: { maxLines?: number },
): string[] {
  const paragraphs = text.split("\n");

  // A non-positive frame has no fit test that can ever pass, and greedily
  // filling it would never advance. Degrade to today's unwrapped behaviour.
  if (!(maxWidth > 0)) return paragraphs;

  const maxLines = Math.max(1, Math.floor(opts?.maxLines ?? MAX_WRAPPED_LINES));
  const lines: string[] = [];
  let capped = false;

  /**
   * Emit one line, unless doing so would consume the last slot — the last slot
   * always receives the whole untreated remainder instead of a truncation.
   */
  const emit = (line: string, remainder: () => string): void => {
    if (lines.length === maxLines - 1) {
      lines.push(remainder());
      capped = true;
      return;
    }
    lines.push(line);
  };

  for (let p = 0; p < paragraphs.length && !capped; p++) {
    const tokens = tokenize(paragraphs[p]);
    const tail = (pending: string, from: number): string => {
      const rest = pending + tokens.slice(from).join("");
      const after = paragraphs.slice(p + 1);
      return after.length ? [rest, ...after].join("\n") : rest;
    };

    // Empty or whitespace-only paragraph — keep the blank line it renders as.
    if (tokens.length === 0) {
      emit(paragraphs[p], () => tail(paragraphs[p], 0));
      continue;
    }

    let current = "";
    let currentAdvance = 0;

    for (let t = 0; t < tokens.length && !capped; t++) {
      let token = tokens[t];
      let metrics = tokenMetrics(token, font);

      if (current !== "") {
        const width = visualWidth(
          currentAdvance + metrics.advanceTrimmed,
          metrics.overhang,
          font,
        );
        if (width <= maxWidth) {
          current += token;
          currentAdvance += metrics.advance;
          continue;
        }

        // Overflowed a line that already has content: close it and retry the
        // token at the start of a fresh one.
        const pending = current;
        emit(pending.replace(/\s+$/, ""), () => tail(pending, t));
        if (capped) break;
        current = "";
        currentAdvance = 0;
        token = token.replace(/^\s+/, "");
        metrics = tokenMetrics(token, font);
      }

      if (visualWidth(metrics.advanceTrimmed, metrics.overhang, font) <= maxWidth) {
        current = token;
        currentAdvance = metrics.advance;
        continue;
      }

      // No break opportunity can help a token wider than the whole frame.
      const chunks = hardSplitToken(token, font, maxWidth);
      for (let c = 0; c < chunks.length - 1 && !capped; c++) {
        const pending = chunks.slice(c).join("");
        emit(chunks[c].replace(/\s+$/, ""), () => tail(pending, t + 1));
      }
      if (capped) break;
      current = chunks[chunks.length - 1];
      currentAdvance = tokenMetrics(current, font).advance;
    }

    if (!capped) {
      const pending = current;
      emit(pending.replace(/\s+$/, ""), () => tail(pending, tokens.length));
    }
  }

  return lines;
}

// ── Element layout ─────────────────────────────────────────────

export interface TextLayoutInput {
  /** The already-resolved display string, not the authored template. */
  text: string;
  font: TextLayoutFont;
  fontSize: number;
  lineHeight: number;
  /** `"fixed"` and `"clip"` wrap to `sizeX`; anything else means `auto` (D4). */
  textFlow?: unknown;
  /** Authored frame width — only read in `fixed` mode. */
  sizeX?: number;
  maxLines?: number;
}

export interface TextLayoutResult {
  /** The string to render: re-broken with "\n" in `fixed` mode, else untouched. */
  text: string;
  contentWidth: number;
  contentHeight: number;
  /**
   * True when a framed mode was requested but the `{{` guard abandoned the
   * rewrite. The server turns this into a `meta.renderErrors` warning; the
   * builder ignores it.
   */
  wrapSkipped: boolean;
}

/**
 * Measure a text element, wrapping it first when it carries an authored frame.
 *
 * Returns the CONTENT box. Applying it — grow-only on the server, exact in the
 * builder, and `max(authored sizeY, contentHeight)` for the rendered box on
 * both — is the caller's job.
 */
export function layoutTextElement(input: TextLayoutInput): TextLayoutResult {
  const { text, font, fontSize, lineHeight } = input;
  const lineSpacing = Math.round(fontSize * lineHeight);

  const auto = (wrapSkipped: boolean): TextLayoutResult => {
    const box = measureBlock(text.split("\n"), font, lineSpacing);
    return {
      text,
      contentWidth: box.width,
      contentHeight: box.height,
      wrapSkipped,
    };
  };

  if (!isFramedTextFlow(input.textFlow)) return auto(false);

  // Wrapping writes the resolved string back into the element, so the engine
  // would resolve it a second time. A value that itself contains "{{" would be
  // interpolated on that second pass — a behaviour change and an injection
  // surface. Check the INPUT: a hard character split can drop a "\n" between
  // the two braces, so an output check would miss what this one catches.
  if (text.includes("{{")) return auto(true);

  const maxWidth = input.sizeX ?? 0;
  const lines = wrapTextToWidth(text, font, maxWidth, { maxLines: input.maxLines });

  return {
    text: lines.join("\n"),
    // The authored width is the entire point of the mode — never report wider.
    contentWidth: maxWidth,
    contentHeight: lines.length * lineSpacing + TEXT_BOX_PADDING,
    wrapSkipped: false,
  };
}
