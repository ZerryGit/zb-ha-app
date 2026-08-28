/**
 * imagePort.test.ts — Port 8000 on-demand render and the framed device reply
 *
 * §1.2: Proves the image-serving behavior including 503 before first render,
 * 200 after render, cooldown window, and the POST `.bin` framed contract.
 *
 * Uses the extracted createOnDemandImageApp factory with mock dependencies
 * to avoid side effects from the HA entrypoint.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { RenderGuard } from "../src/core/renderService";
import { createOnDemandImageApp, type OnDemandDeps } from "../src/ha/imageApp";
import type { RenderMeta } from "../src/core/adapters";

// ── Helpers ────────────────────────────────────────────────────

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

function createTestApp(overrides: Partial<OnDemandDeps> = {}) {
  const renderGuard = new RenderGuard();
  const deps: OnDemandDeps = {
    renderGuard,
    readPayload: async () => ({ misc: {}, elements: [] }),
    runPipeline: async () => ({ pngBuffer: FAKE_PNG, binBuffer: FAKE_BIN, meta: fakeMeta }),
    cooldownMs: 50, // Short cooldown for tests
    ...overrides,
  };
  return { ...createOnDemandImageApp(deps), renderGuard };
}

/** Parse the 25-byte framed header from a response body. */
function parseFrame(body: Buffer) {
  return {
    magic: body.readUInt16LE(0),
    width: body.readUInt16LE(2),
    height: body.readUInt16LE(4),
    x: body.readUInt16LE(6),
    y: body.readUInt16LE(8),
    flags: body.readUInt16LE(10),
    nextWake: body.readUInt32LE(12),
    payloadLen: body.readUInt32LE(16),
    localTime: body.subarray(20, 25),
    image: body.subarray(25),
  };
}

// ── §1.2 Image serving behavior ────────────────────────────────

describe("image port — GET /image.png", () => {
  it("returns 503 before any render when payload is unavailable", async () => {
    const { app } = createTestApp({ readPayload: async () => null });

    const res = await request(app).get("/image.png");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("No image available yet.");
  });

  it("returns 200 with image/png after render completes", async () => {
    const { app } = createTestApp();

    const res = await request(app).get("/image.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(res.body).toString()).toBe(FAKE_PNG.toString());
  });

  it("returns no-cache headers", async () => {
    const { app } = createTestApp();

    const res = await request(app).get("/image.png");
    expect(res.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
  });

  it("returns pre-set buffer without triggering a render", async () => {
    const runPipeline = vi.fn();
    const { app, setBuffer } = createTestApp({ runPipeline, readPayload: async () => null });

    const presetPng = Buffer.from("preset-png");
    const presetBin = Buffer.from("preset-bin");
    setBuffer(presetPng, presetBin, fakeMeta);

    const res = await request(app).get("/image.png");
    expect(res.status).toBe(200);
    expect(Buffer.from(res.body).toString()).toBe("preset-png");
    // runPipeline should not have been called (payload is null, and buffer was pre-set)
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe("image port — POST /image.bin (framed device reply)", () => {
  it("returns 503 before any render when payload is unavailable", async () => {
    const { app } = createTestApp({ readPayload: async () => null });

    const res = await request(app).post("/image.bin");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("No image available yet.");
  });

  it("returns 200 with a framed reply (header + image) after render completes", async () => {
    const { app } = createTestApp();

    const res = await request(app).post("/image.bin");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");

    const body = Buffer.from(res.body as Buffer);
    expect(body.length).toBe(25 + FAKE_BIN.length);
    const frame = parseFrame(body);
    expect(frame.magic).toBe(0x5a46);
    expect(frame.width).toBe(fakeMeta.width);
    expect(frame.height).toBe(fakeMeta.height);
    expect(frame.x).toBe(0);
    expect(frame.y).toBe(0);
    expect(frame.flags).toBe(0);
    expect(frame.nextWake).toBe(0);
    expect(frame.payloadLen).toBe(FAKE_BIN.length);
    // Image bytes are polarity-inverted from the cached (Canvas convention) buffer.
    const expectedInverted = Buffer.from(FAKE_BIN.map((b) => b ^ 0xff));
    expect(frame.image.equals(expectedInverted)).toBe(true);
  });

  it("does not set a Content-Disposition header (device consumption, not a browser download)", async () => {
    const { app } = createTestApp();
    const res = await request(app).post("/image.bin");
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("GET /image.bin returns 405 (POST only)", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image.bin");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
  });

  it("never issues a 304 — the live clock makes every framed reply unique", async () => {
    const { app } = createTestApp({ cooldownMs: 60_000 });

    const first = await request(app).post("/image.bin");
    expect(first.status).toBe(200);
    // POST responses never carry an ETag at all (no conditional-GET path).
    expect(first.headers["etag"]).toBeUndefined();

    const second = await request(app).post("/image.bin").set("If-None-Match", '"sha1-whatever"');
    expect(second.status).toBe(200);
  });

  // CONSCIOUSLY UPDATED by plan 4 Part A: this test used to assert the body
  // "has no effect". A `telemetry` object now reaches the render context
  // (`device` namespace, request-scoped). What is unchanged — and is what the
  // firmware actually depends on — is the WIRE contract: same 200, same
  // content type, same legacy frame, never a 4xx for an old-firmware body.
  it("accepts any JSON telemetry body: wire contract unchanged, telemetry reaches the render", async () => {
    const runPipeline = vi.fn(async () => ({
      pngBuffer: FAKE_PNG,
      binBuffer: FAKE_BIN,
      meta: fakeMeta,
    }));
    const { app } = createTestApp({ runPipeline });
    const res = await request(app)
      .post("/image.bin")
      .set("Content-Type", "application/json")
      .send({ wakeReason: "timer", delta: 0, telemetry: { battery: 0 }, mac: "AA:BB:CC:DD:EE:FF" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");

    // battery 0 is a VALID reading, so the namespace is present.
    const device = runPipeline.mock.calls[0]?.[1] as { present: boolean; battery: number } | undefined;
    expect(device?.present).toBe(true);
    expect(device?.battery).toBe(0);
    // Never exposed, however the body is shaped.
    expect(JSON.stringify(device)).not.toContain("AA:BB");
    expect(Object.keys(device ?? {})).not.toContain("wakeReason");
  });

  it("sends the absent state when a body carries no telemetry at all", async () => {
    const runPipeline = vi.fn(async () => ({
      pngBuffer: FAKE_PNG,
      binBuffer: FAKE_BIN,
      meta: fakeMeta,
    }));
    const { app } = createTestApp({ runPipeline });
    const res = await request(app).post("/image.bin");

    expect(res.status).toBe(200);
    const device = runPipeline.mock.calls[0]?.[1] as { present: boolean } | undefined;
    expect(device?.present).toBe(false);
  });

  it("rejects an oversized body with 413 instead of hanging or crashing", async () => {
    const { app } = createTestApp();
    const oversized = Buffer.alloc(64 * 1024, 0x41); // far above MAX_DEVICE_REQUEST_BODY_BYTES
    const res = await request(app)
      .post("/image.bin")
      .set("Content-Type", "application/octet-stream")
      .send(oversized);
    expect(res.status).toBe(413);
    expect(res.body).not.toHaveProperty("stack");
  });
});

describe("image port — cooldown", () => {
  it("serves stale buffer during cooldown window instead of re-rendering", async () => {
    let renderCount = 0;
    const { app } = createTestApp({
      cooldownMs: 2_000, // 2 second cooldown
      runPipeline: async () => {
        renderCount++;
        return { pngBuffer: FAKE_PNG, binBuffer: FAKE_BIN, meta: fakeMeta };
      },
    });

    // First request triggers a render
    await request(app).get("/image.png");
    expect(renderCount).toBe(1);

    // Second request within cooldown should NOT trigger a render
    await request(app).get("/image.png");
    expect(renderCount).toBe(1);
  });

  it("re-renders after cooldown expires", async () => {
    let renderCount = 0;
    const { app } = createTestApp({
      cooldownMs: 10, // Very short cooldown for testing
      runPipeline: async () => {
        renderCount++;
        return { pngBuffer: FAKE_PNG, binBuffer: FAKE_BIN, meta: fakeMeta };
      },
    });

    await request(app).get("/image.png");
    expect(renderCount).toBe(1);

    // Wait for cooldown to expire
    await new Promise((r) => setTimeout(r, 20));

    await request(app).get("/image.png");
    expect(renderCount).toBe(2);
  });
});

describe("image port — concurrency guard", () => {
  it("serves stale buffer when RenderGuard is locked", async () => {
    const { app, setBuffer, renderGuard } = createTestApp({
      readPayload: async () => null,
    });

    // Pre-set buffer and lock the guard
    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta);
    const release = renderGuard.tryAcquire()!;

    // Request should serve stale buffer (guard is locked, no re-render)
    const res = await request(app).get("/image.png");
    expect(res.status).toBe(200);

    release();
  });
});

describe("image port — HEAD requests", () => {
  it("HEAD /image.png returns 200 with correct Content-Type and no body", async () => {
    const { app } = createTestApp();

    // Trigger a render first via GET
    await request(app).get("/image.png");

    const res = await request(app).head("/image.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.text).toBeFalsy();
  });
});

describe("image port — method rejection", () => {
  it("POST /image.png returns 405 with Allow header", async () => {
    const { app } = createTestApp();

    const res = await request(app).post("/image.png");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  it("PUT /image.bin returns 405", async () => {
    const { app } = createTestApp();

    const res = await request(app).put("/image.bin");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
  });

  it("DELETE /image.png returns 405", async () => {
    const { app } = createTestApp();

    const res = await request(app).delete("/image.png");
    expect(res.status).toBe(405);
  });
});

describe("image port — route isolation", () => {
  it("does not expose payload JSON, widget, asset, or diagnostic paths", async () => {
    const { app } = createTestApp();
    const paths = [
      "/payload",
      "/api/widgets",
      "/api/widgets/example",
      "/api/assets",
      "/api/assets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png/raw",
      "/entities",
      "/history",
      "/health",
      "/panel",
      "/builder",
      "/some/arbitrary/path",
    ];

    for (const path of paths) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.headers["content-type"] ?? "", path).not.toContain("image/");
    }
  });

  it("mutation methods on paths that don't match any image route 404 (no matching route), same as GET would", async () => {
    // The multi-device design replaced the old blanket "non-GET/HEAD
    // -> 405" middleware with per-route method handling scoped to the 4
    // known image path shapes, since POST is now valid on `.bin` routes.
    // Paths that were never image routes to begin with fall through to
    // Express's normal no-route-matched 404 regardless of method — no
    // mutation capability exists anywhere on this app either way.
    const { app } = createTestApp();
    const cases = [
      () => request(app).post("/payload"),
      () => request(app).put("/api/widgets/example"),
      () => request(app).delete("/api/assets/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png"),
      () => request(app).post("/render"),
      () => request(app).patch("/api/assets"),
    ];

    for (const run of cases) {
      const res = await run();
      expect(res.status).toBe(404);
    }
  });

  it("mutation methods on REAL image paths still 405, not 404", async () => {
    const { app } = createTestApp();
    const cases = [
      () => request(app).put("/image.png"),
      () => request(app).delete("/image.bin"),
      () => request(app).patch("/image_fullscreen.png"),
      () => request(app).delete("/image_fullscreen.bin"),
    ];
    for (const run of cases) {
      const res = await run();
      expect(res.status).toBe(405);
      expect(res.body).toEqual({ error: "Method not allowed." });
      expect(res.body).not.toHaveProperty("stack");
    }
  });
});

describe("image port — security headers", () => {
  it("sets X-Content-Type-Options: nosniff", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image.png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image.png");
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("sets Content-Security-Policy: default-src 'none'", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image.png");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
  });

  it("applies the same headers to the POST /image.bin framed reply", async () => {
    const { app } = createTestApp();
    const res = await request(app).post("/image.bin");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
  });
});

describe("image port — render errors", () => {
  it("returns stale buffer when render throws (buffer was pre-set)", async () => {
    const { app, setBuffer } = createTestApp({
      cooldownMs: 0,
      runPipeline: async () => { throw new Error("render failed"); },
    });

    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta);

    // Wait a bit for cooldown to be irrelevant
    await new Promise((r) => setTimeout(r, 5));

    const res = await request(app).get("/image.png");
    // Returns stale buffer despite render failure
    expect(res.status).toBe(200);
  });

  it("returns 503 when render throws and no buffer exists", async () => {
    const { app } = createTestApp({
      readPayload: async () => ({ some: "payload" }),
      runPipeline: async () => { throw new Error("render failed"); },
    });

    const res = await request(app).get("/image.png");
    expect(res.status).toBe(503);
  });
});

// ── Fullscreen companion routes ────────────────────────────────

describe("image port — fullscreen slot routes", () => {
  it("GET /image_fullscreen.png returns 503 when no fullscreen payload exists", async () => {
    const { app } = createTestApp({
      readPayload: async (slot) => (slot === "primary" ? { primary: true } : null),
    });

    const res = await request(app).get("/image_fullscreen.png");
    expect(res.status).toBe(503);
  });

  it("GET /image_fullscreen.png returns 200 when fullscreen payload exists", async () => {
    const FS_PNG = Buffer.from("fs-png");
    const FS_BIN = Buffer.from("fs-bin");
    const { app } = createTestApp({
      readPayload: async (slot) => (slot === "fullscreen" ? { fs: true } : null),
      runPipeline: async () => ({
        pngBuffer: FS_PNG,
        binBuffer: FS_BIN,
        meta: { ...fakeMeta, name: "fs" },
      }),
    });

    const res = await request(app).get("/image_fullscreen.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(res.body).toString()).toBe("fs-png");
  });

  it("POST /image_fullscreen.bin returns a framed reply", async () => {
    const { app } = createTestApp({
      readPayload: async () => ({ any: true }),
    });

    const res = await request(app).post("/image_fullscreen.bin");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/octet-stream");
    const body = Buffer.from(res.body as Buffer);
    expect(parseFrame(body).magic).toBe(0x5a46);
  });

  it("primary and fullscreen cooldowns are independent", async () => {
    const calls: string[] = [];
    const { app } = createTestApp({
      cooldownMs: 5_000,
      readPayload: async (slot) => ({ slot }),
      runPipeline: async (raw) => {
        calls.push((raw as { slot: string }).slot);
        return { pngBuffer: FAKE_PNG, binBuffer: FAKE_BIN, meta: fakeMeta };
      },
    });

    await request(app).get("/image.png");
    expect(calls).toEqual(["primary"]);

    // Fullscreen render should still happen — primary cooldown must not block it.
    await request(app).get("/image_fullscreen.png");
    expect(calls).toEqual(["primary", "fullscreen"]);

    // A second primary request within cooldown is suppressed.
    await request(app).get("/image.png");
    expect(calls).toEqual(["primary", "fullscreen"]);
  });

  it("evicts cached fullscreen buffer when payload becomes unavailable", async () => {
    let payloadAvailable = true;
    const { app } = createTestApp({
      cooldownMs: 0, // Force a re-read every request
      readPayload: async (slot) => (slot === "fullscreen" && payloadAvailable ? { fs: true } : null),
    });

    // First request renders and caches the buffer.
    let res = await request(app).get("/image_fullscreen.png");
    expect(res.status).toBe(200);

    // Companion deleted on disk → next request must NOT return the stale buffer.
    payloadAvailable = false;
    await new Promise((r) => setTimeout(r, 5)); // cross the (zero) cooldown

    res = await request(app).get("/image_fullscreen.png");
    expect(res.status).toBe(503);
  });

  it("POST /image_fullscreen.png returns 405", async () => {
    const { app } = createTestApp();
    const res = await request(app).post("/image_fullscreen.png");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("GET, HEAD");
  });

  it("GET /image_fullscreen.bin returns 405", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image_fullscreen.bin");
    expect(res.status).toBe(405);
    expect(res.headers["allow"]).toBe("POST");
  });

  it("HEAD /image_fullscreen.png returns 200 with no body", async () => {
    const { app } = createTestApp({ readPayload: async () => ({ fs: true }) });
    await request(app).get("/image_fullscreen.png"); // warm

    const res = await request(app).head("/image_fullscreen.png");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("image/png");
    expect(res.text).toBeFalsy();
  });

  it("evictSlot drops the cached buffer for that slot only", async () => {
    const { app, setBuffer, evictSlot, getBuffer } = createTestApp({
      readPayload: async () => null,
    });

    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta, "primary");
    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta, "fullscreen");

    expect(getBuffer("primary")).not.toBeNull();
    expect(getBuffer("fullscreen")).not.toBeNull();

    evictSlot("fullscreen");

    expect(getBuffer("primary")).not.toBeNull();
    expect(getBuffer("fullscreen")).toBeNull();

    // Primary still serves its pre-set buffer.
    const res = await request(app).get("/image.png");
    expect(res.status).toBe(200);
  });

  it("fullscreen security headers match primary", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image_fullscreen.png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'");
  });
});

// ── Task 4: cache-only mode, ETag/304 ───

describe("image port — cache-only mode", () => {
  it("never calls runPipeline in cache-only mode", async () => {
    const runPipeline = vi.fn(async () => ({
      pngBuffer: FAKE_PNG,
      binBuffer: FAKE_BIN,
      meta: fakeMeta,
    }));

    const { app, setBuffer } = createTestApp({
      runPipeline,
      mode: "cache-only",
      readPayload: async () => ({ misc: {}, elements: [] }),
    });

    // No pre-set buffer + cache-only → 503 (no render attempted).
    const empty = await request(app).get("/image.png");
    expect(empty.status).toBe(503);
    expect(runPipeline).not.toHaveBeenCalled();

    // Pre-set buffer (simulating a render driven by Ingress UI / scheduler)
    // → served as-is, still no render.
    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta, "primary");
    const served = await request(app).get("/image.png");
    expect(served.status).toBe(200);
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("cache-only respects both GET .png paths (primary + fullscreen)", async () => {
    const runPipeline = vi.fn();
    const { app } = createTestApp({ runPipeline, mode: "cache-only", readPayload: async () => null });

    for (const path of ["/image.png", "/image_fullscreen.png"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(503);
    }
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("cache-only also suppresses POST .bin renders (primary + fullscreen)", async () => {
    const runPipeline = vi.fn();
    const { app } = createTestApp({ runPipeline, mode: "cache-only", readPayload: async () => null });

    for (const path of ["/image.bin", "/image_fullscreen.bin"]) {
      const res = await request(app).post(path);
      expect(res.status).toBe(503);
    }
    expect(runPipeline).not.toHaveBeenCalled();
  });
});

describe("image port — ETag / 304 conditional GET", () => {
  it("first GET returns 200 with an ETag header", async () => {
    const { app } = createTestApp();
    const res = await request(app).get("/image.png");
    expect(res.status).toBe(200);
    expect(res.headers["etag"]).toMatch(/^"sha1-[0-9a-f]{40}"$/);
  });

  it("repeat GET with matching If-None-Match returns 304 with empty body and no render", async () => {
    let renderCount = 0;
    const runPipeline = vi.fn(async () => {
      renderCount++;
      return { pngBuffer: FAKE_PNG, binBuffer: FAKE_BIN, meta: fakeMeta };
    });

    const { app } = createTestApp({ runPipeline, cooldownMs: 0 });

    const first = await request(app).get("/image.png");
    expect(first.status).toBe(200);
    const etag = first.headers["etag"];
    expect(etag).toBeDefined();
    expect(renderCount).toBe(1);

    // Re-request with If-None-Match — must short-circuit BEFORE attempting
    // a render. This is the unauthenticated-port worst-case mitigation:
    // a polling ESP32 that already has the bytes does not drive renders.
    const second = await request(app)
      .get("/image.png")
      .set("If-None-Match", etag);
    expect(second.status).toBe(304);
    expect(Object.keys(second.body).length).toBe(0);
    expect(renderCount).toBe(1); // no additional render
  });

  it("ETag rotates after a fresh render", async () => {
    let body = Buffer.from("first");
    const runPipeline = vi.fn(async () => ({
      pngBuffer: body,
      binBuffer: FAKE_BIN,
      meta: fakeMeta,
    }));

    const { app } = createTestApp({ runPipeline, cooldownMs: 0 });

    const first = await request(app).get("/image.png");
    const firstEtag = first.headers["etag"];

    // Trigger a fresh render with new bytes — ETag must change.
    body = Buffer.from("second");
    const second = await request(app).get("/image.png");
    expect(second.status).toBe(200);
    expect(second.headers["etag"]).not.toBe(firstEtag);
  });

  it("304 fast path applies to both GET .png paths (primary + fullscreen)", async () => {
    const { app, setBuffer } = createTestApp({
      readPayload: async () => null,
      cooldownMs: 60_000, // long enough that no on-demand render can evict the pre-set buffer mid-loop
    });

    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta, "primary");
    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta, "fullscreen");

    for (const path of ["/image.png", "/image_fullscreen.png"]) {
      const first = await request(app).get(path);
      expect(first.status).toBe(200);
      const etag = first.headers["etag"];
      expect(etag).toBeDefined();

      const second = await request(app).get(path).set("If-None-Match", etag);
      expect(second.status).toBe(304);
    }
  });

  it("POST .bin never 304s even when the client sends a stale-but-matching If-None-Match", async () => {
    const { app } = createTestApp({ cooldownMs: 60_000 });

    const first = await request(app).post("/image.bin");
    expect(first.status).toBe(200);
    expect(first.headers["etag"]).toBeUndefined();

    // Even a client that (incorrectly) tries conditional GET semantics on
    // the POST route gets a full 200 framed reply — no 304 path exists here.
    const second = await request(app).post("/image.bin").set("If-None-Match", '"sha1-anything"');
    expect(second.status).toBe(200);
  });

  it("non-matching If-None-Match falls through to 200", async () => {
    const { app } = createTestApp();

    await request(app).get("/image.png"); // warm
    const res = await request(app)
      .get("/image.png")
      .set("If-None-Match", '"sha1-deadbeef"');
    expect(res.status).toBe(200);
  });

  it("evictSlot clears the ETag so subsequent 304 attempt 503s instead", async () => {
    const { app, setBuffer, evictSlot } = createTestApp({ readPayload: async () => null });

    setBuffer(FAKE_PNG, FAKE_BIN, fakeMeta, "primary");
    const first = await request(app).get("/image.png");
    const etag = first.headers["etag"];

    evictSlot("primary");

    const res = await request(app)
      .get("/image.png")
      .set("If-None-Match", etag);
    // No buffer + no payload → 503 (the conditional check requires a current ETag,
    // which was cleared by evictSlot). Proves stale ETags do not bypass 503.
    expect(res.status).toBe(503);
  });
});
