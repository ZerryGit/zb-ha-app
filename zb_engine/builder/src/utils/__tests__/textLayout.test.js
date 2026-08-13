/**
 * textLayout.test.js — Builder half of the shared wrapping contract.
 *
 * Imports the SAME module the server uses, through the `@shared/textLayout`
 * alias, and replays the same vector fixture. If the alias ever resolves to a
 * stale copy — or stops resolving through vitest.config.js, which is the easy
 * one to forget — this is the test that notices. Real font packs are not
 * loadable here (the builder suite mocks bitmapFont.js wholesale), which is why
 * the fixture carries a synthetic pack.
 */

import { describe, it, expect } from 'vitest';
import {
  measureLineVisual,
  wrapTextToWidth,
  layoutTextElement,
} from '@shared/textLayout';
import vectors from '../../../../test/fixtures/textLayoutVectors.json';

const font = {
  meta: vectors.font.meta,
  glyphs: new Map(Object.entries(vectors.font.glyphs)),
};

describe('@shared/textLayout resolves to the shared module', () => {
  it('exports the measure, wrap and layout entry points', () => {
    expect(typeof measureLineVisual).toBe('function');
    expect(typeof wrapTextToWidth).toBe('function');
    expect(typeof layoutTextElement).toBe('function');
  });

  it('measures with the overhang the engine clips against', () => {
    // 'j' overhangs its advance by 4 px in the fixture pack.
    expect(measureLineVisual('aa', font)).toBe(20);
    expect(measureLineVisual('aj', font)).toBe(24);
  });

  it('applies the same defaults as the server for a text element', () => {
    const result = layoutTextElement({
      text: 'aaa bbb',
      font,
      fontSize: 10,
      lineHeight: 1.2,
      sizeX: 30,
      textFlow: 'fixed',
    });
    expect(result.text).toBe('aaa\nbbb');
    expect(result.contentWidth).toBe(30);
    expect(result.contentHeight).toBe(28);
  });
});

describe('shared vectors', () => {
  for (const testCase of vectors.cases) {
    it(testCase.name, () => {
      const opts = 'maxLines' in testCase ? { maxLines: testCase.maxLines } : undefined;
      expect(wrapTextToWidth(testCase.text, font, testCase.maxWidth, opts)).toEqual(
        testCase.expectedLines,
      );
    });
  }
});
