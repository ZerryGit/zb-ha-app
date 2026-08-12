/**
 * textFrame.test.js — Fixed-flow text frame canvas helpers.
 *
 * The overflow predicate is extracted from the JSX branch precisely so it can
 * be pinned here; the anchor-list assertion is what stands between the
 * eight-anchor decision and someone "tidying" the array back to four corners.
 */

import { describe, expect, it } from 'vitest';
import {
  TEXT_RESIZE_ANCHORS,
  minHeightAfterWidthDrag,
  textAnchorAxes,
  textReserveOverflow,
} from '../textFrame.js';

describe('TEXT_RESIZE_ANCHORS', () => {
  it('has all eight anchors, including the height-only handles', () => {
    expect(TEXT_RESIZE_ANCHORS).toHaveLength(8);
    // top/bottom-center are the only handles that change the authored
    // minimum height without touching the width — they must stay in.
    expect(TEXT_RESIZE_ANCHORS).toContain('top-center');
    expect(TEXT_RESIZE_ANCHORS).toContain('bottom-center');
  });
});

describe('textAnchorAxes', () => {
  it('side handles author width alone', () => {
    expect(textAnchorAxes('middle-left')).toEqual({ width: true, height: false });
    expect(textAnchorAxes('middle-right')).toEqual({ width: true, height: false });
  });

  it('vertical handles author height alone', () => {
    expect(textAnchorAxes('top-center')).toEqual({ width: false, height: true });
    expect(textAnchorAxes('bottom-center')).toEqual({ width: false, height: true });
  });

  it('corners author both', () => {
    for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
      expect(textAnchorAxes(corner)).toEqual({ width: true, height: true });
    }
  });

  it('falls back to both for an unknown or missing anchor', () => {
    expect(textAnchorAxes(null)).toEqual({ width: true, height: true });
    expect(textAnchorAxes(undefined)).toEqual({ width: true, height: true });
  });
});

describe('minHeightAfterWidthDrag', () => {
  it('keeps an auto frame hugging at the new width', () => {
    expect(minHeightAfterWidthDrag({
      textFlow: 'auto', sizeY: 40, oldContentHeight: 40, newContentHeight: 96,
    })).toBe(96);
  });

  it('keeps a hugging fixed frame hugging (within the one-pixel write threshold)', () => {
    expect(minHeightAfterWidthDrag({
      textFlow: 'fixed', sizeY: 40.6, oldContentHeight: 40, newContentHeight: 96,
    })).toBe(96);
  });

  it('preserves a deliberate reserve taller than the content', () => {
    expect(minHeightAfterWidthDrag({
      textFlow: 'fixed', sizeY: 300, oldContentHeight: 200, newContentHeight: 250,
    })).toBeUndefined();
  });

  it('preserves an existing deficit (minimum already below content)', () => {
    expect(minHeightAfterWidthDrag({
      textFlow: 'fixed', sizeY: 100, oldContentHeight: 200, newContentHeight: 250,
    })).toBeUndefined();
  });

  it('leaves the minimum alone when either content height is unknown', () => {
    expect(minHeightAfterWidthDrag({
      textFlow: 'fixed', sizeY: 40, oldContentHeight: undefined, newContentHeight: 96,
    })).toBeUndefined();
    expect(minHeightAfterWidthDrag({
      textFlow: 'fixed', sizeY: 40, oldContentHeight: 40, newContentHeight: undefined,
    })).toBeUndefined();
  });

  it('treats a non-numeric stored minimum as not hugging', () => {
    expect(minHeightAfterWidthDrag({
      textFlow: 'fixed', sizeY: { $: 'src.h' }, oldContentHeight: 40, newContentHeight: 96,
    })).toBeUndefined();
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
