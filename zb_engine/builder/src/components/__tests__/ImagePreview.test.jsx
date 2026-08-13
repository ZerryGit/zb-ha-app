/**
 * ImagePreview.test.jsx — placeholder label selection
 *
 * The builder page's CSP (`img-src 'self' data: blob:`) blocks every
 * cross-origin image, so a URL-sourced element always fails to load in the
 * editor even when the device render is perfect. The label has to distinguish
 * that from a genuine failure.
 */

import { describe, it, expect } from 'vitest';
import { isHttpUrlSource, placeholderLabel } from '../ImagePreview.jsx';

/** A comfortably sized element — the 96x96 default is bigger than this. */
const ROOMY = { width: 200, height: 120 };

describe('isHttpUrlSource', () => {
  it.each([
    'http://192.168.1.50/snapshot.jpg',
    'https://example.com/logo.png',
    'HTTPS://EXAMPLE.COM/logo.png',
    '  https://example.com/logo.png  ',
  ])('treats %s as a URL source', (src) => {
    expect(isHttpUrlSource('img', src, undefined)).toBe(true);
  });

  it.each([
    ['a resolved asset path', './api/assets/logo.png/raw'],
    ['a parent-relative asset path', '../api/assets/logo.png/raw'],
    ['an unresolved asset token', 'asset:logo.png'],
    ['a data URI', 'data:image/png;base64,iVBORw0KGgo='],
    ['an empty string', ''],
  ])('does not treat %s as a URL source', (_label, src) => {
    expect(isHttpUrlSource('img', src, undefined)).toBe(false);
  });

  it('does not treat a binding object as a URL source', () => {
    expect(isHttpUrlSource('img', { $: 'sources.s1.url' }, undefined)).toBe(false);
    expect(isHttpUrlSource('img', undefined, undefined)).toBe(false);
  });

  it('treats an svg element with a url src as a URL source', () => {
    expect(isHttpUrlSource('svg', 'https://example.com/icon.svg', undefined)).toBe(true);
    expect(isHttpUrlSource('svg', 'https://example.com/icon.svg', '')).toBe(true);
  });

  it('does not treat inline SVG content as a URL source — it loads via a blob URL', () => {
    expect(isHttpUrlSource('svg', 'https://example.com/icon.svg', '<svg/>')).toBe(false);
    expect(isHttpUrlSource('svg', undefined, '<svg/>')).toBe(false);
  });
});

describe('placeholderLabel — nothing loaded yet', () => {
  it('shows the neutral type label before any failure', () => {
    expect(placeholderLabel({ elementType: 'img', src: '', loadFailed: false, ...ROOMY }))
      .toBe('🖼️ Image');
    expect(placeholderLabel({ elementType: 'svg', src: '', loadFailed: false, ...ROOMY }))
      .toBe('📐 SVG');
  });

  it('keeps the neutral label for a URL source that has not failed', () => {
    expect(
      placeholderLabel({
        elementType: 'img',
        src: 'https://example.com/a.png',
        loadFailed: false,
        ...ROOMY,
      }),
    ).toBe('🖼️ Image');
  });
});

describe('placeholderLabel — URL sources say the preview is unavailable', () => {
  it.each(['img', 'svg'])('%s element with an http URL', (elementType) => {
    const label = placeholderLabel({
      elementType,
      src: 'http://192.168.1.50/snapshot.jpg',
      loadFailed: true,
      ...ROOMY,
    });

    expect(label).toBe('Preview unavailable in editor — check the rendered widget');
    expect(label).not.toMatch(/failed/i);
  });

  it('never claims a failure for an https URL', () => {
    expect(
      placeholderLabel({
        elementType: 'img',
        src: 'https://example.com/logo.png',
        loadFailed: true,
        ...ROOMY,
      }),
    ).not.toMatch(/failed/i);
  });

  it('does not promise the device render will succeed', () => {
    // CSP blocks before a request is made, so an unlisted private IP, a host
    // outside allowed_source_domains, and a 404 are indistinguishable here.
    // The label may point at the rendered widget; it may not predict it.
    for (const size of [ROOMY, { width: 120, height: 30 }, { width: 64, height: 64 }]) {
      const label = placeholderLabel({
        elementType: 'img',
        src: 'http://192.168.1.50/snapshot.jpg',
        loadFailed: true,
        ...size,
      });
      expect(label).not.toMatch(/renders on|will render|works on/i);
    }
  });
});

describe('placeholderLabel — real failures keep the honest failure message', () => {
  it.each([
    ['a resolved asset path', 'img', './api/assets/logo.png/raw', undefined, 'Image load failed'],
    ['an asset token', 'img', 'asset:logo.png', undefined, 'Image load failed'],
    ['a data URI', 'img', 'data:image/png;base64,zzz', undefined, 'Image load failed'],
    ['inline SVG content', 'svg', '', '<svg><bad', 'SVG load failed'],
    ['a resolved asset svg', 'svg', './api/assets/i.svg/raw', undefined, 'SVG load failed'],
  ])('%s', (_name, elementType, src, svgData, expected) => {
    expect(placeholderLabel({ elementType, src, svgData, loadFailed: true, ...ROOMY }))
      .toBe(expected);
  });

  it('reports a real failure for inline SVG even when src is also a URL', () => {
    // svgData wins in the loader, so the blob URL is what failed.
    expect(
      placeholderLabel({
        elementType: 'svg',
        src: 'https://example.com/icon.svg',
        svgData: '<svg><bad',
        loadFailed: true,
        ...ROOMY,
      }),
    ).toBe('SVG load failed');
  });
});

describe('placeholderLabel — the label fits the element box', () => {
  const CHAR_WIDTH = 5.6;
  const LINE_HEIGHT = 13;

  /**
   * Independent greedy word-wrap, used to assert the chosen label cannot
   * overflow. Written separately from the component's own estimate so a bug in
   * that one does not silently validate itself.
   */
  function estimatedHeight(text, width) {
    if (!text) return 0;
    const charsPerLine = Math.max(1, Math.floor(width / CHAR_WIDTH));
    const lines = [];
    let current = '';
    for (const word of text.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= charsPerLine || !current) current = candidate;
      else {
        lines.push(current);
        current = word;
      }
    }
    lines.push(current);
    // Account for mid-word breaks on lines wider than the box.
    const total = lines.reduce((sum, line) => sum + Math.ceil(line.length / charsPerLine), 0);
    return total * LINE_HEIGHT;
  }

  const sizes = [
    { width: 200, height: 120 },
    { width: 96, height: 96 }, // the default img/svg element size
    { width: 120, height: 40 },
    { width: 64, height: 64 },
    { width: 48, height: 24 },
    { width: 24, height: 24 },
    { width: 16, height: 12 },
    { width: 8, height: 8 },
  ];

  it.each(sizes)('never overflows a $width x $height element', ({ width, height }) => {
    const label = placeholderLabel({
      elementType: 'img',
      src: 'http://192.168.1.50/snapshot.jpg',
      loadFailed: true,
      width,
      height,
    });

    expect(estimatedHeight(label, width)).toBeLessThanOrEqual(height);
  });

  it('uses the full wording when there is room', () => {
    expect(
      placeholderLabel({
        elementType: 'img',
        src: 'http://192.168.1.50/x.jpg',
        loadFailed: true,
        width: 200,
        height: 120,
      }),
    ).toBe('Preview unavailable in editor — check the rendered widget');
  });

  it('falls back to the short wording on a cramped element', () => {
    expect(
      placeholderLabel({
        elementType: 'img',
        src: 'http://192.168.1.50/x.jpg',
        loadFailed: true,
        width: 120,
        height: 30,
      }),
    ).toBe('Preview unavailable');
  });

  it('drops the label entirely when even the short wording cannot fit', () => {
    expect(
      placeholderLabel({
        elementType: 'img',
        src: 'http://192.168.1.50/x.jpg',
        loadFailed: true,
        width: 16,
        height: 12,
      }),
    ).toBe('');
  });
});
