import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

// ── Infinite canvas viewport defaults ────────────────────────────────
const DEFAULT_VIEWPORT = Object.freeze({ panX: 0, panY: 0, zoom: 1 });

// ── Defaults for the preview overlay on the infinite canvas ──
const DEFAULT_PREVIEW_OVERLAY = {
  enabled: false,
  x: 0,
  y: 160, // Below artboard by default (will be repositioned on first enable)
  width: 0, // 0 = use artboard width (auto-sized on first enable)
  height: 0,
  showDeviceFrame: false,
};

export const useUiStore = create(
  immer((set, get) => ({
    // Primary multi-select state — array of selected element IDs.
    selectedElementIds: [],

    // Derived convenience field — first selected element (backwards compat).
    selectedElementId: null,

    selectedSourceId: null,

    // Internal clipboard for copy/paste element operations.
    clipboard: [],

    // Editor-only lock state — tracks which elements are locked (non-draggable).
    // Shape: { [elementId]: true }. Missing key = unlocked.
    // Lives in uiStore (not the doc model) per Engineering constraint §9.
    lockedElementIds: {},

    // Editor-only cache of last tested source responses.
    // Shape: { [sourceId]: { receivedAt: string, responseType: string, data: any } }
    sourceResponsesById: {},

    // Widgets that have already seen the "that's a lot of data sources" notice
    // this session, keyed by PRIMARY doc ID (the shared source pool's home) so a
    // companion doesn't get its own entry. Shape: { [primaryDocId]: true }.
    // Editor-only and flat per Engineering constraint §10 — never serialized
    // into a payload (§8).
    sourceWarnAcknowledged: {},

    // Transient queue depth for the source-test throttler (Task 6).
    // Sum of pending + in-flight source tests. Surfaced here so a future
    // status pill can read it; never persisted into the document payload.
    pendingSourceTests: 0,

    // Platform-injected handler for testing sources against the server.
    // Set by the platform layer on init; null when running standalone.
    sourceTestHandler: null,

    // Platform-injected handler for rendering preview images.
    // Signature: (payload) => Promise<{ renderTime?: string }>
    previewRenderer: null,

    // Platform-injected handler for expanding payload (graph expansion + source resolution).
    // Signature: (payload) => Promise<object>
    payloadExpander: null,

    // Platform-injected function to get the preview image URL.
    // Signature: () => string
    previewImageUrlGetter: null,

    // Platform-injected provider for the HA host's LAN IP. Set by the platform
    // layer on init; null when running standalone or non-HA. Core panels read
    // this to show the ESP32 device endpoint URL only when it can be resolved.
    // Signature: () => Promise<{ ip: string|null, candidates: Array<{ interface, ip, primary }> }>
    hostInfoProvider: null,

    // Platform-injected handler for the guided self-host `/config` push. Set by
    // the platform layer on init; null when running standalone (no add-on
    // backend). The Self-Host setup dialog reads this and only enables "Send"
    // when it is non-null. Mirrors sourceTestHandler / hostInfoProvider.
    // Signature: ({deviceIp, config}) => Promise<{ok,status,configured?,body?}>
    deviceConfigPusher: null,

    // Resolved HA host LAN IP and the host port the ESP32 image endpoint is
    // mapped to (config.yaml `ports: 8000/tcp`, remappable in the add-on
    // Network settings). Both null when unavailable / not yet fetched.
    // Populated once on app init from `hostInfoProvider`. The TopBar reads
    // these to show the always-visible "http://<ip>:<port>" device endpoint.
    hostIp: null,
    hostPort: null,

    // Latest non-deploy preview image URLs, keyed by render slot. These are
    // browser object URLs generated from `POST /render` responses and are
    // intentionally separate from deployed `/image*.png` cache artifacts.
    previewImageUrls: { primary: null, fullscreen: null },

    // Platform-injected callback that opens the user-asset picker modal.
    // Signature: (onSelect: (token: string) => void) => void
    // Set by the AssetPickerProvider on the HA platform; null on builds
    // without an asset store. Core Inspector panels render the "import"
    // button only when this is non-null (Engineering constraint §11 — platform injects
    // into core via uiStore callbacks).
    openAssetPicker: null,

    // Platform-injected resolver mapping a user-asset FILENAME to its
    // authenticated raw-bytes URL (`GET /api/assets/<filename>/raw`). Set by the
    // AssetPickerProvider on the HA platform; null on builds without an asset
    // store. The canvas preview uses it to display custom uploaded SVG/image
    // assets, whose payload `src` is an `asset:<filename>` token the browser
    // cannot load directly (Engineering constraint §11 — platform injects into
    // core via uiStore callbacks). Signature: (filename: string) => string
    assetUrlResolver: null,

    // Timestamp of last successful render (used to coordinate TopBar ⟳ with PreviewTab).
    lastRenderAt: null,

    // Per-element render errors (e.g. SVG too large, fetch timeout) returned
    // by the most recent render. Stored centrally so every refresh trigger
    // (PreviewTab ⟳, TopBar ⟳) updates the same source of truth instead of
    // each component holding a fragile local copy.
    lastRenderWarnings: null,

    leftPanelTab: 'Widget',
    leftPanelWidth: 280,
    leftPanelCollapsed: false,

    rightPanelTab: 'Layers',
    rightPanelWidth: 300,
    rightPanelCollapsed: false,

    // Tracks whether panels were auto-collapsed due to narrow viewport.
    // When true, widening the viewport restores the panels to their
    // pre-collapse state stored in _savedPanelState.
    panelsAutoCollapsed: false,
    _savedPanelState: null,

    toolMode: 'select',

    snapping: {
      snapEnabled: true,
      gridStep: 10,
      snapToElements: false,
    },

    showGrid: false,

    // ── Infinite canvas viewport state ──
    // Single shared pan/zoom. The fullscreen companion (if present) is
    // edited on the same canvas — the user switches between primary and
    // companion via the slot tab in CanvasToolbox.
    viewport: { ...DEFAULT_VIEWPORT },

    // Whether the user is currently panning (Space held or middle-click).
    isPanning: false,

    // ── Preview overlay on the infinite canvas ──
    previewOverlay: { ...DEFAULT_PREVIEW_OVERLAY },

    jsonFullscreen: false,

    // ── App screen state ──
    // Persisted in the store (not component state) so window resize
    // cannot accidentally reinitialize it back to 'welcome'.
    appScreen: 'welcome', // 'welcome' | 'gridSelect' | 'setupMode' | 'editor'

    setAppScreen(screen) {
      set((state) => {
        state.appScreen = screen;
      });
    },

    setSelectedElementId(id) {
      set((state) => {
        state.selectedElementId = id;
        state.selectedElementIds = id ? [id] : [];
      });
    },

    /** Replace the entire selection with a set of IDs. */
    setSelectedElementIds(ids) {
      set((state) => {
        state.selectedElementIds = ids ?? [];
        state.selectedElementId = ids?.[0] ?? null;
      });
    },

    /** Add an element to the current selection (Shift/Ctrl+click). */
    addToSelection(id) {
      set((state) => {
        if (!id || state.selectedElementIds.includes(id)) return;
        state.selectedElementIds.push(id);
        if (!state.selectedElementId) state.selectedElementId = id;
      });
    },

    /** Remove an element from the current selection (Shift/Ctrl+click on selected). */
    removeFromSelection(id) {
      set((state) => {
        state.selectedElementIds = state.selectedElementIds.filter((x) => x !== id);
        state.selectedElementId = state.selectedElementIds[0] ?? null;
      });
    },

    /** Toggle an element in/out of the selection. */
    toggleInSelection(id) {
      const s = get();
      if (s.selectedElementIds.includes(id)) {
        s.removeFromSelection(id);
      } else {
        s.addToSelection(id);
      }
    },

    /** Clear the entire selection. */
    clearSelection() {
      set((state) => {
        state.selectedElementIds = [];
        state.selectedElementId = null;
      });
    },

    /** Store deep-cloned elements for copy/paste. */
    copyToClipboard(elementTemplates) {
      set((state) => {
        state.clipboard = elementTemplates ?? [];
      });
    },

    setSelectedSourceId(selectedSourceId) {
      set((state) => {
        state.selectedSourceId = selectedSourceId;
      });
    },

    /** Toggle lock state for an element. */
    toggleElementLock(elementId) {
      set((state) => {
        if (state.lockedElementIds[elementId]) {
          delete state.lockedElementIds[elementId];
        } else {
          state.lockedElementIds[elementId] = true;
        }
      });
    },

    /** Check if an element is locked. */
    isElementLocked(elementId) {
      return !!get().lockedElementIds[elementId];
    },

    setSourceResponse(sourceId, entry) {
      set((state) => {
        if (!sourceId) return;
        if (!entry || typeof entry !== 'object') return;
        state.sourceResponsesById[sourceId] = entry;
      });
    },

    clearSourceResponse(sourceId) {
      set((state) => {
        if (!sourceId) return;
        delete state.sourceResponsesById[sourceId];
      });
    },

    /** Mark a widget as having seen the many-sources notice (by primary doc ID). */
    acknowledgeSourceWarn(primaryDocId) {
      set((state) => {
        if (!primaryDocId) return;
        state.sourceWarnAcknowledged[primaryDocId] = true;
      });
    },

    /**
     * Set the transient pending-source-test counter. Called by the
     * source-test throttler whenever the queue depth changes. Coerces
     * to a finite integer ≥ 0 so a stale call cannot poison UI.
     */
    setPendingSourceTests(count) {
      set((state) => {
        const n = Number(count);
        state.pendingSourceTests = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
      });
    },

    setToolMode(toolMode) {
      set((state) => {
        state.toolMode = toolMode;
      });
    },

    updateSnapping(patch) {
      set((state) => {
        if (!patch || typeof patch !== 'object') return;
        Object.assign(state.snapping, patch);
      });
    },

    setZoom(zoom) {
      set((state) => {
        state.viewport.zoom = Math.max(0.1, Math.min(5, zoom));
      });
    },

    setShowGrid(showGrid) {
      set((state) => {
        state.showGrid = showGrid;
      });
    },

    setJsonFullscreen(jsonFullscreen) {
      set((state) => {
        state.jsonFullscreen = jsonFullscreen;
      });
    },

    toggleJsonFullscreen() {
      set((state) => {
        state.jsonFullscreen = !state.jsonFullscreen;
      });
    },

    setRightPanelTab(rightPanelTab) {
      set((state) => {
        state.rightPanelTab = rightPanelTab;
      });
    },

    setLeftPanelTab(leftPanelTab) {
      set((state) => {
        state.leftPanelTab = leftPanelTab;
      });
    },

    /** Set left panel width, clamped between minimum and half the viewport. */
    setLeftPanelWidth(width) {
      set((state) => {
        state.leftPanelWidth = Math.max(280, Math.round(width));
      });
    },

    toggleLeftPanelCollapsed() {
      set((state) => {
        state.leftPanelCollapsed = !state.leftPanelCollapsed;
        // Manual toggle overrides auto-collapse — clear saved state so
        // auto-restore doesn't revert the user's explicit action.
        if (state.panelsAutoCollapsed) {
          state.panelsAutoCollapsed = false;
          state._savedPanelState = null;
        }
      });
    },

    /** Set right panel width, clamped between minimum and half the viewport. */
    setRightPanelWidth(width) {
      set((state) => {
        state.rightPanelWidth = Math.max(300, Math.round(width));
      });
    },

    toggleRightPanelCollapsed() {
      set((state) => {
        state.rightPanelCollapsed = !state.rightPanelCollapsed;
        // Manual toggle overrides auto-collapse — clear saved state so
        // auto-restore doesn't revert the user's explicit action.
        if (state.panelsAutoCollapsed) {
          state.panelsAutoCollapsed = false;
          state._savedPanelState = null;
        }
      });
    },

    /** Auto-collapse both panels when viewport is narrow. */
    autoCollapsePanels() {
      set((state) => {
        if (state.panelsAutoCollapsed) return;
        state._savedPanelState = {
          left: state.leftPanelCollapsed,
          right: state.rightPanelCollapsed,
        };
        state.leftPanelCollapsed = true;
        state.rightPanelCollapsed = true;
        state.panelsAutoCollapsed = true;
      });
    },

    /** Restore panels when viewport is wide enough again. */
    autoRestorePanels() {
      set((state) => {
        if (!state.panelsAutoCollapsed) return;
        const saved = state._savedPanelState;
        if (saved) {
          state.leftPanelCollapsed = saved.left;
          state.rightPanelCollapsed = saved.right;
        }
        state._savedPanelState = null;
        state.panelsAutoCollapsed = false;
      });
    },

    /** Set the platform-specific source test handler. Called by platform layer on init. */
    setSourceTestHandler(handler) {
      set((state) => {
        state.sourceTestHandler = handler;
      });
    },

    /** Set the platform-specific preview renderer. Called by platform layer on init. */
    setPreviewRenderer(handler) {
      set((state) => {
        state.previewRenderer = handler;
      });
    },

    /** Set the platform-specific payload expander. Called by platform layer on init. */
    setPayloadExpander(handler) {
      set((state) => {
        state.payloadExpander = handler;
      });
    },

    /** Set the platform-specific preview image URL getter. Called by platform layer on init. */
    setPreviewImageUrlGetter(getter) {
      set((state) => {
        state.previewImageUrlGetter = getter;
      });
    },

    /** Set the platform-specific host-IP provider. Called by platform layer on init. */
    setHostInfoProvider(provider) {
      set((state) => {
        state.hostInfoProvider = provider;
      });
    },

    /** Set the platform-specific device-config pusher. Called by platform layer on init. */
    setDeviceConfigPusher(handler) {
      set((state) => {
        state.deviceConfigPusher = handler;
      });
    },

    /** Store the resolved HA host LAN IP and image host port (null when unavailable). */
    setHostEndpoint(ip, port) {
      set((state) => {
        state.hostIp = ip;
        state.hostPort = port;
      });
    },

    /** Store the latest non-deploy preview image URL for a render slot. */
    setPreviewImageUrl(slot, url) {
      set((state) => {
        const key = slot === 'fullscreen' ? 'fullscreen' : 'primary';
        state.previewImageUrls[key] = url ?? null;
      });
    },

    /**
     * Register the platform's asset-picker opener. Called once by
     * AssetPickerProvider on mount; cleared on unmount. Pass null to
     * disable the picker (e.g. on platforms without an asset store).
     */
    setOpenAssetPicker(fn) {
      set((state) => {
        state.openAssetPicker = fn;
      });
    },

    /**
     * Register the platform's asset raw-URL resolver. Called once by
     * AssetPickerProvider on mount; cleared on unmount. Pass null to disable
     * (builds without an asset store leave `asset:` tokens unresolved, so the
     * canvas shows the load-failed placeholder as before).
     */
    setAssetUrlResolver(fn) {
      set((state) => {
        state.assetUrlResolver = fn;
      });
    },

    // Platform-injected HA entity catalog store reference.
    // Set by the platform layer on init; null when running standalone or non-HA.
    // Core panels check this to conditionally render HA entity features.
    entityCatalogStore: null,

    // Platform-injected source field renderers keyed by source kind.
    // Shape: { [kind]: Component }. Core SourcesPanel looks up renderers
    // dynamically so it never imports platform modules directly.
    sourceFieldRenderers: {},

    /** Set the HA entity catalog store. Called by platform layer on init. */
    setEntityCatalogStore(store) {
      set((state) => {
        state.entityCatalogStore = store;
      });
    },

    /** Register a source field renderer for a given source kind. Called by platform layer on init. */
    setSourceFieldRenderer(kind, component) {
      set((state) => {
        state.sourceFieldRenderers[kind] = component;
      });
    },

    // Whether bitmap font packs have been loaded by the platform layer.
    bitmapFontsLoaded: false,

    /** Signal that bitmap fonts are loaded. Called by platform layer after loadBitmapFonts(). */
    setBitmapFontsLoaded(loaded) {
      set((state) => {
        state.bitmapFontsLoaded = loaded;
      });
    },

    // ── Fullscreen-companion handlers ────────────
    // Platform-injected handlers that create / delete the fullscreen
    // companion for the given widget id. Set by widgetStore on init; null
    // when running in core-only contexts. CanvasToolbox dispatches via
    // these so core stays platform-agnostic (mirrors sourceTestHandler /
    // previewRenderer).
    ensureFullscreenCompanionHandler: null,
    deleteFullscreenCompanionHandler: null,

    /** Register the platform's fullscreen-companion ensure handler. */
    setEnsureFullscreenCompanionHandler(handler) {
      set((state) => {
        state.ensureFullscreenCompanionHandler = handler;
      });
    },

    /** Register the platform's fullscreen-companion delete handler. */
    setDeleteFullscreenCompanionHandler(handler) {
      set((state) => {
        state.deleteFullscreenCompanionHandler = handler;
      });
    },

    /**
     * Signal that a render completed. Bumps `lastRenderAt` and replaces
     * `lastRenderWarnings` with the supplied list (pass `null`/`undefined`
     * to clear). Called by every refresh path so PreviewTab can show the
     * latest warnings regardless of which component triggered the render.
     */
    notifyRenderComplete(warnings) {
      set((state) => {
        state.lastRenderAt = Date.now();
        state.lastRenderWarnings =
          Array.isArray(warnings) && warnings.length > 0 ? warnings : null;
      });
    },

    // ── Infinite canvas viewport actions ──

    /** Shift the viewport pan by a delta (used during drag/wheel). */
    panBy(dx, dy) {
      set((state) => {
        state.viewport.panX += dx;
        state.viewport.panY += dy;
      });
    },

    setIsPanning(isPanning) {
      set((state) => {
        state.isPanning = isPanning;
      });
    },

    /**
     * Zoom the viewport toward a point in screen coordinates.
     * Keeps the world point under the cursor stationary.
     */
    zoomAtPoint(newZoom, screenX, screenY) {
      set((state) => {
        const vp = state.viewport;
        const clamped = Math.max(0.1, Math.min(5, newZoom));
        const oldZoom = vp.zoom;

        // World point under cursor before zoom
        const worldX = (screenX - vp.panX) / oldZoom;
        const worldY = (screenY - vp.panY) / oldZoom;

        // Adjust pan so the same world point stays under cursor
        vp.panX = screenX - worldX * clamped;
        vp.panY = screenY - worldY * clamped;
        vp.zoom = clamped;
      });
    },

    /**
     * Reset pan/zoom so the artboard is centered in the given viewport.
     * @param {number} viewportWidth  — available pixel width of canvas-area
     * @param {number} viewportHeight — available pixel height of canvas-area
     * @param {number} artboardWidth  — pixel width of the artboard
     * @param {number} artboardHeight — pixel height of the artboard
     */
    recenter(viewportWidth, viewportHeight, artboardWidth, artboardHeight) {
      set((state) => {
        const vp = state.viewport;
        const padding = 60; // px breathing room
        const scaleX = (viewportWidth - padding * 2) / artboardWidth;
        const scaleY = (viewportHeight - padding * 2) / artboardHeight;
        const fitZoom = Math.max(0.1, Math.min(5, Math.min(scaleX, scaleY, 2)));

        vp.zoom = fitZoom;
        vp.panX = (viewportWidth - artboardWidth * fitZoom) / 2;
        vp.panY = (viewportHeight - artboardHeight * fitZoom) / 2;
      });
    },

    // ── Preview overlay actions ──

    updatePreviewOverlay(patch) {
      set((state) => {
        if (!patch || typeof patch !== 'object') return;
        Object.assign(state.previewOverlay, patch);
      });
    },

    togglePreviewOverlay() {
      set((state) => {
        state.previewOverlay.enabled = !state.previewOverlay.enabled;
      });
    },
  })),
);
