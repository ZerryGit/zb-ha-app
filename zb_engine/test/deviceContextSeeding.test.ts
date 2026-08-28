/**
 * deviceContextSeeding.test.ts — the `device` core seam (plan 4 Part A,
 * Phase 2: D2 shadow rule, D4 cache key).
 *
 * Asserts against the ctx that actually crosses the render-worker boundary, so
 * these are statements about what the engine really receives, not about an
 * intermediate value.
 *
 * NOTHING here edits `packages/zb-expressions`, `payloadSchema` or any
 * migration: the shadow rule's whole point is that seeding costs nothing
 * stored. The null-semantics block pins pre-existing engine behaviour so the
 * authoring docs (§1) stay honest — do not "improve" those semantics.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { Worker } from "node:worker_threads";
import { runPipeline, __setEngineWorkerFactory } from "../src/core/renderService";
import type { SourceHandler } from "../src/core/renderService";
import { render as realRender } from "../src/engine/renderer";
import { buildDeviceContext, ABSENT_DEVICE_CONTEXT } from "../src/core/adapters";
import { resolveValue, createDataContext } from "@zb/expressions";

/** Every ctx handed to the engine during a test, newest last. */
let seenContexts: Record<string, unknown>[] = [];

/**
 * Inline render worker that also RECORDS the ctx it is given. A cache hit
 * short-circuits `preparePipeline`, so the number of captures is a direct,
 * non-flaky readout of whether a render actually happened.
 */
function makeCapturingWorker() {
  const w = new EventEmitter() as EventEmitter & {
    postMessage: (req: {
      elements: Record<string, unknown>[];
      ctx: unknown;
      width: number;
      height: number;
    }) => void;
    terminate: () => Promise<number>;
    unref: () => void;
  };
  w.postMessage = (req) => {
    seenContexts.push(req.ctx as Record<string, unknown>);
    realRender(req.elements, req.ctx as never, req.width, req.height)
      .then(({ canvas, errors }) => {
        w.emit("message", {
          ok: true,
          buffer: canvas.buffer.buffer,
          width: canvas.width,
          height: canvas.height,
          stride: canvas.stride,
          errors,
        });
      })
      .catch((err) => {
        w.emit("message", { ok: false, message: err instanceof Error ? err.message : String(err) });
      });
  };
  w.terminate = () => {
    w.emit("exit", 0);
    return Promise.resolve(0);
  };
  w.unref = () => {};
  return w;
}

beforeAll(() => {
  __setEngineWorkerFactory(() => makeCapturingWorker() as unknown as Worker);
});
afterAll(() => __setEngineWorkerFactory(null));
beforeEach(() => {
  seenContexts = [];
});

/** Distinct per test so the sha1-keyed render cache never bleeds across them. */
function payload(tag: string, sources: unknown[] = []) {
  return {
    misc: { size: { width: 8, height: 8 }, format: "png" as const, gridSize: "1x1", tag },
    features: {},
    sources,
    elements: [],
  };
}

const lastCtx = () => seenContexts[seenContexts.length - 1];

describe("ctx.device seeding", () => {
  it("seeds the telemetry a caller passes", async () => {
    const device = buildDeviceContext({ battery: 87, tempC: 21.7 });
    await runPipeline(payload("seed-passed"), null, null, device);

    expect(lastCtx().device).toEqual(device);
    expect((lastCtx().device as { present: boolean }).present).toBe(true);
  });

  it("seeds the canonical absent state when a caller passes nothing", async () => {
    await runPipeline(payload("seed-absent"));

    expect(lastCtx().device).toEqual(ABSENT_DEVICE_CONTEXT);
    expect((lastCtx().device as { present: boolean }).present).toBe(false);
  });

  it("survives the structured clone the worker boundary performs", async () => {
    const device = buildDeviceContext({ battery: 50, charging: true, units: "metric" });
    await runPipeline(payload("clone"), null, null, device);

    // ctx is built on a null-prototype object; the device half must be plain
    // JSON values or postMessage would throw a DataCloneError.
    const cloned = structuredClone(lastCtx()) as Record<string, unknown>;
    expect(cloned.device).toEqual(device);
  });
});

describe("SHADOW RULE — a user source named `device` wins (D2)", () => {
  it("overwrites the seeded telemetry and still renders clean", async () => {
    const sourceHandler: SourceHandler = async () => ({ mine: "not telemetry" });
    const raw = payload("shadow", [{ id: "device", kind: "haState", entity_id: "sensor.x" }]);

    const { meta } = await runPipeline(raw, sourceHandler, null, buildDeviceContext({ battery: 87 }));

    // Sources land at the ctx root AFTER seeding, so the user's data wins.
    expect(lastCtx().device).toEqual({ mine: "not telemetry" });
    expect(meta.sourceErrors).toEqual([]);
    expect(meta.renderErrors).toEqual([]);
  });

  it("shadows on the DECLARATION: a DISABLED `device` source is never seeded over", async () => {
    // `fetchAllSources` filters `enabled:false` sources out before its
    // `ctx[source.id] = …` loop, so a disabled source can never overwrite a
    // seeded namespace. Seeding regardless would hand a wake's telemetry to a
    // widget that declared `device` and opted out of fetching it — the stored
    // widget would render differently than it did before telemetry existed.
    const sourceHandler: SourceHandler = async () => ({ mine: "never fetched" });
    const raw = payload("shadow-disabled", [
      { id: "device", kind: "haState", entity_id: "sensor.x", enabled: false },
    ]);

    await runPipeline(raw, sourceHandler, null, buildDeviceContext({ battery: 87 }));

    expect(lastCtx().device).toBeUndefined();
  });

  it("shadows on the DECLARATION: a FAILING `device` source is never seeded over", async () => {
    // An enabled source that throws still assigns (null), so this case was
    // already safe — pinned so the declaration check cannot regress it.
    const sourceHandler: SourceHandler = async () => {
      throw new Error("upstream down");
    };
    const raw = payload("shadow-failed", [{ id: "device", kind: "haState", entity_id: "sensor.x" }]);

    await runPipeline(raw, sourceHandler, null, buildDeviceContext({ battery: 87 }));

    expect(lastCtx().device).toBeNull();
  });

  it("is never rejected server-side — `device` stays a legal source id", async () => {
    // The guard is builder-side UX only (D6). A stored widget that already
    // uses this id must keep saving and rendering forever.
    const sourceHandler: SourceHandler = async () => ({ ok: true });
    const raw = payload("shadow-legal", [{ id: "device", kind: "haState", entity_id: "sensor.y" }]);

    await expect(runPipeline(raw, sourceHandler)).resolves.toBeTruthy();
  });
});

describe("render-result cache key includes the telemetry state (D4)", () => {
  it("re-renders when only the telemetry differs", async () => {
    const raw = payload("cache-differs");

    await runPipeline(raw, null, null, buildDeviceContext({ battery: 10 }));
    await runPipeline(raw, null, null, buildDeviceContext({ battery: 90 }));

    // Two real renders: without the device half in the key, the second call
    // would have been served the first device's bytes.
    expect(seenContexts).toHaveLength(2);
    expect((seenContexts[0].device as { battery: number }).battery).toBe(10);
    expect((seenContexts[1].device as { battery: number }).battery).toBe(90);
  });

  it("still dedupes an identical payload + identical telemetry", async () => {
    const raw = payload("cache-same");
    const device = buildDeviceContext({ battery: 42 });

    await runPipeline(raw, null, null, device);
    await runPipeline(raw, null, null, device);

    expect(seenContexts).toHaveLength(1);
  });

  it("hashes `no device` and the explicit absent state identically", async () => {
    const raw = payload("cache-absent");

    await runPipeline(raw);
    await runPipeline(raw, null, null, ABSENT_DEVICE_CONTEXT);

    // A telemetry-less port render and a builder /render of the same payload
    // must share one entry rather than each paying for a full render.
    expect(seenContexts).toHaveLength(1);
  });
});

describe("null semantics that drive the authoring guidance (§1) — PINNED", () => {
  const ctx = createDataContext();
  ctx.device = ABSENT_DEVICE_CONTEXT;

  it("object binding with a default is the telemetry-safe form", () => {
    expect(resolveValue({ $: "device.battery", default: "--" }, ctx)).toBe("--");
  });

  it("a bare template renders empty — no default mechanism exists", () => {
    expect(resolveValue("{{device.battery}}", ctx)).toBe("");
  });

  it("a template piped through a math op renders 0, NOT empty", () => {
    // toNumber(null) === 0, which is exactly why docs and examples must show
    // the object binding instead of a bare piped template.
    expect(resolveValue("{{device.tempC|round}}", ctx)).toBe("0");
  });

  it("the DOCS cross-unit form picks the right pair on each panel — PINNED", () => {
    // DOCS.md "Temperature and pressure come in two shapes" publishes this
    // exact form. If it stops working the docs are lying, so pin it here.
    const form = {
      if: [
        { "==": [{ $: "device.units" }, "imperial"] },
        { $: "device.tempF", default: "--" },
        { $: "device.tempC", default: "--" },
      ],
    };
    const imperial = createDataContext();
    imperial.device = buildDeviceContext({ units: "imperial", tempF: 71.1 });
    const metric = createDataContext();
    metric.device = buildDeviceContext({ units: "metric", tempC: 21.7 });

    expect(resolveValue(form, imperial)).toBe(71.1);
    expect(resolveValue(form, metric)).toBe(21.7);
    expect(resolveValue(form, ctx)).toBe("--");
  });

  it("a binding's `default` is returned VERBATIM, never resolved — PINNED", () => {
    // Why DOCS.md steers to the `if` form instead of nesting a binding inside
    // a default: bindingResolver returns obj.default as-is, so the inner
    // object would reach the renderer unresolved.
    const imperial = createDataContext();
    imperial.device = buildDeviceContext({ units: "imperial", tempF: 71.1 });
    expect(
      resolveValue({ $: "device.tempC", default: { $: "device.tempF", default: "--" } }, imperial),
    ).toEqual({ $: "device.tempF", default: "--" });
  });

  it("the object binding covers a present-but-null field too", () => {
    const partial = createDataContext();
    partial.device = buildDeviceContext({ tempC: 21.7 });
    expect(resolveValue({ $: "device.battery", default: "--" }, partial)).toBe("--");
    expect(resolveValue({ $: "device.tempC", default: "--" }, partial)).toBe(21.7);
  });
});
