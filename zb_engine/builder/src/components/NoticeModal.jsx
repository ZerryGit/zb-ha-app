/**
 * NoticeModal.jsx — Renders the one-at-a-time notice from noticeStore
 *
 * ENGINEERING_CONSTRAINTS §2: NO BROWSER DIALOGS. This is the in-app
 * replacement for alert() — a single message with a single dismiss button.
 * For a yes/no question use ConfirmModal instead.
 *
 * Mounted ONCE at the app root (App.jsx); renders nothing when no notice is
 * showing. Callers never render it themselves — they call
 * `useNoticeStore.getState().showNotice(...)`. Follows ConfirmModal's
 * overlay/modal markup and CSS classes.
 */

import { useNoticeStore } from '../store/noticeStore.js';

export default function NoticeModal() {
  const notice = useNoticeStore((s) => s.notice);
  const dismissNotice = useNoticeStore((s) => s.dismissNotice);

  if (!notice) return null;

  return (
    <div className="modal-overlay" onClick={dismissNotice}>
      <div
        className="confirm-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--c-surface)',
          borderRadius: 'var(--radius)',
          boxShadow: 'var(--shadow)',
          padding: 'var(--sp-6)',
          maxWidth: '400px',
          width: '90%',
        }}
      >
        {notice.title && (
          <p style={{ margin: '0 0 var(--sp-3) 0', fontSize: 'var(--text-base)', fontWeight: 'bold' }}>
            {notice.title}
          </p>
        )}
        <p style={{ margin: '0 0 var(--sp-5) 0', fontSize: 'var(--text-base)', lineHeight: 1.5 }}>
          {notice.message}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={dismissNotice}>
            {notice.buttonLabel || 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}
