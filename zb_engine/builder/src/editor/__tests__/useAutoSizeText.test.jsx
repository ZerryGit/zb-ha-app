/**
 * useAutoSizeText.test.jsx — Canvas text auto-size hook coverage.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';

const bitmapFontMocks = vi.hoisted(() => ({
  fontsReady: vi.fn(() => true),
  layoutTextBounds: vi.fn(),
}));

vi.mock('../../utils/bitmapFont.js', () => bitmapFontMocks);

import { resolveDisplayText, useAutoSizeText } from '../useAutoSizeText.js';

describe('useAutoSizeText', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('resolves template text with the live binding context', () => {
    const text = resolveDisplayText('Temp: {{weather.temp}}°C', '', {
      weather: { temp: 22 },
    });

    expect(text).toBe('Temp: 22°C');
  });

  it('shows a concise field label, not the raw template, when a binding cannot resolve', () => {
    // No data in context (e.g. secret-protected source the builder cannot
    // fetch): must NOT dump the full {{sourceId.long.path}} on the canvas.
    const text = resolveDisplayText(
      '{{id_abc123_def456.data.stop.stoptimesWithoutPatterns[0].realtimeDeparture}}',
      '',
      {},
    );

    expect(text).toBe('realtimeDeparture');
    expect(text).not.toContain('{{');
  });

  it('prefers the author fallback text for an unresolved binding', () => {
    const text = resolveDisplayText('{{sensor.state}}', '(no data)', {});
    expect(text).toBe('(no data)');
  });

  it('keeps surrounding static text when a token is unresolved', () => {
    const text = resolveDisplayText('Next: {{transit.data.stop.departure}}', '', {});
    expect(text).toBe('Next: departure');
  });

  it('does not throw on a degenerate context, falling back to a label', () => {
    // A missing/degenerate context must not crash the canvas render — the
    // token resolves to its field label instead of throwing or leaking {{…}}.
    const text = resolveDisplayText('{{weather.temp}}', '', null);
    expect(typeof text).toBe('string');
    expect(text).not.toContain('{{');
  });

  it('updates text bounds when measured display size changes', async () => {
    bitmapFontMocks.layoutTextBounds.mockReturnValue({ text: 'Hello', width: 64, height: 18 });
    const updateElementDerived = vi.fn();
    const elements = [
      {
        id: 'text_1',
        type: 'text',
        text: 'Hello',
        fontSize: 12,
        fontWeight: 400,
        fontFamily: 'Sora',
        lineHeight: 1.2,
        sizeX: 10,
        sizeY: 10,
      },
    ];

    renderHook(() => useAutoSizeText({
      elements,
      bitmapFontsLoaded: true,
      bindingCtx: {},
      updateElementDerived,
    }));

    await waitFor(() => {
      expect(updateElementDerived).toHaveBeenCalledWith('text_1', { sizeX: 64, sizeY: 18 });
    });
  });

  it('does not measure while bitmap fonts are not ready', () => {
    bitmapFontMocks.fontsReady.mockReturnValue(false);
    const updateElementDerived = vi.fn();

    renderHook(() => useAutoSizeText({
      elements: [{ id: 'text_1', type: 'text', text: 'Hello' }],
      bitmapFontsLoaded: true,
      bindingCtx: {},
      updateElementDerived,
    }));

    expect(bitmapFontMocks.layoutTextBounds).not.toHaveBeenCalled();
    expect(updateElementDerived).not.toHaveBeenCalled();
  });

  it('writes nothing for a fixed-flow element — both sizes are authored', () => {
    // clearAllMocks does not undo the previous test's fontsReady(false).
    bitmapFontMocks.fontsReady.mockReturnValue(true);
    bitmapFontMocks.layoutTextBounds.mockReturnValue({ text: 'Hello', width: 64, height: 18 });
    const updateElementDerived = vi.fn();
    const elements = [
      {
        id: 'text_1',
        type: 'text',
        text: 'Hello',
        textFlow: 'fixed',
        fontSize: 12,
        sizeX: 40,
        sizeY: 16,
      },
    ];

    renderHook(() => useAutoSizeText({
      elements,
      bitmapFontsLoaded: true,
      bindingCtx: {},
      updateElementDerived,
    }));

    // Skipped entirely: no measure call, no derived write, no warn-noise.
    expect(bitmapFontMocks.layoutTextBounds).not.toHaveBeenCalled();
    expect(updateElementDerived).not.toHaveBeenCalled();
  });

  it('writes nothing for a locked-box (clip) element either', () => {
    bitmapFontMocks.fontsReady.mockReturnValue(true);
    const updateElementDerived = vi.fn();

    renderHook(() => useAutoSizeText({
      elements: [{ id: 'text_1', type: 'text', text: 'Hello', textFlow: 'clip', sizeX: 120, sizeY: 60 }],
      bitmapFontsLoaded: true,
      bindingCtx: {},
      updateElementDerived,
    }));

    expect(bitmapFontMocks.layoutTextBounds).not.toHaveBeenCalled();
    expect(updateElementDerived).not.toHaveBeenCalled();
  });

  it('re-measures on the first auto pass after a fixed -> auto flip', async () => {
    bitmapFontMocks.fontsReady.mockReturnValue(true);
    bitmapFontMocks.layoutTextBounds.mockReturnValue({ text: 'Hello', width: 64, height: 18 });
    const updateElementDerived = vi.fn();
    const fixedElement = {
      id: 'text_1',
      type: 'text',
      text: 'Hello',
      textFlow: 'fixed',
      fontSize: 12,
      sizeX: 40,
      sizeY: 16,
    };

    const { rerender } = renderHook(
      ({ elements }) => useAutoSizeText({
        elements,
        bitmapFontsLoaded: true,
        bindingCtx: {},
        updateElementDerived,
      }),
      { initialProps: { elements: [fixedElement] } },
    );

    expect(updateElementDerived).not.toHaveBeenCalled();

    // Toggling back to auto must drop back to hugging on the next measure
    // pass, even though the text itself never changed.
    rerender({ elements: [{ ...fixedElement, textFlow: 'auto' }] });

    await waitFor(() => {
      expect(updateElementDerived).toHaveBeenCalledWith('text_1', { sizeX: 64, sizeY: 18 });
    });
  });
});
