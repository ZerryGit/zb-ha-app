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
