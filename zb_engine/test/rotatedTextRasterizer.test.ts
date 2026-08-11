/**
 * rotatedTextRasterizer.test.ts — Tests for out-of-engine rotated-text
 * pre-rasterization.
 *
 * Reproduces the user-reported bug: rotated text at a large font size
 * placed near a canvas edge disappears in the deployed render. The
 * frozen engine renders the un-rotated form into a canvas-sized temp
 * buffer, so glyphs landing past the canvas edge are silently dropped
 * before rotation. The pre-rasterizer detects this case, renders into
 * a local buffer the size of the bounding box, and composites the
 * rotated result onto the canvas after the engine pass.
 */

import { describe, it, expect } from "vitest";
import {
  preRasterizeRotatedText,
  compositeRotatedText,
} from "../src/data/rotatedTextRasterizer";
import { expandTextBounds } from "../src/data/textAutoSize";
import { Canvas } from "../src/engine/canvas";
import { fontsReady } from "../src/engine/fonts/fontManager";
import type { DataContext } from "@zb/expressions";

function makeCtx(): DataContext {
  return { misc: {}, features: {} };
}

function countBlackPixels(canvas: Canvas): number {
  let n = 0;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (canvas.getPixel(x, y) === 1) n++;
    }
  }
  return n;
}

describe("preRasterizeRotatedText", () => {
  it("leaves non-text elements untouched", async () => {
    const elements = [{ type: "rect", sizeX: 10, sizeY: 10 }];
    const { elements: out, preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );
    expect(out).toEqual(elements);
    expect(preRendered.size).toBe(0);
  });

  it("leaves un-rotated text to the engine path", async () => {
    const elements = [
      {
        type: "text",
        text: "Hello",
        pos: { x: 50, y: 50 },
        sizeX: 200,
        sizeY: 60,
        fontSize: 44,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 0,
        scale: { x: 1, y: 1 },
        origin: { x: 0, y: 0 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: true,
        enableFill: true,
      },
    ];
    const { preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );
    expect(preRendered.size).toBe(0);
  });

  it("leaves rotated text wholly inside the canvas to the engine path", async () => {
    const elements = [
      {
        type: "text",
        text: "Hello",
        pos: { x: 50, y: 50 },
        sizeX: 200,
        sizeY: 60,
        fontSize: 44,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 45,
        scale: { x: 1, y: 1 },
        origin: { x: 100, y: 30 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: true,
        enableFill: true,
      },
    ];
    const { preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );
    expect(preRendered.size).toBe(0);
  });

  it("intercepts rotated text whose un-rotated bounds exceed the canvas", async () => {
    await fontsReady;

    // pos.x + sizeX = 250 + 600 = 850 ≫ canvas width (320). The
    // engine path would render almost no pixels into its temp canvas
    // and the rotated output would be empty.
    const elements = [
      {
        type: "text",
        text: "Hello",
        pos: { x: 250, y: 100 },
        sizeX: 600,
        sizeY: 60,
        fontSize: 44,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 90,
        scale: { x: 1, y: 1 },
        // Rotation centre at world (260, 110) — well inside the canvas.
        origin: { x: 10, y: 10 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: true,
        enableFill: true,
      },
    ];

    const { elements: out, preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );

    expect(preRendered.size).toBe(1);
    // Original element is muted so the engine skips it.
    expect((out[0] as Record<string, unknown>).text).toBe("");
    expect((out[0] as Record<string, unknown>).rotationDeg).toBe(0);
    expect((out[0] as Record<string, unknown>).scale).toEqual({ x: 1, y: 1 });

    // Composite onto a fresh canvas and confirm pixels actually appear.
    const canvas = new Canvas(320, 240);
    compositeRotatedText(canvas, preRendered);
    const inkPixels = countBlackPixels(canvas);
    expect(inkPixels).toBeGreaterThan(0);
  });

  it("places composited rotated text near the rotation centre", async () => {
    await fontsReady;

    // Vertical text rotated 90° about a centre well inside the canvas.
    const elements = [
      {
        type: "text",
        text: "AB",
        pos: { x: 200, y: 100 },
        sizeX: 400,
        sizeY: 60,
        fontSize: 44,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 90,
        scale: { x: 1, y: 1 },
        origin: { x: 0, y: 0 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: true,
        enableFill: true,
      },
    ];

    const { preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );
    const canvas = new Canvas(320, 240);
    compositeRotatedText(canvas, preRendered);

    // After a 90° rotation about (200, 100) the un-rotated horizontal
    // text along x ≥ 200, y ≈ 100 maps onto a vertical strip that
    // straddles the rotation centre. Confirm ink lands in a broad
    // square around the centre rather than testing exact rotation
    // direction (which depends on coordinate-system handedness).
    let inkNearCentre = 0;
    for (let y = 80; y < 200; y++) {
      for (let x = 140; x < 260; x++) {
        if (canvas.getPixel(x, y) === 1) inkNearCentre++;
      }
    }
    expect(inkNearCentre).toBeGreaterThan(0);
  });

  it("clears fallbackText on the muted element so the engine does not render it", async () => {
    // Reproduces the bug where the engine's resolveText swaps in
    // `fallbackText` whenever `text === ""`. If we leave the default
    // `(no data)` fallback intact when muting the element, the engine
    // happily renders that fallback at the original (un-rotated)
    // position, producing a stray "(no data)" beside the rotated text.
    const elements = [
      {
        type: "text",
        text: "Hello",
        fallbackText: "(no data)",
        pos: { x: 250, y: 100 },
        sizeX: 600,
        sizeY: 60,
        fontSize: 44,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 90,
        scale: { x: 1, y: 1 },
        origin: { x: 10, y: 10 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: true,
        enableFill: true,
      },
    ];
    const { elements: out, preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );
    expect(preRendered.size).toBe(1);
    expect((out[0] as Record<string, unknown>).text).toBe("");
    expect((out[0] as Record<string, unknown>).fallbackText).toBe("");
  });

  it("pre-rasterizes a rotated fixed-flow element after the wrap pass", async () => {
    await fontsReady;

    // Pipeline order in renderService: the text layout pass wraps FIRST, the
    // rotated pre-raster runs after and receives the already-"\n"-broken
    // string. Its glyph loop handles "\n" like any authored break, so fixed
    // flow needs no code here — this test proves that claim instead of
    // assuming it.
    const elements = [
      {
        type: "text",
        text: "several words that wrap into a tall narrow column",
        textFlow: "fixed",
        // Un-rotated box leaves the canvas: 250 + 120 = 370 > 320.
        pos: { x: 250, y: 100 },
        sizeX: 120,
        sizeY: 20,
        fontSize: 24,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 90,
        scale: { x: 1, y: 1 },
        origin: { x: 10, y: 10 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: true,
        enableFill: true,
      },
    ] as Record<string, unknown>[];

    const { elements: wrapped, errors } = await expandTextBounds(elements, makeCtx());
    expect(errors).toEqual([]);

    const laid = wrapped[0] as Record<string, unknown>;
    expect(String(laid.text)).toContain("\n"); // the wrap actually fired
    expect(laid.sizeX).toBe(120); // authored width untouched
    expect(laid.sizeY as number).toBeGreaterThan(20); // grew past the minimum

    const { elements: out, preRendered } = await preRasterizeRotatedText(
      wrapped,
      makeCtx(),
      320,
      240,
    );

    expect(preRendered.size).toBe(1);
    expect((out[0] as Record<string, unknown>).text).toBe("");

    const canvas = new Canvas(320, 240);
    compositeRotatedText(canvas, preRendered);
    expect(countBlackPixels(canvas)).toBeGreaterThan(0);
  });

  it("does not intercept invisible text", async () => {
    const elements = [
      {
        type: "text",
        text: "Hello",
        pos: { x: 250, y: 100 },
        sizeX: 600,
        sizeY: 60,
        fontSize: 44,
        fontWeight: 400,
        fontFamily: "Sora",
        rotationDeg: 90,
        scale: { x: 1, y: 1 },
        origin: { x: 10, y: 10 },
        lineHeight: 1.2,
        textAlign: "left",
        fill: 100,
        opacity: 100,
        visible: false,
        enableFill: true,
      },
    ];
    const { preRendered } = await preRasterizeRotatedText(
      elements,
      makeCtx(),
      320,
      240,
    );
    expect(preRendered.size).toBe(0);
  });
});
