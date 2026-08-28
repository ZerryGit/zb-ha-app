/**
 * deviceTelemetryPort.test.ts — telemetry travelling from a `.bin` POST into
 * the render (plan 4 Part A, Phase 3 wiring + D4 staleness + D7 logging).
 *
 * Phase 1 proved the body parses; Phase 2 proved the seam seeds. This file
 * proves the two ends are connected on the real routes, and pins the three
 * staleness behaviours that are ACCEPTED and documented rather than fixed —
 * so a later "improvement" has to break a test to change them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import type express from "express";

const logWarn = vi.fn();
vi.mock("../src/core/logger", async () => {
  const actual = await vi.importActual<typeof import("../src/core/logger")>("../src/core/logger");
  return { ...actual, logWarn: (...args: unknown[]) => logWarn(...args) };
});

import { RenderGuard } from "../src/core/renderService";
import { createOnDemandImageApp, type OnDemandDeps } from "../src/ha/imageApp";
import type { RenderMeta, WidgetDoc, DeviceTelemetryContext } from "../src/core/adapters";
import type { PairingTarget } from "../src/ha/pairingResolver";

const FAKE_PNG = Buffer.from("fake-png-data");

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

const ID_A = 111_111_111;
const ID_B = 222_222_222;

function widget(id: string, marker: string): WidgetDoc {
  return { id, name: id, doc: { marker }, updatedAt: 1 };
}

function createApp(overrides: Partial<OnDemandDeps> = {}) {
  const pairings = new Map<number, PairingTarget>([
    [ID_A, { widgetId: "w_a", slot: "primary" }],
    [ID_B, { widgetId: "w_b", slot: "primary" }],
  ]);
  const widgets = new Map<string, WidgetDoc>([
    ["w_a", widget("w_a", "a")],
    ["w_b", widget("w_b", "b")],
  ]);

  // Records the telemetry every render was given, in call order.
  const seenDevices: (DeviceTelemetryContext | null | undefined)[] = [];
  const runPipeline = vi.fn(async (raw: unknown, device?: DeviceTelemetryContext | null) => {
    seenDevices.push(device);
    const marker = (raw as { marker?: string }).marker ?? "deployed";
    return { pngBuffer: FAKE_PNG, binBuffer: Buffer.from(`bin:${marker}`), meta: fakeMeta };
  });

  const deps: OnDemandDeps = {
    renderGuard: new RenderGuard(),
    readPayload: async () => ({ marker: "deployed" }),
    runPipeline,
    cooldownMs: 60_000,
    resolvePairing: async (id) => pairings.get(id) ?? null,
    readWidget: async (id) => widgets.get(id) ?? null,
    ...overrides,
  };
  return { ...createOnDemandImageApp(deps), runPipeline, seenDevices };
}

const post = (app: express.Application, payload: unknown) =>
  request(app).post("/image.bin").set("Content-Type", "application/json").send(payload as object);

beforeEach(() => {
  logWarn.mockClear();
});

describe("telemetry reaches the render — legacy path", () => {
  it("passes the POSTed values through to runPipeline", async () => {
    const { app, seenDevices } = createApp();
    await post(app, { wakeReason: "timer", telemetry: { battery: 87, tempC: 21.7 } });

    expect(seenDevices).toHaveLength(1);
    expect(seenDevices[0]).toMatchObject({ present: true, battery: 87, tempC: 21.7 });
  });

  it("passes NOTHING on the GET .png preview — there is no body to read", async () => {
    const { app, seenDevices } = createApp();
    await request(app).get("/image.png");

    // The port passes no device at all rather than manufacturing an absent
    // object; `preparePipeline` is the single place that substitutes the
    // canonical absent state (pinned in deviceContextSeeding.test.ts), which
    // is also what makes this render share a cache entry with a builder
    // /render of the same payload.
    expect(seenDevices).toHaveLength(1);
    expect(seenDevices[0]).toBeUndefined();
  });
});

describe("telemetry reaches the render — pairing stream", () => {
  it("feeds ONE parse to every frame of the stream", async () => {
    const { app, seenDevices } = createApp();
    await post(app, {
      requestedInstances: [ID_A, ID_B],
      telemetry: { battery: 42, charging: true },
    });

    expect(seenDevices).toHaveLength(2);
    // Same telemetry object for both — they are all rendered FOR this device.
    expect(seenDevices[0]).toMatchObject({ battery: 42, charging: true });
    expect(seenDevices[1]).toBe(seenDevices[0]);
  });

  it("feeds all 12 frames of a full-length request from that one parse", async () => {
    const pairings = new Map<number, PairingTarget>();
    const widgets = new Map<string, WidgetDoc>();
    const ids = Array.from({ length: 12 }, (_, i) => 100_000_001 + i);
    ids.forEach((id, i) => {
      pairings.set(id, { widgetId: `w${i}`, slot: "primary" });
      widgets.set(`w${i}`, widget(`w${i}`, `m${i}`));
    });

    const { app, seenDevices } = createApp({
      resolvePairing: async (id) => pairings.get(id) ?? null,
      readWidget: async (id) => widgets.get(id) ?? null,
    });
    await post(app, { requestedInstances: ids, telemetry: { battery: 5 } });

    expect(seenDevices).toHaveLength(12);
    expect(seenDevices.every((d) => d?.battery === 5)).toBe(true);
  });
});

describe("a wake is answered with ITS OWN telemetry (D4 case 1, revised 2026-08-26)", () => {
  it("bypasses the cooldown when the telemetry DIFFERS from the cached frame", async () => {
    // cooldownMs is 60_000 in createApp, so nothing here expires on its own:
    // the second render can only happen via the telemetry-changed bypass.
    const { app, runPipeline, seenDevices } = createApp();

    await post(app, { telemetry: { battery: 10 } });
    const second = await post(app, { telemetry: { battery: 90 } });

    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(seenDevices[0]).toMatchObject({ battery: 10 });
    expect(seenDevices[1]).toMatchObject({ battery: 90 });
    expect(second.status).toBe(200);
  });

  it("still dedupes inside the cooldown when the telemetry is IDENTICAL", async () => {
    // The bypass must not become "render on every POST" — a panel reporting
    // unchanged readings has to stay as cheap as it was before.
    const { app, runPipeline } = createApp();

    await post(app, { telemetry: { battery: 42, tempC: 21.7 } });
    await post(app, { telemetry: { battery: 42, tempC: 21.7 } });
    await post(app, { telemetry: { battery: 42, tempC: 21.7 } });

    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("bypasses on the pairing stream path too", async () => {
    const { app, runPipeline, seenDevices } = createApp();

    await post(app, { requestedInstances: [ID_A], telemetry: { battery: 10 } });
    await post(app, { requestedInstances: [ID_A], telemetry: { battery: 90 } });

    expect(runPipeline).toHaveBeenCalledTimes(2);
    expect(seenDevices[1]).toMatchObject({ battery: 90 });
  });

  it("a telemetry-bearing wake overrides a warmed absent-state buffer (D4 case 2)", async () => {
    const { app, setBuffer, runPipeline, seenDevices } = createApp();
    // The periodic timer and startup warm-up render WITHOUT telemetry and
    // stamp the absent state, so a wake carrying readings differs from it and
    // renders rather than being served the scheduler's frame.
    setBuffer(FAKE_PNG, Buffer.from("bin:warm"), fakeMeta);

    const res = await post(app, { telemetry: { battery: 77 } });

    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(seenDevices[0]).toMatchObject({ battery: 77 });
    expect(res.status).toBe(200);
  });

  it("a body-less wake after a warm buffer still respects the cooldown", async () => {
    // Both are the absent state, so nothing differs and the bypass must not
    // fire — otherwise every body-less poll would drive a render.
    const { app, setBuffer, runPipeline } = createApp();
    setBuffer(FAKE_PNG, Buffer.from("bin:warm"), fakeMeta);

    const res = await request(app).post("/image.bin");

    expect(runPipeline).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("a GET .png after a telemetry wake does NOT bypass the cooldown", async () => {
    // The preview GET reports no telemetry at all. Reading its `undefined` as
    // "the telemetry changed" made it render straight through the cooldown —
    // and then stamp the absent state, so the next wake differed from THAT and
    // bypassed too, ping-ponging until the cooldown applied to neither.
    const { app, runPipeline } = createApp();

    await post(app, { telemetry: { battery: 55 } });
    expect(runPipeline).toHaveBeenCalledTimes(1);

    // `If-None-Match` is deliberately wrong so the 304 fast path cannot be
    // what stops the render — only the cooldown may.
    await request(app).get("/image.png").set("If-None-Match", "not-the-etag");

    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("and leaves the wake's telemetry state intact, so the next repeat wake still dedupes", async () => {
    // The second half of the same bug: a preview render used to overwrite the
    // recorded telemetry key, re-arming the bypass on the WAKE path.
    const { app, runPipeline } = createApp();

    await post(app, { telemetry: { battery: 55 } });
    await request(app).get("/image.png").set("If-None-Match", "not-the-etag");
    await post(app, { telemetry: { battery: 55 } });

    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("cache-only mode never renders, so telemetry cannot drive the port at all", async () => {
    const { app, runPipeline } = createApp({ mode: "cache-only" });
    const res = await post(app, { telemetry: { battery: 50 } });

    expect(runPipeline).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
  });
});

describe("D7 — telemetry.field_reject logging", () => {
  it("warns ONCE per request with field names only, never values", async () => {
    const { app } = createApp();
    await post(app, { telemetry: { battery: 101, humidity: 999, tempC: 21.7 } });

    const rejects = logWarn.mock.calls.filter((c) => c[0] === "telemetry.field_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0][1]).toMatchObject({ fields: ["battery", "humidity"] });
    // The offending READINGS must never reach the logs.
    expect(JSON.stringify(rejects[0][1])).not.toContain("101");
    expect(JSON.stringify(rejects[0][1])).not.toContain("999");
  });

  it("stays silent when every field is valid", async () => {
    const { app } = createApp();
    await post(app, { telemetry: { battery: 50, tempC: 21.7 } });

    expect(logWarn.mock.calls.filter((c) => c[0] === "telemetry.field_reject")).toHaveLength(0);
  });

  it("stays silent for a body carrying no telemetry at all", async () => {
    const { app } = createApp();
    await request(app).post("/image.bin");

    expect(logWarn.mock.calls.filter((c) => c[0] === "telemetry.field_reject")).toHaveLength(0);
  });

  it("warns for a rejected field even on the pairing stream path", async () => {
    const { app } = createApp();
    await post(app, { requestedInstances: [ID_A], telemetry: { units: "kelvin" } });

    const rejects = logWarn.mock.calls.filter((c) => c[0] === "telemetry.field_reject");
    expect(rejects).toHaveLength(1);
    expect(rejects[0][1]).toMatchObject({ fields: ["units"] });
  });

  it("never warns for an invalid selector — that path 400s before telemetry logging", async () => {
    const { app } = createApp();
    const res = await post(app, { requestedInstances: "nope", telemetry: { battery: 101 } });

    expect(res.status).toBe(400);
    expect(logWarn.mock.calls.filter((c) => c[0] === "telemetry.field_reject")).toHaveLength(0);
  });
});
