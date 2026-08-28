/**
 * QrDropdown.jsx — Pairing QR dropdown (platform)
 *
 * Small "QR" button in the top bar, next to the device-endpoint readout.
 * Clicking it opens a dropdown with a locally rendered QR code that the
 * ZerryBit mobile app scans to pair the active widget. The QR encodes the
 * versioned pairing contract JSON:
 *
 *   { v, url, fsUrl, id, fs, w, h, name }
 *
 * `id`/`fs` are the server-assigned pairing IDs from the widget envelope;
 * `fs` is 0 while the widget has no fullscreen companion (the sticky
 * fullscreen ID re-activates if the companion is re-created). `w`/`h` are
 * the PRIMARY slot's persisted pixel size, so the app can lay the widget
 * out before it ever fetches a frame — the fullscreen slot has no
 * counterpart in v1 (see the note at `qrText`). `name` is truncated to the
 * contract cap (50 chars).
 *
 * ENGINEERING_CONSTRAINTS: stays fully local — `qrcode` is a bundled npm
 * dep rendered to a canvas, no CDN/external fetch. No browser dialogs —
 * every edge state (host IP unresolved, no widget, unsaved widget) is an
 * inline notice. The absolute `http://<ip>:<port>` URLs are DEVICE-facing
 * content, same as the endpoint span — the builder relative-paths rule
 * applies to the SPA's own fetches, not to content shown for devices.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import QRCode from 'qrcode';
import { useWidgetStore } from './widgetStore.js';
import { useUiStore } from '../store/uiStore.js';
import { useDocStore } from '../store/docStore.js';
import { fullscreenIdFor } from '../store/companionId.js';
import { truncateName } from '../utils/truncateName.js';
import TablerIcon from '../components/TablerIcon.jsx';

// Default ESP32 image host port (config.yaml maps container 8000/tcp -> 8000).
// Used when the Supervisor-reported host-port mapping is unavailable.
// Owned here (the device-URL builder); TopBar imports it for the endpoint span.
export const DEFAULT_IMAGE_HOST_PORT = 8000;

/** QR payload format version — bump only with the mobile-app contract. */
const QR_PAYLOAD_VERSION = 1;

/** Rendered QR canvas edge length in CSS pixels. */
const QR_CANVAS_PX = 192;

export default function QrDropdown() {
  const hostIp = useUiStore((s) => s.hostIp);
  const hostPort = useUiStore((s) => s.hostPort);
  const activeWidgetId = useWidgetStore((s) => s.activeWidgetId);
  const activeWidgetName = useWidgetStore((s) => s.activeWidgetName);
  const activePairingId = useWidgetStore((s) => s.activePairingId);
  const activeFullscreenPairingId = useWidgetStore((s) => s.activeFullscreenPairingId);
  const activeWidgetWidth = useWidgetStore((s) => s.activeWidgetWidth);
  const activeWidgetHeight = useWidgetStore((s) => s.activeWidgetHeight);
  // `fs` reports the REAL id only while a companion doc actually exists;
  // the sticky stored id alone is not enough (deleted companion -> fs: 0).
  const hasFullscreen = useDocStore((s) =>
    Boolean(s.docs[fullscreenIdFor(activeWidgetId)]),
  );

  const [open, setOpen] = useState(false);
  const [qrError, setQrError] = useState(false);
  const rootRef = useRef(null);
  const canvasRef = useRef(null);

  const qrText = useMemo(() => {
    if (!hostIp || !activePairingId) return null;
    const base = `http://${hostIp}:${hostPort || DEFAULT_IMAGE_HOST_PORT}`;
    const fs = hasFullscreen && activeFullscreenPairingId ? activeFullscreenPairingId : 0;
    return JSON.stringify({
      v: QR_PAYLOAD_VERSION,
      url: `${base}/image.bin`,
      fsUrl: `${base}/image_fullscreen.bin`,
      id: activePairingId,
      fs,
      // PRIMARY-slot pixel size as the server persisted it. Present for any
      // widget that has a pairing ID at all (both arrive from the same save
      // response, and `misc.size` is schema-required), so the spread only
      // guards a malformed on-disk record — better to omit the keys than to
      // publish a size the renderer would disagree with.
      //
      // No fullscreen counterpart in v1: the app treats the fs slot as
      // 720x480 (the default Display Mode) and the authoritative size is in
      // every frame header — see ignore/handoff-mobile-app.md.
      ...(activeWidgetWidth && activeWidgetHeight
        ? { w: activeWidgetWidth, h: activeWidgetHeight }
        : {}),
      name: truncateName(activeWidgetName),
    });
  }, [
    hostIp,
    hostPort,
    activePairingId,
    activeFullscreenPairingId,
    hasFullscreen,
    activeWidgetWidth,
    activeWidgetHeight,
    activeWidgetName,
  ]);

  // Render the QR into the canvas whenever the dropdown is open and the
  // payload changes (rename, companion added/removed, save minted an ID).
  useEffect(() => {
    if (!open || !qrText || !canvasRef.current) return;
    setQrError(false);
    QRCode.toCanvas(canvasRef.current, qrText, { width: QR_CANVAS_PX, margin: 2 })
      .catch(() => setQrError(true));
  }, [open, qrText]);

  // Close on click-outside / Esc while open.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  let content = null;
  if (open) {
    if (!hostIp) {
      content = <div className="topbar-qr-note">Waiting for the Home Assistant host IP…</div>;
    } else if (!activeWidgetId) {
      content = <div className="topbar-qr-note">Select a widget to generate its pairing QR.</div>;
    } else if (!activePairingId) {
      content = <div className="topbar-qr-note">Save this widget once to generate its pairing QR.</div>;
    } else {
      const fs = hasFullscreen && activeFullscreenPairingId ? activeFullscreenPairingId : 0;
      // Keep the canvas mounted even on a render error so the draw effect
      // can retry when the payload changes (it needs the ref to exist).
      content = (
        <>
          <canvas
            ref={canvasRef}
            className="topbar-qr-canvas"
            width={QR_CANVAS_PX}
            height={QR_CANVAS_PX}
            style={qrError ? { display: 'none' } : undefined}
          />
          {qrError ? (
            <div className="topbar-qr-note">Could not render the QR code.</div>
          ) : (
            <>
              <div className="topbar-qr-name">{truncateName(activeWidgetName)}</div>
              <div className="topbar-qr-ids">
                ID {activePairingId} · FS {fs}
                {activeWidgetWidth && activeWidgetHeight
                  ? ` · ${activeWidgetWidth}×${activeWidgetHeight}`
                  : ''}
              </div>
            </>
          )}
        </>
      );
    }
  }

  return (
    <div className="topbar-qr" ref={rootRef}>
      <button
        className="topbar-btn topbar-qr-btn"
        onClick={() => setOpen((o) => !o)}
        title="Pairing QR code"
        aria-label="Pairing QR code"
      >
        <TablerIcon name="qrcode" size={24} />
      </button>
      {open && <div className="topbar-qr-dropdown">{content}</div>}
    </div>
  );
}
