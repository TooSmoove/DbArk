// Extracted from App.tsx (code-audit item A-1).
import type React from "react";

export function SchemaSection({
  label, count, expanded, onToggle,
  children, emptyMessage,
}: {
  label:         string;
  icon:          string;
  count:         number;
  sectionKey:    string;
  expanded:      boolean;
  onToggle:      () => void;
  children:      React.ReactNode;
  emptyMessage?: string;
}) {
  return (
    <div style={{ borderTop: "1px solid var(--border)" }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 14px", cursor: "pointer",
          background: expanded ? "var(--bg)" : "transparent",
          transition: "background .1s",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--bg)")}
        onMouseLeave={e => (e.currentTarget.style.background = expanded ? "var(--bg)" : "transparent")}
      >
        <span style={{ fontSize: 9, color: "var(--text-disabled)", width: 10, flexShrink: 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-tertiary)", fontFamily: "monospace",
          fontWeight: 600, flex: 1, textTransform: "uppercase", letterSpacing: ".05em" }}>
          {label}
        </span>
        <span style={{ fontSize: 9, color: "var(--border-strong)", fontFamily: "monospace" }}>
          {count}
        </span>
      </div>

      {expanded && (
        <div style={{ background: "var(--bg)" }}>
          {emptyMessage ? (
            <div style={{ padding: "8px 14px 8px 20px", fontSize: 10,
              color: "var(--border-strong)", fontFamily: "monospace", fontStyle: "italic" }}>
              {emptyMessage}
            </div>
          ) : count === 0 ? (
            <div style={{ padding: "8px 14px 8px 20px", fontSize: 10,
              color: "var(--border-strong)", fontFamily: "monospace" }}>
              None found
            </div>
          ) : children}
        </div>
      )}
    </div>
  );
}
