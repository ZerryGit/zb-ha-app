/**
 * deviceTelemetry.test.ts — per-field telemetry schemas + `device` namespace
 * construction (plan 4 Part A, Phase 1: D1 classification, D4 constructor).
 *
 * Phase 1 is extraction only — nothing consumes `device` yet. These tests pin
 * the classification contract so the Phase 2/3 wiring cannot quietly change it:
 * per-field fail-soft, unknown keys ignored, telemetry never rescuing a bad
 * selector, and the exposure policy (`wakeReason`/`delta`/`mac` never appear).
 *
 * The 413 body cap is unchanged by this work and stays covered by
 * `imagePort.test.ts:172`.
 */

import { describe, it, expect } from "vitest";
import { classifyDeviceRequestBody } from "../src/ha/imageApp";
import { buildDeviceContext, ABSENT_DEVICE_CONTEXT } from "../src/core/adapters";

/** The LOCKED firmware body from plan 4 §0, verbatim. */
const LOCKED_BODY = {
  requestedInstances: [1704755566],
  wakeReason: "timer",
  delta: 0,
  telemetry: {
    battery: 0,
    charging: false,
    units: "metric",
    tempC: 21.7,
    humidity: 43.5,
    pressureHpa: 1012.3,
  },
  mac: "AA:BB:CC:DD:EE:FF",
};

const body = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

describe("buildDeviceContext", () => {
  it("with no fields returns the canonical absent state", () => {
    expect(buildDeviceContext()).toEqual({
      present: false,
      battery: null,
      charging: null,
      units: null,
      tempC: null,
      tempF: null,
      humidity: null,
      pressureHpa: null,
      pressureInhg: null,
    });
  });

  it("fixes key order by construction — the D4 cache key depends on it", () => {
    const populated = Object.keys(buildDeviceContext({ tempC: 5, battery: 9 }));
    expect(populated).toEqual([
      "present",
      "battery",
      "charging",
      "units",
      "tempC",
      "tempF",
      "humidity",
      "pressureHpa",
      "pressureInhg",
    ]);
    // Same order whether populated or absent, so both hash comparably.
    expect(Object.keys(buildDeviceContext())).toEqual(populated);
  });

  it("present is true iff at least one field validated — falsy values count", () => {
    expect(buildDeviceContext({}).present).toBe(false);
    expect(buildDeviceContext({ battery: 0 }).present).toBe(true);
    expect(buildDeviceContext({ charging: false }).present).toBe(true);
    expect(buildDeviceContext({ tempC: 0 }).present).toBe(true);
  });

  it("exposes the absent state as a frozen shared constant", () => {
    expect(ABSENT_DEVICE_CONTEXT).toEqual(buildDeviceContext());
    expect(Object.isFrozen(ABSENT_DEVICE_CONTEXT)).toBe(true);
  });
});

describe("classifyDeviceRequestBody — telemetry extraction", () => {
  it("reads the locked firmware body: instances path + every field populated", () => {
    const result = classifyDeviceRequestBody(body(LOCKED_BODY));

    expect(result.kind).toBe("instances");
    if (result.kind !== "instances") return;
    expect(result.ids).toEqual([1704755566]);
    expect(result.rejectedFields).toEqual([]);
    expect(result.device).toEqual({
      present: true,
      battery: 0,
      charging: false,
      units: "metric",
      tempC: 21.7,
      tempF: null,
      humidity: 43.5,
      pressureHpa: 1012.3,
      pressureInhg: null,
    });
  });

  it("reads the same telemetry off a LEGACY body (no requestedInstances)", () => {
    const { requestedInstances, ...legacy } = LOCKED_BODY;
    void requestedInstances;
    const result = classifyDeviceRequestBody(body(legacy));

    expect(result.kind).toBe("legacy");
    if (result.kind !== "legacy") return;
    expect(result.device.present).toBe(true);
    expect(result.device.tempC).toBe(21.7);
  });

  it("reads an IMPERIAL body: tempF/pressureInhg populate, the metric pair stays null", () => {
    // The firmware sends DIFFERENT KEYS per unit mode. Both shapes are read
    // raw, so an imperial panel populates its own pair and leaves the metric
    // one null -- no conversion, no branching on `units`.
    const result = classifyDeviceRequestBody(
      body({
        wakeReason: "timer",
        telemetry: {
          battery: 0,
          charging: false,
          units: "imperial",
          tempF: 71.1,
          humidity: 43.5,
          pressureInhg: 29.89,
        },
        mac: "AA:BB:CC:DD:EE:FF",
      }),
    );
    if (result.kind !== "legacy") throw new Error("expected legacy");

    expect(result.device).toEqual({
      present: true,
      battery: 0,
      charging: false,
      units: "imperial",
      tempC: null,
      tempF: 71.1,
      humidity: 43.5,
      pressureHpa: null,
      pressureInhg: 29.89,
    });
    // Silent-drop regression guard: before tempF/pressureInhg had schemas they
    // were UNKNOWN keys, so an imperial panel lost both readings with no warn.
    expect(result.rejectedFields).toEqual([]);
  });

  it("accepts the imperial range as the same physical span as the metric one", () => {
    const ok = classifyDeviceRequestBody(
      body({ telemetry: { tempF: -130, pressureInhg: 35.45 } }),
    );
    if (ok.kind !== "legacy") throw new Error("expected legacy");
    expect(ok.device.tempF).toBe(-130);
    expect(ok.device.pressureInhg).toBe(35.45);

    const bad = classifyDeviceRequestBody(
      body({ telemetry: { tempF: 195, pressureInhg: 8.5 } }),
    );
    if (bad.kind !== "legacy") throw new Error("expected legacy");
    expect(bad.device.tempF).toBeNull();
    expect(bad.device.pressureInhg).toBeNull();
    expect(bad.rejectedFields).toEqual(["tempF", "pressureInhg"]);
  });

  it("populates both pairs when a body carries both -- values are raw, never converted", () => {
    const result = classifyDeviceRequestBody(
      body({ telemetry: { tempC: 21.7, tempF: 71.1 } }),
    );
    if (result.kind !== "legacy") throw new Error("expected legacy");
    expect(result.device.tempC).toBe(21.7);
    expect(result.device.tempF).toBe(71.1);
  });

  it("NEVER exposes wakeReason, delta or mac (D5)", () => {
    const result = classifyDeviceRequestBody(body(LOCKED_BODY));
    if (result.kind === "invalid") throw new Error("unexpected invalid");
    expect(Object.keys(result.device)).not.toContain("mac");
    expect(Object.keys(result.device)).not.toContain("wakeReason");
    expect(Object.keys(result.device)).not.toContain("delta");
    expect(JSON.stringify(result.device)).not.toContain("AA:BB");
  });

  it("nulls ONLY the invalid field and reports its name — siblings still render", () => {
    const result = classifyDeviceRequestBody(
      body({ telemetry: { battery: 101, tempC: 21.7, humidity: 43.5 } }),
    );
    if (result.kind !== "legacy") throw new Error("expected legacy");

    expect(result.device.battery).toBeNull();
    expect(result.device.tempC).toBe(21.7);
    expect(result.device.humidity).toBe(43.5);
    expect(result.device.present).toBe(true);
    expect(result.rejectedFields).toEqual(["battery"]);
  });

  it("rejects every out-of-range value independently", () => {
    const result = classifyDeviceRequestBody(
      body({
        telemetry: {
          battery: -1,
          charging: "yes",
          units: "kelvin",
          tempC: 91,
          humidity: 101,
          pressureHpa: 299,
        },
      }),
    );
    if (result.kind !== "legacy") throw new Error("expected legacy");

    expect(result.device).toEqual(ABSENT_DEVICE_CONTEXT);
    expect(result.device.present).toBe(false);
    expect(result.rejectedFields).toEqual([
      "battery",
      "charging",
      "units",
      "tempC",
      "humidity",
      "pressureHpa",
    ]);
  });

  it("treats non-finite and wrong-typed numbers as invalid", () => {
    // JSON cannot carry Infinity literally, but 1e309 parses to it.
    const result = classifyDeviceRequestBody(body({ telemetry: { tempC: 1e309, battery: "50" } }));
    if (result.kind !== "legacy") throw new Error("expected legacy");
    expect(result.device.tempC).toBeNull();
    expect(result.device.battery).toBeNull();
    expect(result.rejectedFields).toEqual(["battery", "tempC"]);
  });

  it("ignores unknown telemetry keys instead of rejecting them", () => {
    const result = classifyDeviceRequestBody(
      body({ telemetry: { battery: 50, someFutureField: 123, nested: { a: 1 } } }),
    );
    if (result.kind !== "legacy") throw new Error("expected legacy");

    expect(result.device.battery).toBe(50);
    expect(result.rejectedFields).toEqual([]);
    expect(Object.keys(result.device)).not.toContain("someFutureField");
  });

  it("does not report an ABSENT field as rejected", () => {
    const result = classifyDeviceRequestBody(body({ telemetry: { battery: 50 } }));
    if (result.kind !== "legacy") throw new Error("expected legacy");
    expect(result.device.tempC).toBeNull();
    expect(result.rejectedFields).toEqual([]);
  });

  it.each([
    ["an empty telemetry object", { telemetry: {} }],
    ["a string telemetry", { telemetry: "21.7" }],
    ["an array telemetry", { telemetry: [1, 2] }],
    ["a null telemetry", { telemetry: null }],
    ["no telemetry key at all", { wakeReason: "timer" }],
  ])("yields the absent state for %s", (_label, payload) => {
    const result = classifyDeviceRequestBody(body(payload));
    if (result.kind === "invalid") throw new Error("unexpected invalid");
    expect(result.device).toEqual(ABSENT_DEVICE_CONTEXT);
    expect(result.rejectedFields).toEqual([]);
  });

  it.each([
    ["a body-less POST", Buffer.alloc(0)],
    ["a non-JSON body", Buffer.from("not json at all", "utf8")],
    ["a JSON array body", Buffer.from("[1,2,3]", "utf8")],
    ["a non-Buffer body", undefined],
  ])("stays legacy with the absent state for %s", (_label, raw) => {
    const result = classifyDeviceRequestBody(raw);
    expect(result.kind).toBe("legacy");
    if (result.kind !== "legacy") return;
    expect(result.device).toEqual(ABSENT_DEVICE_CONTEXT);
  });
});

describe("classifyDeviceRequestBody — selector precedence is unchanged", () => {
  it("an INVALID selector is still 400-bound even with perfectly valid telemetry", () => {
    const result = classifyDeviceRequestBody(
      body({ requestedInstances: "nope", telemetry: { battery: 50 } }),
    );
    // Telemetry never rescues a bad selector, and no device rides along.
    expect(result).toEqual({ kind: "invalid" });
  });

  it("an over-long selector is still invalid regardless of telemetry", () => {
    const result = classifyDeviceRequestBody(
      body({
        requestedInstances: Array.from({ length: 13 }, (_, i) => i + 1),
        telemetry: { battery: 50 },
      }),
    );
    expect(result).toEqual({ kind: "invalid" });
  });

  it("still dedupes IDs while carrying telemetry", () => {
    const result = classifyDeviceRequestBody(
      body({ requestedInstances: [7, 7, 9], telemetry: { battery: 50 } }),
    );
    if (result.kind !== "instances") throw new Error("expected instances");
    expect(result.ids).toEqual([7, 9]);
    expect(result.device.battery).toBe(50);
  });
});
