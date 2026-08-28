/**
 * pairingResolver.test.ts — pairingId → (widget, slot) resolution (plan 3 D2)
 *
 * The resolver is a read-path TTL cache over StorageAdapter.listWidgets():
 * both slots resolve, unknown IDs return null, resolutions inside the TTL
 * window never re-list, and a newly saved widget becomes resolvable after
 * the window elapses.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { createPairingResolver } from "../src/ha/pairingResolver";
import type { WidgetMeta } from "../src/core/adapters";

afterEach(() => {
  vi.useRealTimers();
});

function meta(partial: Partial<WidgetMeta> & { id: string }): WidgetMeta {
  return { name: partial.id, updatedAt: 1, ...partial };
}

describe("createPairingResolver", () => {
  it("resolves primary and fullscreen IDs to their (widget, slot) targets", async () => {
    const listWidgets = vi.fn(async () => [
      meta({ id: "w1", pairingId: 111_111_111, fullscreenPairingId: 222_222_222 }),
      meta({ id: "w2", pairingId: 333_333_333 }),
    ]);
    const resolve = createPairingResolver({ listWidgets });

    expect(await resolve(111_111_111)).toEqual({ widgetId: "w1", slot: "primary" });
    expect(await resolve(222_222_222)).toEqual({ widgetId: "w1", slot: "fullscreen" });
    expect(await resolve(333_333_333)).toEqual({ widgetId: "w2", slot: "primary" });
  });

  it("returns null for an unknown ID and for widgets without pairing fields", async () => {
    const listWidgets = vi.fn(async () => [meta({ id: "legacy" })]);
    const resolve = createPairingResolver({ listWidgets });

    expect(await resolve(999_999_999)).toBeNull();
  });

  it("serves repeated resolutions inside the TTL from the cache (one listWidgets call)", async () => {
    const listWidgets = vi.fn(async () => [meta({ id: "w1", pairingId: 111_111_111 })]);
    const resolve = createPairingResolver({ listWidgets }, 60_000);

    await resolve(111_111_111);
    await resolve(111_111_111);
    await resolve(424_242_424);

    expect(listWidgets).toHaveBeenCalledTimes(1);
  });

  it("picks up a newly saved widget after the TTL window elapses", async () => {
    vi.useFakeTimers();
    const metas: WidgetMeta[] = [meta({ id: "w1", pairingId: 111_111_111 })];
    const listWidgets = vi.fn(async () => metas.slice());
    const resolve = createPairingResolver({ listWidgets }, 3_000);

    expect(await resolve(222_222_222)).toBeNull();

    // Saved between requests — still invisible inside the TTL window…
    metas.push(meta({ id: "w2", pairingId: 222_222_222 }));
    expect(await resolve(222_222_222)).toBeNull();

    // …and resolvable once the window elapses.
    vi.advanceTimersByTime(3_001);
    expect(await resolve(222_222_222)).toEqual({ widgetId: "w2", slot: "primary" });
  });

  it("a sticky fullscreen ID resolves while the companion payload is absent (readWidget decides availability)", async () => {
    // listWidgets surfaces fullscreenPairingId even when the widget currently
    // has fullscreen: null (sticky rule) — resolution succeeds; the render
    // path then finds no fullscreen payload and answers status = 0.
    const listWidgets = vi.fn(async () => [
      meta({ id: "w1", pairingId: 111_111_111, fullscreenPairingId: 222_222_222 }),
    ]);
    const resolve = createPairingResolver({ listWidgets });

    expect(await resolve(222_222_222)).toEqual({ widgetId: "w1", slot: "fullscreen" });
  });
});
