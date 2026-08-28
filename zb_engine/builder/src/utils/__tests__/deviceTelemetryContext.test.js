/**
 * deviceTelemetryContext.test.js — the builder's `device` placeholder
 * (plan 4 Part A, Phase 4 / D6).
 *
 * The point of these tests is PARITY: the builder's preview must shadow the
 * same way the server does, or an author sees one thing in the canvas and the
 * panel shows another. The server side of the same rule is pinned in
 * `zb_engine/test/deviceContextSeeding.test.js`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildPreviewContext,
  DEVICE_PREVIEW_PLACEHOLDER,
  DEVICE_HINT,
} from '../expressionContext.js';
import { resolveValue } from '@zb/expressions';

describe('device placeholder in the preview context', () => {
  it('is seeded even with no sources at all', () => {
    const ctx = buildPreviewContext({ sources: [], sourceResponsesById: {} });
    expect(ctx.device).toEqual(DEVICE_PREVIEW_PLACEHOLDER);
  });

  it('carries plausible values, not the absent state — authors need a shape to click', () => {
    expect(DEVICE_PREVIEW_PLACEHOLDER.present).toBe(true);
    expect(DEVICE_PREVIEW_PLACEHOLDER.battery).toBe(87);
    expect(DEVICE_PREVIEW_PLACEHOLDER.tempC).toBe(21.7);
    expect(Object.keys(DEVICE_PREVIEW_PLACEHOLDER)).toEqual([
      'present',
      'battery',
      'charging',
      'units',
      'tempC',
      'tempF',
      'humidity',
      'pressureHpa',
      'pressureInhg',
    ]);
  });

  it('seeds BOTH unit shapes so every bindable path shows in the DataTree', () => {
    // A real panel fills one pair and nulls the other; the placeholder shows
    // both because it is an authoring aid, not a simulation of one device.
    expect(DEVICE_PREVIEW_PLACEHOLDER.tempF).toBe(71.1);
    expect(DEVICE_PREVIEW_PLACEHOLDER.pressureInhg).toBe(29.89);
  });

  it('binds through the real expression engine', () => {
    const ctx = buildPreviewContext({ sources: [], sourceResponsesById: {} });
    expect(resolveValue({ $: 'device.battery', default: '--' }, ctx)).toBe(87);
    expect(resolveValue('{{device.units}}', ctx)).toBe('metric');
  });

  it('SHADOW PARITY: a user source named `device` overwrites the placeholder', () => {
    const ctx = buildPreviewContext({
      sources: [{ id: 'device' }],
      sourceResponsesById: { device: { data: { mine: 'not telemetry' } } },
    });

    // Same outcome as the server: seeded first, sources land on top.
    expect(ctx.device).toEqual({ mine: 'not telemetry' });
  });

  it('does NOT seed when a `device` source is declared but has no test response', () => {
    const ctx = buildPreviewContext({
      sources: [{ id: 'device' }],
      sourceResponsesById: {},
    });
    // The DECLARATION is what shadows, not the cached response. Seeding here
    // would show the canvas 87 for a widget whose panel renders the user's
    // source — the server never seeds this doc either, so neither does the
    // preview. An unfetched source reads as absent, like every other source.
    expect(ctx.device).toBeUndefined();
  });

  it('does NOT seed when the declared `device` source is disabled', () => {
    // `fetchAllSources` drops `enabled:false` sources before assigning, so the
    // server leaves ctx.device unset here. Parity means the preview must too.
    const ctx = buildPreviewContext({
      sources: [{ id: 'device', enabled: false }],
      sourceResponsesById: {},
    });
    expect(ctx.device).toBeUndefined();
  });

  it('does not disturb misc, features or ordinary sources', () => {
    const ctx = buildPreviewContext({
      sources: [{ id: 'weather' }],
      sourceResponsesById: { weather: { data: { temp: 5 } } },
      features: { f1: true },
      misc: { name: 'w' },
    });
    expect(ctx.misc).toEqual({ name: 'w' });
    expect(ctx.features).toEqual({ f1: true });
    expect(ctx.weather).toEqual({ temp: 5 });
    expect(ctx.device).toEqual(DEVICE_PREVIEW_PLACEHOLDER);
  });
});

describe('the authoring hint', () => {
  it('shows the object-binding form, because the bare template silently renders 0', () => {
    // `toNumber(null) === 0` is pre-existing engine behaviour, so the UI has to
    // steer authors rather than the engine changing under stored widgets.
    expect(DEVICE_HINT).toContain('"default"');
    expect(DEVICE_HINT).toContain('device.battery');
    // The unit-shape split is a silent-null trap of its own -- an imperial
    // panel leaves tempC empty forever -- so the hint has to name both pairs.
    expect(DEVICE_HINT).toContain('tempF');
    expect(DEVICE_HINT).toContain('pressureInhg');
  });

  it('says the placeholder is a sample, since the canvas renders it like a reading', () => {
    // DEVICE_PREVIEW_PLACEHOLDER draws a plausible 87% on the canvas; without
    // this an author has no way to tell it from a live panel value.
    expect(DEVICE_HINT).toContain('sample values, not live readings');
  });
});
