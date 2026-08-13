/**
 * BusyOverlay.test.jsx — centered spinner for slow user-initiated actions.
 *
 * The overlay exists so a multi-second server render (remote image fetches
 * are 5 s each and element draws are sequential) doesn't read as a hang. The
 * behaviours worth pinning are the ones that make it helpful rather than
 * noisy: it stays silent through a fast action, it names the action once it
 * does appear, it only starts counting seconds after the wait stops being
 * brief, and overlapping actions can't clear each other's overlay.
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import BusyOverlay from '../BusyOverlay.jsx';
import { useUiStore } from '../../store/uiStore.js';

// Mirrors the constants in BusyOverlay.jsx.
const SHOW_AFTER_MS = 250;
const ELAPSED_AFTER_MS = 1500;

// `act()` returns a thenable, not the callback's value, so the token has to
// be captured out of the closure rather than read from the act() return.
const begin = (label) => {
  let token;
  act(() => {
    token = useUiStore.getState().beginBusyTask(label);
  });
  return token;
};

const end = (token) => {
  act(() => {
    useUiStore.getState().endBusyTask(token);
  });
};

/** Advance timers inside act() so the resulting re-render is flushed. */
const advance = async (ms) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

const card = () => screen.queryByRole('status');

beforeEach(() => {
  vi.useFakeTimers();
  useUiStore.setState({ busyTasks: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useUiStore.setState({ busyTasks: [] });
});

describe('BusyOverlay', () => {
  it('renders nothing while no task is running', () => {
    render(<BusyOverlay />);
    expect(card()).toBeNull();
  });

  it('stays hidden through an action that finishes before the show delay', async () => {
    render(<BusyOverlay />);

    const token = begin('Rendering preview…');
    await advance(SHOW_AFTER_MS - 50);
    expect(card()).toBeNull();

    end(token);
    await advance(1000);
    expect(card()).toBeNull();
  });

  it('appears with the task label once the action outlasts the show delay', async () => {
    render(<BusyOverlay />);

    begin('Deploying…');
    await advance(SHOW_AFTER_MS + 50);

    expect(card()).not.toBeNull();
    expect(screen.getByText('Deploying…')).toBeTruthy();
  });

  it('withholds the elapsed counter until the wait stops being brief', async () => {
    render(<BusyOverlay />);

    begin('Refreshing data…');
    await advance(SHOW_AFTER_MS + 50);
    expect(screen.queryByText(/^\d+s$/)).toBeNull();

    await advance(ELAPSED_AFTER_MS);
    expect(screen.getByText(/^\d+s$/)).toBeTruthy();
  });

  it('hides again when the task ends', async () => {
    render(<BusyOverlay />);

    const token = begin('Deploying…');
    await advance(SHOW_AFTER_MS + 50);
    expect(card()).not.toBeNull();

    end(token);
    expect(card()).toBeNull();
  });

  it('keeps the overlay up when one of two overlapping tasks finishes', async () => {
    render(<BusyOverlay />);

    const first = begin('Refreshing data…');
    begin('Deploying…');
    await advance(SHOW_AFTER_MS + 50);

    // Most recent task owns the label.
    expect(screen.getByText('Deploying…')).toBeTruthy();

    end(first);
    expect(card()).not.toBeNull();
    expect(screen.getByText('Deploying…')).toBeTruthy();
  });

  it('ignores an unknown token rather than clearing a live task', async () => {
    render(<BusyOverlay />);

    begin('Deploying…');
    await advance(SHOW_AFTER_MS + 50);

    end(9999);
    expect(card()).not.toBeNull();
  });
});
