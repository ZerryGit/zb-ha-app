/**
 * imagePortMulti.test.ts — pairing-based `requestedInstances` POST (plan 3 D3–D5)
 *
 * The `.bin` POST body is classified: a JSON object carrying a valid
 * `requestedInstances` array streams one `u32 LE id + u8 status`
 * preamble per requested ID (frame follows on status 1); an invalid
 * `requestedInstances` is a loud 400; every other body — empty, non-JSON,
 * telemetry JSON — takes the legacy single-frame path, byte-identical.
 */

import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import type express from "express";
import { RenderGuard } from "../src/core/renderService";
import { createOnDemandImageApp, type OnDemandDeps } from "../src/ha/imageApp";
import type { RenderMeta, WidgetDoc } from "../src/core/adapters";
import type { PairingTarget } from "../src/ha/pairingResolver";

const FAKE_PNG = Buffer.from("fake-png-data");
const FAKE_BIN = Buffer.from("fake-bin-data");

const fakeMeta: RenderMeta = {
  name: "test-widget",
  format: "png",
  width: 296,
  height: 128,
  sourceCount: 0,
  elementCount: 1,
  renderTimeMs: 10,
  sourceErrors: [],
  renderErrors: [],
};

// Pairing fixtures: W1 has both slots, W2 primary only.
const ID_W1_PRIMARY = 111_111_111;
const ID_W1_FULLSCREEN = 222_222_222;
const ID_W2_PRIMARY = 333_333_333;
const ID_UNKNOWN = 999_999_999;

function makeWidget(id: string, marker: string, fullscreenMarker?: string): WidgetDoc {
  return {
    id,
    name: id,
    doc: { marker },
    fullscreen: fullscreenMarker ? { marker: fullscreenMarker } : undefined,
    updatedAt: 1,
  };
}

function createPairingTestApp(overrides: Partial<OnDemandDeps> = {}) {
  const renderGuard = new RenderGuard();
  const widgets = new Map<string, WidgetDoc>([
    ["widget_w1", makeWidget("widget_w1", "w1-primary", "w1-fs")],
    ["widget_w2", makeWidget("widget_w2", "w2-primary")],
  ]);
  const pairings = new Map<number, PairingTarget>([
    [ID_W1_PRIMARY, { widgetId: "widget_w1", slot: "primary" }],
    [ID_W1_FULLSCREEN, { widgetId: "widget_w1", slot: "fullscreen" }],
    [ID_W2_PRIMARY, { widgetId: "widget_w2", slot: "primary" }],
  ]);
  const runPipeline = vi.fn(async (raw: unknown) => {
    const marker = (raw as { marker?: string }).marker ?? "deployed";
    if (marker === "boom") throw new Error("render exploded");
    return { pngBuffer: FAKE_PNG, binBuffer: Buffer.from(`bin:${marker}`), meta: fakeMeta };
  });
  const deps: OnDemandDeps = {
    renderGuard,
    readPayload: async () => ({ marker: "deployed" }),
    runPipeline,
    cooldownMs: 60_000, // long: cache-serving behavior is deterministic in tests
    resolvePairing: async (id) => pairings.get(id) ?? null,
    readWidget: async (widgetId) => widgets.get(widgetId) ?? null,
    ...overrides,
  };
  return { ...createOnDemandImageApp(deps), renderGuard, widgets, pairings, runPipeline };
}

/** Invert polarity the same way the serve path does. */
function inverted(text: string): Buffer {
  return Buffer.from(Buffer.from(text).map((b) => b ^ 0xff));
}

interface StreamSection {
  id: number;
  status: number;
  /** Frame image bytes (after the 25-byte header), present when status = 1. */
  image?: Buffer;
  width?: number;
  magic?: number;
}

/** Walk the multi-frame stream via the u32+status preamble and each frame's payloadLen. */
function parseMultiStream(body: Buffer): StreamSection[] {
  const sections: StreamSection[] = [];
  let off = 0;
  while (off < body.length) {
    const id = body.readUInt32LE(off);
    const status = body.readUInt8(off + 4);
    off += 5;
    if (status === 1) {
      const magic = body.readUInt16LE(off);
      const width = body.readUInt16LE(off + 2);
      const payloadLen = body.readUInt32LE(off + 16);
      const image = body.subarray(off + 25, off + 25 + payloadLen);
      off += 25 + payloadLen;
      sections.push({ id, status, magic, width, image });
    } else {
      sections.push({ id, status });
    }
  }
  return sections;
}

function postInstances(app: Parameters<typeof request>[0], ids: unknown) {
  return request(app)
    .post("/image.bin")
    .set("Content-Type", "application/json")
    .send({ requestedInstances: ids });
}

// ── Legacy path stays byte-identical ───────────────────────────

describe("image port multi — legacy fallback", () => {
  it("empty body → single legacy frame, no preamble", async () => {
    const { app } = createPairingTestApp();
    const res = await request(app).post("/image.bin");
    expect(res.status).toBe(200);
    const body = Buffer.from(res.body as Buffer);
    // First two bytes are the frame magic — proof there is NO preamble.
    expect(body.readUInt16LE(0)).toBe(0x5a46);
    expect(body.length).toBe(25 + "bin:deployed".length);
  });

  // CONSCIOUSLY UPDATED by plan 4 Part A: the CLASSIFICATION is unchanged — a
  // body without `requestedInstances` is still legacy, still a single frame
  // with no preamble — but the telemetry inside it is no longer discarded.
  it("telemetry JSON (no requestedInstances key) → legacy frame, telemetry still read", async () => {
    const { app } = createPairingTestApp();
    const res = await request(app)
      .post("/image.bin")
      .set("Content-Type", "application/json")
      .send({ wakeReason: "timer", telemetry: { battery: 87 }, mac: "AA:BB:CC:DD:EE:FF" });
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).readUInt16LE(0)).toBe(0x5a46);
  });

  it("non-JSON body → legacy frame", async () => {
    const { app } = createPairingTestApp();
    const res = await request(app)
      .post("/image.bin")
      .set("Content-Type", "application/json")
      .send("this is not json");
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).readUInt16LE(0)).toBe(0x5a46);
  });

  it("JSON array body → legacy frame (no requestedInstances key to honor)", async () => {
    const { app } = createPairingTestApp();
    const res = await request(app)
      .post("/image.bin")
      .set("Content-Type", "application/json")
      .send([1, 2, 3]);
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body as Buffer).readUInt16LE(0)).toBe(0x5a46);
  });
});

// ── Validation (D3.3) ──────────────────────────────────────────

describe("image port multi — requestedInstances validation", () => {
  it.each([
    ["a string", "nope"],
    ["a number", 5],
    ["null", null],
    ["an empty array", []],
    ["non-integer IDs", [1.5]],
    ["zero", [0]],
    ["a negative ID", [-1]],
    ["an ID above u32 max", [4_294_967_296]],
    ["a string element", ["111111111"]],
  ])("400 when requestedInstances is %s", async (_label, value) => {
    const { app, runPipeline } = createPairingTestApp();
    const res = await postInstances(app, value);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Invalid requestedInstances." });
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("400 for 13 IDs (raw length is validated before dedup)", async () => {
    const { app } = createPairingTestApp();
    const thirteen = Array.from({ length: 13 }, (_, i) => 100_000_001 + i);
    const res = await postInstances(app, thirteen);
    expect(res.status).toBe(400);
  });

  it("accepts exactly 12 IDs", async () => {
    const { app } = createPairingTestApp();
    const twelve = Array.from({ length: 12 }, (_, i) => 400_000_001 + i);
    const res = await postInstances(app, twelve);
    expect(res.status).toBe(200);
    expect(parseMultiStream(Buffer.from(res.body as Buffer))).toHaveLength(12);
  });
});

// ── Streamed multi-frame reply (D4/D5) ─────────────────────────

describe("image port multi — streamed reply", () => {
  it("one known ID → preamble + one well-formed frame", async () => {
    const { app } = createPairingTestApp();
    const res = await postInstances(app, [ID_W1_PRIMARY]);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    expect(res.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers["etag"]).toBeUndefined();

    const sections = parseMultiStream(Buffer.from(res.body as Buffer));
    expect(sections).toHaveLength(1);
    expect(sections[0].id).toBe(ID_W1_PRIMARY);
    expect(sections[0].status).toBe(1);
    expect(sections[0].magic).toBe(0x5a46);
    expect(sections[0].width).toBe(fakeMeta.width);
    expect(sections[0].image!.equals(inverted("bin:w1-primary"))).toBe(true);
  });

  it("mixed primary/fullscreen IDs stream in request order; an unknown ID mid-stream is status 0 and the stream continues", async () => {
    const { app } = createPairingTestApp();
    const res = await postInstances(app, [ID_W1_PRIMARY, ID_UNKNOWN, ID_W1_FULLSCREEN, ID_W2_PRIMARY]);

    const sections = parseMultiStream(Buffer.from(res.body as Buffer));
    expect(sections.map((s) => s.id)).toEqual([ID_W1_PRIMARY, ID_UNKNOWN, ID_W1_FULLSCREEN, ID_W2_PRIMARY]);
    expect(sections.map((s) => s.status)).toEqual([1, 0, 1, 1]);
    expect(sections[1].image).toBeUndefined();
    expect(sections[2].image!.equals(inverted("bin:w1-fs"))).toBe(true);
    expect(sections[3].image!.equals(inverted("bin:w2-primary"))).toBe(true);
  });

  it("duplicate IDs are deduped preserving first occurrence", async () => {
    const { app, runPipeline } = createPairingTestApp();
    const res = await postInstances(app, [ID_W1_PRIMARY, ID_W1_PRIMARY, ID_W2_PRIMARY, ID_W1_PRIMARY]);

    const sections = parseMultiStream(Buffer.from(res.body as Buffer));
    expect(sections.map((s) => s.id)).toEqual([ID_W1_PRIMARY, ID_W2_PRIMARY]);
    expect(runPipeline).toHaveBeenCalledTimes(2);
  });

  it("a fullscreen ID whose companion is removed (sticky) is status 0, and resumes after re-creation", async () => {
    const { app, widgets } = createPairingTestApp();
    widgets.set("widget_w1", makeWidget("widget_w1", "w1-primary")); // fullscreen removed

    const gone = await postInstances(app, [ID_W1_FULLSCREEN]);
    expect(parseMultiStream(Buffer.from(gone.body as Buffer))[0]).toMatchObject({
      id: ID_W1_FULLSCREEN,
      status: 0,
    });

    widgets.set("widget_w1", makeWidget("widget_w1", "w1-primary", "w1-fs")); // re-created
    const back = await postInstances(app, [ID_W1_FULLSCREEN]);
    const section = parseMultiStream(Buffer.from(back.body as Buffer))[0];
    expect(section.status).toBe(1);
    expect(section.image!.equals(inverted("bin:w1-fs"))).toBe(true);
  });

  it("a render failure yields status 0 without failing the stream", async () => {
    const { app, widgets } = createPairingTestApp();
    widgets.set("widget_w2", makeWidget("widget_w2", "boom"));

    const res = await postInstances(app, [ID_W2_PRIMARY, ID_W1_PRIMARY]);
    const sections = parseMultiStream(Buffer.from(res.body as Buffer));
    expect(sections.map((s) => s.status)).toEqual([0, 1]);
  });

  it("second request within the cooldown serves the cached buffer without re-rendering", async () => {
    const { app, runPipeline } = createPairingTestApp();

    const first = await postInstances(app, [ID_W1_PRIMARY]);
    expect(parseMultiStream(Buffer.from(first.body as Buffer))[0].status).toBe(1);
    expect(runPipeline).toHaveBeenCalledTimes(1);

    const second = await postInstances(app, [ID_W1_PRIMARY]);
    const section = parseMultiStream(Buffer.from(second.body as Buffer))[0];
    expect(section.status).toBe(1);
    expect(section.image!.equals(inverted("bin:w1-primary"))).toBe(true);
    expect(runPipeline).toHaveBeenCalledTimes(1); // cache hit, fresh clock only
  });

  it("while the RenderGuard is held elsewhere, an uncached instance is status 0 (never blocks)", async () => {
    const { app, renderGuard } = createPairingTestApp();
    const release = renderGuard.tryAcquire();
    expect(release).not.toBeNull();

    const res = await postInstances(app, [ID_W1_PRIMARY]);
    expect(parseMultiStream(Buffer.from(res.body as Buffer))[0].status).toBe(0);

    release!();
    const retry = await postInstances(app, [ID_W1_PRIMARY]);
    expect(parseMultiStream(Buffer.from(retry.body as Buffer))[0].status).toBe(1);
  });

  it("cache-only mode: uncached instances are status 0 and never render", async () => {
    const { app, runPipeline } = createPairingTestApp({ mode: "cache-only" });
    const res = await postInstances(app, [ID_W1_PRIMARY, ID_W2_PRIMARY]);

    const sections = parseMultiStream(Buffer.from(res.body as Buffer));
    expect(sections.map((s) => s.status)).toEqual([0, 0]);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("without injected pairing deps, every requested instance is status 0 (legacy contract untouched)", async () => {
    const { app } = createPairingTestApp({ resolvePairing: undefined, readWidget: undefined });
    const res = await postInstances(app, [ID_W1_PRIMARY]);
    expect(parseMultiStream(Buffer.from(res.body as Buffer))[0]).toMatchObject({
      id: ID_W1_PRIMARY,
      status: 0,
    });
  });

  it("evicts the oldest pairing buffer past the cache cap (insertion order)", async () => {
    const { app, widgets, pairings, runPipeline } = createPairingTestApp();
    // 25 paired widgets — one over MAX_PAIRING_BUFFER_CACHE (24).
    const ids: number[] = [];
    for (let i = 0; i < 25; i++) {
      const id = 500_000_001 + i;
      const widgetId = `widget_evict${i}`;
      widgets.set(widgetId, makeWidget(widgetId, `evict-${i}`));
      pairings.set(id, { widgetId, slot: "primary" });
      ids.push(id);
    }

    // 25 renders across three ≤12-ID requests (cooldown is 60 s — no re-renders).
    await postInstances(app, ids.slice(0, 12));
    await postInstances(app, ids.slice(12, 24));
    await postInstances(app, ids.slice(24));
    expect(runPipeline).toHaveBeenCalledTimes(25);

    // ids[0] was evicted (oldest) → re-render despite the cooldown…
    // (this re-insert brings the count back to 25, evicting ids[1] next)
    const evicted = await postInstances(app, [ids[0]]);
    expect(parseMultiStream(Buffer.from(evicted.body as Buffer))[0].status).toBe(1);
    expect(runPipeline).toHaveBeenCalledTimes(26);

    // …while the newest entry is untouched by eviction: served from cache.
    await postInstances(app, [ids[24]]);
    expect(runPipeline).toHaveBeenCalledTimes(26);
  });

  it("security headers are present on the streamed reply; GET .bin stays 405", async () => {
    const { app } = createPairingTestApp();
    const res = await postInstances(app, [ID_W1_PRIMARY]);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");

    const get = await request(app).get("/image.bin");
    expect(get.status).toBe(405);
    expect(get.headers["allow"]).toBe("POST");
  });

  it("behaves identically on /image_fullscreen.bin (pairing IDs name their own slot)", async () => {
    const { app } = createPairingTestApp();
    const res = await request(app)
      .post("/image_fullscreen.bin")
      .set("Content-Type", "application/json")
      .send({ requestedInstances: [ID_W1_PRIMARY, ID_W1_FULLSCREEN] });

    const sections = parseMultiStream(Buffer.from(res.body as Buffer));
    expect(sections.map((s) => s.status)).toEqual([1, 1]);
    expect(sections[0].image!.equals(inverted("bin:w1-primary"))).toBe(true);
    expect(sections[1].image!.equals(inverted("bin:w1-fs"))).toBe(true);
  });
});

describe("image port multi — pairing buffer cache eviction", () => {
  // MAX_PAIRING_BUFFER_CACHE is 24 and one request may carry 12 IDs, so the
  // cap is reachable in three requests. Eviction must drop the LEAST RECENTLY
  // RENDERED entry: `Map.set` on an existing key keeps its ORIGINAL position,
  // so a cache that never re-inserts evicts the hottest instance first.
  const ID_BASE = 700_000_000;
  const id = (n: number) => ID_BASE + n;

  function createManyPairingsApp() {
    const widgets = new Map<string, WidgetDoc>();
    const pairings = new Map<number, PairingTarget>();
    for (let n = 1; n <= 30; n++) {
      widgets.set(`widget_${n}`, makeWidget(`widget_${n}`, `m${n}`));
      pairings.set(id(n), { widgetId: `widget_${n}`, slot: "primary" });
    }
    const runPipeline = vi.fn(async (raw: unknown) => ({
      pngBuffer: FAKE_PNG,
      binBuffer: Buffer.from(`bin:${(raw as { marker?: string }).marker}`),
      meta: fakeMeta,
    }));
    const { app } = createOnDemandImageApp({
      renderGuard: new RenderGuard(),
      readPayload: async () => ({ marker: "deployed" }),
      runPipeline,
      cooldownMs: 60_000,
      resolvePairing: async (pid) => pairings.get(pid) ?? null,
      readWidget: async (wid) => widgets.get(wid) ?? null,
    });
    return { app, runPipeline };
  }

  const ask = (app: express.Application, ids: number[], battery: number) =>
    request(app)
      .post("/image.bin")
      .set("Content-Type", "application/json")
      .send({ requestedInstances: ids, telemetry: { battery } });

  it("keeps the most recently rendered instance and drops the coldest", async () => {
    const { app, runPipeline } = createManyPairingsApp();
    const range = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => id(from + i));

    // Fill to the 24-entry cap.
    await ask(app, range(1, 12), 10);
    await ask(app, range(13, 24), 10);
    expect(runPipeline).toHaveBeenCalledTimes(24);

    // Touch #1 again. Differing telemetry bypasses the cooldown, so this is a
    // real re-render — the write that has to move #1 to the tail.
    await ask(app, [id(1)], 20);
    expect(runPipeline).toHaveBeenCalledTimes(25);

    // Six more instances push the cache to 30 and evict six from the head.
    await ask(app, range(25, 30), 10);
    expect(runPipeline).toHaveBeenCalledTimes(31);

    // #1 must have survived: re-asking with the SAME telemetry it was last
    // rendered with is served from cache, so no render happens. If eviction
    // were by first insertion, #1 would have been the first entry dropped and
    // its cooldown state deleted with it, forcing a render here.
    const kept = await ask(app, [id(1)], 20);
    expect(runPipeline).toHaveBeenCalledTimes(31);
    expect(kept.body.length).toBeGreaterThan(5);

    // #2 is the control: coldest either way, so it was evicted and re-renders.
    await ask(app, [id(2)], 10);
    expect(runPipeline).toHaveBeenCalledTimes(32);
  });
});
