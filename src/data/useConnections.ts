import { useReducer, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toIpcError } from "../ipc";
import type { ConnectionConfig, Tab } from "../types";
import {
  connectionsReducer, initConnectionsState,
  type ConnectionsState, type ConnectionsAction,
} from "../state/connectionsReducer";

// Owns the connections reducer plus the SSH-tunnel machinery (openTunnel and
// its port cache). `updateActiveTab` is injected because a tunnel failure
// surfaces as an error on the active tab. loadConnections stays in App: it is
// cross-cutting orchestration (connections + schema + tabs), not connection-
// local state.
interface UseConnectionsDeps {
  updateActiveTab: (updates: Partial<Tab>) => void;
}

export interface UseConnections {
  connState:   ConnectionsState;
  dispatchConn: React.Dispatch<ConnectionsAction>;
  openTunnel:  (conn: ConnectionConfig) => Promise<number | null>;
}

export function useConnections({ updateActiveTab }: UseConnectionsDeps): UseConnections {
  const [connState, dispatchConn] = useReducer(connectionsReducer, undefined, initConnectionsState);
  const tunnelPortsRef = useRef<Record<string, number>>({});

  async function openTunnel(conn: ConnectionConfig): Promise<number | null> {
    if (!conn.sshEnabled) return null;
    if (tunnelPortsRef.current[conn.id]) return tunnelPortsRef.current[conn.id];

    dispatchConn({ type: "SET_TUNNEL_LOADING", connId: conn.id, loading: true });
    try {
      // Get SSH password from keychain if stored
      let sshPassword = "";
      try {
        sshPassword = await invoke<string>("get_ssh_password", {
          target:   `dbark-ssh:${conn.id}:${conn.sshUser}`,
          username: conn.sshUser,
        });
      } catch { /* no SSH password stored — key-only auth */ }

      const localPort = await invoke<number>("open_tunnel", {
        params: {
          tunnelId:    conn.id,
          sshHost:     conn.sshHost,
          sshPort:     conn.sshPort ?? 22,
          sshUser:     conn.sshUser,
          sshKeyPath:  conn.sshKeyPath ?? "",
          sshPassword: sshPassword,
          dbHost:      "127.0.0.1",
          dbPort:      conn.port,
        },
      });

      console.log("open_tunnel invoke result:", localPort);
      tunnelPortsRef.current = { ...tunnelPortsRef.current, [conn.id]: localPort };
      dispatchConn({ type: "SET_TUNNEL_PORTS", ports: { ...tunnelPortsRef.current } });
      return localPort;
    } catch (e) {
      console.error("open_tunnel invoke error:", e);
      updateActiveTab({ error: `SSH tunnel failed: ${toIpcError(e).message}` });
      return null;
    } finally {
      dispatchConn({ type: "SET_TUNNEL_LOADING", connId: conn.id, loading: false });
    }
  }

  return { connState, dispatchConn, openTunnel };
}
