import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";

import { useVirtualizer } from "@tanstack/react-virtual";

// ---- Types ------------------------------------------------
interface ConnectionConfig {
  id: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  credentialRef: string;
  color: string;
  group: string;
  filePath: string;
  sslMode: string;
  readOnly: boolean;
}

interface ConnectionListResult {
  connections: ConnectionConfig[];
  error?: string;
}

interface QueryResult {
  columns: string[];
  rows: (string | null)[][];
  rowCount: number;
  truncated?: boolean;
  error?: string;
}

interface FileSession {
  id: string;
  name: string;
  path: string;
  type: "csv" | "json" | "xlsx";
}

interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
}

interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
}

interface SchemaResult {
  tables: TableInfo[];
  error?: string;
}

interface HistoryEntry {
  id: number;
  connectionId: string;
  connectionName: string;
  sql: string;
  executedAt: number;
  durationMs: number;
  rowCount: number;
  success: boolean;
}

// ---- Engine badge -----------------------------------------
function EngineBadge({ engine }: { engine: string }) {
  const colors: Record<string, string> = {
    mysql:     "#f59e0b",
    sqlserver: "#3b82f6",
    postgres:  "#6c63ff",
    sqlite:    "#10b981",
  };
  const color = colors[engine.toLowerCase()] ?? "#6b7280";
  return (
    <span style={{
      fontSize: 9,
      fontWeight: 600,
      padding: "1px 6px",
      borderRadius: 20,
      background: color + "22",
      color,
      textTransform: "uppercase",
      letterSpacing: ".05em",
      fontFamily: "monospace",
      flexShrink: 0,
    }}>
      {engine}
    </span>
  );
}

// ---- Join Tables Panel ------------------------------------
function JoinTablesPanel({
  activeConnection,
  onSelectionChange,
}: {
  activeConnection: ConnectionConfig | null;
  onSelectionChange: (tables: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !activeConnection) return;
    setLoading(true);
    setError(null);
    invoke<string>("list_db_tables", {
      credentialRef: activeConnection.credentialRef,
      engine: activeConnection.engine,
      host: activeConnection.host,
      port: activeConnection.port,
      database: activeConnection.database,
      username: activeConnection.username,
      sslMode: activeConnection.sslMode ?? "prefer",
    })
      .then((result) => {
        const parsed = JSON.parse(result);
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

  if (!activeConnection) return null;

  return (
    <div style={{ borderBottom: "1px solid #1e2026", background: "#13141a" }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          background: "none",
          border: "none",
          color: "#9ca3af",
          fontSize: 12,
          cursor: "pointer",
          textAlign: "left",
          fontFamily: "monospace",
        }}
      >
        <span>⊕</span>
        <span>Join DB Tables</span>
        {checked.size > 0 && (
          <span style={{
            background: "#6c63ff",
            color: "white",
            borderRadius: 10,
            padding: "1px 7px",
            fontSize: 11,
          }}>
            {checked.size} selected
          </span>
        )}
        <span style={{ marginLeft: "auto" }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ padding: "8px 12px 12px", borderTop: "1px solid #1e2026" }}>
          <p style={{ fontSize: 11, color: "#6b7280", margin: "0 0 8px" }}>
            From <strong style={{ color: "#9ca3af" }}>{activeConnection.name}</strong> —
            checked tables available as <code style={{ color: "#6c63ff" }}>db_tablename</code>
          </p>

          {loading && <p style={{ fontSize: 12, color: "#6b7280" }}>Loading tables…</p>}
          {error   && <p style={{ fontSize: 12, color: "#ef4444" }}>{error}</p>}
          {!loading && !error && tables.length === 0 && (
            <p style={{ fontSize: 12, color: "#6b7280" }}>No tables found</p>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 180, overflowY: "auto" }}>
            {tables.map(t => (
              <label key={t} style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "3px 4px",
                borderRadius: 4,
                cursor: "pointer",
                fontSize: 12,
                color: "#e8e9ec",
              }}>
                <input
                  type="checkbox"
                  checked={checked.has(t)}
                  onChange={() => toggle(t)}
                />
                <span style={{ flex: 1 }}>{t}</span>
                {checked.has(t) && (
                  <code style={{
                    fontSize: 10,
                    color: "#6c63ff",
                    background: "rgba(108,99,255,0.15)",
                    padding: "1px 5px",
                    borderRadius: 3,
                  }}>
                    → db_{t}
                  </code>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Add connection form ----------------------------------
function AddConnectionForm({
  onSave,
  onCancel,
  connectionsFolder,
}: {
  onSave: () => void;
  onCancel: () => void;
  connectionsFolder: string;
}) {
  const [form, setForm] = useState({
    name: "", engine: "mysql", host: "", port: "", database: "",
    username: "", password: "", color: "#6c63ff", group: "",
    sslMode: "prefer", readOnly: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fieldStyle: React.CSSProperties = {
    width: "100%", padding: "6px 10px", background: "#0e0f11",
    border: "1px solid #2d2f36", borderRadius: 6, color: "#e8e9ec",
    fontSize: 12, fontFamily: "monospace", marginTop: 3,
    outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "#6b7280", display: "block", marginBottom: 8, width: "100%",
  };

  async function handleSave() {
    if (!form.name || !form.host || !form.database || !form.username) {
      setError("Name, host, database and username are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const defaultPort: Record<string, number> = {
        mysql: 3306, sqlserver: 1433, postgres: 5432, sqlite: 0,
      };
      const request = {
        name: form.name, engine: form.engine, host: form.host,
        port: parseInt(form.port) || defaultPort[form.engine] || 3306,
        database: form.database, username: form.username,
        color: form.color, group: form.group, folderPath: connectionsFolder,
        sslMode: form.sslMode, readOnly: form.readOnly,
      };
      const result = await invoke<string>("save_connection", {
        requestJson: JSON.stringify(request),
      });
      if (result.startsWith("ERROR")) { setError(result); return; }

      if (form.password) {
        await invoke<boolean>("store_credential", {
          target: `devsql:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`,
          username: form.username,
          password: form.password,
        });
      }
      onSave();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "12px 14px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "#e8e9ec" }}>
        Add connection
      </div>

      {[
        { label: "Name", key: "name", placeholder: "My Database", type: "text" },
        { label: "Host", key: "host", placeholder: "localhost", type: "text" },
        { label: "Port", key: "port", placeholder: "3306", type: "text" },
        { label: "Database", key: "database", placeholder: "mydb", type: "text" },
        { label: "Username", key: "username", placeholder: "root", type: "text" },
        { label: "Password", key: "password", placeholder: "••••••••", type: "password" },
        { label: "Group", key: "group", placeholder: "Production", type: "text" },
      ].map(({ label, key, placeholder, type }) => (
        <label key={key} style={labelStyle}>
          {label}
          <input
            style={fieldStyle} type={type}
            value={form[key as keyof typeof form]}
            onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
            placeholder={placeholder}
          />
        </label>
      ))}

      <label style={labelStyle}>
        Engine
        <select style={fieldStyle} value={form.engine}
          onChange={e => setForm(f => ({ ...f, engine: e.target.value }))}>
          <option value="mysql">MySQL</option>
          <option value="sqlserver">SQL Server</option>
          <option value="postgres">PostgreSQL</option>
          <option value="sqlite">SQLite</option>
        </select>
      </label>

      <label style={labelStyle}>
        SSL Mode
        <select
          style={fieldStyle}
          value={form.sslMode}
          onChange={e => setForm(f => ({ ...f, sslMode: e.target.value }))}
        >
          <option value="prefer">Prefer (default)</option>
          <option value="none">None — no encryption</option>
          <option value="require">Require — encrypt, don't verify cert</option>
          <option value="verify-full">Verify Full — encrypt + verify cert</option>
        </select>
      </label>

      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={form.readOnly}
          onChange={e => setForm(f => ({ ...f, readOnly: e.target.checked }))}
          style={{ width: 14, height: 14, cursor: "pointer" }}
        />
        <div>
          <div style={{ fontSize: 12, color: "#e8e9ec", marginBottom: 2 }}>Read-only connection</div>
          <div style={{ fontSize: 10, color: "#4b5563" }}>
            Blocks INSERT, UPDATE, DELETE, and DROP at the driver level
          </div>
        </div>
      </label>

      <label style={labelStyle}>
        Colour
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
          <input type="color" value={form.color}
            onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
            style={{ width: 32, height: 28, border: "none", background: "none", cursor: "pointer", flexShrink: 0 }}
          />
          <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>{form.color}</span>
        </div>
      </label>

      {error && <div style={{ fontSize: 11, color: "#ef4444", marginBottom: 8, wordBreak: "break-word" }}>{error}</div>}

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button onClick={handleSave} disabled={saving} style={{
          flex: 1, padding: "7px 0", background: "#6c63ff", color: "white",
          border: "none", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer",
          fontSize: 12, fontFamily: "monospace",
        }}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={onCancel} style={{
          flex: 1, padding: "7px 0", background: "transparent", color: "#6b7280",
          border: "1px solid #2d2f36", borderRadius: 6, cursor: "pointer",
          fontSize: 12, fontFamily: "monospace",
        }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- Results grid -----------------------------------------
function ResultsGrid({ result }: { result: QueryResult }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [filterText, setFilterText] = useState("");
  const debouncedFilter = useDebounce(filterText, 300);
  const [sorting, setSorting] = useState<import("@tanstack/react-table").SortingState>([]);

  const columnHelper = createColumnHelper<(string | null)[]>();

  const columns = result.columns.map((col, i) =>
    columnHelper.accessor((row) => row[i], {
      id: col,
      header: col,
      cell: (info) => {
        const val = info.getValue();
        if (val === null)
          return <span style={{ color: "#6b7280", fontStyle: "italic" }}>NULL</span>;
        return val;
      },
    })
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

  const table = useReactTable({
    data: filteredRows,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    onSortingChange: setSorting,
    state: { sorting },
  });

  const { rows } = table.getRowModel();

  const rowVirtualiser = useVirtualizer({
    count: rows.length,
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
        borderBottom: "1px solid #1e2026",
        background: "#13141a",
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
            background: "#0e0f11",
            border: "1px solid #2d2f36",
            borderRadius: 6,
            color: "#e8e9ec",
            fontSize: 12,
            fontFamily: "monospace",
            padding: "4px 10px",
            outline: "none",
            width: 260,
          }}
        />
        {debouncedFilter && (
          <>
            <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
              {rows.length} of {result.rowCount} rows
            </span>
            <button
              onClick={() => setFilterText("")}
              style={{
                background: "none", border: "none", color: "#6b7280",
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
              background: "none", border: "none", color: "#6b7280",
              cursor: "pointer", fontSize: 11, padding: "2px 6px",
              fontFamily: "monospace", marginLeft: "auto",
            }}
          >
            ✕ clear sort
          </button>
        )}
      </div>

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
                      background: "#1e2026", borderBottom: "1px solid #2d2f36",
                      color: header.column.getIsSorted() ? "#e8e9ec" : "#9ca3af",
                      fontWeight: 500, whiteSpace: "nowrap",
                      cursor: "pointer", userSelect: "none",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc"  && <span style={{ color: "#6c63ff" }}>↑</span>}
                      {header.column.getIsSorted() === "desc" && <span style={{ color: "#6c63ff" }}>↓</span>}
                      {!header.column.getIsSorted() && (
                        <span style={{ color: "#2d2f36", fontSize: 10 }}>⇅</span>
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
              const row = rows[virtualRow.index];
              return (
                <tr key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                     onClick={() => {
                        const val = cell.getValue() as string | null;
                        if (val === null) return;
                        const cellId = cell.id;

                        import("@tauri-apps/plugin-clipboard-manager").then(({ writeText, readText, clear }) => {
                          writeText(val).then(() => {
                            setCopiedCell(cellId);
                            setTimeout(() => setCopiedCell(null), 800);

                            setTimeout(() => {
                              readText().then(current => {
                                if (current === val) {
                                  clear().catch(() => {});
                                }
                              }).catch(() => {});
                            }, 60_000);

                          }).catch(() => {});
                        });
                      }}
                      title="Click to copy"
                      style={{
                        padding: "5px 14px",
                        borderBottom: "1px solid #1e2026",
                        color: "#e8e9ec",
                        whiteSpace: "nowrap",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        cursor: "pointer",
                        background: copiedCell === cell.id
                          ? "rgba(108,99,255,0.15)"
                          : virtualRow.index % 2 === 0 ? "#0e0f11" : "#13141a",
                        transition: "background .15s",
                      }}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {paddingBottom > 0 && (
              <tr><td style={{ height: paddingBottom }} colSpan={columns.length} /></tr>
            )}
          </tbody>
        </table>

        {rows.length === 0 && filterText && (
          <div style={{ padding: "24px 14px", color: "#4b5563", fontSize: 13, textAlign: "center" }}>
            No rows match "{filterText}"
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Resizable split helper -------------------------------
function useResizable(initial: number, min: number, max: number) {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startSize = useRef(initial);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    dragging.current = true;
    startY.current = e.clientY;
    startSize.current = size;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
  }, [size]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragging.current) return;
      const delta = e.clientY - startY.current;
      setSize(Math.min(max, Math.max(min, startSize.current + delta)));
    }
    function onMouseUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [min, max]);

  return { size, onMouseDown };
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState<T>(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

// ---- Main App ---------------------------------------------
function App() {
  const editorRef = useRef<any>(null);
  const activeConnectionRef = useRef<ConnectionConfig | null>(null);
  const activeFileRef = useRef<FileSession | null>(null);
  const resultClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [activeConnection, setActiveConnection] = useState<ConnectionConfig | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [files, setFiles] = useState<FileSession[]>([]);
  const [activeFile, setActiveFile] = useState<FileSession | null>(null);
  const [joinTables, setJoinTables] = useState<string[]>([]);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const sidebarDragging = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartW = useRef(220);

  const { size: editorHeight, onMouseDown: onEditorDragStart } = useResizable(220, 80, 600);

  const CONNECTIONS_FOLDER = "C:/Users/keith/source/repos/DevSql/connections";
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const schemaRef = useRef<SchemaResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [locked, setLocked] = useState(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOCK_AFTER_MS = 15 * 60 * 1000; // 15 minutes

  // Keep refs in sync
  useEffect(() => { activeConnectionRef.current = activeConnection; }, [activeConnection]);
  useEffect(() => { activeFileRef.current = activeFile; }, [activeFile]);

  // Sidebar resize
  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!sidebarDragging.current) return;
      const delta = e.clientX - sidebarStartX.current;
      setSidebarWidth(Math.min(380, Math.max(160, sidebarStartW.current + delta)));
    }
    function onUp() {
      if (!sidebarDragging.current) return;
      sidebarDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  function onSidebarDragStart(e: React.MouseEvent) {
    sidebarDragging.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartW.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  // Result auto-clear on unmount
  useEffect(() => {
    return () => { if (resultClearTimer.current) clearTimeout(resultClearTimer.current); };
  }, []);

  useEffect(() => { loadConnections(); }, []);
  useEffect(() => { schemaRef.current = schema; }, [schema]);

  async function loadConnections() {
    try {
      const raw = await invoke<string>("list_connections", { folderPath: CONNECTIONS_FOLDER });
      const parsed: ConnectionListResult = JSON.parse(raw);
      setConnections(parsed.connections ?? []);
      if (parsed.connections?.length > 0 && !activeConnectionRef.current) {
        setActiveConnection(parsed.connections[0]);
      }
    } catch (e) {
      console.error("Failed to load connections:", e);
    }
  }

  // Inactivity lock
  function resetInactivityTimer() {
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (locked) return; // don't reset if already locked
    inactivityTimer.current = setTimeout(() => {
      setLocked(true);
    }, LOCK_AFTER_MS);
  }

  useEffect(() => {
    const events = ["mousemove", "keydown", "mousedown", "touchstart"];
    events.forEach(e => window.addEventListener(e, resetInactivityTimer));
    resetInactivityTimer(); // start the timer on mount

    return () => {
      events.forEach(e => window.removeEventListener(e, resetInactivityTimer));
      if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    };
  }, [locked]);
  //END Inactivity lock

  //Open File Function
  async function openFile() {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        multiple: false,
        filters: [{ name: "Data files", extensions: ["csv", "json", "xlsx"] }]
      });
      if (!selected || typeof selected !== "string") return;
      const name = selected.split(/[/\\]/).pop() ?? selected;
      const ext  = name.split(".").pop()?.toLowerCase() ?? "csv";
      const file: FileSession = {
        id: `file-${Date.now()}`, name, path: selected,
        type: ext as "csv" | "json" | "xlsx",
      };
      setFiles(f => [...f, file]);
      setActiveFile(file);
      setJoinTables([]);
      editorRef.current?.setValue("SELECT * FROM data LIMIT 100");
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }

  //Run Query Function
  const runQuery = useCallback(async () => {
    if (locked) return; // prevent running queries when locked
    const sql = editorRef.current?.getValue()?.trim() ?? "";
    if (!sql) return;

    setLoading(true);
    setError(null);
    setResult(null);

    const start = performance.now();
    let historyConn: ConnectionConfig | null = null;

    try {
      let raw: string;

      if (activeFileRef.current) {
        if (joinTables.length > 0 && activeConnectionRef.current) {
          const conn = activeConnectionRef.current;
          raw = await invoke<string>("query_file_with_db", {
            filePath:   activeFileRef.current.path,
            sql,
            credentialRef: conn.credentialRef,
            engine:     conn.engine,
            host:       conn.host,
            port:       conn.port,
            database:   conn.database,
            username:   conn.username,
            tableNames: joinTables.join(","),
            sslMode:    conn.sslMode ?? "prefer",
          });
        } else {
          raw = await invoke<string>("query_file", {
            filePath: activeFileRef.current.path,
            sql,
          });
        }
      } else if (activeConnectionRef.current) {
        const conn = activeConnectionRef.current;
        historyConn = conn; // track for history saving after parse

        const connectionString = await invoke<string>("build_connection_string", {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          conn.host,
          port:          conn.port,
          database:      conn.database,
          username:      conn.username,
          sslMode:       conn.sslMode ?? "prefer",
        });

        raw = await invoke<string>("execute_query", {
          connectionString,
          sql,
          engine:   conn.engine,
          readOnly: conn.readOnly ?? false,
        });
      } else {
        alert("Select a connection or open a file first");
        return;
      }

      const parsed = JSON.parse(raw);
      const ms = Math.round(performance.now() - start);
      setDuration(ms);

      // Save to history after parse — single source of truth
      if (historyConn) {
        await saveToHistory(
          historyConn,
          sql,
          ms,
          parsed.rowCount ?? 0,
          !parsed.error
        );
        // Refresh history panel if it's open
        if (showHistory) loadHistory(historyConn);
      }

      if (parsed.error) {
        setError(parsed.error);
      } else {
        setResult(parsed);
        if (resultClearTimer.current) clearTimeout(resultClearTimer.current);
        resultClearTimer.current = setTimeout(() => {
          setResult(null);
          setDuration(null);
        }, 5 * 60 * 1000);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [joinTables, showHistory, locked]);
  //End Run Query Function

  const handleEditorMount: OnMount = (editor, monaco) => {
      editorRef.current = editor;

      // Cmd+Enter to run
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => runQuery());

      // Register SQL autocomplete provider
      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [" ", ".", "\n"],
        provideCompletionItems: (model, position) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: monaco.languages.CompletionItem[] = [];

          // SQL keywords
          const keywords = [
            "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN",
            "INNER JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT",
            "OFFSET", "INSERT INTO", "UPDATE", "DELETE FROM", "CREATE TABLE",
            "DROP TABLE", "ALTER TABLE", "AND", "OR", "NOT", "IN", "IS NULL",
            "IS NOT NULL", "LIKE", "BETWEEN", "DISTINCT", "COUNT", "SUM",
            "AVG", "MIN", "MAX", "AS", "CASE", "WHEN", "THEN", "ELSE", "END",
          ];

          keywords.forEach(kw => {
            suggestions.push({
              label: kw,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: kw,
              range,
            });
          });

          // Tables and columns from schema
          if (schemaRef.current?.tables) {
            schemaRef.current.tables.forEach(table => {
              // Table name suggestion
              suggestions.push({
                label: table.name,
                kind: monaco.languages.CompletionItemKind.Class,
                insertText: table.name,
                detail: `table · ${table.columns.length} columns`,
                documentation: table.columns.map(c => `${c.name} (${c.dataType})`).join("\n"),
                range,
              });

              // Column name suggestions
              table.columns.forEach(col => {
                suggestions.push({
                  label: col.name,
                  kind: monaco.languages.CompletionItemKind.Field,
                  insertText: col.name,
                  detail: `${col.dataType}${col.isPrimaryKey ? " · PK" : ""}${col.isNullable ? "" : " · NOT NULL"}`,
                  documentation: `${table.name}.${col.name}`,
                  range,
                });
              });
            });
          }

          return { suggestions };
        },
      });
  };

async function loadSchema(conn: ConnectionConfig) {
  setSchema(null);
  setSchemaLoading(true);
  try {
    const raw = await invoke<string>("get_schema", {
      credentialRef: conn.credentialRef,
      engine: conn.engine,
      host: conn.host,
      port: conn.port,
      database: conn.database,
      username: conn.username,
    });
    const parsed: SchemaResult = JSON.parse(raw);
    setSchema(parsed);
  } catch (e) {
    console.error("Schema load failed:", e);
  } finally {
    setSchemaLoading(false);
  }
}

async function saveToHistory(
  conn: ConnectionConfig,
  sql: string,
  durationMs: number,
  rowCount: number,
  success: boolean
) {
  try {
    // Use setTimeout to ensure this runs after execute_query fully completes
    await new Promise(resolve => setTimeout(resolve, 0));
    
    const result = await invoke<boolean>("add_history_entry", {
      connectionId:   conn.id,
      connectionName: conn.name,
      sql:            sql.trim(),
      executedAt:     Date.now(),
      durationMs,
      rowCount,
      success,
    });
    console.log("History save result:", result);
  } catch (e) {
    console.error("Failed to save history:", e);
  }
}

async function loadHistory(conn: ConnectionConfig | null) {
  try {
    console.log("Loading history for:", conn?.id ?? "all");
    const raw = await invoke<string>("get_history", {
      connectionId: conn?.id ?? "",
      limit: 100,
    });
    console.log("History raw:", raw);
    const parsed = JSON.parse(raw);
    console.log("Loading with conn?.id:", conn?.id ?? "empty");
    console.log("History save result:", result);
    setHistory(parsed.entries ?? []);
  } catch (e) {
    console.error("Failed to load history:", e);
  }
}

  return (
    <div style={{
      display: "flex", height: "100vh", width: "100vw",
      background: "#0e0f11", color: "#e8e9ec", fontFamily: "monospace",
      overflow: "hidden", boxSizing: "border-box",
    }}>

      {/* Lock overlay */}
      {locked && (
        <div
          onClick={() => {
            setLocked(false);
            resetInactivityTimer();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(14,15,17,0.92)",
            backdropFilter: "blur(12px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <div style={{
            fontSize: 48,
            marginBottom: 24,
          }}>
            🔒
          </div>
          <div style={{
            fontSize: 20,
            fontWeight: 700,
            color: "#e8e9ec",
            marginBottom: 8,
            fontFamily: "monospace",
          }}>
            DevSql is locked
          </div>
          <div style={{
            fontSize: 13,
            color: "#6b7280",
            fontFamily: "monospace",
          }}>
            Click anywhere to unlock
          </div>
          <div style={{
            marginTop: 32,
            fontSize: 11,
            color: "#374151",
            fontFamily: "monospace",
          }}>
            Locked after 15 minutes of inactivity
          </div>
        </div>
      )}

      {/* Sidebar */}
      <div style={{
        width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth,
        background: "#13141a", borderRight: "1px solid #1e2026",
        display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0,
      }}>
        {/* Sidebar header */}
        <div style={{
          padding: "12px 14px", borderBottom: "1px solid #1e2026",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <span style={{ color: "#6c63ff", fontWeight: 700, fontSize: 14, letterSpacing: ".02em" }}>DevSQL</span>
        </div>

        {showAddForm ? (
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            <AddConnectionForm
              connectionsFolder={CONNECTIONS_FOLDER}
              onSave={() => { setShowAddForm(false); loadConnections(); }}
              onCancel={() => setShowAddForm(false)}
            />
          </div>
        ) : (
          <div style={{ flex: 1, overflow: "auto", minHeight: 0 }}>
            {/* Connections section label */}
            <div style={{ padding: "8px 14px 4px", borderBottom: "1px solid #1e2026", fontSize: 10, fontWeight: 600, color: "#4b5563", textTransform: "uppercase", letterSpacing: ".06em" }}>
              Connections &nbsp;&nbsp;
              <button onClick={() => setShowAddForm(v => !v)} title="Add connection" style={{
                  background: "none", border: "1px solid #2d2f36", borderRadius: 4,
                  color: "#9ca3af", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 7px", flexShrink: 0,
                }}>
                  {showAddForm ? "×" : "+"}
              </button>
            </div>

            {connections.length === 0 ? (
              <div style={{ padding: "6px 14px 10px", color: "#4b5563", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
                No connections yet.<br />Click + to add one.
              </div>
            ) : (
              connections.map((conn) => (
                <div key={conn.id}>
                  {/* Connection row */}
                  <div
                    onClick={() => {
                      setActiveConnection(conn);
                      setActiveFile(null);
                      setJoinTables([]);
                      setSchema(null);
                      setExpandedTables(new Set());
                      loadSchema(conn);
                    }}
                    style={{
                      padding: "9px 14px",
                      cursor: "pointer",
                      borderBottom: "1px solid #1e2026",
                      borderLeft: `3px solid ${
                        activeConnection?.id === conn.id ? conn.color : "transparent"
                      }`,
                      background: activeConnection?.id === conn.id ? "#1e2026" : "transparent",
                      transition: "background .1s",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 3, color: "#e8e9ec", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {conn.name}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <EngineBadge engine={conn.engine} />
                      <span style={{ fontSize: 10, color: "#4b5563", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                        {conn.host}
                      </span>
                    </div>
                  </div>

                  {/* Schema tree — only shown for the active connection */}
                  {activeConnection?.id === conn.id && (
                    <div style={{ background: "#0e0f11", borderBottom: "1px solid #1e2026" }}>
                      {schemaLoading && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "#4b5563", fontFamily: "monospace" }}>
                          Loading schema…
                        </div>
                      )}

                      {schema?.error && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "#ef4444", fontFamily: "monospace" }}>
                          {schema.error}
                        </div>
                      )}

                      {schema && !schema.error && (
                        <>
                          {/* Refresh button */}
                          <div style={{ padding: "5px 14px 3px", display: "flex", justifyContent: "flex-end" }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); loadSchema(conn); }}
                              style={{ background: "none", border: "none", color: "#4b5563", cursor: "pointer", fontSize: 10, fontFamily: "monospace", padding: "2px 4px" }}
                              title="Refresh schema"
                            >
                              ↻ refresh
                            </button>
                          </div>

                          {/* Table list */}
                          {schema.tables.map((table) => (
                            <div key={table.name}>
                              {/* Table row */}
                              <div
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 6,
                                  padding: "5px 14px",
                                  cursor: "pointer",
                                  borderTop: "1px solid #1a1b21",
                                }}
                                onClick={() => {
                                  // Toggle expand/collapse
                                  const next = new Set(expandedTables);
                                  next.has(table.name) ? next.delete(table.name) : next.add(table.name);
                                  setExpandedTables(next);
                                }}
                                onDoubleClick={() => {
                                  // Insert SELECT query into editor
                                  const q = `SELECT * FROM ${table.name} LIMIT 100`;
                                  editorRef.current?.setValue(q);
                                  editorRef.current?.focus();
                                }}
                                title="Click to expand · Double-click to query"
                              >
                                <span style={{ fontSize: 9, color: "#4b5563", flexShrink: 0, width: 10 }}>
                                  {expandedTables.has(table.name) ? "▾" : "▸"}
                                </span>
                                <span style={{
                                  fontSize: 11,
                                  color: "#9ca3af",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  fontFamily: "monospace",
                                  flex: 1,
                                }}>
                                  {table.name}
                                </span>
                                <span style={{ fontSize: 9, color: "#374151", fontFamily: "monospace", flexShrink: 0 }}>
                                  {table.columns.length}
                                </span>
                              </div>

                              {/* Column list — shown when table is expanded */}
                              {expandedTables.has(table.name) && table.columns.map((col) => (
                                <div
                                  key={col.name}
                                  style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "3px 14px 3px 26px",
                                    borderTop: "1px solid #111318",
                                  }}
                                >
                                  {/* PK indicator */}
                                  {col.isPrimaryKey && (
                                    <span style={{ fontSize: 8, color: "#f59e0b", flexShrink: 0 }} title="Primary key">🔑</span>
                                  )}
                                  <span style={{
                                    fontSize: 11,
                                    color: col.isPrimaryKey ? "#e8e9ec" : "#6b7280",
                                    fontFamily: "monospace",
                                    flex: 1,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {col.name}
                                  </span>
                                  <span style={{
                                    fontSize: 9,
                                    color: "#374151",
                                    fontFamily: "monospace",
                                    flexShrink: 0,
                                  }}>
                                    {col.dataType}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))
            )}

            {/* Files section */}
            <div style={{ borderTop: "1px solid #1e2026", marginTop: 4 }}>
              <div style={{
                padding: "8px 14px 4px", fontSize: 10, fontWeight: 600, color: "#4b5563",
                textTransform: "uppercase", letterSpacing: ".06em",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <span>Files</span>
                <button onClick={openFile} title="Open file" style={{
                  background: "none", border: "1px solid #2d2f36", borderRadius: 4,
                  color: "#9ca3af", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "1px 6px",
                }}>
                  +
                </button>
              </div>

              {files.length === 0 ? (
                <div style={{ padding: "6px 14px 10px", color: "#4b5563", fontSize: 11 }}>
                  Open a CSV or JSON file
                </div>
              ) : (
                files.map(file => (
                  <div
                    key={file.id}
                    onClick={() => { setActiveFile(file); setJoinTables([]); editorRef.current?.setValue("SELECT * FROM data LIMIT 100"); }}
                    style={{
                      padding: "8px 14px", cursor: "pointer",
                      borderBottom: "1px solid #1e2026",
                      borderLeft: `3px solid ${activeFile?.id === file.id ? "#10b981" : "transparent"}`,
                      background: activeFile?.id === file.id ? "#1e2026" : "transparent",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 500, color: "#e8e9ec", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>
                      {file.name}
                    </div>
                    <span style={{
                      fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 20,
                      background: "rgba(16,185,129,0.12)", color: "#10b981",
                      textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "monospace",
                    }}>
                      {file.type}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Sidebar resize handle */}
      <div
        onMouseDown={onSidebarDragStart}
        style={{ width: 4, cursor: "col-resize", background: "transparent", flexShrink: 0, transition: "background .15s", zIndex: 10 }}
        onMouseEnter={e => (e.currentTarget.style.background = "#6c63ff44")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
          borderBottom: "1px solid #1e2026", background: "#13141a",
          flexShrink: 0, flexWrap: "wrap", minHeight: 44,
        }}>
          {/* Active connection pill */}
          {activeConnection && (
              <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
                  background: "#1e2026", borderRadius: 6,
                  border: `1px solid ${activeConnection.color}44`,
                  minWidth: 0, overflow: "hidden",
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: activeConnection.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: "#e8e9ec", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {activeConnection.name}
                  </span>
                  <EngineBadge engine={activeConnection.engine} />
                  {activeConnection.readOnly && (
                    <span style={{
                      fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 20,
                      background: "rgba(245,158,11,0.12)", color: "#f59e0b",
                      textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "monospace",
                      flexShrink: 0,
                    }}>
                      read-only
                    </span>
                  )}
                </div>
          )}

          {/* Active file pill */}
          {activeFile && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
              background: "#1e2026", borderRadius: 6, border: "1px solid rgba(16,185,129,0.3)",
            }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "#e8e9ec" }}>{activeFile.name}</span>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 20,
                background: "rgba(16,185,129,0.12)", color: "#10b981",
                textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "monospace",
              }}>
                {activeFile.type}
              </span>
            </div>
          )}

          <button
            onClick={runQuery}
            disabled={loading || (!activeConnection && !activeFile)}
            style={{
              padding: "6px 14px",
              background: loading || (!activeConnection && !activeFile) ? "#2d2f36" : "#6c63ff",
              color: "white", border: "none", borderRadius: 6,
              cursor: loading || (!activeConnection && !activeFile) ? "not-allowed" : "pointer",
              fontSize: 12, fontFamily: "monospace", flexShrink: 0, whiteSpace: "nowrap",
            }}
          >
            {loading ? "Running..." : "▶ Run (Cmd+Enter)"}
          </button>
          <button
            onClick={() => {
              setShowHistory(h => !h);
              if (!showHistory) loadHistory(activeConnectionRef.current);
            }}
            style={{
              padding: "6px 14px",
              background: showHistory ? "#1e2026" : "none",
              color: showHistory ? "#e8e9ec" : "#6b7280",
              border: "1px solid #2d2f36",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "monospace",
              flexShrink: 0,
            }}
          >
            ⏱ History
          </button>
          {duration !== null && !loading && (
            <span style={{ color: "#6b7280", fontSize: 11, whiteSpace: "nowrap" }}>
              {result ? `${result.rowCount} rows · ` : ""}{duration}ms
              {result?.truncated && (
                <span style={{ color: "#f59e0b", marginLeft: 8 }}>
                  ⚠ first 10,000 rows shown
                </span>
              )}
            </span>
          )}
        </div>
        
        {/* History panel — only shown when a connection is active and history is toggled on */}
        {showHistory && (
          <div style={{
            borderBottom: "1px solid #1e2026",
            background: "#13141a",
            maxHeight: 240,
            overflow: "auto",
            flexShrink: 0,
          }}>
            <div style={{
              padding: "6px 14px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              borderBottom: "1px solid #1e2026",
              position: "sticky",
              top: 0,
              background: "#13141a",
            }}>
              <span style={{ fontSize: 11, color: "#6b7280", fontFamily: "monospace" }}>
                Recent queries
              </span>
              <button
                onClick={async () => {
                  await invoke("clear_history", {
                    connectionId: activeConnectionRef.current?.id ?? ""
                  });
                  setHistory([]);
                }}
                style={{
                  background: "none", border: "none", color: "#6b7280",
                  cursor: "pointer", fontSize: 11, fontFamily: "monospace",
                }}
              >
                Clear
              </button>
            </div>

            {history.length === 0 ? (
              <div style={{ padding: "12px 14px", color: "#4b5563", fontSize: 12, fontFamily: "monospace" }}>
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
                    borderBottom: "1px solid #1a1b21",
                    cursor: "pointer",
                    transition: "background .1s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = "#1e2026")}
                  onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                >
                  <div style={{
                    fontSize: 11,
                    color: entry.success ? "#9ca3af" : "#ef4444",
                    fontFamily: "monospace",
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
                    color: "#4b5563",
                    fontFamily: "monospace",
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
        )}
        {/*End History Panel */}

        {/* Join tables panel — only shown when a file is active */}
        {activeFile && (
          <JoinTablesPanel
            activeConnection={activeConnection}
            onSelectionChange={setJoinTables}
          />
        )}

        {/* Editor */}
        <div style={{ height: editorHeight, minHeight: editorHeight, maxHeight: editorHeight, borderBottom: "1px solid #1e2026", flexShrink: 0, overflow: "hidden" }}>
          <Editor
            height="100%"
            defaultLanguage="sql"
            theme="vs-dark"
            defaultValue="-- Write your query here&#10;SELECT 1"
            onMount={handleEditorMount}
            options={{
              fontSize: 14, minimap: { enabled: false },
              scrollBeyondLastLine: false, lineNumbers: "on",
              renderLineHighlight: "line", fontFamily: "monospace",
              padding: { top: 12 }, wordWrap: "on",
            }}
          />
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={onEditorDragStart}
          style={{ height: 4, cursor: "row-resize", background: "transparent", flexShrink: 0, transition: "background .15s", zIndex: 10 }}
          onMouseEnter={e => (e.currentTarget.style.background = "#6c63ff44")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
        />

        {/* Results area */}
        <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", minHeight: 0 }}>
          {error && (
            <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.1)", borderBottom: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", fontSize: 12, wordBreak: "break-word", flexShrink: 0 }}>
              ❌ {error}
            </div>
          )}
          {result && result.rows.length === 0 && (
            <div style={{ padding: "16px", color: "#6b7280", fontSize: 13 }}>
              Query executed successfully — 0 rows returned
            </div>
          )}
          {result && result.rows.length > 0 && <ResultsGrid result={result} />}
          {!result && !error && !loading && (
            <div style={{ padding: "40px 16px", color: "#374151", fontSize: 13, textAlign: "center" }}>
              {activeFile
                ? "Write a query using \"data\" as the table name, or join DB tables above"
                : activeConnection
                ? "Write a query and press Cmd+Enter to run it"
                : "Select a connection or open a file to get started"}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;