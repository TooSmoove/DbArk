import { useReducer, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ipcJson, toIpcError } from "../ipc";
import type { ConnectionConfig, ActivityRow } from "../types";
import {
  activityReducer, initActivityState,
  type ActivityState, type ActivityAction,
} from "../state/activityReducer";

// Owns the live-activity reducer, its load/kill IPC loaders, and the 5-second
// poll effect. `openTunnel` and the active connection are injected because they
// belong to the connection layer.
interface UseActivityDeps {
  openTunnel:       (conn: ConnectionConfig) => Promise<number | null>;
  activeConnection: ConnectionConfig | null;
}

export interface UseActivity {
  state:    ActivityState;
  dispatch: React.Dispatch<ActivityAction>;
  load:     (conn: ConnectionConfig | null, silent?: boolean) => Promise<void>;
  kill:     (row: ActivityRow) => Promise<void>;
}

export function useActivity({ openTunnel, activeConnection }: UseActivityDeps): UseActivity {
  const [state, dispatch] = useReducer(activityReducer, undefined, initActivityState);

  // Builds the connection string for a connection (same path as execute_query)
  // and asks the C# side for currently-running queries. No-op when no
  // connection, SQLite connection, or activity panel closed.
  async function load(conn: ConnectionConfig | null, silent = false) {
    if (!conn || conn.engine === "sqlite") {
      dispatch({ type: "SET_ROWS", rows: [] });
      return;
    }
    dispatch({ type: "LOAD_START", silent });
    try {
      // Same tunnel handling as runQuery — if SSH is enabled we route via
      // 127.0.0.1:<tunnelPort> with SSL disabled (the tunnel is already
      // encrypted). Passing tunnelPort:0 / a missing field to Rust trips
      // its "port must be valid" check, hence the undefined fallback.
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (!port) {
          dispatch({ type: "LOAD_ERROR", error: "SSH tunnel failed", code: null });
          return;
        }
        tunnelPort = port;
      }
      const effectiveSslMode = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const connectionString = await invoke<string>("build_connection_string", {
        params: {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          conn.host,
          port:          conn.port,
          database:      conn.database,
          username:      conn.username,
          sslMode:       effectiveSslMode,
          sqlInstance:   conn.sqlInstance ?? "",
          windowsAuth:   conn.windowsAuth ?? false,
          tunnelPort:    tunnelPort,
        },
      });

      const parsed = await ipcJson<{ error?: string; code?: string; rows?: ActivityRow[] }>("get_activity", {
        connectionString,
        engine: conn.engine,
      });

      if (parsed.error) {
        dispatch({ type: "LOAD_ERROR", error: parsed.error, code: parsed.code ?? null });
      } else {
        dispatch({ type: "LOAD_SUCCESS", rows: parsed.rows ?? [] });
      }
    } catch (e) {
      dispatch({ type: "LOAD_ERROR", error: toIpcError(e).message, code: null });
    } finally {
      dispatch({ type: "LOAD_DONE", silent });
    }
  }

  // Kill a session and immediately refresh the list. The DB enforces "you can
  // only kill your own queries" via permission checks; we surface the error
  // unchanged so the user sees the DB's own message.
  async function kill(row: ActivityRow) {
    const conn = activeConnection;
    if (!conn || conn.engine === "sqlite") return;
    try {
      // Reuse the existing tunnel for this connection if one is open.
      // openTunnel is idempotent via tunnelPortsRef cache, so this is cheap.
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (!port) {
          dispatch({ type: "SET_ERROR", error: "SSH tunnel failed" });
          return;
        }
        tunnelPort = port;
      }
      const effectiveSslMode = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const connectionString = await invoke<string>("build_connection_string", {
        params: {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          conn.host,
          port:          conn.port,
          database:      conn.database,
          username:      conn.username,
          sslMode:       effectiveSslMode,
          sqlInstance:   conn.sqlInstance ?? "",
          windowsAuth:   conn.windowsAuth ?? false,
          tunnelPort:    tunnelPort,
        },
      });

      const parsed = await ipcJson<{ error?: string }>("kill_session", {
        connectionString,
        engine: conn.engine,
        pid:    row.pid,
      });
      if (parsed.error) {
        dispatch({ type: "KILL_ERROR", error: parsed.error });
      } else {
        dispatch({ type: "CLEAR_ERROR" });
        // Refresh silently so the user sees the kill take effect immediately
        await load(conn, true);
      }
    } catch (e) {
      dispatch({ type: "KILL_ERROR", error: toIpcError(e).message });
    }
  }

  // 5-second poll: runs only when panel open, document visible, and there's
  // a non-SQLite connection. setInterval is paused (cleared) when any of
  // those conditions go false — no wasted DB connections in the background.
  useEffect(() => {
    if (!state.showActivity) return;
    if (!activeConnection) return;
    if (activeConnection.engine === "sqlite") return;

    let active = true;
    const tick = () => {
      if (!active) return;
      if (document.visibilityState !== "visible") return;
      // Silent refresh — don't flash a spinner every 5s
      load(activeConnection, true);
    };
    // Immediate load, then every 5s
    tick();
    const id = setInterval(tick, 5000);
    return () => { active = false; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.showActivity, activeConnection?.id]);

  return { state, dispatch, load, kill };
}
