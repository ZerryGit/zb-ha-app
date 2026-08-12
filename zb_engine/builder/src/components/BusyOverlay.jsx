/**
 * BusyOverlay.jsx — Centered spinner for slow user-initiated actions.
 *
 * Server renders wait on remote assets (IMAGE_FETCH_TIMEOUT_MS is 5 s per
 * image, and element draws are sequential), so Preview / Refresh data /
 * Deploy can sit for several seconds with nothing moving on screen. A frozen
 * button is indistinguishable from a hang, so this shows what is running and
 * — once the wait stops being brief — how long it has been running.
 *
 * Driven by `uiStore.busyTasks`; see `beginBusyTask` / `endBusyTask`.
 *
 * Two deliberate choices:
 *  - SHOW_AFTER_MS delay: a cached render finishes in well under a frame or
 *    two, and a spinner that flashes on every fast action is worse than no
 *    spinner at all.
 *  - `pointer-events: none`: the triggering buttons already disable
 *    themselves, so the overlay never needs to trap input — which also means
 *    a task that somehow never settles cannot lock the user out of the app.
 */

import { useEffect, useState } from 'react';
import { useUiStore } from '../store/uiStore.js';

/** Don't paint anything until an action has run at least this long (ms). */
const SHOW_AFTER_MS = 250;

/** Start showing elapsed seconds once the wait passes this (ms). */
const ELAPSED_AFTER_MS = 1500;

/** How often (ms) to re-tick the elapsed-seconds readout. */
const TICK_MS = 500;

export default function BusyOverlay() {
  const busyTasks = useUiStore((s) => s.busyTasks);
  const active = busyTasks.length > 0;

  // Most recent task wins the label — it's the one the user just triggered.
  const label = active ? busyTasks[busyTasks.length - 1].label : null;

  const [visible, setVisible] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      setElapsedMs(0);
      return undefined;
    }

    const startedAt = Date.now();
    const showTimer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    const tick = setInterval(() => setElapsedMs(Date.now() - startedAt), TICK_MS);

    return () => {
      clearTimeout(showTimer);
      clearInterval(tick);
    };
  }, [active]);

  if (!active || !visible) return null;

  const showElapsed = elapsedMs >= ELAPSED_AFTER_MS;

  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-overlay-card">
        <span className="busy-spinner" aria-hidden="true" />
        <span className="busy-overlay-label">{label}</span>
        {showElapsed && (
          <span className="busy-overlay-elapsed">{Math.round(elapsedMs / 1000)}s</span>
        )}
      </div>
    </div>
  );
}
