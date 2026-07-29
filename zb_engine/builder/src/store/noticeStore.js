/**
 * noticeStore.js — In-app "popup message" primitive
 *
 * The builder's general-purpose way to tell the user something. Browser
 * dialogs are banned (ENGINEERING_CONSTRAINTS.md §2), and `ConfirmModal`
 * only covers questions with a yes/no answer — this covers the
 * informational case: one message, one button, no decision to make.
 *
 * Deliberately minimal. One notice at a time (showing a second replaces the
 * first), no queue, no severity levels, no auto-dismiss timers, no
 * positioning. Anything that needs more than this should make its case
 * before growing this store.
 *
 * Rendered by `components/NoticeModal.jsx`, mounted once at the app root.
 * This module is platform-agnostic (no imports from platform/).
 */

import { create } from 'zustand';

export const useNoticeStore = create((set) => ({
  /** The visible notice: { title, message, buttonLabel }, or null when none. */
  notice: null,

  /** Show a notice, replacing any currently visible one. */
  showNotice({ title, message, buttonLabel = 'Got it' } = {}) {
    set({ notice: { title, message, buttonLabel } });
  },

  /** Dismiss the visible notice. */
  dismissNotice() {
    set({ notice: null });
  },
}));
