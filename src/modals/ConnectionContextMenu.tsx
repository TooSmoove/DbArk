// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch } from "react";
import type { ConnectionMenu } from "../types";
import type { ConnectionsAction } from "../state/connectionsReducer";

export function ConnectionContextMenu({
  contextMenu, dispatchConn,
}: {
  contextMenu: ConnectionMenu;
  dispatchConn: Dispatch<ConnectionsAction>;
}) {
  return (
        <>
          {/* Backdrop to close on click outside */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => dispatchConn({ type: "CLOSE_CONTEXT_MENU" })}
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
                dispatchConn({ type: "OPEN_EDIT_FORM", connection: contextMenu.connection });
              }}
              className="menu-item"
            >
              ✏️ Edit connection
            </button>
            <button
              onClick={() => {
                dispatchConn({ type: "REQUEST_DELETE", connection: contextMenu.connection });
              }}
              className="menu-item menu-item--danger"
            >
              🗑️ Delete connection
            </button>
          </div>
        </>
  );
}
