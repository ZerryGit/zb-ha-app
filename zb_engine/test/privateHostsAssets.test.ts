/**
 * privateHostsAssets.test.ts — `allow_private_hosts` on the img/svg path
 *
 * One test per call path reaching `fetchBufferWithLimit` (plan 3.25 §1b):
 * the engine's `img.ts:25`, the out-of-engine `svgInlineSanitizer.ts:180` that
 * a literal `src` actually hits, and the in-engine `svg.ts:137` fallback.
 *
 * Uses the REAL urlValidator — unlike assetRedirectSsrf.test.ts, which mocks it
 * — and stubs only global fetch, so the actual matcher is under test.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import sharp from "sharp";
import { Canvas } from "../src/engine/canvas";
import { drawImg } from "../src/engine/primitives/img";
import { drawSvg } from "../src/engine/primitives/svg";
import { sanitizeSvgElementsForEngine } from "../src/data/svgInlineSanitizer";
import {
  configurePrivateHosts,
  configureUrlValidator,
  configureBlockedHostnames,
} from "../src/data/urlValidator";
import type { ImgProps, SvgProps } from "../src/engine/types";

const SVG_BYTES = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

let pngBytes: Uint8Array;
const realFetch = globalThis.fetch;
const mockFetch = vi.fn();

function makeOkResponse(bytes: Uint8Array) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" ? String(bytes.byteLength) : null,
    },
    body: null,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
  };
}

function makeRedirectResponse(location: string) {
  return {
    ok: false,
    status: 302,
    statusText: "Found",
    headers: {
      get: (name: string) => (name.toLowerCase() === "location" ? location : null),
    },
    body: null,
  };
}

function imgProps(src: string): ImgProps {
  return {
    src,
    pos: { x: 0, y: 0 },
    sizeX: 8,
    sizeY: 8,
    bwMode: "threshold",
    bwLevel: 50,
    opacity: 100,
  } as ImgProps;
}

function svgProps(src: string): SvgProps {
  return {
    src,
    pos: { x: 0, y: 0 },
    sizeX: 8,
    sizeY: 8,
    bwMode: "threshold",
    bwLevel: 50,
    opacity: 100,
  } as SvgProps;
}

beforeEach(async () => {
  pngBytes ??= new Uint8Array(
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer(),
  );
  mockFetch.mockReset();
  globalThis.fetch = mockFetch as unknown as typeof fetch;
  configurePrivateHosts([]);
  configureUrlValidator([]);
  configureBlockedHostnames(["localhost", "supervisor", "hassio", "homeassistant"]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

afterAll(() => {
  configurePrivateHosts([]);
  configureUrlValidator([]);
});

describe("path 1 — img element (img.ts:25)", () => {
  it("loads an image from a listed private IP", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    mockFetch.mockResolvedValueOnce(makeOkResponse(pngBytes));

    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://192.168.1.50/snapshot.jpg")),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("is blocked with an empty allowlist, without fetching", async () => {
    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://192.168.1.50/snapshot.jpg")),
    ).rejects.toThrow(/private\/internal address/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("is blocked for an unlisted address in the same subnet", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://192.168.1.51/snapshot.jpg")),
    ).rejects.toThrow(/private\/internal address/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("path 2 — literal svg src, via svgInlineSanitizer (:180)", () => {
  async function sanitizeOne(src: string) {
    const [el] = await sanitizeSvgElementsForEngine([{ type: "svg", svg: "", src }]);
    return el as { svg: string; src: string };
  }

  it("fetches and inlines an SVG from a listed private IP", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    mockFetch.mockResolvedValueOnce(makeOkResponse(new TextEncoder().encode(SVG_BYTES)));

    const el = await sanitizeOne("http://192.168.1.50/icon.svg");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(el.svg).toContain("<svg");
    expect(el.svg).toContain("rect");
    expect(el.src).toBe("");
  });

  it("blanks the element with an empty allowlist, without fetching", async () => {
    const el = await sanitizeOne("http://192.168.1.50/icon.svg");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(el.svg).toBe("");
    expect(el.src).toBe("");
  });

  it("blanks the element for an unlisted address", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    const el = await sanitizeOne("http://192.168.1.99/icon.svg");

    expect(mockFetch).not.toHaveBeenCalled();
    expect(el.svg).toBe("");
  });
});

describe("path 3 — in-engine svg fallback (svg.ts:137)", () => {
  it("loads an SVG from a listed private IP", async () => {
    configurePrivateHosts(["10.0.0.7"]);
    mockFetch.mockResolvedValueOnce(makeOkResponse(new TextEncoder().encode(SVG_BYTES)));

    await expect(
      drawSvg(new Canvas(8, 8), svgProps("http://10.0.0.7/icon.svg")),
    ).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("is blocked with an empty allowlist, without fetching", async () => {
    await expect(
      drawSvg(new Canvas(8, 8), svgProps("http://10.0.0.7/icon.svg")),
    ).rejects.toThrow(/private\/internal address/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("never-exemptable targets and redirects on the asset path", () => {
  it("refuses loopback even when the operator listed it (D3)", async () => {
    configurePrivateHosts(["127.0.0.1"]);
    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://127.0.0.1:8000/slot.png")),
    ).rejects.toThrow(/private\/internal address/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses the cloud metadata endpoint", async () => {
    configurePrivateHosts(["169.254.169.254", "192.168.1.0/24"]);
    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://169.254.169.254/latest/meta-data")),
    ).rejects.toThrow(/private\/internal address/);
  });

  it("refuses a public image host redirecting to a listed private IP (D4)", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    mockFetch.mockResolvedValueOnce(makeRedirectResponse("http://192.168.1.50/snapshot.jpg"));

    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://8.8.8.8/snapshot.jpg")),
    ).rejects.toThrow(/private\/internal address/);
  });

  it("refuses a listed private host redirecting within the same listed /24 (D4)", async () => {
    configurePrivateHosts(["192.168.1.0/24"]);
    mockFetch.mockResolvedValueOnce(makeRedirectResponse("http://192.168.1.99/snapshot.jpg"));

    await expect(
      drawImg(new Canvas(8, 8), imgProps("http://192.168.1.50/snapshot.jpg")),
    ).rejects.toThrow(/private\/internal address/);
  });
});
