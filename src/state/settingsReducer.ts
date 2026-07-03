// ─────────────────────────────────────────────────────────────────────────
// Settings — pure reducer (code-audit item A-1).
//
// Holds the committed settings, the modal's edit draft, the modal visibility,
// and the runtime audit-log flag. The draft/commit dance is atomic:
// OPEN_SETTINGS snapshots settings → draft and opens in one action;
// COMMIT_DRAFT promotes draft → settings, syncs auditLogEnabled, and closes
// in one action (previously three consecutive setState calls after the
// save_settings IPC). Persistence (save_settings invoke, the
// dbark_audit_log localStorage key) stays at the dispatch sites — side
// effects never live in the reducer. Pure — no DOM, no IPC.
// ─────────────────────────────────────────────────────────────────────────

import type { AppSettings } from "../types";
import { DEFAULT_SETTINGS } from "../appState";

export interface SettingsState {
  /** Committed, app-wide settings. */
  settings: AppSettings;
  /** The modal's working copy — edits land here until Save. */
  draft: AppSettings;
  /** Whether the settings modal is open. */
  showSettings: boolean;
  /**
   * Runtime audit-log flag. Mirrors settings.auditLogEnabled on load/commit
   * but can also be toggled independently at runtime (the sidebar button).
   */
  auditLogEnabled: boolean;
}

export type SettingsAction =
  /** Initial load from disk: set settings AND derive the audit flag — atomically. */
  | { type: "LOAD_SETTINGS"; settings: AppSettings }
  /** Open the modal with a fresh draft snapshotted from committed settings. */
  | { type: "OPEN_SETTINGS" }
  /**
   * Plain open/close without touching the draft. Parity: the command-palette
   * open uses this (it never refreshed the draft), as do the three closes.
   */
  | { type: "SET_SETTINGS_OPEN"; open: boolean }
  /** Merge one or more edited fields into the draft. */
  | { type: "UPDATE_DRAFT"; patch: Partial<AppSettings> }
  /** Reset the draft to factory defaults (the modal's Reset button). */
  | { type: "RESET_DRAFT" }
  /** Save: promote draft → settings, sync the audit flag, close — atomically. */
  | { type: "COMMIT_DRAFT" }
  /** Set the runtime audit flag (localStorage restore + sidebar toggle). */
  | { type: "SET_AUDIT_LOG"; enabled: boolean };

export function settingsReducer(
  state: SettingsState,
  action: SettingsAction,
): SettingsState {
  switch (action.type) {
    case "LOAD_SETTINGS":
      return {
        ...state,
        settings: action.settings,
        auditLogEnabled: action.settings.auditLogEnabled,
      };

    case "OPEN_SETTINGS":
      return { ...state, draft: { ...state.settings }, showSettings: true };

    case "SET_SETTINGS_OPEN":
      return { ...state, showSettings: action.open };

    case "UPDATE_DRAFT":
      return { ...state, draft: { ...state.draft, ...action.patch } };

    case "RESET_DRAFT":
      return { ...state, draft: DEFAULT_SETTINGS };

    case "COMMIT_DRAFT":
      return {
        ...state,
        settings: state.draft,
        auditLogEnabled: state.draft.auditLogEnabled,
        showSettings: false,
      };

    case "SET_AUDIT_LOG":
      return { ...state, auditLogEnabled: action.enabled };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — defaults everywhere, modal closed, audit off. */
export function initSettingsState(): SettingsState {
  return {
    settings: DEFAULT_SETTINGS,
    draft: DEFAULT_SETTINGS,
    showSettings: false,
    auditLogEnabled: false,
  };
}
