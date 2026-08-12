/**
 * CanvasDataStatus.jsx — Canvas data-freshness pill + "Refresh data" button.
 *
 * The builder canvas resolves bound values from a cache of last-fetched source
 * responses (`uiStore.sourceResponsesById`) that is, by design, only populated
 * on initial load and on source-config edits — it does not poll. So the canvas
 * can drift behind the live values shown by the server Preview render. This
 * control makes that staleness honest (a "fetched Xm ago" pill, read from each
 * entry's previously-unused `receivedAt`) and fixable (one click re-fetches
 * every source through the throttled queue and re-renders the Preview, so both
 * surfaces update together).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUiStore } from '../store/uiStore.js';
import { formatTimeAgo } from '../utils/timeAgo.js';
import { renderFocusedPreview } from '../utils/renderPreview.js';
import { isSourceFetchable, refreshAllSources } from './sourceRefresh.js';
import TablerIcon from '../components/TablerIcon.jsx';

/** Pill turns amber once the oldest fetched value is older than this (ms). */
const STALE_AFTER_MS = 5 * 60 * 1000;

/** How often (ms) to re-tick the relative-time label. */
const TICK_MS = 30_000;

export default function CanvasDataStatus({ sources }) {
  const sourceResponsesById = useUiStore((s) => s.sourceResponsesById);
  const pending = useUiStore((s) => s.pendingSourceTests);
  const hasHandler = useUiStore((s) => Boolean(s.sourceTestHandler));

  const fetchable = useMemo(
    () => (sources ?? []).filter(isSourceFetchable),
    [sources],
  );

  // Oldest fetch time across cached sources — the canvas is only as fresh as
  // its stalest binding, so surface the worst case.
  const { oldestEpoch, cachedCount } = useMemo(() => {
    let oldest = null;
    let cached = 0;
    for (const s of fetchable) {
      const receivedAt = sourceResponsesById[s.id]?.receivedAt;
      if (!receivedAt) continue;
      const t = new Date(receivedAt).getTime();
      if (!Number.isFinite(t)) continue;
      cached += 1;
      if (oldest == null || t < oldest) oldest = t;
    }
    return { oldestEpoch: oldest, cachedCount: cached };
  }, [fetchable, sourceResponsesById]);

  // Self-tick so "Xm ago" stays current. UI-only — never fetches. Paused
  // while the tab is hidden so a background editor does no needless work.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (oldestEpoch == null) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setTick((n) => n + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [oldestEpoch]);

  const handleRefresh = useCallback(() => {
    refreshAllSources(sources);
    // Also refresh the server Preview so the canvas and Preview agree from one
    // click. Fire-and-forget — a render failure must not block the data fetch.
    // The spinner tracks the render (the slow half, which waits on remote
    // assets); the source fetches report their own progress in the pill above.
    const busyToken = useUiStore.getState().beginBusyTask('Refreshing data…');
    renderFocusedPreview()
      .catch(() => {})
      .finally(() => useUiStore.getState().endBusyTask(busyToken));
  }, [sources]);

  // Nothing to be fresh/stale about with no fetchable sources — stay out of
  // the way rather than show an empty pill.
  if (fetchable.length === 0) return null;

  const refreshing = pending > 0;
  const isStale = oldestEpoch != null && Date.now() - oldestEpoch > STALE_AFTER_MS;
  const notFetched = fetchable.length - cachedCount;

  let label;
  let title;
  if (refreshing) {
    label = `Refreshing ${pending}…`;
    title = `Fetching live values for ${pending} source${pending === 1 ? '' : 's'}.`;
  } else if (oldestEpoch == null) {
    label = hasHandler ? 'Not fetched' : 'No live data';
    title = hasHandler
      ? 'Canvas data has not been fetched yet — click to fetch live values.'
      : 'Live data is unavailable in this build.';
  } else {
    label = formatTimeAgo(oldestEpoch);
    title =
      `Canvas shows the last fetched values (oldest ${formatTimeAgo(oldestEpoch)}).` +
      (notFetched > 0 ? ` ${notFetched} source${notFetched === 1 ? '' : 's'} not fetched yet.` : '') +
      ' Click to re-fetch all sources and refresh the preview.';
  }

  return (
    <div className="toolbox-group" title={title}>
      <span
        className="toolbox-label"
        style={{
          fontSize: '0.8em',
          whiteSpace: 'nowrap',
          maxWidth: '8em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          color: isStale && !refreshing ? 'var(--c-warning, #f0a500)' : undefined,
          opacity: 0.85,
          userSelect: 'none',
        }}
      >
        {label}
      </span>
      <button
        className="toolbox-btn"
        title="Refresh data (re-fetch all sources + preview)"
        onClick={handleRefresh}
        disabled={refreshing || !hasHandler}
      >
        <TablerIcon name="refresh" />
      </button>
    </div>
  );
}
