// src/components/ErDiagram/TableSelector.tsx
//
// Modal for picking which tables to render in the diagram. Shown unconditionally
// when the schema has >50 tables, and on demand via the "Tables" toolbar button.
//
// Behaviour:
//   - Lists every table grouped by schema (relevant for Postgres / SQL Server).
//   - Search filters the list in place.
//   - "Select all in schema" / "Clear all in schema" per-group quick actions.
//   - Apply commits the new selection; Cancel keeps the previous selection.

import { useMemo, useState } from "react";
import type { TableInfo } from "./diagramTypes";

interface Props {
  tables: TableInfo[];
  initialSelection: Set<string>;
  onApply: (selection: Set<string>) => void;
  onCancel: () => void;
}

export function TableSelector({ tables, initialSelection, onApply, onCancel }: Props) {
  const [selection, setSelection] = useState<Set<string>>(
    () => new Set(initialSelection),
  );
  const [search, setSearch] = useState("");

  const tableId = (t: TableInfo) => `${t.schema}.${t.name}`;

  // Group by schema, filter by search
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const byScheme = new Map<string, TableInfo[]>();
    for (const t of tables) {
      if (q && !t.name.toLowerCase().includes(q) && !t.schema.toLowerCase().includes(q)) {
        continue;
      }
      const list = byScheme.get(t.schema) ?? [];
      list.push(t);
      byScheme.set(t.schema, list);
    }
    return Array.from(byScheme.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [tables, search]);

  const toggle = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllInSchema = (schema: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      for (const t of tables) if (t.schema === schema) next.add(tableId(t));
      return next;
    });
  };

  const clearAllInSchema = (schema: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      for (const t of tables) if (t.schema === schema) next.delete(tableId(t));
      return next;
    });
  };

  return (
    <div className="er-modal-backdrop" onClick={onCancel}>
      <div
        className="er-modal"
        role="dialog"
        aria-label="Select tables to include"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="er-modal-header">
          <h3>Tables in diagram</h3>
          <span className="er-modal-count">
            {selection.size} / {tables.length} selected
          </span>
        </div>

        <input
          type="search"
          className="er-modal-search"
          placeholder="Filter tables..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />

        <div className="er-modal-body">
          {groups.length === 0 && (
            <div className="er-modal-empty">No tables match "{search}"</div>
          )}
          {groups.map(([schema, tablesInSchema]) => (
            <div key={schema} className="er-modal-group">
              <div className="er-modal-group-header">
                <span className="er-modal-group-name">{schema}</span>
                <div className="er-modal-group-actions">
                  <button
                    type="button"
                    className="er-link-button"
                    onClick={() => selectAllInSchema(schema)}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="er-link-button"
                    onClick={() => clearAllInSchema(schema)}
                  >
                    None
                  </button>
                </div>
              </div>
              <ul className="er-modal-list">
                {tablesInSchema.map((t) => {
                  const id = tableId(t);
                  return (
                    <li key={id}>
                      <label className="er-modal-row">
                        <input
                          type="checkbox"
                          checked={selection.has(id)}
                          onChange={() => toggle(id)}
                        />
                        <span className="er-modal-table-name">{t.name}</span>
                        <span className="er-modal-table-meta">
                          {t.columns.length} cols
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div className="er-modal-footer">
          <button type="button" className="er-button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="er-button-primary"
            onClick={() => onApply(selection)}
            disabled={selection.size === 0}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
