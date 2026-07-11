import type { ConnectionConfig } from "../types";

// Presentational database row in the connection tree. Selection and toggle
// behaviour are passed in; this component only derives active/expanded state
// from props and renders.
interface DbRowProps {
  conn:            ConnectionConfig;
  db:              string;
  activeDb:        string;
  dbTreeCollapsed: boolean;
  onToggle:        () => void;
  onSelect:        (conn: ConnectionConfig, db: string) => void;
}

export function DbRow({ conn, db, activeDb, dbTreeCollapsed, onToggle, onSelect }: DbRowProps) {
  const isActive = db === activeDb;
  const expanded = isActive && !dbTreeCollapsed;
  return (
    <div
      onClick={() => (isActive ? onToggle() : onSelect(conn, db))}
      title={isActive
        ? `${db} — click to ${expanded ? "collapse" : "expand"}`
        : `Browse ${db}`}
      style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "5px 14px", cursor: "pointer",
        borderLeft: `3px solid ${isActive ? conn.color : "transparent"}`,
        background: isActive ? "var(--surface-3)" : "transparent",
      }}
    >
      <span style={{
        fontSize: 9, color: expanded ? "var(--accent)" : "var(--text-disabled)",
        flexShrink: 0, width: 8,
      }}>
        {expanded ? "▾" : "▸"}
      </span>
      <span style={{
        fontSize: 10, color: isActive ? "var(--accent)" : "var(--text-disabled)",
        flexShrink: 0, width: 12,
      }}>
        🗄
      </span>
      <span style={{
        fontSize: 11, flex: 1, fontFamily: "var(--mono)",
        color: isActive ? "var(--text)" : "var(--text-secondary)",
        fontWeight: isActive ? 600 : 400,
        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
      }}>
        {db}
      </span>
    </div>
  );
}
