/**
 * sourceFetcher.ts — Fetch all sources in parallel → data context
 *
 * Per README "Phase 3 — sources":
 *   Each source fetches data from one URL, parses it, and exposes
 *   named data fields to the drawing phase.
 */

import { XMLParser } from "fast-xml-parser";
import { resolveValue, type DataContext } from "@zb/expressions";
import {
  DataFieldDef,
  extractDataFields,
  extractDefaultFields,
} from "./dataFieldExtractor";
import { SourceError, SourceErrorInfo } from "../errors/sourceError";
import { fetchWithTimeout, readResponseTextWithLimit } from "./safeFetch";
import { validateUrlWithDns } from "./urlValidator";
import {
  MAX_SOURCE_TIMEOUT_MS,
  MAX_SOURCE_TOTAL_TIMEOUT_MS,
  MAX_SOURCE_RETRIES,
  MAX_SOURCE_RESPONSE_BYTES,
  MAX_SOURCE_CONCURRENCY,
  MAX_CSV_COLUMNS,
  MAX_CSV_ROWS,
} from "../limits";

// ── Types ──────────────────────────────────────────────────────

interface SourceAuth {
  type: "none" | "apiKey" | "bearer" | "basic";
  apiKey?: { in: "query" | "header"; name: string; value: string };
  bearer?: string;
  basic?: { username: string; password: string };
}

export interface SourceDef {
  id: string;
  kind?: "http";
  enabled?: unknown;            // bindable → resolved at runtime via resolveValue()
  method: "GET" | "POST";
  url?: unknown;                // bindable → resolved at runtime via resolveValue()
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  auth?: SourceAuth;
  body?: { type: "json" | "form" | "text" | "none"; [key: string]: unknown };
  timeoutMs?: number;
  retries?: number;
  response: { type: "json" | "xml" | "csv" | "text" };
  dataFields?: DataFieldDef[];
}

export interface HaHistorySourceDef {
  id: string;
  kind: "haHistory";
  enabled?: unknown;
  entity_id: string;
  hoursBack: number;
  dataFields?: DataFieldDef[];
}

export interface HaStateSourceDef {
  id: string;
  kind: "haState";
  enabled?: unknown;
  entity_id: string;
  attribute?: string;
  dataFields?: DataFieldDef[];
}

export type AnySourceDef = SourceDef | HaHistorySourceDef | HaStateSourceDef;

/** A single state-change point returned by the HA history API. */
export interface HaHistoryPoint {
  t: number;        // Unix ms timestamp
  v: number | null; // Parsed numeric value; null for non-numeric states (e.g. "unavailable")
  s: string;        // Raw state string
}

/**
 * Normalized result stored in the data context for a haHistory source.
 * Reference in element bindings as e.g. {mySource.latest}, {mySource.points}, etc.
 */
export interface HaHistoryResult {
  entity_id: string;
  hoursBack: number;
  points: HaHistoryPoint[];  // Full history array ordered oldest → newest
  min: number | null;        // Minimum numeric value in the window
  max: number | null;        // Maximum numeric value in the window
  avg: number | null;        // Mean numeric value in the window
  latest: number | null;     // Most recent numeric value
  latestState: string;       // Most recent raw state string
  count: number;             // Total number of data points

  // ── Graph metadata (universal source contract) ─────────────
  // Pre-computed so the graph expander can skip redundant scanning.
  tMin: number;              // Earliest timestamp in ms
  tMax: number;              // Latest timestamp in ms
  labels: {                  // Pre-formatted display strings for axis labels
    tStart: string;
    tEnd: string;
    vMin: string;
    vMax: string;
  };
  /**
   * True when the upstream HA Supervisor returned more points than the
   * per-entity / per-batch caps allow and this result was downsampled
   * via LTTB. Always present so consumers do not have to coalesce
   * `undefined`.
   */
  truncated: boolean;
}

interface FetchResult {
  errors: SourceErrorInfo[];
}

type Settled<T> = PromiseSettledResult<T>;

// ── Helpers ────────────────────────────────────────────────────

// Source fetch limits are imported from ../limits
// (MAX_SOURCE_TIMEOUT_MS, MAX_SOURCE_RETRIES)

async function settleWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  if (items.length === 0) return [];

  const concurrency = Math.max(1, Math.min(limit, items.length));
  const results = new Array<Settled<R>>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) return;
        try {
          results[index] = {
            status: "fulfilled",
            value: await worker(items[index], index),
          };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );

  return results;
}

// ── Source security ─────────────────────────────────────────────

/**
 * Runtime type guard: verify that a resolved binding is a plain object
 * (Record) and throw a SourceError if not.  Prevents silent misuse of
 * arrays, primitives, or null that would crash downstream helpers.
 */
function toRecordOrThrow<V>(
  value: unknown,
  sourceId: string,
  field: string,
): Record<string, V> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, V>;
  }
  throw new SourceError(sourceId, `"${field}" resolved to ${typeof value} instead of an object.`);
}

/**
 * Wrapper that delegates to the shared urlValidator (with DNS resolution)
 * and re-throws as a SourceError so that the existing error-collection
 * pipeline keeps working.
 */
async function validateSourceUrl(
  sourceId: string,
  rawUrl: string,
  opts?: { allowPrivateHosts?: boolean },
): Promise<void> {
  try {
    await validateUrlWithDns(`Source ${sourceId}`, rawUrl, opts);
  } catch (err) {
    throw new SourceError(
      sourceId,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/** Regex for valid HTTP header names (no special chars). */
const HEADER_NAME_RE = /^[a-zA-Z0-9-]+$/;

/**
 * Validate custom headers to prevent header injection attacks.
 * Header names must be alphanumeric + hyphens only.
 * Header values must not contain CR, LF, or null bytes.
 */
function validateHeaders(sourceId: string, headers: Record<string, string>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) {
      throw new SourceError(
        sourceId,
        `Invalid header name "${name}": only alphanumeric characters and hyphens are allowed.`,
      );
    }
    if (/[\r\n\0]/.test(value)) {
      throw new SourceError(
        sourceId,
        `Invalid header value for "${name}": must not contain CR, LF, or null bytes.`,
      );
    }
  }
}

function buildUrl(
  base: string,
  query: Record<string, unknown> | undefined,
  auth: SourceAuth | undefined,
): string {
  const url = new URL(base);

  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== null && v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  if (auth?.type === "apiKey" && auth.apiKey?.in === "query") {
    url.searchParams.set(auth.apiKey.name, auth.apiKey.value);
  }

  return url.toString();
}

function buildHeaders(
  custom: Record<string, string> | undefined,
  auth: SourceAuth | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...custom };

  if (auth?.type === "apiKey" && auth.apiKey?.in === "header") {
    headers[auth.apiKey.name] = auth.apiKey.value;
  } else if (auth?.type === "bearer" && auth.bearer) {
    headers["Authorization"] = `Bearer ${auth.bearer}`;
  } else if (auth?.type === "basic" && auth.basic) {
    const encoded = Buffer.from(
      `${auth.basic.username}:${auth.basic.password}`,
    ).toString("base64");
    headers["Authorization"] = `Basic ${encoded}`;
  }

  return headers;
}

function buildBody(
  bodyDef: SourceDef["body"],
): { body?: string; contentType?: string } {
  if (!bodyDef || bodyDef.type === "none") return {};

  switch (bodyDef.type) {
    case "json":
      return {
        body:
          typeof bodyDef.json === "string"
            ? bodyDef.json
            : JSON.stringify(bodyDef.json ?? {}),
        contentType: "application/json",
      };
    case "form": {
      const params = new URLSearchParams();
      const formData = bodyDef.form ?? {};
      if (typeof formData === "object" && formData !== null && !Array.isArray(formData)) {
        for (const [k, v] of Object.entries(formData as Record<string, unknown>)) {
          params.set(k, String(v));
        }
      }
      return {
        body: params.toString(),
        contentType: "application/x-www-form-urlencoded",
      };
    }
    case "text":
      return {
        body: String(bodyDef.text ?? ""),
        contentType: "text/plain",
      };
    default:
      return {};
  }
}

/**
 * Parse CSV text into an array of objects.
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];

  if (rows.length > MAX_CSV_ROWS + 1) {
    throw new Error(`CSV exceeds ${MAX_CSV_ROWS} row limit`);
  }

  const headers = rows[0];

  if (headers.length > MAX_CSV_COLUMNS) {
    throw new Error(`CSV exceeds ${MAX_CSV_COLUMNS} column limit`);
  }

  const result: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length === 0 || (row.length === 1 && row[0] === "")) continue;
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = j < row.length ? row[j] : "";
    }
    result.push(obj);
  }

  return result;
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ",") {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
        if (i < text.length && text[i] === "\n") i++;
      } else if (ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  parseAttributeValue: true,
  parseTagValue: true,
  trimValues: true,
  // Security: explicitly disable external entity processing to prevent XXE attacks.
  // Never rely on library defaults for security — be explicit.
  processEntities: false,
});

async function parseResponse(
  res: Response,
  type: SourceDef["response"]["type"],
  signal?: AbortSignal,
): Promise<unknown> {
  // Read body with streaming size enforcement — guards against servers
  // that omit Content-Length and stream unbounded data.
  const text = await readResponseTextWithLimit(
    res,
    MAX_SOURCE_RESPONSE_BYTES,
    MAX_SOURCE_TOTAL_TIMEOUT_MS,
    "Response body",
    signal,
  );

  switch (type) {
    case "json":
      return JSON.parse(text);
    case "text": {
      // Best-effort JSON parse so sub-path bindings work even when the
      // user picks "text" for an API that actually returns JSON.
      try { return JSON.parse(text); } catch { /* not JSON */ }
      return text;
    }
    case "xml":
      return xmlParser.parse(text);
    case "csv":
      return parseCsv(text);
    default:
      return text;
  }
}

// ── Main fetch logic ───────────────────────────────────────────

async function fetchSingleSource(
  source: SourceDef,
  ctx: DataContext,
  signal?: AbortSignal,
): Promise<unknown> {
  const resolvedUrl = String(resolveValue(source.url, ctx));

  // Security: block private networks, enforce domain allowlist, and resolve
  // DNS to mitigate rebinding before fetching. A residual TOCTOU window
  // remains (the fetch re-resolves the hostname) — see SECURITY.md.
  await validateSourceUrl(source.id, resolvedUrl, { allowPrivateHosts: true });

  const resolvedQuery = source.query
    ? toRecordOrThrow<unknown>(resolveValue(source.query, ctx), source.id, "query")
    : undefined;
  const resolvedHeaders = source.headers
    ? toRecordOrThrow<string>(resolveValue(source.headers, ctx), source.id, "headers")
    : undefined;
  const resolvedAuth = source.auth
    ? (resolveValue(source.auth, ctx) as SourceAuth)
    : undefined;
  const resolvedBody = source.body
    ? (resolveValue(source.body, ctx) as SourceDef["body"])
    : undefined;

  const url = buildUrl(resolvedUrl, resolvedQuery, resolvedAuth);
  const headers = buildHeaders(resolvedHeaders, resolvedAuth);
  const { body: bodyStr, contentType } = buildBody(resolvedBody);

  if (contentType && !headers["Content-Type"]) {
    headers["Content-Type"] = contentType;
  }

  // Security: validate all custom headers against injection attacks
  validateHeaders(source.id, headers);

  const timeout = Math.min(source.timeoutMs ?? 4000, MAX_SOURCE_TIMEOUT_MS);
  const retries = Math.min(source.retries ?? 0, MAX_SOURCE_RETRIES);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new SourceError(source.id, "RENDER_ABORTED");
    try {
      const res = await fetchWithTimeout(url, timeout, {
        method: source.method,
        headers,
        body: source.method === "POST" ? bodyStr : undefined,
        redirect: "manual",
      }, signal);

      // Handle redirects — re-validate the target URL to prevent SSRF via redirect.
      // No allowPrivateHosts here: the allowlist expresses trust in a URL the
      // operator authored, and a Location header is authored by whatever answered.
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (location) {
          await validateSourceUrl(source.id, new URL(location, url).toString());
        }
        throw new SourceError(
          source.id,
          `Redirect to ${location ?? "unknown"} — re-fetch not supported for security.`,
          res.status,
        );
      }

      if (!res.ok) {
        throw new SourceError(
          source.id,
          `HTTP ${res.status} ${res.statusText}`,
          res.status,
        );
      }

      // Enforce response body size limit
      const contentLength = res.headers.get("content-length");
      if (contentLength) {
        const parsedLength = parseInt(contentLength, 10);
        if (Number.isFinite(parsedLength) && parsedLength > MAX_SOURCE_RESPONSE_BYTES) {
          throw new SourceError(
            source.id,
            `Response body too large: ${parsedLength} bytes exceeds ${MAX_SOURCE_RESPONSE_BYTES} byte limit.`,
          );
        }
      }

      return await parseResponse(res, source.response.type, signal);
    } catch (err) {
      const normalizedError = err instanceof Error ? err : new Error(String(err));
      // Render-level aborts MUST short-circuit the retry loop — the
      // whole pipeline is being torn down, retrying would just keep
      // the dead render alive past the timeout.
      if (normalizedError.message === "RENDER_ABORTED" || signal?.aborted) {
        throw new SourceError(source.id, "RENDER_ABORTED");
      }
      if (normalizedError.message.includes("timed out")) {
        lastError = new SourceError(source.id, normalizedError.message);
      } else {
        lastError = normalizedError;
      }
    }
  }

  throw lastError instanceof SourceError
    ? lastError
    : new SourceError(source.id, lastError?.message ?? "Unknown error");
}

// ── HA type exports ────────────────────────────────────────────
// These types are used by the HA adapter (haSources.ts, haEntities.ts).
// The actual fetch functions have been extracted to src/ha/haSources.ts.

export interface HaStateResult {
  entity_id: string;
  state: string;             // Raw state string (e.g. "23.5", "on", "unavailable")
  value: number | null;      // Numeric parse of state, or null if non-numeric
  attributes: Record<string, unknown>;  // Full attributes dict from HA
  last_changed: string;      // ISO timestamp of last state change
  last_updated: string;      // ISO timestamp of last update
}

/**
 * Optional platform-specific source handler callback.
 * Called for sources whose `kind` is not "http" (or undefined).
 * Should return the fetched data or throw on failure.
 *
 * The optional `signal` is the per-render `AbortSignal` owned by
 * `runPipeline`. Handlers MUST forward it to any HTTP fetch they make
 * so a render timeout actually cancels in-flight Supervisor calls.
 */
export type PlatformSourceHandler = (
  source: AnySourceDef,
  ctx: DataContext,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * Fetch all enabled sources with bounded parallelism and populate the data context.
 *
 * @param sources  Source definitions from the payload
 * @param ctx  Data context to populate
 * @param platformSourceHandler  Optional handler for platform-specific source kinds
 */
export async function fetchAllSources(
  sources: AnySourceDef[],
  ctx: DataContext,
  platformSourceHandler?: PlatformSourceHandler | null,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const errors: SourceErrorInfo[] = [];

  const enabled = sources.filter((s) => {
    const isEnabled = resolveValue(s.enabled ?? true, ctx);
    return isEnabled !== false;
  });

  const results = await settleWithConcurrency(
    enabled,
    MAX_SOURCE_CONCURRENCY,
    async (source) => {
      const kind = (source as { kind?: string }).kind;
      // Platform-specific source kinds (e.g. haState, haHistory) are
      // delegated to the platform adapter's source handler.
      if (kind && kind !== "http" && platformSourceHandler) {
        return platformSourceHandler(source, ctx, signal);
      }
      return fetchSingleSource(source as SourceDef, ctx, signal);
    },
  );

  for (let i = 0; i < enabled.length; i++) {
    const source = enabled[i];
    const result = results[i];

    if (result.status === "fulfilled") {
      if (source.dataFields && source.dataFields.length > 0) {
        ctx[source.id] = extractDataFields(result.value, source.dataFields);
      } else {
        ctx[source.id] = result.value;
      }
    } else {
      const reason = result.reason;
      const errorInfo: SourceErrorInfo =
        reason instanceof SourceError
          ? reason.toInfo()
          : {
              sourceId: source.id,
              message: reason?.message ?? "Unknown error",
            };

      errors.push(errorInfo);

      if (source.dataFields && source.dataFields.length > 0) {
        ctx[source.id] = extractDefaultFields(source.dataFields);
      } else {
        ctx[source.id] = null;
      }
    }
  }

  return { errors };
}
