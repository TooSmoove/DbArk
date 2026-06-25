// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";
import { ipc, toIpcError } from "../ipc";
import type { ConnectionConfig, Tab } from "../types";

export function DeleteConnectionDialog({ deletingConnection, setDeletingConnection, setTabs, loadConnections, connectionsFolder }: { deletingConnection: ConnectionConfig; setDeletingConnection: Dispatch<SetStateAction<ConnectionConfig | null>>; setTabs: Dispatch<SetStateAction<Tab[]>>; loadConnections: (folder: string) => void; connectionsFolder: string }) {
  return (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.6)" }}
            onClick={() => setDeletingConnection(null)} />
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
                  setTabs(prev => prev.map(t =>
                    t.connection?.id === deletingConnection.id
                      ? { ...t, connection: null, title: "New tab" }
                      : t
                  ));
                  setDeletingConnection(null);
                  loadConnections(connectionsFolder);
                }}
                style={{
                  flex: 1, padding: "8px 0", background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setDeletingConnection(null)}
                style={{
                  flex: 1, padding: "8px 0", background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
  );
}
