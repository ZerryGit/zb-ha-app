/**
 * ha/index.ts — Home Assistant add-on entrypoint
 *
 * Wires the platform-agnostic core server with the HA-specific adapter.
 * Manages the dual-port architecture:
 *   - Port 8099 (Ingress): authenticated UI + API
 *   - Port 8000 (On-demand): read-only image rendering for ESP32
 */

import type { Server } from "http";
import { configureUrlValidator, configureBlockedHostnames, configurePrivateHosts } from "../data/urlValidator";
import { createIngressApp } from "../core/server";
import { runPipeline } from "../core/renderService";
import type { PlatformAdapter, DeviceId } from "../core/adapters";
import { DEFAULT_DEVICE_ID } from "../core/adapters";
import { logError, logInfo, logWarn } from "../core/logger";
import { HaStorageAdapter } from "./haStorage";
import { haSourceHandler } from "./haSources";
import { registerEntityRoutes } from "./haEntities";
import { registerNetworkRoutes } from "./haNetwork";
import { registerAssetRoutes } from "./haAssets";
import { registerDeviceRoutes } from "./haDevice";
import { loadOptions } from "./haOptions";
import { createOnDemandImageApp } from "./imageApp";
import { createPairingResolver } from "./pairingResolver";
import { readWidget } from "../core/widgetService";

// Re-export createImageApp for backward compatibility (used in tests)
export { createImageApp } from "./imageApp";

// ── Load add-on options ────────────────────────────────────────

const options = loadOptions();

// Configure shared URL validator with allowed domains from options
configureUrlValidator(options.allowed_source_domains);
if (options.allowed_source_domains.length === 0) {
  // Prominent first-run warning: an empty allowlist means every public
  // domain is reachable by source/image/SVG fetches (private/reserved IP
  // ranges are still always blocked).
  logWarn("security.url_validator.allow_all", {
    message:
      "allowed_source_domains is empty — ALL public domains are allowed for " +
      "outbound source/image/SVG fetches. Set allowed_source_domains in the " +
      "add-on configuration to restrict egress to specific hosts.",
    allowedSourceDomainMode: "all_external",
  });
} else {
  logInfo("security.url_validator.configured", {
    allowedSourceDomainMode: "allowlist",
    allowedSourceDomainCount: options.allowed_source_domains.length,
  });
}

// Operator-allowlisted private hosts. Silent when empty — that is the default
// and must not add startup noise; a dropped entry grants nothing.
const privateHosts = configurePrivateHosts(options.allow_private_hosts);
for (const { index, reason } of privateHosts.rejected) {
  logWarn("security.private_hosts.dropped", { index, reason });
}
if (privateHosts.accepted.length > 0) {
  // Configured-list rows, not addresses: the logger redacts every dotted quad,
  // and these are the same rows the per-fetch "permitted" lines and the
  // "dropped" warnings above refer to.
  logInfo("security.private_hosts.configured", {
    privateHostCount: privateHosts.accepted.length,
    entries: privateHosts.acceptedIndices,
  });
}

// ── HA Platform Adapter ────────────────────────────────────────

const storage = new HaStorageAdapter();

const haAdapter: PlatformAdapter = {
  storage,

  registerRoutes(app) {
    // Register HA entity proxy routes (/entities, /history)
    registerEntityRoutes(app);
    // Register the host-network route (/api/host-ip) for ESP32 device URLs
    registerNetworkRoutes(app);
    // Register user-asset upload / list / delete / raw routes
    registerAssetRoutes(app, storage);
    // Register the guided Self-Host /config push proxy (POST /api/device/config).
    // INGRESS APP ONLY — never the port-8000 image app (HA3).
    registerDeviceRoutes(app);
  },

  getBlockedHostnames() {
    // HA-specific internal hostnames that must never be accessed via user URLs
    return ["localhost", "supervisor", "hassio", "homeassistant"];
  },

  getSourceHandler() {
    return haSourceHandler;
  },
};

// ── Create Ingress app ─────────────────────────────────────────

// Wire platform-specific blocked hostnames from the adapter
configureBlockedHostnames(haAdapter.getBlockedHostnames());

const { ingressApp, renderGuard, sourceHandler, markShuttingDown } = createIngressApp(haAdapter);

// ── On-demand image app — port 8000 ────────────────────────────
// Read-only, unauthenticated by design (ESP32 has no auth capability).
// A GET serves the slot's in-memory buffer. It may first trigger a fresh
// render only when image_port_mode is "on-demand", the per-slot cooldown
// has elapsed, and RenderGuard is free; in "cache-only" mode, during the
// cooldown window, or while a render is in flight, the cached buffer is
// served as-is (304 when the client's ETag still matches).

const { app: staticApp, setBuffer: setImageBuffer } = createOnDemandImageApp({
  renderGuard,
  // Forward the slot + deviceId through so the on-demand app reads the
  // right device's payload.json / payload.fullscreen.json.
  readPayload: (slot, deviceId) => storage.readPayload(slot, deviceId),
  // The 2nd arg is the wake's request-scoped telemetry (plan 4). The timer
  // and startup warm-up call the real runPipeline directly and pass nothing,
  // so their re-renders deliberately carry the absent state.
  runPipeline: (raw, device) => runPipeline(raw, sourceHandler, storage, device),
  // Pairing-based instance requests (`requestedInstances` POST body):
  // resolve pairingId → (widget, slot), then render from the SAVED widget
  // doc — no deploy step for paired widgets.
  resolvePairing: createPairingResolver(storage),
  readWidget: (widgetId) => readWidget(storage, widgetId),
  cooldownMs: options.image_port_cooldown_ms,
  mode: options.image_port_mode,
});

// ── Startup ────────────────────────────────────────────────────

function parsePort(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  const port = raw ? parseInt(raw, 10) : fallback;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${envVar}: "${raw}" — must be 1–65535`);
  }
  return port;
}

const INGRESS_PORT = parsePort("INGRESS_PORT", 8099);
const STATIC_PORT = parsePort("STATIC_PORT", 8000);
const SHUTDOWN_TIMEOUT_MS = 10_000;

let isShuttingDown = false;
let reRenderTimer: NodeJS.Timeout | null = null;
const backgroundTasks = new Set<Promise<void>>();

logInfo("startup.config", {
  ingressPort: INGRESS_PORT,
  imagePort: STATIC_PORT,
  reRenderMinutes: options.re_render_minutes,
  imagePortMode: options.image_port_mode,
  imagePortCooldownMs: options.image_port_cooldown_ms,
  allowedSourceDomainMode: options.allowed_source_domains.length === 0 ? "all_external" : "allowlist",
  allowedSourceDomainCount: options.allowed_source_domains.length,
  privateHostCount: privateHosts.accepted.length,
  blockedHostnameCount: haAdapter.getBlockedHostnames().length,
});

function trackBackgroundTask(name: string, task: Promise<void>): void {
  let tracked: Promise<void>;
  tracked = task
    .catch((err: unknown) => {
      logWarn("background_task.failed", { name, error: err });
    })
    .finally(() => {
      backgroundTasks.delete(tracked);
    });
  backgroundTasks.add(tracked);
}

/**
 * Render one device+slot and, on success, warm the in-memory buffer and
 * persist the cached images to disk. Shared by both the startup warm-up and
 * the periodic re-render timer — the only differences between the two
 * callers are the `surface` log tag and elapsed-time logging. A failure (or
 * a missing payload) for one device/slot must never block any other
 * (ENGINEERING_CONSTRAINTS §15 graceful failure).
 */
async function renderAndWarmOne(deviceId: DeviceId, slot: "primary" | "fullscreen", surface: "startup" | "scheduler"): Promise<void> {
  let release: (() => void) | null = null;
  const t0 = Date.now();
  try {
    const payload = await storage.readPayload(slot, deviceId);
    if (!payload) return;

    release = renderGuard.tryAcquire();
    if (!release) {
      logInfo(surface === "startup" ? "startup.prerender.skip" : "render.skip", { surface, slot, deviceId, reason: "render_busy" });
      return;
    }

    logInfo("render.start", { surface, slot, deviceId });
    const { pngBuffer, binBuffer, meta } = await runPipeline(payload, sourceHandler, storage);
    setImageBuffer(pngBuffer, binBuffer, meta, slot, deviceId);

    // Also persist to disk so the cached files survive container restarts
    // (SD-card safe compare-before-write).
    await Promise.all([
      storage.writeCachedImage("png", pngBuffer, slot, deviceId),
      storage.writeCachedImage("bin", binBuffer, slot, deviceId),
    ]);

    logInfo("render.finish", {
      surface,
      slot,
      deviceId,
      elapsedMs: Date.now() - t0,
      renderTimeMs: meta.renderTimeMs,
      sourceErrorCount: meta.sourceErrors.length,
      renderErrorCount: meta.renderErrors.length,
    });
    if (meta.sourceErrors.length > 0) {
      logWarn("source.fetch.failure", {
        surface,
        slot,
        deviceId,
        count: meta.sourceErrors.length,
        errors: meta.sourceErrors,
      });
    }
  } catch (err) {
    logWarn("render.failed", { surface, slot, deviceId, error: err });
  } finally {
    release?.();
  }
}

// Pre-render on startup so the in-memory buffer is warm for the first ESP32
// request. Warms the single device × both slots; one slot's failure must not
// block the other (ENGINEERING_CONSTRAINTS §15 graceful failure).
async function warmStartupBuffers(): Promise<void> {
  for (const slot of ["primary", "fullscreen"] as const) {
    if (isShuttingDown) return;
    await renderAndWarmOne(DEFAULT_DEVICE_ID, slot, "startup");
  }
}

trackBackgroundTask("startup-prerender", warmStartupBuffers());

// QR pairing and `cache-only` are incompatible by construction: a paired
// instance's frame is rendered only by the port-8000 request that asks for it,
// and cache-only forbids the port from rendering at all, so every paired
// instance answers `status = 0` for as long as the mode is set. The device
// side of that is silent (a panel just shows nothing), so say it once at
// startup — but only when widgets are actually paired, so an operator who
// deliberately runs cache-only without the mobile app gets no noise.
async function warnIfPairingDisabledByMode(): Promise<void> {
  if (options.image_port_mode !== "cache-only") return;
  const metas = await storage.listWidgets();
  const pairedWidgetCount = metas.filter(
    (m) => typeof m.pairingId === "number" || typeof m.fullscreenPairingId === "number",
  ).length;
  if (pairedWidgetCount === 0) return;
  logWarn("image_port.pairing_disabled", {
    reason: "cache_only_mode",
    pairedWidgetCount,
    detail:
      "image_port_mode is cache-only, so pairing requests (requestedInstances) always "
      + "answer status = 0 and paired panels will never receive a frame. Set "
      + "image_port_mode to on-demand to use the mobile app.",
  });
}

trackBackgroundTask("pairing-mode-check", warnIfPairingDisabledByMode());

// ── Timer-based re-render (SD-card safe) ───────────────────────

const RE_RENDER_INTERVAL_MS = options.re_render_minutes * 60 * 1000;

async function runScheduledRerender(): Promise<void> {
  // Re-render both slots. Sequential (not parallel) so the single RenderGuard
  // lock is held only for one render at a time (ENGINEERING_CONSTRAINTS §12).
  // A failure on one must not block the other (ENGINEERING_CONSTRAINTS §15).
  for (const slot of ["primary", "fullscreen"] as const) {
    if (isShuttingDown) return;
    await renderAndWarmOne(DEFAULT_DEVICE_ID, slot, "scheduler");
  }
}

if (RE_RENDER_INTERVAL_MS > 0) {
  reRenderTimer = setInterval(() => {
    if (isShuttingDown) return;
    trackBackgroundTask("scheduled-rerender", runScheduledRerender());
  }, RE_RENDER_INTERVAL_MS);

  logInfo("scheduler.start", { intervalMinutes: options.re_render_minutes });
} else {
  logInfo("scheduler.disabled", { reason: "re_render_minutes_zero" });
}

// ── Start servers ──────────────────────────────────────────────

const ingressServer = ingressApp.listen(INGRESS_PORT, "0.0.0.0", () => {
  logInfo("server.listen", { surface: "ingress", port: INGRESS_PORT });
});

const imageServer = staticApp
  .listen(STATIC_PORT, "0.0.0.0", () => {
    logInfo("server.listen", { surface: "image", port: STATIC_PORT, cooldownSeconds: options.image_port_cooldown_ms / 1000 });
  })
  .on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      logError("server.listen.failed", { surface: "image", port: STATIC_PORT, code: err.code });
    } else {
      logError("server.listen.failed", { surface: "image", port: STATIC_PORT, error: err });
    }
    // Do not crash the ingress server — log and continue.
  });

function closeServer(server: Server, surface: "ingress" | "image"): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      logInfo("server.close.skip", { surface, reason: "not_listening" });
      resolve();
      return;
    }
    server.close((err) => {
      if (err) {
        logWarn("server.close.failed", { surface, error: err });
      } else {
        logInfo("server.close", { surface });
      }
      resolve();
    });
  });
}

function requestShutdown(signal: NodeJS.Signals): void {
  if (isShuttingDown) return;
  isShuttingDown = true;
  markShuttingDown();
  if (reRenderTimer) {
    clearInterval(reRenderTimer);
    reRenderTimer = null;
  }

  logInfo("shutdown.start", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
  const timeout = setTimeout(() => {
    logError("shutdown.timeout", { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  timeout.unref();

  void (async () => {
    await Promise.allSettled([
      closeServer(ingressServer, "ingress"),
      closeServer(imageServer, "image"),
    ]);
    await Promise.allSettled(Array.from(backgroundTasks));
    clearTimeout(timeout);
    logInfo("shutdown.complete", { signal });
    process.exit(0);
  })();
}

process.once("SIGTERM", () => requestShutdown("SIGTERM"));
process.once("SIGINT", () => requestShutdown("SIGINT"));

// Last-resort backstop for a promise rejection that escaped every route
// handler (asyncHandler wraps the routes; this catches anything that slips
// through, e.g. a background task). Log and keep the process alive rather than
// letting Node terminate the add-on on an unhandled rejection.
process.on("unhandledRejection", (reason) => {
  logError("process.unhandledRejection", { error: reason });
});
