/**
 * bitmapFont.js — Bitmap font cache and renderer (platform-agnostic)
 *
 * Replicates the draw engine's text layout logic (src/engine/primitives/text.ts)
 * so the builder preview matches the server-rendered output pixel-for-pixel.
 *
 * This module is a pure cache + renderer with NO fetch() calls. Font data is
 * fed in by the platform layer via registerFontPack(). This keeps the module
 * platform-agnostic per ENGINEERING_CONSTRAINTS § Builder Structure.
 *
 * Usage:
 *   // Platform layer calls once at startup:
 *   import { registerFontPack, markFontsReady } from '../utils/bitmapFont.js';
 *   registerFontPack('sora-12-Light', fontJsonData);
 *   markFontsReady();
 *
 *   // Core components consume:
 *   import { renderBitmapText, fontsReady } from '../utils/bitmapFont.js';
 *   const canvas = renderBitmapText({ text, width, height, fontSize, ... });
 */

import { layoutTextElement, measureLineVisual } from '@shared/textLayout';

// ── Types (mirrors src/engine/fonts/fontTypes.ts) ──────────────

/**
 * @typedef {{ codePoint: number, width: number, height: number,
 *             xOffset: number, yOffset: number, xAdvance: number,
 *             baseline: number, pixels: Uint8Array }} DecodedGlyph
 *
 * @typedef {{ font: string, familyName: string, variant: string,
 *             fontSize: number, lineHeight: number, letterSpacing: number,
 *             glyphCount: number }} FontMeta
 *
 * @typedef {{ meta: FontMeta, glyphs: Map<string, DecodedGlyph> }} FontPack
 */

// ── Font cache ─────────────────────────────────────────────────

/** @type {Map<string, FontPack>} key = "family-size-Weight" */
const fontCache = new Map();

/** @type {string[]} Available font families (lowercase). */
const availableFamilies = [];

/** @type {number[]} Available font sizes (sorted ascending). */
const availableSizes = [];

let initialized = false;

// ── Decoding ───────────────────────────────────────────────────

/**
 * Decode a base64-encoded 1-bit glyph bitmap into a Uint8Array.
 * @param {string} base64 - base64-encoded bitmap data
 * @returns {Uint8Array}
 */
function decodeBase64(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Parse a raw font JSON object into a FontPack with decoded glyphs.
 * @param {object} raw - The parsed font JSON
 * @returns {FontPack}
 */
function parseFontJson(raw) {
  const meta = {
    font: raw.font,
    familyName: raw.familyName,
    variant: raw.variant,
    fontSize: raw.fontSize,
    lineHeight: raw.lineHeight,
    letterSpacing: raw.letterSpacing,
    glyphCount: raw.glyphCount,
  };

  const glyphs = new Map();
  for (const [char, g] of Object.entries(raw.glyphs)) {
    glyphs.set(char, {
      codePoint: g.codePoint,
      width: g.width,
      height: g.height,
      xOffset: g.xOffset,
      yOffset: g.yOffset,
      xAdvance: g.xAdvance,
      baseline: g.baseline,
      pixels: decodeBase64(g.bitmap),
    });
  }

  return { meta, glyphs };
}

// ── Weight/size snapping (mirrors fontManager.ts) ──────────────

const WEIGHT_ANCHORS = [
  { value: 300, name: 'Light' },
  { value: 400, name: 'Regular' },
  { value: 600, name: 'SemiBold' },
  { value: 800, name: 'ExtraBold' },
];

function snapWeight(numericWeight) {
  let best = WEIGHT_ANCHORS[0];
  let bestDist = Math.abs(numericWeight - best.value);
  for (let i = 1; i < WEIGHT_ANCHORS.length; i++) {
    const d = Math.abs(numericWeight - WEIGHT_ANCHORS[i].value);
    if (d < bestDist) { best = WEIGHT_ANCHORS[i]; bestDist = d; }
  }
  return best.name;
}

function snapSize(requested) {
  if (availableSizes.length === 0) return requested;
  let best = availableSizes[0];
  let bestDist = Math.abs(requested - best);
  for (let i = 1; i < availableSizes.length; i++) {
    const d = Math.abs(requested - availableSizes[i]);
    if (d < bestDist) { best = availableSizes[i]; bestDist = d; }
  }
  return best;
}

// ── Font resolution ────────────────────────────────────────────

/**
 * Get a loaded font pack by family, size, and weight.
 * Falls back via size-snapping + weight-snapping, then cross-family.
 * @param {string} fontFamily
 * @param {number} fontSize
 * @param {number} fontWeight
 * @returns {FontPack|null}
 */
function getFont(fontFamily, fontSize, fontWeight) {
  if (!initialized) return null;

  const family = (fontFamily || '').trim().toLowerCase();
  const resolvedFamily = availableFamilies.includes(family)
    ? family
    : (availableFamilies[0] || 'sora');
  const size = snapSize(fontSize);
  const weight = snapWeight(fontWeight);
  const key = `${resolvedFamily}-${size}-${weight}`;

  const exact = fontCache.get(key);
  if (exact) return exact;

  // Cross-family fallback (same weight)
  for (const fam of availableFamilies) {
    const fallbackKey = `${fam}-${size}-${weight}`;
    const candidate = fontCache.get(fallbackKey);
    if (candidate) return candidate;
  }

  // Weight fallback — try other weights at the same size, closest first.
  // Handles cases like 12px where Regular doesn't exist but Light does.
  const weightNames = WEIGHT_ANCHORS.map((a) => a.name);
  const requestedIdx = weightNames.indexOf(weight);
  for (let offset = 1; offset < weightNames.length; offset++) {
    for (const dir of [-1, 1]) {
      const idx = requestedIdx + dir * offset;
      if (idx < 0 || idx >= weightNames.length) continue;
      const altWeight = weightNames[idx];
      // Try resolved family first, then all families
      const altKey = `${resolvedFamily}-${size}-${altWeight}`;
      const alt = fontCache.get(altKey);
      if (alt) return alt;
      for (const fam of availableFamilies) {
        const altFamKey = `${fam}-${size}-${altWeight}`;
        const altFam = fontCache.get(altFamKey);
        if (altFam) return altFam;
      }
    }
  }

  return null;
}

// ── Registration API (called by the platform layer) ────────────

/**
 * Register a single font pack from its raw JSON data.
 * The key follows the convention: "family-size-Weight" (e.g. "sora-12-Light").
 * @param {string} key - Cache key
 * @param {object} rawJson - The parsed font JSON object
 */
export function registerFontPack(key, rawJson) {
  const pack = parseFontJson(rawJson);
  fontCache.set(key, pack);

  // Maintain family and size lookups
  const parts = key.split('-');
  if (parts.length >= 3) {
    const family = parts[0];
    const size = parseInt(parts[1], 10);
    if (!availableFamilies.includes(family)) availableFamilies.push(family);
    if (!availableSizes.includes(size)) {
      availableSizes.push(size);
      availableSizes.sort((a, b) => a - b);
    }
  }
}

/**
 * Signal that all font packs have been registered.
 * Call this after the last registerFontPack() call.
 * Triggers a re-render for any components waiting on fontsReady().
 */
export function markFontsReady() {
  initialized = true;
  availableFamilies.sort();
}

/** @returns {boolean} Whether fonts have been fully loaded and registered. */
export function fontsReady() {
  return initialized;
}

// ── Text measurement ───────────────────────────────────────────

/**
 * Measure the pixel width of a single line of text using bitmap font metrics.
 * Mirrors the engine's line-width calculation in text.ts.
 * @param {string} line
 * @param {FontPack} font
 * @returns {number}
 */
function measureLine(line, font) {
  let width = 0;
  for (const char of line) {
    const glyph = font.glyphs.get(char);
    if (glyph) {
      width += glyph.xAdvance + font.meta.letterSpacing;
    } else {
      const space = font.glyphs.get(' ');
      width += space?.xAdvance ?? Math.round(font.meta.fontSize * 0.3);
    }
  }
  if (line.length > 0) width -= font.meta.letterSpacing;
  return width;
}

/**
 * Measure the bounding box required to render a text string.
 * Returns { width, height } in pixels, with a small padding margin.
 *
 * @param {object} opts
 * @param {string} opts.text - The text to measure
 * @param {number} opts.fontSize - Font size in pixels
 * @param {number} [opts.fontWeight=400] - Numeric font weight
 * @param {string} [opts.fontFamily='Sora'] - Font family
 * @param {number} [opts.lineHeight=1.2] - Line height multiplier
 * @returns {{ width: number, height: number } | null} Null if fonts are unavailable
 */
export function measureTextBounds({ text, fontSize, fontWeight = 400, fontFamily = 'Sora', lineHeight = 1.2 }) {
  if (!text) return { width: 10, height: Math.round(fontSize * lineHeight) };

  const font = getFont(fontFamily, fontSize, fontWeight);
  if (!font) return null;

  const lines = String(text).split('\n');
  const lineSpacing = Math.round(fontSize * lineHeight);

  let maxLineWidth = 0;
  for (const line of lines) {
    const w = measureLineVisual(line, font);
    if (w > maxLineWidth) maxLineWidth = w;
  }

  // Padding: small horizontal margin so text doesn't clip at edges
  const padding = 4;
  return {
    width: maxLineWidth + padding,
    height: lines.length * lineSpacing + padding,
  };
}

/**
 * Measure — and, for fixed-flow elements, wrap — a text element's resolved
 * string through the shared layout module, using the same snapped font pack
 * the canvas renders with.
 *
 * The line-break decision itself lives in `@shared/textLayout` (the server
 * pre-render pass runs the identical code); this wrapper only resolves the
 * font. Returns the content box: for `fixed` elements the caller displays
 * `max(authored sizeY, height)` and stores nothing.
 *
 * @param {object} opts
 * @param {string} opts.text - The resolved display text
 * @param {number} opts.fontSize
 * @param {number} [opts.fontWeight=400]
 * @param {string} [opts.fontFamily='Sora']
 * @param {number} [opts.lineHeight=1.2]
 * @param {unknown} [opts.textFlow] - `"fixed"` wraps to `sizeX`; anything else measures only
 * @param {number} [opts.sizeX] - Authored frame width, read only in fixed mode
 * @returns {{ text: string, width: number, height: number } | null} Null if fonts are unavailable
 */
export function layoutTextBounds({
  text,
  fontSize,
  fontWeight = 400,
  fontFamily = 'Sora',
  lineHeight = 1.2,
  textFlow,
  sizeX,
}) {
  const font = getFont(fontFamily, fontSize, fontWeight);
  if (!font) return null;

  const result = layoutTextElement({
    text: text == null ? '' : String(text),
    font,
    fontSize,
    lineHeight,
    textFlow,
    sizeX,
  });

  return { text: result.text, width: result.contentWidth, height: result.contentHeight };
}

// ── Text rendering to HTMLCanvasElement ─────────────────────────

/**
 * Render a text string using bitmap fonts onto an offscreen HTMLCanvasElement.
 * This exactly mirrors the engine's drawText() logic from text.ts.
 *
 * @param {object} opts
 * @param {string} opts.text - The text string to render
 * @param {number} opts.width - Bounding box width in pixels
 * @param {number} opts.height - Bounding box height in pixels
 * @param {number} opts.fontSize - Font size in pixels
 * @param {number} [opts.fontWeight=400] - Numeric font weight
 * @param {string} [opts.fontFamily='Sora'] - Font family name
 * @param {string} [opts.textAlign='left'] - Text alignment: 'left', 'center', 'right'
 * @param {number} [opts.lineHeight=1.0] - Line height multiplier
 * @param {string} [opts.color='#000000'] - Fill color (hex or CSS)
 * @returns {HTMLCanvasElement|null} The canvas with rendered text, or null if fonts unavailable
 */
export function renderBitmapText({
  text,
  width,
  height,
  fontSize,
  fontWeight = 400,
  fontFamily = 'Sora',
  textAlign = 'left',
  lineHeight = 1.0,
  color = '#000000',
}) {
  if (!text || width <= 0 || height <= 0) return null;

  const font = getFont(fontFamily, fontSize, fontWeight);
  if (!font) return null;

  const w = Math.round(width);
  const h = Math.round(height);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Create an ImageData to blit pixels into
  const imageData = ctx.createImageData(w, h);
  const data = imageData.data; // RGBA flat array

  // Parse fill color to RGB
  const rgb = parseColor(color);

  const sampleGlyph = font.glyphs.values().next().value;
  const baseline = sampleGlyph?.baseline ?? Math.round(fontSize * 0.75);

  const lines = String(text).split('\n');
  const lineSpacing = Math.round(fontSize * lineHeight);

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const lineY = lineIdx * lineSpacing;

    if (lineY >= h) break;

    // Measure line width for alignment
    let lineWidth = measureLine(line, font);

    let cursorX;
    if (textAlign === 'center') {
      cursorX = Math.round((w - lineWidth) / 2);
    } else if (textAlign === 'right') {
      cursorX = w - lineWidth;
    } else {
      cursorX = 0;
    }

    for (const char of line) {
      const glyph = font.glyphs.get(char);
      if (!glyph) {
        const spaceGlyph = font.glyphs.get(' ');
        cursorX += spaceGlyph?.xAdvance ?? Math.round(fontSize * 0.3);
        continue;
      }

      if (cursorX >= w) break;

      // Blit glyph pixels, clipped to bounding box
      blitGlyphToImageData(
        data, w, h, glyph,
        cursorX, lineY + baseline - glyph.baseline,
        rgb,
        0, 0, w, h,
      );

      cursorX += glyph.xAdvance + font.meta.letterSpacing;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Blit a decoded glyph's 1-bit bitmap into an RGBA ImageData buffer.
 * Mirrors glyphRenderer.ts blitGlyphClipped, adapted for RGBA output.
 */
function blitGlyphToImageData(data, imgW, imgH, glyph, x, y, rgb, clipX, clipY, clipW, clipH) {
  const gx = Math.round(x + glyph.xOffset);
  const gy = Math.round(y + glyph.yOffset);
  const stride = Math.ceil(glyph.width / 8);
  const clipRight = clipX + clipW;
  const clipBottom = clipY + clipH;

  for (let row = 0; row < glyph.height; row++) {
    const py = gy + row;
    if (py < clipY || py >= clipBottom || py < 0 || py >= imgH) continue;

    for (let col = 0; col < glyph.width; col++) {
      const px = gx + col;
      if (px < clipX || px >= clipRight || px < 0 || px >= imgW) continue;

      const byteIdx = row * stride + (col >> 3);
      const bitIdx = 7 - (col & 7);
      const isInk = (glyph.pixels[byteIdx] >> bitIdx) & 1;

      if (isInk) {
        const idx = (py * imgW + px) * 4;
        data[idx] = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
  }
}

/**
 * Parse a color string to [r, g, b].
 * Accepts hex (`#rgb`, `#rrggbb`) and CSS `rgb()`/`rgba()` notation with either
 * space- or comma-separated channels. The canvas passes gray fills produced by
 * ditherPercentToGray() (e.g. "rgb(128 128 128)"), so rgb() support is required
 * for text to reflect its dither/fill level instead of always rendering black.
 * @param {string} color
 * @returns {number[]}
 */
export function parseColor(color) {
  if (typeof color !== 'string') return [0, 0, 0];

  const trimmed = color.trim();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      return [
        parseInt(hex[0] + hex[0], 16),
        parseInt(hex[1] + hex[1], 16),
        parseInt(hex[2] + hex[2], 16),
      ];
    }
    if (hex.length === 6) {
      return [
        parseInt(hex.slice(0, 2), 16),
        parseInt(hex.slice(2, 4), 16),
        parseInt(hex.slice(4, 6), 16),
      ];
    }
  }

  // rgb()/rgba() — channels may be separated by commas and/or whitespace.
  const rgbMatch = trimmed.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].trim().split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const channel = (s) => {
        const n = s.endsWith('%')
          ? Math.round((parseFloat(s) / 100) * 255)
          : parseFloat(s);
        return Number.isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : 0;
      };
      return [channel(parts[0]), channel(parts[1]), channel(parts[2])];
    }
  }

  // Fallback: black
  return [0, 0, 0];
}
