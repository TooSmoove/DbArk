// ─────────────────────────────────────────────────────────────────────────
// Tabs domain — pure reducer (code-audit item A-1, Tier 3).
//
// All tab state transitions live here as ONE pure function so they can be
// unit-tested without a DOM. Side effects (reading/writing the Monaco editor,
// timers, cache purges) stay in the component — this file only computes the
// next { tabs, activeTabId } from the current state + an action.
// ─────────────────────────────────────────────────────────────────────────
import type { Tab, ConnectionConfig } from "../types";
import { createTab } from "../appState";

export interface TabsState {
  tabs: Tab[];
  activeTabId: string;
}

export type TabsAction =
  /** Set the active tab by id. */
  | { type: "SET_ACTIVE"; id: string }
  /** Shallow-merge `updates` into the tab whose id matches. No-op if no match. */
  | { type: "UPDATE_TAB"; id: string; updates: Partial<Tab> }
  /** Merge `updates` into the currently active tab. */
  | { type: "UPDATE_ACTIVE_TAB"; updates: Partial<Tab> }
  /**
   * Optionally persist `saveSql` into the tab `saveToId` (typically the
   * outgoing active tab), append `tab`, and make it active.
   */
  | { type: "APPEND_ACTIVATE"; tab: Tab; saveToId?: string; saveSql?: string }
  /**
   * Close `closeId`. If only one tab remains, no-op. Optionally persist
   * `saveSql` into the active tab first. If the closed tab was active, the
   * neighbour at the same index (clamped) becomes active.
   */
  | { type: "CLOSE"; closeId: string; saveSql?: string }
  /** Attach/detach a live join table on the tab `id`. */
  | { type: "TOGGLE_JOIN_TABLE"; id: string; table: string; attach: boolean }
  /** Detach a deleted connection from every tab that referenced it. */
  | { type: "CLEAR_CONNECTION"; connectionId: string }
  /**
   * Re-point each tab to the fresh copy of its connection (after the list
   * reloads), resetting that tab's transient result state. Tabs with no
   * connection, or whose connection is absent from `freshById`, are untouched.
   */
  | { type: "REFRESH_CONNECTIONS"; freshById: Map<string, ConnectionConfig> };

function mapTab(tabs: Tab[], id: string, fn: (t: Tab) => Tab): Tab[] {
  return tabs.map(t => (t.id === id ? fn(t) : t));
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case "SET_ACTIVE":
      return { ...state, activeTabId: action.id };

    case "UPDATE_TAB":
      return { ...state, tabs: mapTab(state.tabs, action.id, t => ({ ...t, ...action.updates })) };

    case "UPDATE_ACTIVE_TAB":
      return {
        ...state,
        tabs: mapTab(state.tabs, state.activeTabId, t => ({ ...t, ...action.updates })),
      };

    case "APPEND_ACTIVATE": {
      let tabs = state.tabs;
      if (action.saveToId !== undefined && action.saveSql !== undefined) {
        tabs = mapTab(tabs, action.saveToId, t => ({ ...t, sql: action.saveSql! }));
      }
      return { tabs: [...tabs, action.tab], activeTabId: action.tab.id };
    }

    case "CLOSE": {
      if (state.tabs.length <= 1) return state;
      let tabs = state.tabs;
      if (action.saveSql !== undefined) {
        tabs = mapTab(tabs, state.activeTabId, t => ({ ...t, sql: action.saveSql! }));
      }
      const idx = tabs.findIndex(t => t.id === action.closeId);
      const remaining = tabs.filter(t => t.id !== action.closeId);
      if (remaining.length === tabs.length) {
        // closeId not found — nothing removed; keep state (but apply any save)
        return { ...state, tabs };
      }
      let activeTabId = state.activeTabId;
      if (action.closeId === state.activeTabId) {
        const next = remaining[Math.min(idx, remaining.length - 1)];
        activeTabId = next.id;
      }
      return { tabs: remaining, activeTabId };
    }

    case "TOGGLE_JOIN_TABLE":
      return {
        ...state,
        tabs: mapTab(state.tabs, action.id, t => {
          const has = t.joinTables.includes(action.table);
          if (action.attach === has) return t;
          return {
            ...t,
            joinTables: action.attach
              ? [...t.joinTables, action.table]
              : t.joinTables.filter(x => x !== action.table),
          };
        }),
      };

    case "CLEAR_CONNECTION":
      return {
        ...state,
        tabs: state.tabs.map(t =>
          t.connection?.id === action.connectionId
            ? { ...t, connection: null, title: "New tab" }
            : t
        ),
      };

    case "REFRESH_CONNECTIONS":
      return {
        ...state,
        tabs: state.tabs.map(t => {
          if (!t.connection) return t;
          const fresh = action.freshById.get(t.connection.id);
          return fresh
            ? { ...t, connection: fresh, error: null, results: [], activeResult: 0 }
            : t;
        }),
      };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state factory — one empty tab, active. */
export function initTabsState(): TabsState {
  const first = createTab("tab-1");
  return { tabs: [first], activeTabId: first.id };
}
