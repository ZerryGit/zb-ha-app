/**
 * truncateName.js — Widget-name truncation for the pairing QR payload
 *
 * The QR JSON contract (mobile app / cloud, `v: 1`) caps `name` at
 * QR_NAME_MAX characters TOTAL: longer names are cut to QR_NAME_MAX - 3
 * characters with a literal `...` appended, so the result never exceeds
 * QR_NAME_MAX. Pure string helper — no editor state, no side effects.
 */

/** Maximum total length of the `name` field in the QR payload. */
export const QR_NAME_MAX = 50;

/**
 * Truncate a widget name for the QR payload.
 *
 * @param {string} name  Widget name (non-strings coerce to '').
 * @param {number} [max] Total-length cap, including the `...` suffix.
 * @returns {string} The name unchanged when within the cap, otherwise
 *   the first `max - 3` characters plus `...`.
 */
export function truncateName(name, max = QR_NAME_MAX) {
  const s = typeof name === 'string' ? name : '';
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}
