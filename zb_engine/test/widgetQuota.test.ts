/**
 * widgetQuota.test.ts — Widget storage quota in writeWidget (P3.4)
 *
 * An authenticated user must not be able to exhaust the /data volume by
 * creating unlimited widgets or oversized aggregate content.
 */

import { describe, it, expect } from "vitest";
import { writeWidget } from "../src/core/widgetService";
import { MAX_WIDGET_COUNT, MAX_WIDGETS_TOTAL_BYTES } from "../src/limits";
import type { StorageAdapter, WidgetDoc, WidgetMeta } from "../src/core/adapters";

const validDoc = {
  misc: { size: { width: 8, height: 8 }, gridSize: "1x1" },
  features: {},
  sources: [],
  elements: [],
};

function makeWidget(id: string): WidgetDoc {
  return { id, name: "w", doc: validDoc, updatedAt: 1 };
}

/**
 * Storage stub whose listWidgets reports a fixed metadata set (with sizes),
 * so quota behaviour can be exercised without materialising real bytes.
 */
function storageWith(metas: WidgetMeta[]) {
  const writes: WidgetDoc[] = [];
  const ids = new Set(metas.map((m) => m.id));
  const storage: StorageAdapter = {
    readWidget: async (id) => (ids.has(id) ? makeWidget(id) : null),
    writeWidget: async (w) => { writes.push(w); },
    deleteWidget: async () => true,
    listWidgets: async () => metas,
    readPayload: async () => null,
    writePayload: async () => false,
    writeCachedImage: async () => false,
    getCachedImagePath: () => null,
  };
  return { storage, writes };
}

function fullCountMetas(): WidgetMeta[] {
  return Array.from({ length: MAX_WIDGET_COUNT }, (_, i) => ({
    id: `existing_${i}`,
    name: "n",
    updatedAt: 1,
    size: 16,
  }));
}

describe("widget count quota", () => {
  it("rejects a NEW widget once the count cap is reached", async () => {
    const { storage, writes } = storageWith(fullCountMetas());
    await expect(writeWidget(storage, makeWidget("brand_new"))).rejects.toThrow(/limit reached/i);
    expect(writes).toHaveLength(0);
  });

  it("still allows OVERWRITING an existing widget at the count cap", async () => {
    const metas = fullCountMetas();
    const { storage, writes } = storageWith(metas);
    await expect(writeWidget(storage, makeWidget(metas[0].id))).resolves.toMatchObject({ id: metas[0].id });
    expect(writes).toHaveLength(1);
  });

  it("allows a new widget below the cap", async () => {
    const { storage, writes } = storageWith([{ id: "a", name: "n", updatedAt: 1, size: 16 }]);
    await expect(writeWidget(storage, makeWidget("new_one"))).resolves.toMatchObject({ id: "new_one" });
    expect(writes).toHaveLength(1);
  });
});

describe("widget aggregate-byte quota", () => {
  it("rejects a write that would exceed the total-byte budget", async () => {
    // One existing widget already fills the entire budget.
    const { storage, writes } = storageWith([
      { id: "big", name: "n", updatedAt: 1, size: MAX_WIDGETS_TOTAL_BYTES },
    ]);
    await expect(writeWidget(storage, makeWidget("another"))).rejects.toThrow(/storage quota/i);
    expect(writes).toHaveLength(0);
  });

  it("excludes the widget's own prior bytes when overwriting", async () => {
    // The only stored widget is the one being overwritten, so its old size
    // does not count against the budget for the replacement.
    const { storage, writes } = storageWith([
      { id: "big", name: "n", updatedAt: 1, size: MAX_WIDGETS_TOTAL_BYTES },
    ]);
    await expect(writeWidget(storage, makeWidget("big"))).resolves.toMatchObject({ id: "big" });
    expect(writes).toHaveLength(1);
  });
});
