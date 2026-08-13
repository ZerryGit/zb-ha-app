/**
 * privateHostsSources.test.ts — `allow_private_hosts` on the data-source path
 *
 * Uses the REAL urlValidator (unlike redirectSsrf.test.ts, which mocks it) and
 * stubs only the transport, so these exercise the actual matcher end to end:
 * sourceFetcher.ts's opt-in on the initial URL, its strict redirect target
 * (D4), and the builder's Test Source route.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

const mockFetch = vi.fn();

vi.mock("../src/data/safeFetch", () => ({
  fetchWithTimeout: (...args: unknown[]) => mockFetch(...args),
  readResponseTextWithLimit: (response: Response) => response.text(),
}));

import request from "supertest";
import { fetchAllSources, type SourceDef } from "../src/data/sourceFetcher";
import { createDataContext } from "@zb/expressions";
import {
  configurePrivateHosts,
  configureUrlValidator,
  configureBlockedHostnames,
} from "../src/data/urlValidator";
import { createIngressApp } from "../src/core/server";
import type { PlatformAdapter, StorageAdapter, WidgetMeta } from "../src/core/adapters";

function makeSource(url: string, id = "priv-test"): SourceDef {
  return { id, kind: "http", method: "GET", url, response: { type: "json" } } as SourceDef;
}

function makeOkResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    body: null,
    text: () => Promise.resolve(JSON.stringify(payload)),
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
    text: () => Promise.resolve(""),
  };
}

function createAdapter(): PlatformAdapter {
  const storage: StorageAdapter = {
    readWidget: async () => null,
    writeWidget: async () => {},
    deleteWidget: async () => false,
    listWidgets: async (): Promise<WidgetMeta[]> => [],
    readPayload: async () => null,
    writePayload: async () => false,
    writeCachedImage: async () => false,
    getCachedImagePath: () => null,
  };
  return {
    storage,
    registerRoutes() {},
    getBlockedHostnames: () => [],
    getSourceHandler: () => null,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  configurePrivateHosts([]);
  configureUrlValidator([]);
  configureBlockedHostnames(["localhost", "supervisor", "hassio", "homeassistant"]);
});

afterAll(() => {
  configurePrivateHosts([]);
  configureUrlValidator([]);
});

describe("data-source fetch honors allow_private_hosts", () => {
  it("fetches a listed private IP", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    mockFetch.mockResolvedValueOnce(makeOkResponse({ temp: 21 }));

    const ctx = createDataContext();
    const result = await fetchAllSources([makeSource("http://192.168.1.50/api")], ctx);

    expect(result.errors).toEqual([]);
    expect(ctx["priv-test"]).toEqual({ temp: 21 });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("fetches any address inside a listed /24", async () => {
    configurePrivateHosts(["10.0.5.0/24"]);
    mockFetch.mockResolvedValueOnce(makeOkResponse({ ok: true }));

    const result = await fetchAllSources(
      [makeSource("http://10.0.5.200:9000/status")],
      createDataContext(),
    );
    expect(result.errors).toEqual([]);
  });

  it("refuses an unlisted address in the same subnet, without fetching", async () => {
    configurePrivateHosts(["192.168.1.50"]);

    const result = await fetchAllSources(
      [makeSource("http://192.168.1.51/api")],
      createDataContext(),
    );

    expect(result.errors[0].message).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses every private address when the list is empty", async () => {
    const result = await fetchAllSources(
      [makeSource("http://192.168.1.50/api")],
      createDataContext(),
    );

    expect(result.errors[0].message).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("refuses loopback even when the operator listed it (D3)", async () => {
    configurePrivateHosts(["127.0.0.1"]);

    const result = await fetchAllSources(
      [makeSource("http://127.0.0.1:8000/img.png")],
      createDataContext(),
    );

    expect(result.errors[0].message).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("the exemption never applies to a redirect target (D4)", () => {
  it("refuses a public host redirecting to a listed private IP", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    mockFetch.mockResolvedValueOnce(makeRedirectResponse("http://192.168.1.50/admin"));

    // A public IP literal, not a hostname — the real validator is in play here
    // and a hostname would need DNS.
    const result = await fetchAllSources(
      [makeSource("http://8.8.8.8/api")],
      createDataContext(),
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("private/internal address");
  });

  it("refuses a listed private host redirecting to another listed private IP", async () => {
    configurePrivateHosts(["192.168.1.0/24"]);
    mockFetch.mockResolvedValueOnce(makeRedirectResponse("http://192.168.1.99/other"));

    const result = await fetchAllSources(
      [makeSource("http://192.168.1.50/api")],
      createDataContext(),
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].message).toContain("private/internal address");
  });
});

describe("POST /render/test-source — the builder's Test Source button", () => {
  function post(body: unknown, clientIp: string) {
    const { ingressApp } = createIngressApp(createAdapter());
    ingressApp.set("trust proxy", true);
    return request(ingressApp)
      .post("/render/test-source")
      .set("X-Forwarded-For", clientIp)
      .send(body as object);
  }

  it("succeeds for a listed private IP", async () => {
    configurePrivateHosts(["192.168.1.50"]);
    mockFetch.mockResolvedValueOnce(makeOkResponse({ temp: 21 }));

    const res = await post(
      { id: "s1", kind: "http", method: "GET", url: "http://192.168.1.50/api", response: { type: "json" } },
      "198.51.100.40",
    );

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.errors).toEqual([]);
    expect(res.body.data).toEqual({ temp: 21 });
  });

  it("still fails for an unlisted private IP", async () => {
    configurePrivateHosts(["192.168.1.50"]);

    const res = await post(
      { id: "s1", kind: "http", method: "GET", url: "http://192.168.1.99/api", response: { type: "json" } },
      "198.51.100.41",
    );

    expect(res.status).toBe(200);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0].message).toContain("private/internal address");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
