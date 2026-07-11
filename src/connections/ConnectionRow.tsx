import type { MouseEvent } from "react";
import type { ConnectionConfig } from "../types";
import { EngineBadge } from "../ui";

// Presentational connection card in the sidebar tree. Selection and
// context-menu side effects live in App and are passed in as callbacks.
interface ConnectionRowProps {
  conn:          ConnectionConfig;
  isActive:      boolean;
  indented:      boolean; // true when the connection sits inside a named group
  onSelect:      (conn: ConnectionConfig) => void;
  onContextMenu: (e: MouseEvent, conn: ConnectionConfig) => void;
}

export function ConnectionRow({ conn, isActive, indented, onSelect, onContextMenu }: ConnectionRowProps) {
  return (
    <div
      onClick={() => onSelect(conn)}
      onContextMenu={(e) => onContextMenu(e, conn)}
      style={{
        padding: "9px 14px",
        paddingLeft: indented ? 22 : 14,
        cursor: "pointer",
        borderBottom: "1px solid var(--surface-3)",
        borderLeft: `3px solid ${isActive ? conn.color : "transparent"}`,
        background: isActive ? "var(--surface-3)" : "transparent",
        transition: "background .1s",
      }}
    >
      <div style={{
        fontSize: 12, fontWeight: 500,
        marginBottom: 3, color: "var(--text)",
        overflow: "hidden", textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}>
        {conn.name}
      </div>
      <div style={{
        display: "flex", alignItems: "center",
        gap: 6, minWidth: 0,
      }}>
        <EngineBadge engine={conn.engine} />
        <span style={{
          fontSize: 10, color: "var(--text-disabled)",
          overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", minWidth: 0,
        }}>
          {conn.host}
        </span>
      </div>
    </div>
  );
}
