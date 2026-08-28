/**
 * server.ts — Express app factory (platform-agnostic)
 *
 * Creates the Ingress Express app with all core routes:
 *   - Widget CRUD (/api/widgets)
 *   - Payload management (/payload)
 *   - Render pipeline (/render, /image.png)
 *   - Export token flow (/export)
 *   - Static file serving (builder SPA, management panel)
 *
 * Platform-specific routes (e.g. HA entity proxy) are registered
 * by the PlatformAdapter.
 */

import express, { Request, Response, NextFunction } from "express";
import * as path from "path";
import * as crypto from "crypto";
import { z } from "zod";

import { payloadSchema, fullscreenPayloadSchema } from "../schema/payloadSchema";
import {
  sourceSchema,
  haStateSourceSchema,
  haHistorySourceSchema,
  httpSourceSchema,
} from "../schema/sourceSchema";
import {
  EXPORT_TTL_MS,
  MAX_EXPORT_TOKENS,
  EXPORT_PURGE_INTERVAL_MS,
  MAX_REQUEST_BODY,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MUTATION,
  RATE_LIMIT_SOURCE_TEST,
  RATE_LIMIT_RENDER_EXPAND,
} from "../limits";
import { HttpError } from "../errors/httpError";
import type { PlatformAdapter, WidgetDoc, Slot } from "./adapters";
import { RenderGuard, runPipeline, renderAndCache, cacheImages, expandPipeline, SourceHandler } from "./renderService";
import { fetchAllSources } from "../data/sourceFetcher";
import { rateLimit } from "./rateLimiter";
import {
  getRequestId,
  getResponseRequestId,
  logError,
  logInfo,
  logWarn,
  requestContextMiddleware,
} from "./logger";
import {
  generateWidgetId,
  readWidget,
  writeWidget,
  deleteWidget,
  listWidgets,
  primaryPayloadSize,
} from "./widgetService";
import { maskWidgetSecrets, maskPayloadSecrets, restorePayloadSecrets } from "./sourceSecrets";

// ── Async route wrapper ────────────────────────────────────────

/**
 * Shared error-to-response logic used by both asyncHandler and routes that
 * need a try/finally (e.g. RenderGuard release).
 */
function handleRouteError(label: string, fallback: string, err: unknown, res: Response): void {
  if (err instanceof HttpError) {
    logWarn("route.error", {
      requestId: getResponseRequestId(res),
      route: label,
      statusCode: err.statusCode,
      error: err,
    });
    res.status(err.statusCode).json({ error: err.message });
  } else {
    logError("route.error", {
      requestId: getResponseRequestId(res),
      route: label,
      statusCode: 500,
      error: err,
    });
    res.status(500).json({ error: fallback });
  }
}

/**
 * Extract a 4xx client-error status from an error raised by upstream
 * middleware (e.g. body-parser sets `status`/`statusCode` = 413 on an
 * oversized body). Returns undefined for anything that is not a recognised
 * 4xx so the caller falls back to a generic 500.
 */
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { status?: unknown; statusCode?: unknown };
  const status = typeof candidate.status === "number"
    ? candidate.status
    : typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : undefined;
  return status !== undefined && status >= 400 && status < 500 ? status : undefined;
}

/**
 * Whether an error's message is safe to send to the client. Connect/http-errors
 * style errors set `expose: true` for client errors (the message is generic and
 * non-sensitive). Anything else gets a redacted, generic message.
 */
function isExposable(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { expose?: unknown }).expose === true;
}

/**
 * Wrap an async Express route handler so thrown errors are caught and sent
 * as a standard JSON error response.  HttpError instances control the
 * status code; all other errors become 500.
 *
 * @param label  Route label for server-side log lines (e.g. "GET /api/widgets")
 * @param fallback  Client-facing message for unexpected (non-HttpError) failures
 * @param fn  The async handler to wrap
 */
function asyncHandler(
  label: string,
  fallback: string,
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res, next).catch((err: unknown) => {
      handleRouteError(label, fallback, err, res);
    });
  };
}

// ── Export token store ─────────────────────────────────────────

interface ExportEntry {
  data: unknown;
  expiresAt: number;
}

const exportStore = new Map<string, ExportEntry>();

// Purge expired tokens periodically
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of exportStore) {
    if (now >= entry.expiresAt) exportStore.delete(token);
  }
}, EXPORT_PURGE_INTERVAL_MS);

function createExportToken(data: unknown): string {
  if (exportStore.size >= MAX_EXPORT_TOKENS) {
    throw new Error("Export token limit reached. Please wait for existing tokens to expire.");
  }
  const token = crypto.randomBytes(16).toString("hex");
  exportStore.set(token, { data, expiresAt: Date.now() + EXPORT_TTL_MS });
  return token;
}

// ── Slot helpers ───────────────────────────────────────────────

/**
 * Resolve the optional `slot` parameter that `/render` and `/payload`
 * accept on either the query string or the body. Returns the slot, or
 * null if the value is present but invalid (caller responds 400).
 *
 * Missing entirely → defaults to `"primary"` for backward compatibility
 * with all pre-fullscreen clients.
 */
function resolveSlot(req: Request): Slot | null {
  const raw = (req.query.slot as unknown) ?? (req.body && (req.body as Record<string, unknown>).slot);
  if (raw === undefined || raw === null) return "primary";
  if (raw === "primary" || raw === "fullscreen") return raw;
  return null;
}

const widgetSaveRequestSchema = z.object({
  name: z.string().trim().min(1).max(255),
  doc: payloadSchema,
  metadata: z.object({}).passthrough().optional(),
  fullscreen: z.union([fullscreenPayloadSchema, z.null()]).optional(),
}).passthrough();

const exportRequestSchema = z.object({}).passthrough();
const exportTokenParamsSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{32}$/i),
});

function zodLogFields(error: z.ZodError): { issueCount: number; fields: string[] } {
  const fields = Array.from(
    new Set(error.issues.map((issue) => issue.path.join(".") || "(root)")),
  ).slice(0, 8);
  return { issueCount: error.issues.length, fields };
}

/**
 * Build a field-level explanation of why a source config failed `sourceSchema`.
 * `sourceSchema` is a `z.union`, so a failure surfaces as one `invalid_union`
 * issue with the useless path `(root)` — useless for telling a designer what to
 * fix. To pinpoint the offending field we re-validate against the branch that
 * matches the config's declared `kind` and report that branch's field errors.
 *
 * Used only by the builder-only, same-origin `/render/test-source` route so the
 * Test Source panel can show exactly what's wrong. It returns constraint
 * messages and field paths only — never the submitted values — so nothing
 * sensitive is echoed back.
 */
function describeSourceSchemaError(
  sourceConfig: unknown,
  unionError: z.ZodError,
): { message: string; fields: Array<{ field: string; message: string }> } {
  const kind =
    sourceConfig && typeof sourceConfig === "object"
      ? (sourceConfig as { kind?: unknown }).kind
      : undefined;
  const branch =
    kind === "haState"
      ? haStateSourceSchema
      : kind === "haHistory"
        ? haHistorySourceSchema
        : httpSourceSchema;
  const branchResult = branch.safeParse(sourceConfig);
  const issues = branchResult.success ? unionError.issues : branchResult.error.issues;
  const fields = issues
    .filter((issue) => issue.code !== "invalid_union")
    .map((issue) => ({ field: issue.path.join(".") || "(root)", message: issue.message }))
    .slice(0, 12);
  const message = fields.length
    ? `Invalid source config — ${fields.map((f) => `${f.field}: ${f.message}`).join("; ")}`
    : "Invalid source config schema.";
  return { message, fields };
}

type RenderPayloadParseResult =
  | { success: true; data: z.infer<typeof payloadSchema> }
  | { success: false; error: z.ZodError };

function parseRenderPayload(raw: unknown, slot: Slot): RenderPayloadParseResult {
  const schema = slot === "fullscreen" ? fullscreenPayloadSchema : payloadSchema;
  const parseResult = schema.safeParse(raw);
  if (!parseResult.success) return { success: false, error: parseResult.error };
  return { success: true, data: parseResult.data };
}

// ── App factory ────────────────────────────────────────────────

export interface AppContext {
  ingressApp: express.Application;
  renderGuard: RenderGuard;
  sourceHandler: SourceHandler | null;
  markShuttingDown: () => void;
  isShuttingDown: () => boolean;
}

/**
 * Create the fully wired Ingress Express app.
 *
 * @param adapter  Platform-specific adapter (HA, cloud, etc.)
 * @returns The Express app and supporting objects for the entrypoint to use.
 */
export function createIngressApp(adapter: PlatformAdapter): AppContext {
  const app = express();
  const storage = adapter.storage;
  const renderGuard = new RenderGuard();
  const sourceHandler = adapter.getSourceHandler();
  let shuttingDown = false;

  app.use(requestContextMiddleware);
  app.use(express.json({ limit: MAX_REQUEST_BODY }));

  // ── Rate limiting ──────────────────────────────────────────
  const mutationLimiter = rateLimit("mutation", RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MUTATION);
  const sourceTestLimiter = rateLimit("source-test", RATE_LIMIT_WINDOW_MS, RATE_LIMIT_SOURCE_TEST);
  const renderExpandLimiter = rateLimit("render-expand", RATE_LIMIT_WINDOW_MS, RATE_LIMIT_RENDER_EXPAND);

  // ── Security headers ───────────────────────────────────────
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // SAMEORIGIN (not DENY) because HA Ingress embeds the add-on in an iframe
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        // 'unsafe-inline' needed for Vite-built React SPA
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "connect-src 'self'",
      ].join("; "),
    );
    next();
  });

  // Reject new ingress work during bounded shutdown while keeping /health
  // available so the supervisor can observe the coarse readiness state.
  app.use((req, res, next) => {
    if (!shuttingDown || req.path === "/health") {
      next();
      return;
    }
    res.status(503).json({ error: "Server is shutting down." });
  });

  // ── Static file serving ────────────────────────────────────
  const ROOT = path.resolve(__dirname, "../..");
  const builderPath = path.join(ROOT, "builder", "dist");
  const publicPath = path.join(ROOT, "public");

  // Serve builder SPA at /builder/ — must be before the catch-all
  app.use("/builder", express.static(builderPath, { index: "index.html", dotfiles: "deny" }));

  // ── Health/readiness (Ingress only) ─────────────────────────
  app.get("/health", (_req, res) => {
    const status = shuttingDown ? "shutting_down" : "ok";
    res.status(shuttingDown ? 503 : 200).json({
      status,
      components: {
        ingress: shuttingDown ? "stopping" : "ready",
        renderer: renderGuard.isLocked() ? "busy" : "ready",
        storage: "configured",
      },
    });
  });

  // ── Bitmap font API (read-only, for builder preview) ───────
  const fontsDir = path.join(ROOT, "fonts", "latin");
  const fontFilePattern = /^[A-Za-z]+_\d+px_[A-Za-z]+\.json$/;

  // GET /api/fonts — list available font files
  app.get("/api/fonts", asyncHandler("GET /api/fonts", "Failed to list fonts.", async (_req, res) => {
    const fs = require("fs") as typeof import("fs");
    const files = fs.readdirSync(fontsDir).filter((f: string) => fontFilePattern.test(f));
    res.json(files);
  }));

  // GET /api/fonts/:filename — serve a single font JSON (immutable cache)
  app.get("/api/fonts/:filename", (req: Request, res: Response) => {
    const { filename } = req.params;
    if (!fontFilePattern.test(filename)) {
      res.status(400).json({ error: "Invalid font filename." });
      return;
    }
    const filePath = path.join(fontsDir, filename);
    const fs = require("fs") as typeof import("fs");
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ error: "Font not found." });
      return;
    }
    // Fonts are immutable — cache aggressively
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  });

  // ── Platform-specific routes ───────────────────────────────
  // Registered before core routes so the platform can override or add
  // endpoints without interference.
  adapter.registerRoutes(app);

  // ── Widget CRUD API ────────────────────────────────────────

  app.get("/api/widgets", asyncHandler("GET /api/widgets", "Failed to list widgets.", async (_req, res) => {
    const widgets = await listWidgets(storage);
    res.json(widgets);
  }));

  // GET /api/widgets/new-id MUST be registered before /api/widgets/:id
  app.get("/api/widgets/new-id", asyncHandler("GET /api/widgets/new-id", "Failed to generate widget ID.", async (_req, res) => {
    const id = generateWidgetId();
    res.json({ id });
  }));

  app.get("/api/widgets/:id", asyncHandler("GET /api/widgets/:id", "Failed to read widget.", async (req, res) => {
    const widget = await readWidget(storage, req.params.id);
    if (!widget) {
      res.status(404).json({ error: "Widget not found.", code: "NOT_FOUND" });
      return;
    }
    res.json(maskWidgetSecrets(widget));
  }));

  app.put("/api/widgets/:id", mutationLimiter, asyncHandler("PUT /api/widgets/:id", "Failed to save widget.", async (req, res) => {
    const { id } = req.params;
    const parseResult = widgetSaveRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "PUT /api/widgets/:id",
        statusCode: 400,
        ...zodLogFields(parseResult.error),
      });
      res.status(400).json({ error: "Invalid widget save request." });
      return;
    }

    const { name, doc, metadata, fullscreen } = parseResult.data;

    // The fullscreen field is optional. When supplied it MUST be either an
    // object (a payload — schema-validated by writeWidget) or null (explicit
    // companion removal). Missing means "leave existing companion unchanged".
    const hasFullscreenField = Object.prototype.hasOwnProperty.call(req.body, "fullscreen");

    const widget: WidgetDoc = {
      id,
      name,
      doc,
      metadata,
      updatedAt: Date.now(),
    };
    if (hasFullscreenField) {
      widget.fullscreen = fullscreen as unknown;
    } else {
      const existing = await readWidget(storage, id);
      if (existing?.fullscreen != null) {
        widget.fullscreen = existing.fullscreen;
      }
    }
    const saved = await writeWidget(storage, widget);
    logInfo("widget.save", { requestId: getRequestId(req), widgetId: id });
    // pairingId/fullscreenPairingId are additive: assigned lazily inside
    // writeWidget, echoed here so the builder can render the pairing QR
    // without a follow-up GET. JSON.stringify drops them while undefined.
    //
    // width/height are the PERSISTED primary-payload pixel size — the QR's
    // `w`/`h`. Echoed for the same reason, and only here: GET already carries
    // the size inside `doc.misc.size`, so duplicating it there would be a
    // second source of truth in one response. The save response is the only
    // place the builder can learn the size the server actually stored.
    const primarySize = primaryPayloadSize(saved);
    res.json({
      ok: true,
      id,
      name: saved.name,
      updatedAt: saved.updatedAt,
      pairingId: saved.pairingId,
      fullscreenPairingId: saved.fullscreenPairingId,
      width: primarySize?.width,
      height: primarySize?.height,
    });
  }));

  app.delete("/api/widgets/:id", mutationLimiter, asyncHandler("DELETE /api/widgets/:id", "Failed to delete widget.", async (req, res) => {
    const existed = await deleteWidget(storage, req.params.id);
    if (!existed) {
      res.status(404).json({ error: "Widget not found.", code: "NOT_FOUND" });
      return;
    }
    logInfo("widget.delete", { requestId: getRequestId(req), widgetId: req.params.id });
    res.json({ ok: true });
  }));

  // ── Payload management ─────────────────────────────────────

  app.get("/payload", asyncHandler("GET /payload", "Failed to read payload.", async (_req, res) => {
    const raw = await storage.readPayload();
    if (!raw) {
      res.status(404).json({ error: "No payload.json found." });
      return;
    }
    res.json(maskPayloadSecrets(raw));
  }));

  // POST /export — create a temporary export token
  app.post("/export", mutationLimiter, (req: Request, res: Response) => {
    const parseResult = exportRequestSchema.safeParse(req.body);
    if (!parseResult.success) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "POST /export",
        statusCode: 400,
        ...zodLogFields(parseResult.error),
      });
      res.status(400).json({ error: "Invalid export request." });
      return;
    }

    try {
      const token = createExportToken(parseResult.data);
      logInfo("export_token.create", {
        requestId: getRequestId(req),
        ttlSeconds: EXPORT_TTL_MS / 1000,
        activeTokens: exportStore.size,
      });
      res.json({ token, expiresIn: EXPORT_TTL_MS });
    } catch (err) {
      logWarn("export_token.reject", {
        requestId: getRequestId(req),
        statusCode: 429,
        error: err,
      });
      res.status(429).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /export/:token — one-time fetch of entity export data
  app.get("/export/:token", (req: Request, res: Response) => {
    const parseResult = exportTokenParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      res.status(400).json({ error: "Invalid export token." });
      return;
    }

    const { token } = parseResult.data;
    const entry = exportStore.get(token);

    if (!entry) {
      res.status(404).json({ error: "Export token not found or expired." });
      return;
    }

    if (Date.now() >= entry.expiresAt) {
      exportStore.delete(token);
      res.status(410).json({ error: "Export token has expired." });
      return;
    }

    exportStore.delete(token);
    logInfo("export_token.redeem", {
      requestId: getRequestId(req),
      activeTokens: exportStore.size,
    });
    res.json(entry.data);
  });

  // PUT /payload — deploy a new payload from the builder
  app.put("/payload", mutationLimiter, async (req: Request, res: Response) => {
    const raw = req.body;

    if (!raw || typeof raw !== "object") {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "PUT /payload",
        statusCode: 400,
        reason: "body_not_object",
      });
      res.status(400).json({ error: "Request body must be a JSON object." });
      return;
    }

    const slot = resolveSlot(req);
    if (slot === null) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "PUT /payload",
        statusCode: 400,
        reason: "invalid_slot",
      });
      res.status(400).json({ error: "Invalid 'slot' — must be 'primary' or 'fullscreen'." });
      return;
    }

    // Pick the strict schema for fullscreen so a misconfigured companion
    // (e.g. wrong gridSize) is rejected before render.
    const schema = slot === "fullscreen" ? fullscreenPayloadSchema : payloadSchema;
    const parseResult = schema.safeParse(raw);
    if (!parseResult.success) {
      // Log detailed validation errors server-side; return generic message to client
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "PUT /payload",
        slot,
        statusCode: 400,
        ...zodLogFields(parseResult.error),
      });
      res.status(400).json({ error: "Invalid payload schema." });
      return;
    }

    const validated = parseResult.data;

    const release = renderGuard.tryAcquire();
    if (!release) {
      logWarn("render.busy", {
        requestId: getRequestId(req),
        route: "PUT /payload",
        slot,
        statusCode: 409,
      });
      res.status(409).json({ error: "A render is already in progress. Please try again shortly." });
      return;
    }
    try {
      logInfo("render.start", { requestId: getRequestId(req), route: "PUT /payload", slot, deploy: true });
      // Restore mask-on-read source secrets from the prior deployed payload for
      // this slot (matched by source id) BEFORE persist + render, so a re-deploy
      // of a payload loaded via masked GET /payload neither writes the
      // "__stored__" sentinel to disk (which would destroy the real stored
      // credential) nor authenticates the deploy render with it. An unmatched
      // sentinel is dropped, never persisted — that source deploys without auth.
      const priorPayload = await storage.readPayload(slot);
      restorePayloadSecrets(validated, priorPayload);
      // Persist the Zod-validated, secret-restored payload to the slot-specific file.
      const payloadBuf = Buffer.from(JSON.stringify(validated, null, 2), "utf-8");
      await storage.writePayload(payloadBuf, slot);
      const meta = await renderAndCache(validated, storage, sourceHandler, slot);

      if (meta.sourceErrors.length > 0) {
        logWarn("source.fetch.failure", {
          requestId: getRequestId(req),
          route: "PUT /payload",
          slot,
          count: meta.sourceErrors.length,
          errors: meta.sourceErrors,
        });
        res.setHeader("X-Source-Errors", Buffer.from(JSON.stringify(meta.sourceErrors)).toString("base64"));
      }
      if (meta.renderErrors.length > 0) {
        logWarn("render.element.warning", {
          requestId: getRequestId(req),
          route: "PUT /payload",
          slot,
          count: meta.renderErrors.length,
          errors: meta.renderErrors,
        });
        res.setHeader("X-Render-Errors", Buffer.from(JSON.stringify(meta.renderErrors)).toString("base64"));
      }

      logInfo("render.finish", {
        requestId: getRequestId(req),
        route: "PUT /payload",
        slot,
        deploy: true,
        renderTimeMs: meta.renderTimeMs,
        sourceErrorCount: meta.sourceErrors.length,
        renderErrorCount: meta.renderErrors.length,
      });

      res.json({
        ok: true,
        slot,
        name: meta.name,
        width: meta.width,
        height: meta.height,
        renderTimeMs: meta.renderTimeMs,
        sourceErrors: meta.sourceErrors,
        renderErrors: meta.renderErrors,
      });
    } catch (err) {
      logWarn("render.failed", { requestId: getRequestId(req), route: "PUT /payload", slot, error: err });
      handleRouteError("PUT /payload", "Render failed.", err, res);
    } finally {
      release();
    }
  });

  // ── Render endpoint ────────────────────────────────────────

  app.post("/render", mutationLimiter, async (req: Request, res: Response) => {
    const slot = resolveSlot(req);
    if (slot === null) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "POST /render",
        statusCode: 400,
        reason: "invalid_slot",
      });
      res.status(400).json({ error: "Invalid 'slot' — must be 'primary' or 'fullscreen'." });
      return;
    }

    const parseResult = parseRenderPayload(req.body, slot);
    if (!parseResult.success) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "POST /render",
        slot,
        statusCode: 400,
        ...zodLogFields(parseResult.error),
      });
      res.status(400).json({ error: "Invalid payload schema." });
      return;
    }
    const payload = parseResult.data;

    const release = renderGuard.tryAcquire();
    if (!release) {
      logWarn("render.busy", {
        requestId: getRequestId(req),
        route: "POST /render",
        slot,
        statusCode: 409,
      });
      res.status(409).json({ error: "A render is already in progress. Please try again shortly." });
      return;
    }
    try {
      const isDeploy = req.headers["x-deploy"] === "true";
      logInfo("render.start", { requestId: getRequestId(req), route: "POST /render", slot, deploy: isDeploy });
      if (isDeploy) {
        // Deploy persists payload.json — restore mask-on-read source secrets from
        // the prior deployed payload for this slot first (see PUT /payload), so the
        // deploy neither authenticates with nor persists the "__stored__" sentinel.
        // Preview (non-deploy) intentionally does NOT restore: the preview payload
        // may belong to a different widget than the deployed slot, and matching by
        // source id across unrelated payloads could surface the wrong stored token.
        const priorPayload = await storage.readPayload(slot);
        restorePayloadSecrets(payload, priorPayload);
      }
      const { pngBuffer, binBuffer, meta } = await runPipeline(payload, sourceHandler, storage);

      if (meta.sourceErrors.length > 0) {
        logWarn("source.fetch.failure", {
          requestId: getRequestId(req),
          route: "POST /render",
          slot,
          count: meta.sourceErrors.length,
          errors: meta.sourceErrors,
        });
      }
      // Per-element render errors (e.g. SVG rasterization timeout) are caught
      // by the renderer and reported as metadata rather than thrown. Log them
      // so they’re visible in the add-on log even when the client doesn’t
      // surface the X-Render-Errors header.
      if (meta.renderErrors.length > 0) {
        logWarn("render.element.warning", {
          requestId: getRequestId(req),
          route: "POST /render",
          slot,
          count: meta.renderErrors.length,
          errors: meta.renderErrors,
        });
      }

      // On deploy, persist the already validated Zod-cleaned payload to the slot.
      if (isDeploy) {
        const payloadBuf = Buffer.from(JSON.stringify(payload, null, 2), "utf-8");
        await storage.writePayload(payloadBuf, slot);
        await cacheImages(storage, pngBuffer, binBuffer, meta, slot);
        logInfo("render.deploy.save", { requestId: getRequestId(req), slot });
      }

      logInfo("render.finish", {
        requestId: getRequestId(req),
        route: "POST /render",
        slot,
        deploy: isDeploy,
        renderTimeMs: meta.renderTimeMs,
        sourceErrorCount: meta.sourceErrors.length,
        renderErrorCount: meta.renderErrors.length,
        pngBytes: pngBuffer.length,
        binBytes: binBuffer.length,
      });

      const format = meta.format;

      // Expose render metadata via headers
      res.setHeader("X-Render-Time", String(meta.renderTimeMs));
      res.setHeader("X-Render-Slot", slot);
      if (meta.sourceErrors.length > 0) {
        res.setHeader("X-Source-Errors", Buffer.from(JSON.stringify(meta.sourceErrors)).toString("base64"));
      }
      if (meta.renderErrors.length > 0) {
        res.setHeader("X-Render-Errors", Buffer.from(JSON.stringify(meta.renderErrors)).toString("base64"));
      }

      if (format === "bin") {
        res.setHeader("Content-Type", "application/octet-stream");
        res.status(200).send(binBuffer);
      } else {
        res.setHeader("Content-Type", "image/png");
        res.status(200).send(pngBuffer);
      }
    } catch (err) {
      // `aborted` is set by `RenderTimeoutError` (see renderService) so
      // operators can distinguish a render that timed out and was
      // forcibly cancelled from one that errored mid-pipeline.
      const aborted = err instanceof Error && (err as { aborted?: boolean }).aborted === true;
      logWarn("render.failed", {
        requestId: getRequestId(req),
        route: "POST /render",
        slot,
        aborted,
        error: err,
      });
      handleRouteError("POST /render", "Render failed.", err, res);
    } finally {
      release();
    }
  });

  // POST /render/expand — return expanded payload JSON (no actual rendering).
  app.post("/render/expand", renderExpandLimiter, asyncHandler("POST /render/expand", "Expand failed.", async (req, res) => {
    const parseResult = payloadSchema.safeParse(req.body);
    if (!parseResult.success) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "POST /render/expand",
        statusCode: 400,
        ...zodLogFields(parseResult.error),
      });
      res.status(400).json({ error: "Invalid payload schema." });
      return;
    }

    const expanded = await expandPipeline(parseResult.data, sourceHandler, storage);
    res.json(expanded);
  }));

  // POST /render/test-source — test a single source config
  app.post("/render/test-source", sourceTestLimiter, asyncHandler("POST /render/test-source", "Source test failed.", async (req, res) => {
    const sourceConfig = req.body;
    if (!sourceConfig || typeof sourceConfig !== "object") {
      res.status(400).json({ error: "Request body must be a source config object." });
      return;
    }

    // Validate against source schema before processing (ENGINEERING_CONSTRAINTS S1)
    const parseResult = sourceSchema.safeParse(sourceConfig);
    if (!parseResult.success) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "POST /render/test-source",
        statusCode: 400,
        ...zodLogFields(parseResult.error),
      });
      // Builder-only diagnostic: report the exact failing field(s) so the Test
      // Source panel shows what to fix, instead of a generic "invalid schema".
      const detail = describeSourceSchemaError(sourceConfig, parseResult.error);
      res.status(400).json({ error: detail.message, fields: detail.fields });
      return;
    }

    // `../expressions/context` is a frozen-engine shim that non-shim src/ files are
    // restricted from importing statically (eslint no-restricted-imports), so it is
    // loaded dynamically here. `fetchAllSources` is a normal static import (top of file).
    const { createDataContext, validateContextKey } = await import("../expressions/context");

    const validatedSource = parseResult.data;

    // Reject reserved context root names (ENGINEERING_CONSTRAINTS §S1 — same semantic check as payloadSchema)
    if (!validateContextKey(validatedSource.id)) {
      logWarn("schema.reject", {
        requestId: getRequestId(req),
        route: "POST /render/test-source",
        statusCode: 400,
        reason: "reserved_context_key",
      });
      res.status(400).json({ error: "Source ID collides with a reserved context name." });
      return;
    }

    const ctx = createDataContext();
    const result = await fetchAllSources([validatedSource], ctx, sourceHandler);
    if (result.errors.length > 0) {
      logWarn("source.fetch.failure", {
        requestId: getRequestId(req),
        route: "POST /render/test-source",
        count: result.errors.length,
        errors: result.errors,
      });
    }

    res.json({
      ok: true,
      data: ctx[validatedSource.id] ?? null,
      errors: result.errors,
    });
  }));

  // GET /image.png and /image_fullscreen.png — serve cached PNG preview per slot.
  // The builder's PreviewOverlay reads these via the ingress prefix so the
  // fullscreen tab can show the companion's last-rendered image without
  // routing through the unauthenticated port-8000 image server.
  const serveCachedPng = (slot: Slot) => (_req: Request, res: Response) => {
    const pngPath = storage.getCachedImagePath("png", slot);
    if (!pngPath) {
      res.status(404).json({ error: "No image cached yet. Deploy a payload first." });
      return;
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(pngPath);
  };
  app.get("/image.png", serveCachedPng("primary"));
  app.get("/image_fullscreen.png", serveCachedPng("fullscreen"));

  // ── Static serving ─────────────────────────────────────────

  // Serve management panel at /panel
  app.use("/panel", express.static(publicPath, { index: "index.html", dotfiles: "deny" }));

  // Serve builder SPA as the default root view — MUST be the LAST middleware (catch-all)
  app.use(express.static(builderPath, { index: "index.html", dotfiles: "deny" }));

  // App-wide error backstop. Express routes errors here when a handler calls
  // next(err) or throws synchronously; combined with asyncHandler (which
  // catches rejected promises per route), this guarantees any uncaught route
  // error becomes a JSON response instead of a default HTML stack trace or a
  // hung request. Must be registered after all routes/middleware. Express
  // identifies it as an error handler by its 4-argument arity.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    // Honor a client-error status already set by upstream middleware the way
    // Express's default handler would — e.g. body-parser's 413 Payload Too
    // Large. Only genuinely unexpected errors fall through to a generic 500.
    if (!(err instanceof HttpError)) {
      const status = clientErrorStatus(err);
      if (status !== undefined) {
        const message = isExposable(err) ? (err as Error).message : "Request could not be processed.";
        logWarn("route.error", {
          requestId: getResponseRequestId(res),
          route: "unhandled",
          statusCode: status,
          error: err,
        });
        res.status(status).json({ error: message });
        return;
      }
    }
    handleRouteError("unhandled", "Internal server error.", err, res);
  });

  return {
    ingressApp: app,
    renderGuard,
    sourceHandler,
    markShuttingDown: () => {
      shuttingDown = true;
    },
    isShuttingDown: () => shuttingDown,
  };
}
