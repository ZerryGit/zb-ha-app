/**
 * schemas.test.ts — Tests for Zod validation schemas
 *
 * Covers: payload schema limits, source schema variants,
 * element type validation, and boundary enforcement.
 */

import { describe, it, expect } from "vitest";
import { payloadSchema, miscSchema } from "../src/schema/payloadSchema";
import { sourceSchema } from "../src/schema/sourceSchema";
import { elementSchema } from "../src/schema/elementSchema";

// ── Misc schema ────────────────────────────────────────────────

describe("miscSchema", () => {
  it("accepts valid misc", () => {
    const result = miscSchema.safeParse({ size: { width: 800, height: 480 } });
    expect(result.success).toBe(true);
  });

  it("rejects width over 4096", () => {
    const result = miscSchema.safeParse({ size: { width: 5000, height: 480 } });
    expect(result.success).toBe(false);
  });

  it("rejects height over 4096", () => {
    const result = miscSchema.safeParse({ size: { width: 800, height: 5000 } });
    expect(result.success).toBe(false);
  });

  it("rejects zero width", () => {
    const result = miscSchema.safeParse({ size: { width: 0, height: 480 } });
    expect(result.success).toBe(false);
  });

  it("rejects negative dimensions", () => {
    const result = miscSchema.safeParse({ size: { width: -100, height: 480 } });
    expect(result.success).toBe(false);
  });
});

// ── Payload schema ─────────────────────────────────────────────

describe("payloadSchema", () => {
  const validPayload = {
    misc: { size: { width: 800, height: 480 } },
    features: {},
    sources: [],
    elements: [],
  };

  it("accepts valid minimal payload", () => {
    const result = payloadSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("defaults features to empty object", () => {
    const result = payloadSchema.safeParse({
      misc: { size: { width: 800, height: 480 } },
      sources: [],
      elements: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.features).toEqual({});
    }
  });

  const makeSources = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      method: "GET",
      url: "https://example.com",
      response: { type: "json" },
      auth: { type: "none" },
    }));

  it("accepts 51 sources (past the builder warn threshold)", () => {
    const result = payloadSchema.safeParse({ ...validPayload, sources: makeSources(51) });
    expect(result.success).toBe(true);
  });

  it("accepts exactly 500 sources", () => {
    const result = payloadSchema.safeParse({ ...validPayload, sources: makeSources(500) });
    expect(result.success).toBe(true);
  });

  it("rejects more than 500 sources", () => {
    const result = payloadSchema.safeParse({ ...validPayload, sources: makeSources(501) });
    expect(result.success).toBe(false);
  });

  it("rejects more than 2000 elements", () => {
    const elements = Array.from({ length: 2001 }, (_, i) => ({
      type: "rect",
      pos: { x: i, y: 0 },
    }));
    const result = payloadSchema.safeParse({ ...validPayload, elements });
    expect(result.success).toBe(false);
  });

  it("rejects features with more than 1000 keys", () => {
    const features: Record<string, string> = {};
    for (let i = 0; i < 1001; i++) features[`key${i}`] = "v";
    const result = payloadSchema.safeParse({ ...validPayload, features });
    expect(result.success).toBe(false);
  });
});

// ── Source schema: HTTP ────────────────────────────────────────

describe("sourceSchema: HTTP", () => {
  it("accepts a valid HTTP source", () => {
    const result = sourceSchema.safeParse({
      id: "api1",
      method: "GET",
      url: "https://api.example.com/data",
      response: { type: "json" },
      auth: { type: "none" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts HTTP source with explicit kind", () => {
    const result = sourceSchema.safeParse({
      id: "api2",
      kind: "http",
      method: "POST",
      url: "https://api.example.com/data",
      response: { type: "xml" },
      auth: { type: "bearer", bearer: "token123" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing id", () => {
    const result = sourceSchema.safeParse({
      method: "GET",
      url: "https://example.com",
      response: { type: "json" },
      auth: { type: "none" },
    });
    expect(result.success).toBe(false);
  });
});

// ── Source schema: HA State ────────────────────────────────────

describe("sourceSchema: haState", () => {
  it("accepts valid haState source", () => {
    const result = sourceSchema.safeParse({
      id: "temp",
      kind: "haState",
      entity_id: "sensor.temperature",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid entity_id format", () => {
    const result = sourceSchema.safeParse({
      id: "bad",
      kind: "haState",
      entity_id: "INVALID-FORMAT",
    });
    expect(result.success).toBe(false);
  });

  it("rejects entity_id with special chars", () => {
    const result = sourceSchema.safeParse({
      id: "bad",
      kind: "haState",
      entity_id: "sensor.temp; DROP TABLE",
    });
    expect(result.success).toBe(false);
  });
});

// ── Source schema: HA History ──────────────────────────────────

describe("sourceSchema: haHistory", () => {
  it("accepts valid haHistory source", () => {
    const result = sourceSchema.safeParse({
      id: "history1",
      kind: "haHistory",
      entity_id: "sensor.living_room_temp",
      hoursBack: 24,
    });
    expect(result.success).toBe(true);
  });

  it("rejects hoursBack over 168", () => {
    const result = sourceSchema.safeParse({
      id: "history2",
      kind: "haHistory",
      entity_id: "sensor.temp",
      hoursBack: 200,
    });
    expect(result.success).toBe(false);
  });

  it("rejects hoursBack of 0", () => {
    const result = sourceSchema.safeParse({
      id: "history3",
      kind: "haHistory",
      entity_id: "sensor.temp",
      hoursBack: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ── Source name preservation (regression) ──────────────────────
//
// z.object() strips unknown keys, so a source's user-facing `name` is only
// persisted if the schema declares it. Before the schema carried `name`,
// every save dropped it and reloaded sources rendered as "Unnamed Source"
// even though the builder sent the name. These guard that round-trip.

describe("sourceSchema: name preservation", () => {
  it("keeps name on an HTTP source", () => {
    const result = sourceSchema.safeParse({
      id: "api1",
      name: "Weather API",
      method: "GET",
      url: "https://api.example.com/data",
      response: { type: "json" },
      auth: { type: "none" },
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Weather API");
  });

  it("keeps name on an haState source", () => {
    const result = sourceSchema.safeParse({
      id: "temp",
      name: "Living Room Temp",
      kind: "haState",
      entity_id: "sensor.temperature",
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Living Room Temp");
  });

  it("keeps name on an haHistory source", () => {
    const result = sourceSchema.safeParse({
      id: "hist",
      name: "Temp History",
      kind: "haHistory",
      entity_id: "sensor.temperature",
      hoursBack: 24,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.name).toBe("Temp History");
  });

  it("survives a full payloadSchema round-trip", () => {
    const result = payloadSchema.safeParse({
      misc: { size: { width: 200, height: 200 } },
      sources: [
        {
          id: "temp",
          name: "Living Room Temp",
          kind: "haState",
          entity_id: "sensor.temperature",
        },
      ],
      elements: [],
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sources[0].name).toBe("Living Room Temp");
  });
});

// ── Element geometry bounds ────────────────────────────────────
//
// Literal non-finite / absurd geometry (sizeX/sizeY/strokeWidth/pos/line
// points) must be rejected at the schema boundary, while bindings and
// in-range numbers still pass. `1e309` / `1e400` overflow to Infinity in JS.

describe("elementSchema: geometry bounds", () => {
  it("rejects non-finite / oversize literal rect geometry", () => {
    expect(elementSchema.safeParse({ type: "rect", sizeX: Infinity }).success).toBe(false);
    expect(elementSchema.safeParse({ type: "rect", sizeX: 1e309 }).success).toBe(false);
    expect(elementSchema.safeParse({ type: "rect", sizeY: 1e400 }).success).toBe(false);
    expect(elementSchema.safeParse({ type: "rect", strokeWidth: Infinity }).success).toBe(false);
  });

  it("rejects non-finite / oversize literal pos and circle strokeWidth", () => {
    expect(elementSchema.safeParse({ type: "rect", pos: { x: Infinity, y: 0 } }).success).toBe(false);
    expect(elementSchema.safeParse({ type: "rect", pos: { x: 0, y: 1e400 } }).success).toBe(false);
    expect(elementSchema.safeParse({ type: "circle", strokeWidth: 1e400 }).success).toBe(false);
  });

  it("rejects non-finite / oversize literal line points", () => {
    expect(elementSchema.safeParse({ type: "line", points: [[1e309, 0], [0, 0]] }).success).toBe(false);
    expect(elementSchema.safeParse({ type: "line", points: [[0, 0], [Infinity, 0]] }).success).toBe(false);
    // Beyond MAX_GEOMETRY_COORD (100000) — rejected at the schema.
    expect(elementSchema.safeParse({ type: "line", points: [[0, 0], [200000, 0]] }).success).toBe(false);
  });

  it("accepts bindings and in-range numbers for geometry", () => {
    expect(elementSchema.safeParse({ type: "rect", sizeX: "={{ features.w }}" }).success).toBe(true);
    expect(elementSchema.safeParse({ type: "rect", sizeX: { $: "s.w" } }).success).toBe(true);
    expect(elementSchema.safeParse({ type: "rect", sizeX: 800 }).success).toBe(true);
    // In the schema cap (<=100000) but beyond the render-clamp bound — accepted
    // here, bounded later by the pre-render geometry clamp.
    expect(elementSchema.safeParse({ type: "rect", sizeX: 50000 }).success).toBe(true);
    expect(elementSchema.safeParse({ type: "line", points: [[0, 0], [10, 10]] }).success).toBe(true);
  });

  it("still round-trips valid geometry through payloadSchema", () => {
    const base = {
      misc: { size: { width: 800, height: 480 } },
      features: {},
      sources: [],
    };
    expect(
      payloadSchema.safeParse({ ...base, elements: [{ type: "rect", sizeX: 800, sizeY: 480 }] }).success,
    ).toBe(true);
    expect(
      payloadSchema.safeParse({ ...base, elements: [{ type: "rect", sizeX: Infinity }] }).success,
    ).toBe(false);
  });
});
