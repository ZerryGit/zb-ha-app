/**
 * ImagePreview.jsx — Konva component for rendering img/svg elements on the canvas
 *
 * Renders a preview of image and SVG elements that matches the render engine's
 * 1-bit output (threshold/dither, fill silhouette, morphological stroke band)
 * rather than the raw full-color source. Shows a placeholder rectangle when the
 * source is empty or fails to load.
 *
 * Pipeline:
 *   1. Load src URL (img) or inline/url SVG (svg) into an HTMLImageElement.
 *   2. Convert it to a 1-bit HTMLCanvasElement via utils/oneBitImage.js, which
 *      mirrors src/engine/primitives/{img,svg}.ts exactly.
 *   3. Draw the converted canvas through <KonvaImage>.
 * Falls back to the raw image when pixel conversion is impossible (e.g. a
 * cross-origin source taints the canvas), so the element still displays.
 *
 * NOTE on http(s) sources: the builder page is served with
 * `img-src 'self' data: blob:`, so the browser refuses every cross-origin image
 * before a request is made. Such elements can never preview here, however
 * healthy the server-side render is — see `placeholderLabel`, which says so
 * rather than reporting a load failure. The load is still attempted, so a
 * future same-origin image proxy would start working with no change here.
 */

import { useEffect, useRef, useState } from 'react';
import { Group, Image as KonvaImage, Line, Rect, Text } from 'react-konva';
import { renderImage1bit, renderSvg1bit } from '../utils/oneBitImage.js';

/**
 * Load an image from a URL, returning a promise of the HTMLImageElement.
 * @param {string} url
 * @returns {Promise<HTMLImageElement>}
 */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = url;
  });
}

/**
 * Convert inline SVG content to a blob URL for rendering.
 *
 * When an SVG is loaded as a standalone document (via a blob URL into an
 * HTMLImageElement), the browser requires xmlns on the root <svg> element.
 * SVGs designed for HTML inline embedding often omit it, which causes
 * the browser to treat the document as plain XML and fire onerror.
 * Injects xmlns if absent.
 *
 * @param {string} svgContent
 * @returns {string}
 */
function svgToBlobUrl(svgContent) {
  let content = svgContent;
  const svgTagStart = content.indexOf('<svg');
  if (svgTagStart !== -1) {
    const openEnd = content.indexOf('>', svgTagStart);
    if (openEnd !== -1 && !content.slice(svgTagStart, openEnd).includes('xmlns=')) {
      // Insert xmlns immediately after "<svg" so existing attributes are preserved
      content =
        content.slice(0, svgTagStart + 4) +
        ' xmlns="http://www.w3.org/2000/svg"' +
        content.slice(svgTagStart + 4);
    }
  }
  const blob = new Blob([content], { type: 'image/svg+xml;charset=utf-8' });
  return URL.createObjectURL(blob);
}

/**
 * Parse the viewBox dimensions from an SVG string.
 * Returns { vbW, vbH } in user units, or null if absent/unparseable.
 * Used as the SVG's intrinsic aspect ratio for the engine's `fit: contain`
 * letterbox (browser naturalWidth/Height is unreliable for viewBox-only SVGs).
 *
 * @param {string} svgContent
 * @returns {{ vbW: number, vbH: number } | null}
 */
function parseSvgViewBox(svgContent) {
  const match = svgContent.match(/viewBox\s*=\s*["'][\s,]*[\d.+-]+[\s,]+[\d.+-]+[\s,]+([\d.+-]+)[\s,]+([\d.+-]+)["']/i);
  if (!match) return null;
  const vbW = parseFloat(match[1]);
  const vbH = parseFloat(match[2]);
  if (!isFinite(vbW) || !isFinite(vbH) || vbW <= 0 || vbH <= 0) return null;
  return { vbW, vbH };
}

/** Placeholder label metrics — approximate, only used to pick a label that fits. */
const LABEL_FONT_SIZE = 11;
const LABEL_CHAR_WIDTH = 5.6;
const LABEL_LINE_HEIGHT = 13;

const URL_PREVIEW_LABEL = 'Preview unavailable in editor — check the rendered widget';
const URL_PREVIEW_LABEL_SHORT = 'Preview unavailable';

/**
 * Line count for a label under Konva's word wrap. Character width is an
 * approximation, but the greedy word-boundary walk is not: dividing length by
 * line capacity would under-count (a word that does not fit starts a new line,
 * leaving the previous one short), and under-counting is what lets a label
 * clip.
 */
function estimateWrappedLines(text, width) {
  const charsPerLine = Math.max(1, Math.floor(width / LABEL_CHAR_WIDTH));
  let lines = 1;
  let used = 0;

  for (const word of text.split(' ')) {
    if (used === 0) used = word.length;
    else if (used + 1 + word.length <= charsPerLine) used += 1 + word.length;
    else {
      lines += 1;
      used = word.length;
    }
    // A word wider than the line breaks mid-word.
    while (used > charsPerLine) {
      lines += 1;
      used -= charsPerLine;
    }
  }

  return lines;
}

/** Whether a wrapped label fits the element box. */
function labelFits(text, width, height) {
  return estimateWrappedLines(text, width) * LABEL_LINE_HEIGHT <= height;
}

/**
 * Whether this element's source is a literal http(s) URL — the case the
 * builder page's CSP (`img-src 'self' data: blob:`) refuses outright, so
 * `onerror` fires before the URL is ever requested. An inline SVG goes through
 * a blob URL and an `asset:` token has already been resolved to a same-origin
 * path by the caller; both load normally, so their failures are real.
 */
export function isHttpUrlSource(elementType, src, svgData) {
  if (elementType === 'svg' && svgData) return false;
  return typeof src === 'string' && /^https?:\/\//i.test(src.trim());
}

/**
 * The placeholder label for the current state.
 *
 * A URL-sourced image cannot be previewed here no matter what the server does,
 * so reporting "load failed" invites the user to debug a working widget. The
 * label states only what this side can know: the editor cannot show it, and
 * the rendered widget is where to look. It must NOT promise the render will
 * succeed — CSP blocks before a request is made, so an unlisted private IP, a
 * host outside `allowed_source_domains`, and a plain 404 all look identical
 * from here.
 *
 * (A future same-origin image proxy would make these loads succeed, and this
 * branch would simply stop being reached.)
 */
export function placeholderLabel({ elementType, src, svgData, loadFailed, width, height }) {
  if (!loadFailed) return elementType === 'svg' ? '📐 SVG' : '🖼️ Image';

  if (isHttpUrlSource(elementType, src, svgData)) {
    if (labelFits(URL_PREVIEW_LABEL, width, height)) return URL_PREVIEW_LABEL;
    if (labelFits(URL_PREVIEW_LABEL_SHORT, width, height)) return URL_PREVIEW_LABEL_SHORT;
    // Too small for any honest wording — the dashed box alone is better than
    // a truncated sentence.
    return '';
  }

  return elementType === 'svg' ? 'SVG load failed' : 'Image load failed';
}

/**
 * Placeholder — dashed rectangle with type label, shown when no image is available.
 */
function Placeholder({ width, height, label }) {
  return (
    <Group>
      <Rect
        width={width}
        height={height}
        fill="#f5f5f5"
        stroke="#999"
        strokeWidth={1}
        dash={[4, 4]}
      />
      {/* Diagonal cross lines */}
      <Line points={[0, 0, width, height]} stroke="#ccc" strokeWidth={1} listening={false} />
      <Line points={[width, 0, 0, height]} stroke="#ccc" strokeWidth={1} listening={false} />
      {label ? (
        <Text
          x={0}
          y={0}
          width={width}
          // Centre the whole block vertically so a wrapped two- or three-line
          // label sits in the box the same way the one-line labels do.
          height={height}
          verticalAlign="middle"
          text={label}
          fontSize={LABEL_FONT_SIZE}
          fontFamily="system-ui, sans-serif"
          fill="#999"
          align="center"
          listening={false}
        />
      ) : null}
    </Group>
  );
}

/**
 * ImagePreview — renders img or svg elements on the Konva canvas as 1-bit.
 *
 * Props (spread from getCommonNodeProps + element data):
 * @param {object} props
 * @param {string} props.elementType - 'img' or 'svg'
 * @param {string} [props.src] - URL source (for img or svg-from-url)
 * @param {string} [props.svgData] - Inline SVG content (for svg elements)
 * @param {number} props.width - Display width
 * @param {number} props.height - Display height
 * @param {number} [props.posX] - Element artboard X (aligns dither phase to the engine)
 * @param {number} [props.posY] - Element artboard Y
 * @param {string} [props.bwMode] - 'threshold' | 'dither'
 * @param {number} [props.bwLevel] - Black/white level 0–100
 * @param {boolean} [props.enableFill] - Fill the shape silhouette (svg only)
 * @param {number} [props.fill] - Fill dither intensity 0–100 (svg only)
 * @param {boolean} [props.enableStroke] - Whether to render a stroke outline (svg only)
 * @param {number} [props.strokeDither] - Stroke intensity 0–100 (svg only)
 * @param {number} [props.strokeWidth] - Stroke width in px (svg only)
 * @param {string} [props.strokePosition] - 'inside'|'outside'|'center' (svg only)
 */
export default function ImagePreview({
  elementType,
  src,
  svgData,
  width,
  height,
  posX = 0,
  posY = 0,
  bwMode = 'threshold',
  bwLevel = 50,
  enableFill = false,
  fill = 100,
  enableStroke = false,
  strokeDither = 100,
  strokeWidth = 1,
  strokePosition = 'center',
}) {
  const [image, setImage] = useState(null);
  // The 1-bit converted canvas (null until ready, or when conversion is skipped/failed).
  const [processed, setProcessed] = useState(null);
  // Tracks whether the most recent load attempt ended in an error, so the
  // placeholder can show a distinct "failed" label instead of the generic empty one.
  const [loadFailed, setLoadFailed] = useState(false);
  const blobUrlRef = useRef(null);
  const imageRef = useRef(null);
  // Debounce timer for inline SVG loads — prevents a blob URL creation/revoke
  // cascade on every keystroke while the user is editing the SVG textarea.
  const debounceRef = useRef(null);

  // ── Load the source into an HTMLImageElement ──────────────────
  useEffect(() => {
    setLoadFailed(false);

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }

    let cancelled = false;

    async function load() {
      let url = '';

      if (elementType === 'svg' && svgData) {
        // Inline SVG → blob URL. No stroke filter is injected here: the stroke
        // band (and fill silhouette) are composited in pixel space by
        // renderSvg1bit, matching the engine exactly.
        const blobUrl = svgToBlobUrl(svgData);
        blobUrlRef.current = blobUrl;
        url = blobUrl;
      } else if (src) {
        url = src;
      }

      if (!url) {
        if (!cancelled) setImage(null);
        return;
      }

      try {
        const img = await loadImage(url);
        if (!cancelled) setImage(img);
      } catch {
        if (!cancelled) {
          setImage(null);
          setLoadFailed(true);
        }
      }
    }

    // Debounce inline SVG loads to absorb rapid updates while the user edits the
    // SVG textarea. URL-based sources only change on explicit user action.
    if (elementType === 'svg' && svgData) {
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        load();
      }, 300);
    } else {
      load();
    }

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [elementType, src, svgData]);

  // ── Convert the loaded image to 1-bit (mirrors the engine) ────
  useEffect(() => {
    if (!image) {
      setProcessed(null);
      return;
    }

    let canvas = null;
    if (elementType === 'svg') {
      const vb = svgData ? parseSvgViewBox(svgData) : null;
      canvas = renderSvg1bit({
        image,
        width,
        height,
        intrinsicW: vb?.vbW ?? 0,
        intrinsicH: vb?.vbH ?? 0,
        posX,
        posY,
        bwMode,
        bwLevel,
        enableFill,
        fill,
        enableStroke,
        strokeDither,
        strokeWidth,
        strokePosition,
      });
    } else {
      canvas = renderImage1bit({
        image,
        width,
        height,
        posX,
        posY,
        bwMode,
        bwLevel,
      });
    }

    // canvas is null when conversion is impossible (e.g. a cross-origin source
    // taints the canvas); fall through to the raw-image fallback in render.
    setProcessed(canvas);
  }, [
    image,
    elementType,
    svgData,
    width,
    height,
    posX,
    posY,
    bwMode,
    bwLevel,
    enableFill,
    fill,
    enableStroke,
    strokeDither,
    strokeWidth,
    strokePosition,
  ]);

  // Force Konva to redraw when the converted canvas changes.
  useEffect(() => {
    imageRef.current?.getLayer()?.batchDraw();
  }, [processed]);

  if (!image) {
    const label = placeholderLabel({ elementType, src, svgData, loadFailed, width, height });
    return <Placeholder width={width} height={height} label={label} />;
  }

  // Prefer the 1-bit conversion; fall back to the raw image only when conversion
  // was not possible (keeps cross-origin sources visible).
  return (
    <KonvaImage
      ref={imageRef}
      image={processed ?? image}
      width={width}
      height={height}
      listening={false}
    />
  );
}
