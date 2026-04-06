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
  sqlInstance: string;
  windowsAuth: boolean;
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

interface Tab {
  id: string;
  title: string;
  sql: string;
  connection: ConnectionConfig | null;
  file: FileSession | null;
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
  duration: number | null;
  joinTables: string[];
}

function createTab(id?: string): Tab {
  return {
    id:         id ?? `tab-${Date.now()}`,
    title:      "New tab",
    sql:        "",
    connection: null,
    file:       null,
    result:     null,
    error:      null,
    loading:    false,
    duration:   null,
    joinTables: [],
  };
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
    setLoading(true);  // ← local state, not updateActiveTab
    setError(null);    // ← local state, not updateActiveTab
    invoke<string>("list_db_tables", {
      credentialRef: activeConnection.credentialRef,
      engine: activeConnection.engine,
      host: activeConnection.host,
      port: activeConnection.port,
      database: activeConnection.database,
      username: activeConnection.username,
      sslMode: activeConnection.sslMode ?? "prefer",
      sqlInstance: activeConnection.sqlInstance ?? "",
      windowsAuth: activeConnection.windowsAuth ?? false,
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
  editingConnection,
}: {
  onSave: () => void;
  onCancel: () => void;
  connectionsFolder: string;
  editingConnection: Connection | null;
}) {
  const [form, setForm] = useState({
    name:         editingConnection?.name        ?? "",
    engine:       editingConnection?.engine      ?? "mysql",
    host:         editingConnection?.host        ?? "",
    port:         editingConnection?.port?.toString() ?? "",
    database:     editingConnection?.database    ?? "",
    username:     editingConnection?.username    ?? "",
    password:     "", // never pre-fill password
    color:        editingConnection?.color       ?? "#6c63ff",
    group:        editingConnection?.group       ?? "",
    sslMode:      editingConnection?.sslMode     ?? "prefer",
    readOnly:     editingConnection?.readOnly    ?? false,
    sqlInstance:  editingConnection?.sqlInstance ?? "",
    windowsAuth:  editingConnection?.windowsAuth ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const fieldStyle: React.CSSProperties = {
    width: "100%", padding: "6px 10px", background: "#0e0f11",
    border: "1px solid #2d2f36", borderRadius: 6, color: "#e8e9ec",
    fontSize: 12, fontFamily: "monospace", marginTop: 3,
    outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "#6b7280", display: "block", marginBottom: 8, width: "100%",
  };

  // Save connection handler
  async function handleSave() {
    // ... existing validation ...
    setSaving(true);
    setError(null);
    try {
      const request = {
        name:        form.name,
        engine:      form.engine,
        host:        form.host,
        port:        parseInt(form.port) || defaultPort[form.engine] || 3306,
        database:    form.database,
        username:    form.username,
        color:       form.color,
        group:       form.group,
        folderPath:  connectionsFolder,
        sslMode:     form.sslMode,
        readOnly:    form.readOnly,
        sqlInstance: form.sqlInstance,
        windowsAuth: form.windowsAuth,
        // Pass existing filePath when editing so ConnectionManager overwrites it
        existingFilePath: editingConnection?.filePath ?? "",
      };
      const result = await invoke<string>("save_connection", {
        requestJson: JSON.stringify(request),
      });
      if (result.startsWith("ERROR")) { setError(result); return; }

      const newRef = `devsql:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`;

      if (form.password) {
       console.log("store_credential target:", newRef);
      console.log("store_credential username:", form.username);
        // User entered a new password — store it under the new ref
        await invoke<boolean>("store_credential", {
          target:   newRef,
          username: form.username,
          password: form.password,
        });
        // Clean up old ref if name changed
        if (editingConnection && editingConnection.credentialRef !== newRef) {
          await invoke("delete_credential", { target: editingConnection.credentialRef });
        }
      } else if (editingConnection) {
        // No new password — migrate old credential to new ref if name changed
        const oldRef = editingConnection.credentialRef;
        if (oldRef !== newRef) {
          await invoke("migrate_credential", {
            oldTarget: oldRef,
            newTarget: newRef,
            username:  form.username,
          });
        }
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
        {editingConnection ? "Edit connection" : "Add connection"}
      </div>

     {[
        { label: "Name",     key: "name",     placeholder: "My Database", type: "text" },
        { label: "Host",     key: "host",     placeholder: "localhost",   type: "text" },
        { label: "Port",     key: "port",     placeholder: "3306",        type: "text" },
        { label: "Database", key: "database", placeholder: "mydb",        type: "text" },
        ...(!form.windowsAuth ? [
          { label: "Username", key: "username", placeholder: "root", type: "text" },
        ] : []),
        { label: "Group", key: "group", placeholder: "Production", type: "text" },
      ].map(({ label, key, placeholder, type }) => (
        <label key={key} style={labelStyle}>
          {label}
          <input
            style={fieldStyle} type={type}
            value={form[key as keyof typeof form] as string}
            onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
            placeholder={placeholder}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
      ))}

      {/* Password field — rendered separately for full control */}
      {!form.windowsAuth && (
        <label style={labelStyle}>
          Password
          <div style={{ position: "relative", marginTop: 3 }}>
            <input
              style={{ ...fieldStyle, marginTop: 0, paddingRight: 36 }}
              type={showPassword ? "text" : "password"}
              value={form.password}
              onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
              placeholder={editingConnection ? "Enter new password to change" : "••••••••"}
              autoComplete="new-password"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            <button
              type="button"
              onClick={() => setShowPassword(s => !s)}
              style={{
                position: "absolute", right: 8, top: "50%",
                transform: "translateY(-50%)",
                background: "none", border: "none",
                color: "#6b7280", cursor: "pointer",
                fontSize: 12, padding: "2px 4px",
              }}
            >
              {showPassword ? "🙈" : "👁"}
            </button>
          </div>
          {editingConnection && (
            <div style={{ fontSize: 10, color: "#4b5563", marginTop: 4, lineHeight: 1.5 }}>
              Updates the password DbArk uses to connect. Change the password on the server first, then update it here.
            </div>
          )}
        </label>
      )}

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

      {/*SQL Server Specific Settings*/}
      {form.engine === "sqlserver" && (
        <>
          <label style={labelStyle}>
            Instance Name <span style={{ color: "#4b5563" }}>(optional)</span>
            <input
              style={fieldStyle}
              type="text"
              placeholder="SQLEXPRESS"
              value={form.sqlInstance}
              onChange={e => setForm(f => ({ ...f, sqlInstance: e.target.value }))}
            />
          </label>

          <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={form.windowsAuth}
              onChange={e => setForm(f => ({ ...f, windowsAuth: e.target.checked }))}
              style={{ width: 14, height: 14, cursor: "pointer" }}
            />
            <div>
              <div style={{ fontSize: 12, color: "#e8e9ec", marginBottom: 2 }}>Windows Authentication</div>
              <div style={{ fontSize: 10, color: "#4b5563" }}>
                Use current Windows user — no password required
              </div>
            </div>
          </label>
        </>
      )}

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

      {/* Test connection */}
      <div style={{ marginBottom: 8 }}>
        <button
          onClick={async () => {
            if (!form.host || !form.database) {
              setTestResult("error");
              setTestMessage("Host and database are required to test");
              return;
            }
            setTesting(true);
            setTestResult(null);
            setTestMessage("");
            try {
              const msg = await invoke<string>("test_connection", {
                credentialRef: editingConnection?.credentialRef ??
                  `devsql:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`,
                engine:      form.engine,
                host:        form.host,
                port:        parseInt(form.port) || defaultPort[form.engine] || 3306,
                database:    form.database,
                username:    form.username,
                sslMode:     form.sslMode,
                sqlInstance: form.sqlInstance,
                windowsAuth: form.windowsAuth,
              });
              setTestResult("success");
              setTestMessage(msg);
            } catch (e) {
              setTestResult("error");
              setTestMessage(String(e));
            } finally {
              setTesting(false);
            }
          }}
          disabled={testing}
          style={{
            width: "100%", padding: "7px 0",
            background: "transparent",
            color: testing ? "#4b5563" : "#9ca3af",
            border: "1px solid #2d2f36",
            borderRadius: 6, cursor: testing ? "not-allowed" : "pointer",
            fontSize: 12, fontFamily: "monospace",
          }}
        >
          {testing ? "Testing…" : "⚡ Test connection"}
        </button>

        {testResult && (
          <div style={{
            marginTop: 6, padding: "6px 10px", borderRadius: 6, fontSize: 11,
            fontFamily: "monospace",
            background: testResult === "success"
              ? "rgba(16,185,129,0.1)" : "rgba(239,68,68,0.1)",
            color: testResult === "success" ? "#10b981" : "#ef4444",
            border: `1px solid ${testResult === "success"
              ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)"}`,
          }}>
            {testResult === "success" ? "✓ " : "✗ "}{testMessage}
          </div>
        )}
      </div>

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
      id: col && col.trim() ? `${col}_${i}` : `col_${i}`, // ← always unique
      header: col && col.trim() ? col : `(col ${i + 1})`,  // ← friendly display name
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

  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([createTab("tab-1")]);
  const [activeTabId, setActiveTabId] = useState("tab-1");
  const [recentFiles, setRecentFiles] = useState<FileSession[]>([]);
  const activeTab = tabs.find(t => t.id === activeTabId) ?? tabs[0];
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const sidebarDragging = useRef(false);
  const sidebarStartX = useRef(0);
  const sidebarStartW = useRef(220);
  const [showAddForm, setShowAddForm] = useState(false);
  const { size: editorHeight, onMouseDown: onEditorDragStart } = useResizable(220, 80, 600);

const [connectionsFolder, setConnectionsFolder] = useState("");
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const schemaRef = useRef<SchemaResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [locked, setLocked] = useState(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const LOCK_AFTER_MS = 15 * 60 * 1000; // 15 minutes
  const activeTabRef = useRef<Tab>(activeTab);
  const runQueryRef = useRef<() => Promise<void>>(async () => {});
  const sqlSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schemaCache = useRef<Map<string, SchemaResult>>(new Map());
const handleJoinSelectionChange = useCallback((tables: string[]) => {
  updateActiveTab({ joinTables: tables });
}, [activeTabId])
const autocompleteRegistered = useRef(false);

const [contextMenu, setContextMenu] = useState<{
  x: number;
  y: number;
  connection: ConnectionConfig;
} | null>(null);

const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
const [deletingConnection, setDeletingConnection] = useState<ConnectionConfig | null>(null);
const [showExportMenu, setShowExportMenu] = useState(false);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

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

  useEffect(() => { schemaRef.current = schema; }, [schema]);

  useEffect(() => {
    if (showHistory) {
      loadHistory(activeTab.connection);
    }
  }, [activeTabId, activeTab.connection]);

  //Active Tab helper - load schema when connection changes
  const schemaConnectionId = useRef<string | null>(null);

  useEffect(() => {
    const conn = activeTab.connection;
    if (conn) {
      if (schemaConnectionId.current === conn.id) return; // already loaded
      schemaConnectionId.current = conn.id;
      setSchema(null);
      setExpandedTables(new Set());
      loadSchema(conn);
    } else {
      schemaConnectionId.current = null;
      setSchema(null);
      setExpandedTables(new Set());
    }
  }, [activeTabId]);

  //END Active Tab Schema helper

  useEffect(() => {
    import("@tauri-apps/api/path").then(({ homeDir, join }) => {
      homeDir().then(async home => {
        const folder = await join(home, ".devsql", "connections");
        console.log("Connections folder:", folder);
        setConnectionsFolder(folder);
        loadConnections(folder);
      });
    });
  }, []);

  async function loadConnections(folder: string) {
    if (!folder) return;
    try {
      const raw = await invoke<string>("list_connections", { folderPath: folder });
      const parsed: ConnectionListResult = JSON.parse(raw);
      setConnections(parsed.connections ?? []);

      if (parsed.connections?.length > 0) {
        const currentConn = activeTabRef.current.connection;
        
        setTabs(prev => prev.map(tab => {
          if (!tab.connection) return tab;
          const fresh = parsed.connections.find(c => c.id === tab.connection!.id);
          if (fresh) {
            schemaCache.current.delete(fresh.id);
            return { ...tab, connection: fresh, error: null, result: null };
          }
          return tab;
        }));

        // If active tab's connection was refreshed, reload schema
        if (currentConn) {
          const freshConn = parsed.connections.find(c => c.id === currentConn.id);
          if (freshConn) {
            schemaConnectionId.current = null;
            setSchema(null);
            setExpandedTables(new Set());
            loadSchema(freshConn);
          }
        }
      }

      if (parsed.connections?.length > 0 && !activeTabRef.current.connection) {
        updateActiveTab({ connection: parsed.connections[0], title: parsed.connections[0].name });
      }
    } catch (e) {
      console.error("Failed to load connections:", e);
    }
  }

  // Update active tab helper
  function updateActiveTab(updates: Partial<Tab>) {
    setTabs(prev => prev.map(t =>
      t.id === activeTabId ? { ...t, ...updates } : t
    ));
  }

  // ---- Inactivity lock --------------------------------------
  const lastActivity = useRef(Date.now());

  function resetInactivityTimer() {
    const now = Date.now();
    if (now - lastActivity.current < 500) return; // throttle to max 2x per second
    lastActivity.current = now;
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (locked) return;
    inactivityTimer.current = setTimeout(() => setLocked(true), LOCK_AFTER_MS);
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
        id:   `file-${Date.now()}`,
        name, path: selected,
        type: ext as "csv" | "json" | "xlsx",
      };

      setRecentFiles(f => {
        const exists = f.find(x => x.path === selected);
        return exists ? f : [file, ...f].slice(0, 10);
      });

      updateActiveTab({
        file:       file,
        connection: null,
        title:      name,
        joinTables: [],
        result:     null,
        error:      null,
      });

      editorRef.current?.setValue("SELECT * FROM data LIMIT 100");
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }

  //Run Query Function
  const runQuery = useCallback(async () => {
    if (locked) return;
    const sql = editorRef.current?.getValue()?.trim() ?? "";
    if (!sql) return;

    const tab = activeTabRef.current;

    updateActiveTab({ loading: true, error: null, result: null });

    const start = performance.now();
    let historyConn: ConnectionConfig | null = null;

    try {
      let raw: string;

      if (tab.file) {
        if (tab.joinTables.length > 0 && tab.connection) {
          const conn = tab.connection;
          raw = await invoke<string>("query_file_with_db", {
            filePath:   tab.file.path,
            sql,
            credentialRef: conn.credentialRef,
            engine:     conn.engine,
            host:       conn.host,
            port:       conn.port,
            database:   conn.database,
            username:   conn.username,
            tableNames: tab.joinTables.join(","),
            sslMode:    conn.sslMode ?? "prefer",
            sqlInstance: conn.sqlInstance ?? "",
            windowsAuth: conn.windowsAuth ?? false,
          });
        } else {
          raw = await invoke<string>("query_file", {
            filePath: tab.file.path,
            sql,
          });
        }
      } else if (tab.connection) {
        const conn = tab.connection;
        historyConn = conn;

        const connectionString = await invoke<string>("build_connection_string", {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          conn.host,
          port:          conn.port,
          database:      conn.database,
          username:      conn.username,
          sslMode:       conn.sslMode ?? "prefer",
          sqlInstance:   conn.sqlInstance ?? "",
          windowsAuth:   conn.windowsAuth ?? false,
        });

        raw = await invoke<string>("execute_query", {
          connectionString,
          sql,
          engine:   conn.engine,
          readOnly: conn.readOnly ?? false,
        });
      } else {
        updateActiveTab({ loading: false, error: "Select a connection or open a file first" });
        return;
      }

      const parsed = JSON.parse(raw);
      const ms = Math.round(performance.now() - start);

      updateActiveTab({
        loading:  false,
        duration: ms,
        result:   parsed.error ? null : parsed,
        error:    parsed.error ?? null,
      });

      if (historyConn) {
        await saveToHistory(historyConn, sql, ms, parsed.rowCount ?? 0, !parsed.error);
        if (showHistory) loadHistory(historyConn);
      }

    } catch (e) {
      updateActiveTab({ loading: false, error: String(e) });
    }
  }, [locked, showHistory, activeTabId]);

  useEffect(() => { runQueryRef.current = runQuery; }, [runQuery]);
  //End Run Query Function

  const handleEditorMount: OnMount = (editor, monaco) => {
      editorRef.current = editor;

    if (!autocompleteRegistered.current) {
      autocompleteRegistered.current = true;
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
    }

      // Cmd+Enter to run
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
        runQueryRef.current();
      });

      // Cmd+T — new tab
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyT, () => {
        const currentSql = editorRef.current?.getValue() ?? "";
        const newTab = createTab();
        setTabs(prev => {
          const updated = prev.map(t =>
            t.id === editorRef.current ? { ...t, sql: currentSql } : t
          );
          return [...updated, newTab];
        });
        setActiveTabId(newTab.id);
        setTimeout(() => editorRef.current?.setValue(""), 0);
      });

      // Cmd+W — close tab
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
        const currentSql = editorRef.current?.getValue() ?? "";
        setTabs(prev => {
          if (prev.length <= 1) return prev;
          const idx = prev.findIndex(t => t.id === editorRef.current);
          // Save current SQL then remove current tab
          const updated = prev.map(t =>
            t.id === editorRef.current ? { ...t, sql: currentSql } : t
          );
          const newTabs = updated.filter(t => t.id !== editorRef.current);
          const nextTab = newTabs[Math.min(idx, newTabs.length - 1)];
          setActiveTabId(nextTab.id);
          setTimeout(() => editorRef.current?.setValue(nextTab.sql ?? ""), 0);
          return newTabs;
        });
      });

    // Save SQL to tab on every change
    editor.onDidChangeModelContent(() => {
      const sql = editor.getValue();
      if (sqlSaveTimer.current) clearTimeout(sqlSaveTimer.current);
      sqlSaveTimer.current = setTimeout(() => {
        setTabs(prev => prev.map(t =>
          t.id === editorRef.current ? { ...t, sql } : t
        ));
      }, 300);
    });
  };

  async function loadSchema(conn: ConnectionConfig) {
    // Return cached schema if available
    if (schemaCache.current.has(conn.id)) {
      setSchema(schemaCache.current.get(conn.id)!);
      return;
    }

    // Evict oldest entry if cache exceeds 5 items
    if (schemaCache.current.size >= 5) {
      const firstKey = schemaCache.current.keys().next().value;
      schemaCache.current.delete(firstKey);
    }

    setSchema(null);
    setSchemaLoading(true);
    try {
      const raw = await invoke<string>("get_schema", {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          conn.host,
        port:          conn.port,
        database:      conn.database,
        username:      conn.username,
        sslMode:       conn.sslMode ?? "prefer",
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
      });
      const parsed: SchemaResult = JSON.parse(raw);
      schemaCache.current.set(conn.id, parsed); // cache it
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
    } catch (e) {
      console.error("Failed to save history:", e);
    }
  }

  //Load query history for a connection
  async function loadHistory(conn: ConnectionConfig | null) {
    if (!conn) {
      setHistory([]);
      return;
    }
    try {
      const raw = await invoke<string>("get_history", {
        connectionId: conn?.id ?? "",
        limit: 100,
      });

      const parsed = JSON.parse(raw);

      setHistory(parsed.entries ?? []);
    } catch (e) {
      console.error("Failed to load history:", e);
    }
  }

  async function exportResults(format: "csv" | "json") {
    const result = activeTab.result;
    if (!result) return;

    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        filters: [{
          name: format === "csv" ? "CSV file" : "JSON file",
          extensions: [format],
        }],
        defaultPath: `query-results.${format}`,
      });

      if (!path) return; // user cancelled

      await invoke("export_results", {
        path,
        format,
        columns: result.columns,
        rows:    result.rows,
      });

    } catch (e) {
      console.error("Export failed:", e);
      updateActiveTab({ error: `Export failed: ${String(e)}` });
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

      {/* Connection Context menu */}
      {contextMenu && (
        <>
          {/* Backdrop to close on click outside */}
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setContextMenu(null)}
          />
          <div style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            zIndex: 1000,
            background: "#1e2026",
            border: "1px solid #2d2f36",
            borderRadius: 8,
            padding: "4px 0",
            minWidth: 160,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}>
            <button
              onClick={() => {
                setEditingConnection(contextMenu.connection);
                setShowAddForm(true);
                setContextMenu(null);
              }}
              style={{
                display: "block", width: "100%", padding: "8px 16px",
                background: "none", border: "none", color: "#e8e9ec",
                fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              ✏️ Edit connection
            </button>
            <button
              onClick={() => {
                setDeletingConnection(contextMenu.connection);
                setContextMenu(null);
              }}
              style={{
                display: "block", width: "100%", padding: "8px 16px",
                background: "none", border: "none", color: "#ef4444",
                fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              🗑️ Delete connection
            </button>
          </div>
        </>
      )}
      {/* END Connection Context menu */}
      {/* Delete confirmation */}
      {deletingConnection && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.6)" }}
            onClick={() => setDeletingConnection(null)} />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 1000, background: "#1e2026",
            border: "1px solid #2d2f36", borderRadius: 12,
            padding: "24px 28px", minWidth: 340,
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#e8e9ec", marginBottom: 8 }}>
              Delete connection
            </div>
            <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 20, lineHeight: 1.6 }}>
              Delete <strong style={{ color: "#e8e9ec" }}>{deletingConnection.name}</strong>?
              This removes the TOML file and keychain entry. This cannot be undone.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    await invoke("delete_connection", { filePath: deletingConnection.filePath });
                    await invoke("delete_credential", { target: deletingConnection.credentialRef });
                    // Clear from tabs if active
                    setTabs(prev => prev.map(t =>
                      t.connection?.id === deletingConnection.id
                        ? { ...t, connection: null, title: "New tab" }
                        : t
                    ));
                    setDeletingConnection(null);
                    loadConnections(connectionsFolder);
                  } catch (e) {
                    console.error("Delete failed:", e);
                  }
                }}
                style={{
                  flex: 1, padding: "8px 0", background: "#ef4444", color: "white",
                  border: "none", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setDeletingConnection(null)}
                style={{
                  flex: 1, padding: "8px 0", background: "transparent", color: "#6b7280",
                  border: "1px solid #2d2f36", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
      {/* END Delete confirmation */}
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
              connectionsFolder={connectionsFolder}
              editingConnection={editingConnection}
              onSave={() => {
                setShowAddForm(false);
                setEditingConnection(null);
                loadConnections(connectionsFolder);
              }}
              onCancel={() => {
                setShowAddForm(false);
                setEditingConnection(null);
              }}
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
                      schemaConnectionId.current = conn.id;
                      updateActiveTab({
                        connection: conn,
                        file:       null,
                        title:      conn.name,
                        joinTables: [],
                        result:     null,
                        error:      null,
                      });
                      setSchema(null);
                      setExpandedTables(new Set());
                      loadSchema(conn);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ x: e.clientX, y: e.clientY, connection: conn });
                    }}
                    style={{
                      padding: "9px 14px",
                      cursor: "pointer",
                      borderBottom: "1px solid #1e2026",
                      borderLeft: `3px solid ${
                        activeTab.connection?.id === conn.id ? conn.color : "transparent"
                      }`,
                      background: activeTab.connection?.id === conn.id ? "#1e2026" : "transparent",
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
                  {activeTab.connection?.id === conn.id && (
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
                              onClick={(e) => { e.stopPropagation(); schemaCache.current.delete(conn.id); loadSchema(conn); }}
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

              {recentFiles.length === 0 ? (
                <div style={{ padding: "6px 14px 10px", color: "#4b5563", fontSize: 11 }}>
                  Open a CSV or JSON file
                </div>
              ) : (
                recentFiles.map(file => (
                  <div
                    key={file.id}
                    onClick={() => {
                      updateActiveTab({
                        file:       file,
                        connection: activeTab.connection, // keep connection for join panel
                        title:      file.name,
                        joinTables: [],
                        result:     null,
                        error:      null,
                      });
                      editorRef.current?.setValue("SELECT * FROM data LIMIT 100");
                    }}
                    style={{
                      padding: "8px 14px", cursor: "pointer",
                      borderBottom: "1px solid #1e2026",
                      borderLeft: `3px solid ${activeTab.file?.id === file.id ? "#10b981" : "transparent"}`,
                      background: activeTab.file?.id === file.id ? "#1e2026" : "transparent",
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

        {/* Tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          background: "#0e0f11",
          borderBottom: "1px solid #1e2026",
          overflowX: "auto",
          flexShrink: 0,
          minHeight: 38,
        }}>
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => {
                if (tab.id === activeTabId) return; // already active
                
                // Save current editor content to current tab
                const currentSql = editorRef.current?.getValue() ?? "";
                setTabs(prev => {
                  const updated = prev.map(t =>
                    t.id === activeTabId ? { ...t, sql: currentSql } : t
                  );
                  // Find the target tab's SQL from the updated array
                  const targetTab = updated.find(t => t.id === tab.id);
                  setTimeout(() => editorRef.current?.setValue(targetTab?.sql ?? ""), 0);
                  return updated;
                });
                setActiveTabId(tab.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                height: 38,
                cursor: "pointer",
                borderRight: "1px solid #1e2026",
                borderBottom: `2px solid ${tab.id === activeTabId ? "#6c63ff" : "transparent"}`,
                background: tab.id === activeTabId ? "#13141a" : "transparent",
                flexShrink: 0,
                maxWidth: 200,
                minWidth: 120,
                transition: "background .1s",
              }}
            >
              {/* Connection colour dot */}
              {tab.connection && (
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: tab.connection.color, flexShrink: 0,
                }} />
              )}
              {tab.file && (
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "#10b981", flexShrink: 0,
                }} />
              )}

              {/* Tab title */}
              <span style={{
                fontSize: 12,
                color: tab.id === activeTabId ? "#e8e9ec" : "#6b7280",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                fontFamily: "monospace",
              }}>
                {tab.title}
              </span>

              {/* Close button — only show if more than one tab */}
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const currentSql = editorRef.current?.getValue() ?? "";
                    const idx = tabs.findIndex(t => t.id === tab.id);
                    setTabs(prev => {
                      const updated = prev.map(t =>
                        t.id === activeTabId ? { ...t, sql: currentSql } : t
                      );
                      const newTabs = updated.filter(t => t.id !== tab.id);
                      if (tab.id === activeTabId) {
                        const nextTab = newTabs[Math.min(idx, newTabs.length - 1)];
                        setActiveTabId(nextTab.id);
                        setTimeout(() => editorRef.current?.setValue(nextTab.sql ?? ""), 0);
                      }
                      return newTabs;
                    });
                  }}
                  style={{
                    background: "none", border: "none",
                    color: "#4b5563", cursor: "pointer",
                    fontSize: 14, lineHeight: 1,
                    padding: "2px 4px", flexShrink: 0,
                    borderRadius: 3,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "#ef4444")}
                  onMouseLeave={e => (e.currentTarget.style.color = "#4b5563")}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {/* New tab button */}
          <button
            onClick={() => {
              // Save current editor content before creating new tab
              const currentSql = editorRef.current?.getValue() ?? "";
              const newTab = createTab();
              setTabs(prev => {
                const updated = prev.map(t =>
                  t.id === activeTabId ? { ...t, sql: currentSql } : t
                );
                return [...updated, newTab];
              });
              setActiveTabId(newTab.id);
              setTimeout(() => editorRef.current?.setValue(""), 0);
            }}
            style={{
              background: "none", border: "none",
              color: "#4b5563", cursor: "pointer",
              fontSize: 18, lineHeight: 1,
              padding: "0 12px", height: 38,
              flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "#e8e9ec")}
            onMouseLeave={e => (e.currentTarget.style.color = "#4b5563")}
            title="New tab (Cmd+T)"
          >
            +
          </button>
        </div>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
          borderBottom: "1px solid #1e2026", background: "#13141a",
          flexShrink: 0, flexWrap: "wrap", minHeight: 44,
        }}>
          {/* Active connection pill */}
          {activeTab.connection && (
              <div style={{
                  display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
                  background: "#1e2026", borderRadius: 6,
                  border: `1px solid ${activeTab.connection.color}44`,
                  minWidth: 0, overflow: "hidden",
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: activeTab.connection.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: "#e8e9ec", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {activeTab.connection.name}
                  </span>
                  <EngineBadge engine={activeTab.connection.engine} />
                  {activeTab.connection.readOnly && (
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
          {activeTab.file && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
              background: "#1e2026", borderRadius: 6, border: "1px solid rgba(16,185,129,0.3)",
            }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "#e8e9ec" }}>{activeTab.file.name}</span>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 20,
                background: "rgba(16,185,129,0.12)", color: "#10b981",
                textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "monospace",
              }}>
                {activeTab.file.type}
              </span>
            </div>
          )}

          <button
            onClick={runQuery}
            disabled={activeTab.loading || (!activeTab.connection && !activeTab.file)}
            style={{
              padding: "6px 14px",
              background: activeTab.loading || (!activeTab.connection && !activeTab.file) ? "#2d2f36" : "#6c63ff",
              color: "white", border: "none", borderRadius: 6,
              cursor: activeTab.loading || (!activeTab.connection && !activeTab.file) ? "not-allowed" : "pointer",
              fontSize: 12, fontFamily: "monospace", flexShrink: 0, whiteSpace: "nowrap",
            }}
          >
            {activeTab.loading ? "Running..." : "▶ Run (Cmd+Enter)"}
          </button>
          <button
            onClick={() => {
              setShowHistory(h => !h);
              if (!showHistory) loadHistory(activeTab.connection);
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
          {activeTab.result && (
            <div style={{ position: "relative", display: "inline-block" }}>
              <button
                onClick={() => setShowExportMenu(e => !e)}
                style={{
                  padding: "6px 14px",
                  background: "none",
                  color: "#6b7280",
                  border: "1px solid #2d2f36",
                  borderRadius: 6,
                  cursor: "pointer",
                  fontSize: 12,
                  fontFamily: "monospace",
                  flexShrink: 0,
                }}
              >
                ↓ Export
              </button>

              {showExportMenu && (
                <>
                  <div
                    style={{ position: "fixed", inset: 0, zIndex: 99 }}
                    onClick={() => setShowExportMenu(false)}
                  />
                  <div style={{
                    position: "absolute",
                    top: "calc(100% + 4px)",
                    right: 0,
                    zIndex: 100,
                    background: "#1e2026",
                    border: "1px solid #2d2f36",
                    borderRadius: 8,
                    padding: "4px 0",
                    minWidth: 140,
                    boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
                  }}>
                    {[
                      { label: "Export as CSV",  format: "csv"  as const },
                      { label: "Export as JSON", format: "json" as const },
                    ].map(({ label, format }) => (
                      <button
                        key={format}
                        onClick={() => { exportResults(format); setShowExportMenu(false); }}
                        style={{
                          display: "block", width: "100%",
                          padding: "8px 16px",
                          background: "none", border: "none",
                          color: "#e8e9ec", fontSize: 12,
                          fontFamily: "monospace", cursor: "pointer",
                          textAlign: "left",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
                        onMouseLeave={e => (e.currentTarget.style.background = "none")}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          {activeTab.duration !== null && !activeTab.loading && (
            <span style={{ color: "#6b7280", fontSize: 11, whiteSpace: "nowrap" }}>
              {activeTab.result ? `${activeTab.result.rowCount} rows · ` : ""}{activeTab.duration}ms
              {activeTab.result?.truncated && (
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
                {activeTab.connection
                  ? `${activeTab.connection.name} — recent queries`
                  : "All recent queries"}
              </span>
              <button
                onClick={async () => {
                  await invoke("clear_history", {
                    connectionId: activeTab.connection?.id ?? ""
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
        {activeTab.file && (
          <JoinTablesPanel
            activeConnection={activeTab.connection}
            onSelectionChange={handleJoinSelectionChange}
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
          {activeTab.error && (
            <div style={{ padding: "10px 14px", background: "rgba(239,68,68,0.1)", borderBottom: "1px solid rgba(239,68,68,0.2)", color: "#ef4444", fontSize: 12, wordBreak: "break-word", flexShrink: 0 }}>
              ❌ {activeTab.error}
            </div>
          )}
          {activeTab.result && activeTab.result.rows.length === 0 && (
            <div style={{ padding: "16px", color: "#6b7280", fontSize: 13 }}>
              Query executed successfully — 0 rows returned
            </div>
          )}
          {activeTab.result && activeTab.result.rows.length > 0 && <ResultsGrid result={activeTab.result} />}
          {!activeTab.result && !activeTab.error && !activeTab.loading && (
            <div style={{ padding: "40px 16px", color: "#374151", fontSize: 13, textAlign: "center" }}>
              {activeTab.file
                ? "Write a query using \"data\" as the table name, or join DB tables above"
                : activeTab.connection
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