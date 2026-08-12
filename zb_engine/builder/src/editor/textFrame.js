/**
 * textFrame.js — Fixed-flow text frame helpers for the canvas
 *
 * Kept out of CanvasArea.jsx so the overflow decision and the anchor set are
 * plain callable values with their own tests — an inline comparison in a JSX
 * branch is precisely the thing that silently inverts.
 */

/**
 * Resize anchors for a text element: all four corners, the side handles that
 * author width alone, and top/bottom-center, which are the only handles that
 * change the authored minimum height without touching the width the user
 * just set. Do not trim this back to corners-only — height is authored on a
 * fixed element, so the handle set has to say so.
 */
export const TEXT_RESIZE_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/**
 * Which sizes a text resize gesture authors, from the Transformer anchor
 * being dragged: side handles author width alone, top/bottom-center author
 * height alone, corners author both. An unknown or missing anchor name
 * (older Konva, programmatic transform) falls back to both — the
 * pre-anchor-aware behaviour. Derived from the anchor, not from which scale
 * factor moved, because grid snapping can perturb the axis the user never
 * touched.
 *
 * @param {string|null|undefined} anchorName - Konva anchor name (e.g. "middle-left")
 * @returns {{ width: boolean, height: boolean }}
 */
export function textAnchorAxes(anchorName) {
  return {
    width: anchorName !== 'top-center' && anchorName !== 'bottom-center',
    height: anchorName !== 'middle-left' && anchorName !== 'middle-right',
  };
}

/**
 * The Min height to write after a width-only drag, or undefined to keep the
 * stored value. A frame that was HUGGING its content (auto mode, or a fixed
 * minimum within a pixel of the content height) keeps hugging at the new
 * width — otherwise narrowing a frame re-wraps the text taller than a
 * minimum the user never chose and strands the overflow marker mid-text. A
 * deliberate reserve (or deficit) is preserved: the marker reporting content
 * past a CHOSEN minimum is the feature working.
 *
 * @param {object} opts
 * @param {unknown} opts.textFlow - current mode; anything but "fixed" hugs by construction
 * @param {unknown} opts.sizeY - stored minimum height
 * @param {number|undefined} opts.oldContentHeight - wrapped content height at the old width
 * @param {number|undefined} opts.newContentHeight - wrapped content height at the new width
 * @returns {number|undefined} the minimum to write, or undefined to leave it alone
 */
export function minHeightAfterWidthDrag({ textFlow, sizeY, oldContentHeight, newContentHeight }) {
  if (typeof newContentHeight !== 'number') return undefined;
  if (textFlow === 'fixed') {
    if (typeof oldContentHeight !== 'number') return undefined;
    const stored = Number(sizeY);
    if (!Number.isFinite(stored) || Math.abs(stored - oldContentHeight) > 1) return undefined;
  }
  return newContentHeight;
}

/**
 * How far a text element's wrapped content runs past its authored minimum
 * height, in pixels. Only a fixed-flow element has a reserve to exceed;
 * anything else — auto, absent, or a garbage value — returns 0 (readers
 * coerce defensively: not exactly "fixed" means auto).
 *
 * The canvas draws the overflow band over exactly this region, and the
 * element's display box is `authored + overflow` = max(authored, content).
 * Both are computed at render time and never written to the store.
 *
 * @param {unknown} textFlow - the element's `textFlow` value
 * @param {number} authoredSizeY - resolved authored minimum height
 * @param {number} contentHeight - measured height of the wrapped content
 * @returns {number} pixels of overflow past the reserve (0 when none)
 */
export function textReserveOverflow(textFlow, authoredSizeY, contentHeight) {
  if (textFlow !== 'fixed') return 0;
  const reserve = Number(authoredSizeY) || 0;
  const content = Number(contentHeight) || 0;
  return Math.max(0, content - reserve);
}
