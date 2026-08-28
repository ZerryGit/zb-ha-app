/**
 * widgetPairing.test.ts — Pairing-ID assignment on the widget envelope (plan 3 D1)
 *
 * Covers lazy assignment on save, carry-over across route-shaped re-saves
 * (the incoming envelope NEVER carries pairing IDs — the PUT route
 * whitelists the body), fullscreen-slot assignment, the sticky rule on
 * companion removal, uniqueness under forced RNG collision, and the
 * additive PUT-response contract.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createIngressApp } from "../src/core/server";
import { readWidget, writeWidget } from "../src/core/widgetService";
import type { PlatformAdapter, Slot, StorageAdapter, WidgetDoc, WidgetMeta } from "../src/core/adapters";

// Rig crypto.randomInt so a test can force specific pairing-ID candidates.
// Queue empty (the default) → real randomInt; every other crypto export
// stays untouched.
const rig = vi.hoisted(() => ({ queue: [] as number[] }));
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomInt: (min: number, max: number): number =>
      rig.queue.length > 0 ? rig.queue.shift()! : (actual.randomInt(min, max) as number),
  };
});

const PAIRING_ID_MIN = 100_000_000;
const PAIRING_ID_MAX = 4_294_967_295;

const validPrimary = {
  misc: { size: { width: 240, height: 240 }, gridSize: "1x1" },
  features: {},
  sources: [],
  elements: [],
};

const validFullscreen = {
  misc: { size: { width: 800, height: 480 }, gridSize: "3x2" },
  features: {},
  sources: [],
  elements: [],
};

interface TestStorage extends StorageAdapter {
  _widgets: Map<string, WidgetDoc>;
}

/** In-memory adapter whose listWidgets surfaces pairing IDs (mirrors haStorage). */
function makeTestStorage(): TestStorage {
  const widgets = new Map<string, WidgetDoc>();
  return {
    _widgets: widgets,
    async readWidget(id: string) {
      return widgets.get(id) ?? null;
    },
    async writeWidget(widget: WidgetDoc) {
      widgets.set(widget.id, widget);
    },
    async deleteWidget(id: string) {
      return widgets.delete(id);
    },
    async listWidgets(): Promise<WidgetMeta[]> {
      return Array.from(widgets.values()).map(
        ({ id, name, updatedAt, pairingId, fullscreenPairingId }) => ({
          id,
          name,
          updatedAt,
          pairingId,
          fullscreenPairingId,
        }),
      );
    },
    async readPayload() { return null; },
    async writePayload() { return false; },
    async writeCachedImage() { return false; },
    getCachedImagePath() { return null; },
    async deleteSlot(_slot: Slot) {},
  };
}

/** A route-shaped envelope: what the PUT handler builds — never any pairing IDs. */
function routeShaped(id: string, extra: Partial<WidgetDoc> = {}): WidgetDoc {
  return { id, name: "test", doc: validPrimary, updatedAt: Date.now(), ...extra };
}

beforeEach(() => {
  rig.queue.length = 0;
});

describe("pairing ID assignment (service level)", () => {
  it("assigns an in-range pairingId on first save; no fullscreenPairingId without a companion", async () => {
    const storage = makeTestStorage();
    const saved = await writeWidget(storage, routeShaped("widget_aa11bb22_cc33dd"));

    expect(saved.pairingId).toBeTypeOf("number");
    expect(saved.pairingId!).toBeGreaterThanOrEqual(PAIRING_ID_MIN);
    expect(saved.pairingId!).toBeLessThanOrEqual(PAIRING_ID_MAX);
    expect(Number.isInteger(saved.pairingId)).toBe(true);
    expect(saved.fullscreenPairingId).toBeUndefined();

    // Persisted copy matches the returned envelope.
    expect(storage._widgets.get("widget_aa11bb22_cc33dd")?.pairingId).toBe(saved.pairingId);
  });

  it("assigns BOTH IDs when saved with a fullscreen companion, and they differ", async () => {
    const storage = makeTestStorage();
    const saved = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen }),
    );

    expect(saved.pairingId).toBeTypeOf("number");
    expect(saved.fullscreenPairingId).toBeTypeOf("number");
    expect(saved.fullscreenPairingId).not.toBe(saved.pairingId);
  });

  it("keeps IDs stable across re-saves through a route-shaped envelope (carry-over)", async () => {
    const storage = makeTestStorage();
    const first = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen }),
    );

    // Re-save WITHOUT pairing fields — exactly what the PUT route sends.
    const second = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen, name: "renamed" }),
    );

    expect(second.pairingId).toBe(first.pairingId);
    expect(second.fullscreenPairingId).toBe(first.fullscreenPairingId);
  });

  it("assigns fullscreenPairingId when a companion is added later; primary ID unchanged", async () => {
    const storage = makeTestStorage();
    const first = await writeWidget(storage, routeShaped("widget_aa11bb22_cc33dd"));
    expect(first.fullscreenPairingId).toBeUndefined();

    const second = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen }),
    );

    expect(second.pairingId).toBe(first.pairingId);
    expect(second.fullscreenPairingId).toBeTypeOf("number");
  });

  it("keeps fullscreenPairingId when the companion is removed (sticky) and reuses it on re-create", async () => {
    const storage = makeTestStorage();
    const withFs = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen }),
    );

    const cleared = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: null }),
    );
    expect(cleared.fullscreen).toBeNull();
    expect(cleared.fullscreenPairingId).toBe(withFs.fullscreenPairingId);

    const recreated = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen }),
    );
    expect(recreated.fullscreenPairingId).toBe(withFs.fullscreenPairingId);
  });

  it("regenerates on collision with another widget's stored IDs (uniqueness)", async () => {
    const storage = makeTestStorage();
    // Seed a stored widget that already owns 111_111_111.
    storage._widgets.set("widget_00000000_000000", {
      id: "widget_00000000_000000",
      name: "occupant",
      doc: validPrimary,
      pairingId: 111_111_111,
      updatedAt: 1,
    });

    rig.queue.push(111_111_111, 222_222_222);
    const saved = await writeWidget(storage, routeShaped("widget_aa11bb22_cc33dd"));

    expect(saved.pairingId).toBe(222_222_222);
    expect(rig.queue.length).toBe(0); // both candidates consumed
  });

  it("never gives the fullscreen slot its own primary's ID within one save", async () => {
    const storage = makeTestStorage();
    rig.queue.push(333_333_333, 333_333_333, 444_444_444);

    const saved = await writeWidget(
      storage,
      routeShaped("widget_aa11bb22_cc33dd", { fullscreen: validFullscreen }),
    );

    expect(saved.pairingId).toBe(333_333_333);
    expect(saved.fullscreenPairingId).toBe(444_444_444);
  });

  it("readWidget never assigns — a legacy envelope loads without pairing fields, disk untouched", async () => {
    const storage = makeTestStorage();
    storage._widgets.set("widget_aa11bb22_cc33dd", {
      id: "widget_aa11bb22_cc33dd",
      name: "legacy",
      doc: validPrimary,
      updatedAt: 1,
    });

    const read = await readWidget(storage, "widget_aa11bb22_cc33dd");
    expect(read?.pairingId).toBeUndefined();
    expect(read?.fullscreenPairingId).toBeUndefined();
    expect(storage._widgets.get("widget_aa11bb22_cc33dd")?.pairingId).toBeUndefined();
  });
});

// ── HTTP contract: PUT response + GET round-trip ───────────────

function createAdapter(storage: StorageAdapter): PlatformAdapter {
  return {
    storage,
    registerRoutes() {},
    getBlockedHostnames: () => [],
    getSourceHandler: () => null,
  };
}

describe("pairing IDs over the widget API", () => {
  it("PUT response carries pairingId (and fullscreenPairingId once a companion exists)", async () => {
    const storage = makeTestStorage();
    const { ingressApp } = createIngressApp(createAdapter(storage));

    const first = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "One", doc: validPrimary });
    expect(first.status).toBe(200);
    expect(first.body.pairingId).toBeTypeOf("number");
    expect(first.body).not.toHaveProperty("fullscreenPairingId");

    const second = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "Two", doc: validPrimary, fullscreen: validFullscreen });
    expect(second.status).toBe(200);
    // Stability through the real route: same widget, same primary ID.
    expect(second.body.pairingId).toBe(first.body.pairingId);
    expect(second.body.fullscreenPairingId).toBeTypeOf("number");
  });

  it("GET /api/widgets/:id includes the envelope pairing fields", async () => {
    const storage = makeTestStorage();
    const { ingressApp } = createIngressApp(createAdapter(storage));

    const put = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "One", doc: validPrimary, fullscreen: validFullscreen });
    expect(put.status).toBe(200);

    const get = await request(ingressApp).get("/api/widgets/widget_aabbccdd_eeff00");
    expect(get.status).toBe(200);
    expect(get.body.pairingId).toBe(put.body.pairingId);
    expect(get.body.fullscreenPairingId).toBe(put.body.fullscreenPairingId);
  });

  it("PUT response carries the persisted PRIMARY size as width/height (the QR's w/h)", async () => {
    const storage = makeTestStorage();
    const { ingressApp } = createIngressApp(createAdapter(storage));

    const res = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "One", doc: validPrimary, fullscreen: validFullscreen });

    expect(res.status).toBe(200);
    // The PRIMARY payload's size — never the 800x480 companion's.
    expect(res.body.width).toBe(240);
    expect(res.body.height).toBe(240);
  });

  it("PUT response reports the NEW size after a resize, not the previously stored one", async () => {
    const storage = makeTestStorage();
    const { ingressApp } = createIngressApp(createAdapter(storage));

    const first = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "One", doc: validPrimary });
    expect(first.body.width).toBe(240);

    const resized = {
      ...validPrimary,
      misc: { size: { width: 533, height: 240 }, gridSize: "2x1" },
    };
    const second = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "One", doc: resized });

    expect(second.body.width).toBe(533);
    expect(second.body.height).toBe(240);
    // The size moves with the payload; the pairing ID does not.
    expect(second.body.pairingId).toBe(first.body.pairingId);
  });

  it("a client-sent pairingId in the PUT body is ignored (server-assigned only)", async () => {
    const storage = makeTestStorage();
    const { ingressApp } = createIngressApp(createAdapter(storage));

    const res = await request(ingressApp)
      .put("/api/widgets/widget_aabbccdd_eeff00")
      .send({ name: "Sneaky", doc: validPrimary, pairingId: 123 });
    expect(res.status).toBe(200);
    expect(res.body.pairingId).not.toBe(123);
    expect(storage._widgets.get("widget_aabbccdd_eeff00")?.pairingId).not.toBe(123);
  });
});
