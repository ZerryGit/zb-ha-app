/**
 * haOptions.test.ts — Tests for options.json Zod validation
 *
 * Verifies that malformed HA add-on config is rejected at load time.
 * Uses filesystem mocking to test without real /data/options.json.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";

// Mock fs before importing the module
vi.mock("fs");

// Import after mocking
import { loadOptions } from "../src/ha/haOptions";

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadOptions", () => {
  it("returns defaults when file does not exist", () => {
    mockedFs.existsSync.mockReturnValue(false);
    const opts = loadOptions();
    expect(opts).toEqual({
      allowed_source_domains: [],
      allow_private_hosts: [],
      re_render_minutes: 0,
      image_port_cooldown_ms: 4000,
      image_port_mode: "on-demand",
    });
  });

  it("parses valid options", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        allowed_source_domains: ["api.weather.com"],
        re_render_minutes: 10,
      }),
    );
    const opts = loadOptions();
    expect(opts.allowed_source_domains).toEqual(["api.weather.com"]);
    expect(opts.re_render_minutes).toBe(10);
  });

  it("applies defaults for missing fields", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({}));
    const opts = loadOptions();
    expect(opts.allowed_source_domains).toEqual([]);
    expect(opts.re_render_minutes).toBe(0); // schema default (scheduler disabled)
  });

  it("rejects re_render_minutes over 60", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ re_render_minutes: 999 }),
    );
    const opts = loadOptions();
    // Should fall back to defaults because validation fails
    expect(opts.re_render_minutes).toBe(0); // DEFAULTS value
  });

  it("rejects re_render_minutes as string", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ re_render_minutes: "five" }),
    );
    const opts = loadOptions();
    expect(opts.re_render_minutes).toBe(0); // falls back to DEFAULTS
  });

  it("rejects allowed_source_domains as string instead of array", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allowed_source_domains: "*" }),
    );
    const opts = loadOptions();
    expect(opts.allowed_source_domains).toEqual([]); // falls back to DEFAULTS
  });

  it("rejects more than 50 allowed domains", () => {
    mockedFs.existsSync.mockReturnValue(true);
    const domains = Array.from({ length: 51 }, (_, i) => `domain${i}.com`);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allowed_source_domains: domains }),
    );
    const opts = loadOptions();
    expect(opts.allowed_source_domains).toEqual([]); // falls back to DEFAULTS
  });

  it("parses a valid allow_private_hosts list", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allow_private_hosts: ["192.168.1.50", "10.0.0.0/24"] }),
    );
    const opts = loadOptions();
    expect(opts.allow_private_hosts).toEqual(["192.168.1.50", "10.0.0.0/24"]);
  });

  it("defaults allow_private_hosts to empty when the key is absent", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ re_render_minutes: 5 }));
    const opts = loadOptions();
    expect(opts.allow_private_hosts).toEqual([]);
  });

  it("rejects allow_private_hosts as a string instead of an array", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allow_private_hosts: "192.168.1.50" }),
    );
    const opts = loadOptions();
    expect(opts.allow_private_hosts).toEqual([]); // falls back to DEFAULTS
  });

  it("rejects more than 50 private hosts", () => {
    mockedFs.existsSync.mockReturnValue(true);
    const hosts = Array.from({ length: 51 }, (_, i) => `192.168.1.${i}`);
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ allow_private_hosts: hosts }));
    const opts = loadOptions();
    expect(opts.allow_private_hosts).toEqual([]); // falls back to DEFAULTS
  });

  it("an over-long private-host entry does not reset the other options", () => {
    // Regression: an 18-char cap made any long typo fail the whole schema, so
    // loadOptions returned DEFAULTS and silently reopened allowed_source_domains.
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        allowed_source_domains: ["api.example.com"],
        allow_private_hosts: ["http://192.168.1.50", "192.168.1.50"],
        re_render_minutes: 15,
        image_port_mode: "cache-only",
        image_port_cooldown_ms: 9000,
      }),
    );

    const opts = loadOptions();

    expect(opts.allowed_source_domains).toEqual(["api.example.com"]);
    expect(opts.re_render_minutes).toBe(15);
    expect(opts.image_port_mode).toBe("cache-only");
    expect(opts.image_port_cooldown_ms).toBe(9000);
    // The junk entry survives the loader; configurePrivateHosts drops it (D7).
    expect(opts.allow_private_hosts).toEqual(["http://192.168.1.50", "192.168.1.50"]);
  });

  it("accepts a private-host entry up to the 253-char cap", () => {
    mockedFs.existsSync.mockReturnValue(true);
    const long = "a".repeat(253);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allow_private_hosts: [long], re_render_minutes: 7 }),
    );
    const opts = loadOptions();
    expect(opts.allow_private_hosts).toEqual([long]);
    expect(opts.re_render_minutes).toBe(7);
  });

  it("loads a list containing junk entries — the validator drops them (D7)", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allow_private_hosts: ["nas.local", "192.168.1.50", "10.0.0.0/8"] }),
    );
    const opts = loadOptions();
    // The loader is not the entry validator: it passes the list through intact
    // and configurePrivateHosts() discards the bad lines with a warning.
    expect(opts.allow_private_hosts).toEqual(["nas.local", "192.168.1.50", "10.0.0.0/8"]);
  });

  it("returns defaults on malformed JSON", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue("not-json{{{");
    const opts = loadOptions();
    expect(opts).toEqual({
      allowed_source_domains: [],
      allow_private_hosts: [],
      re_render_minutes: 0,
      image_port_cooldown_ms: 4000,
      image_port_mode: "on-demand",
    });
  });

  it("passes through extra HA keys without error", () => {
    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({
        allowed_source_domains: [],
        re_render_minutes: 3,
        some_future_ha_field: true,
      }),
    );
    const opts = loadOptions();
    expect(opts.re_render_minutes).toBe(3);
  });
});
