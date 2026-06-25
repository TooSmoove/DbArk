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
              className="menu-item"
            >
              ✏️ Edit connection
            </button>
            <button
              onClick={() => {
                setDeletingConnection(contextMenu.connection);
                setContextMenu(null);
              }}
              className="menu-item menu-item--danger"
            >
              🗑️ Delete connection
            </button>
          </div>
        </>
  );
}
