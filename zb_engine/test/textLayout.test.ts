/**
 * textLayout.test.ts — Shared text measurement and wrapping
 *
 * The module is pure, so everything here runs against a synthetic font pack
 * with round metrics: 10 px per glyph unless a case needs otherwise. The
 * shared vector fixture at the bottom is also run by the builder suite — that
 * pair is what proves the `@shared/textLayout` alias resolves to this file and
 * not to a stale copy.
 */

import { describe, it, expect } from "vitest";
import {
  measureLineVisual,
  wrapTextToWidth,
  layoutTextElement,
  type TextLayoutFont,
} from "../src/data/textLayout";
import { MAX_WRAPPED_LINES } from "../src/limits";
import vectors from "./fixtures/textLayoutVectors.json";

/** Build a duck-typed font pack: uniform advance, optional per-char overrides. */
function makeFont(
  overrides: Record<string, { xAdvance?: number; xOffset?: number; width?: number }> = {},
  letterSpacing = 0,
): TextLayoutFont {
  const chars = " -abcdefghijklmnopqrstuvwxyz0123456789{}.";
  const glyphs = new Map<string, { xAdvance: number; xOffset: number; width: number }>();
  for (const char of chars) {
    glyphs.set(char, { xAdvance: 10, xOffset: 0, width: 10, ...overrides[char] });
  }
  for (const [char, metrics] of Object.entries(overrides)) {
    if (!glyphs.has(char)) {
      glyphs.set(char, { xAdvance: 10, xOffset: 0, width: 10, ...metrics });
    }
  }
  return { meta: { letterSpacing, fontSize: 10 }, glyphs };
}

describe("measureLineVisual", () => {
  const font = makeFont();

  it("measures an empty line as zero", () => {
    expect(measureLineVisual("", font)).toBe(0);
  });

  it("sums glyph advances", () => {
    expect(measureLineVisual("abc", font)).toBe(30);
  });

  it("adds the last glyph's overhang, which is what the engine clips against", () => {
    const overhanging = makeFont({ j: { width: 14 } });
    expect(measureLineVisual("aj", overhanging)).toBe(24);
    // Only the LAST glyph's overhang counts — an interior one is covered by
    // the following glyph's advance.
    expect(measureLineVisual("ja", overhanging)).toBe(20);
  });

  it("applies letter spacing between glyphs but not after the last", () => {
    const spaced = makeFont({}, 2);
    expect(measureLineVisual("abc", spaced)).toBe(34);
    expect(measureLineVisual("a", spaced)).toBe(10);
  });

  it("falls back to the space advance for a missing glyph", () => {
    const font2 = makeFont();
    expect(measureLineVisual("é", font2)).toBe(10);
  });
});

describe("wrapTextToWidth", () => {
  const font = makeFont();

  it("breaks greedily at whitespace", () => {
    expect(wrapTextToWidth("aaa bbb ccc", font, 70)).toEqual(["aaa bbb", "ccc"]);
  });

  it("preserves author-typed breaks and wraps each paragraph independently", () => {
    expect(wrapTextToWidth("aaa\nbbb ccc", font, 30)).toEqual(["aaa", "bbb", "ccc"]);
  });

  it("does not count trailing whitespace toward the fit test", () => {
    // "aa bb" is exactly 50 px; counting the space after "bb" would make it 60
    // and wrap a word early.
    expect(wrapTextToWidth("aa bb cc", font, 50)).toEqual(["aa bb", "cc"]);
    expect(wrapTextToWidth("aaaa ", font, 40)).toEqual(["aaaa"]);
  });

  it("breaks after a hyphen followed by a non-space", () => {
    expect(wrapTextToWidth("well-known", font, 50)).toEqual(["well-", "known"]);
  });

  it("does not break after a hyphen that ends a word", () => {
    expect(wrapTextToWidth("ab- cd", font, 100)).toEqual(["ab- cd"]);
  });

  it("splits a word wider than the frame character by character", () => {
    expect(wrapTextToWidth("abcdefgh", font, 30)).toEqual(["abc", "def", "gh"]);
  });

  it("emits a single character wider than the frame alone and advances", () => {
    const wide = makeFont({ W: { xAdvance: 20, width: 20 } });
    expect(wrapTextToWidth("WWW", wide, 10)).toEqual(["W", "W", "W"]);
  });

  it("keeps empty paragraphs as empty lines", () => {
    expect(wrapTextToWidth("a\n\nb", font, 100)).toEqual(["a", "", "b"]);
  });

  it("returns the paragraphs unwrapped when maxWidth is not positive", () => {
    expect(wrapTextToWidth("aaa bbb\nccc", font, 0)).toEqual(["aaa bbb", "ccc"]);
    expect(wrapTextToWidth("aaa bbb", font, -5)).toEqual(["aaa bbb"]);
    expect(wrapTextToWidth("aaa bbb", font, NaN)).toEqual(["aaa bbb"]);
  });

  it("stops at maxLines and emits the untreated remainder as the last line", () => {
    expect(wrapTextToWidth("aa bb cc dd", font, 20, { maxLines: 2 })).toEqual([
      "aa",
      "bb cc dd",
    ]);
  });

  it("carries later paragraphs into the remainder when the cap is hit", () => {
    expect(wrapTextToWidth("aa\nbb\ncc", font, 20, { maxLines: 2 })).toEqual([
      "aa",
      "bb\ncc",
    ]);
  });

  it("never exceeds MAX_WRAPPED_LINES on a pathological value", () => {
    const blob = "ab ".repeat(20_000);
    const lines = wrapTextToWidth(blob, font, 20);
    expect(lines.length).toBe(MAX_WRAPPED_LINES);
  });

  it("preserves an authored leading indent", () => {
    expect(wrapTextToWidth("  ab", font, 100)).toEqual(["  ab"]);
  });

  it("does not split a surrogate pair", () => {
    const emoji = makeFont({ "\u{1F600}": { xAdvance: 30, width: 30 } });
    expect(wrapTextToWidth("\u{1F600}\u{1F600}", emoji, 30)).toEqual([
      "\u{1F600}",
      "\u{1F600}",
    ]);
  });
});

describe("layoutTextElement", () => {
  const font = makeFont();
  const base = { font, fontSize: 10, lineHeight: 1.2 };

  it("measures without wrapping in auto mode", () => {
    const result = layoutTextElement({ ...base, text: "aaa bbb", sizeX: 20 });
    expect(result.text).toBe("aaa bbb");
    expect(result.contentWidth).toBe(74); // 7 glyphs + 4 px padding
    expect(result.contentHeight).toBe(16); // 1 line x 12 px + 4 px padding
    expect(result.wrapSkipped).toBe(false);
  });

  it("treats an unknown textFlow value as auto", () => {
    for (const textFlow of ["FIXED", "wrap", 1, true, null, undefined, {}]) {
      const result = layoutTextElement({ ...base, text: "aaa bbb", sizeX: 20, textFlow });
      expect(result.text).toBe("aaa bbb");
    }
  });

  it("wraps to the authored width in fixed mode", () => {
    const result = layoutTextElement({
      ...base,
      text: "aaa bbb",
      sizeX: 30,
      textFlow: "fixed",
    });
    expect(result.text).toBe("aaa\nbbb");
    expect(result.contentWidth).toBe(30);
    expect(result.contentHeight).toBe(28); // 2 lines x 12 px + 4 px padding
  });

  it("never reports a content box wider than the authored frame", () => {
    const result = layoutTextElement({
      ...base,
      text: "abcdefgh",
      sizeX: 30,
      textFlow: "fixed",
    });
    expect(result.contentWidth).toBe(30);
  });

  it("converting at the current measured width is a visual no-op", () => {
    // `auto` reports maxLineWidth + 4, and `fixed` wraps at exactly sizeX, so
    // baking the measured width must not reflow the element.
    const auto = layoutTextElement({ ...base, text: "aaa bbb" });
    const fixed = layoutTextElement({
      ...base,
      text: "aaa bbb",
      sizeX: auto.contentWidth,
      textFlow: "fixed",
    });
    expect(fixed.text).toBe("aaa bbb");
  });

  it("abandons the wrap when the resolved value contains a binding token", () => {
    const result = layoutTextElement({
      ...base,
      text: "aa {{bb}} cc",
      sizeX: 20,
      textFlow: "fixed",
    });
    // Falls through to the auto result: no rewrite, so the engine cannot
    // interpolate the value a second time.
    expect(result.text).toBe("aa {{bb}} cc");
    expect(result.wrapSkipped).toBe(true);
  });

  it("does not flag the guard for a normal fixed element", () => {
    const result = layoutTextElement({
      ...base,
      text: "aaa bbb",
      sizeX: 30,
      textFlow: "fixed",
    });
    expect(result.wrapSkipped).toBe(false);
  });
});

describe("shared vectors", () => {
  const font: TextLayoutFont = {
    meta: vectors.font.meta,
    glyphs: new Map(Object.entries(vectors.font.glyphs)),
  };

  for (const testCase of vectors.cases) {
    it(testCase.name, () => {
      const opts = "maxLines" in testCase ? { maxLines: testCase.maxLines } : undefined;
      expect(wrapTextToWidth(testCase.text, font, testCase.maxWidth, opts)).toEqual(
        testCase.expectedLines,
      );
    });
  }
});
