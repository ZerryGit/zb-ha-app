/**
 * assetFetchTimeout.test.ts — The img/svg fetch deadline is a chosen value
 *
 * `IMAGE_FETCH_TIMEOUT_MS` gates time-to-first-byte on every asset fetch. At
 * 300 ms it rejected any host more than a short hop away — measured TTFB to a
 * US origin from the EU was 1.1–2.7 s — so remote images failed constantly.
 * These cases pin the 5 s contract itself rather than the constant, so the
 * value stays deliberate: a host that stalls before headers must be refused at
 * 5000 ms, and one that answers a second in must be served.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../src/data/urlValidator", () => ({
  validateUrl: vi.fn(),
  validateUrlWithDns: vi.fn(async () => {}),
}));

import {
  fetchBufferWithLimit,
  MAX_IMAGE_FETCH_BYTES,
  IMAGE_FETCH_TIMEOUT_MS,
} from "../src/engine/primitives/assetLimits";

const URL_UNDER_TEST = "https://example.com/moon.jpg";

/** A response whose headers never arrive; only the abort signal ends it. */
function stallForever(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

/** A response whose headers arrive after `delayMs`. */
function respondAfter(delayMs: number, body: Buffer) {
  return (_url: string, _init?: RequestInit): Promise<Response> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve(
          new Response(body, {
            status: 200,
            headers: { "content-length": String(body.byteLength) },
          }),
        );
      }, delayMs);
    });
}

describe("asset fetch timeout", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.fetch = realFetch;
  });

  it("refuses a host that stalls before headers, at 5000 ms", async () => {
    globalThis.fetch = vi.fn(stallForever) as unknown as typeof fetch;

    const pending = fetchBufferWithLimit(
      URL_UNDER_TEST,
      "Image source",
      MAX_IMAGE_FETCH_BYTES,
      IMAGE_FETCH_TIMEOUT_MS,
    );
    const assertion = expect(pending).rejects.toThrow("Request timed out after 5000ms");

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("is still pending at 300 ms — the old budget no longer decides", async () => {
    globalThis.fetch = vi.fn(stallForever) as unknown as typeof fetch;

    let settled = false;
    const pending = fetchBufferWithLimit(
      URL_UNDER_TEST,
      "Image source",
      MAX_IMAGE_FETCH_BYTES,
      IMAGE_FETCH_TIMEOUT_MS,
    ).catch(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(settled).toBe(true);
  });

  it("serves a host that takes a second to answer", async () => {
    const body = Buffer.from([1, 2, 3, 4]);
    globalThis.fetch = vi.fn(respondAfter(1000, body)) as unknown as typeof fetch;

    const pending = fetchBufferWithLimit(
      URL_UNDER_TEST,
      "Image source",
      MAX_IMAGE_FETCH_BYTES,
      IMAGE_FETCH_TIMEOUT_MS,
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual(body);
  });
});
