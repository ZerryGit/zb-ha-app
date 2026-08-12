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
  textAnchorAxes,
  textClipHidden,
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

  it('never reports overflow without a declared reserve (0/absent = hug)', () => {
    // A minimum of 0 means "no reserve, hug the content" — there is nothing
    // to overflow, so the marker must not draw.
    expect(textReserveOverflow('fixed', 0, 30)).toBe(0);
    expect(textReserveOverflow('fixed', undefined, 30)).toBe(0);
  });

  it('never reports overflow for a locked box (clip has its own hint)', () => {
    expect(textReserveOverflow('clip', 20, 100)).toBe(0);
  });
});

describe('textClipHidden', () => {
  it('reports how much content is cut below a locked box', () => {
    expect(textClipHidden('clip', 40, 58)).toBe(18);
  });

  it('reports nothing when the content fits inside the box', () => {
    expect(textClipHidden('clip', 60, 58)).toBe(0);
    expect(textClipHidden('clip', 58, 58)).toBe(0);
  });

  it('reports nothing for a degenerate box — it shows all content instead', () => {
    // Mirrors the server: a locked box with sizeY <= 0 falls back to the
    // content height rather than clipping everything.
    expect(textClipHidden('clip', 0, 100)).toBe(0);
    expect(textClipHidden('clip', undefined, 100)).toBe(0);
  });

  it('never reports for non-clip modes', () => {
    expect(textClipHidden('fixed', 40, 100)).toBe(0);
    expect(textClipHidden('auto', 40, 100)).toBe(0);
    expect(textClipHidden(undefined, 40, 100)).toBe(0);
  });
});
