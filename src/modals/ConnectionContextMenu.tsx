// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";
import type { ConnectionConfig } from "../types";

export function ConnectionContextMenu({
  contextMenu, setContextMenu, setEditingConnection, setShowAddForm, setDeletingConnection,
}: {
  contextMenu: { x: number; y: number; connection: ConnectionConfig };
  setContextMenu: Dispatch<SetStateAction<{ x: number; y: number; connection: ConnectionConfig } | null>>;
  setEditingConnection: Dispatch<SetStateAction<ConnectionConfig | null>>;
  setShowAddForm: Dispatch<SetStateAction<boolean>>;
  setDeletingConnection: Dispatch<SetStateAction<ConnectionConfig | null>>;
}) {
  return (
        <>
          {/* Backdrop to close on click outside */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setContextMenu(null)}
          />
          <div style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "4px 0",
            minWidth: 160,
            boxShadow: "var(--shadow)",
          }}>
            <button
              onClick={() => {
                setEditingConnection(contextMenu.connection);
                setShowAddForm(true);
                setContextMenu(null);
              }}
              style={{
                display: "block", width: "100%", padding: "8px 16px",
                background: "none", border: "none", color: "var(--text)",
                fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              ✏️ Edit connection
            </button>
            <button
              onClick={() => {
                setDeletingConnection(contextMenu.connection);
                setContextMenu(null);
              }}
              style={{
                display: "block", width: "100%", padding: "8px 16px",
                background: "none", border: "none", color: "var(--error)",
                fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              🗑️ Delete connection
            </button>
          </div>
        </>
  );
}
