/**
 * renderWorker.ts — Terminable worker-thread host for the frozen render engine
 *
 * The frozen engine's `render()` runs a synchronous per-element draw
 * loop and takes no AbortSignal (`src/engine/renderer.ts`), so the per-render
 * timeout in `renderService` can only *signal* cancellation — it cannot
 * interrupt CPU-bound engine work on the main event loop. Running `render()`
 * here, inside a Node `worker_thread`, lets `renderService` hard-kill a runaway
 * render via `worker.terminate()` when the timeout's AbortController fires: the
 * main-thread timer runs unblocked, the worker is destroyed, and the render
 * promise rejects so the route can release the RenderGuard.
 *
 * This module only IMPORTS the public `render` symbol from the frozen engine
 * and calls it. It does NOT modify anything under `src/engine/`.
 */

import { parentPort, workerData } from "node:worker_threads";
import { render } from "../engine/renderer";
import type { DataContext } from "@zb/expressions";
import type { RenderErrorInfo } from "../errors/renderError";
import {
  configureUrlValidator,
  configurePrivateHosts,
  configureBlockedHostnames,
  type UrlValidatorConfig,
} from "../data/urlValidator";

/** Message posted from `renderService` to this worker. */
interface RenderWorkerRequest {
  elements: Record<string, unknown>[];
  ctx: DataContext;
  width: number;
  height: number;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Apply the main thread's SSRF allowlists to this worker's own copy of
 * `urlValidator`. Without it the module here holds its empty initial state, so
 * `img`/`svg` fetches — which run inside `render()`, i.e. in this thread —
 * ignore both `allowed_source_domains` and the operator's `allow_private_hosts`.
 *
 * Exported for the bootstrap unit test: the shared inline-worker test helper
 * runs `render()` on the main thread, where the config is already applied, so
 * it cannot exercise this path.
 *
 * Throws when the config is absent or malformed. `defaultEngineWorkerFactory`
 * always supplies the snapshot, so this is unreachable in practice — and the
 * module defaults are the wrong fallback anyway: `privateHosts = []` is safe,
 * but `allowedDomains = []` means allow-all-public and `blockedHostnames`
 * loses `supervisor`/`hassio`/`homeassistant`. A render that cannot prove its
 * SSRF config is loaded must not run.
 */
export function applyValidatorConfig(config: unknown): void {
  const candidate = config as Partial<UrlValidatorConfig> | null | undefined;
  if (
    !candidate ||
    typeof candidate !== "object" ||
    !isStringArray(candidate.allowedDomains) ||
    !isStringArray(candidate.privateHosts) ||
    !isStringArray(candidate.blockedHostnames)
  ) {
    throw new Error(
      "renderWorker: missing or malformed SSRF validator config in workerData — refusing to render.",
    );
  }

  configureUrlValidator(candidate.allowedDomains);
  configurePrivateHosts(candidate.privateHosts);
  configureBlockedHostnames(candidate.blockedHostnames);
}

if (parentPort) {
  applyValidatorConfig(workerData);
  const port = parentPort;
  port.on("message", async (msg: RenderWorkerRequest) => {
    try {
      const { canvas, errors } = await render(
        msg.elements,
        msg.ctx,
        msg.width,
        msg.height,
      );
      // `Canvas.buffer` wraps a dedicated ArrayBuffer at offset 0 spanning the
      // whole allocation (stride * height bytes), so transferring `.buffer` is
      // a zero-copy hand-off of the packed 1-bit bitmap back to the main
      // thread, which reconstructs the Canvas losslessly.
      const buffer = canvas.buffer.buffer as ArrayBuffer;
      port.postMessage(
        {
          ok: true,
          buffer,
          width: canvas.width,
          height: canvas.height,
          stride: canvas.stride,
          errors,
        },
        [buffer],
      );
    } catch (err) {
      port.postMessage({
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
