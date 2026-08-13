/**
 * haOptions.ts — Home Assistant add-on options loader
 *
 * Reads /data/options.json written by the HA Supervisor whenever the
 * user saves changes in the add-on Configuration tab.
 */

import * as fs from "fs";
import { z } from "zod";
import { logWarn } from "../core/logger";

export interface AddonOptions {
  allowed_source_domains: string[];
  /**
   * Private LAN addresses the add-on may fetch from, for both HTTP data
   * sources and img/svg elements. IPv4 literals or /24–/32 CIDRs; ships
   * empty. Entries are parsed and enforced in data/urlValidator.ts.
   */
  allow_private_hosts: string[];
  re_render_minutes: number; // 0 = disabled, 1–60; ships disabled (config.yaml re_render_minutes: 0)
  /**
   * Per-slot minimum interval between on-demand renders triggered by
   * port-8000 GETs. Bounds the render rate ESP32 / LAN clients can
   * drive on the unauthenticated image port. Range 1000–60000 ms.
   */
  image_port_cooldown_ms: number;
  /**
   * Render policy for port 8000:
   *  - `"on-demand"` (default, legacy behavior): each GET may trigger
   *    a fresh render once the per-slot cooldown elapses.
   *  - `"cache-only"`: GETs only serve whatever buffer is currently
   *    in memory; rendering is driven solely by the Ingress UI and
   *    the periodic re-render timer (`re_render_minutes`).
   */
  image_port_mode: "on-demand" | "cache-only";
}

const OPTIONS_PATH = "/data/options.json";

/** Zod schema for /data/options.json — rejects malformed or out-of-range values. */
const optionsSchema = z.object({
  allowed_source_domains: z
    .array(z.string().max(253))   // max DNS hostname length
    .max(50)
    .default([]),
  allow_private_hosts: z
    // Matches allowed_source_domains rather than the 18 chars of the longest
    // legal entry: a zod failure here rejects the WHOLE file and falls back to
    // DEFAULTS, so one long typo would silently reset every other option —
    // including reopening allowed_source_domains. Length is not the validator;
    // configurePrivateHosts drops a bad entry individually and warns.
    .array(z.string().max(253))
    .max(50)
    .default([]),
  re_render_minutes: z
    .number()
    .int()
    .min(0)
    .max(60)
    // Fallback for a missing key in an otherwise-valid options.json. Matches
    // config.yaml (re_render_minutes: 0) and the file-missing DEFAULTS (0) so a
    // dropped key never silently enables a re-render loop.
    .default(0),
  image_port_cooldown_ms: z
    .number()
    .int()
    .min(1000)
    .max(60_000)
    .default(4_000),
  image_port_mode: z
    .enum(["on-demand", "cache-only"])
    .default("on-demand"),
}).passthrough();  // allow HA to add keys we don't consume

const DEFAULTS: AddonOptions = {
  allowed_source_domains: [],
  allow_private_hosts: [],
  re_render_minutes: 0,
  image_port_cooldown_ms: 4_000,
  image_port_mode: "on-demand",
};

/**
 * Load add-on options from disk. Returns safe defaults if the file
 * is missing or malformed.
 */
export function loadOptions(): AddonOptions {
  try {
    if (fs.existsSync(OPTIONS_PATH)) {
      const raw = JSON.parse(fs.readFileSync(OPTIONS_PATH, "utf-8"));
      const result = optionsSchema.safeParse(raw);
      if (!result.success) {
        logWarn("startup.options.invalid", { issueCount: result.error.issues.length });
        return DEFAULTS;
      }
      return {
        allowed_source_domains: result.data.allowed_source_domains,
        allow_private_hosts: result.data.allow_private_hosts,
        re_render_minutes: result.data.re_render_minutes,
        image_port_cooldown_ms: result.data.image_port_cooldown_ms,
        image_port_mode: result.data.image_port_mode,
      };
    }
  } catch (err) {
    logWarn("startup.options.read_failed", { error: err });
  }
  return DEFAULTS;
}
