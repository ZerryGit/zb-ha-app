/**
 * textFrame.test.js — Fixed-flow text frame canvas helpers.
 *
 * The overflow predicate is extracted from the JSX branch precisely so it can
 * be pinned here; the anchor-list assertion is what stands between the
 * eight-anchor decision and someone "tidying" the array back to four corners.
 */

import { describe, expect, it } from 'vitest';
import { TEXT_RESIZE_ANCHORS, textReserveOverflow } from '../textFrame.js';

describe('TEXT_RESIZE_ANCHORS', () => {
  it('has all eight anchors, including the height-only handles', () => {
    expect(TEXT_RESIZE_ANCHORS).toHaveLength(8);
    // top/bottom-center are the only handles that change the authored
    // minimum height without touching the width — they must stay in.
    expect(TEXT_RESIZE_ANCHORS).toContain('top-center');
    expect(TEXT_RESIZE_ANCHORS).toContain('bottom-center');
  });
});

describe('textReserveOverflow', () => {
  it('reports how far fixed content runs past the authored reserve', () => {
    expect(textReserveOverflow('fixed', 40, 58)).toBe(18);
  });

  it('reports no overflow when the content fits inside the reserve', () => {
    expect(textReserveOverflow('fixed', 60, 58)).toBe(0);
    expect(textReserveOverflow('fixed', 58, 58)).toBe(0);
  });

  it('never reports overflow for an auto element', () => {
    expect(textReserveOverflow('auto', 10, 999)).toBe(0);
    expect(textReserveOverflow(undefined, 10, 999)).toBe(0);
  });

  it('treats a garbage textFlow value as auto', () => {
    expect(textReserveOverflow('FIXED', 10, 999)).toBe(0);
    expect(textReserveOverflow(42, 10, 999)).toBe(0);
  });

  it('treats a missing reserve as zero rather than NaN', () => {
    expect(textReserveOverflow('fixed', undefined, 30)).toBe(30);
  });
});
