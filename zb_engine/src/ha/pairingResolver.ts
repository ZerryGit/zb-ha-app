/**
 * pairingResolver.ts — pairingId → (widget, slot) resolution for port 8000
 *
 * Backed by `StorageAdapter.listWidgets()` with a short in-memory TTL cache
 * so a device request burst does not re-read every widget file. READ-PATH
 * ONLY: a seconds-stale answer costs at most one `status = 0` section in a
 * multi-frame reply (a just-saved widget becomes resolvable within one TTL
 * window). Pairing-ID UNIQUENESS is never checked here — that scans an
 * in-mutex-fresh `listWidgets()` snapshot in `core/widgetService.ts`.
 *
 * Lives in `src/ha/` and is injected into the image app as a function
 * (`src/core/` must not import `src/ha/`; the image app takes the resolver
 * as a dep for testability, mirroring `readPayload`).
 */

import type { Slot, StorageAdapter } from "../core/adapters";
import { PAIRING_RESOLVER_CACHE_TTL_MS } from "../limits";

/** Resolution result: which widget + which slot a pairing ID addresses. */
export interface PairingTarget {
  widgetId: string;
  slot: Slot;
}

export type ResolvePairing = (pairingId: number) => Promise<PairingTarget | null>;

/**
 * Create a TTL-cached resolver over the stored widget metas. Concurrent
 * calls during a rebuild may each call `listWidgets()` once — harmless
 * (read-only), and simpler than a stampede guard the quota-capped widget
 * set does not need.
 */
export function createPairingResolver(
  storage: Pick<StorageAdapter, "listWidgets">,
  ttlMs: number = PAIRING_RESOLVER_CACHE_TTL_MS,
): ResolvePairing {
  let index: Map<number, PairingTarget> | null = null;
  let builtAt = 0;

  return async function resolvePairing(pairingId: number): Promise<PairingTarget | null> {
    const now = Date.now();
    if (!index || now - builtAt >= ttlMs) {
      const metas = await storage.listWidgets();
      const next = new Map<number, PairingTarget>();
      for (const m of metas) {
        if (typeof m.pairingId === "number") {
          next.set(m.pairingId, { widgetId: m.id, slot: "primary" });
        }
        if (typeof m.fullscreenPairingId === "number") {
          next.set(m.fullscreenPairingId, { widgetId: m.id, slot: "fullscreen" });
        }
      }
      index = next;
      builtAt = now;
    }
    return index.get(pairingId) ?? null;
  };
}
