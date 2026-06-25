// Extracted from App.tsx (code-audit item A-1).
import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toIpcError } from "../ipc";
import type {
  ConnectionConfig,
} from "../types";

// ---- Join Tables Panel ------------------------------------
// Shown whenever a flat file is open. Frames the file as the queryable `data`
// table and lets the user pull live DB tables into the same query as
// db_<table>. Two design rules drive this component:
//   1. Visible, not hidden — the join affordance is the hero feature, so it is
//      never collapsed behind an unlabeled control. Tables load as soon as a
//      connection exists.
//   2. Controlled selection — the panel holds NO local copy of the checked
//      set. The single source of truth is the tab's joinTables (`selected`),
//      so switching tabs and back can never desync the checkboxes from the set
//      the query engine actually attaches.
export function JoinTablesPanel({
  fileName,
  activeConnection,
  selected,
  onToggle,
  onInsert,
}: {
  fileName: string;
  activeConnection: ConnectionConfig | null;
  selected: string[];
  onToggle: (table: string, next: boolean) => void;
  onInsert: (table: string) => void;
}) {
  const [tables, setTables] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load tables the moment a connection is available — no expand gate.
  useEffect(() => {
    if (!activeConnection) { setTables([]); setError(null); return; }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<string>("list_db_tables", {
      params: {
        credentialRef: activeConnection.credentialRef,
        engine: activeConnection.engine,
        host: activeConnection.host,
        port: activeConnection.port,
        database: activeConnection.database,
        username: activeConnection.username,
        sslMode: activeConnection.sslMode ?? "prefer",
        sqlInstance: activeConnection.sqlInstance ?? "",
        windowsAuth: activeConnection.windowsAuth ?? false,
      },
    })
      .then((result) => {
        if (cancelled) return;
        const parsed = JSON.parse(result);
        if (parsed.error) { setError(parsed.error); return; }
        setTables(parsed.tables ?? []);
      })
      .catch((e) => { if (!cancelled) setError(toIpcError(e).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeConnection]);

  const selectedSet = new Set(selected);

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)", padding: "10px 12px" }}>
      {/* Framing line — names the `data` alias the file is queryable as. */}
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, fontFamily: "var(--mono)" }}>
        Querying <strong style={{ color: "var(--text)" }}>{fileName}</strong> as{" "}
        <code style={{ color: "var(--accent)", background: "var(--accent-bg)", padding: "1px 5px", borderRadius: 3 }}>data</code>
      </p>

      {!activeConnection ? (
        <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "6px 0 0" }}>
          Connect to a database in the sidebar to join live tables into this query.
        </p>
      ) : (
        <>
          <p style={{ fontSize: 11, color: "var(--text-tertiary)", margin: "4px 0 8px" }}>
            Add live tables from <strong style={{ color: "var(--text-secondary)" }}>{activeConnection.name}</strong> —
            click a table to drop <code style={{ color: "var(--accent)" }}>db_tablename</code> into the editor.
          </p>

          {loading && <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>Loading tables…</p>}
          {error   && <p style={{ fontSize: 12, color: "var(--error)" }}>{error}</p>}
          {!loading && !error && tables.length === 0 && (
            <p style={{ fontSize: 12, color: "var(--text-tertiary)" }}>No tables found</p>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto" }}>
            {tables.map(t => {
              const isSelected = selectedSet.has(t);
              return (
                <div
                  key={t}
                  onClick={() => onInsert(t)}
                  title={`Insert db_${t} into the editor and join`}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "4px 6px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    color: "var(--text)",
                    background: isSelected ? "var(--accent-bg)" : "transparent",
                  }}
                  onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(127,127,127,0.10)"; }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
                >
                  {/* Checkbox = attach WITHOUT inserting text. stopPropagation
                      so toggling it doesn't also fire the row's insert. */}
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onClick={e => e.stopPropagation()}
                    onChange={e => onToggle(t, e.target.checked)}
                  />
                  <span style={{ flex: 1 }}>{t}</span>
                  <code style={{
                    fontSize: 10,
                    color: isSelected ? "var(--accent)" : "var(--text-tertiary)",
                    background: isSelected ? "var(--accent-bg)" : "transparent",
                    padding: "1px 5px",
                    borderRadius: 3,
                  }}>
                    db_{t}
                  </code>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
