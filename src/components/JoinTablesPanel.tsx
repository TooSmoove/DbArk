// src/components/JoinTablesPanel.tsx
import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface Props {
  activeConnection: Connection | null;
  onSelectionChange: (tables: string[]) => void;
}

export function JoinTablesPanel({ activeConnection, onSelectionChange }: Props) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load table list when panel is opened
  useEffect(() => {
    if (!open || !activeConnection) return;
    setLoading(true);
    setError(null);

    invoke('list_db_tables', {
      credentialRef: activeConnection.credential_ref,
      engine: activeConnection.engine,
      host: activeConnection.host,
      port: activeConnection.port,
      database: activeConnection.database,
      username: activeConnection.username,
    })
      .then((result) => {
        const parsed = JSON.parse(result as string);
        if (parsed.error) { setError(parsed.error); return; }
        setTables(parsed.tables ?? []);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, activeConnection]);

  const toggle = (table: string) => {
    const next = new Set(checked);
    next.has(table) ? next.delete(table) : next.add(table);
    setChecked(next);
    onSelectionChange([...next]);
  };

  if (!activeConnection) {
  return (
    <div style={{ borderBottom: "1px solid #1e2026", background: "#13141a" }}>
      <div style={{
        padding: "8px 12px", fontSize: 12, color: "#4b5563", fontFamily: "monospace",
      }}>
        ⊕ Join DB Tables — <span style={{ color: "#6c63ff", cursor: "pointer" }}
          onClick={() => {/* hint only */}}>
          select a connection in the sidebar first
        </span>
      </div>
    </div>
  );
}
  return (
    <div className="join-panel">
      <button
        className="join-panel-toggle"
        onClick={() => setOpen(o => !o)}
      >
        <span className="join-icon">⊕</span>
        Join DB Tables
        {checked.size > 0 && (
          <span className="join-badge">{checked.size} selected</span>
        )}
        <span className="join-chevron">{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div className="join-panel-body">
          <p className="join-hint">
            From <strong>{activeConnection.name}</strong> — 
            checked tables available as <code>db_tablename</code>
          </p>

          {loading && <p className="join-loading">Loading tables…</p>}
          {error   && <p className="join-error">{error}</p>}

          {!loading && !error && tables.length === 0 && (
            <p className="join-empty">No tables found</p>
          )}

          <div className="join-table-list">
            {tables.map(t => (
              <label key={t} className="join-table-row">
                <input
                  type="checkbox"
                  checked={checked.has(t)}
                  onChange={() => toggle(t)}
                />
                <span className="join-table-name">{t}</span>
                {checked.has(t) && (
                  <code className="join-alias">→ db_{t}</code>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}