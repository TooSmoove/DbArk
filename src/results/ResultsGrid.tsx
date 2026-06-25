// Extracted from App.tsx (code-audit item A-1).
import { useState, useRef, useMemo } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useDebounce } from "../hooks";
import type {
  ConnectionConfig, QueryResult, SchemaResult, PendingEdit,
} from "../types";

// Stable identity so the header-only table doesn't rebuild each render.
export const EMPTY_ROWS: (string | null)[][] = [];

// ---- Results grid -----------------------------------------
export function ResultsGrid({
  result,
  connection,
  schema,
  pendingEdits,
  editingCell,
  onCellEdit,
  onCellCommit,
  onCellCancel,
  onCommitAll,
  onRollbackAll,
}: {
  result:        QueryResult;
  connection:    ConnectionConfig | null;
  schema:        SchemaResult | null;
  pendingEdits:  PendingEdit[];
  editingCell:   { rowIndex: number; colIndex: number } | null;
  onCellEdit:    (rowIndex: number, colIndex: number) => void;
  onCellCommit:  (rowIndex: number, colIndex: number, value: string) => void;
  onCellCancel:  () => void;
  onCommitAll:   () => void;
  onRollbackAll: () => void;
}) {

  // Detect table name from result.sql (best effort)
  const tableName = useMemo(() => {
    const sql = result.sql ?? "";
    const match = sql.match(/FROM\s+(?:\w+\.)*[\[\`"]?(\w+)[\]\`"]?/i);
    return match?.[1] ?? "";
  }, [result.sql]);

  const tableInfo = useMemo(() =>
    schema?.tables.find(t =>
      t.name.toLowerCase() === tableName.toLowerCase()),
    [schema, tableName]);

  const pkColumns  = tableInfo?.columns.filter(c => c.isPrimaryKey) ?? [];
  const hasPk      = pkColumns.length > 0;
  const isReadOnly = connection?.readOnly ?? false;
  const canEdit    = !isReadOnly && hasPk && !!tableInfo;

  const parentRef = useRef<HTMLDivElement>(null);
  const [filterText, setFilterText] = useState("");
  const debouncedFilter = useDebounce(filterText, 300);
  const [sorting, setSorting] = useState<import("@tanstack/react-table").SortingState>([]);

  const columnHelper = useMemo(() => createColumnHelper<(string | null)[]>(), []);

  const columns = useMemo(
    () => result.columns.map((col, i) =>
      columnHelper.accessor((row) => row[i], {
        id: col && col.trim() ? `${col}_${i}` : `col_${i}`,
        header: col && col.trim() ? col : `(col ${i + 1})`,
        cell: (info) => {
          const val = info.getValue();
          if (val === null)
            return <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>NULL</span>;
          return val;
        },
      })
    ),
    [result.columns, columnHelper]
  );

  // Client-side filter — check if any cell in the row contains the filter text
  // Use debouncedFilter for the actual filtering, not filterText
  const filterableRows = result.rows.slice(0, 1_000);

  const filteredRows = useMemo(() => {
    if (!debouncedFilter.trim()) return result.rows;
    const lower = debouncedFilter.toLowerCase();
    return filterableRows.filter(row =>
      row.some(cell => cell?.toLowerCase().includes(lower))
    );
  }, [debouncedFilter, result.rows]);

  // Sort the plain array ourselves so we never hand 600k rows to TanStack's
  // row model (the source of the post-load freeze). Header UI + sort state
  // still come from the table below, which now holds zero data rows.
  const sortedRows = useMemo(() => {
    if (sorting.length === 0) return filteredRows;
    const { id, desc } = sorting[0];
    const colIdx = result.columns.findIndex((c, i) =>
      (c && c.trim() ? `${c}_${i}` : `col_${i}`) === id);
    if (colIdx < 0) return filteredRows;

    // Decide numeric vs string once from the first non-null sample, so a
    // numeric column sorts 2 < 10 rather than lexically.
    const sample = filteredRows.find(r => r[colIdx] != null)?.[colIdx];
    const numeric = sample != null && sample.trim() !== "" && !Number.isNaN(Number(sample));

    const copy = filteredRows.slice();
    copy.sort((a, b) => {
      const av = a[colIdx], bv = b[colIdx];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;           // nulls last
      if (bv == null) return -1;
      const cmp = numeric
        ? Number(av) - Number(bv)
        : av.localeCompare(bv, undefined, { numeric: true });
      return desc ? -cmp : cmp;
    });
    return copy;
  }, [filteredRows, sorting, result.columns]);

  const table = useReactTable({
    data: EMPTY_ROWS,        // header + sort state only — body renders from sortedRows
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
    manualSorting: true,     // we sort sortedRows ourselves; don't let TanStack try
  });

  const rowVirtualiser = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 20,
  });

  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const virtualRows   = rowVirtualiser.getVirtualItems();
  const totalHeight   = rowVirtualiser.getTotalSize();
  const paddingTop    = virtualRows.length > 0 ? virtualRows[0].start : 0;
  const paddingBottom = virtualRows.length > 0
    ? totalHeight - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>

      {/* Filter bar */}
      <div style={{
        padding: "6px 14px",
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexShrink: 0,
      }}>
        <input
          type="text"
          placeholder={result.rowCount > 1000
            ? "Filter first 1,000 rows — use WHERE for more"
            : "Filter rows…"}
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          style={{
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            color: "var(--text)",
            fontSize: 12,
            fontFamily: "monospace",
            padding: "4px 10px",
            outline: "none",
            width: 260,
          }}
        />
        {debouncedFilter && (
          <>
            <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
              {sortedRows.length} of {result.rowCount} rows
            </span>
            <button
              onClick={() => setFilterText("")}
              style={{
                background: "none", border: "none", color: "var(--text-tertiary)",
                cursor: "pointer", fontSize: 12, padding: "2px 6px",
              }}
            >
              ✕ clear
            </button>
          </>
        )}
        {sorting.length > 0 && (
          <button
            onClick={() => setSorting([])}
            style={{
              background: "none", border: "none", color: "var(--text-tertiary)",
              cursor: "pointer", fontSize: 11, padding: "2px 6px",
              fontFamily: "monospace", marginLeft: "auto",
            }}
          >
            ✕ clear sort
          </button>
        )}
      </div>

      {/* Pending edits toolbar */}
      {pendingEdits.length > 0 && (
        <div style={{
          padding: "6px 14px",
          borderBottom: "1px solid var(--border)",
          background: "var(--warning-bg)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 11, color: "var(--warning)",
            fontFamily: "monospace", flex: 1,
          }}>
            ⚠ {pendingEdits.length} unsaved change{pendingEdits.length > 1 ? "s" : ""}
          </span>
          <button
            onClick={onCommitAll}
            style={{
              padding: "4px 12px",
              background: "var(--success)", color: "white",
              border: "none", borderRadius: 6,
              cursor: "pointer", fontSize: 11,
              fontFamily: "monospace",
            }}
          >
            ✓ Commit
          </button>
          <button
            onClick={onRollbackAll}
            style={{
              padding: "4px 12px",
              background: "transparent", color: "var(--text-tertiary)",
              border: "1px solid var(--border)", borderRadius: 6,
              cursor: "pointer", fontSize: 11,
              fontFamily: "monospace",
            }}
          >
            ✕ Rollback
          </button>
        </div>
      )}

      {/* Grid */}
      <div ref={parentRef} style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <table style={{
          borderCollapse: "collapse", width: "100%",
          fontSize: 13, fontFamily: "monospace", tableLayout: "auto",
        }}>
          <thead style={{ position: "sticky", top: 0, zIndex: 1 }}>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    style={{
                      padding: "7px 14px", textAlign: "left",
                      background: "var(--surface-2)", borderBottom: "1px solid var(--border)",
                      color: header.column.getIsSorted() ? "var(--text)" : "var(--text-secondary)",
                      fontWeight: 500, whiteSpace: "nowrap",
                      cursor: "pointer", userSelect: "none",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc"  && <span style={{ color: "var(--accent)" }}>↑</span>}
                      {header.column.getIsSorted() === "desc" && <span style={{ color: "var(--accent)" }}>↓</span>}
                      {!header.column.getIsSorted() && (
                        <span style={{ color: "var(--border)", fontSize: 10 }}>⇅</span>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {paddingTop > 0 && (
              <tr><td style={{ height: paddingTop }} colSpan={columns.length} /></tr>
            )}
            {virtualRows.map((virtualRow) => {
              const rowIdx  = virtualRow.index;
              const dataRow = sortedRows[rowIdx];
              return (
                <tr key={virtualRow.key}>
                  {result.columns.map((_, colIdx) => {
                  const cellId     = `${rowIdx}_${colIdx}`;
                  const isEditing  = editingCell?.rowIndex === rowIdx
                                  && editingCell?.colIndex === colIdx;
                  const pending    = pendingEdits.find(
                    e => e.rowIndex === rowIdx && e.colIndex === colIdx);
                  const rawValue   = dataRow[colIdx] as string | null;
                  const cellValue  = pending ? pending.newValue : rawValue;
                  const isModified = !!pending;

                  return (
                    <td
                      key={cellId}
                      onDoubleClick={() => {
                        if (!canEdit) return;
                        if (rawValue === null && !hasPk) return;
                        onCellEdit(rowIdx, colIdx);
                      }}
                      title={
                        isReadOnly  ? "Read-only connection"
                        : !hasPk    ? "No primary key — editing disabled"
                        : !tableInfo ? "Select from a single table to edit"
                        : "Double-click to edit"
                      }
                      style={{
                        padding: isEditing ? "0" : "5px 14px",
                        borderBottom: "1px solid var(--border)",
                        color: isModified ? "var(--warning)" : "var(--text)",
                        whiteSpace: "nowrap",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: isEditing ? "clip" : "ellipsis",
                        cursor: canEdit ? "pointer" : "default",
                        background: isEditing
                          ? "var(--accent-bg)"
                          : isModified
                          ? "var(--warning-bg)"
                          : copiedCell === cellId
                          ? "var(--accent-bg)"
                          : virtualRow.index % 2 === 0 ? "var(--bg)" : "var(--surface)",
                        transition: "background .15s",
                      }}
                      onClick={() => {
                        if (isEditing) return;
                        if (rawValue === null) return;
                        import("@tauri-apps/plugin-clipboard-manager").then(
                          ({ writeText, readText, clear }) => {
                            writeText(rawValue).then(() => {
                              setCopiedCell(cellId);
                              setTimeout(() => setCopiedCell(null), 800);
                              setTimeout(() => {
                                readText().then(current => {
                                  if (current === rawValue) clear().catch(() => {});
                                }).catch(() => {});
                              }, 60_000);
                            }).catch(() => {});
                          });
                      }}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          defaultValue={cellValue ?? ""}
                          style={{
                            width: "100%",
                            height: "100%",
                            minHeight: 30,
                            padding: "5px 14px",
                            background: "var(--accent-bg)",
                            border: "none",
                            borderBottom: "2px solid var(--accent)",
                            color: "var(--text)",
                            fontSize: 13,
                            fontFamily: "monospace",
                            outline: "none",
                            boxSizing: "border-box",
                          }}
                          onKeyDown={e => {
                            if (e.key === "Enter") {
                              onCellCommit(rowIdx, colIdx,
                                (e.target as HTMLInputElement).value);
                            }
                            if (e.key === "Escape") {
                              onCellCancel();
                            }
                          }}
                          onBlur={e => {
                            const newVal = e.target.value;
                            if (newVal !== (rawValue ?? "")) {
                              onCellCommit(rowIdx, colIdx, newVal);
                            } else {
                              onCellCancel();
                            }
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        cellValue === null
                          ? <span style={{ color: "var(--text-tertiary)", fontStyle: "italic" }}>NULL</span>
                          : isModified
                          ? <span style={{ color: "var(--warning)" }}>{cellValue}</span>
                          : cellValue
                      )}
                    </td>
                  );
                })}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr><td style={{ height: paddingBottom }} colSpan={columns.length} /></tr>
            )}
          </tbody>
        </table>

        {sortedRows.length === 0 && filterText && (
          <div style={{ padding: "24px 14px", color: "var(--text-disabled)", fontSize: 13, textAlign: "center" }}>
            No rows match "{filterText}"
          </div>
        )}
      </div>

      {/* Edit Status Indicator */}
      {!canEdit && connection && (
      <div style={{
        padding: "4px 14px",
        background: "var(--surface)",
        borderTop: "1px solid var(--border)",
        fontSize: 10, color: "var(--text-disabled)",
        fontFamily: "monospace", flexShrink: 0,
      }}>
        {isReadOnly
          ? "🔒 Read-only connection — editing disabled"
          : !tableInfo
          ? "ℹ Select from a single table to enable inline editing"
          : !hasPk
          ? "ℹ No primary key detected — inline editing disabled"
          : null}
      </div>
    )}

    </div>
  );
}
