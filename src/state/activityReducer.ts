// ─────────────────────────────────────────────────────────────────────────
// Activity panel — pure reducer (code-audit item A-1).
//
// Holds the live-server-activity panel: visibility, rows, error + error code,
// loading flag, and the kill-session confirmation. The load lifecycle is
// atomic: LOAD_SUCCESS sets the rows AND clears both error fields in one
// action; LOAD_ERROR sets both error fields AND clears the rows — previously
// three separate setState calls at four different call sites. The `silent`
// flag on LOAD_START/LOAD_DONE reproduces the poll behaviour: a silent
// refresh never touches the loading flag, so the 5-second poll doesn't
// flicker the spinner. Pure — no DOM, no IPC.
// ─────────────────────────────────────────────────────────────────────────

import type { ActivityRow } from "../types";

export interface ActivityState {
  /** Whether the activity panel is open. */
  showActivity: boolean;
  /** Currently-running queries for the active connection. */
  rows: ActivityRow[];
  /** Last error message (null = healthy). */
  error: string | null;
  /** Machine-readable error code accompanying `error`, when the backend provides one. */
  errorCode: string | null;
  /** Loading flag — only driven by non-silent loads. */
  loading: boolean;
  /** Row pending kill confirmation (null = dialog closed). */
  killPending: ActivityRow | null;
}

export type ActivityAction =
  | { type: "TOGGLE_ACTIVITY" }
  | { type: "SET_ACTIVITY_OPEN"; open: boolean }
  /** Clear the rows without touching errors (no-connection / SQLite early return). */
  | { type: "SET_ROWS"; rows: ActivityRow[] }
  /** Begin a load. Silent loads (the 5s poll) never raise the spinner. */
  | { type: "LOAD_START"; silent: boolean }
  /** Rows arrived: set them AND clear error + errorCode — atomically. */
  | { type: "LOAD_SUCCESS"; rows: ActivityRow[] }
  /** Load failed: set error + errorCode AND clear the rows — atomically. */
  | { type: "LOAD_ERROR"; error: string; code: string | null }
  /** End a load. Silent loads never lower the spinner (they never raised it). */
  | { type: "LOAD_DONE"; silent: boolean }
  /**
   * Kill-flow tunnel failure: sets the error message ONLY. Parity with the
   * original code, which left errorCode and rows untouched on this path.
   */
  | { type: "SET_ERROR"; error: string }
  /** Kill failed: set the error, clear the code; rows stay (list still valid). */
  | { type: "KILL_ERROR"; error: string }
  /** Kill succeeded: clear both error fields (rows refresh separately). */
  | { type: "CLEAR_ERROR" }
  | { type: "SET_KILL_PENDING"; row: ActivityRow | null };

export function activityReducer(
  state: ActivityState,
  action: ActivityAction,
): ActivityState {
  switch (action.type) {
    case "TOGGLE_ACTIVITY":
      return { ...state, showActivity: !state.showActivity };

    case "SET_ACTIVITY_OPEN":
      return { ...state, showActivity: action.open };

    case "SET_ROWS":
      return { ...state, rows: action.rows };

    case "LOAD_START":
      return action.silent ? state : { ...state, loading: true };

    case "LOAD_SUCCESS":
      return { ...state, rows: action.rows, error: null, errorCode: null };

    case "LOAD_ERROR":
      return { ...state, error: action.error, errorCode: action.code, rows: [] };

    case "LOAD_DONE":
      return action.silent ? state : { ...state, loading: false };

    case "SET_ERROR":
      return { ...state, error: action.error };

    case "KILL_ERROR":
      return { ...state, error: action.error, errorCode: null };

    case "CLEAR_ERROR":
      return { ...state, error: null, errorCode: null };

    case "SET_KILL_PENDING":
      return { ...state, killPending: action.row };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — panel closed, nothing loaded, no pending kill. */
export function initActivityState(): ActivityState {
  return {
    showActivity: false,
    rows: [],
    error: null,
    errorCode: null,
    loading: false,
    killPending: null,
  };
}
