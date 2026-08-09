export const MAX_IMAGE_FETCH_BYTES = 10 * 1024 * 1024;
export const MAX_SVG_FETCH_BYTES = 1 * 1024 * 1024;
export const MAX_INLINE_SVG_BYTES = 1 * 1024 * 1024;
export const IMAGE_FETCH_TIMEOUT_MS = 300;

/** Maximum time allowed for a single SVG rasterization pass via sharp. */
export const SVG_RASTER_TIMEOUT_MS = 300;

import { validateUrlWithDns } from "../../data/urlValidator";

/**
 * Race a promise against a deadline.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    handle.unref?.();
  });
  const guarded = promise.then(
    (v) => { clearTimeout(handle); return v; },
    (e) => { clearTimeout(handle); throw e; },
  );
  return Promise.race([guarded, timeoutPromise]);
}

export async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  init?: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error
      ? `${err.name}: ${err.message}`
      : String(err);
    if (message.includes("AbortError") || message.includes("aborted")) {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timer);
  }
}

function formatLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${Math.round(bytes / (1024 * 1024))} MiB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KiB`;
  }
  return `${bytes} bytes`;
}

function buildLimitError(label: string, maxBytes: number): Error {
  return new Error(`${label} exceeds ${formatLimit(maxBytes)} limit`);
}

async function readResponseBufferWithLimit(
  response: Response,
  label: string,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw buildLimitError(label, maxBytes);
    }
  }

  if (!response.body) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw buildLimitError(label, maxBytes);
    }
    return Buffer.from(arrayBuffer);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw buildLimitError(label, maxBytes);
    }

    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, totalBytes);
}

export async function fetchBufferWithLimit(
  url: string,
  label: string,
  maxBytes: number,
  timeoutMs?: number,
): Promise<Buffer> {
  // SSRF guard: block private/internal networks, enforce domain allowlist, and
  // resolve DNS to mitigate rebinding before fetching. A residual TOCTOU window
  // remains (the fetch re-resolves the hostname) — see SECURITY.md.
  // Operator-allowlisted private hosts (allow_private_hosts). Redirect
  // targets below stay strict — see plan 3.25 D4.
  await validateUrlWithDns(label, url, { allowPrivateHosts: true });

  // SSRF guard (redirect): undici follows 3xx automatically, so a redirect
  // from an allowed public host to an internal target (e.g. 127.0.0.1,
  // 169.254.169.254) would otherwise be fetched without re-validation. We
  // fetch with `redirect: "manual"`, re-validate the Location target against
  // the same SSRF rules, and refuse to follow. Mirrors sourceFetcher.ts.
  const init: RequestInit = { redirect: "manual" };
  const response = timeoutMs !== undefined
    ? await fetchWithTimeout(url, timeoutMs, init)
    : await fetch(url, init);

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location) {
      await validateUrlWithDns(label, new URL(location, url).toString());
    }
    throw new Error(
      `${label}: blocked redirect to ${location ?? "unknown location"} — ` +
        `re-fetch not supported for security.`,
    );
  }

  if (!response.ok) {
    throw new Error(`${label} fetch failed with HTTP ${response.status}`);
  }

  return readResponseBufferWithLimit(response, label, maxBytes);
}

export async function fetchTextWithLimit(
  url: string,
  label: string,
  maxBytes: number,
  timeoutMs?: number,
): Promise<string> {
  const buffer = await fetchBufferWithLimit(url, label, maxBytes, timeoutMs);
  return buffer.toString("utf8");
}

export function assertTextWithinLimit(text: string, label: string, maxBytes: number): void {
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw buildLimitError(label, maxBytes);
  }
}
