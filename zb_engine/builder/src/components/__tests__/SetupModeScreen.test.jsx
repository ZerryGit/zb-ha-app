/**
 * SetupModeScreen.test.jsx — end-to-end walkthrough of the "How do you want to
 * set up?" flow (the manual setup walkthrough, automated).
 *
 * No tile is pre-selected; a click selects a tile (highlight) and opens its
 * dialog. Both the app guide's OK and the self-host dialog's Close return to the
 * chooser (keeping the selection); the user then presses "Continue to builder",
 * which only proceeds once a tile is chosen (else an inline error). The Self-Host
 * Send paths run through the real SetupModeScreen → SelfHostSetupDialog against a
 * mocked pusher, with the image URL auto-filled from the resolved host IP.
 *
 * @vitest-environment jsdom
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import SetupModeScreen from '../SetupModeScreen.jsx';
import { useUiStore } from '../../store/uiStore.js';
import { useDocStore } from '../../store/docStore.js';

// The tile icons load a 6000+ entry catalog lazily; the flow doesn't care about
// the glyph, so stub it to keep the tests fast and synchronous.
vi.mock('../TablerIcon.jsx', () => ({ default: () => null }));

const HOST_IP = '192.168.1.77';
const HOST_PORT = 8000;
const AUTO_URL = `http://${HOST_IP}:${HOST_PORT}/image.bin`;

const setPusher = (handler) => useUiStore.setState({ deviceConfigPusher: handler });
const setHost = (ip, port) => useUiStore.setState({ hostIp: ip, hostPort: port });

const appTile = () => screen.getByRole('button', { name: /Using the mobile application/ });
const selfHostTile = () => screen.getByRole('button', { name: /Self-host/ });
const continueBtn = () => screen.getByRole('button', { name: /Continue to builder/ });

afterEach(() => {
  cleanup();
  setPusher(null);
  setHost(null, null);
  vi.restoreAllMocks();
});

describe('SetupModeScreen — new-widget flow (not embedded)', () => {
  it('shows the title, both tiles, and the Continue button', () => {
    render(<SetupModeScreen onContinue={() => {}} />);
    expect(screen.getByText('How do you want to set up?')).toBeTruthy();
    expect(appTile()).toBeTruthy();
    expect(selfHostTile()).toBeTruthy();
    expect(continueBtn()).toBeTruthy();
  });

  it('does not pre-select either tile on open', () => {
    render(<SetupModeScreen onContinue={() => {}} />);
    expect(appTile().getAttribute('aria-pressed')).toBe('false');
    expect(selfHostTile().getAttribute('aria-pressed')).toBe('false');
  });

  it('Continue with nothing chosen shows an error and does not navigate', () => {
    const onContinue = vi.fn();
    render(<SetupModeScreen onContinue={onContinue} />);
    fireEvent.click(continueBtn());
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.getByText(/choose how you want to set up/i)).toBeTruthy();
  });

  it('app tile selects it + opens the guide; OK returns to the chooser, then Continue navigates', () => {
    const onContinue = vi.fn();
    render(<SetupModeScreen onContinue={onContinue} />);

    fireEvent.click(appTile());
    expect(appTile().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText(/Register and sign in to the ZerryBit app/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    // OK returns to the two tiles — it does NOT jump to the builder.
    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByText(/Register and sign in to the ZerryBit app/i)).toBeNull();
    expect(appTile().getAttribute('aria-pressed')).toBe('true');

    // The selection persists, so Continue now proceeds.
    fireEvent.click(continueBtn());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('self-host tile selects it, its Close returns to the chooser, and Continue then navigates', () => {
    const onContinue = vi.fn();
    render(<SetupModeScreen onContinue={onContinue} />);

    fireEvent.click(selfHostTile());
    expect(selfHostTile().getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Self-host setup')).toBeTruthy();

    // Footer "Close" (text) — distinct from the ✕ (aria-label only).
    fireEvent.click(screen.getByText('Close'));
    expect(screen.queryByText('Self-host setup')).toBeNull();
    expect(selfHostTile().getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(continueBtn());
    expect(onContinue).toHaveBeenCalledTimes(1);
  });
});

describe('SetupModeScreen — embedded (Settings re-open) mode', () => {
  it('has no Continue button; the ✕ closes via onContinue', () => {
    const onContinue = vi.fn();
    render(<SetupModeScreen embedded onContinue={onContinue} />);

    expect(screen.queryByRole('button', { name: /Continue to builder/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('app-guide OK returns to the chooser instead of navigating', () => {
    const onContinue = vi.fn();
    render(<SetupModeScreen embedded onContinue={onContinue} />);

    fireEvent.click(appTile());
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));

    expect(onContinue).not.toHaveBeenCalled();
    expect(screen.queryByText(/Register and sign in to the ZerryBit app/i)).toBeNull();
    expect(selfHostTile()).toBeTruthy();
  });
});

describe('SetupModeScreen — Self-Host Send paths (through the real dialog)', () => {
  function openSelfHost() {
    setHost(HOST_IP, HOST_PORT); // so the image URL auto-fills (required on Send)
    render(<SetupModeScreen onContinue={() => {}} />);
    fireEvent.click(selfHostTile());
    const dialog = screen.getByText('Self-host setup').closest('.selfhost-modal');
    return {
      ip: within(dialog).getByPlaceholderText('192.168.1.42'),
      send: within(dialog).getByRole('button', { name: 'Send' }),
    };
  }

  it('device OK (200 configured:true) → success banner; posts {deviceIp, config} with no port', async () => {
    const pusher = vi.fn(async () => ({ ok: true, status: 200, configured: true }));
    setPusher(pusher);
    const { ip, send } = openSelfHost();

    fireEvent.change(ip, { target: { value: '192.168.1.42' } });
    fireEvent.click(send);

    expect(await screen.findByText(/Device configured/)).toBeTruthy();
    expect(pusher).toHaveBeenCalledTimes(1);
    const arg = pusher.mock.calls[0][0];
    expect(arg.deviceIp).toBe('192.168.1.42');
    expect(arg).not.toHaveProperty('port');
    expect(arg.config).not.toHaveProperty('port');
    // Config defaults forwarded, with the URL auto-filled from the host endpoint.
    expect(arg.config).toMatchObject({ url: AUTO_URL, sidebar: true, sleepSec: 900 });
  });

  it('device rejects the config (proxy ok:true, status:400) → distinct "rejected" message', async () => {
    setPusher(vi.fn(async () => ({ ok: true, status: 400, body: { error: 'bad config' } })));
    const { ip, send } = openSelfHost();

    fireEvent.change(ip, { target: { value: '192.168.1.42' } });
    fireEvent.click(send);

    expect(await screen.findByText(/rejected the config/)).toBeTruthy();
    expect(screen.queryByText(/Device configured/)).toBeNull();
  });

  it('proxy/network failure (thrown Error) → the friendly error message is surfaced', async () => {
    const msg = "Couldn't reach the device. Make sure it's on the Self-Host Setup screen and on the same network.";
    setPusher(vi.fn(async () => { throw new Error(msg); }));
    const { ip, send } = openSelfHost();

    fireEvent.change(ip, { target: { value: '192.168.1.42' } });
    fireEvent.click(send);

    expect(await screen.findByText(msg)).toBeTruthy();
  });
});

describe('SetupModeScreen — self-host success → Continue sizes the canvas', () => {
  // Seed a focused primary doc so setFocusedFullScreen has a target. A fresh
  // doc is 720×480 (default 'panel' mode); the pin overwrites it regardless.
  function seedFocusedDoc(id = 'w1') {
    const ds = useDocStore.getState();
    ds.newDoc(id);
    ds.switchFocus(id);
    return id;
  }

  function miscOf(id) {
    return useDocStore.getState().docs[id].doc.misc;
  }

  // Render the flow, open the self-host dialog, optionally uncheck the sidebar,
  // then drive a form-valid successful send. Returns the onContinue spy.
  function sendSelfHostOk({ embedded = false, uncheckSidebar = false } = {}) {
    setPusher(vi.fn(async () => ({ ok: true, status: 200, configured: true })));
    setHost(HOST_IP, HOST_PORT);
    const onContinue = vi.fn();
    render(<SetupModeScreen embedded={embedded} onContinue={onContinue} />);
    fireEvent.click(selfHostTile());
    const dialog = screen.getByText('Self-host setup').closest('.selfhost-modal');
    if (uncheckSidebar) {
      fireEvent.click(within(dialog).getByRole('checkbox', { name: /Sidebar column/ }));
    }
    fireEvent.change(within(dialog).getByPlaceholderText('192.168.1.42'), {
      target: { value: '192.168.1.42' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send' }));
    return { onContinue };
  }

  afterEach(() => {
    useDocStore.setState({ docs: {}, focusedDocId: null });
  });

  it('welcome flow, sidebar ON → pins the widget to the full screen at 720×480', async () => {
    seedFocusedDoc('w1');
    const { onContinue } = sendSelfHostOk();
    await screen.findByText(/Device configured/);

    // The dialog's own Continue (exact "Continue") — distinct from the tiles'
    // "Continue to builder →" button.
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(miscOf('w1').size).toEqual({ width: 720, height: 480 });
    expect(miscOf('w1').gridSize).toBe('3x2');
  });

  it('welcome flow, sidebar OFF → pins the widget to the full screen at 800×480', async () => {
    seedFocusedDoc('w1');
    const { onContinue } = sendSelfHostOk({ uncheckSidebar: true });
    await screen.findByText(/Device configured/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(miscOf('w1').size).toEqual({ width: 800, height: 480 });
    expect(miscOf('w1').gridSize).toBe('3x2');
    // 800×480 differs from the fresh 720×480 baseline, so the pin is a real
    // change — the doc must be dirty so auto-save persists the new size.
    expect(useDocStore.getState().docs.w1.dirty).toBe(true);
  });

  it('welcome flow, sidebar OFF → the 800×480 pin survives a later metadata edit', async () => {
    seedFocusedDoc('w1');
    const { onContinue } = sendSelfHostOk({ uncheckSidebar: true });
    await screen.findByText(/Device configured/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(miscOf('w1').size).toEqual({ width: 800, height: 480 });

    // Simulate renaming the widget in the Widget tab (LeftPanel → updateMisc).
    // With the real displayConfigStore (widgetMode 'panel' = 720×480) this used
    // to silently revert the canvas to 720×480 on the first keystroke.
    useDocStore.getState().updateMisc({ name: 'Hallway' });
    expect(miscOf('w1').size).toEqual({ width: 800, height: 480 });
  });

  it('embedded (Settings) flow → navigates but never resizes the existing widget', async () => {
    seedFocusedDoc('w1');
    const before = { ...miscOf('w1').size };
    // Uncheck sidebar so a mistaken resize would flip 720→800 and fail the assert.
    const { onContinue } = sendSelfHostOk({ embedded: true, uncheckSidebar: true });
    await screen.findByText(/Device configured/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(miscOf('w1').size).toEqual(before);
  });
});
