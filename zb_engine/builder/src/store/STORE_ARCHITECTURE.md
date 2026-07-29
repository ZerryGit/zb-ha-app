# Store Architecture — docStore (Normalized Multi-Doc Map)

This document is the reference for docStore's data model: a normalized multi-document
map that supports multi-widget editing, per-widget undo/redo, and save
coordination backed by a single dirty-tracking source. docStore is the single source of
truth for all widget document state — no component, store, or module holds a separate copy
of document content (`ENGINEERING_CONSTRAINTS.md` §5).

For overall project architecture see `ARCHITECTURE.md` (root).
For engineering constraints see `ENGINEERING_CONSTRAINTS.md` (root).


## Data Model

```js
{
  focusedDocId: string | null,

  docs: {
    [widgetId: string]: {
      doc: { misc, elements, sources, features },
      history: { past: [], future: [] },
      dirty: boolean,                 // true when doc differs from last-saved baseline
      lastSavedHash: string | null,   // JSON.stringify snapshot at last save
    }
  },

  // ...mutation actions (scoped to focusedDocId)
  // ...lifecycle actions (openDoc, closeDoc, switchFocus, newDoc, markClean)
  // ...selector helpers (exported as named functions)
}
```

### Key properties

| Property | Purpose |
|---|---|
| `focusedDocId` | The widget currently visible in the editor. All mutation actions operate on this document. |
| `docs` | Normalized map keyed by widget ID. Each entry owns its doc, history, and dirty state. |
| `dirty` | Per-widget flag indicating unsaved changes. Set by mutations and cleared by save. |
| `lastSavedHash` | Serialized snapshot at last save. Used by both auto-save and manual save to skip redundant writes — the single source of truth for "has it changed?". |


## Selector Helpers

All consumers access state through these selector helpers instead of deep-path access.
This is enforced by `ENGINEERING_CONSTRAINTS.md` §9.

### Fallback constants

Selectors return frozen empty objects when no doc is focused (e.g. app startup before any
widget is loaded). These are defined at module scope in `docStore.js`:

```js
const EMPTY_DOC = Object.freeze({ misc: {}, elements: [], sources: [], features: {} });
const EMPTY_HISTORY = Object.freeze({ past: [], future: [] });
```

They are module-level singletons so Zustand's `===` equality check returns the same
reference on every call when unfocused, preventing infinite re-renders.

```js
// ── Focused document (the common case — used by 95% of consumers) ────

/** Returns the focused doc object, or a frozen empty doc if nothing focused. */
export const selectFocusedDoc = (state) =>
  state.focusedDocId ? state.docs[state.focusedDocId]?.doc ?? EMPTY_DOC : EMPTY_DOC;

/** Returns the focused doc's history { past, future }. */
export const selectFocusedHistory = (state) =>
  state.focusedDocId ? state.docs[state.focusedDocId]?.history ?? EMPTY_HISTORY : EMPTY_HISTORY;

/** Returns the focused doc's elements array. */
export const selectFocusedElements = (state) =>
  selectFocusedDoc(state).elements;

/** Returns the focused doc's misc object. */
export const selectFocusedMisc = (state) =>
  selectFocusedDoc(state).misc;

/** Returns the focused widget's sources, delegating to the shared pool so a
 *  fullscreen companion sees its primary's sources. */
export const selectFocusedSources = (state) =>
  selectSharedSources(state);

/** Returns the focused doc's features object. */
export const selectFocusedFeatures = (state) =>
  selectFocusedDoc(state).features;


// ── Workspace-level selectors ────────────────────────────────────────

/** Returns the focused widget ID. */
export const selectFocusedDocId = (state) => state.focusedDocId;

/** Returns the primary doc paired with the focused widget/companion. */
export const selectFocusedPrimaryDoc = (state) => /* ... */;

/** Returns the fullscreen companion doc paired with the focused widget. */
export const selectFocusedCompanionDoc = (state) => /* ... */;

/** Returns array of all open widget IDs. */
export const selectOpenDocIds = (state) => Object.keys(state.docs);

/** Returns true if ANY open doc has unsaved changes. */
export const selectHasUnsavedChanges = (state) =>
  Object.values(state.docs).some((entry) => entry.dirty);
```

### Companion-ID convention

A widget MAY have an optional **fullscreen companion** payload locked to grid
`3x2`. The companion is stored as a sibling entry under the synthetic ID
`<widgetId>::fullscreen` (e.g. `widget_aa11_bb22::fullscreen`). Helpers in
`store/companionId.js`:

- `FULLSCREEN_SUFFIX` — the literal `'::fullscreen'`.
- `fullscreenIdFor(primaryId)` — returns `${primaryId}${FULLSCREEN_SUFFIX}`.
- `isFullscreenId(id)` — returns true iff `id` ends with the suffix.
- `primaryIdOf(id)` — strips the suffix (returns `id` unchanged for primaries).

The synthetic ID is **builder-internal only**: the suffix never appears in
runtime payload JSON, on disk, or in any network message. The server
round-trips the companion as a sibling field `WidgetDoc.fullscreen`, not as a
second widget.

Companion-aware selectors (also in `docStore.js`):

```js
/** Returns the companion doc ID for the focused widget, or null. */
export const selectCompanionDocId = (state) => /* ... */;

/** Returns the companion's elements array, or a frozen empty array. */
export const selectCompanionElements = (state) => /* ... */;
```

### Shared source pool

A widget's primary view and its optional fullscreen companion share **one**
source pool, physically stored on the **primary** entry's `doc.sources`. The
companion is optional (it may be absent or created later), so it can never host
the canonical pool — its own `doc.sources` is kept empty once unified. A source
added, edited, or deleted on either screen is therefore immediately visible and
editable on the other.

**Read side.** `selectSharedSources(state)` resolves the pool from
`state.docs[primaryIdOf(focusedDocId)]?.doc?.sources`, falling back to the frozen
`EMPTY_DOC.sources`. The general-purpose `selectFocusedSources` delegates straight
to it, so every source-consuming UI (`SourcesPanel`, `BindingExpressionEditor`,
`ValueEditor`, `GraphInspectorPanel`, …) reads the same array on both screens with
no per-component branching.

**Write side.** `addSource`, `updateSource`, and `removeSource` scope to the
primary via `getPrimaryEntryFor(state)` (which applies `primaryIdOf` to the focused
ID) instead of `getFocusedEntry`. They record history and set `dirty` on the
primary, then call `markCompanionDirty(state)` so the companion's auto-save
re-exports its merged payload. The inline JSON editor (`replaceDocFromJson`)
follows the same rule: editing a *companion's* JSON routes its `sources` onto the
primary pool and leaves the companion's own array empty.

**Cap.** `MAX_SOURCES = 500` mirrors the server's `MAX_SOURCES` in `src/limits.ts`
(applied by `src/schema/payloadSchema.ts`). The two install trees share no code, so
the constants are kept in sync by hand — change both together. The cap is enforced
on `addSource`, on JSON edits, and on the migration fold below, so the shared pool
can never grow past what either slot's export accepts — an over-cap pool would `400`
on save. Over-cap attempts are refused and surfaced via `console`, never applied
silently. Both `MAX_SOURCES` and `SOURCE_WARN_THRESHOLD` are exported from
`docStore.js`; nothing should re-declare either number.

**Warn threshold.** `SOURCE_WARN_THRESHOLD = 50` is advisory, not a limit. When an
add would take a widget past it, `SourcesPanel` shows a one-button notice
(`noticeStore.showNotice`) explaining that a pool this large can slow saves and
screen refreshes on low-power hardware. The store is not involved: `addSource`
neither checks the threshold nor blocks the add — the source is added either way.
The "already warned" flag lives on `uiStore.sourceWarnAcknowledged`, keyed by
PRIMARY doc ID so a widget and its companion share one warning, and is session-only
(never serialized).

**Legacy migration.** Older widgets could store independent sources on each slot.
`mergeCompanionSourcesIntoPrimary(widgetId)` folds a companion's own sources onto
the primary via `mergeInheritedSources` (a companion-own source whose `id` matches
an inherited one **wins**), then empties the companion array. It is idempotent — a
re-fold of an already-unified pool is a no-op — and dirties the primary **only** on
a real change, compared with an order-independent `sourcePoolFingerprint` so a pure
reorder or a clean load never triggers a spurious auto-save. If the fold would
exceed `MAX_SOURCES`, it is skipped (the widget stays in its valid legacy shape,
each slot within the cap) and the problem is logged.

### Consumer access pattern

Components subscribe through the selector helpers rather than deep-path access:

```js
import { selectFocusedElements } from '../store/docStore.js';
const elements = useDocStore(selectFocusedElements);
```

Non-React platform code reads through the imperative accessors `getFocusedDoc()`, which
returns the frozen `EMPTY_DOC` fallback when no doc is focused, and `getDocById(widgetId)`,
which returns `null` when the widget ID is unknown.


## Mutation Scoping

Most mutation actions (`updateElement`, `addElement`, `removeElement`, `updateMisc`,
`addFeature`, `updateFeature`, `removeFeature`, `setFeatureValue`, `reorderElements`,
`undo`, `redo`, etc.):

1. **Operate on `state.docs[state.focusedDocId]`** via the `getFocusedEntry(state)` helper,
   never on a top-level `state.doc`.
2. **No-op if `focusedDocId` is null** or the entry doesn't exist.
3. **Record history** into the per-widget `history` object (not a shared one).
4. **Set `dirty = true`** on the entry after mutation.

> **Source CRUD is the exception.** `addSource`, `updateSource`, and `removeSource`
> scope to the **primary** entry via `getPrimaryEntryFor(state)` (not `getFocusedEntry`),
> so an edit made while a fullscreen companion is focused still mutates the one shared
> pool. They record history and `dirty` on the primary and additionally call
> `markCompanionDirty(state)` so auto-save re-exports the companion. See
> **Shared source pool** above.

Internal helper pattern:

```js
function getFocusedEntry(state) {
  return state.focusedDocId ? state.docs[state.focusedDocId] ?? null : null;
}

// In a mutation action:
const entry = getFocusedEntry(state);
if (!entry) return;
recordHistory(entry);   // pushes a snapshot onto entry.history.past
// ...mutate entry.doc...
entry.dirty = true;
```

Supporting helpers operate on the entry or doc object directly:

- `recordHistory(entry)` — reads `entry.doc` and pushes onto `entry.history.past`.
- `cloneDoc(doc)` — deep-clones a doc via Immer `current(doc)`.
- `normalizeDoc(doc, screenSize)` — derives `doc.misc.size` from `doc.misc.gridSize` and the passed-in screen size. Callers resolve the size with `screenSizeForDocId(docId)`, which returns a fixed 3x2 screen size for fullscreen companion IDs and `getDisplayConfig().getScreenSize()` otherwise.
- `refreshSize()` — re-normalizes the focused doc's size; does **not** set `dirty` (size is derived, not a user edit).


## Lifecycle Actions

These manage the docs map and are called by the platform layer (widgetStore, auto-save):

| Action | Purpose |
|---|---|
| `openDoc(widgetId, json)` | Parse JSON via `importRuntimeJson()`, create entry in `docs[widgetId]` with empty history and `dirty: false`. Re-opening replaces the doc and resets history. Also calls `getDisplayConfig().confirmGridSize()` (the loaded widget already has a confirmed grid). |
| `closeDoc(widgetId)` | Remove entry from `docs[widgetId]`. If it was focused, set `focusedDocId` to another open doc or `null`. |
| `switchFocus(widgetId)` | Set `focusedDocId = widgetId`. No-op if widgetId not in docs. Does NOT flush auto-save — that is the platform layer's responsibility. |
| `newDoc(widgetId)` | Create entry with `createNewDocument(screenSizeForDocId(widgetId))` (a fixed 3x2 screen size for fullscreen companion IDs, otherwise `getDisplayConfig().getScreenSize()`). Does NOT change focus — the caller calls `switchFocus()` separately. Also calls `getDisplayConfig().resetGridSizeConfirmation()` so the grid selector shows for the new widget. |
| `markClean(widgetId, hash)` | Set `dirty = false` and store the saved snapshot in `lastSavedHash`. Called after a successful save. |

New widgets are first created under the temporary ID `PENDING_DOC_ID` (`'__pending'`,
exported from docStore) while the grid selector is shown; once the server assigns a real
widget ID the doc is copied to that ID via `openDoc` and the temporary entry is removed via
`closeDoc('__pending')`, so `docs` never retains stale temporary keys.


## Save Pipeline Rules

The save pipeline is a **platform concern** (lives in `builder/src/platform/`), but it reads
docStore state. These rules keep auto-save and manual save from stepping on each other:

1. **Single dirty-tracking source of truth.** The `dirty` flag and `lastSavedHash` in each
   doc entry are read and written by both auto-save and manual save.

2. **Manual save updates the baseline.** After `widgetStore.saveCurrentWidget()` succeeds it
   calls `docStore.markClean(widgetId, hash)` with the serialized snapshot, preventing
   auto-save from re-saving an already-saved doc. (Auto-save calls `markClean` the same way.)

3. **Per-widget auto-save debounce.** The auto-save hook keeps a per-widget debounce timer
   keyed by widget ID, not a single global timer. When the user switches widgets, the old
   widget's timer continues independently and can save by reading `docs[oldId].doc`.

4. **Export via mapper.** Saving always serializes via `exportRuntimeJson(doc)` from
   `builder/src/models/mapper.js`. There is no alternative export path.

5. **writeIfChanged on server.** The server's `writeWidget` uses `Buffer.equals()` to skip
   no-op writes. The client-side dirty flag is an optimization to avoid unnecessary network
   calls; the server is the final safety net.


## Workspace State vs Document State

| Category | Examples | Where it lives | Serialized? |
|---|---|---|---|
| **Document** | elements, sources, features, misc (grid, size, tags) | `docs[id].doc` | YES — this IS the widget payload |
| **Document-session** | undo/redo history, dirty flag, lastSavedHash | `docs[id].history`, `docs[id].dirty` | NO — session only |
| **Workspace** | focusedDocId, set of open doc IDs | `docStore.focusedDocId`, `docStore.docs` keys | NO — session only |
| **UI** | selectedElementId, panX/Y, zoom, toolMode | `uiStore` | NO — session only |
| **Platform** | activeWidgetId, widget list, auto-save toggle | `widgetStore`, `autoSaveStore` | Partial (auto-save toggle in localStorage) |

**Rule:** Only `docs[id].doc` is serialized into the widget JSON payload. Everything else is
session-only state that is lost on page reload. `focusedDocId` and the open doc set MUST NOT
appear in any exported payload.
