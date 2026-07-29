/**
 * widgetMigrations.test.ts — the stored-envelope `schemaVersion` seam.
 *
 * Covers the three things that make the seam safe to build on:
 *   1. `migrateWidgetDoc` treats a missing `schemaVersion` as 0 (the
 *      pre-versioning baseline) and brings it to current WITHOUT disturbing any
 *      other envelope field;
 *   2. an envelope from a FUTURE version passes through untouched, so a
 *      downgraded add-on cannot mangle a file a newer build wrote;
 *   3. reading a pre-versioning widget performs NO storage write — the bytes on
 *      disk stay exactly as they were until the user saves.
 *
 * The mock storage keeps records as serialized JSON strings (rather than live
 * objects) so the byte-identity assertion in (3) is a real one.
 */

import { describe, it, expect } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrateWidgetDoc } from "../src/core/widgetMigrations";
import { readWidget, writeWidget } from "../src/core/widgetService";
import type { StorageAdapter, Slot, WidgetDoc, WidgetMeta } from "../src/core/adapters";

const WIDGET_ID = "widget_aa11bb22_cc33dd";

const validPrimary = {
  misc: { size: { width: 240, height: 240 }, gridSize: "1x1" },
  features: {},
  sources: [],
  elements: [],
};

interface TestStorage extends StorageAdapter {
  /** Persisted records, exactly as the HA adapter would encode them. */
  _raw: Map<string, string>;
  /** Widget IDs passed to `writeWidget`, in order — length is the write count. */
  _writeLog: string[];
}

function makeTestStorage(): TestStorage {
  const raw = new Map<string, string>();
  const writeLog: string[] = [];
  return {
    _raw: raw,
    _writeLog: writeLog,
    async readWidget(id: string) {
      const json = raw.get(id);
      return json ? (JSON.parse(json) as WidgetDoc) : null;
    },
    async writeWidget(widget: WidgetDoc) {
      writeLog.push(widget.id);
      // Mirrors haStorage's pretty-printed encoding.
      raw.set(widget.id, JSON.stringify(widget, null, 2));
    },
    async deleteWidget(id: string) {
      return raw.delete(id);
    },
    async listWidgets(): Promise<WidgetMeta[]> {
      return Array.from(raw.entries()).map(([id, json]) => {
        const { name, updatedAt } = JSON.parse(json) as WidgetDoc;
        return { id, name, updatedAt, size: Buffer.byteLength(json, "utf8") };
      });
    },
    async readPayload() { return null; },
    async writePayload() { return false; },
    async writeCachedImage() { return false; },
    getCachedImagePath() { return null; },
    async deleteSlot(_slot: Slot) { /* not exercised here */ },
  };
}

/** A raw stored envelope as written before envelope versioning existed. */
function preVersioningRecord(): string {
  return JSON.stringify(
    { id: WIDGET_ID, name: "pre-versioning", doc: validPrimary, updatedAt: 1_700_000_000_000 },
    null,
    2,
  );
}

describe("migrateWidgetDoc", () => {
  it("pins the current envelope version at 1", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });

  it("treats a missing schemaVersion as 0 and stamps current, leaving every other field intact", () => {
    const stored: WidgetDoc = {
      id: WIDGET_ID,
      name: "pre-versioning",
      doc: validPrimary,
      metadata: { note: "keep me" },
      fullscreen: null,
      updatedAt: 1_700_000_000_000,
    };

    const migrated = migrateWidgetDoc(stored);

    expect(migrated.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    // 0→1 is the identity step: nothing but the version may differ.
    const { schemaVersion, ...rest } = migrated;
    expect(schemaVersion).toBe(1);
    expect(rest).toEqual(stored);
  });

  it("does not mutate the input envelope", () => {
    const stored: WidgetDoc = {
      id: WIDGET_ID,
      name: "pre-versioning",
      doc: validPrimary,
      updatedAt: 1,
    };

    migrateWidgetDoc(stored);

    expect(stored.schemaVersion).toBeUndefined();
  });

  it("returns an already-current envelope as-is", () => {
    const stored: WidgetDoc = {
      id: WIDGET_ID,
      name: "current",
      doc: validPrimary,
      updatedAt: 2,
      schemaVersion: CURRENT_SCHEMA_VERSION,
    };

    expect(migrateWidgetDoc(stored)).toBe(stored);
  });

  it("passes a FUTURE envelope through untouched (a downgrade must not mangle it)", () => {
    const stored: WidgetDoc = {
      id: WIDGET_ID,
      name: "from the future",
      doc: validPrimary,
      updatedAt: 3,
      schemaVersion: 99,
    };

    const migrated = migrateWidgetDoc(stored);

    expect(migrated).toBe(stored);
    expect(migrated.schemaVersion).toBe(99);
  });
});

describe("schemaVersion on the widgetService write path", () => {
  it("stamps schemaVersion on save", async () => {
    const storage = makeTestStorage();

    await writeWidget(storage, {
      id: WIDGET_ID,
      name: "test",
      doc: validPrimary,
      updatedAt: 1,
    });

    const persisted = JSON.parse(storage._raw.get(WIDGET_ID)!) as WidgetDoc;
    expect(persisted.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("keeps schemaVersion on the envelope — never inside doc or fullscreen", async () => {
    const storage = makeTestStorage();

    await writeWidget(storage, {
      id: WIDGET_ID,
      name: "test",
      doc: validPrimary,
      fullscreen: {
        misc: { size: { width: 800, height: 480 }, gridSize: "3x2" },
        features: {},
        sources: [],
        elements: [],
      },
      updatedAt: 1,
    });

    const persisted = JSON.parse(storage._raw.get(WIDGET_ID)!) as {
      schemaVersion?: number;
      doc: Record<string, unknown>;
      fullscreen: Record<string, unknown>;
    };
    expect(persisted.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(persisted.doc).not.toHaveProperty("schemaVersion");
    expect(persisted.fullscreen).not.toHaveProperty("schemaVersion");
  });
});

describe("schemaVersion on the widgetService read path", () => {
  it("reads a pre-versioning stored doc back as version-current", async () => {
    const storage = makeTestStorage();
    storage._raw.set(WIDGET_ID, preVersioningRecord());

    const read = await readWidget(storage, WIDGET_ID);

    expect(read).not.toBeNull();
    expect(read?.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(read?.name).toBe("pre-versioning");
    expect(read?.doc).toEqual(validPrimary);
  });

  // Phase C — the additive guarantee. Migration is in-memory only.
  it("leaves the stored JSON byte-identical — a read never rewrites disk", async () => {
    const storage = makeTestStorage();
    const before = preVersioningRecord();
    storage._raw.set(WIDGET_ID, before);

    await readWidget(storage, WIDGET_ID);

    expect(storage._writeLog).toEqual([]);
    expect(storage._raw.get(WIDGET_ID)).toBe(before);
    // Belt and braces: the untouched record still carries no version field.
    expect(JSON.parse(storage._raw.get(WIDGET_ID)!)).not.toHaveProperty("schemaVersion");
  });

  it("returns null for a missing widget without inventing an envelope", async () => {
    const storage = makeTestStorage();

    expect(await readWidget(storage, WIDGET_ID)).toBeNull();
    expect(storage._writeLog).toEqual([]);
  });
});
