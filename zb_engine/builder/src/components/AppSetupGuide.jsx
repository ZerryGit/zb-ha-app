/**
 * AppSetupGuide.jsx — "Using the mobile application" how-to guide
 *
 * Opened from the recommended tile on SetupModeScreen. Shows the five pairing
 * steps; the OK button hands control back to the parent (which enters the canvas
 * builder on the new-widget flow, or just returns to the tile chooser when
 * re-opened from Settings).
 *
 * Follows the ConfirmModal `modal-overlay` pattern — all feedback is in-app, no
 * browser dialogs (Constraint U2). Platform-agnostic (core).
 */

import PropTypes from 'prop-types';

export default function AppSetupGuide({ onOk }) {
  return (
    <div className="modal-overlay">
      <div
        className="setup-guide-modal"
        style={{
          background: 'var(--c-surface)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow)',
          padding: 'var(--sp-6)',
          maxWidth: '440px',
          width: '90%',
          textAlign: 'center',
        }}
      >
        <h2 className="setup-title" style={{ marginTop: 0, fontSize: 'var(--text-lg)' }}>
          Using the mobile application
        </h2>
        <ol className="setup-guide-steps">
          <li>
            Register and sign in to the ZerryBit app, then add a Home Assistant widget to your
            phone&apos;s screen.
          </li>
          <li>Tap the widget to open its editing menu.</li>
          <li>Tap &ldquo;Scan QR code&rdquo;.</li>
          <li>
            Every widget in Home Assistant add-on has its own QR code. Open it from the QR button in the top bar and
            scan it.
          </li>
          <li>Done. The widget is connected.</li>
        </ol>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <button type="button" className="btn btn-primary" onClick={onOk}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

AppSetupGuide.propTypes = {
  onOk: PropTypes.func.isRequired,
};
