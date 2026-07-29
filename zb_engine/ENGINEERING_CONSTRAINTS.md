# Engineering constraints — ZerryBit Engine

This is the short list of things the engine deliberately does and doesn't do. Most of it isn't obvious from the code, and a handful of the rules are expensive to get wrong, so it's worth a skim before changing anything in here. Architecture lives in `ARCHITECTURE.md`; the docStore and save pipeline are covered in `builder/src/store/STORE_ARCHITECTURE.md`.

## Universal constraints

These hold on every platform.

1. **The render core is frozen.** Treat everything under `src/engine/` as read-only. No new code, refactors, import changes, or comment tweaks, however harmless they look. If something in there is broken, write it down and raise it rather than patching in place.

2. **No browser dialogs.** Skip `alert()`, `confirm()`, and `prompt()`; route anything user-facing through the in-app notifications.

3. **Relative paths only in the Builder.** Use `./payload`, not `/payload`. Absolute URLs break the app under HA Ingress, reverse proxies, and subdomain deployments.

4. **Validate outbound URLs.** Every URL-based element and source-fetch URL gets checked against private and reserved IP ranges first — details in the security section below.

5. **One source of truth per concern.** Check whether something already exists before adding it, and avoid overlapping or redundant logic.
   - docStore owns all widget document state. Nothing else — no component, store, or module — keeps its own copy of document content. The current data model is in `builder/src/store/STORE_ARCHITECTURE.md`.
   - Logic shared between the server and the builder lives in the workspace packages under `packages/`. The expression engine (`@zb/expressions`) is the model to follow: one TypeScript source feeding both the CommonJS server build and the ESM builder bundle. Don't copy logic between `src/` and `builder/src/`. `src/expressions/` is only a compatibility shim, kept because the frozen `src/engine/` still imports it — new code imports from `@zb/expressions`, and ESLint enforces that.

6. **Compose complex elements from primitives.** Build graphs, charts, and the like out of the existing line / rect / circle / text primitives instead of adding new drawing paths.

7. **Draft first.** Dragging and editing run against the client-side canvas preview; the server only renders on Save and Export.

8. **Keep editor-only state out of the payload.** The JSON payload (`elements[]`, `sources[]`, `features{}`, `misc{}`) is a rendering spec for the draw engine, not a place to stash editor behavior. Every key in `ELEMENT_KNOWN_KEYS` (mapper.js) should map to something the renderer reads or the schema defines. Session and workspace state — `focusedDocId`, the open-doc list, dirty flags — never gets serialized into a widget payload.

9. **Reach the store through selectors.** Builder components read docStore state via the selector helpers in `builder/src/store/STORE_ARCHITECTURE.md` (e.g. `useDocStore(selectFocusedElements)`), not by deep-pathing into the store.

10. **Keep the store reusable.** It should stay usable by other front-ends and leave room for future split-view / multi-pane editing, which means a few things:
    - Mutations resolve the target doc with `getFocusedEntry(state)` — don't inline `state.docs[state.focusedDocId]` in a mutation body.
    - New selectors follow the `selectFocused*` convention (e.g. `selectFocusedElements`). Skip factory selectors like `selectElements(docId)` unless HA platform code actually uses them — unused API surface doesn't earn its keep.
    - Interaction state on `uiStore` (selection, viewport, tool) stays flat at the top level rather than nested under a pane or context key. The fullscreen companion already shares the primary's single canvas and flat viewport (`uiStore.viewport = { panX, panY, zoom }`), with slot switching handled by the toolbox pills; full split-view is a possible direction, not a current feature.
    - Components don't import from `builder/src/platform/`. Platform code injects into the core through `uiStore` callbacks, and new platform-specific UI follows the same pattern — register via a setter, null-check before rendering.

11. **Never break saved widgets.** Persisted widget documents (`/data/widgets/<id>.json`) are sacred — loading, parsing, and rendering of a pre-existing widget must keep working across every change. Any change to the widget document schema (`src/schema/`), the storage layout (`src/ha/haStorage.ts`), the render pipeline (`src/core/renderService.ts`), or the expression engine (`packages/zb-expressions`) is backward-compat-critical. Prefer additive/optional schema fields plus a migration; never make an existing field newly required, tighten a type, or rename/remove an element `type` without one — each hard-fails every saved widget of the old shape. Enforcement is `test/widgetBackwardCompat.test.ts`: a committed corpus of representative saved documents (`test/fixtures/widget-corpus/`) driven through the real load → `payloadSchema` → render path, asserting each still parses, still renders, and matches a committed golden PNG — a passing run is a merge gate. Migrations are version-gated: the stored envelope carries a `schemaVersion` (current: 1) stamped on save at the single write choke point (`core/widgetService.ts:writeWidget`), and loads route through the version-keyed chain in `src/core/widgetMigrations.ts`. A missing `schemaVersion` means 0 — the pre-versioning baseline — and migration is in-memory only, so reading an old file never rewrites it. `schemaVersion` belongs on the envelope, never inside `doc` / `elements` / `sources` / `fullscreen`; the payload schema and renderer stay version-agnostic. A breaking envelope change ships a migration step in that chain and bumps `CURRENT_SCHEMA_VERSION`.

## Home Assistant platform constraints

These apply to the HA add-on only, not the cloud-hosted or self-hosted builds.

1. **Stay fully local.** The add-on makes no external calls — no telemetry, CDNs, or cloud-based loaders.

2. **Don't write to disk blindly.** Compare the new buffer against the existing file before writing (`writeIfChanged`); it's what keeps SD-card wear down. When several widgets auto-save, each write goes through `writeIfChanged` on its own, and a manual save updates that widget's auto-save baseline so it doesn't immediately re-save.

3. **Keep the ports segregated.** Port 8099 (Ingress) serves the authenticated UI. Port 8000 serves read-only images only (`.bin`, `.png`) and stays unauthenticated and GET/HEAD-only.

4. **Auth through HA Ingress.** Use HA Ingress session cookies on 8099; the legacy `X-ZB-Token` path is gone.

## Security requirements

These apply everywhere unless a line says otherwise.

### Input validation

1. Validate every request body with Zod before doing anything with it.
2. Widget IDs match `/^[a-z0-9_-]+$/i`; reject `/`, `\`, `..`, and null bytes.
3. Cap request bodies at 2MB via the Express `json()` middleware.
4. Payload limits: `elements[]` up to 2000 top-level (10,000 counting nested), `sources[]` up to 50, `features{}` up to 1000 keys, expression recursion up to 20.

### Network

5. SSRF: block every private/reserved IP form — decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), IPv6 loopback (`[::1]`), IPv6-mapped IPv4 (`[::ffff:127.0.0.1]`). Resolve the hostname first, then validate the resolved IP.
6. Source fetches: 1MB response cap, 10s connect timeout, 30s total timeout, re-validate IPs after each redirect, HTTP(S) only.
7. Header injection: header names match `/^[a-zA-Z0-9-]+$/`; values carry no `\r`, `\n`, or null bytes.

### XML and SVG

8. XXE: turn off external entity processing explicitly (`processEntities: false` for fast-xml-parser).
9. SVG: strip `<script>`, `<foreignObject>`, `<iframe>`, and event handlers, disable external `<image>` refs, and cap source at 500KB.

### Expressions

10. Recursion depth maxes at 20. No `eval()` or `new Function()`, plain data only, and `__proto__` / `constructor` / `prototype` stay blocked in path resolution (BLOCKED_KEYS).

### Server hardening

11. Default security headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'`, `Referrer-Policy: strict-origin-when-cross-origin`.
    - HA Ingress (port 8099) differs: `X-Frame-Options: SAMEORIGIN` so HA can embed the iframe, and the CSP adds `'unsafe-inline'` to `script-src` and `style-src` for the Vite-built React SPA, plus `img-src 'self' data: blob:`, `font-src 'self' data:`, `worker-src 'self' blob:`, and `connect-src 'self'`.
    - Image port (8000) differs too: `Content-Security-Policy: default-src 'none'`, since it loads no resources.
12. One render at a time, behind the `RenderGuard` mutex — extra requests queue or get rejected.
13. Image port hardening (HA): port 8000 serves only the read-only image endpoints (`/image.png`, `/image.bin`, `/image_fullscreen.png`, `/image_fullscreen.bin`) — no directory listings, no POST/PUT/DELETE, no leaked error detail, and stale-while-revalidate for concurrent requests.

### Error handling

14. Keep sensitive detail out of client responses: no filesystem paths, stack traces, env vars, or internal IPs.
15. Fail gracefully — try/catch and timeouts around every external operation, so a single failure can't take the server down.

## Reference documents

- `ARCHITECTURE.md` — server and builder structure, the platform seam, build pipeline, and data-flow patterns.
- `builder/src/store/STORE_ARCHITECTURE.md` — the docStore data model (normalized multi-doc map), selector conventions, and save-pipeline rules.
- README payload section and `src/schema/payloadSchema.ts` — the JSON payload structure.
