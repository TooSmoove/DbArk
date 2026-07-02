// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch } from "react";
import { ipc, toIpcError } from "../ipc";
import type { ConnectionConfig } from "../types";
import type { TabsAction } from "../state/tabsReducer";
import type { ConnectionsAction } from "../state/connectionsReducer";
import { modalBackdrop } from "../ui/styles";

export function DeleteConnectionDialog({ deletingConnection, dispatchConn, dispatchTabs, loadConnections, connectionsFolder }: { deletingConnection: ConnectionConfig; dispatchConn: Dispatch<ConnectionsAction>; dispatchTabs: Dispatch<TabsAction>; loadConnections: (folder: string) => void; connectionsFolder: string }) {
  return (
        <>
          <div style={modalBackdrop}
            onClick={() => dispatchConn({ type: "CLOSE_DELETE" })} />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", minWidth: 340,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              Delete connection
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 20, lineHeight: 1.6 }}>
              Delete <strong style={{ color: "var(--text)" }}>{deletingConnection.name}</strong>?
              This removes the TOML file and keychain entry. This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    await ipc("delete_connection", { filePath: deletingConnection.filePath });
                  } catch (e) {
                    // The connection file is the source of truth — if this fails,
                    // nothing was removed, so keep the dialog open and surface it.
                    console.error("Delete failed:", toIpcError(e).message);
                    return;
                  }
                  // File is gone. Credential cleanup is best-effort: a missing or
                  // locked keychain entry must not strand a connection that has
                  // already been deleted on disk.
                  try {
                    await ipc("delete_credential", { target: deletingConnection.credentialRef });
                  } catch (e) {
                    console.warn("Credential cleanup skipped:", toIpcError(e).message);
                  }
                  // Clear from tabs if active
                  dispatchTabs({ type: "CLEAR_CONNECTION", connectionId: deletingConnection.id });
                  dispatchConn({ type: "CLOSE_DELETE" });
                  loadConnections(connectionsFolder);
                }}
                style={{
                  flex: 1, padding: "8px 0", background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "var(--mono)",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => dispatchConn({ type: "CLOSE_DELETE" })}
                style={{
                  flex: 1, padding: "8px 0", background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "var(--mono)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
  );
}
