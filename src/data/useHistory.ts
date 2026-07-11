import { useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ipcJson } from "../ipc";
import type { ConnectionConfig, HistoryEntry } from "../types";
import {
  historyReducer, initHistoryState,
  type HistoryState, type HistoryAction,
} from "../state/historyReducer";

// Owns the query-history reducer plus its two IPC loaders. Extracted from
// App.tsx so history persistence/loading is a single cohesive unit.
export interface UseHistory {
  state:    HistoryState;
  dispatch: React.Dispatch<HistoryAction>;
  save:     (conn: ConnectionConfig, sql: string, durationMs: number, rowCount: number, success: boolean) => Promise<void>;
  load:     (conn: ConnectionConfig | null) => Promise<void>;
}

export function useHistory(): UseHistory {
  const [state, dispatch] = useReducer(historyReducer, undefined, initHistoryState);

  async function save(
    conn: ConnectionConfig,
    sql: string,
    durationMs: number,
    rowCount: number,
    success: boolean,
  ) {
    try {
      // Use setTimeout to ensure this runs after execute_query fully completes
      await new Promise(resolve => setTimeout(resolve, 0));

      await invoke("add_history_entry", {
        connectionId:   conn.id,
        connectionName: conn.name,
        sql:            sql.trim(),
        executedAt:     Date.now(),
        durationMs,
        rowCount,
        success,
      });
    } catch (e) {
      console.error("Failed to save history:", e);
    }
  }

  async function load(conn: ConnectionConfig | null) {
    if (!conn) {
      dispatch({ type: "CLEAR_ENTRIES" });
      return;
    }
    try {
      const parsed = await ipcJson<{ entries?: HistoryEntry[] }>("get_history", {
        connectionId: conn?.id ?? "",
        limit: 100,
      });

      dispatch({ type: "SET_ENTRIES", entries: parsed.entries ?? [] });
    } catch (e) {
      console.error("Failed to load history:", e);
    }
  }

  return { state, dispatch, save, load };
}
