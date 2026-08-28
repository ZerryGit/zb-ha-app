/**
 * QrDropdown.test.jsx — Pairing QR dropdown states + payload contract.
 *
 * Verifies the §1.3 QR JSON contract (key order, fs:0 edge, w/h primary
 * size, 50-char name truncation) and the inline notice states (unresolved
 * host IP, no widget, unsaved widget). `qrcode` is mocked — jsdom has no
 * canvas 2D context; the REAL rendering is covered by the manual
 * dev-server check.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('qrcode', () => ({
  default: { toCanvas: vi.fn(() => Promise.resolve()) },
}));

vi.mock('../apiClient.js', () => ({
  listWidgets: vi.fn(() => Promise.resolve({ widgets: [] })),
  loadWidget: vi.fn(),
  saveWidget: vi.fn(() => Promise.resolve()),
  newWidgetId: vi.fn(() => Promise.resolve('w_new')),
  deleteWidget: vi.fn(() => Promise.resolve()),
}));

import QRCode from 'qrcode';
import QrDropdown from '../QrDropdown.jsx';
import { useWidgetStore } from '../widgetStore.js';
import { useUiStore } from '../../store/uiStore.js';
import { useDocStore } from '../../store/docStore.js';
import { fullscreenIdFor } from '../../store/companionId.js';

function reset() {
  cleanup();
  useDocStore.setState({ focusedDocId: null, docs: {} });
  useWidgetStore.setState({
    widgets: [],
    activeWidgetId: null,
    activeWidgetName: '',
    activePairingId: null,
    activeFullscreenPairingId: null,
    activeWidgetWidth: null,
    activeWidgetHeight: null,
    loading: false,
    saving: false,
    error: null,
  });
  useUiStore.setState({ hostIp: null, hostPort: null });
  vi.clearAllMocks();
}

function openDropdown() {
  render(<QrDropdown />);
  fireEvent.click(screen.getByTitle('Pairing QR code'));
}

/** The JSON text the (mocked) QR renderer was asked to encode. */
function encodedText() {
  expect(QRCode.toCanvas).toHaveBeenCalled();
  return QRCode.toCanvas.mock.calls[0][1];
}

describe('QrDropdown', () => {
  beforeEach(reset);

  it('shows the host-IP notice while the HA host IP is unresolved', () => {
    useWidgetStore.setState({ activeWidgetId: 'w1', activePairingId: 482915637 });

    openDropdown();

    expect(screen.getByText('Waiting for the Home Assistant host IP…')).toBeTruthy();
    expect(QRCode.toCanvas).not.toHaveBeenCalled();
  });

  it('shows the select-a-widget notice when no widget is active', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });

    openDropdown();

    expect(screen.getByText('Select a widget to generate its pairing QR.')).toBeTruthy();
  });

  it('shows the unsaved-widget notice when the widget has no pairing ID yet', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });
    useWidgetStore.setState({ activeWidgetId: 'w1', activeWidgetName: 'New one' });

    openDropdown();

    expect(screen.getByText('Save this widget once to generate its pairing QR.')).toBeTruthy();
    expect(QRCode.toCanvas).not.toHaveBeenCalled();
  });

  it('encodes the v1 contract JSON with fs:0 when no fullscreen companion exists', () => {
    useUiStore.setState({ hostIp: '192.168.1.23', hostPort: null });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'Kitchen panel',
      activePairingId: 482915637,
      // Sticky stored ID without a live companion must NOT surface in `fs`.
      activeFullscreenPairingId: 193847265,
      activeWidgetWidth: 240,
      activeWidgetHeight: 240,
    });

    openDropdown();

    const payload = JSON.parse(encodedText());
    expect(Object.keys(payload)).toEqual(['v', 'url', 'fsUrl', 'id', 'fs', 'w', 'h', 'name']);
    expect(payload).toEqual({
      v: 1,
      url: 'http://192.168.1.23:8000/image.bin',
      fsUrl: 'http://192.168.1.23:8000/image_fullscreen.bin',
      id: 482915637,
      fs: 0,
      w: 240,
      h: 240,
      name: 'Kitchen panel',
    });
    expect(screen.getByText('ID 482915637 · FS 0 · 240×240')).toBeTruthy();
  });

  it('encodes the persisted primary size, not a grid-derived guess', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'Wide one',
      activePairingId: 482915637,
      // A 2x1 widget on the 'full' 800×480 preset — neither dimension is a
      // round multiple of the legacy 240px grid unit.
      activeWidgetWidth: 533,
      activeWidgetHeight: 240,
    });

    openDropdown();

    const payload = JSON.parse(encodedText());
    expect(payload.w).toBe(533);
    expect(payload.h).toBe(240);
    expect(screen.getByText('ID 482915637 · FS 0 · 533×240')).toBeTruthy();
  });

  it('omits w/h when the persisted size is unknown, keeping the rest of the contract', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'Sizeless',
      activePairingId: 482915637,
      activeWidgetWidth: null,
      activeWidgetHeight: null,
    });

    openDropdown();

    const payload = JSON.parse(encodedText());
    expect(Object.keys(payload)).toEqual(['v', 'url', 'fsUrl', 'id', 'fs', 'name']);
    expect(payload.id).toBe(482915637);
    expect(screen.getByText('ID 482915637 · FS 0')).toBeTruthy();
  });

  it('encodes the real fullscreen ID when the companion doc exists', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'Kitchen panel',
      activePairingId: 482915637,
      activeFullscreenPairingId: 193847265,
    });
    useDocStore.setState({
      docs: { [fullscreenIdFor('w1')]: { doc: {}, dirty: false } },
    });

    openDropdown();

    const payload = JSON.parse(encodedText());
    expect(payload.fs).toBe(193847265);
    expect(screen.getByText('ID 482915637 · FS 193847265')).toBeTruthy();
  });

  it('uses the Supervisor-reported host port when available', () => {
    useUiStore.setState({ hostIp: '10.0.0.5', hostPort: 8123 });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: 'A',
      activePairingId: 482915637,
    });

    openDropdown();

    const payload = JSON.parse(encodedText());
    expect(payload.url).toBe('http://10.0.0.5:8123/image.bin');
    expect(payload.fsUrl).toBe('http://10.0.0.5:8123/image_fullscreen.bin');
  });

  it('truncates names longer than 50 chars to 47 + "..." in the payload', () => {
    const longName = 'x'.repeat(60);
    useUiStore.setState({ hostIp: '192.168.1.23' });
    useWidgetStore.setState({
      activeWidgetId: 'w1',
      activeWidgetName: longName,
      activePairingId: 482915637,
    });

    openDropdown();

    const payload = JSON.parse(encodedText());
    expect(payload.name).toBe(`${'x'.repeat(47)}...`);
    expect(payload.name.length).toBe(50);
  });

  it('closes on Escape', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });

    openDropdown();
    expect(screen.getByText('Select a widget to generate its pairing QR.')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('Select a widget to generate its pairing QR.')).toBeNull();
  });

  it('closes on click-outside but stays open on inside clicks', () => {
    useUiStore.setState({ hostIp: '192.168.1.23' });

    openDropdown();
    fireEvent.mouseDown(screen.getByText('Select a widget to generate its pairing QR.'));
    expect(screen.getByText('Select a widget to generate its pairing QR.')).toBeTruthy();

    fireEvent.mouseDown(document.body);

    expect(screen.queryByText('Select a widget to generate its pairing QR.')).toBeNull();
  });
});
