/**
 * renderService.ts — Core render pipeline orchestration
 *
 * Extracted from index.ts. This module is platform-agnostic: it depends only
 * on the StorageAdapter interface for cached image writes, not on the
 * filesystem directly.
 */

import { Worker } from "node:worker_threads";
import * as path from "node:path";
import { payloadSchema } from "../schema/payloadSchema";
import { createDataContext, type DataContext } from "@zb/expressions";
import { resolveFeatures } from "../data/featureResolver";
import { fetchAllSources, AnySourceDef } from "../data/sourceFetcher";
import { expandGraphElements } from "../data/graph/expander";
import { expandTextBounds } from "../data/textAutoSize";
import {
  preRasterizeRotatedText,
  compositeRotatedText,
} from "../data/rotatedTextRasterizer";
import { normalizeSvgElements } from "../data/svgPreprocessor";
import { sanitizeSvgElementsForEngine } from "../data/svgInlineSanitizer";
import { clampElementGeometry } from "../data/geometryClamp";
import { getUrlValidatorConfig } from "../data/urlValidator";
import { preRasterizeLargeSvgs, compositePreRasteredOnto } from "../data/svgPreRasterizer";
import {
  preRasterizeRotatedSvgs,
  compositeRotatedSvgs,
} from "../data/rotatedSvgRasterizer";
import { resolveUserAssets, compositeUserAssetsOnto, type AssetReader } from "../data/userAssets";
import { Canvas } from "../engine/canvas";
import type { RenderErrorInfo } from "../errors/renderError";
import { encodePng } from "../encoder/pngEncoder";
import { encodeBin } from "../encoder/binEncoder";
import { RENDER_TIMEOUT_MS, MAX_EXPANDED_ELEMENTS } from "../limits";
import { createHash } from "crypto";
import type { StorageAdapter, RenderMeta, Slot } from "./adapters";
import { stripSourcesSecrets } from "./sourceSecrets";
import { logInfo } from "./logger";

// ── Cancellation helpers ───────────────────────────────────────

/**
 * Sentinel error thrown when the per-render AbortSignal fires. The
 * outer `runPipeline` catches this and converts it into the public
 * `RENDER_TIMEOUT` error so route-level callers see the same shape
 * they did before signal propagation was added.
 */
const RENDER_ABORT_MARKER = "RENDER_ABORTED";

/**
 * Cooperative checkpoint: throw if the per-render signal has already
 * fired. Cheap enough to call between every async pipeline step.
 * Intentionally permissive about `signal` being undefined so call
 * sites in shared modules can use it unconditionally.
 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(RENDER_ABORT_MARKER);
  }
}

/**
 * Render-timeout error thrown by `runPipeline` after the per-render
 * `AbortController` fires. Carries `aborted = true` so the route's
 * `render.failed` log entry can surface the cancellation cause without
 * relying on string matching the message.
 */
export class RenderTimeoutError extends Error {
  readonly aborted = true;
  constructor(timeoutMs: number) {
    super(`RENDER_TIMEOUT (${timeoutMs}ms)`);
    this.name = "RenderTimeoutError";
  }
}

// ── Render concurrency guard ───────────────────────────────────

/**
 * A try-acquire mutex: callers receive a release callback on success, or
 * null if a render is already in flight.
 */
export class RenderGuard {
  private _locked = false;

  /** True while a render is in flight. Used only for coarse readiness. */
  isLocked(): boolean {
    return this._locked;
  }

  /** Returns a release callback if the lock was acquired, or null if busy. */
  tryAcquire(): (() => void) | null {
    if (this._locked) return null;
    this._locked = true;
    return () => {
      this._locked = false;
    };
  }
}

// ── Terminable render worker ───────────────────────────────────
//
// The frozen engine `render()` (src/engine/renderer.ts) is a synchronous,
// non-yielding CPU loop with no AbortSignal, so the per-render timeout below
// cannot stop it on the main thread. Running it in a worker_thread lets the
// main-thread timer terminate() a runaway render. RenderGuard already
// serialises renders, so a single reusable worker is sufficient; a terminated
// worker cannot be reused, so it is dropped and lazily respawned.

/** Reply posted back by `renderWorker.ts`. */
type RenderWorkerResponse =
  | {
      ok: true;
      buffer: ArrayBuffer;
      width: number;
      height: number;
      stride: number;
      errors: RenderErrorInfo[];
    }
  | { ok: false; message: string };

/**
 * Factory for the engine worker. Overridable in tests, which run TypeScript
 * with no compiled `dist/core/renderWorker.js`, via `__setEngineWorkerFactory`.
 * `__dirname` is valid because the server is compiled as CommonJS.
 */
const defaultEngineWorkerFactory = (): Worker =>
  // The worker's module registry is its own, so the SSRF allowlists have to
  // travel with it. Spawn time is enough: options are read once at startup and
  // a terminated worker is always respawned (disposeEngineWorker below).
  new Worker(path.resolve(__dirname, "renderWorker.js"), {
    workerData: getUrlValidatorConfig(),
  });

let engineWorkerFactory: () => Worker = defaultEngineWorkerFactory;

/** TEST-ONLY: substitute a fake worker factory. Pass `null` to restore default. */
export function __setEngineWorkerFactory(factory: (() => Worker) | null): void {
  engineWorkerFactory = factory ?? defaultEngineWorkerFactory;
}

/** The single long-lived engine worker (or null before first use / after a kill). */
let engineWorker: Worker | null = null;

function getEngineWorker(): Worker {
  if (!engineWorker) {
    engineWorker = engineWorkerFactory();
    // Never let the worker keep the process alive on shutdown.
    engineWorker.unref?.();
  }
  return engineWorker;
}

/** Drop the current worker reference so the next render respawns a fresh one. */
function disposeEngineWorker(): void {
  engineWorker = null;
}

/**
 * Run the frozen engine `render()` inside the terminable worker. When `signal`
 * fires (the render timeout), the worker is hard-killed via `terminate()`; its
 * `exit` event rejects this promise with RENDER_ABORT_MARKER so `runPipeline`
 * unwinds and the route releases the RenderGuard. On success the packed 1-bit
 * buffer is transferred back and the Canvas is reconstructed losslessly on the
 * main thread, so a normal render produces byte-identical output.
 */
export function renderInWorker(
  elements: Record<string, unknown>[],
  ctx: DataContext,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<{ canvas: Canvas; errors: RenderErrorInfo[] }> {
  const worker = getEngineWorker();
  return new Promise((resolve, reject) => {
    let settled = false;

    const onMessage = (msg: RenderWorkerResponse): void => {
      if (settled) return;
      if (msg.ok) {
        const canvas = new Canvas(width, height);
        canvas.buffer.set(new Uint8Array(msg.buffer));
        finalize();
        resolve({ canvas, errors: msg.errors });
      } else {
        finalize();
        reject(new Error(msg.message));
      }
    };
    const onError = (err: Error): void => {
      if (settled) return;
      finalize();
      reject(err);
    };
    const onExit = (): void => {
      // A terminated worker cannot be reused — drop it so the next render
      // spawns a fresh one.
      disposeEngineWorker();
      if (settled) return;
      finalize();
      reject(new Error(RENDER_ABORT_MARKER));
    };
    const onAbort = (): void => {
      // Hard-kill the synchronous engine work the cooperative signal cannot
      // reach. The `exit` handler above turns this into a promise rejection.
      void worker.terminate();
    };

    // Remove every listener on settle so a reused (non-terminated) worker does
    // not accumulate exit/error listeners across successive renders.
    function finalize(): void {
      settled = true;
      worker.removeListener("message", onMessage);
      worker.removeListener("error", onError);
      worker.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    }

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });

    worker.postMessage({ elements, ctx, width, height });
  });
}

// ── Core render pipeline ───────────────────────────────────────

/**
 * Optional callback for platform-specific source kinds (e.g. haState, haHistory).
 * The platform adapter can provide this so the pipeline handles custom sources.
 * The optional `signal` is the per-render `AbortSignal` owned by `runPipeline`;
 * implementations MUST forward it to any outbound `fetch()` so a render
 * timeout actually cancels the in-flight platform call.
 */
export type SourceHandler = (
  source: AnySourceDef,
  ctx: DataContext,
  signal?: AbortSignal,
) => Promise<unknown>;

/** Result of the shared pipeline preparation phase. */
interface PreparedPipeline {
  payload: ReturnType<typeof payloadSchema.parse>;
  ctx: DataContext;
  expandedElements: Record<string, unknown>[];
  expandErrors: string[];
  sourceErrors: string[];
  /**
   * Pre-decoded raster user-asset bitmaps keyed by element index. The
   * indices are valid against `expandedElements` because graph expansion
   * only inserts entries (it never deletes), so any index resolved before
   * graph expansion is still a valid leading-prefix index. Composited
   * onto the canvas by `runPipeline` after `render()` returns.
   */
  userAssetBitmaps: Parameters<typeof compositeUserAssetsOnto>[1];
  userAssetErrors: string[];
}

/**
 * Shared preparation: validate → build context → resolve features →
 * fetch sources → resolve user assets → expand graph elements → check limits.
 *
 * `storage` is optional — when omitted (or when the adapter does not
 * implement asset reads, e.g. a non-HA platform) the user-asset pass is
 * a transparent no-op.
 */
async function preparePipeline(
  raw: unknown,
  sourceHandler?: SourceHandler | null,
  storage?: AssetReader | null,
  signal?: AbortSignal,
): Promise<PreparedPipeline> {
  const parseResult = payloadSchema.safeParse(raw);
  if (!parseResult.success) {
    throw new Error(`Invalid payload: ${JSON.stringify(parseResult.error.flatten())}`);
  }

  const payload = parseResult.data;
  const { misc, features, sources, elements } = payload;

  const ctx: DataContext = createDataContext();
  ctx.misc = { ...misc, width: misc.size.width, height: misc.size.height };
  if (misc.gridSize) {
    const parts = misc.gridSize.split("x");
    ctx.misc.grid = {
      cols: parseInt(parts[0]) || 1,
      rows: parseInt(parts[1]) || 1,
    };
  }
  ctx.features = resolveFeatures(features);

  const sourceResult = await fetchAllSources(sources, ctx, sourceHandler, signal);
  throwIfAborted(signal);

  // Sanitize every statically-resolvable SVG out-of-engine so the frozen
  // engine's regex `sanitizeSvg` only ever sees parser-sanitized,
  // whitespace-run-capped bytes (kills its ReDoS + external-ref/entity gaps).
  // See `data/svgInlineSanitizer.ts`. Runs first so its output feeds every
  // downstream SVG pass. May fetch http(s) `src` SVGs, hence `await`.
  const sanitizedElements = await sanitizeSvgElementsForEngine(elements, signal);
  throwIfAborted(signal);

  // Normalize inline SVGs to the element's display size before the payload
  // reaches the engine. See `data/svgPreprocessor.ts` for the rationale —
  // briefly: this prevents librsvg timeouts on oversized vector exports and
  // forces the rasterizer to match the Konva preview's anisotropic stretch.
  // Equivalent in pattern to expandTextBounds / expandGraphElements: a
  // pre-render pass outside the frozen engine.
  const preprocessedElements = normalizeSvgElements(sanitizedElements);

  // Resolve user-uploaded asset references (`asset:<uuid>.<ext>` tokens).
  // Mirrors the pattern used by other pre-render passes: rewrite the
  // element list so the frozen engine sees only payload it can interpret,
  // and stash any pre-decoded raster bitmaps for post-render compositing.
  // Runs BEFORE graph expansion so element indices in the bitmap map
  // remain valid against the post-expansion list (graph expansion only
  // appends new entries; existing index positions are preserved).
  const userAssetResult = storage
    ? await resolveUserAssets(preprocessedElements, ctx, storage)
    : { elements: preprocessedElements, preLoaded: new Map(), errors: [] };
  const elementsAfterAssets = userAssetResult.elements;

  // Diagnostic — when SVG rendering misbehaves, the engine's per-element
  // failures end up in `meta.renderErrors`, but a *blank* render with no
  // error usually means either (a) the SVG never reached the engine,
  // (b) `visible` was resolved to false, or (c) sharp produced an
  // all-white raster. One terse line per SVG present at render time
  // makes all three cases trivially observable in the add-on log without
  // requiring a debug flag the user has to discover and toggle.
  for (const el of elementsAfterAssets) {
    if (el.type === "svg") {
      const svg = typeof el.svg === "string" ? el.svg : "(non-string)";
      logInfo("svg.render_input", {
        elementId: el.id ?? "?",
        sizeX: el.sizeX,
        sizeY: el.sizeY,
        visible: el.visible,
        enableFill: el.enableFill,
        enableStroke: el.enableStroke,
        bwMode: el.bwMode,
        bwLevel: el.bwLevel,
        svgLength: svg.length,
      });
    }
  }

  // Clamp resolved geometry (sizeX/sizeY/strokeWidth/pos/line points) to
  // canvas-scale bounds before the frozen engine's draw loops consume them.
  // Mirrors the position of normalizeSvgElements: validate → SVG
  // normalize → user assets → geometry clamp → graph expansion. Unchanged
  // elements keep their reference, so byte-identical renders stay cached.
  const clampedElements = clampElementGeometry(elementsAfterAssets, ctx);

  const expandResult = expandGraphElements(clampedElements, ctx);
  if (expandResult.elements.length > MAX_EXPANDED_ELEMENTS) {
    throw new Error(
      `Element count after graph expansion (${expandResult.elements.length}) exceeds the ${MAX_EXPANDED_ELEMENTS} limit.`,
    );
  }

  return {
    payload,
    ctx,
    expandedElements: expandResult.elements,
    expandErrors: expandResult.errors,
    sourceErrors: sourceResult.errors.map((e) => JSON.stringify(e)),
    userAssetBitmaps: userAssetResult.preLoaded,
    userAssetErrors: userAssetResult.errors,
  };
}

/**
 * Run the full render pipeline: validate → resolve features → fetch
 * sources → render elements → encode output.
 *
 * @param raw  The raw (unvalidated) payload JSON
 * @param sourceHandler  Optional platform-specific source handler
 * @returns Encoded buffers and render metadata
 */
export async function runPipeline(
  raw: unknown,
  sourceHandler?: SourceHandler | null,
  storage?: AssetReader | null,
): Promise<{ pngBuffer: Buffer; binBuffer: Buffer; meta: RenderMeta }> {
  // Short-lived render-result cache. The builder fires multiple
  // /render requests for the same payload in normal use:
  //   - Auto-render on widget switch (App.jsx)
  //   - Auto-render on artboard size change (App.jsx)
  //   - Manual Refresh in PreviewTab
  //   - PUT /payload on deploy
  // When two of these fire in quick succession with byte-identical
  // payloads, returning the cached buffers immediately turns a 2–4 s
  // pipeline into a sub-millisecond response. The cache deliberately
  // does NOT cover source results — sources are time-sensitive — but
  // the source-fetch result is part of the payload hash via the
  // payload's source IDs and configs, so any source config change
  // invalidates the cache automatically. Cached entries also expire
  // after RENDER_RESULT_CACHE_TTL_MS so stale source fetches don't
  // serve indefinitely.
  const cached = getCachedRenderResult(raw);
  if (cached) return cached;

  // Per-render abort controller: fired by the timeout below, propagated
  // through every async leaf (source fetches, pre-rasterizers, encoders).
  // Replaces the old `Promise.race` shape, which left the loser running
  // in the background and silently held CPU/memory while the route had
  // already released the RenderGuard.
  const controller = new AbortController();
  const signal = controller.signal;

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, RENDER_TIMEOUT_MS);
  // Don't keep the event loop alive just for the render timer.
  timeoutHandle.unref?.();

  try {
    const t0 = Date.now();

    const {
      payload,
      ctx,
      expandedElements,
      expandErrors,
      sourceErrors,
      userAssetBitmaps,
      userAssetErrors,
    } = await preparePipeline(raw, sourceHandler, storage, signal);
    throwIfAborted(signal);
    const { misc, sources, elements } = payload;

    // Expand text bounding boxes to fit resolved dynamic content.
    // Only grows sizeX/sizeY — never shrinks — so user layout is preserved.
    const sizedElements = await expandTextBounds(expandedElements, ctx);
    throwIfAborted(signal);

    // Out-of-engine pre-rasterization for rotated/scaled text whose
    // un-rotated bounding box extends past the canvas. The frozen
    // engine's transform path renders the un-rotated text into a
    // canvas-sized temp buffer and inverse-maps from there, so
    // glyphs landing outside the canvas are silently dropped before
    // rotation — making the deployed image show clipped or missing
    // text even when the rotated bounds and the builder preview
    // both look correct. See `data/rotatedTextRasterizer.ts` for
    // the full rationale.
    const {
      elements: rotatedTextElements,
      preRendered: rotatedTextBitmaps,
    } = await preRasterizeRotatedText(
      sizedElements,
      ctx,
      misc.size.width,
      misc.size.height,
      signal,
    );
    throwIfAborted(signal);

    // Out-of-engine pre-rasterization for rotated/scaled SVG
    // elements (notably the icon picker's Tabler icons) whose
    // un-rotated bounding box extends past the canvas. Same engine
    // bug as rotated text above: drawWithTransform renders the
    // un-rotated SVG into a canvas-sized temp buffer, so any
    // pixels outside the canvas are silently dropped before the
    // inverse-mapping rotation step — making the deployed image
    // show clipped or fully missing icons (the bug grows with
    // rotation magnitude as more of the icon swings into the
    // dropped region). See `data/rotatedSvgRasterizer.ts` for the
    // full rationale.
    const {
      elements: rotatedSvgElements,
      preRendered: rotatedSvgBitmaps,
      errors: rotatedSvgErrors,
    } = await preRasterizeRotatedSvgs(
      rotatedTextElements,
      ctx,
      misc.size.width,
      misc.size.height,
      signal,
    );
    throwIfAborted(signal);

    // Pre-rasterize large inline SVGs OUTSIDE the engine. The engine's
    // 300 ms SVG_RASTER_TIMEOUT_MS races sharp/librsvg on big vector
    // exports; this pass moves the rasterization to a 5 s window with
    // an LRU bitmap cache, then clears the SVG field so the engine's
    // drawSvg early-returns silently. The bitmaps are composited onto
    // the canvas after render() finishes, preserving z-order.
    // See `data/svgPreRasterizer.ts` for the full rationale.
    const preRasterStart = Date.now();
    const {
      elements: preRasterElements,
      preRastered,
      errors: preRasterErrors,
    } = await preRasterizeLargeSvgs(rotatedSvgElements, ctx, signal);
    const preRasterMs = Date.now() - preRasterStart;
    if (preRastered.size > 0) {
      logInfo("svg.preraster.finish", {
        count: preRastered.size,
        elapsedMs: preRasterMs,
        fallbackCount: preRasterErrors.length,
      });
    }
    throwIfAborted(signal);

    // The frozen engine cannot be made AbortSignal-aware, so it runs inside a
    // terminable worker_thread: when the timeout's AbortController
    // fires, the worker is hard-killed and `renderInWorker` rejects, so the
    // render timeout is actually enforced and the route can release
    // `RenderGuard`. The composite → encode steps below stay on the main thread.
    const { canvas, errors: renderErrors } = await renderInWorker(
      preRasterElements,
      ctx,
      misc.size.width,
      misc.size.height,
      signal,
    );

    // Composite pre-rasterized SVG bitmaps onto the canvas using the
    // engine's exact dither / opacity helpers — visually equivalent
    // to what drawSvg would have written if it had succeeded.
    if (preRastered.size > 0) {
      compositePreRasteredOnto(canvas, preRastered);
    }

    // Composite pre-decoded user-asset raster bitmaps. Mirrors
    // drawImg byte-for-byte; SVG assets were rewritten to inline
    // form upstream and are handled by the SVG paths above.
    if (userAssetBitmaps.size > 0) {
      compositeUserAssetsOnto(canvas, userAssetBitmaps);
    }

    // Composite rotated-SVG bitmaps. Same rationale as rotated
    // text below — these elements were muted upstream (svg/src
    // cleared, transform reset) so the engine has not drawn
    // anything for them yet. Composited before rotated text so the
    // existing rotated-text-on-top z-order policy is preserved.
    if (rotatedSvgBitmaps.size > 0) {
      compositeRotatedSvgs(canvas, rotatedSvgBitmaps);
    }

    // Composite rotated-text bitmaps last. These elements were muted
    // upstream (text cleared) so the engine has not drawn anything
    // for them yet — see `data/rotatedTextRasterizer.ts` for why
    // this lives outside the frozen engine.
    if (rotatedTextBitmaps.size > 0) {
      compositeRotatedText(canvas, rotatedTextBitmaps);
    }

    const [pngBuffer, binBuffer] = await Promise.all([
      encodePng(canvas),
      Promise.resolve(encodeBin(canvas)),
    ]);

    const result = {
      pngBuffer,
      binBuffer,
      meta: {
        name: misc.name ?? "untitled",
        format: misc.format,
        width: misc.size.width,
        height: misc.size.height,
        sourceCount: sources.length,
        elementCount: elements.length,
        renderTimeMs: Date.now() - t0,
        sourceErrors,
        renderErrors: [
          ...expandErrors,
          ...userAssetErrors,
          ...preRasterErrors,
          ...rotatedSvgErrors,
          // `RenderError` bakes the element index and type into the message
          // (`errors/renderError.ts`), so the prose alone carries everything
          // the other four contributors here carry. Serialising the object
          // instead showed the user raw JSON in the warning list.
          ...renderErrors.map((e) => e.message),
        ],
      },
    };

    putCachedRenderResult(raw, result);
    return result;
  } catch (err) {
    // Translate the internal sentinel into the public timeout error.
    // The route already logs `render.failed`; the typed error lets it
    // surface `aborted: true` without sniffing the message string.
    if (timedOut || (err instanceof Error && err.message === RENDER_ABORT_MARKER)) {
      throw new RenderTimeoutError(RENDER_TIMEOUT_MS);
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── Render-result cache ────────────────────────────────────────

/**
 * How long a cached render survives. Long enough to absorb the typical
 * burst of duplicate /render requests the builder emits on a widget
 * switch (auto-render + manual Refresh + PUT /payload), short enough
 * that any source-driven content change will be picked up promptly.
 */
const RENDER_RESULT_CACHE_TTL_MS = 2_000;

/** Maximum number of cached render results held in memory. */
const RENDER_RESULT_CACHE_MAX_ENTRIES = 4;

interface CachedRenderResult {
  pngBuffer: Buffer;
  binBuffer: Buffer;
  meta: RenderMeta;
  cachedAt: number;
}

const renderResultCache = new Map<string, CachedRenderResult>();

function payloadHashKey(raw: unknown): string | null {
  try {
    return createHash("sha1").update(JSON.stringify(raw)).digest("hex");
  } catch {
    // Non-serializable input (cycles, etc.) — skip the cache.
    return null;
  }
}

function getCachedRenderResult(
  raw: unknown,
): { pngBuffer: Buffer; binBuffer: Buffer; meta: RenderMeta } | null {
  const key = payloadHashKey(raw);
  if (!key) return null;
  const entry = renderResultCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > RENDER_RESULT_CACHE_TTL_MS) {
    renderResultCache.delete(key);
    return null;
  }
  // Promote (LRU): re-insert at the end of iteration order.
  renderResultCache.delete(key);
  renderResultCache.set(key, entry);
  // Re-stamp renderTimeMs as 0 so logs distinguish cache hits from work.
  return {
    pngBuffer: entry.pngBuffer,
    binBuffer: entry.binBuffer,
    meta: { ...entry.meta, renderTimeMs: 0 },
  };
}

function putCachedRenderResult(
  raw: unknown,
  result: { pngBuffer: Buffer; binBuffer: Buffer; meta: RenderMeta },
): void {
  const key = payloadHashKey(raw);
  if (!key) return;
  if (renderResultCache.has(key)) renderResultCache.delete(key);
  renderResultCache.set(key, {
    pngBuffer: result.pngBuffer,
    binBuffer: result.binBuffer,
    meta: result.meta,
    cachedAt: Date.now(),
  });
  while (renderResultCache.size > RENDER_RESULT_CACHE_MAX_ENTRIES) {
    const oldest = renderResultCache.keys().next().value;
    if (oldest === undefined) break;
    renderResultCache.delete(oldest);
  }
}

/**
 * Write both rendered image files via the storage adapter (SD-card safe on HA).
 * Uses compare-before-write: only touches storage when output actually changes.
 *
 * `slot` selects which on-disk filenames to write (`image.png` / `image.bin`
 * for primary, `image_fullscreen.png` / `image_fullscreen.bin` for the
 * fullscreen companion). Defaults to primary for backward compatibility.
 */
export async function cacheImages(
  storage: StorageAdapter,
  pngBuffer: Buffer,
  binBuffer: Buffer,
  meta: RenderMeta,
  slot: Slot = "primary",
): Promise<void> {
  const [pngWritten, binWritten] = await Promise.all([
    storage.writeCachedImage("png", pngBuffer, slot),
    storage.writeCachedImage("bin", binBuffer, slot),
  ]);

  if (pngWritten || binWritten) {
    logInfo("render.cache.write", {
      slot,
      width: meta.width,
      height: meta.height,
      renderTimeMs: meta.renderTimeMs,
      pngBytes: pngBuffer.length,
      binBytes: binBuffer.length,
      pngWritten,
      binWritten,
    });
  } else {
    logInfo("render.cache.skip", {
      slot,
      reason: "unchanged",
      width: meta.width,
      height: meta.height,
      renderTimeMs: meta.renderTimeMs,
    });
  }
}

/**
 * Render and write both image files via the storage adapter (SD-card safe on HA).
 * Uses compare-before-write: only touches storage when output actually changes.
 */
export async function renderAndCache(
  raw: unknown,
  storage: StorageAdapter,
  sourceHandler?: SourceHandler | null,
  slot: Slot = "primary",
): Promise<RenderMeta> {
  const { pngBuffer, binBuffer, meta } = await runPipeline(raw, sourceHandler, storage);
  await cacheImages(storage, pngBuffer, binBuffer, meta, slot);
  return meta;
}

/**
 * Run the pipeline up to graph expansion (skip actual rendering).
 * Returns the fully expanded payload JSON as the draw function would see it.
 */
export async function expandPipeline(
  raw: unknown,
  sourceHandler?: SourceHandler | null,
  storage?: AssetReader | null,
): Promise<{ misc: unknown; features: unknown; sources: unknown; elements: Record<string, unknown>[] }> {
  const { payload, expandedElements } = await preparePipeline(raw, sourceHandler, storage);
  const { misc, features, sources } = payload;
  // Strip source credentials from the echoed sources — the fetch inside
  // preparePipeline already ran with whatever auth the request carried, so
  // data resolution is unaffected, but the response must not leak secrets.
  return { misc, features, sources: stripSourcesSecrets(sources), elements: expandedElements };
}
