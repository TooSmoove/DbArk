// ─────────────────────────────────────────────────────────────────────────
// Query history — pure reducer (code-audit item A-1, final pass).
//
// Holds the history panel's visibility and its entries (loaded from the
// local state.db via IPC, which stays at the dispatch sites). Pure.
// ─────────────────────────────────────────────────────────────────────────

import type { HistoryEntry } from "../types";

export interface HistoryState {
  /** Whether the history panel is open. */
  open: boolean;
  /** History entries for the active connection. */
  entries: HistoryEntry[];
}

export type HistoryAction =
  | { type: "TOGGLE_HISTORY" }
  | { type: "SET_HISTORY_OPEN"; open: boolean }
  | { type: "SET_ENTRIES"; entries: HistoryEntry[] }
  | { type: "CLEAR_ENTRIES" };

export function historyReducer(
  state: HistoryState,
  action: HistoryAction,
): HistoryState {
  switch (action.type) {
    case "TOGGLE_HISTORY":
      return { ...state, open: !state.open };

    case "SET_HISTORY_OPEN":
      return { ...state, open: action.open };

    case "SET_ENTRIES":
      return { ...state, entries: action.entries };

    case "CLEAR_ENTRIES":
      return { ...state, entries: [] };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — panel closed, no entries loaded. */
export function initHistoryState(): HistoryState {
  return { open: false, entries: [] };
}
