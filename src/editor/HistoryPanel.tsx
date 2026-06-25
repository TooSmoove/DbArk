// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, RefObject, SetStateAction } from "react";
import { ipc, toIpcError } from "../ipc";
import type { HistoryEntry, Tab } from "../types";

type EditorHandle = { getValue: () => string; setValue: (value: string) => void };

export function HistoryPanel({
  activeTab, history, setHistory, setShowHistory, editorRef,
}: {
  activeTab: Tab;
  history: HistoryEntry[];
  setHistory: Dispatch<SetStateAction<HistoryEntry[]>>;
  setShowHistory: Dispatch<SetStateAction<boolean>>;
  editorRef: RefObject<EditorHandle | null>;
}) {
  return (
          <div style={{
            borderBottom: "1px solid var(--border)",
            background: "var(--surface)",
            maxHeight: 240,
            overflow: "auto",
            flexShrink: 0,
          }}>
            <div style={{
              padding: "6px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid var(--border)",
              position: "sticky",
              top: 0,
              background: "var(--surface)",
            }}>
             <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--mono)" }}>
                {activeTab.connection
                  ? `${activeTab.connection.name} — recent queries`
                  : "All recent queries"}
              </span>
              <button
                onClick={async () => {
                  try {
                    await ipc("clear_history", {
                      connectionId: activeTab.connection?.id ?? ""
                    });
                    setHistory([]);
                  } catch (e) {
                    console.error("Clear history failed:", toIpcError(e).message);
                  }
                }}
                style={{
                  background: "none", border: "none", color: "var(--text-tertiary)",
                  cursor: "pointer", fontSize: 11, fontFamily: "var(--mono)",
                }}
              >
                Clear
              </button>
            </div>

            {history.length === 0 ? (
              <div style={{ padding: "12px 14px", color: "var(--text-disabled)", fontSize: 12, fontFamily: "var(--mono)" }}>
                No history yet
              </div>
            ) : (
              history.map(entry => (
                <div
                  key={entry.id}
                  onClick={() => {
                    editorRef.current?.setValue(entry.sql);
                    setShowHistory(false);
                  }}
                  style={{
                    padding: "8px 14px",
                    borderBottom: "1px solid var(--border)",
                    cursor: "pointer",
                    transition: "background .1s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <div style={{
                    fontSize: 11,
                    color: entry.success ? "var(--text-secondary)" : "var(--error)",
                    fontFamily: "var(--mono)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    marginBottom: 3,
                  }}>
                    {entry.sql}
                  </div>
                  <div style={{
                    display: "flex",
                    gap: 10,
                    fontSize: 10,
                    color: "var(--text-disabled)",
                    fontFamily: "var(--mono)",
                  }}>
                    <span>{entry.connectionName}</span>
                    <span>{entry.durationMs}ms</span>
                    <span>{entry.rowCount} rows</span>
                    <span>{new Date(entry.executedAt).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))
            )}
          </div>
  );
}
