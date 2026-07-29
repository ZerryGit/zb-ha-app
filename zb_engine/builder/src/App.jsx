import { useCallback, useEffect, useRef, useState } from 'react';
import CanvasArea from './editor/CanvasArea.jsx';
import LeftPanel from './panels/LeftPanel.jsx';
import RightPanel from './panels/RightPanel.jsx';
import PanelResizeHandle from './components/PanelResizeHandle.jsx';
import TopBar from './platform/TopBar.jsx';
import WelcomeScreen from './platform/WelcomeScreen.jsx';
import AssetPickerProvider from './platform/AssetPickerProvider.jsx';
import GridSizeSelector from './components/GridSizeSelector.jsx';
import SetupModeScreen from './components/SetupModeScreen.jsx';
import NoticeModal from './components/NoticeModal.jsx';
import { testSource, renderPreview, getPreviewImageUrl, expandPayload, loadBitmapFonts, fetchHostIp, pushDeviceConfig } from './platform/apiClient.js';
import { useEntityStore } from './platform/entityStore.js';
import HaStateSourceFields from './platform/HaStateSourceFields.jsx';
import HaHistorySourceFields from './platform/HaHistorySourceFields.jsx';
import { useUiStore } from './store/uiStore.js';
import { useDisplayConfigStore } from './store/displayConfigStore.js';
import { useWidgetStore } from './platform/widgetStore.js';
import { useDocStore, selectFocusedMisc, getFocusedDoc, getInheritedPrimarySources, PENDING_DOC_ID } from './store/docStore.js';
import { isFullscreenId } from './store/companionId.js';
import { exportRuntimeJson } from './models/mapper.js';

function revokeObjectUrl(url) {
  if (!url || !url.startsWith('blob:')) return;
  globalThis.URL?.revokeObjectURL?.(url);
}

function rememberPreviewImageUrl(slot, url) {
  const key = slot === 'fullscreen' ? 'fullscreen' : 'primary';
  const store = useUiStore.getState();
  const previous = store.previewImageUrls?.[key];
  if (previous && previous !== url) revokeObjectUrl(previous);
  store.setPreviewImageUrl(key, url);
}

function latestPreviewImageUrl(slot = 'primary') {
  const key = slot === 'fullscreen' ? 'fullscreen' : 'primary';
  return useUiStore.getState().previewImageUrls?.[key] || getPreviewImageUrl(key);
}

/** Wraps renderPreview to return a result object matching the store contract. */
async function previewRenderer(payload, opts) {
  const slot = opts?.slot === 'fullscreen' ? 'fullscreen' : 'primary';
  const res = await renderPreview(payload, opts);
  const renderTime = res.headers.get('X-Render-Time') || undefined;

  // Decode per-element render errors (e.g. SVG too large, timeout) so the
  // builder can surface them as warnings without hiding the rendered image.
  // The header is server-controlled, but we still validate the decoded shape
  // defensively to avoid rendering unexpected objects in the warnings UI.
  let renderWarnings;
  const errHeader = res.headers.get('X-Render-Errors');
  if (errHeader) {
    try {
      const decoded = JSON.parse(atob(errHeader));
      if (Array.isArray(decoded)) {
        renderWarnings = decoded
          .filter((entry) => typeof entry === 'string')
          .slice(0, 50);
        if (renderWarnings.length === 0) {
          renderWarnings = ['Render completed with one or more element errors.'];
        }
      } else {
        renderWarnings = ['Render completed with one or more element errors.'];
      }
    } catch {
      renderWarnings = ['Render completed with one or more element errors.'];
    }
  }

  let imageUrl;
  const blob = await res.blob();
  if (globalThis.URL?.createObjectURL) {
    imageUrl = globalThis.URL.createObjectURL(blob);
    rememberPreviewImageUrl(slot, imageUrl);
  }

  return { renderTime, renderWarnings, imageUrl };
}

/**
 * App startup flow:
 *   1. WelcomeScreen — choose existing widget or "New Widget"
 *   2. GridSizeSelector — pick canvas size (only for new widgets)
 *   3. SetupModeScreen — "How do you want to set up?" (only for new widgets)
 *   4. Editor — full canvas + panels
 *
 * Opening an existing widget skips the grid selector AND the setup-mode screen
 * because the size is already defined in the saved document.
 */

/** Screen state: 'welcome' → 'gridSelect' → 'setupMode' → 'editor' */
const SCREEN_WELCOME = 'welcome';
const SCREEN_GRID_SELECT = 'gridSelect';
const SCREEN_SETUP_MODE = 'setupMode';
const SCREEN_EDITOR = 'editor';

function App() {
  // Screen state lives in uiStore so window resize cannot reinitialize it.
  const screen = useUiStore((s) => s.appScreen);
  const setScreen = useUiStore((s) => s.setAppScreen);
  const [pendingWidgetName, setPendingWidgetName] = useState('');

  // Inject platform-specific handlers into the core stores on mount.
  // This keeps core panels platform-agnostic (store injection pattern).
  useEffect(() => {
    const store = useUiStore.getState();
    store.setSourceTestHandler(testSource);
    store.setPreviewRenderer(previewRenderer);
    store.setPayloadExpander(expandPayload);
    store.setPreviewImageUrlGetter(latestPreviewImageUrl);

    // Provide the HA host-IP lookup so the Settings tab can show the ESP32
    // device endpoint URL. Injected (not imported by core) so the panel stays
    // platform-agnostic — mirrors the source-test / preview handlers above.
    store.setHostInfoProvider(fetchHostIp);

    // Provide the guided self-host `/config` push proxy so the Self-Host setup
    // dialog can POST to a LAN device through the add-on backend. Injected (not
    // imported by core) so the dialog stays platform-agnostic and disables
    // "Send" when this is absent (standalone / non-HA build).
    store.setDeviceConfigPusher(pushDeviceConfig);

    // Resolve the host IP + image host port once on init so the TopBar can
    // always show the "http://<ip>:<port>" device endpoint. Fire-and-forget:
    // when running outside Home Assistant the lookup fails (no Supervisor
    // token) and the readout stays hidden until a real IP can be resolved.
    Promise.resolve(fetchHostIp())
      .then((res) => store.setHostEndpoint(res?.ip || null, res?.port || null))
      .catch(() => store.setHostEndpoint(null, null));

    // Inject the HA entity catalog store so core panels can conditionally
    // render entity browsing features when running as an HA add-on.
    store.setEntityCatalogStore(useEntityStore);

    // Register HA-specific source field renderers (platform → core injection).
    store.setSourceFieldRenderer('haState', HaStateSourceFields);
    store.setSourceFieldRenderer('haHistory', HaHistorySourceFields);

    // Kick off background entity loading — non-blocking, builder is usable
    // immediately while the entity list fetches in the background.
    useEntityStore.getState().loadEntities();

    // Load bitmap fonts for pixel-accurate text preview.
    // Non-blocking — BitmapText falls back to Konva <Text> until ready.
    loadBitmapFonts().then(() => {
      // Trigger re-render for components that read fontsReady()
      store.setBitmapFontsLoaded(true);
    });

    return () => {
      const urls = useUiStore.getState().previewImageUrls ?? {};
      revokeObjectUrl(urls.primary);
      revokeObjectUrl(urls.fullscreen);
    };
  }, []);

  // ── Auto-render preview on artboard size change or widget switch ──
  // Watches the document's pixel dimensions (which change when grid size
  // or display mode changes) and the active widget ID (which changes on
  // widget switch). When either changes, triggers a server render so the
  // preview overlay and PreviewTab stay current.
  const docSizeW = useDocStore((s) => selectFocusedMisc(s).size?.width);
  const docSizeH = useDocStore((s) => selectFocusedMisc(s).size?.height);
  const focusedDocId = useDocStore((s) => s.focusedDocId);
  const activeWidgetId = useWidgetStore((s) => s.activeWidgetId);
  const prevContextRef = useRef({ w: docSizeW, h: docSizeH, id: activeWidgetId, focused: focusedDocId });

  useEffect(() => {
    const prev = prevContextRef.current;
    prevContextRef.current = { w: docSizeW, h: docSizeH, id: activeWidgetId, focused: focusedDocId };

    // Skip if nothing changed (includes initial mount)
    if (
      prev.w === docSizeW &&
      prev.h === docSizeH &&
      prev.id === activeWidgetId &&
      prev.focused === focusedDocId
    ) return;
    if (!activeWidgetId) return; // No widget open yet

    // Debounce to coalesce rapid changes (e.g. widget switch changes both
    // activeWidgetId and doc size in quick succession).
    const timer = setTimeout(() => {
      const renderer = useUiStore.getState().previewRenderer;
      if (!renderer) return;
      // Render against the slot the user is currently editing so the
      // on-canvas PreviewOverlay loads the matching cached image.
      const slot = isFullscreenId(focusedDocId) ? 'fullscreen' : 'primary';
      const doc = getFocusedDoc();
      // A companion render inherits its primary's sources (undefined for the
      // primary slot, so this is a no-op there).
      const payload = exportRuntimeJson(doc, {
        slot,
        primarySources: getInheritedPrimarySources(focusedDocId),
      });
      renderer(payload, { slot })
        .then((result) => useUiStore.getState().notifyRenderComplete(result?.renderWarnings))
        .catch(() => {}); // Non-fatal — preview will update on next manual refresh
    }, 300);

    return () => clearTimeout(timer);
  }, [docSizeW, docSizeH, activeWidgetId, focusedDocId]);

  // When the active widget changes, clear stale element selection and
  // reposition the preview overlay below the new artboard so it doesn't
  // obscure the editing surface. This covers same-size widget switches
  // where the artboard-dimension effect in PreviewOverlay.jsx would not fire.
  useEffect(() => {
    if (!activeWidgetId) return;

    // Clear any element selection from the previous widget so the
    // Transformer and InspectorPanel don't reference stale element IDs.
    useUiStore.getState().setSelectedElementId(null);

    const { previewOverlay } = useUiStore.getState();
    if (!previewOverlay.enabled) return;

    const size = getFocusedDoc().misc.size;
    if (!size) return;

    useUiStore.getState().updatePreviewOverlay({
      x: 0,
      y: size.height + 30, // DEFAULT_GAP from PreviewOverlay
      width: size.width,
      height: size.height,
    });
  }, [activeWidgetId]);

  // ── Safety net: sync screen state with activeWidgetId ──
  // 1. If we're in the editor but activeWidgetId was cleared (e.g. widget
  //    deleted), redirect to the welcome screen.
  // 2. If we landed on the welcome screen because of a delete but the
  //    widgetStore auto-switched to another widget, jump back to the editor
  //    so the user sees the auto-selected widget immediately.
  useEffect(() => {
    if (screen === SCREEN_EDITOR && !activeWidgetId) {
      setScreen(SCREEN_WELCOME);
    } else if (screen === SCREEN_WELCOME && activeWidgetId) {
      setScreen(SCREEN_EDITOR);
    }
  }, [screen, activeWidgetId]);

  // ── Auto-collapse panels on narrow viewport ──
  useEffect(() => {
    const THRESHOLD = 800;
    let rafId = 0;
    const check = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const w = window.innerWidth;
        if (w < THRESHOLD) {
          useUiStore.getState().autoCollapsePanels();
        } else {
          useUiStore.getState().autoRestorePanels();
        }
      });
    };
    check();
    window.addEventListener('resize', check);
    return () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener('resize', check);
    };
  }, []);

  // ── Welcome screen handlers ──

  const handleNewWidget = useCallback((name) => {
    // New widgets always start at the 720×480 "With Side Panel" size. This is
    // forced before newDoc() (which reads widgetMode to size the doc) so a
    // previously-persisted 'full' choice can't leak in. The size can still be
    // changed later from the Settings tab.
    useDisplayConfigStore.getState().setWidgetMode('panel');
    // Create a temporary doc entry for the grid size selector.
    // The PENDING_DOC_ID entry lets the selector operate normally
    // (it mutates docs[PENDING_DOC_ID].doc.misc via updateMisc).
    // After grid confirmation, createNewWidget copies it to a real ID.
    useDocStore.getState().newDoc(PENDING_DOC_ID);
    useDocStore.getState().switchFocus(PENDING_DOC_ID);
    useDisplayConfigStore.getState().resetGridSizeConfirmation();
    setPendingWidgetName(name || '');
    setScreen(SCREEN_GRID_SELECT);
  }, []);

  const handleOpenWidget = useCallback(async (id) => {
    // Load the saved widget into docStore — openDoc (called inside
    // widgetStore.openWidget) already confirms grid size, so we skip
    // straight to the editor.
    await useWidgetStore.getState().openWidget(id);
    setScreen(SCREEN_EDITOR);
  }, []);

  // ── Grid selector handler ──
  // When the user confirms the grid size, persist the widget to the server
  // immediately so the editor opens with a valid activeWidgetId.  This
  // uses the current docStore state (which contains the grid choice) — no
  // newDoc() reset — so the user's selection is preserved in the saved payload.

  const handleGridConfirm = useCallback(async () => {
    useDisplayConfigStore.getState().confirmGridSize();
    try {
      await useWidgetStore.getState().createNewWidget({ name: pendingWidgetName });
      setPendingWidgetName('');
      // New widgets pass through the "How do you want to set up?" screen before
      // the editor; the setupMode overlay's Continue/OK advances to the editor.
      setScreen(SCREEN_SETUP_MODE);
    } catch {
      // createNewWidget failed — stay on grid select so the user sees the error
      // instead of briefly flashing the editor then snapping back to welcome.
      setScreen(SCREEN_WELCOME);
    }
  }, [pendingWidgetName]);

  // ── Render ──
  // Always render the editor so it appears blurred behind overlays.

  const showWelcome = screen === SCREEN_WELCOME;
  const showGridSelect = screen === SCREEN_GRID_SELECT;
  const showSetupMode = screen === SCREEN_SETUP_MODE;

  // ── Panel resize & collapse state ──
  const leftPanelWidth = useUiStore((s) => s.leftPanelWidth);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const leftCollapsed = useUiStore((s) => s.leftPanelCollapsed);
  const rightCollapsed = useUiStore((s) => s.rightPanelCollapsed);

  const handleLeftResize = useCallback((w) => {
    useUiStore.getState().setLeftPanelWidth(w);
  }, []);
  const handleRightResize = useCallback((w) => {
    useUiStore.getState().setRightPanelWidth(w);
  }, []);
  const toggleLeft = useCallback(() => {
    useUiStore.getState().toggleLeftPanelCollapsed();
  }, []);
  const toggleRight = useCallback(() => {
    useUiStore.getState().toggleRightPanelCollapsed();
  }, []);

  const leftCol = leftCollapsed ? '0px' : `${leftPanelWidth}px`;
  const rightCol = rightCollapsed ? '0px' : `${rightPanelWidth}px`;

  // Build grid columns to match the actual number of rendered children.
  // Collapsed panels and their resize handles are removed from the DOM,
  // so the column template must shrink to match.
  const cols = [];
  if (!leftCollapsed) { cols.push(leftCol); cols.push('auto'); }  // panel + handle
  cols.push('1fr');                                                 // canvas wrapper
  if (!rightCollapsed) { cols.push('auto'); cols.push(rightCol); }  // handle + panel
  const gridTemplateColumns = cols.join(' ');

  return (
    <div className="app-root">
      <TopBar />
      <div
        className={`app-layout${showWelcome || showGridSelect || showSetupMode ? ' app-layout--blurred' : ''}`}
        style={{ gridTemplateColumns }}
      >
        {!leftCollapsed && <LeftPanel />}
        {!leftCollapsed && (
          <PanelResizeHandle side="left" currentWidth={leftPanelWidth} onResize={handleLeftResize} />
        )}
        <div className="canvas-area-wrapper" style={{ position: 'relative', minWidth: 0, overflow: 'hidden', height: '100%' }}>
          {/* Left collapse/expand button */}
          <button
            className={`panel-collapse-btn panel-collapse-btn--left`}
            onClick={toggleLeft}
            title={leftCollapsed ? 'Show left panel' : 'Hide left panel'}
          >
            {leftCollapsed ? '▶' : '◀'}
          </button>
          <CanvasArea />
          {/* Right collapse/expand button */}
          <button
            className={`panel-collapse-btn panel-collapse-btn--right`}
            onClick={toggleRight}
            title={rightCollapsed ? 'Show right panel' : 'Hide right panel'}
          >
            {rightCollapsed ? '◀' : '▶'}
          </button>
        </div>
        {!rightCollapsed && (
          <PanelResizeHandle side="right" currentWidth={rightPanelWidth} onResize={handleRightResize} />
        )}
        {!rightCollapsed && <RightPanel />}
      </div>
      {showWelcome && (
        <WelcomeScreen
          onNewWidget={handleNewWidget}
          onOpenWidget={handleOpenWidget}
        />
      )}
      {showGridSelect && <GridSizeSelector onConfirm={handleGridConfirm} />}
      {showSetupMode && (
        <SetupModeScreen onContinue={() => setScreen(SCREEN_EDITOR)} />
      )}
      {/* Platform providers — register their callbacks into uiStore on mount. */}
      <AssetPickerProvider />
      {/* Single mount for every in-app notice; renders only when one is showing. */}
      <NoticeModal />
    </div>
  );
}

export default App;
