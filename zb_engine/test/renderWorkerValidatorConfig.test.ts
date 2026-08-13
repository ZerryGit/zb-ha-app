/**
 * renderWorkerValidatorConfig.test.ts — the SSRF config crossing the thread boundary
 *
 * `render()` runs in a worker_thread, which has its own module registry, so
 * `urlValidator.ts` is a second, empty instance there. Phase 4's exemption is
 * inert until the main thread's allowlists are handed over at spawn (D11).
 *
 * READ BEFORE EXTENDING: `test/helpers/inlineRenderWorker.ts` runs `render()` on
 * the MAIN thread, where the config is already applied — a test written against
 * it passes while production is broken. That is exactly how the v4 bug reached
 * the bench. These tests therefore assert the two halves of the hand-off
 * separately (what is sent, and what the receiver does with it); only the VM
 * bench can prove the whole path, by showing a `security.private_hosts.permitted`
 * line with `label: "Image source"`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { EventEmitter } from "node:events";

const hoisted = vi.hoisted(() => ({
  ctorCalls: [] as Array<{ specifier: unknown; options: unknown; instance: EventEmitter }>,
}));

// Async factory: vi.mock is hoisted above this file's imports, so it has to
// pull EventEmitter in itself.
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");

  class FakeWorker extends EventEmitter {
    constructor(specifier: unknown, options: unknown) {
      super();
      hoisted.ctorCalls.push({ specifier, options, instance: this });
    }
    postMessage(): void {}
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
    unref(): void {}
  }
  // parentPort null ⇒ importing renderWorker.ts here does NOT run its bootstrap,
  // so these tests drive `applyValidatorConfig` explicitly.
  return { Worker: FakeWorker, parentPort: null, workerData: undefined };
});

import { createDataContext } from "@zb/expressions";
import { renderInWorker, __setEngineWorkerFactory } from "../src/core/renderService";
import { applyValidatorConfig } from "../src/core/renderWorker";
import {
  getUrlValidatorConfig,
  configureUrlValidator,
  configurePrivateHosts,
  configureBlockedHostnames,
} from "../src/data/urlValidator";

function resetValidator(): void {
  configureUrlValidator([]);
  configurePrivateHosts([]);
  configureBlockedHostnames([]);
}

/** Spawn a worker through the real default factory and return its ctor options. */
function spawnAndCaptureOptions(): unknown {
  const before = hoisted.ctorCalls.length;
  void renderInWorker([], createDataContext(), 8, 8).catch(() => {});
  expect(hoisted.ctorCalls.length).toBe(before + 1);
  const call = hoisted.ctorCalls[before];
  // renderService caches one long-lived worker; "exit" runs disposeEngineWorker
  // so the next spawn is fresh, and settles the promise we deliberately ignore.
  call.instance.emit("exit", 0);
  return call.options;
}

beforeEach(() => {
  hoisted.ctorCalls.length = 0;
  __setEngineWorkerFactory(null);
  resetValidator();
});

afterAll(() => {
  __setEngineWorkerFactory(null);
  resetValidator();
});

describe("getUrlValidatorConfig", () => {
  it("snapshots all three allowlists in configure* input form", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50", "10.0.5.0/24"]);
    configureBlockedHostnames(["supervisor", "hassio"]);

    expect(getUrlValidatorConfig()).toEqual({
      allowedDomains: ["api.example.com"],
      privateHosts: ["192.168.1.50", "10.0.5.0/24"],
      blockedHostnames: ["localhost", "supervisor", "hassio"],
    });
  });

  it("reports private hosts VERBATIM, dropped entries included", () => {
    // Deliberately not the normalized/accepted list. An entry's audit index is
    // its position in the list it was parsed from, so handing the worker a
    // filtered list renumbers it: the bench showed the same address logged as
    // `Source entry:2` on the main thread and `Image source entry:1` in the
    // worker. Passing the operator's list unchanged keeps both in step.
    configurePrivateHosts(["  192.168.1.50/32 ", "nas.local", "10.0.0.0/8"]);

    expect(getUrlValidatorConfig().privateHosts).toEqual([
      "  192.168.1.50/32 ",
      "nas.local",
      "10.0.0.0/8",
    ]);
  });

  it("re-parses to the same rows in the worker as on the main thread", () => {
    configurePrivateHosts(["nas.local", "192.168.1.50"]);
    const mainThread = configurePrivateHosts(["nas.local", "192.168.1.50"]);

    // What the worker does with the snapshot it is handed.
    const inWorker = configurePrivateHosts(getUrlValidatorConfig().privateHosts);

    expect(inWorker.acceptedIndices).toEqual(mainThread.acceptedIndices);
    expect(inWorker.rejected.map((r) => r.index)).toEqual(
      mainThread.rejected.map((r) => r.index),
    );
    expect(inWorker.acceptedIndices).toEqual([2]);
  });

  it("returns copies — mutating the result does not reach the validator", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50"]);
    configureBlockedHostnames(["supervisor"]);

    const snapshot = getUrlValidatorConfig();
    snapshot.allowedDomains.push("evil.example.net");
    snapshot.privateHosts.push("127.0.0.1");
    snapshot.blockedHostnames.length = 0;

    expect(getUrlValidatorConfig()).toEqual({
      allowedDomains: ["api.example.com"],
      privateHosts: ["192.168.1.50"],
      blockedHostnames: ["localhost", "supervisor"],
    });
  });
});

describe("the spawn hands the config to the worker", () => {
  it("passes workerData matching getUrlValidatorConfig()", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50"]);
    configureBlockedHostnames(["supervisor"]);

    const options = spawnAndCaptureOptions();

    expect(options).toEqual({ workerData: getUrlValidatorConfig() });
    expect((options as { workerData: { privateHosts: string[] } }).workerData.privateHosts)
      .toEqual(["192.168.1.50"]);
  });

  it("passes an empty-but-well-formed config when nothing is configured", () => {
    const options = spawnAndCaptureOptions();

    expect(options).toEqual({
      workerData: { allowedDomains: [], privateHosts: [], blockedHostnames: ["localhost"] },
    });
  });

  it("resolves the worker script alongside the compiled module", () => {
    spawnAndCaptureOptions();
    expect(String(hoisted.ctorCalls[0].specifier)).toMatch(/renderWorker\.js$/);
  });
});

describe("the worker applies the config it was given", () => {
  it("invokes all three configure* functions with the workerData contents", () => {
    applyValidatorConfig({
      allowedDomains: ["api.example.com"],
      privateHosts: ["192.168.1.50", "10.0.5.0/24"],
      blockedHostnames: ["supervisor", "homeassistant"],
    });

    expect(getUrlValidatorConfig()).toEqual({
      allowedDomains: ["api.example.com"],
      privateHosts: ["192.168.1.50", "10.0.5.0/24"],
      blockedHostnames: ["localhost", "supervisor", "homeassistant"],
    });
  });

  it("round-trips a main-thread snapshot exactly", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50", "172.16.4.0/24"]);
    configureBlockedHostnames(["supervisor", "hassio", "homeassistant"]);
    const fromMainThread = getUrlValidatorConfig();

    resetValidator(); // stand in for the worker's fresh, empty module instance
    expect(getUrlValidatorConfig().privateHosts).toEqual([]);

    applyValidatorConfig(fromMainThread);

    expect(getUrlValidatorConfig()).toEqual(fromMainThread);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a non-object", "192.168.1.50"],
    ["an empty object", {}],
    ["a missing field", { allowedDomains: [], privateHosts: [] }],
    ["a non-array field", { allowedDomains: [], privateHosts: "x", blockedHostnames: [] }],
    [
      "an array of non-strings",
      { allowedDomains: [], privateHosts: [42], blockedHostnames: [] },
    ],
  ])("throws rather than rendering without a config for %s", (_label, config) => {
    expect(() => applyValidatorConfig(config)).toThrow(/refusing to render/);
  });

  it("does not half-apply a malformed config", () => {
    configureUrlValidator(["api.example.com"]);
    configurePrivateHosts(["192.168.1.50"]);
    const before = getUrlValidatorConfig();

    expect(() =>
      applyValidatorConfig({ allowedDomains: ["evil.example.net"], privateHosts: "x" }),
    ).toThrow();

    expect(getUrlValidatorConfig()).toEqual(before);
  });

  it("fails closed rather than falling back to allow-all-public defaults", () => {
    // The module defaults block private hosts but leave allowedDomains empty
    // (= every public host) and drop the internal HA hostnames, so keeping
    // them on a malformed config would widen egress, not narrow it.
    expect(() => applyValidatorConfig(undefined)).toThrow();
  });
});
