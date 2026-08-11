/**
 * CanvasArea.jsx — Infinite canvas editor surface
 *
 * The Stage fills the viewport and applies pan (position) + zoom (scale).
 * The widget artboard sits at world-space origin (0,0) as a fixed-size Rect.
 * Users pan with scroll/middle-click/Space+drag, and zoom with Ctrl+scroll.
 *
 * The optional PreviewOverlay shows the live-rendered image.png on the canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Shape, Stage, Transformer } from 'react-konva';

import { useDocStore, selectFocusedDoc, selectFocusedDocId, selectSharedSources } from '../store/docStore.js';
import { useUiStore } from '../store/uiStore.js';
import { getSnapLines, getResizeSnapLines } from '../utils/snapping.js';
import { evaluate, isBinding, isExpression } from '@zb/expressions';
import { buildPreviewContext } from '../utils/expressionContext.js';

import { centerToCirclePos, circlePosToCenter } from '../utils/circleGeometry.js';
import BitmapText from '../components/BitmapText.jsx';
import ImagePreview from '../components/ImagePreview.jsx';
import CanvasToolbox from './CanvasToolbox.jsx';
import GraphPreview from './GraphPreview.jsx';
import PreviewOverlay from './PreviewOverlay.jsx';
import { screenToWorld as toWorldCoords, snapToGrid, snapSizeToGrid } from './canvasUtils.js';
import { ditherPercentToGray, getFill, getStroke, getStrokeProps, getEndpointCaps } from './elementRenderHelpers.js';
import { makeRectSceneFunc, makeCircleSceneFunc, boxHitFunc } from './shapeSceneFuncs.js';
import { roundPolyline } from '../utils/polyline.js';
import { resolveVisibilityValue } from '../utils/visibility.js';
import { resolveAssetSrc } from '../utils/assetSrc.js';
import { resolveDisplayText, useAutoSizeText } from './useAutoSizeText.js';
import { useAutoFetchSources } from './useAutoFetchSources.js';
import { layoutTextBounds } from '../utils/bitmapFont.js';
import { TEXT_RESIZE_ANCHORS, textReserveOverflow } from './textFrame.js';

/** How fast zooming with the wheel feels. */
const ZOOM_SENSITIVITY = 1.05;

/**
 * Resolve a possibly-bound numeric value for Konva.
 * If the value is a binding or expression, evaluate it and coerce to a number.
 * Returns `fallback` if evaluation fails or produces non-numeric result.
 */
function resolveNumeric(value, fallback, ctx) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (value === null || value === undefined) return fallback;
  if (isBinding(value) || isExpression(value)) {
    try {
      const resolved = evaluate(value, ctx);
      const num = Number(resolved);
      return Number.isFinite(num) ? num : fallback;
    } catch {
      return fallback;
    }
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

// ── Component ──────────────────────────────────────────────────

export default function CanvasArea() {
  const focusedDocId = useDocStore(selectFocusedDocId);

  // Doc reads — track the focused doc.
  const doc = useDocStore(selectFocusedDoc);
  const size = doc.misc?.size;
  const elements = doc.elements;
  const featureValues = doc.features?.values;

  // Primary and companion share ONE source pool (anchored on the primary), so
  // the canvas — on either screen — reads the same sources and auto-fetches
  // them for live binding preview.
  const sources = useDocStore(selectSharedSources);

  const updateElement = useDocStore((s) => s.updateElement);
  const updateElementDerived = useDocStore((s) => s.updateElementDerived);
  const updateElementsPositions = useDocStore((s) => s.updateElementsPositions);
  const addElement = useDocStore((s) => s.addElement);
  const removeElements = useDocStore((s) => s.removeElements);
  const undo = useDocStore((s) => s.undo);
  const redo = useDocStore((s) => s.redo);

  const selectedElementId = useUiStore((s) => s.selectedElementId);
  const selectedElementIds = useUiStore((s) => s.selectedElementIds);
  const setSelectedElementId = useUiStore((s) => s.setSelectedElementId);
  const setSelectedElementIds = useUiStore((s) => s.setSelectedElementIds);
  const toggleInSelection = useUiStore((s) => s.toggleInSelection);
  const clearSelection = useUiStore((s) => s.clearSelection);
  const snapping = useUiStore((s) => s.snapping);

  // The currently selected element object (used for Transformer config)
  const selectedElement = useMemo(
    () => elements?.find((e) => e.id === selectedElementId) ?? null,
    [elements, selectedElementId],
  );
  const zoom = useUiStore((s) => s.viewport.zoom);
  const showGrid = useUiStore((s) => s.showGrid);
  const toolMode = useUiStore((s) => s.toolMode);
  const setToolMode = useUiStore((s) => s.setToolMode);
  const panX = useUiStore((s) => s.viewport.panX);
  const panY = useUiStore((s) => s.viewport.panY);
  const isPanning = useUiStore((s) => s.isPanning);
  const previewOverlay = useUiStore((s) => s.previewOverlay);
  const lockedElementIds = useUiStore((s) => s.lockedElementIds);
  const copyToClipboard = useUiStore((s) => s.copyToClipboard);
  const clipboard = useUiStore((s) => s.clipboard);
  const pasteElements = useDocStore((s) => s.pasteElements);

  // Data context for resolving bindings on the canvas (live preview).
  // Mirrors the context built by ValueEditor so text elements show
  // resolved values instead of [object Object].
  const sourceResponsesById = useUiStore((s) => s.sourceResponsesById);

  const bindingCtx = useMemo(
    () => buildPreviewContext({
      sources,
      sourceResponsesById,
      features: featureValues,
    }),
    [featureValues, sourceResponsesById, sources],
  );

  // Bitmap font loading is handled by the platform layer (App.jsx).
  // Subscribe to the store flag so we re-render when fonts become ready.
  const bitmapFontsLoaded = useUiStore((s) => s.bitmapFontsLoaded);
  // Platform resolver that maps an `asset:<filename>` payload token to its
  // loadable raw-bytes URL, so custom uploaded SVG/image assets preview on the
  // canvas. Null on builds without an asset store (token left unresolved).
  const assetUrlResolver = useUiStore((s) => s.assetUrlResolver);

  useAutoSizeText({ elements, bitmapFontsLoaded, bindingCtx, updateElementDerived });
  useAutoFetchSources(sources);

  // Wrapped layout for every fixed-flow text element, keyed by element id.
  // Computed at render time and never written to the store: the display box
  // is max(authored sizeY, content height), and the overflow past the
  // authored minimum drives the dashed overflow band. The line breaks come
  // from the same shared module the server pre-render pass runs, so the
  // canvas preview and the device wrap identically for the same input —
  // though a longer live value can still overflow further on the device.
  const fixedTextLayouts = useMemo(() => {
    const layouts = {};
    if (!bitmapFontsLoaded) return layouts;
    for (const el of elements ?? []) {
      if (el.type !== 'text' || el.textFlow !== 'fixed') continue;
      const displayText = resolveDisplayText(el.text, el.fallbackText, bindingCtx);
      // The server leaves an empty text element untouched (no wrap, no grow) —
      // measuring '' as one line here would show a display box and overflow
      // band the device never renders.
      if (!displayText) continue;
      const layout = layoutTextBounds({
        text: displayText,
        fontSize: el.fontSize ?? 14,
        fontWeight: el.fontWeight ?? 400,
        fontFamily: el.fontFamily ?? 'Sora',
        lineHeight: el.lineHeight ?? 1.2,
        textFlow: 'fixed',
        sizeX: resolveNumeric(el.sizeX, 0, bindingCtx),
      });
      if (layout) layouts[el.id] = layout;
    }
    return layouts;
  }, [elements, bindingCtx, bitmapFontsLoaded]);

  const width = size?.width ?? 240;
  const height = size?.height ?? 240;

  // Refs
  const containerRef = useRef(null);
  const stageRef = useRef(null);
  const transformerRef = useRef(null);
  const shapeRefs = useRef({});

  // Viewport size (updated on mount and resize)
  const [viewportSize, setViewportSize] = useState({ w: 800, h: 600 });

  // Guides
  const [guides, setGuides] = useState([]);

  // The overflow band overlay reads element positions from the STORE, but a
  // dragged/transformed node moves live and only commits on release — a band
  // left visible during the gesture sits stranded at the stale position and
  // "teleports" on mouse-up. Hide every band while a gesture is in progress,
  // like the snap guides; it reappears at the committed position.
  const [suppressOverflowBands, setSuppressOverflowBands] = useState(false);

  // Resolved themed colours for the artboard (Konva can't read CSS variables).
  // Read once on mount — the builder is dark-only, so they never change.
  const [maskFill, setMaskFill] = useState('#161618');
  const [artboardLine, setArtboardLine] = useState('#4a4a52');

  // Line tool: first click sets lineStart, second click creates element.
  // linePreviewEnd tracks cursor for the dotted preview line.

  // Marquee (rubber-band) selection state
  const [marquee, setMarquee] = useState(null); // { x, y, width, height } in world coords
  const marqueeStart = useRef(null); // { x, y } world coords of mousedown

  // Multi-drag: track sibling start positions when dragging within a selection
  const multiDragStart = useRef(null); // { draggedId, starts: { [id]: { x, y } } }
  const justCompletedMarquee = useRef(false); // prevent click-clear after marquee
  const groupDragStart = useRef(null); // { worldStart, starts: { [id]: { x, y } } }
  const [lineStart, setLineStart] = useState(null);
  const [linePreviewEnd, setLinePreviewEnd] = useState(null);

  // Track Space key for pan mode
  const spaceHeld = useRef(false);
  const panStart = useRef(null);

  // ── Viewport measurement ──

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const measure = () => {
      setViewportSize({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Resolve themed canvas colours for Konva (it can't read CSS vars) ──
  // The off-artboard mask (--c-bg) and the artboard hairline (--c-line) are
  // read once on mount (dark-only theme, so they never change).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const bg = cs.getPropertyValue('--c-bg').trim();
    const line = cs.getPropertyValue('--c-line').trim();
    if (bg) setMaskFill(bg);
    if (line) setArtboardLine(line);
  }, []);

  // ── Auto-center artboard on mount and when dimensions change ──
  // Uses a two-phase approach:
  //   1. On mount, wait for a real viewport measurement (from ResizeObserver)
  //      then recenter once.
  //   2. Afterwards, recenter whenever the artboard width/height changes
  //      (e.g. grid size or display mode change) OR when the focused doc
  //      changes (widget switch, slot switch, new widget creation) — even
  //      when both widgets share the same pixel dimensions.

  const hasMountCentered = useRef(false);
  const prevArtboardRef = useRef({ w: 0, h: 0, docId: null });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Only recenter once with the real measured viewport (not the default).
    const realW = el.clientWidth;
    const realH = el.clientHeight;
    if (realW <= 0 || realH <= 0) return;

    if (!hasMountCentered.current) {
      hasMountCentered.current = true;
      prevArtboardRef.current = { w: width, h: height, docId: focusedDocId };
      useUiStore.getState().recenter(realW, realH, width, height);
      return;
    }

    const docChanged = prevArtboardRef.current.docId !== focusedDocId;
    const sizeChanged =
      prevArtboardRef.current.w !== width || prevArtboardRef.current.h !== height;
    if (docChanged || sizeChanged) {
      prevArtboardRef.current = { w: width, h: height, docId: focusedDocId };
      useUiStore.getState().recenter(realW, realH, width, height);
    }
  }, [viewportSize.w, viewportSize.h, width, height, focusedDocId]);

  // Attach transformer to selected node(s)
  useEffect(() => {
    const tr = transformerRef.current;
    if (!tr) return;

    if (selectedElementIds.length > 0 && toolMode === 'select') {
      const nodes = [];
      for (const id of selectedElementIds) {
        const node = shapeRefs.current[id];
        if (!node) continue;
        // Don't attach Transformer to lines — they use endpoint handles instead
        const el = elements?.find((e) => e.id === id);
        if (el?.type === 'line') continue;
        nodes.push(node);
      }
      tr.nodes(nodes);
    } else {
      tr.nodes([]);
    }
    tr.getLayer()?.batchDraw();
  }, [selectedElementIds, elements, toolMode]);

  // ── Keyboard handlers (line tool + Space for pan) ──

  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore shortcuts when user is typing in an input/textarea
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      // Undo: Ctrl+Z (not Shift)
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }

      // Redo: Ctrl+Y or Ctrl+Shift+Z
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }

      // Copy: Ctrl+C
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedElementIds.length > 0) {
        e.preventDefault();
        const els = elements?.filter((el) => selectedElementIds.includes(el.id)) ?? [];
        const clones = JSON.parse(JSON.stringify(els));
        copyToClipboard(clones);
        return;
      }

      // Paste: Ctrl+V
      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && clipboard.length > 0) {
        e.preventDefault();
        const newIds = pasteElements(clipboard);
        if (newIds && newIds.length > 0) {
          setSelectedElementIds(newIds);
        }
        return;
      }

      // Duplicate: Ctrl+D
      if ((e.ctrlKey || e.metaKey) && e.key === 'd' && selectedElementIds.length > 0) {
        e.preventDefault();
        const els = elements?.filter((el) => selectedElementIds.includes(el.id)) ?? [];
        const clones = JSON.parse(JSON.stringify(els));
        const newIds = pasteElements(clones);
        if (newIds && newIds.length > 0) {
          setSelectedElementIds(newIds);
        }
        return;
      }

      // Delete selected element(s)
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedElementIds.length > 0) {
        e.preventDefault();
        // Batch into a single undo entry (Task 8).
        removeElements([...selectedElementIds]);
        clearSelection();
        return;
      }

      // Escape: cancel line tool or deselect
      if (e.key === 'Escape') {
        if (toolMode === 'line') {
          setLineStart(null);
          setLinePreviewEnd(null);
          setToolMode('select');
        } else {
          clearSelection();
        }
        return;
      }

      // Space activates pan mode
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        spaceHeld.current = true;
        useUiStore.getState().setIsPanning(true);
      }
    };

    const handleKeyUp = (e) => {
      if (e.code === 'Space') {
        spaceHeld.current = false;
        panStart.current = null;
        useUiStore.getState().setIsPanning(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [toolMode, selectedElementIds, elements, undo, redo, removeElements, clearSelection, setToolMode, copyToClipboard, clipboard, pasteElements, setSelectedElementIds]);

  // ── Convert screen coords → world coords ──

  const screenToWorld = useCallback(
    (screenX, screenY) => {
      const vp = useUiStore.getState().viewport;
      return toWorldCoords(screenX, screenY, vp.panX, vp.panY, vp.zoom);
    },
    [],
  );

  // ── Wheel: pan (plain) / zoom (Ctrl) ──

  const handleWheel = useCallback(
    (e) => {
      e.evt.preventDefault();
      const store = useUiStore.getState();
      const vp = store.viewport;

      if (e.evt.ctrlKey || e.evt.metaKey) {
        // Pinch-to-zoom or Ctrl+scroll → zoom around cursor
        const pointer = stageRef.current?.getPointerPosition();
        if (!pointer) return;

        const direction = e.evt.deltaY < 0 ? 1 : -1;
        const factor = direction > 0 ? ZOOM_SENSITIVITY : 1 / ZOOM_SENSITIVITY;
        const newZoom = vp.zoom * factor;

        store.zoomAtPoint(newZoom, pointer.x, pointer.y);
      } else {
        // Plain scroll → pan
        store.panBy(-e.evt.deltaX, -e.evt.deltaY);
      }
    },
    [],
  );

  // ── Mouse pan (Space+drag or middle-click) ──

  const handleMouseDown = useCallback(
    (e) => {
      if (e.evt.button === 1 || spaceHeld.current) {
        e.evt.preventDefault();
        panStart.current = { x: e.evt.clientX, y: e.evt.clientY };
        useUiStore.getState().setIsPanning(true);
        return;
      }

      // Marquee or group-drag: on empty canvas click in select mode
      const state = useUiStore.getState();
      if (state.toolMode === 'select' && e.evt.button === 0 && e.target === e.target.getStage()) {
        const pointer = e.target.getStage().getPointerPosition();
        if (pointer) {
          const world = screenToWorld(pointer.x, pointer.y);

          // If multi-selection exists and click is inside the selection bbox,
          // start a group-drag instead of a new marquee.
          const selIds = state.selectedElementIds;
          if (selIds.length > 1 && elements) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const el of elements) {
              if (!selIds.includes(el.id)) continue;
              const ex = el.pos?.x ?? 0;
              const ey = el.pos?.y ?? 0;
              const ew = el.sizeX ?? 0;
              const eh = el.sizeY ?? 0;
              minX = Math.min(minX, ex);
              minY = Math.min(minY, ey);
              maxX = Math.max(maxX, ex + ew);
              maxY = Math.max(maxY, ey + eh);
            }
            if (world.x >= minX && world.x <= maxX && world.y >= minY && world.y <= maxY) {
              // Inside selection bbox — start group drag
              const starts = {};
              for (const id of selIds) {
                const node = shapeRefs.current[id];
                if (node) starts[id] = { x: node.x(), y: node.y() };
              }
              groupDragStart.current = { worldStart: world, starts };
              return;
            }
          }

          marqueeStart.current = world;
          setMarquee(null); // will be set on mousedown drag starts
        }
      }
    },
    [screenToWorld, elements],
  );

  const handleMouseMove = useCallback(
    (e) => {
      // Pan handling (highest priority)
      if (panStart.current) {
        const dx = e.evt.clientX - panStart.current.x;
        const dy = e.evt.clientY - panStart.current.y;
        panStart.current = { x: e.evt.clientX, y: e.evt.clientY };
        useUiStore.getState().panBy(dx, dy);
        return;
      }

      // Group-drag (multi-select from empty space inside bbox)
      if (groupDragStart.current) {
        const pointer = e.target.getStage()?.getPointerPosition();
        if (pointer) {
          const world = screenToWorld(pointer.x, pointer.y);
          const dx = world.x - groupDragStart.current.worldStart.x;
          const dy = world.y - groupDragStart.current.worldStart.y;
          for (const [id, start] of Object.entries(groupDragStart.current.starts)) {
            const node = shapeRefs.current[id];
            if (node) {
              node.x(start.x + dx);
              node.y(start.y + dy);
            }
          }
        }
        return;
      }

      // Marquee dragging
      if (marqueeStart.current) {
        const pointer = e.target.getStage()?.getPointerPosition();
        if (pointer) {
          const world = screenToWorld(pointer.x, pointer.y);
          const sx = marqueeStart.current.x;
          const sy = marqueeStart.current.y;
          setMarquee({
            x: Math.min(sx, world.x),
            y: Math.min(sy, world.y),
            width: Math.abs(world.x - sx),
            height: Math.abs(world.y - sy),
          });
        }
        return;
      }

      // Line tool: track cursor for the dotted preview line
      const state = useUiStore.getState();
      if (state.toolMode === 'line') {
        const stage = e.target.getStage();
        const pointer = stage?.getPointerPosition();
        if (pointer) {
          const world = screenToWorld(pointer.x, pointer.y);
          let x = world.x;
          let y = world.y;
          if (state.snapping.snapEnabled) {
            const step = state.snapping.gridStep;
            x = snapToGrid(x, step);
            y = snapToGrid(y, step);
          }
          setLinePreviewEnd({ x, y });
        }
      }
    },
    [screenToWorld],
  );

  const handleMouseUp = useCallback(
    (e) => {
      if (panStart.current) {
        panStart.current = null;
        if (!spaceHeld.current) {
          useUiStore.getState().setIsPanning(false);
        }
        return;
      }

      // Group-drag commit: persist positions for all dragged elements
      if (groupDragStart.current) {
        const selIds = useUiStore.getState().selectedElementIds;
        const updates = [];
        for (const id of selIds) {
          const node = shapeRefs.current[id];
          if (!node) continue;
          const el = elements?.find((el) => el.id === id);
          if (!el) continue;
          let x = node.x() - (el.origin?.x ?? 0);
          let y = node.y() - (el.origin?.y ?? 0);
          if (el.type === 'circle') {
            ({ x, y } = centerToCirclePos(x, y, el.sizeX ?? 0, el.sizeY ?? 0));
          }
          if (snapping.snapEnabled) {
            const step = snapping.gridStep;
            x = snapToGrid(x, step);
            y = snapToGrid(y, step);
          }
          updates.push({ id, pos: { x, y } });
        }
        // Single undo entry for the whole group drag (Task 8).
        updateElementsPositions(updates);
        groupDragStart.current = null;
        return;
      }

      // Marquee selection: compute intersecting elements
      if (marqueeStart.current) {
        let marqueeDidSelect = false;
        if (marquee && marquee.width > 2 && marquee.height > 2 && elements) {
          const ids = [];
          for (const el of elements) {
            if (!el?.id) continue;
            const ex = el.pos?.x ?? 0;
            const ey = el.pos?.y ?? 0;
            const ew = el.sizeX ?? 0;
            const eh = el.sizeY ?? 0;
            // AABB intersection test
            if (
              ex < marquee.x + marquee.width &&
              ex + ew > marquee.x &&
              ey < marquee.y + marquee.height &&
              ey + eh > marquee.y
            ) {
              ids.push(el.id);
            }
          }
          if (ids.length > 0) {
            // Shift+marquee adds to existing selection
            if (e?.evt?.shiftKey) {
              const current = useUiStore.getState().selectedElementIds;
              const merged = [...new Set([...current, ...ids])];
              setSelectedElementIds(merged);
            } else {
              setSelectedElementIds(ids);
            }
            marqueeDidSelect = true;
          } else {
            clearSelection();
          }
        }
        marqueeStart.current = null;
        setMarquee(null);
        // Only suppress the subsequent click-deselect if the marquee actually selected elements
        justCompletedMarquee.current = marqueeDidSelect;
      }
    },
    [marquee, elements, setSelectedElementIds, clearSelection, snapping, updateElementsPositions],
  );

  // ── Element selection ──

  const handleSelect = useCallback(
    (id, e) => {
      if (toolMode === 'select' && !isPanning) {
        // Shift or Ctrl+click toggles element in/out of multi-selection
        if (e && (e.evt?.shiftKey || e.evt?.ctrlKey || e.evt?.metaKey)) {
          toggleInSelection(id);
        } else {
          setSelectedElementId(id);
        }
      }
    },
    [setSelectedElementId, toggleInSelection, toolMode, isPanning],
  );

  const handleStageClick = useCallback(
    (e) => {
      // Ignore clicks while panning
      if (isPanning || panStart.current) return;

      if (toolMode === 'line') {
        const stage = e.target.getStage();
        const pointer = stage.getPointerPosition();
        const world = screenToWorld(pointer.x, pointer.y);

        let x = world.x;
        let y = world.y;
        if (snapping.snapEnabled) {
          const step = snapping.gridStep;
          x = snapToGrid(x, step);
          y = snapToGrid(y, step);
        }

        if (!lineStart) {
          // First click — set the start point
          setLineStart({ x, y });
        } else {
          // Second click — create the line element and reset
          const dx = x - lineStart.x;
          const dy = y - lineStart.y;
          addElement('line', {
            pos: { x: lineStart.x, y: lineStart.y },
            points: [[0, 0], [dx, dy]],
          });
          setLineStart(null);
          setLinePreviewEnd(null);
        }
        return;
      }

      // Clicked on empty area → deselect (unless marquee just completed or inside selection bbox)
      if (e.target === e.target.getStage()) {
        if (justCompletedMarquee.current) {
          justCompletedMarquee.current = false;
          return;
        }
        // Don't deselect if clicking inside the multi-selection bounding box
        const selIds = useUiStore.getState().selectedElementIds;
        if (selIds.length > 1 && elements) {
          const pointer = e.target.getStage().getPointerPosition();
          if (pointer) {
            const world = screenToWorld(pointer.x, pointer.y);
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const el of elements) {
              if (!selIds.includes(el.id)) continue;
              const ex = el.pos?.x ?? 0;
              const ey = el.pos?.y ?? 0;
              const ew = el.sizeX ?? 0;
              const eh = el.sizeY ?? 0;
              minX = Math.min(minX, ex);
              minY = Math.min(minY, ey);
              maxX = Math.max(maxX, ex + ew);
              maxY = Math.max(maxY, ey + eh);
            }
            if (world.x >= minX && world.x <= maxX && world.y >= minY && world.y <= maxY) {
              return; // Inside selection bbox — don't deselect
            }
          }
        }
        clearSelection();
      }
    },
    [clearSelection, toolMode, snapping, isPanning, screenToWorld, lineStart, addElement, elements],
  );

  const handleDragEnd = useCallback(
    (element, e) => {
      const node = e.target;
      let x = node.x() - (element.origin?.x ?? 0);
      let y = node.y() - (element.origin?.y ?? 0);

      // For circles, we need to offset back from center
      if (element.type === 'circle') {
        ({ x, y } = centerToCirclePos(x, y, element.sizeX ?? 0, element.sizeY ?? 0));
      }

      if (snapping.snapEnabled) {
        const step = snapping.gridStep;
        x = snapToGrid(x, step);
        y = snapToGrid(y, step);
      }

      updateElement(element.id, { pos: { x, y } });
      setGuides([]);
    },
    [updateElement, snapping],
  );

  const handleBoundBoxFunc = useCallback(
    (oldBox, newBox) => {
      const vp = useUiStore.getState().viewport;
      const px = vp.panX;
      const py = vp.panY;
      const z = vp.zoom;

      if (snapping.snapEnabled) {
        const step = snapping.gridStep;
        // boundBoxFunc receives absolute (screen-space) coords.
        // Convert position to world space, snap, convert back.
        const wx = (newBox.x - px) / z;
        const wy = (newBox.y - py) / z;
        newBox.x = snapToGrid(wx, step) * z + px;
        newBox.y = snapToGrid(wy, step) * z + py;

        // Size is in screen pixels; convert to world, snap, convert back.
        const ww = newBox.width / z;
        const wh = newBox.height / z;
        newBox.width = snapSizeToGrid(ww, step) * z;
        newBox.height = snapSizeToGrid(wh, step) * z;
      }

      // Element-to-element snapping during resize
      if (snapping.snapToElements && selectedElementId) {
        // Convert screen-space boxes to world space for the snap utility
        const worldOld = {
          x: (oldBox.x - px) / z,
          y: (oldBox.y - py) / z,
          width: oldBox.width / z,
          height: oldBox.height / z,
        };
        const worldNew = {
          x: (newBox.x - px) / z,
          y: (newBox.y - py) / z,
          width: newBox.width / z,
          height: newBox.height / z,
        };

        const result = getResizeSnapLines(worldOld, worldNew, elements, selectedElementId);
        if (result.lines.length > 0) {
          // Apply snapped world-space box back to screen space
          newBox.x = result.box.x * z + px;
          newBox.y = result.box.y * z + py;
          newBox.width = result.box.width * z;
          newBox.height = result.box.height * z;
        }

        // Update guide lines
        if (result.lines.length > 0 || guides.length > 0) {
          if (
            result.lines.length !== guides.length ||
            result.lines.some((l, i) => l.pos !== guides[i]?.pos)
          ) {
            setGuides(result.lines);
          }
        }
      }

      // Floor a text-frame drag at ~8 px wide and one line tall so a handle
      // drag cannot produce a degenerate frame (the render's maxWidth <= 0
      // guard still backstops anything that slips through).
      const selEl = elements?.find((el) => el.id === selectedElementId);
      if (selEl?.type === 'text') {
        const minW = 8 * z;
        const minH =
          (Math.round((selEl.fontSize ?? 14) * (selEl.lineHeight ?? 1.2)) + 4) * z;
        if (newBox.width < minW) newBox.width = minW;
        if (newBox.height < minH) newBox.height = minH;
      }

      return newBox;
    },
    [snapping, selectedElementId, elements, guides],
  );

  const handleTransformEnd = useCallback(() => {
    setSuppressOverflowBands(false);
    const node = shapeRefs.current[selectedElementId];
    if (!node) return;

    const element = elements.find((e) => e.id === selectedElementId);
    if (!element) return;

    const scaleX = node.scaleX();
    const scaleY = node.scaleY();

    // Reset node scale to avoid compounding
    node.scaleX(1);
    node.scaleY(1);

    let newX = node.x() - (element.origin?.x ?? 0);
    let newY = node.y() - (element.origin?.y ?? 0);
    const newRotation = Math.round(node.rotation());

    // A rotation-only transform (scale untouched) keeps today's behaviour for
    // text: write pos/rotation and nothing else — rotating an element must
    // not convert it to fixed flow or bake sizes.
    if (element.type === 'text' && scaleX === 1 && scaleY === 1) {
      if (snapping.snapEnabled) {
        const step = snapping.gridStep;
        newX = snapToGrid(newX, step);
        newY = snapToGrid(newY, step);
      }
      updateElement(element.id, { pos: { x: newX, y: newY }, rotationDeg: newRotation });
      return;
    }

    // Dragging a resize handle on a text element converts it to fixed flow
    // and bakes the dragged box (one store write, one undo entry). Sizes come
    // from the node rather than the element because a grown fixed element
    // renders taller than its authored minimum — the drag operates on what is
    // on screen, and where the user releases becomes the new minimum.
    const isText = element.type === 'text';
    let newSizeX = (isText ? node.width() : (element.sizeX ?? 100)) * scaleX;
    let newSizeY = (isText ? node.height() : (element.sizeY ?? 100)) * scaleY;

    if (snapping.snapEnabled) {
      const step = snapping.gridStep;
      newSizeX = snapSizeToGrid(newSizeX, step);
      newSizeY = snapSizeToGrid(newSizeY, step);

      // Snap position as well to keep alignment
      newX = snapToGrid(newX, step);
      newY = snapToGrid(newY, step);
    }

    // Circle position correction (node is center, store is top-left)
    if (element.type === 'circle') {
      ({ x: newX, y: newY } = centerToCirclePos(newX, newY, newSizeX, newSizeY));
    }

    updateElement(element.id, {
      pos: { x: newX, y: newY },
      rotationDeg: newRotation,
      sizeX: newSizeX,
      sizeY: newSizeY,
      scale: { x: 1, y: 1 },
      ...(isText ? { textFlow: 'fixed' } : {}),
    });

    // Clear snap guides after resize is committed
    setGuides([]);
  }, [selectedElementId, elements, updateElement, snapping]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      const type = e.dataTransfer.getData('application/widget-type');
      if (!type) return;

      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();

      // Screen position relative to container → world coordinates
      const screenX = e.clientX - rect.left;
      const screenY = e.clientY - rect.top;
      const world = screenToWorld(screenX, screenY);

      addElement(type, { pos: { x: world.x - 50, y: world.y - 50 } });
    },
    [addElement, screenToWorld],
  );

  const getCommonNodeProps = useCallback(
    (element) => ({
      ref: (node) => {
        if (node) {
          shapeRefs.current[element.id] = node;
        } else {
          delete shapeRefs.current[element.id];
        }
      },
      id: element.id,
      visible: resolveVisibilityValue(element.visible, bindingCtx, true),
      x: resolveNumeric(element.pos?.x, 0, bindingCtx) + (element.origin?.x ?? 0),
      y: resolveNumeric(element.pos?.y, 0, bindingCtx) + (element.origin?.y ?? 0),
      rotation: resolveNumeric(element.rotationDeg, 0, bindingCtx),
      scaleX: element.scale?.x ?? 1,
      scaleY: element.scale?.y ?? 1,
      offsetX: element.origin?.x ?? 0,
      offsetY: element.origin?.y ?? 0,
      // The engine dithers opacity per pixel; Konva applies a uniform alpha,
      // which is the same intentional solid-stand-in the canvas uses for dither.
      opacity: resolveNumeric(element.opacity, 100, bindingCtx) / 100,
      draggable: !lockedElementIds[element.id] && !isPanning,
      onClick: (e) => handleSelect(element.id, e),
      onTap: (e) => handleSelect(element.id, e),
      onDragStart: () => {
        setSuppressOverflowBands(true);
        // When dragging an element that's part of a multi-selection,
        // record sibling start positions so we can move them in sync.
        const ids = useUiStore.getState().selectedElementIds;
        if (ids.length > 1 && ids.includes(element.id)) {
          const starts = {};
          for (const id of ids) {
            if (id === element.id) continue;
            const node = shapeRefs.current[id];
            if (node) starts[id] = { x: node.x(), y: node.y() };
          }
          const draggedNode = shapeRefs.current[element.id];
          multiDragStart.current = {
            draggedId: element.id,
            originX: draggedNode ? draggedNode.x() : 0,
            originY: draggedNode ? draggedNode.y() : 0,
            starts,
          };
        } else {
          multiDragStart.current = null;
        }
      },
      onDragMove: (e) => {
        // Move sibling selected elements by the same delta
        if (multiDragStart.current && multiDragStart.current.draggedId === element.id) {
          const dx = e.target.x() - multiDragStart.current.originX;
          const dy = e.target.y() - multiDragStart.current.originY;
          for (const [id, start] of Object.entries(multiDragStart.current.starts)) {
            const node = shapeRefs.current[id];
            if (node) {
              node.x(start.x + dx);
              node.y(start.y + dy);
            }
          }
        }
      },
      onDragEnd: (e) => {
        // The store commit below re-renders the band at the fresh position.
        setSuppressOverflowBands(false);
        // Commit positions for all selected elements on multi-drag
        if (multiDragStart.current && multiDragStart.current.draggedId === element.id) {
          const ids = useUiStore.getState().selectedElementIds;
          const updates = [];
          for (const id of ids) {
            const node = id === element.id ? e.target : shapeRefs.current[id];
            if (!node) continue;
            const el = id === element.id
              ? element
              : elements?.find((el) => el.id === id);
            if (!el) continue;
            let x = node.x() - (el.origin?.x ?? 0);
            let y = node.y() - (el.origin?.y ?? 0);
            if (el.type === 'circle') {
              ({ x, y } = centerToCirclePos(x, y, el.sizeX ?? 0, el.sizeY ?? 0));
            }
            if (snapping.snapEnabled) {
              const step = snapping.gridStep;
              x = snapToGrid(x, step);
              y = snapToGrid(y, step);
            }
            updates.push({ id, pos: { x, y } });
          }
          // Single undo entry for the whole multi-drag (Task 8).
          updateElementsPositions(updates);
          multiDragStart.current = null;
          setGuides([]);
          return;
        }
        handleDragEnd(element, e);
      },
      dragBoundFunc: (pos) => {
        let { x, y } = pos;

        // dragBoundFunc receives absolute (screen-space) coordinates.
        // The grid is defined in world space, so convert before snapping.
        const vp = useUiStore.getState().viewport;
        const px = vp.panX;
        const py = vp.panY;
        const z = vp.zoom;

        // 1. Grid Snapping
        if (snapping.snapEnabled) {
          const step = snapping.gridStep;
          // Convert absolute → world, snap, convert back → absolute
          if (element.type === 'circle') {
            const sizeX = element.sizeX ?? 0;
            const sizeY = element.sizeY ?? 0;
            const wx = (x - px) / z - sizeX / 2;
            const wy = (y - py) / z - sizeY / 2;
            x = (snapToGrid(wx, step) + sizeX / 2) * z + px;
            y = (snapToGrid(wy, step) + sizeY / 2) * z + py;
          } else {
            const originX = element.origin?.x ?? 0;
            const originY = element.origin?.y ?? 0;
            const wx = (x - px) / z - originX;
            const wy = (y - py) / z - originY;
            x = (snapToGrid(wx, step) + originX) * z + px;
            y = (snapToGrid(wy, step) + originY) * z + py;
          }
        }

        // 2. Element Snapping (Guides)
        if (snapping.snapToElements) {
          const originX = element.origin?.x ?? 0;
          const originY = element.origin?.y ?? 0;
          // Convert current absolute pos to world coords for the snapping util
          let worldX = (x - px) / z - originX;
          let worldY = (y - py) / z - originY;

          // Construct a temporary object for the snapping util
          // We need the current size
          const tempEl = {
            ...element,
            pos: { x: worldX, y: worldY },
            sizeX: (element.sizeX ?? 0) * (shapeRefs.current[element.id]?.scaleX() ?? 1),
            sizeY: (element.sizeY ?? 0) * (shapeRefs.current[element.id]?.scaleY() ?? 1),
          };

          // Circle correction for snapping util (which expects top-left pos)
          if (element.type === 'circle') {
            const { x: tlX, y: tlY } = centerToCirclePos(tempEl.pos.x, tempEl.pos.y, tempEl.sizeX, tempEl.sizeY);
            tempEl.pos.x = tlX;
            tempEl.pos.y = tlY;
          }

          const result = getSnapLines(tempEl, elements);

          if (result.x !== null) {
            worldX = result.x;
            if (element.type === 'circle') worldX += tempEl.sizeX / 2;
          }
          if (result.y !== null) {
            worldY = result.y;
            if (element.type === 'circle') worldY += tempEl.sizeY / 2;
          }

          // Convert snapped world coords back to absolute (re-add origin offset)
          x = (worldX + originX) * z + px;
          y = (worldY + originY) * z + py;

          // Update snap guides only when they actually changed, to avoid
          // redundant re-renders during the drag.
          if (result.lines.length > 0 || guides.length > 0) {
            // Simple check to avoid setting same empty array
            if (
              result.lines.length !== guides.length ||
              result.lines.some((l, i) => l.pos !== guides[i]?.pos)
            ) {
              setGuides(result.lines);
            }
          }
        } else if (guides.length > 0) {
          setGuides([]);
        }

        return { x, y };
      },
    }),
    [handleSelect, handleDragEnd, snapping, elements, guides, isPanning, lockedElementIds, updateElement, updateElementsPositions, setGuides, bindingCtx],
  );

  // ── Cursor style ──

  const cursorStyle = isPanning ? 'grab' : toolMode === 'line' ? 'crosshair' : 'default';

  // ── Render ──

  return (
    <main
      className="canvas-area"
      ref={containerRef}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ cursor: cursorStyle }}
    >
      {/* Toolbar overlay */}
      <CanvasToolbox
        viewportWidth={viewportSize.w}
        viewportHeight={viewportSize.h}
        artboardWidth={width}
        artboardHeight={height}
        sources={sources}
      />

      {/* Konva Stage — fills viewport, positioned by pan, scaled by zoom */}
      <Stage
        ref={stageRef}
        width={viewportSize.w}
        height={viewportSize.h}
        x={panX}
        y={panY}
        scaleX={zoom}
        scaleY={zoom}
        onClick={handleStageClick}
        onTap={handleStageClick}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        {/* Background layer — artboard outline + optional grid */}
        <Layer listening={false}>
          {/* Artboard shadow */}
          <Rect
            x={0}
            y={0}
            width={width}
            height={height}
            shadowColor="rgba(0,0,0,0.15)"
            shadowBlur={12}
            shadowOffsetX={2}
            shadowOffsetY={4}
            fill="transparent"
          />
          {/* Artboard fill (white — the design surface) */}
          <Rect x={0} y={0} width={width} height={height} fill="#ffffff" />

          {/* Grid overlay (within artboard bounds) */}
          {showGrid &&
            Array.from({ length: Math.ceil(width / snapping.gridStep) + 1 }).map((_, i) => (
              <Line
                key={`v-${i}`}
                points={[i * snapping.gridStep, 0, i * snapping.gridStep, height]}
                stroke="rgba(0,0,0,0.1)"
                strokeWidth={1}
              />
            ))}
          {showGrid &&
            Array.from({ length: Math.ceil(height / snapping.gridStep) + 1 }).map((_, i) => (
              <Line
                key={`h-${i}`}
                points={[0, i * snapping.gridStep, width, i * snapping.gridStep]}
                stroke="rgba(0,0,0,0.1)"
                strokeWidth={1}
              />
            ))}

          {/* Artboard border — thin themed hairline */}
          <Rect
            x={0}
            y={0}
            width={width}
            height={height}
            stroke={artboardLine}
            strokeWidth={1}
          />
        </Layer>

        {/* Elements layer — the main editing surface */}
        <Layer>
          {(elements ?? []).map((element) => {
              if (!element?.id || !element?.type) return null;

              if (element.type === 'rect') {
                const rectW = resolveNumeric(element.sizeX, 0, bindingCtx);
                const rectH = resolveNumeric(element.sizeY, 0, bindingCtx);
                // Custom Shape (not <Rect>) so corner radius and inside/outside
                // stroke position match the engine (src/engine/primitives/rect.ts).
                return (
                  <Shape
                    key={element.id}
                    {...getCommonNodeProps(element)}
                    width={rectW}
                    height={rectH}
                    sceneFunc={makeRectSceneFunc({
                      w: rectW,
                      h: rectH,
                      radius: resolveNumeric(element.strokeRadius, 0, bindingCtx),
                      fillColor: getFill(element),
                      strokeColor: getStroke(element),
                      strokeWidth: element.strokeWidth ?? 1,
                      strokePosition: element.strokePosition ?? 'center',
                      dash: element.strokeDash,
                    })}
                    hitFunc={boxHitFunc}
                  />
                );
              }

              if (element.type === 'circle') {
                const sizeX = resolveNumeric(element.sizeX, 0, bindingCtx);
                const sizeY = resolveNumeric(element.sizeY, 0, bindingCtx);
                // Custom Shape (not <Ellipse>) so donut (innerSize), arc
                // (arcStartDeg/arcEndDeg) and stroke position match the engine
                // (src/engine/primitives/circle.ts). Positioned at center with a
                // half-size offset so the node origin stays the ellipse center
                // (preserving the existing center↔top-left handling in drag/
                // transform handlers) while getSelfRect reports the true bounds.
                return (
                  <Shape
                    key={element.id}
                    {...getCommonNodeProps(element)}
                    x={resolveNumeric(element.pos?.x, 0, bindingCtx) + sizeX / 2}
                    y={resolveNumeric(element.pos?.y, 0, bindingCtx) + sizeY / 2}
                    offsetX={sizeX / 2}
                    offsetY={sizeY / 2}
                    width={sizeX}
                    height={sizeY}
                    sceneFunc={makeCircleSceneFunc({
                      w: sizeX,
                      h: sizeY,
                      fillColor: getFill(element),
                      strokeColor: getStroke(element),
                      strokeWidth: element.strokeWidth ?? 1,
                      strokePosition: element.strokePosition ?? 'center',
                      innerSize: resolveNumeric(element.innerSize, 0, bindingCtx),
                      arcStartDeg: resolveNumeric(element.arcStartDeg, 0, bindingCtx),
                      arcEndDeg: resolveNumeric(element.arcEndDeg, 0, bindingCtx),
                      dash: element.strokeDash,
                    })}
                    hitFunc={boxHitFunc}
                  />
                );
              }

              if (element.type === 'line') {
                const caps = getEndpointCaps(element);
                // Apply the engine's polyline corner rounding (line.ts) so rounded
                // line elements match the device.
                const radius = resolveNumeric(element.strokeRadius, 0, bindingCtx);
                const rawPts = (element.points || []).map(([x, y]) => ({ x, y }));
                const shaped = radius > 0 && rawPts.length > 2 ? roundPolyline(rawPts, radius) : rawPts;
                const flatPoints = shaped.flatMap((p) => [p.x, p.y]);
                // The transform lives on the Group (not the inner Line) so the
                // endpoint caps rotate/scale together with the line.
                return (
                  <Group key={element.id} {...getCommonNodeProps(element)}>
                    <Line
                      points={flatPoints}
                      hitStrokeWidth={Math.max(20, element.strokeWidth ?? 2)}
                      {...getStrokeProps(element)}
                    />
                    {caps?.type === 'round' && (
                      <>
                        <Circle x={caps.first[0]} y={caps.first[1]}
                          radius={caps.radius} fill={caps.fill} listening={false} />
                        <Circle x={caps.last[0]} y={caps.last[1]}
                          radius={caps.radius} fill={caps.fill} listening={false} />
                      </>
                    )}
                  </Group>
                );
              }

              if (element.type === 'text') {
                // A fixed-flow element renders its pre-wrapped string in a
                // display box of max(authored sizeY, content height) — the
                // grown height is never stored. An auto element (no layout
                // entry) keeps today's path untouched.
                const layout = fixedTextLayouts[element.id];
                const authoredH = resolveNumeric(element.sizeY, 0, bindingCtx);
                const overflow = layout
                  ? textReserveOverflow(element.textFlow, authoredH, layout.height)
                  : 0;
                return (
                  <BitmapText
                    key={element.id}
                    {...getCommonNodeProps(element)}
                    width={resolveNumeric(element.sizeX, 0, bindingCtx)}
                    height={authoredH + overflow}
                    text={layout
                      ? layout.text
                      : resolveDisplayText(element.text, element.fallbackText, bindingCtx)}
                    fontFamily={element.fontFamily ?? 'Sora'}
                    fontSize={element.fontSize ?? 14}
                    fontWeight={element.fontWeight ?? 400}
                    align={element.textAlign ?? 'left'}
                    lineHeight={element.lineHeight ?? 1.2}
                    // The engine's drawText ignores enableFill and always paints
                    // glyphs at the configured `fill` dither level (text.ts via
                    // resolveText -> drawText). Mirror that here: derive the gray
                    // straight from element.fill, never from getFill() (which
                    // returns black when enableFill is off, diverging from preview).
                    fill={ditherPercentToGray(element.fill ?? 100)}
                  />
                );
              }

              if (element.type === 'graph') {
                // `bindingCtx` is the canonical FLAT context from
                // buildPreviewContext ({ misc, features, [sourceId]: data }) —
                // source data lives at ctx[sourceId], matching the server graph
                // expander (src/data/graph/expander.ts). The legacy nested
                // `ctx.sources[id]` shape no longer exists, so reading it left
                // graphSourceData null and the canvas always rendered the
                // "no data" placeholder.
                const graphSourceData = element.sourceId
                  ? bindingCtx[element.sourceId] ?? null
                  : null;
                // No clip: the engine graph expander does not clip primitives to
                // the element box (axis labels/title can overflow), so the canvas
                // must not clip either, or the preview would hide on-device content.
                // opacity={1} on the wrapper: the engine fades ONLY the data series
                // (bar/line carry config.opacity; axes/grid/labels/title are emitted
                // at opacity 100), so GraphPreview applies opacity to the series and
                // the Group must stay fully opaque.
                return (
                  <Group key={element.id} {...getCommonNodeProps(element)} opacity={1}>
                    <GraphPreview element={element} sourceData={graphSourceData} />
                  </Group>
                );
              }

              if (element.type === 'img') {
                const imgW = resolveNumeric(element.sizeX, 96, bindingCtx);
                const imgH = resolveNumeric(element.sizeY, 96, bindingCtx);
                return (
                  <Group
                    key={element.id}
                    {...getCommonNodeProps(element)}
                    clipX={0}
                    clipY={0}
                    clipWidth={imgW}
                    clipHeight={imgH}
                  >
                    {/* Transparent hit area for click/drag detection */}
                    <Rect width={imgW} height={imgH} fill="transparent" />
                    <ImagePreview
                      elementType="img"
                      src={resolveAssetSrc(element.src, assetUrlResolver)}
                      width={imgW}
                      height={imgH}
                      posX={resolveNumeric(element.pos?.x, 0, bindingCtx)}
                      posY={resolveNumeric(element.pos?.y, 0, bindingCtx)}
                      bwMode={element.bwMode ?? 'threshold'}
                      bwLevel={element.bwLevel ?? 50}
                    />
                  </Group>
                );
              }

              if (element.type === 'svg') {
                const svgW = resolveNumeric(element.sizeX, 160, bindingCtx);
                const svgH = resolveNumeric(element.sizeY, 96, bindingCtx);
                return (
                  <Group
                    key={element.id}
                    {...getCommonNodeProps(element)}
                    clipX={0}
                    clipY={0}
                    clipWidth={svgW}
                    clipHeight={svgH}
                  >
                    {/* Transparent hit area for click/drag detection */}
                    <Rect width={svgW} height={svgH} fill="transparent" />
                    <ImagePreview
                      elementType="svg"
                      src={resolveAssetSrc(element.src, assetUrlResolver)}
                      svgData={element.svg}
                      width={svgW}
                      height={svgH}
                      posX={resolveNumeric(element.pos?.x, 0, bindingCtx)}
                      posY={resolveNumeric(element.pos?.y, 0, bindingCtx)}
                      bwMode={element.bwMode ?? 'threshold'}
                      bwLevel={element.bwLevel ?? 50}
                      enableFill={element.enableFill ?? false}
                      fill={element.fill ?? 100}
                      enableStroke={element.enableStroke}
                      strokeDither={element.strokeDither ?? 100}
                      strokeWidth={element.strokeWidth ?? 1}
                      strokePosition={element.strokePosition ?? 'center'}
                    />
                  </Group>
                );
              }

              return null;
            })}

          {/* Artboard mask — visually hides off-canvas elements while keeping
              them interactive (listening={false} lets clicks pass through to
              elements underneath). Uses four rects to cover the area around
              the artboard. The PAD constant must be large enough to span
              the visible canvas at maximum zoom-out. */}
          {(() => {
            const PAD = 10000;
            return (
              <Group listening={false}>
                {/* Top */}
                <Rect x={-PAD} y={-PAD} width={width + PAD * 2} height={PAD} fill={maskFill} />
                {/* Bottom */}
                <Rect x={-PAD} y={height} width={width + PAD * 2} height={PAD} fill={maskFill} />
                {/* Left */}
                <Rect x={-PAD} y={0} width={PAD} height={height} fill={maskFill} />
                {/* Right */}
                <Rect x={width} y={0} width={PAD} height={height} fill={maskFill} />
              </Group>
            );
          })()}

          {/* Line creation preview: dotted line from first click to cursor */}
          {toolMode === 'line' && lineStart && linePreviewEnd && (
            <Line
              points={[lineStart.x, lineStart.y, linePreviewEnd.x, linePreviewEnd.y]}
              stroke="#D42D32"
              strokeWidth={2}
              dash={[5, 5]}
              listening={false}
            />
          )}

          {/* First-click indicator dot */}
          {toolMode === 'line' && lineStart && (
            <Circle
              x={lineStart.x}
              y={lineStart.y}
              radius={4}
              fill="#D42D32"
              listening={false}
            />
          )}

          {/* Selected line point handles (points stored as [[x,y], ...]) */}
          {selectedElementId &&
            (() => {
              const el = elements.find((e) => e.id === selectedElementId);
              if (!el || el.type !== 'line' || !Array.isArray(el.points)) return null;
              const ox = el.pos?.x ?? 0;
              const oy = el.pos?.y ?? 0;
              return el.points.map((pt, i) => {
                if (!Array.isArray(pt)) return null;
                const [px, py] = pt;
                return (
                  <Circle
                    key={i}
                    x={ox + px}
                    y={oy + py}
                    radius={6}
                    fill="#fff"
                    stroke="#D42D32"
                    strokeWidth={2}
                    draggable
                    onDragMove={(e) => {
                      let nx = e.target.x() - ox;
                      let ny = e.target.y() - oy;

                      if (snapping.snapEnabled) {
                        const step = snapping.gridStep;
                        nx = snapToGrid(nx, step);
                        ny = snapToGrid(ny, step);
                        e.target.x(ox + nx);
                        e.target.y(oy + ny);
                      }
                      const newPoints = el.points.map((p, j) =>
                        j === i ? [nx, ny] : p,
                      );
                      updateElement(selectedElementId, { points: newPoints });
                    }}
                  />
                );
              });
            })()}

          {/* Overflow band — a fixed-flow text element whose wrapped content
              runs past its authored minimum height gets a dashed band over
              the grown region, drawn whether or not the element is selected
              (grow-down is decided server-side against live data, so the
              author must see it without hunting for it). The band's top edge
              IS the authored minimum — no second indicator. Nothing here is
              stored; it is a draw over two numbers the render already has. */}
          {!suppressOverflowBands && elements?.map((element) => {
            if (element.type !== 'text') return null;
            const layout = fixedTextLayouts[element.id];
            if (!layout) return null;
            const authoredH = resolveNumeric(element.sizeY, 0, bindingCtx);
            const overflow = textReserveOverflow(element.textFlow, authoredH, layout.height);
            if (overflow <= 0) return null;
            if (!resolveVisibilityValue(element.visible, bindingCtx, true)) return null;
            return (
              <Group
                key={`text-overflow-${element.id}`}
                x={resolveNumeric(element.pos?.x, 0, bindingCtx) + (element.origin?.x ?? 0)}
                y={resolveNumeric(element.pos?.y, 0, bindingCtx) + (element.origin?.y ?? 0)}
                rotation={resolveNumeric(element.rotationDeg, 0, bindingCtx)}
                scaleX={element.scale?.x ?? 1}
                scaleY={element.scale?.y ?? 1}
                offsetX={element.origin?.x ?? 0}
                offsetY={element.origin?.y ?? 0}
                listening={false}
              >
                <Rect
                  y={authoredH}
                  width={resolveNumeric(element.sizeX, 0, bindingCtx)}
                  height={overflow}
                  stroke="#D42D32"
                  strokeWidth={1 / zoom}
                  dash={[4 / zoom, 4 / zoom]}
                  listening={false}
                />
              </Group>
            );
          })}

          {/* Marquee selection rectangle */}
          {marquee && (
            <Rect
              x={marquee.x}
              y={marquee.y}
              width={marquee.width}
              height={marquee.height}
              fill="rgba(212, 45, 50, 0.12)"
              stroke="#D42D32"
              strokeWidth={1 / zoom}
              dash={[4 / zoom, 4 / zoom]}
              listening={false}
            />
          )}

          {/* Transformer */}
          <Transformer
            ref={transformerRef}
            rotateEnabled={true}
            // Text is resizable since the frame work: dragging any handle
            // converts the element to fixed flow and bakes the dragged
            // size(s) in handleTransformEnd. Non-text keeps Konva's default
            // (full) anchor set.
            enabledAnchors={selectedElement?.type === 'text' ? TEXT_RESIZE_ANCHORS : undefined}
            borderStroke="#D42D32"
            borderStrokeWidth={1}
            borderDash={[4, 4]}
            onTransformStart={() => setSuppressOverflowBands(true)}
            onTransformEnd={handleTransformEnd}
            boundBoxFunc={handleBoundBoxFunc}
          />

          {/* Snap guides */}
          {guides.map((guide, i) => {
            const strokeColor = guide.snap === 'center' ? '#ff0000' : '#3b82f6';
            if (guide.orientation === 'vertical') {
              return (
                <Line
                  key={i}
                  points={[guide.pos, 0, guide.pos, height]}
                  stroke={strokeColor}
                  strokeWidth={1}
                  dash={[4, 4]}
                  listening={false}
                />
              );
            }
            return (
              <Line
                key={i}
                points={[0, guide.pos, width, guide.pos]}
                stroke={strokeColor}
                strokeWidth={1}
                dash={[4, 4]}
                listening={false}
              />
            );
          })}
        </Layer>

        {/* Preview overlay layer (above all elements) */}
        {previewOverlay.enabled && (
          <Layer>
            <PreviewOverlay artboardWidth={width} artboardHeight={height} />
          </Layer>
        )}
      </Stage>
    </main>
  );
}
