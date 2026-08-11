/**
 * textAutoSize.test.ts — Tests for the server-side text layout pass
 *
 * `auto` (the first nine cases, and every widget saved before 0.1.4):
 * expandTextBounds() grows sizeX/sizeY when the resolved text is wider/taller
 * than the stored dimensions, and leaves them unchanged (never shrinks) when
 * the stored box is already large enough.
 *
 * `fixed`: the width is authored, so the value wraps into it instead of
 * widening the box, and sizeY acts as a minimum the content may grow past.
 */

import { describe, it, expect } from "vitest";
import { expandTextBounds } from "../src/data/textAutoSize";
import { MAX_WRAPPED_LINES } from "../src/limits";
import type { DataContext } from "@zb/expressions";

function makeCtx(overrides: Record<string, unknown> = {}): DataContext {
  return {
    misc: {},
    features: {},
    ...overrides,
  };
}

/** Unwrap the elements so the `auto` assertions below stay verbatim. */
async function expand(
  elements: Record<string, unknown>[],
  ctx: DataContext,
): Promise<Record<string, unknown>[]> {
  return (await expandTextBounds(elements, ctx)).elements;
}

describe("expandTextBounds", () => {
  it("returns non-text elements unchanged", async () => {
    const elements = [
      { type: "rect", sizeX: 10, sizeY: 10 },
      { type: "circle", sizeX: 20, sizeY: 20 },
    ];
    const result = await expand(elements, makeCtx());
    expect(result).toEqual(elements);
  });

  it("does not shrink a text element with an oversized bounding box", async () => {
    const elements = [
      {
        type: "text",
        text: "Hi",
        sizeX: 500,
        sizeY: 500,
        fontSize: 16,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, makeCtx());
    expect(result[0].sizeX).toBe(500);
    expect(result[0].sizeY).toBe(500);
  });

  it("expands sizeX when resolved text is wider than stored value", async () => {
    // Use a tiny sizeX that can't fit any reasonable text at 20px
    const elements = [
      {
        type: "text",
        text: "123456789",
        sizeX: 5,
        sizeY: 200,
        fontSize: 20,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, makeCtx());
    expect(result[0].sizeX).toBeGreaterThan(5);
    // sizeY should stay because 200 is large enough for one line
    expect(result[0].sizeY).toBe(200);
  });

  it("expands sizeY for multi-line text", async () => {
    const elements = [
      {
        type: "text",
        text: "Line 1\nLine 2\nLine 3",
        sizeX: 500,
        sizeY: 5,
        fontSize: 20,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, makeCtx());
    expect(result[0].sizeY).toBeGreaterThan(5);
    expect(result[0].sizeX).toBe(500);
  });

  it("resolves bindings before measuring", async () => {
    const ctx = makeCtx({
      sensor_temp: { state: "31.32" },
    });
    const elements = [
      {
        type: "text",
        text: { $: "sensor_temp.state" },
        sizeX: 5,
        sizeY: 200,
        fontSize: 34,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, ctx);
    // With the binding resolved to "31.32" at 34px, sizeX=5 must expand
    expect(result[0].sizeX).toBeGreaterThan(5);
  });

  it("uses fallbackText when text binding resolves to empty", async () => {
    const elements = [
      {
        type: "text",
        text: { $: "missing.path" },
        fallbackText: "N/A",
        sizeX: 5,
        sizeY: 200,
        fontSize: 20,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, makeCtx());
    // "N/A" at 20px should need more than 5px
    expect(result[0].sizeX).toBeGreaterThan(5);
  });

  it("returns element unchanged when text is empty", async () => {
    const elements = [
      {
        type: "text",
        text: "",
        sizeX: 50,
        sizeY: 50,
        fontSize: 20,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, makeCtx());
    expect(result[0]).toEqual(elements[0]);
  });

  it("preserves other element properties when expanding", async () => {
    const elements = [
      {
        type: "text",
        text: "A long string of text that needs more room",
        sizeX: 5,
        sizeY: 5,
        fontSize: 20,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
        pos: { x: 10, y: 20 },
        textAlign: "center",
        fill: 100,
        visible: true,
      },
    ];
    const result = await expand(elements, makeCtx());
    const el = result[0] as Record<string, unknown>;
    expect(el.pos).toEqual({ x: 10, y: 20 });
    expect(el.textAlign).toBe("center");
    expect(el.fill).toBe(100);
    expect(el.visible).toBe(true);
    expect(el.type).toBe("text");
  });

  it("handles template interpolation in text", async () => {
    const ctx = makeCtx({
      weather: { temperature: 31.32 },
    });
    const elements = [
      {
        type: "text",
        text: "Temp: {{weather.temperature}}°C",
        sizeX: 5,
        sizeY: 200,
        fontSize: 20,
        fontWeight: 400,
        fontFamily: "Sora",
        lineHeight: 1.2,
      },
    ];
    const result = await expand(elements, ctx);
    // "Temp: 31.32°C" at 20px should need more than 5px
    expect(result[0].sizeX).toBeGreaterThan(5);
  });
});

describe("expandTextBounds — fixed frames", () => {
  /** A text element wide enough for a word or two at 20 px, not for a sentence. */
  function fixedText(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      type: "text",
      text: "alpha bravo charlie delta echo",
      sizeX: 90,
      sizeY: 30,
      fontSize: 20,
      fontWeight: 400,
      fontFamily: "Sora",
      lineHeight: 1.2,
      textFlow: "fixed",
      ...overrides,
    };
  }

  it("wraps the value instead of widening the box", async () => {
    const result = await expand([fixedText()], makeCtx());
    const text = String(result[0].text);

    expect(text).toContain("\n");
    // Same words, only the breaks are new.
    expect(text.split("\n").join(" ")).toBe("alpha bravo charlie delta echo");
  });

  it("never changes sizeX in fixed mode", async () => {
    const result = await expand([fixedText()], makeCtx());
    expect(result[0].sizeX).toBe(90);
  });

  it("grows past the authored sizeY when the content is taller", async () => {
    const result = await expand([fixedText()], makeCtx());
    expect(result[0].sizeY).toBeGreaterThan(30);
  });

  it("respects an authored reserve taller than the content", async () => {
    // One short word in a 400 px-tall frame: the reserve is the point, so the
    // box must stay at 400 rather than shrink to the single line it contains.
    const result = await expand([fixedText({ text: "hi", sizeY: 400 })], makeCtx());
    expect(result[0].sizeY).toBe(400);
    expect(result[0].text).toBe("hi");
  });

  it("leaves an element alone when the value already fits on one line", async () => {
    // The D2 corollary: converting at the measured width must be a visual
    // no-op, so a fitting element keeps its reference and its template.
    const element = fixedText({ text: "hi", sizeY: 400 });
    const result = await expand([element], makeCtx());
    expect(result[0]).toBe(element);
  });

  it("caps a pathological value at MAX_WRAPPED_LINES", async () => {
    const result = await expand(
      [fixedText({ text: "ab ".repeat(20_000), sizeY: 10 })],
      makeCtx(),
    );
    expect(String(result[0].text).split("\n").length).toBe(MAX_WRAPPED_LINES);
  });

  it("treats an unknown textFlow value as auto", async () => {
    for (const textFlow of ["FIXED", "wrap", 1, true, null]) {
      const result = await expand([fixedText({ textFlow, sizeX: 5 })], makeCtx());
      // The auto path widens the box and leaves the string alone.
      expect(result[0].sizeX).toBeGreaterThan(5);
      expect(result[0].text).toBe("alpha bravo charlie delta echo");
    }
  });

  it("falls back to auto when the resolved value contains a binding token", async () => {
    const ctx = makeCtx({
      s: { v: "a {{features.secret}} b" },
      features: { secret: "leaked" },
    });
    const element = fixedText({ text: { $: "s.v" }, sizeX: 5 });
    const { elements: result, errors } = await expandTextBounds([element], ctx);

    // No write-back, so the engine cannot interpolate the value a second time.
    expect(result[0].text).toEqual({ $: "s.v" });
    expect(JSON.stringify(result[0])).not.toContain("leaked");
    // ...and the box grows on both axes as an auto element would.
    expect(result[0].sizeX).toBeGreaterThan(5);
    expect(errors).toHaveLength(1);
  });

  it("emits no warning for a normal fixed element", async () => {
    const { errors } = await expandTextBounds([fixedText()], makeCtx());
    expect(errors).toHaveLength(0);
  });

  it("emits no warning for an auto element carrying a template", async () => {
    const ctx = makeCtx({ s: { v: "a {{features.secret}} b" }, features: { secret: "x" } });
    const { errors } = await expandTextBounds(
      [fixedText({ text: { $: "s.v" }, textFlow: "auto" })],
      ctx,
    );
    expect(errors).toHaveLength(0);
  });
});
