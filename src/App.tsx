import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useRef, useEffect, useMemo, Fragment, lazy, Suspense } from "react";
import type { OnMount } from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";

// Monaco is code-split into SqlEditor.tsx and loaded lazily AFTER first paint,
// so the large Monaco bundle no longer blocks initial render. Do NOT statically
// import "monaco-editor" or "@monaco-editor/react" (value) anywhere in this file
// or Monaco gets pulled back into the main bundle.
const SqlEditor = lazy(() => import("./components/SqlEditor/SqlEditor"));
import { format as formatSql } from "sql-formatter";
import Fuse from "fuse.js";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
  createColumnHelper,
} from "@tanstack/react-table";

import { useVirtualizer } from "@tanstack/react-virtual";
import "./theme.css";   // colors — must come first
import "./index.css";   // typography & layout
import { ErDiagram } from "./components/ErDiagram/ErDiagram";

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
  sshEnabled:  boolean;
  sshHost:     string;
  sshPort:     number;
  sshUser:     string;
  sshKeyPath:  string;
}

interface ConnectionListResult {
  connections: ConnectionConfig[];
  error?: string;
}

interface QueryResult {
  columns:   string[];
  rows:      (string | null)[][];
  rowCount:  number;
  truncated?: boolean;
  largeResult?: boolean;
  error?:    string;
  isMessage?: boolean;
  sql?:      string;  
  wasRewritten?: boolean;
  // True when this result is the output of an EXPLAIN / SHOWPLAN_XML wrapper.
  // The plan renderer detects this flag and replaces the data grid with the
  // tree visualisation. Set by runQuery when includePlan is enabled.
  isPlan?:   boolean;
  // The engine that produced the plan — needed because each engine's parser
  // expects a different format (Postgres JSON, SQL Server XML, MySQL JSON).
  planEngine?: string;
}

// ── Execution plan tree ─────────────────────────────────────────────────────
// Normalised across engines. Postgres JSON, SQL Server XML, and MySQL JSON
// all parse into this same shape so the renderer code is engine-agnostic.
//
//   label    — short operator name shown in the tree (e.g. "Seq Scan", "Hash Join")
//   detail   — secondary text shown in muted color (e.g. table name, index name)
//   cost     — total cost or estimated cost. Used for hot-node ranking.
//   rows     — estimated or actual rows produced by this node
//   actualMs — present only when ANALYZE was used. Real execution time.
//   children — sub-plans. Empty array (not undefined) for leaves.
//   meta     — engine-specific extras (filters, sort keys, buffer reads, etc).
//              Rendered as a key-value table beneath the node.
interface PlanNode {
  label:    string;
  detail:   string;
  cost:     number;
  rows:     number;
  actualMs?: number;
  children: PlanNode[];
  meta:     Record<string, string>;
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

interface ProcedureInfo {
  name:           string;
  schema:         string;
  parameterCount: number;
  created?:       string;
}

interface FunctionInfo {
  name:           string;
  schema:         string;
  functionType:   string; // scalar | table | window
  parameterCount: number;
}

interface ViewInfo {
  name:   string;
  schema: string;
}

interface TriggerInfo {
  name:      string;
  tableName: string;
  event:     string;
  timing:    string;
}

interface IndexInfo {
  name:      string;
  tableName: string;
  columns:   string;
  isUnique:  boolean;
  isPrimary: boolean;
}

interface ForeignKey {
  constraintName: string;
  sourceSchema:   string;
  sourceTable:    string;
  sourceColumn:   string;
  targetSchema:   string;
  targetTable:    string;
  targetColumn:   string;
}

interface SchemaResult {
  tables:       TableInfo[];
  procedures:   ProcedureInfo[];
  functions:    FunctionInfo[];
  views:        ViewInfo[];
  triggers:     TriggerInfo[];
  indexes:      IndexInfo[];
  foreignKeys?: ForeignKey[];   // ← new, optional for backward compat
  error?:       string;
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

// ── Activity panel ─────────────────────────────────────────────────────────
// Matches ActivityRow from ActivityExecutor.cs (camelCase JSON).
// All string fields may be empty — engines populate optional columns
// inconsistently (CockroachDB notably leaves several blank).
interface ActivityRow {
  pid:        string;
  user:       string;
  database:   string;
  state:      string;
  durationMs: number;
  query:      string;
  host:       string;
}

// ── Command palette ────────────────────────────────────────────────────────
// Five categories, all rendered through one PaletteItem shape so fuse.js
// has a single haystack to fuzzy-search. The category property drives
// the icon + section header in the rendered list; the onSelect closure
// captures everything needed to invoke the item — no global lookups at
// click time, no stale-reference bugs.
type PaletteCategory = "command" | "connection" | "table" | "tab" | "saved";

interface PaletteItem {
  id:        string;
  category:  PaletteCategory;
  label:     string;          // primary text — what fuse searches first
  secondary: string;          // shown to the right, lower contrast (schema, db, tag)
  onSelect:  () => void;
}

interface Tab {
  id:          string;
  title:       string;
  sql:         string;
  connection:  ConnectionConfig | null;
  file:        FileSession | null;
  results:     QueryResult[];     
  activeResult: number;            
  error:       string | null;
  loading:     boolean;
  duration:    number | null;
  joinTables:  string[];
  pendingEdits: PendingEdit[];
  editingCell:  { rowIndex: number; colIndex: number } | null;
  // Per-tab toggle. When true, runQuery wraps the SQL with the engine's
  // EXPLAIN / SHOWPLAN_XML / EXPLAIN FORMAT JSON equivalent and marks the
  // resulting QueryResult as isPlan so the renderer shows the tree.
  // Per-tab (not global) so a user can keep "plan mode" on for one tab
  // while running normal queries in another.
  includePlan?: boolean;
  // Which database on the connection's server this tab is currently browsing /
  // querying. Defaults to the connection's saved `database`. Set when the user
  // picks a different database in the sidebar's database list. The query
  // connection string is built against this database, so switching it here also
  // switches what unqualified queries (SELECT * FROM t) run against.
  activeDatabase?: string;
}

function Spinner({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ display: "inline-block", verticalAlign: "middle" }}
      aria-hidden="true"
    >
      {/* faint full ring */}
      <circle
        cx="12" cy="12" r="9"
        fill="none" stroke="currentColor"
        strokeOpacity="0.25" strokeWidth="3"
      />
      {/* bright arc that rotates */}
      <path
        d="M12 3 a9 9 0 0 1 9 9"
        fill="none" stroke="currentColor"
        strokeWidth="3" strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 12 12" to="360 12 12"
          dur="0.7s" repeatCount="indefinite"
        />
      </path>
    </svg>
  );
}


function createTab(id?: string): Tab {
  return {
    id:           id ?? `tab-${Date.now()}`,
    title:        "New tab",
    sql:          "",
    connection:   null,
    file:         null,
    results:      [],        // ← was: result: null
    activeResult: 0,
    error:        null,
    loading:      false,
    duration:     null,
    joinTables:   [],
    pendingEdits: [],
    editingCell:  null,
    includePlan:  false,
    activeDatabase: undefined,
  };
}

// ── Execution plan: SQL wrapping ────────────────────────────────────────────
// When the "Include Execution Plan" toggle is on, runQuery routes the user's
// SQL through wrapPlanSql() first. Each engine has its own EXPLAIN dialect;
// the wrapper returns the prefix that produces a single result row containing
// the plan in its native serialised form (JSON for Postgres/MySQL, XML for
// SQL Server, tabular for SQLite).
//
// The wrapper is conservative: only wraps SELECT statements. Wrapping a DDL
// statement (CREATE TABLE, etc) or a non-data statement is either an error
// (SHOWPLAN_XML doesn't work on most DDL) or actively dangerous (EXPLAIN
// ANALYZE on an UPDATE actually mutates data). Easier and safer to require
// the user to write SELECTs when plan mode is on.

/** Returns true if the SQL looks like a SELECT-ish statement we can safely
 *  wrap with an EXPLAIN/SHOWPLAN. Conservative — anything that isn't
 *  obviously a read is rejected. */
function isPlanSafeSql(sql: string): boolean {
  // Strip leading comments and whitespace to find the first keyword
  const stripped = sql
    .replace(/^\s*--[^\n]*\n/g, "")  // line comments at start
    .replace(/^\s*\/\*[\s\S]*?\*\//g, "")  // block comments at start
    .trim();
  const first = stripped.split(/\s+/)[0]?.toUpperCase() ?? "";
  // CTEs (WITH ...) are SELECT-adjacent and safe to plan
  return first === "SELECT" || first === "WITH";
}

/** Wraps user SQL with the engine-appropriate plan-capture statement.
 *  Returns the wrapped SQL, or null if the statement isn't plan-safe. */
function wrapPlanSql(sql: string, engine: string): string | null {
  if (!isPlanSafeSql(sql)) return null;
  const clean = sql.trim().replace(/;\s*$/, "");
  switch (engine.toLowerCase()) {
    case "postgres":
      // ANALYZE actually executes the query. FORMAT JSON gives us a
      // parse-friendly tree. BUFFERS reports cache hits/reads.
      return `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${clean}`;
    case "cockroachdb":
      // CockroachDB doesn't accept Postgres's parenthesised option list
      // and has no JSON output mode. Plain EXPLAIN returns a tabular
      // plan — we render it like the SQLite EXPLAIN QUERY PLAN output.
      // EXPLAIN ANALYZE exists too but emits prose, not a parseable
      // structure, so we stick with the cheaper non-analyzing form.
      return `EXPLAIN ${clean}`;
    case "sqlserver":
      return `BEGIN\nSET STATISTICS XML ON;\n${clean};\nSET STATISTICS XML OFF;\nEND`;
    case "mysql":
    case "mariadb":
      return `EXPLAIN FORMAT=JSON ${clean}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${clean}`;
    default:
      return null;
  }
}

interface AppSettings {
  queryTimeoutSecs:      number;
  lockTimeoutMins:       number; // 0 = disabled
  resultRowLimit:        number;
  historyRetentionDays:  number; // 0 = forever
  resultClearMins:       number; // 0 = never
  auditLogEnabled:       boolean;
  clipboardClearEnabled: boolean;
  clipboardClearSecs:    number;
}

const DEFAULT_SETTINGS: AppSettings = {
  queryTimeoutSecs:      30,
  lockTimeoutMins:       15,
  resultRowLimit:        50_000,
  historyRetentionDays:  90,
  resultClearMins:       5,
  auditLogEnabled:       false,
  clipboardClearEnabled: true,
  clipboardClearSecs:    60,
};

interface PendingEdit {
  rowIndex:   number;
  colIndex:   number;
  colName:    string;
  oldValue:   string | null;
  newValue:   string;
}

// ---- Theme ------------------------------------------------
// Theme preference is stored separately from AppSettings because:
//   1. It's a per-device UI preference, not a project/connection setting
//   2. localStorage is the universal convention for theme persistence
//   3. Avoids a round-trip to Rust for a setting that only the WebView uses
// "system" follows prefers-color-scheme; "light"/"dark" force a value.
type ThemePreference = "system" | "light" | "dark";
type ResolvedTheme   = "light" | "dark";

const THEME_STORAGE_KEY = "dbark_theme";

function readStoredTheme(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch { /* localStorage unavailable — fall through to default */ }
  return "system";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined"
    && window.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
}

function resolveTheme(pref: ThemePreference): ResolvedTheme {
  if (pref === "system") return systemPrefersDark() ? "dark" : "light";
  return pref;
}

// ---- Engine badge -----------------------------------------
function EngineBadge({ engine }: { engine: string }) {
  const colors: Record<string, string> = {
    mysql:       "#f59e0b",
    mariadb:     "#c0392b",
    sqlserver:   "#3b82f6",
    postgres:    "#6c63ff",
    cockroachdb: "#6933ff",
    sqlite:      "#10b981",
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
function JoinTablesPanel({
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
        if (cancelled) return;
        const parsed = JSON.parse(result);
        if (parsed.error) { setError(parsed.error); return; }
        setTables(parsed.tables ?? []);
      })
      .catch((e) => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [activeConnection]);

  const selectedSet = new Set(selected);

  return (
    <div style={{ borderBottom: "1px solid var(--border)", background: "var(--surface)", padding: "10px 12px" }}>
      {/* Framing line — names the `data` alias the file is queryable as. */}
      <p style={{ fontSize: 12, color: "var(--text-secondary)", margin: 0, fontFamily: "monospace" }}>
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
  editingConnection: ConnectionConfig | null;
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
    sshEnabled:  editingConnection?.sshEnabled  ?? false,
    sshHost:     editingConnection?.sshHost     ?? "",
    sshPort:     editingConnection?.sshPort?.toString() ?? "22",
    sshUser:     editingConnection?.sshUser     ?? "",
    sshKeyPath:  editingConnection?.sshKeyPath  ?? "",
    sshPassword:  "", // never pre-fill SSH password
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<"success" | "error" | null>(null);
  const [testMessage, setTestMessage] = useState("");
  const [showPassword, setShowPassword] = useState(false);


  const defaultPort: Record<string, number> = {
    mysql: 3306, mariadb: 3306, sqlserver: 1433, postgres: 5432, cockroachdb: 26257, sqlite: 0,
  };

  const fieldStyle: React.CSSProperties = {
    width: "100%", padding: "6px 10px", background: "var(--bg)",
    border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)",
    fontSize: 12, fontFamily: "monospace", marginTop: 3,
    outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 11, color: "var(--text-tertiary)", display: "block", marginBottom: 8, width: "100%",
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
        sshEnabled:  form.sshEnabled,
        sshHost:     form.sshHost,
        sshPort:     parseInt(form.sshPort) || 22,
        sshUser:     form.sshUser,
        sshKeyPath:  form.sshKeyPath,
      };

      const result = await invoke<string>("save_connection", {
        requestJson: JSON.stringify(request),
      });
      if (result.startsWith("ERROR")) { setError(result); return; }

      const newRef = `dbark:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`;

      if (form.sshEnabled && form.sshPassword) {
        await invoke<boolean>("store_credential", {
          target:   `dbark-ssh:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.sshUser}`,
          username: form.sshUser,
          password: form.sshPassword,
        });
      }

      if (form.password) {
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
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "var(--text)" }}>
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
                color: "var(--text-tertiary)", cursor: "pointer",
                fontSize: 12, padding: "2px 4px",
              }}
            >
              {showPassword ? "🙈" : "👁"}
            </button>
          </div>
          {editingConnection && (
            <div style={{ fontSize: 10, color: "var(--text-disabled)", marginTop: 4, lineHeight: 1.5 }}>
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
          <option value="mariadb">MariaDB</option>
          <option value="sqlserver">SQL Server</option>
          <option value="postgres">PostgreSQL</option>
          <option value="cockroachdb">CockroachDB</option>
          <option value="sqlite">SQLite</option>
        </select>
      </label>

      {/*SQL Server Specific Settings*/}
      {form.engine === "sqlserver" && (
        <>
          <label style={labelStyle}>
            Instance Name <span style={{ color: "var(--text-disabled)" }}>(optional)</span>
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
              <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 2 }}>Windows Authentication</div>
              <div style={{ fontSize: 10, color: "var(--text-disabled)" }}>
                Use current Windows user — no password required
              </div>
            </div>
          </label>
        </>
      )}

      <label style={labelStyle}>
        SSL Mode
        {form.sshEnabled && (
          <span style={{
            marginLeft: 8, fontSize: 10, color: "var(--warning)",
            fontFamily: "monospace",
          }}>
            ⚠ Disabled — SSH tunnel provides encryption
          </span>
        )}
        <select
          style={{
            ...fieldStyle,
            opacity: form.sshEnabled ? 0.4 : 1,
            cursor: form.sshEnabled ? "not-allowed" : "auto",
          }}
          value={form.sshEnabled ? "none" : form.sslMode}
          onChange={e => {
            if (!form.sshEnabled) setForm(f => ({ ...f, sslMode: e.target.value }));
          }}
          disabled={form.sshEnabled}
          title={form.sshEnabled
            ? "SSL is automatically disabled when using an SSH tunnel — the tunnel provides its own encryption"
            : undefined}
        >
          <option value="prefer">Prefer (default)</option>
          <option value="none">None — no encryption</option>
          <option value="require">Require — encrypt, don't verify cert</option>
          <option value="verify-full">Verify Full — encrypt + verify cert</option>
        </select>
      </label>

      {/* SSH Tunnel */}
      <div style={{
        borderTop: "1px solid var(--border)",
        marginTop: 8, paddingTop: 8,
      }}>
        <label style={{ ...labelStyle, display: "flex", alignItems: "center",
          gap: 10, cursor: "pointer", marginBottom: 12 }}>
          <input
            type="checkbox"
            checked={form.sshEnabled}
            onChange={e => setForm(f => ({ ...f, sshEnabled: e.target.checked }))}
            style={{ width: 14, height: 14, cursor: "pointer" }}
          />
          <div>
            <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 2 }}>
              SSH Tunnel
            </div>
            <div style={{ fontSize: 10, color: "var(--text-disabled)" }}>
              Connect via SSH port forwarding
            </div>
          </div>
        </label>

        {form.sshEnabled && (
          <>
            <label style={labelStyle}>
              SSH Host
              <input style={fieldStyle} type="text"
                value={form.sshHost}
                onChange={e => setForm(f => ({ ...f, sshHost: e.target.value }))}
                placeholder="ec2-user@52.54.120.55"
                autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </label>
            <label style={labelStyle}>
              SSH Port
              <input style={fieldStyle} type="text"
                value={form.sshPort}
                onChange={e => setForm(f => ({ ...f, sshPort: e.target.value }))}
                placeholder="22"
              />
            </label>
            <label style={labelStyle}>
              SSH Username
              <input style={fieldStyle} type="text"
                value={form.sshUser}
                onChange={e => setForm(f => ({ ...f, sshUser: e.target.value }))}
                placeholder="ec2-user"
                autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </label>
            <label style={labelStyle}>
              Private Key File
              <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
                <input
                  style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
                  type="text"
                  value={form.sshKeyPath}
                  onChange={e => setForm(f => ({ ...f, sshKeyPath: e.target.value }))}
                  placeholder="C:\Users\keith\.ssh\key.pem"
                  autoCorrect="off" autoCapitalize="off" spellCheck={false}
                />
                <button
                  type="button"
                  onClick={async () => {
                    const { open } = await import("@tauri-apps/plugin-dialog");
                    const selected = await open({
                      multiple: false,
                      filters: [{ name: "PEM key", extensions: ["pem", "key", "ppk"] }],
                    });
                    if (selected && typeof selected === "string")
                      setForm(f => ({ ...f, sshKeyPath: selected }));
                  }}
                  style={{
                    padding: "6px 10px", background: "var(--surface-2)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    color: "var(--text-secondary)", cursor: "pointer", fontSize: 11,
                    fontFamily: "monospace", flexShrink: 0,
                  }}
                >
                  Browse
                </button>
              </div>
            </label>
            <label style={labelStyle}>
              SSH Password <span style={{ color: "var(--text-disabled)" }}>(if key requires passphrase)</span>
              <input
                style={fieldStyle} type="password"
                value={form.sshPassword ?? ""}
                onChange={e => setForm(f => ({ ...f, sshPassword: e.target.value }))}
                placeholder="leave blank if key has no passphrase"
                autoComplete="new-password"
                autoCorrect="off" autoCapitalize="off" spellCheck={false}
              />
            </label>
          </>
        )}
      </div>
      {/* END SSH Tunnel */}

      {/* Read-only connection */}
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={form.readOnly}
          onChange={e => setForm(f => ({ ...f, readOnly: e.target.checked }))}
          style={{ width: 14, height: 14, cursor: "pointer" }}
        />
        <div>
          <div style={{ fontSize: 12, color: "var(--text)", marginBottom: 2 }}>Read-only connection</div>
          <div style={{ fontSize: 10, color: "var(--text-disabled)" }}>
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
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>{form.color}</span>
        </div>
      </label>

      {error && <div style={{ fontSize: 11, color: "var(--error)", marginBottom: 8, wordBreak: "break-word" }}>{error}</div>}

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
                  `dbark:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`,
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
            color: testing ? "var(--text-disabled)" : "var(--text-secondary)",
            border: "1px solid var(--border)",
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
              ? "var(--success-bg)" : "var(--error-bg)",
            color: testResult === "success" ? "var(--success)" : "var(--error)",
            border: `1px solid ${testResult === "success"
              ? "var(--success)" : "var(--error)"}`,
          }}>
            {testResult === "success" ? "✓ " : "✗ "}{testMessage}
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <button onClick={handleSave} disabled={saving} style={{
          flex: 1, padding: "7px 0", background: "var(--accent)", color: "white",
          border: "none", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer",
          fontSize: 12, fontFamily: "monospace",
        }}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={onCancel} style={{
          flex: 1, padding: "7px 0", background: "transparent", color: "var(--text-tertiary)",
          border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
          fontSize: 12, fontFamily: "monospace",
        }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Stable identity so the header-only table doesn't rebuild each render.
const EMPTY_ROWS: (string | null)[][] = [];

// ---- Results grid -----------------------------------------
function ResultsGrid({
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

{/*Renders a section in the schema sidebar for tables, views, or routines*/}
// ── Activity panel body ─────────────────────────────────────────────────────
// Pure presentation: takes already-loaded rows and emits a row-per-query.
// Polling, loading-state management, and kill-execution all live in App();
// this component just renders what it's handed and emits user intent
// (refresh request, kill request) back up through callbacks.
// ── Execution plan parsers ──────────────────────────────────────────────────
// One parser per engine, all returning the normalised PlanNode shape so the
// renderer doesn't need engine-specific branches. Session 1 ships Postgres;
// session 2 adds SQL Server XML and MySQL JSON.

/** Postgres EXPLAIN (FORMAT JSON, ANALYZE) returns an array with one element
 *  per top-level statement. Each element has a "Plan" property which is the
 *  root of the tree. Sub-plans are in "Plans" arrays. Field names use
 *  Capital Case With Spaces (e.g. "Node Type", "Total Cost"). */
function parsePostgresPlan(json: string): PlanNode | null {
  try {
    const parsed = JSON.parse(json);
    // Postgres returns [{ Plan: {...}, ... }]. Take the first statement.
    const root = Array.isArray(parsed) ? parsed[0]?.Plan : parsed?.Plan;
    if (!root) return null;
    return convertPostgresNode(root);
  } catch (e) {
    console.error("parsePostgresPlan failed:", e);
    return null;
  }
}

function convertPostgresNode(n: any): PlanNode {
  // Build a "detail" line — for a Seq Scan that's the table name, for a
  // Hash Join it's the join condition, etc. Keeping it short and readable
  // is more useful than dumping every property.
  const label = n["Node Type"] ?? "Unknown";
  const detail = (() => {
    const parts: string[] = [];
    if (n["Relation Name"]) {
      parts.push(`on ${n["Schema"] ? `${n["Schema"]}.` : ""}${n["Relation Name"]}`);
      if (n["Alias"] && n["Alias"] !== n["Relation Name"]) parts.push(`as ${n["Alias"]}`);
    }
    if (n["Index Name"]) parts.push(`using ${n["Index Name"]}`);
    if (n["Join Type"]) parts.push(`(${n["Join Type"]})`);
    return parts.join(" ");
  })();

  // meta: secondary properties shown beneath the node in a small key-value list
  const meta: Record<string, string> = {};
  if (n["Index Cond"])    meta["Index Cond"]    = n["Index Cond"];
  if (n["Filter"])        meta["Filter"]        = n["Filter"];
  if (n["Hash Cond"])     meta["Hash Cond"]     = n["Hash Cond"];
  if (n["Join Filter"])   meta["Join Filter"]   = n["Join Filter"];
  if (n["Sort Key"])      meta["Sort Key"]      = Array.isArray(n["Sort Key"])
    ? n["Sort Key"].join(", ") : String(n["Sort Key"]);
  if (n["Rows Removed by Filter"] != null && n["Rows Removed by Filter"] > 0) {
    meta["Rows Removed"] = String(n["Rows Removed by Filter"]);
  }
  if (n["Shared Hit Blocks"] != null || n["Shared Read Blocks"] != null) {
    meta["Buffers"] = `${n["Shared Hit Blocks"] ?? 0} hit / ${n["Shared Read Blocks"] ?? 0} read`;
  }

  return {
    label,
    detail,
    cost:    n["Total Cost"] ?? 0,
    rows:    n["Actual Rows"] ?? n["Plan Rows"] ?? 0,
    actualMs: n["Actual Total Time"] != null
      ? Math.round(n["Actual Total Time"] * 100) / 100  // round to 0.01ms
      : undefined,
    children: Array.isArray(n["Plans"]) ? n["Plans"].map(convertPostgresNode) : [],
    meta,
  };
}

// ── SQL Server XML plan parser ──────────────────────────────────────────────
// SET STATISTICS XML ON returns a single column containing a ShowPlanXML
// document. The tree lives under <ShowPlanXML><BatchSequence><Batch>
// <Statements><StmtSimple><QueryPlan><RelOp>. Each <RelOp> has:
//   - LogicalOp attribute   ("Inner Join", "Index Seek", etc) — used as label
//   - PhysicalOp attribute  ("Hash Match", "Clustered Index Seek", etc)
//   - EstimateCPU, EstimateRows, EstimateIO attributes
//   - Optional <RunTimeInformation> with actual stats (present with
//     STATISTICS XML ON, absent with SHOWPLAN_XML ON)
//   - One or more nested <RelOp> as children, typically wrapped in
//     phase-specific elements like <Hash>, <NestedLoops>, <Compute Scalar>.
//
// We use the browser's DOMParser — available everywhere, no external dep.
// XML traversal uses getElementsByTagName which returns live HTMLCollection;
// we collect immediate <RelOp> descendants via a recursive scan that stops
// at the first nested RelOp level.

function parseSqlServerPlan(xml: string): PlanNode | null {
  try {
    // Quick sanity check: if the input doesn't start with `<` after
    // trimming, it can't possibly be XML. Skip DOMParser entirely and
    // log a clear diagnostic.
    const head = xml.trimStart().slice(0, 100);
    if (!head.startsWith("<")) {
      console.error(
        "parseSqlServerPlan: expected XML, got:",
        head.length === 0 ? "(empty string)" : head.slice(0, 50)
      );
      return null;
    }
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    // DOMParser returns a document with <parsererror> on failure rather
    // than throwing. Detect that explicitly.
    if (doc.querySelector("parsererror")) {
      console.error("parseSqlServerPlan: XML parse error", doc.querySelector("parsererror")?.textContent);
      return null;
    }
    // Find the first RelOp anywhere in the document — that's the root
    // operator. We don't care about the wrapping batch/statement layers
    // for tree rendering.
    const firstRelOp = doc.querySelector("RelOp");
    if (!firstRelOp) return null;
    return convertSqlServerNode(firstRelOp);
  } catch (e) {
    console.error("parseSqlServerPlan failed:", e);
    return null;
  }
}

// Find all <RelOp> child operators of `el` at one level deep. SQL Server
// nests RelOps inside operator-specific wrapper elements (<Hash>, <Sort>,
// <NestedLoops>, etc), so a direct .children scan doesn't work. We
// recursively walk children but stop descending whenever we hit a RelOp —
// that's a child operator in the tree, not a grandchild.
function findChildRelOps(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c.tagName === "RelOp") {
        out.push(c);
      } else {
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

function convertSqlServerNode(el: Element): PlanNode {
  // Prefer PhysicalOp for the label — it's what shows in SSMS's tree
  // (Index Seek, Clustered Index Scan, Hash Match, etc). Fall back to
  // LogicalOp if PhysicalOp is missing.
  const physical = el.getAttribute("PhysicalOp") ?? "";
  const logical  = el.getAttribute("LogicalOp") ?? "";
  const label = physical || logical || "Unknown";

  // Build detail line — most operator types nest the table/index reference
  // inside a phase wrapper. We look for the first <Object> element which
  // is where SQL Server records the target object.
  const objectEl = el.querySelector(":scope > * > Object")
                ?? el.querySelector(":scope > * > * > Object");
  const detail = (() => {
    if (!objectEl) {
      // Some operators (Compute Scalar, Filter) have no object — fall
      // back to the LogicalOp when label is the PhysicalOp.
      return physical && logical && physical !== logical ? `(${logical})` : "";
    }
    const schema = (objectEl.getAttribute("Schema") ?? "").replace(/[\[\]]/g, "");
    const table  = (objectEl.getAttribute("Table")  ?? "").replace(/[\[\]]/g, "");
    const index  = (objectEl.getAttribute("Index")  ?? "").replace(/[\[\]]/g, "");
    const parts: string[] = [];
    if (table) parts.push(`on ${schema && schema !== "dbo" ? schema + "." : ""}${table}`);
    if (index) parts.push(`using ${index}`);
    return parts.join(" ");
  })();

  // EstimateRows and EstimatedTotalSubtreeCost give us numeric ranking.
  // STATISTICS XML adds <RunTimeInformation> with actual stats — prefer
  // those when present.
  const estRows  = parseFloat(el.getAttribute("EstimateRows") ?? "0");
  const subtree  = parseFloat(el.getAttribute("EstimatedTotalSubtreeCost") ?? "0");
  const runtime  = el.querySelector(":scope > RunTimeInformation > RunTimeCountersPerThread");
  const actualRows = runtime
    ? parseFloat(runtime.getAttribute("ActualRows") ?? "0")
    : null;
  // SQL Server reports ActualCPUms and ActualElapsedms per thread; we sum
  // them by summing all <RunTimeCountersPerThread> elements.
  let actualMs: number | undefined;
  const allRuntime = el.querySelectorAll(":scope > RunTimeInformation > RunTimeCountersPerThread");
  if (allRuntime.length > 0) {
    let total = 0;
    allRuntime.forEach(rt => {
      total += parseFloat(rt.getAttribute("ActualElapsedms") ?? "0");
    });
    actualMs = Math.round(total * 100) / 100;
  }

  // meta: surface useful per-operator details. Each operator type stores
  // its specifics in a child element matching its name (<Hash>, <Sort>,
  // <NestedLoops>, etc). We pick out the ones users care about.
  const meta: Record<string, string> = {};
  const predicates = el.querySelectorAll(":scope > * > Predicate ScalarOperator");
  if (predicates.length > 0) {
    const text = Array.from(predicates).map(p => p.getAttribute("ScalarString") ?? "").filter(Boolean);
    if (text.length > 0) meta["Predicate"] = text.join(" AND ");
  }
  // Seek predicates — what an Index Seek is filtering on
  const seekPreds = el.querySelectorAll(":scope > IndexScan SeekPredicates SeekPredicate ScalarOperator");
  if (seekPreds.length > 0) {
    const text = Array.from(seekPreds).map(p => p.getAttribute("ScalarString") ?? "").filter(Boolean);
    if (text.length > 0) meta["Seek"] = text.join(", ");
  }
  if (actualRows != null && estRows > 0) {
    const ratio = actualRows / estRows;
    if (ratio > 10 || ratio < 0.1) {
      // Estimate badly off — useful to surface
      meta["Estimate"] = `${estRows.toFixed(0)} expected, ${actualRows.toFixed(0)} actual`;
    }
  }

  return {
    label,
    detail,
    cost: subtree,
    rows: actualRows ?? estRows,
    actualMs,
    children: findChildRelOps(el).map(convertSqlServerNode),
    meta,
  };
}

// ── MySQL JSON plan parser ──────────────────────────────────────────────────
// EXPLAIN FORMAT=JSON returns a single column "EXPLAIN" with a JSON document.
// The shape is:
//   { "query_block": { "select_id": 1, "cost_info": {...}, "table": {...},
//                      "nested_loop": [{"table": {...}}, ...], ... } }
//
// MySQL's tree is irregular compared to Postgres — instead of a uniform
// "Plans" children array, child operators appear under multiple possible
// keys: nested_loop, ordering_operation, grouping_operation, materialized_
// from_subquery, attached_subqueries, table. We probe for each shape.
//
// Where a node has "table", that's the table-access detail bundled into
// the same node as the operator above it. We treat that as a single
// PlanNode and record the table name as `detail`.

function parseMysqlPlan(json: string): PlanNode | null {
  try {
    const parsed = JSON.parse(json);

    // MySQL 8.4+ ships a new "v2.0" JSON plan schema with a fundamentally
    // different shape: a top-level `query_plan` object instead of
    // `query_block`, uniform `inputs[]` children instead of irregular
    // nested_loop / ordering_operation wrappers, and renamed cost/rows
    // fields. Detect by either the explicit version marker or the
    // presence of `query_plan`, and route to the v2 parser.
    if (parsed?.json_schema_version === "2.0" || parsed?.query_plan) {
      return parsed.query_plan ? convertMysqlV2Node(parsed.query_plan) : null;
    }

    // Legacy schema (MySQL 5.7 through 8.3, MariaDB)
    const block = parsed?.query_block;
    if (!block) return null;
    return convertMysqlBlock(block);
  } catch (e) {
    console.error("parseMysqlPlan failed:", e);
    return null;
  }
}

// MySQL 8.4+ "v2.0" plan schema. Every node has the same shape:
//   { operation, access_type, inputs?, table_name?, schema_name?,
//     used_columns?, estimated_rows?, estimated_total_cost?,
//     limit?, limit_offset?, index_name?, condition?, ... }
// `operation` is a human-readable label MySQL has already formatted
// (e.g. "Table scan on db", "Limit: 100 row(s)", "Nested loop inner join").
// Children are uniformly in `inputs[]` — no irregular wrappers to probe.
function convertMysqlV2Node(n: any): PlanNode {
  const op: string = n.operation ?? n.access_type ?? "Node";
  const label = shortenMysqlV2Label(op);

  const meta: Record<string, string> = {};
  if (n.schema_name && n.table_name) {
    meta["Table"] = `${n.schema_name}.${n.table_name}`;
  } else if (n.table_name) {
    meta["Table"] = n.table_name;
  }
  if (n.access_type)  meta["Access"]    = n.access_type;
  if (n.index_name)   meta["Index"]     = n.index_name;
  if (n.condition)    meta["Condition"] = n.condition;
  if (n.limit != null) meta["Limit"]   = String(n.limit);
  if (n.limit_offset)  meta["Offset"]  = String(n.limit_offset);
  if (Array.isArray(n.used_columns) && n.used_columns.length > 0) {
    // Truncate long column lists — a SELECT * on a wide table dumps
    // dozens of names and crushes the meta panel.
    const cols = n.used_columns as string[];
    meta["Columns"] = cols.length > 8
      ? `${cols.slice(0, 8).join(", ")}, … (+${cols.length - 8} more)`
      : cols.join(", ");
  }

  return {
    label,
    // Only set detail when the shortened label dropped useful info.
    detail: op === label ? "" : op,
    cost: parseFloat(n.estimated_total_cost ?? "0"),
    rows: parseFloat(n.estimated_rows ?? "0"),
    children: Array.isArray(n.inputs) ? n.inputs.map(convertMysqlV2Node) : [],
    meta,
  };
}

// Pulls a compact tree-node label out of MySQL's verbose `operation` string.
//   "Table scan on db"               → "Table Scan"
//   "Limit: 100 row(s)"              → "Limit"
//   "Nested loop inner join"         → "Nested Loop Inner Join"
//   "Index lookup on t using PRIMARY" → "Index Lookup"
// The full operation string is preserved in PlanNode.detail so nothing
// is lost — just rearranged for the tree visualisation.
function shortenMysqlV2Label(op: string): string {
  let s = op;
  const onIdx = s.search(/\s+on\s+/i);
  if (onIdx > 0) s = s.slice(0, onIdx);
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) s = s.slice(0, colonIdx);
  s = s.trim();
  return s.split(/\s+/)
    .map(w => w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w)
    .join(" ");
}

function convertMysqlBlock(block: any): PlanNode {
  // Try each wrapper key in priority order — these mirror MySQL's
  // documented EXPLAIN JSON structure. The outermost wrapper becomes the
  // operator label.
  if (block.union_result) {
    return {
      label: "Union",
      detail: block.union_result.using_temporary_table ? "(temp table)" : "",
      cost: 0,
      rows: 0,
      children: (block.union_result.query_specifications ?? [])
        .map((s: any) => convertMysqlBlock(s.query_block ?? s)),
      meta: {},
    };
  }
  if (block.ordering_operation) {
    return {
      label: "Sort",
      detail: block.ordering_operation.using_filesort ? "(filesort)" : "",
      cost: 0,
      rows: 0,
      children: [convertMysqlBlock(block.ordering_operation)],
      meta: {},
    };
  }
  if (block.grouping_operation) {
    return {
      label: "Group",
      detail: block.grouping_operation.using_filesort ? "(filesort)" : "",
      cost: 0,
      rows: 0,
      children: [convertMysqlBlock(block.grouping_operation)],
      meta: {},
    };
  }
  if (Array.isArray(block.nested_loop)) {
    // Nested loop is the join structure. Each entry is { table: {...} }.
    // We render as a Join node with each table as a child.
    return {
      label: "Nested Loop Join",
      detail: `${block.nested_loop.length} tables`,
      cost: parseFloat(block.cost_info?.query_cost ?? "0"),
      rows: 0,
      children: block.nested_loop.map((nl: any) => convertMysqlTable(nl.table ?? nl)),
      meta: {},
    };
  }
  if (block.table) {
    return convertMysqlTable(block.table);
  }
  // Unknown shape — render as a placeholder with the raw block name
  return {
    label: "Query Block",
    detail: "",
    cost: parseFloat(block.cost_info?.query_cost ?? "0"),
    rows: 0,
    children: [],
    meta: {},
  };
}

function convertMysqlTable(t: any): PlanNode {
  // Each table node has:
  //   access_type: "ALL" | "index" | "ref" | "range" | "const" | "eq_ref" | ...
  //   table_name, key (index name), rows_examined_per_scan, filtered (%)
  //   cost_info: { read_cost, eval_cost, prefix_cost, data_read_per_join }
  //   used_columns, attached_condition
  //   materialized_from_subquery, attached_subqueries (for nested cases)
  const accessType = t.access_type ?? "?";
  // Map MySQL's access_type to a readable label
  const label = ({
    ALL:      "Full Table Scan",
    index:    "Index Scan",
    range:    "Index Range Scan",
    ref:      "Ref Lookup",
    eq_ref:   "Eq Ref Lookup",
    const:    "Constant Lookup",
    system:   "System Lookup",
    fulltext: "Fulltext Search",
  } as Record<string, string>)[accessType] ?? `Access (${accessType})`;

  const parts: string[] = [];
  if (t.table_name) parts.push(`on ${t.table_name}`);
  if (t.key)        parts.push(`using ${t.key}`);
  if (t.using_index === true) parts.push("(index only)");
  const detail = parts.join(" ");

  const meta: Record<string, string> = {};
  if (t.possible_keys) meta["Possible Keys"] = (t.possible_keys as string[]).join(", ");
  if (t.attached_condition) meta["Condition"] = t.attached_condition;
  if (t.filtered != null && t.filtered < 100) meta["Filtered"] = `${t.filtered}%`;
  if (t.cost_info?.read_cost != null) meta["Read Cost"] = String(t.cost_info.read_cost);
  if (t.cost_info?.eval_cost != null) meta["Eval Cost"] = String(t.cost_info.eval_cost);

  const children: PlanNode[] = [];
  // Subqueries materialized in the FROM clause — render as a child node
  if (t.materialized_from_subquery?.query_block) {
    children.push(convertMysqlBlock(t.materialized_from_subquery.query_block));
  }
  // Attached subqueries — present in WHERE clauses
  if (Array.isArray(t.attached_subqueries)) {
    for (const sub of t.attached_subqueries) {
      if (sub.query_block) children.push(convertMysqlBlock(sub.query_block));
    }
  }

  return {
    label,
    detail,
    cost: parseFloat(t.cost_info?.prefix_cost ?? t.cost_info?.read_cost ?? "0"),
    rows: parseFloat(t.rows_examined_per_scan ?? t.rows ?? "0"),
    children,
    meta,
  };
}

// ── SQLite EXPLAIN QUERY PLAN parser ────────────────────────────────────────
// SQLite returns a *tabular* result rather than a JSON or XML tree:
//   id | parent | notused | detail
//   3  | 0      | 0       | SCAN TABLE foo
//   5  | 0      | 0       | SEARCH TABLE bar USING INDEX bar_x_idx (x=?)
//   8  | 5      | 0       | USE TEMP B-TREE FOR ORDER BY
//
// Each row is one access plan; parent is the id of the row's parent node
// (0 = root). We reconstruct the tree by walking parent references.
//
// `detail` is free-form text like "SCAN TABLE foo" — we keep it as-is for
// label since SQLite doesn't separate operator name from target.

function parseSqlitePlan(result: QueryResult): PlanNode | null {
  if (!result.rows || result.rows.length === 0) return null;
  // SQLite EXPLAIN QUERY PLAN columns are: id, parent, notused, detail.
  // Column index varies — find them by name first, fall back to position.
  const cols = result.columns ?? [];
  const idxId     = cols.findIndex(c => c.toLowerCase() === "id");
  const idxParent = cols.findIndex(c => c.toLowerCase() === "parent");
  const idxDetail = cols.findIndex(c => c.toLowerCase() === "detail");
  const ID     = idxId     >= 0 ? idxId     : 0;
  const PARENT = idxParent >= 0 ? idxParent : 1;
  const DETAIL = idxDetail >= 0 ? idxDetail : 3;

  // Build a map of id → PlanNode plus a parent-reference list
  const nodes = new Map<string, PlanNode & { _parent: string }>();
  for (const row of result.rows) {
    const id     = row[ID]     ?? "";
    const parent = row[PARENT] ?? "0";
    const detail = row[DETAIL] ?? "";
    if (!id) continue;
    nodes.set(id, {
      label: detail,
      detail: "",
      cost: 0,
      rows: 0,
      children: [],
      meta: {},
      _parent: parent,
    });
  }
  if (nodes.size === 0) return null;

  // Wire children to parents. parent="0" means top-level — those go under
  // a synthetic root so the user sees a single tree even when there are
  // multiple top-level access paths.
  const rootChildren: PlanNode[] = [];
  for (const node of nodes.values()) {
    if (node._parent === "0" || !nodes.has(node._parent)) {
      rootChildren.push(node);
    } else {
      nodes.get(node._parent)!.children.push(node);
    }
  }
  if (rootChildren.length === 1) return rootChildren[0];
  return {
    label: "Query Plan",
    detail: `${rootChildren.length} top-level paths`,
    cost: 0,
    rows: 0,
    children: rootChildren,
    meta: {},
  };
}

// ── Hot node detection ──────────────────────────────────────────────────────
// "Most expensive" is defined as: nodes whose cost (or actualMs if present)
// is in the top 20% of all nodes in the tree. Minimum threshold of 1.0 so
// trivial queries don't get spurious highlights on every node.

function collectAllNodes(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode) => { out.push(n); n.children.forEach(walk); };
  walk(root);
  return out;
}

function hotNodeThreshold(root: PlanNode): number {
  const all = collectAllNodes(root);
  // Prefer actualMs when present (more meaningful than cost estimate)
  const useActual = all.some(n => n.actualMs != null);
  const values = all
    .map(n => useActual ? (n.actualMs ?? 0) : n.cost)
    .filter(v => v > 0)
    .sort((a, b) => b - a);   // descending
  if (values.length === 0) return Infinity;
  // 80th percentile — top 20% are hot
  const idx = Math.floor(values.length * 0.2);
  return Math.max(values[idx] ?? Infinity, 1.0);
}

function isHotNode(node: PlanNode, threshold: number, useActual: boolean): boolean {
  const v = useActual ? (node.actualMs ?? 0) : node.cost;
  return v >= threshold;
}

// ── Tree renderer ───────────────────────────────────────────────────────────
// Vertical indented tree. Each node renders as:
//   • Operator name (bold) + brief detail (muted)
//   • Cost / rows / actualMs row (small, monospace)
//   • Optional meta key-value table (filters, sort keys, etc)
//   • Children indented and rendered recursively
// Hot nodes get an amber left-border + amber operator name.

function PlanTreeRenderer({
  root, engine,
}: { root: PlanNode; engine: string }) {
  const allNodes = collectAllNodes(root);
  const useActual = allNodes.some(n => n.actualMs != null);
  const threshold = hotNodeThreshold(root);

  return (
    <div style={{
      flex: 1,
      overflow: "auto",
      padding: "12px 16px",
      fontFamily: "monospace",
      fontSize: 12,
    }}>
      <div style={{
        color: "var(--text-tertiary)",
        fontSize: 11,
        marginBottom: 12,
      }}>
        Execution plan ({engine}) — {allNodes.length} nodes
        {useActual && " · actual times shown"}
      </div>
      <PlanNodeView
        node={root}
        depth={0}
        threshold={threshold}
        useActual={useActual}
      />
    </div>
  );
}

function PlanNodeView({
  node, depth, threshold, useActual,
}: {
  node: PlanNode;
  depth: number;
  threshold: number;
  useActual: boolean;
}) {
  const hot = isHotNode(node, threshold, useActual);
  return (
    <div style={{
      // Tree indentation via left margin grows with depth, but we cap at
      // 8 levels so deeply-nested plans don't push content off-screen.
      marginLeft: Math.min(depth, 8) * 18,
      marginBottom: 8,
    }}>
      <div style={{
        borderLeft: `3px solid ${hot ? "var(--warning)" : "var(--border)"}`,
        background: hot ? "var(--warning-bg)" : "var(--surface)",
        padding: "6px 10px",
        borderRadius: 4,
      }}>
        {/* Header — operator + detail */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{
            fontWeight: 600,
            color: hot ? "var(--warning)" : "var(--text)",
            fontSize: 13,
          }}>
            {node.label}
          </span>
          {node.detail && (
            <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
              {node.detail}
            </span>
          )}
        </div>

        {/* Stats row — cost, rows, ms */}
        <div style={{
          display: "flex",
          gap: 14,
          marginTop: 3,
          fontSize: 11,
          color: "var(--text-tertiary)",
        }}>
          {node.cost > 0 && (
            <span>
              <span style={{ color: "var(--text-disabled)" }}>cost </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {node.cost.toFixed(2)}
              </span>
            </span>
          )}
          {node.rows > 0 && (
            <span>
              <span style={{ color: "var(--text-disabled)" }}>rows </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {node.rows.toLocaleString()}
              </span>
            </span>
          )}
          {node.actualMs != null && (
            <span>
              <span style={{ color: "var(--text-disabled)" }}>actual </span>
              <span style={{ color: hot ? "var(--warning)" : "var(--text-secondary)" }}>
                {node.actualMs}ms
              </span>
            </span>
          )}
        </div>

        {/* Meta — key/value table when there are extras */}
        {Object.keys(node.meta).length > 0 && (
          <div style={{
            marginTop: 6,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "2px 10px",
            fontSize: 11,
          }}>
            {Object.entries(node.meta).map(([k, v]) => (
              <Fragment key={k}>
                <span style={{ color: "var(--text-disabled)" }}>{k}</span>
                <span style={{
                  color: "var(--text-secondary)",
                  wordBreak: "break-all",
                  fontFamily: "monospace",
                }}>
                  {v}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Children — recurse */}
      {node.children.map((child, i) => (
        <PlanNodeView
          key={i}
          node={child}
          depth={depth + 1}
          threshold={threshold}
          useActual={useActual}
        />
      ))}
    </div>
  );
}

// ── Top-level plan result renderer ──────────────────────────────────────────
// Routed to from the results-tab branch when result.isPlan is true. Picks
// the right parser by engine, falls back to raw text if parsing fails so
// the user still has something to look at.

function PlanResultRenderer({ result }: { result: QueryResult }) {
  const engine = (result.planEngine ?? "").toLowerCase();
  // Most engines return the plan as a single-cell document. SQLite is the
  // exception — it returns a multi-row tabular result that the SQLite
  // parser reconstructs into a tree.
  const rawText = result.rows[0]?.[0] ?? "";

  // Diagnostic: SQL Server plan should arrive as a single-column rowset
  // whose first cell is XML. If it's empty, dump the full result so we
  // can see what shape arrived — most often it's the data rowset instead
  // of the plan rowset, meaning the C# multi-result walk didn't pick the
  // right one.
  if (engine === "sqlserver" && !rawText) {
    console.warn(
      "SQL Server plan: first cell empty. Result shape:",
      {
        columns: result.columns,
        rowCount: result.rows.length,
        firstRowFirstCells: result.rows[0]?.slice(0, 3),
        allFirstCells: result.rows.slice(0, 5).map(r => r[0]),
      }
    );
  }

  let root: PlanNode | null = null;
  if (engine === "postgres") {
    root = parsePostgresPlan(rawText);
  } else if (engine === "sqlserver") {
    root = parseSqlServerPlan(rawText);
  } else if (engine === "mysql" || engine === "mariadb") {
    root = parseMysqlPlan(rawText);
  } else if (engine === "sqlite") {
    root = parseSqlitePlan(result);
  } 
  // CockroachDB returns plain EXPLAIN as a multi-row tabular result.
  // The server has already formatted it as a readable indented tree with
  // • markers — building a parser on top of that text format doesn't
  // add value, just fragility across versions. Render directly with a
  // clear header so it reads as the intended output, not a failure path.
  else if (engine === "cockroachdb") {
    const text = result.rows.map(r => r[0] ?? "").join("\n");
    return (
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
        <div style={{
          color: "var(--text-tertiary)",
          fontSize: 11,
          marginBottom: 8,
          fontFamily: "monospace",
        }}>
          Execution plan (cockroachdb) — server-formatted text output.
        </div>
        <pre style={{
          fontSize: 12,
          fontFamily: "monospace",
          color: "var(--text-secondary)",
          whiteSpace: "pre",
          margin: 0,
        }}>
          {text}
        </pre>
      </div>
    );
  }

  if (root) {
    return <PlanTreeRenderer root={root} engine={engine} />;
  }

  // Fallback: parser didn't return a tree (malformed plan, unexpected
  // engine, etc). Show the raw text so the user isn't stuck.
  // For SQLite the rawText is just the first cell — display the full
  // tabular output instead.
  const fallbackText = engine === "sqlite"
    ? result.rows.map(r => r.join("\t")).join("\n")
    : rawText;

  return (
    <div style={{
      flex: 1,
      overflow: "auto",
      padding: "12px 16px",
    }}>
      <div style={{
        color: "var(--text-tertiary)",
        fontSize: 11,
        marginBottom: 8,
        fontFamily: "monospace",
      }}>
        Execution plan ({engine}) — tree rendering failed, raw output below.
      </div>
      <pre style={{
        fontSize: 11,
        fontFamily: "monospace",
        color: "var(--text-secondary)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: 0,
      }}>
        {fallbackText}
      </pre>
    </div>
  );
}

function ActivityPanelBody({
  rows, loading, error, engine, onRefresh, onKillRequest,
}: {
  rows:          ActivityRow[];
  loading:       boolean;
  error:         string | null;
  engine:        string;
  onRefresh:     () => void;
  onKillRequest: (row: ActivityRow) => void;
}) {
  // Format milliseconds → human-readable duration.
  // <1s shows ms; <60s shows seconds; otherwise mm:ss.
  function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      overflow: "hidden", minHeight: 0,
    }}>
      {/* Header strip — refresh button + status */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 14px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        fontFamily: "monospace", fontSize: 11, flexShrink: 0,
      }}>
        <span style={{ color: "var(--text-secondary)" }}>
          ⚡ Active queries on this connection — auto-refresh every 5s
        </span>
        <span style={{ flex: 1 }} />
        {loading && (
          <span style={{ color: "var(--text-tertiary)" }}>Loading…</span>
        )}
        <button
          onClick={onRefresh}
          style={{
            padding: "3px 10px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-secondary)",
            fontFamily: "monospace",
            fontSize: 10,
            cursor: "pointer",
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Error banner if last fetch failed.
          Doesn't replace the rows — failed refresh keeps stale data visible,
          which is preferable to blanking the panel on a transient blip. */}
      {error && (
        <div style={{
          padding: "8px 14px",
          background: "var(--error-bg)",
          color: "var(--error)",
          fontSize: 11, fontFamily: "monospace",
          borderBottom: "1px solid var(--error)",
          flexShrink: 0,
        }}>
          ❌ {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && rows.length === 0 && !error && (
        <div style={{
          padding: "40px 16px",
          color: "var(--text-disabled)",
          fontSize: 13, textAlign: "center",
        }}>
          No active queries — server is idle (or all activity is from this connection).
        </div>
      )}

      {/* Row list — scrollable. Each row is a card so query text can wrap
          without breaking the table grid. A real table would force
          horizontal scrolling for long queries which is worse UX. */}
      {rows.length > 0 && (
        <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
          {rows.map((row) => (
            <div
              key={row.pid}
              style={{
                padding: "8px 14px",
                borderBottom: "1px solid var(--surface-3)",
                fontFamily: "monospace", fontSize: 11,
                display: "flex", flexDirection: "column", gap: 4,
              }}
            >
              {/* Top meta row — pid, user, db, state, duration, kill */}
              <div style={{
                display: "flex", alignItems: "center", gap: 12,
                color: "var(--text-tertiary)",
              }}>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                  #{row.pid}
                </span>
                {row.user && <span>👤 {row.user}</span>}
                {row.database && <span>🗄 {row.database}</span>}
                {row.state && (
                  <span style={{
                    padding: "1px 6px",
                    background: row.state.toLowerCase() === "active"
                      ? "var(--success-bg)" : "var(--surface-3)",
                    color: row.state.toLowerCase() === "active"
                      ? "var(--success)" : "var(--text-secondary)",
                    borderRadius: 3,
                    fontSize: 10,
                  }}>
                    {row.state}
                  </span>
                )}
                <span style={{ color: "var(--warning)" }}>
                  ⏱ {fmtDuration(row.durationMs)}
                </span>
                {row.host && (
                  <span style={{ color: "var(--text-disabled)" }}>
                    {row.host}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  onClick={() => onKillRequest(row)}
                  title={`Kill session ${row.pid}`}
                  style={{
                    padding: "2px 8px",
                    background: "var(--error-bg)",
                    border: "1px solid var(--error)",
                    borderRadius: 3,
                    color: "var(--error)",
                    fontFamily: "monospace",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  Kill
                </button>
              </div>
              {/* Query text — wraps; we use the raw query as-is and let CSS
                  break long lines. Truncating in TS would hide useful detail. */}
              {row.query && (
                <div style={{
                  color: "var(--text)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 11,
                  paddingLeft: 4,
                  paddingRight: 4,
                  maxHeight: 120,
                  overflow: "auto",
                }}>
                  {row.query}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer note for CockroachDB — its pg_stat_activity columns
          are sparse, so we tell the user not to expect everything. */}
      {engine === "cockroachdb" && (
        <div style={{
          padding: "6px 14px",
          fontSize: 10, fontFamily: "monospace",
          color: "var(--text-tertiary)",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          ℹ CockroachDB exposes a subset of Postgres activity columns — some fields may be blank.
        </div>
      )}
    </div>
  );
}


function SchemaSection({
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

function SettingsSection({
  label, children
}: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: "var(--text-disabled)",
        fontFamily: "monospace", textTransform: "uppercase",
        letterSpacing: ".08em", marginBottom: 12,
        paddingBottom: 6, borderBottom: "1px solid var(--border)",
      }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {children}
      </div>
    </div>
  );
}

function SettingsRow({
  label, description, children
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      justifyContent: "space-between", gap: 16,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: "var(--text)",
          marginBottom: 2, fontFamily: "monospace",
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 10, color: "var(--text-tertiary)",
          fontFamily: "monospace", lineHeight: 1.5,
        }}>
          {description}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {children}
      </div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "monospace",
  padding: "5px 10px",
  cursor: "pointer",
  outline: "none",
};

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
  const [settings, setSettings]           = useState<AppSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings]   = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);

  // Theme — preference is what the user chose (system/light/dark);
  // resolved is the actual rendered theme (light/dark) after resolving "system".
  const [themePreference, setThemePreference] = useState<ThemePreference>(readStoredTheme);
  const [resolvedTheme, setResolvedTheme]     = useState<ResolvedTheme>(
    () => resolveTheme(readStoredTheme())
  );
  const [connectionsFolder, setConnectionsFolder] = useState("");
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  // Database list for the currently-active connection. Only the active
  // connection renders its tree (see the sidebar), so a single list here is
  // enough — switching connections refetches. dbListCache memoises per
  // connection id so re-selecting a connection is instant.
  const [databases, setDatabases] = useState<string[]>([]);
  const [databasesLoading, setDatabasesLoading] = useState(false);
  const dbListCache = useRef<Map<string, string[]>>(new Map());
  // Free-text filter over the database list — the scalability unlock for
  // servers with many databases. Reset whenever the active connection changes.
  const [dbFilter, setDbFilter] = useState("");
  // Whether the active database's tree is collapsed. The active database is
  // always the one whose schema is loaded; collapsing hides its tree inline
  // (chevron ▸) without changing which database queries run against.
  const [dbTreeCollapsed, setDbTreeCollapsed] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set(["public"]));
  const schemaRef = useRef<SchemaResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Activity panel — bottom panel peer to results tabs.
  // Hidden for SQLite (no concept of server-side activity).
  // Polled every 5s only when open AND app focused.
  const [showActivity, setShowActivity]     = useState(false);
  const [activityRows, setActivityRows]     = useState<ActivityRow[]>([]);
  const [activityError, setActivityError]   = useState<string | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [killPending, setKillPending]       = useState<ActivityRow | null>(null);

  // Diagram panel — virtual result tab at activeResult = -2.
  // Toggle from the schema sidebar header. Hidden when no connection
  // has been loaded (the diagram has nothing to render without schema).
  const [showDiagram, setShowDiagram] = useState(false);

  // ── Command palette state ───────────────────────────────────────────────
  // showPalette gates the modal; paletteQuery is the search input;
  // paletteIndex is the keyboard-cursor position into the filtered results.
  // We deliberately do NOT memoize the assembled items list — assembly
  // is O(connections + tables + tabs + saved + commands), tiny relative
  // to the cost of fuse.js running over it. Recompute fresh on every
  // render while the palette is open; closed → no work happens.
  const [showPalette, setShowPalette]   = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [locked, setLocked] = useState(false);
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState("");
  const [saveQueryTags, setSaveQueryTags] = useState("");
  const [saveQueryDesc, setSaveQueryDesc] = useState("");
  // Saved-query library state — kept here with other saveQuery state so it's
  // declared before any consumer (the command palette references savedQueries
  // during its render-time item assembly).
  const [savedQueries, setSavedQueries]         = useState<any[]>([]);
  const [querySearch, setQuerySearch]           = useState("");
  const [showQueryLibrary, setShowQueryLibrary] = useState(false);
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTabRef = useRef<Tab>(activeTab);
  const settingsRef  = useRef<AppSettings>(settings); 
  const runQueryRef = useRef<() => Promise<void>>(async () => {});
  const formatSqlRef = useRef<() => void>(() => {});
  const sqlSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schemaCache = useRef<Map<string, SchemaResult>>(new Map());
  
  // Toggle one live table in/out of the join set (checkbox path: attach or
  // detach without touching the editor text).
  const handleToggleJoinTable = useCallback((table: string, next: boolean) => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const has = t.joinTables.includes(table);
      if (next === has) return t;
      return {
        ...t,
        joinTables: next
          ? [...t.joinTables, table]
          : t.joinTables.filter(x => x !== table),
      };
    }));
  }, [activeTabId]);

  // Click-to-insert: drop db_<table> at the cursor AND ensure the table is
  // attached, so the identifier you just inserted is always one the query
  // engine actually exposes (no "db_x does not exist" surprise).
  const handleInsertJoinTable = useCallback((table: string) => {
    setTabs(prev => prev.map(t =>
      t.id === activeTabId && !t.joinTables.includes(table)
        ? { ...t, joinTables: [...t.joinTables, table] }
        : t
    ));
    const editor = editorRef.current;
    if (editor) {
      const sel = editor.getSelection();
      editor.executeEdits("join-insert-table", [{
        range: sel ?? editor.getModel()!.getFullModelRange(),
        text: `db_${table}`,
        forceMoveMarkers: true,
      }]);
      editor.focus();
    }
  }, [activeTabId]);
  
  const autocompleteRegistered = useRef(false);
  const tokensProviderRegistered = useRef(false);

  const groupedConnections = useMemo(() => {
    const groups = new Map<string, ConnectionConfig[]>();

    for (const conn of connections) {
      const group = conn.group?.trim() || ""; 
      const key   = group || "__ungrouped__";
      const list  = groups.get(key) ?? [];
      list.push(conn);
      groups.set(key, list);
    }

    // Sort: named groups alphabetically, ungrouped last
    const sorted = [...groups.entries()].sort(([a], [b]) => {
      if (a === "__ungrouped__") return 1;
      if (b === "__ungrouped__") return -1;
      return a.localeCompare(b);
    });

    return sorted;
  }, [connections]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    connection: ConnectionConfig;
  } | null>(null);

  const [schemaContextMenu, setSchemaContextMenu] = useState<{
    x: number;
    y: number;
    name: string;
    type: string; // table | procedure | function | view | trigger | index
    schema: string;
    connection: ConnectionConfig;
    extra?: any;
  } | null>(null);

  const tablesBySchema = useMemo(() => {
  if (!schema?.tables) return new Map<string, TableInfo[]>();
  const map = new Map<string, TableInfo[]>();
  for (const table of schema.tables) {
    const s    = table.schema || "public";
    const list = map.get(s) ?? [];
    list.push(table);
    map.set(s, list);
  }
  // Sort schemas — public first, rest alphabetically
  return new Map([...map.entries()].sort(([a], [b]) => {
    if (a === "public") return -1;
    if (b === "public") return 1;
    return a.localeCompare(b);
  }));
}, [schema?.tables]);

  const [editingConnection, setEditingConnection] = useState<ConnectionConfig | null>(null);
  const [deletingConnection, setDeletingConnection] = useState<ConnectionConfig | null>(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [tunnelPorts, setTunnelPorts] = useState<Record<string, number>>({});
  const tunnelPortsRef = useRef<Record<string, number>>({});
  const [tunnelLoading, setTunnelLoading] = useState<Record<string, boolean>>({});
  const [auditLogEnabled, setAuditLogEnabled] = useState(false);
  const wasRewritten = activeTab.results.some(r => r.wasRewritten);

  // Apply theme to <html data-theme>, persist to localStorage, and
  // listen for system theme changes when the user has chosen "system".
  // The CSS in theme.css keys off the data-theme attribute.
  useEffect(() => {
    const apply = (pref: ThemePreference) => {
      const resolved = resolveTheme(pref);
      document.documentElement.setAttribute("data-theme", resolved);
      setResolvedTheme(resolved);
    };
    apply(themePreference);

    try {
      localStorage.setItem(THEME_STORAGE_KEY, themePreference);
    } catch { /* quota / private mode — non-fatal */ }

    // Only listen to OS changes when preference is "system".
    // If the user has forced light or dark, system changes are ignored.
    if (themePreference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => apply("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [themePreference]);

  // Enable CSS transitions only after first paint.
  // Without this, the initial render's data-theme application would
  // animate from default-to-correct, producing a one-time color flash.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      document.documentElement.classList.add("theme-transitions-enabled");
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    invoke<string>("load_settings")
      .then(raw => {
        try {
          const loaded = JSON.parse(raw);
          // Map snake_case from Rust to camelCase
          const mapped: AppSettings = {
            queryTimeoutSecs:      loaded.query_timeout_secs      ?? 30,
            lockTimeoutMins:       loaded.lock_timeout_mins       ?? 15,
            resultRowLimit:        loaded.result_row_limit        ?? 50_000,
            historyRetentionDays:  loaded.history_retention_days  ?? 90,
            resultClearMins:       loaded.result_clear_mins       ?? 5,
            auditLogEnabled:       loaded.audit_log_enabled       ?? false,
            clipboardClearEnabled: loaded.clipboard_clear_enabled ?? true,
            clipboardClearSecs:    loaded.clipboard_clear_secs    ?? 60,
          };
          const stored = localStorage.getItem("dbark_collapsed_groups");

          if (stored) {
            try {
              setCollapsedGroups(new Set(JSON.parse(stored)));
            } catch { /* ignore */ }
          }
          
          setSettings(mapped);
          setAuditLogEnabled(mapped.auditLogEnabled);
        } catch { /* use defaults */ }
      })
      .catch(() => { /* use defaults */ });
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem("dbark_audit_log");
    if (stored === "true") setAuditLogEnabled(true);
  }, []);

  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

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

  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  function toggleSection(key: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function onSidebarDragStart(e: React.MouseEvent) {
    sidebarDragging.current = true;
    sidebarStartX.current = e.clientX;
    sidebarStartW.current = sidebarWidth;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  function toggleGroup(group: string) {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(group) ? next.delete(group) : next.add(group);
      // Persist to localStorage
      localStorage.setItem(
        "dbark_collapsed_groups",
        JSON.stringify([...next])
      );
      return next;
    });
  }

  //DBeaver import state
  const [showDbeaverImport, setShowDbeaverImport] = useState(false);
  const [dbeaverImporting, setDbeaverImporting]   = useState(false);
  const [dbeaverResult, setDbeaverResult]         = useState<{
    imported: { name: string; engine: string; host: string; port: number;
                database: string; username: string; password: string; }[];
    skipped:  string[];
    error?:   string;
  } | null>(null);

  async function handleDbeaverImport() {
    setDbeaverImporting(true);
    try {
      const raw = await invoke<string>("import_dbeaver_connections");
      const result = JSON.parse(raw);
      setDbeaverResult(result);

      if (!result.error && result.imported.length > 0) {
        // Save each connection and store its password in the keychain
        for (const conn of result.imported) {
          const request = {
            name:        conn.name,
            engine:      conn.engine,
            host:        conn.host,
            port:        conn.port,
            database:    conn.database,
            username:    conn.username,
            color:       "#6c63ff",
            group:       "Imported from DBeaver",
            folderPath:  connectionsFolder,
            sslMode:     "prefer",
            readOnly:    false,
            sqlInstance: "",
            windowsAuth: false,
            existingFilePath: "",
            sshEnabled:  false,
            sshHost:     "",
            sshPort:     22,
            sshUser:     "",
            sshKeyPath:  "",
          };

          const saveResult = await invoke<string>("save_connection", {
            requestJson: JSON.stringify(request),
          });

          if (!saveResult.startsWith("ERROR") && conn.password) {
            const credRef = `dbark:${conn.name.toLowerCase().replace(/\s+/g, "-")}:${conn.username}`;
            await invoke("store_credential", {
              target:   credRef,
              username: conn.username,
              password: conn.password,
            });
          }
        }
        loadConnections(connectionsFolder);
      }
    } catch (e) {
      setDbeaverResult({ imported: [], skipped: [], error: String(e) });
    } finally {
      setDbeaverImporting(false);
    }
  }
  //END DBeaver import

  //BEGIN SSH Tunnel helper
  async function openTunnel(conn: ConnectionConfig): Promise<number | null> {
    if (!conn.sshEnabled) return null;
    if (tunnelPortsRef.current[conn.id]) return tunnelPortsRef.current[conn.id];

    setTunnelLoading(prev => ({ ...prev, [conn.id]: true }));
    try {
      // Get SSH password from keychain if stored
      let sshPassword = "";
      try {
        sshPassword = await invoke<string>("get_ssh_password", {
          target:   `dbark-ssh:${conn.id}:${conn.sshUser}`,
          username: conn.sshUser,
        });
      } catch { /* no SSH password stored — key-only auth */ }

      const localPort = await invoke<number>("open_tunnel", {
        tunnelId:    conn.id,
        sshHost:     conn.sshHost,
        sshPort:     conn.sshPort ?? 22,
        sshUser:     conn.sshUser,
        sshKeyPath:  conn.sshKeyPath ?? "",
        sshPassword: sshPassword,
        dbHost:      "127.0.0.1",
        dbPort:      conn.port,
      });

      console.log("open_tunnel invoke result:", localPort);
      tunnelPortsRef.current = { ...tunnelPortsRef.current, [conn.id]: localPort };
      setTunnelPorts({ ...tunnelPortsRef.current });
      return localPort;
    } catch (e) {
      console.error("open_tunnel invoke error:", e);
      updateActiveTab({ error: `SSH tunnel failed: ${String(e)}` });
      return null;
    } finally {
      setTunnelLoading(prev => ({ ...prev, [conn.id]: false }));
    }
  }


  useEffect(() => { schemaRef.current = schema; }, [schema]);

  useEffect(() => {
    if (showHistory) {
      loadHistory(activeTab.connection);
    }
  }, [activeTabId, activeTab.connection]);

  //Active Tab helper - load schema when connection changes
  const schemaConnectionId = useRef<string | null>(null);

  const [dropConfirm, setDropConfirm] = useState<{
    name:       string;
    type:       string;
    schema:     string;
    tableName:  string;
    dropSql:    string;
    connection: ConnectionConfig;
  } | null>(null);

  function buildDropSql(
    engine: string, type: string,
    name: string, schema: string, table: string
  ): string {
    switch (engine) {
      case "sqlserver":
        switch (type) {
          case "procedure": return `DROP PROCEDURE [${schema}].[${name}]`;
          case "function":  return `DROP FUNCTION [${schema}].[${name}]`;
          case "view":      return `DROP VIEW [${schema}].[${name}]`;
          case "trigger":   return `DROP TRIGGER [${name}]`;
          case "index":     return `DROP INDEX [${name}] ON [${schema}].[${table}]`;
          case "table":     return `DROP TABLE [${schema}].[${name}]`;
          default:          return `DROP ${type} [${name}]`;
        }
      case "mysql":
        switch (type) {
          case "procedure": return `DROP PROCEDURE \`${name}\``;
          case "function":  return `DROP FUNCTION \`${name}\``;
          case "view":      return `DROP VIEW \`${name}\``;
          case "trigger":   return `DROP TRIGGER \`${name}\``;
          case "index":     return `DROP INDEX \`${name}\` ON \`${table}\``;
          case "table":     return `DROP TABLE \`${name}\``;
          default:          return `DROP ${type} \`${name}\``;
        }
      case "postgres":
        switch (type) {
          case "procedure": return `DROP PROCEDURE ${schema}.${name}`;
          case "function":  return `DROP FUNCTION ${schema}.${name}`;
          case "view":      return `DROP VIEW ${schema}.${name}`;
          case "trigger":   return `DROP TRIGGER ${name} ON ${schema}.${table}`;
          case "index":     return `DROP INDEX ${schema}.${name}`;
          case "table":     return `DROP TABLE ${schema}.${name}`;
          default:          return `DROP ${type} ${name}`;
        }
      default: // sqlite
        switch (type) {
          case "view":    return `DROP VIEW ${name}`;
          case "trigger": return `DROP TRIGGER ${name}`;
          case "index":   return `DROP INDEX ${name}`;
          case "table":   return `DROP TABLE ${name}`;
          default:        return `DROP ${type} ${name}`;
        }
    }
  }

  useEffect(() => {
    const conn = activeTab.connection;
    if (conn) {
      if (schemaConnectionId.current === conn.id) return; // already loaded
      schemaConnectionId.current = conn.id;
      setSchema(null);
      setExpandedTables(new Set());
      // Load the server's database list, then the schema for this tab's active
      // database (or the connection default if the tab hasn't picked one yet).
      setDbTreeCollapsed(false);
      loadDatabases(conn, activeTab.activeDatabase ?? conn.database);
    } else {
      schemaConnectionId.current = null;
      setSchema(null);
      setExpandedTables(new Set());
      setDatabases([]);
    }
  }, [activeTabId]);

  //END Active Tab Schema helper

  useEffect(() => {
    import("@tauri-apps/api/path").then(({ homeDir, join }) => {
      homeDir().then(async home => {
        const folder = await join(home, ".dbark", "connections");
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
            purgeSchemaCache(fresh.id);
            dbListCache.current.delete(fresh.id);
            setExpandedSchemas(new Set(["public"]));
            return { ...tab, connection: fresh, error: null, results: [], activeResult: 0 };
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
            loadDatabases(freshConn, activeTabRef.current.activeDatabase ?? freshConn.database);
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

  function generateUpdateSql(
    tableName:    string,
    schemaName:   string,
    edits:        PendingEdit[],
    pkColumns:    ColumnInfo[],
    pkValues:     (string | null)[],
    engine:       string,
  ): string {
    const quote = (n: string) =>
      engine === "sqlserver" ? `[${n}]`
      : engine === "mysql"   ? `\`${n}\``
      : n;

    const quoteTable = () =>
      engine === "sqlserver"
        ? `[${schemaName || "dbo"}].[${tableName}]`
        : engine === "mysql"
        ? `\`${tableName}\``
        : `${schemaName || "public"}.${tableName}`;

    const quoteValue = (v: string | null) => {
      if (v === null) return "NULL";
      // Numeric — no quotes
      if (/^-?\d+(\.\d+)?$/.test(v)) return v;
      // Escape single quotes
      return `'${v.replace(/'/g, "''")}'`;
    };

    const setClause = edits
      .map(e => `    ${quote(e.colName)} = ${quoteValue(e.newValue)}`)
      .join(",\n");

    const whereClause = pkColumns
      .map((pk, i) => `${quote(pk.name)} = ${quoteValue(pkValues[i])}`)
      .join(" AND ");

    return `UPDATE ${quoteTable()}\nSET\n${setClause}\nWHERE ${whereClause}`;
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
    if (settings.lockTimeoutMins === 0) return; // disabled
    const now = Date.now();
    if (now - lastActivity.current < 500) return;
    lastActivity.current = now;
    if (inactivityTimer.current) clearTimeout(inactivityTimer.current);
    if (locked) return;
    inactivityTimer.current = setTimeout(
      () => setLocked(true),
      settings.lockTimeoutMins * 60 * 1000
    );
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

 useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      //const sql = editorRef.current?.getValue()?.trim() ?? "";
      setSaveQueryOpen(true);
    }

    // Block WebView reload shortcuts at the document level. A native app
    // should never reload itself from a keystroke. Monaco's addCommand
    // only intercepts these when the editor is focused, leaving the
    // WebView's default (page reload) to run from any other focus state.
    //   F5             — primary reload
    //   Ctrl+R / Cmd+R — alternate reload
    //   Ctrl+Shift+R / Cmd+Shift+R — hard reload (also blocked)
    if (e.key === "F5"
        || ((e.metaKey || e.ctrlKey) && (e.key === "r" || e.key === "R"))) {
      e.preventDefault();

      // F5 outside the editor still runs the active tab's query.
      // SSMS users expect F5 to work from any focus state. Reload-blocking
      // Ctrl+R / Cmd+R is a no-op — those aren't SSMS run shortcuts.
      if (e.key === "F5") {
        runQueryRef.current();
      }
    }
  }
  window.addEventListener("keydown", handleKeyDown);
  return () => window.removeEventListener("keydown", handleKeyDown);
}, []);

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
        title:      name,
        joinTables: [],
        results:     [],
        activeResult: 0,
        error:      null,
      });

      editorRef.current?.setValue("SELECT * FROM data LIMIT 100");
    } catch (e) {
      console.error("Failed to open file:", e);
    }
  }

  async function scriptDropAndCreate(
    name: string,
    type: string,
    schema: string,
    conn: ConnectionConfig,
    extra?: { tableName: string; columns: string; isUnique: boolean; isPrimary: boolean; }
  ) {
    // Get the CREATE definition first
    const raw = await invoke<string>("get_object_definition", {
      credentialRef: conn.credentialRef,
      engine:        conn.engine,
      host:          conn.host,
      port:          conn.port,
      database:      conn.database,
      username:      conn.username,
      sslMode:       conn.sslMode ?? "prefer",
      sqlInstance:   conn.sqlInstance ?? "",
      windowsAuth:   conn.windowsAuth ?? false,
      objectName:    name,
      objectType:    type,
      schemaName:    schema || "dbo",
    });

    const parsed: { definition?: string; error?: string } = JSON.parse(raw);
    if (parsed.error) { updateActiveTab({ error: parsed.error }); return; }

    const definition = parsed.definition ?? "";

    // Build DROP IF EXISTS per engine
    const dropSql = buildDropIfExists(conn.engine, type, name, schema,
      extra?.tableName ?? "");

    const batchSep = conn.engine === "sqlserver" ? "\nGO\n\n" : "\n\n";
    const fullScript = `${dropSql}${batchSep}${definition}`;

    const currentSql = editorRef.current?.getValue() ?? "";
    const newTab      = createTab();
    newTab.title      = `Drop & Create ${name}`;
    newTab.sql        = fullScript;
    newTab.connection = conn;

    setTabs(prev => {
      const updated = prev.map(t =>
        t.id === activeTabId ? { ...t, sql: currentSql } : t
      );
      return [...updated, newTab];
    });
    setActiveTabId(newTab.id);
    setTimeout(() => editorRef.current?.setValue(fullScript), 0);
  }

  function buildDropIfExists(
    engine: string, type: string,
    name: string, schema: string, table: string
  ): string {
    switch (engine) {
      case "sqlserver":
        switch (type) {
          case "procedure": return `DROP PROCEDURE IF EXISTS [${schema}].[${name}]`;
          case "function":  return `DROP FUNCTION IF EXISTS [${schema}].[${name}]`;
          case "view":      return `DROP VIEW IF EXISTS [${schema}].[${name}]`;
          case "trigger":   return `DROP TRIGGER IF EXISTS [${name}]`;
          case "table":     return `DROP TABLE IF EXISTS [${schema}].[${name}]`;
          case "index":     return `DROP INDEX IF EXISTS [${name}] ON [${schema}].[${table}]`;
          default:          return `DROP ${type} IF EXISTS [${name}]`;
        }
      case "mysql":
        switch (type) {
          case "procedure": return `DROP PROCEDURE IF EXISTS \`${name}\``;
          case "function":  return `DROP FUNCTION IF EXISTS \`${name}\``;
          case "view":      return `DROP VIEW IF EXISTS \`${name}\``;
          case "trigger":   return `DROP TRIGGER IF EXISTS \`${name}\``;
          case "table":     return `DROP TABLE IF EXISTS \`${name}\``;
          case "index":     return `DROP INDEX IF EXISTS \`${name}\` ON \`${table}\``;
          default:          return `DROP ${type} IF EXISTS \`${name}\``;
        }
      case "postgres":
        switch (type) {
          case "procedure": return `DROP PROCEDURE IF EXISTS ${schema}.${name}`;
          case "function":  return `DROP FUNCTION IF EXISTS ${schema}.${name}`;
          case "view":      return `DROP VIEW IF EXISTS ${schema}.${name}`;
          case "trigger":   return `DROP TRIGGER IF EXISTS ${name} ON ${schema}.${table}`;
          case "table":     return `DROP TABLE IF EXISTS ${schema}.${name}`;
          case "index":     return `DROP INDEX IF EXISTS ${schema}.${name}`;
          default:          return `DROP ${type} IF EXISTS ${name}`;
        }
      default: // SQLite
        switch (type) {
          case "view":    return `DROP VIEW IF EXISTS ${name}`;
          case "trigger": return `DROP TRIGGER IF EXISTS ${name}`;
          case "index":   return `DROP INDEX IF EXISTS ${name}`;
          case "table":   return `DROP TABLE IF EXISTS ${name}`;
          default:        return `DROP ${type} IF EXISTS ${name}`;
        }
    }
  }

  //Generate CRUD Scripts for Various Db Objects
  function scriptTable(
    table: TableInfo,
    scriptType: "select" | "insert" | "update" | "delete",
    engine: string
  ): string {
    const cols     = table.columns ?? [];
    const pkCols   = cols.filter(c => c.isPrimaryKey);
    const dataCols = cols.filter(c => !c.isPrimaryKey);

    const quoteName = (n: string) =>
      engine === "sqlserver" ? `[${n}]`
      : engine === "mysql"   ? `\`${n}\``
      : n;

    const quoteTable = () =>
      engine === "sqlserver"
        ? `[${table.schema || "dbo"}].[${table.name}]`
        : engine === "mysql"
        ? `\`${table.name}\``
        : `${table.schema || "public"}.${table.name}`;

    const colList = (columns: ColumnInfo[]) =>
      columns.map(c => quoteName(c.name)).join(", ");

    const valueList = (columns: ColumnInfo[]) =>
      columns.map(c => `<${c.name}, ${c.dataType}>`).join(", ");

    const setList = (columns: ColumnInfo[]) =>
      columns.map(c =>
        `    ${quoteName(c.name)} = <${c.name}, ${c.dataType}>`
      ).join(",\n");

    const whereClause = (columns: ColumnInfo[]) =>
      columns.length > 0
        ? columns.map(c =>
            `${quoteName(c.name)} = <${c.name}, ${c.dataType}>`
          ).join(" AND ")
        : `<primary_key> = <value>`;

    const tbl = quoteTable();

    switch (scriptType) {
      case "select":
        return `SELECT ${colList(cols)}\nFROM ${tbl}`;

      case "insert":
        return `INSERT INTO ${tbl}\n    (${colList(dataCols.length > 0 ? dataCols : cols)})\nVALUES\n    (${valueList(dataCols.length > 0 ? dataCols : cols)})`;

      case "update":
        return `UPDATE ${tbl}\nSET\n${setList(dataCols.length > 0 ? dataCols : cols)}\nWHERE ${whereClause(pkCols)}`;

      case "delete":
        return `DELETE FROM ${tbl}\nWHERE ${whereClause(pkCols)}`;

      default:
        return "";
    }
  }

  function scriptExecute(proc: ProcedureInfo, engine: string): string {
    const paramList = proc.parameterCount > 0
      ? Array.from({ length: proc.parameterCount },
          (_, i) => `<param${i + 1}>`)
      : [];

    switch (engine) {
      case "sqlserver":
        return `EXECUTE [${proc.schema}].[${proc.name}]${
          paramList.length > 0
            ? "\n    " + paramList.map((p, i) =>
                `@param${i + 1} = ${p}`).join(",\n    ")
            : ""
        }`;
      case "mysql":
      case "mariadb":
        return `CALL \`${proc.name}\`(${paramList.join(", ")})`;
      case "postgres":
        return `CALL ${proc.schema}.${proc.name}(${paramList.join(", ")})`;
      case "cockroachdb":
        // CockroachDB v23.1+ supports CREATE PROCEDURE with CALL syntax.
        // SQL-language procedures (SELECT-only) work on the free tier.
        // DML procedures require LANGUAGE plpgsql (enterprise-only).
        return `CALL ${proc.schema}.${proc.name}(${paramList.join(", ")})`;
      default:
        return `-- ${engine} does not support stored procedures`;
    }
  }

  function setEditorScript(script: string) {
    editorRef.current?.setValue(script);
    editorRef.current?.focus();
  }

  const menuItemStyle: React.CSSProperties = {
    display: "block", width: "100%", padding: "8px 16px",
    background: "none", border: "none", color: "var(--text)",
    fontSize: 12, fontFamily: "monospace", cursor: "pointer",
    textAlign: "left",
  };
  //END CRUD Script function

  //Run Query Function
  const runQuery = useCallback(async () => {
    if (locked) return;
    const userSql = editorRef.current?.getValue()?.trim() ?? "";
    if (!userSql) return;

    const tab = activeTabRef.current;
    // Pin the launching tab's id for the entire async lifetime of this query.
    // Reads use `tab` (captured above); every write below must target this id,
    // NOT the live activeTabId — otherwise a result that arrives after the user
    // switches tabs lands in the wrong tab. updateActiveTab() resolves
    // activeTabId at call time and must not be used for post-await writes here.
    const launchTabId = tab.id;
    const writeTab = (updates: Partial<Tab>) =>
      setTabs(prev => prev.map(t => (t.id === launchTabId ? { ...t, ...updates } : t)));

    // ── Plan-mode wrapping ────────────────────────────────────────────────
    // If the per-tab Include Plan toggle is on AND we're on a DB connection
    // (plan mode is meaningless for flat-file DuckDB queries), wrap the SQL
    // with the engine's EXPLAIN equivalent. wrapPlanSql() returns null when
    // the statement isn't plan-safe (non-SELECT) — in that case we fall
    // back to running the original SQL with a banner error to keep the
    // user informed rather than silently dropping the toggle.
    let sql = userSql;
    let wrappedPlanSql: string | null = null;
    let planMode = false;
    if (tab.includePlan && tab.connection && !tab.file) {
      const wrapped = wrapPlanSql(userSql, tab.connection.engine);
      if (wrapped == null) {
        writeTab({
          loading: false,
          error: "Execution plan capture only works for SELECT statements. Disable 'Include Plan' to run this query.",
        });
        return;
      }
      planMode = true;
      if (tab.connection.engine.toLowerCase() === "sqlserver") {
        // SQL Server: SET STATISTICS XML returns data + plan in one execution.
        // Swap sql for the wrapped form; the C# layer now returns both result
        // sets and the post-parse reshape tags the plan tab.
        sql = wrapped;
      } else {
        // Postgres / MySQL / MariaDB / SQLite / CockroachDB: EXPLAIN *replaces*
        // the query rather than running alongside it. Keep `sql` as the user's
        // original (for the data call) and stash the wrapped form for a second
        // call we'll make right after the data call returns.
        wrappedPlanSql = wrapped;
      }
    }

    writeTab({ loading: true, error: null, results: [], activeResult: 0 });

    const start = performance.now();
    let historyConn: ConnectionConfig | null = null;

    try {
      let raw: string;
      let planRaw: string | null = null;

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

          console.log("SSH key path being sent:", conn.sshKeyPath);
          console.log("SSH user being sent:", conn.sshUser);
          console.log("SSH host being sent:", conn.sshHost);

          // Open SSH tunnel if enabled
          let tunnelPort: number | undefined;
          if (conn.sshEnabled) {
            console.log("Opening tunnel for:", conn.sshHost, "db port:", conn.port);
            const port = await openTunnel(conn);
            console.log("Tunnel result:", port);
            if (!port) return;
            tunnelPort = port;
          }

          console.log("effectiveSslMode:", tunnelPort !== undefined ? "none" : conn.sslMode);
          console.log("tunnelPort:", tunnelPort);
          console.log("connecting to:", tunnelPort ? `127.0.0.1:${tunnelPort}` : `${conn.host}:${conn.port}`);

          // When an SSH tunnel is active, disable SSL on the DB connection —
          // the tunnel is already encrypted end-to-end. Mixing SSL with an
          // SSH tunnel causes handshake failures on MySQL and Postgres.
          const effectiveSslMode = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

          const connectionString = await invoke<string>("build_connection_string", {
            credentialRef: conn.credentialRef,
            engine:        conn.engine,
            host:          conn.host,
            port:          conn.port,
            // Run against the database the user is browsing in the sidebar, not
            // necessarily the connection's saved default. Lets one connection
            // query any database on its server without a separate connection.
            database:      tab.activeDatabase ?? conn.database,
            username:      conn.username,
            sslMode:       effectiveSslMode,
            sqlInstance:   conn.sqlInstance ?? "",
            windowsAuth:   conn.windowsAuth ?? false,
            tunnelPort:    tunnelPort,  // ← pass tunnel port
          });

        raw = await invoke<string>("execute_query", {
          connectionString,
          sql,
          engine:   conn.engine,
          readOnly: conn.readOnly ?? false,
          rowLimit: settingsRef.current.resultRowLimit,
        });

        // Second call for non-SQL Server plan capture. Reuses the same
        // connectionString — so the same SSH tunnel and same credentials —
        // just with the EXPLAIN-wrapped form of the user's SQL.
        //
        // Failure here doesn't sink the whole runQuery; we stuff the error
        // into a fake JSON envelope so the parsing branch below surfaces it
        // as an errored plan tab and the user keeps their data result.
        if (wrappedPlanSql) {
          try {
            planRaw = await invoke<string>("execute_query", {
              connectionString,
              sql: wrappedPlanSql,
              engine: conn.engine,
              readOnly: conn.readOnly ?? false,
              rowLimit: settingsRef.current.resultRowLimit,
            });
          } catch (e) {
            planRaw = JSON.stringify({
              error: `Plan capture failed: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        }

      } else {
        writeTab({ loading: false, error: "Select a connection or open a file first" });
        return;
      }

    const parsed = JSON.parse(raw);

    // File queries return single result shape — normalise to multi-result
    const normalised: { results: QueryResult[]; rowCount?: number; error?: string } = 
      parsed.results 
        ? parsed  // already multi-result shape (DB query)
        : parsed.error
        ? { results: [], error: parsed.error }
        : { results: [{ ...parsed, sql: "" }] }; // wrap single result

    // Tag every result as a plan output when plan mode was on. The renderer
    // checks isPlan and routes through PlanResultRenderer instead of the
    // data grid. Engine is recorded so the right parser is selected.
    if (planMode && tab.connection) {
      const engine = tab.connection.engine;

      if (engine === "sqlserver") {
        // SQL Server: STATISTICS XML returned data + plan in one call,
        // and (after the C# fix) both arrive as separate entries in
        // normalised.results. Find the XML cell, split data from plan,
        // and tag the plan with isPlan.
        let planResult: typeof normalised.results[0] | undefined;
        let planCell = "";

        console.log(
          "[plan] SQL Server response — %d result set(s)",
          normalised.results.length
        );
        normalised.results.forEach((r, i) => {
          const colShape = r.columns?.length === 1
            ? `1 col: "${r.columns[0]}"`
            : `${r.columns?.length ?? 0} cols`;
          const firstCells = (r.rows ?? []).slice(0, 2).map(row => {
            const c = row[0];
            return c === null ? "null"
              : typeof c === "string"
              ? c.length === 0 ? "empty" : `"${c.slice(0, 60)}${c.length > 60 ? "..." : ""}"`
              : String(c);
          });
          console.log(
            `[plan]   Result ${i}: ${colShape} · ${r.rows?.length ?? 0} row(s) · samples: [${firstCells.join(", ")}]`
          );
        });

        for (const r of normalised.results) {
          for (const row of r.rows ?? []) {
            for (const cell of row) {
              if (typeof cell === "string" && cell.trimStart().startsWith("<")) {
                const head = cell.trimStart().slice(0, 200);
                if (head.includes("ShowPlanXML") || head.includes("<?xml")) {
                  planResult = r;
                  planCell = cell;
                  break;
                }
              }
            }
            if (planCell) break;
          }
          if (planCell) break;
        }

        if (planResult && planCell) {
          console.log("[plan] ✓ Matched XML cell, reshaping result");
          const dataResults = normalised.results.filter(
            r => r !== planResult && !r.isMessage
          );
          const reshapedPlan: QueryResult = {
            ...planResult,
            columns: ["plan"],
            rows: [[planCell]],
            rowCount: 1,
            isPlan: true,
            planEngine: engine,
          };
          normalised.results = [...dataResults, reshapedPlan];
        } else {
          console.warn(
            "[plan] ✗ No XML cell found. Permission/driver issue, or plan not being returned by C#."
          );
        }
      } else if (planRaw != null) {
        // Postgres / MySQL / SQLite / CockroachDB: data came back from the
        // first call as normalised.results; the plan is in planRaw from the
        // second call. Append it as an extra result tagged isPlan.
        try {
          const planParsed = JSON.parse(planRaw);
          if (planParsed.error) {
            normalised.results.push({
              columns: [],
              rows: [],
              rowCount: 0,
              error: planParsed.error,
              isPlan: true,
              planEngine: engine,
            });
          } else {
            const planResults: QueryResult[] =
              planParsed.results ?? [planParsed];
            // EXPLAIN against any of these engines produces exactly one
            // result set; take the first and ignore extras defensively.
            if (planResults[0]) {
              normalised.results.push({
                ...planResults[0],
                isPlan: true,
                planEngine: engine,
              });
            }
          }
        } catch (e) {
          console.error("[plan] Failed to parse planRaw:", e);
          normalised.results.push({
            columns: [],
            rows: [],
            rowCount: 0,
            error: `Plan parse failed: ${e instanceof Error ? e.message : String(e)}`,
            isPlan: true,
            planEngine: engine,
          });
        }
      }
    }
    const ms = Math.round(performance.now() - start);

    // Top-level error (connection failed etc)
    if (normalised.error) {
      writeTab({ loading: false, duration: ms, results: [], error: normalised.error! });
      return;
    }

    const results = normalised.results ?? [];
    const firstError = results.find(r => r.error);

    // Result auto-clear — targets the launching tab, not the active one.
    if (settings.resultClearMins > 0) {
      setTimeout(() => {
        setTabs(prev => prev.map(t =>
          t.id === launchTabId ? { ...t, results: [], error: null } : t
        ));
      }, settings.resultClearMins * 60 * 1000);
    }

    writeTab({
      loading:      false,
      duration:     ms,
      results:      results,
      activeResult: 0,
      error:        firstError?.error ?? null,
    });

    if (historyConn) {
      await saveToHistory(historyConn, sql, ms, normalised.rowCount ?? 0, !normalised.error);
      if (showHistory) loadHistory(historyConn);
    }

    if (historyConn && auditLogEnabled) {
      invoke("append_audit_log", {
        connectionName: historyConn.name,
        engine:         historyConn.engine,
        sql:            sql,
        rowCount:       normalised.rowCount ?? 0,
        durationMs:     ms,
        success:        !normalised.error,
      }).catch(() => {}); // fire and forget — never block query execution
    }

   } catch (e) {
      writeTab({ loading: false, error: String(e) });
    }
  }, [locked, showHistory, activeTabId, auditLogEnabled]);

  useEffect(() => { runQueryRef.current = runQuery; }, [runQuery]);

  // Dialect-aware SQL formatter — Ctrl+Shift+F / Cmd+Shift+F
  // Formats the selection if non-empty, otherwise the entire buffer.
  // Applied via executeEdits so it's a single undoable step.
  const formatActiveSql = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    // Engine → sql-formatter dialect mapping.
    // CockroachDB is wire-compatible with Postgres so it shares the dialect.
    // No active connection falls back to the generic "sql" dialect.
    const engine = activeTabRef.current?.connection?.engine;
    const dialectMap: Record<string, string> = {
      sqlserver:   "tsql",
      postgres:    "postgresql",
      cockroachdb: "postgresql",
      mysql:       "mysql",
      mariadb:     "mariadb",
      sqlite:      "sqlite",
    };
    const language = (engine && dialectMap[engine]) ?? "sql";

    const selection = editor.getSelection();
    const hasSelection = selection && !selection.isEmpty();
    const targetRange = hasSelection ? selection : model.getFullModelRange();
    const sourceText = model.getValueInRange(targetRange);
    if (!sourceText.trim()) return;

    let formatted: string;
    try {
      formatted = formatSql(sourceText, {
        // Cast: sql-formatter's SqlLanguage union isn't worth importing
        // just to retype the same string we already validated above.
        language: language as any,
        keywordCase: "upper",
        indentStyle: "standard",
        linesBetweenQueries: 2,
        tabWidth: 4,
      });
    } catch (e) {
      // Un-parseable input (user mid-edit, exotic dialect feature, etc).
      // Silent no-op is the right call — surfacing a banner on every
      // mistyped query would be more annoying than helpful.
      console.warn("SQL formatter could not parse input:", e);
      return;
    }

    editor.executeEdits("format-sql", [{
      range: targetRange,
      text: formatted,
      forceMoveMarkers: true,
    }]);
  }, []);
  useEffect(() => { formatSqlRef.current = formatActiveSql; }, [formatActiveSql]);
  //End Run Query Function

  const handleBeforeMount = useCallback((monaco: typeof monacoEditor) => {
      // Pre-register the 'sql' language ID so Monaco's built-in SQL loader
      // never fires. Without this, Monaco loads its default SQL grammar after
      // handleEditorMount, overwriting setMonarchTokensProvider silently.
      if (!tokensProviderRegistered.current) {
        tokensProviderRegistered.current = true;
        monaco.languages.register({ id: "sql" });
         monaco.languages.setMonarchTokensProvider("sql", {
        defaultToken: "",
        tokenPostfix: ".sql",
        ignoreCase: true,

        brackets: [
          { open: "[", close: "]", token: "delimiter.square" },
          { open: "(", close: ")", token: "delimiter.parenthesis" },
        ],

        keywords: [
          // Standard SQL
          "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "AUTHORIZATION",
          "BACKUP", "BEGIN", "BETWEEN", "BREAK", "BY",
          "CASCADE", "CASE", "CHECK", "CLOSE", "CLUSTERED", "COALESCE",
          "COLLATE", "COLUMN", "COMMIT", "CONSTRAINT", "CONTINUE", "CONVERT",
          "CREATE", "CROSS", "CURRENT", "CURRENT_DATE", "CURRENT_TIME", "CURSOR",
          "DATABASE", "DECLARE", "DEFAULT", "DELETE", "DESC", "DISTINCT",
          "DOUBLE", "DROP",
          "ELSE", "END", "ESCAPE", "EXCEPT", "EXISTS", "EXIT", "EXTERNAL",
          "FETCH", "FOR", "FOREIGN", "FROM", "FULL", "FUNCTION",
          "GOTO", "GRANT", "GROUP",
          "HAVING",
          "IF", "IN", "INDEX", "INNER", "INSERT", "INTERSECT", "INTO", "IS",
          "JOIN", "KEY", "KILL",
          "LEFT", "LIKE", "LOAD",
          "MERGE",
          "NATIONAL", "NOCHECK", "NOT", "NULL", "NULLIF",
          "OF", "OFF", "ON", "OPEN", "OPTION", "OR", "ORDER", "OUTER", "OVER",
          "PERCENT", "PIVOT", "PLAN", "PRECISION", "PRIMARY", "PRINT", "PROC",
          "PROCEDURE", "PUBLIC",
          "READ", "RECONFIGURE", "REFERENCES", "REPLACE", "REPLICATION",
          "RESTORE", "RESTRICT", "RETURN", "REVERT", "REVOKE", "RIGHT",
          "ROLLBACK", "RULE",
          "SAVE", "SCHEMA", "SELECT", "SESSION_USER", "SET", "SHUTDOWN",
          "SOME", "STATISTICS", "SYSTEM_USER",
          "TABLE", "THEN", "TO", "TOP", "TRAN", "TRANSACTION", "TRIGGER",
          "TRUNCATE", "UNION", "UNIQUE", "UNPIVOT", "UPDATE", "USE", "USER",
          "VALUES", "VIEW",
          "WAITFOR", "WHEN", "WHERE", "WHILE", "WITH", "WITHIN",
          // Stored procedure / routine keywords
          // CALL is the standard for MySQL, MariaDB, CockroachDB, and Postgres.
          // EXEC / EXECUTE are the SQL Server equivalents.
          "CALL", "EXEC", "EXECUTE",
          // Additional dialect keywords
          "DESCRIBE", "EXPLAIN", "SHOW", "LIMIT", "OFFSET",
          "DO", "HANDLER", "RETURNS", "LANGUAGE", "DECLARE",
        ],

        builtinFunctions: [
          "ABS", "AVG", "CAST", "CEILING", "COALESCE", "CONCAT", "CONVERT",
          "COUNT", "DAY", "DATEDIFF", "FLOOR", "GETDATE", "ISNULL", "LEN",
          "LOWER", "MAX", "MIN", "MONTH", "NOW", "NULLIF", "ROUND",
          "ROW_NUMBER", "SUBSTRING", "SUM", "TRIM", "UPPER", "YEAR",
          "TRY_CAST", "TRY_CONVERT", "COALESCE", "NULLIF",
        ],

        tokenizer: {
          root: [
            { include: "@comments" },
            { include: "@whitespace" },
            [/[;,.]/, "delimiter"],
            [/[()[\]]/, "@brackets"],
            [/[<>=!%&+\-*/|~^]/, "operator"],
            [/\d*\.\d+([eE][-+]?\d+)?/, "number.float"],
            [/\d+/, "number"],
            [/'/, { token: "string", next: "@stringSingle" }],
            [/"/, { token: "string.double", next: "@stringDouble" }],
            [/`/, { token: "string.backtick", next: "@stringBacktick" }],
            [/\[/, { token: "string.bracket", next: "@stringBracket" }],
            [
              /[a-zA-Z_]\w*/,
              {
                cases: {
                  "@keywords": "keyword",
                  "@builtinFunctions": "predefined",
                  "@default": "identifier",
                },
              },
            ],
          ],

          comments: [
            [/--.*$/, "comment"],
            [/\/\*/, { token: "comment.quote", next: "@blockComment" }],
          ],

          blockComment: [
            [/[^*/]+/, "comment"],
            [/\*\//, { token: "comment.quote", next: "@pop" }],
            [/./, "comment"],
          ],

          whitespace: [[/\s+/, "white"]],

          stringSingle: [
            [/[^']+/, "string"],
            [/''/, "string"],
            [/'/, { token: "string", next: "@pop" }],
          ],

          stringDouble: [
            [/[^"]+/, "string.double"],
            [/""/, "string.double"],
            [/"/, { token: "string.double", next: "@pop" }],
          ],

          stringBacktick: [
            [/[^`]+/, "string.backtick"],
            [/``/, "string.backtick"],
            [/`/, { token: "string.backtick", next: "@pop" }],
          ],

          stringBracket: [
            [/[^\]]+/, "string.bracket"],
            [/\]/, { token: "string.bracket", next: "@pop" }],
          ],
        },
      });
      }
    }, []);

  const handleEditorMount: OnMount = (editor, monaco) => {
      editorRef.current = editor;

    // Register extended SQL tokenizer once — adds CALL, EXEC, EXECUTE,
    // PROCEDURE and other keywords missing from Monaco's built-in SQL grammar.
    // Must use setMonarchTokensProvider which replaces the tokenizer entirely,
    // so a complete tokenizer is required rather than a partial patch.
    if (!tokensProviderRegistered.current) {
      tokensProviderRegistered.current = true;
    }

    if (!autocompleteRegistered.current) {
      autocompleteRegistered.current = true;

      monaco.languages.registerCompletionItemProvider("sql", {
        triggerCharacters: [" ", ".", "\n"],
        provideCompletionItems: (model: monacoEditor.editor.ITextModel, position: monacoEditor.Position) => {
          const word = model.getWordUntilPosition(position);
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };

          const suggestions: monacoEditor.languages.CompletionItem[] = [];

          // SQL keywords — kept in sync with the tokenizer keywords above
          const keywords = [
            "SELECT", "FROM", "WHERE", "JOIN", "LEFT JOIN", "RIGHT JOIN",
            "INNER JOIN", "ON", "GROUP BY", "ORDER BY", "HAVING", "LIMIT",
            "OFFSET", "INSERT INTO", "UPDATE", "DELETE FROM", "CREATE TABLE",
            "DROP TABLE", "ALTER TABLE", "AND", "OR", "NOT", "IN", "IS NULL",
            "IS NOT NULL", "LIKE", "BETWEEN", "DISTINCT", "COUNT", "SUM",
            "AVG", "MIN", "MAX", "AS", "CASE", "WHEN", "THEN", "ELSE", "END",
            // Procedure / function call keywords
            "CALL", "EXEC", "EXECUTE",
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

      // Ctrl+Shift+D / Cmd+Shift+D — toggle Diagram panel
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyD,
        () => {
          setShowDiagram(prev => {
            const next = !prev;
            if (next) updateActiveTab({ activeResult: -2 });
            else if (activeTab.activeResult === -2) updateActiveTab({ activeResult: 0 });
            return next;
          });
        }
      );

      // Ctrl+Shift+F / Cmd+Shift+F — dialect-aware SQL formatter
      // Uses the ref so it always picks up the latest formatActiveSql,
      // matching the runQueryRef pattern.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
        () => { formatSqlRef.current(); }
      );

      // Ctrl+Shift+A / Cmd+Shift+A — toggle Activity panel
      // No ref needed; toggle is a simple state flip with no closure issues.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyA,
        () => { setShowActivity(prev => !prev); }
      );

      // Ctrl+P / Cmd+P — open command palette
      // No ref needed; setShowPalette is stable across renders.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP,
        () => { setShowPalette(true); }
      );

      // F5 — alias for Run (SSMS muscle memory).
      // Handled at the document level (see global keydown handler) rather
      // than via Monaco's addCommand, because we also need to block the
      // WebView's default reload-on-F5 behavior — which Monaco can't see
      // when the editor isn't focused. The document handler serves both
      // purposes: prevent reload AND invoke runQueryRef. Registering F5
      // here too would cause runQuery to fire twice when editor has focus.

      // Ctrl+/ — toggle line comment.
      // Monaco has this built-in via the editor.action.commentLine action,
      // bound to Ctrl+/ on its own keymap. But Monaco's default binding
      // doesn't fire reliably inside a Tauri WebView on Windows because
      // the WebView intercepts some keys before Monaco sees them. Adding
      // an explicit addCommand re-registers it through Monaco's pipeline.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash,
        () => {
          editor.getAction("editor.action.commentLine")?.run();
        }
      );

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

  // Resolve which database to load: explicit arg wins, else the connection's
  // saved default. The cache is keyed by connection id + database so two
  // databases on the same server are cached independently.
  async function loadSchema(conn: ConnectionConfig, database?: string) {
    const db      = database ?? conn.database;
    const cacheKey = `${conn.id}::${db}`;

    if (schemaCache.current.has(cacheKey)) {
      setSchema(schemaCache.current.get(cacheKey)!);
      return;
    }

    if (schemaCache.current.size >= 5) {
      const firstKey = schemaCache.current.keys().next().value;
      schemaCache.current.delete(firstKey!);
    }

    setExpandedSchemas(new Set(["public"]));
    setSchema(null);
    setSchemaLoading(true);

    try {
      // Open SSH tunnel first if needed
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (!port) {
          setSchema({ tables: [], procedures: [], functions: [], views: [], triggers: [], indexes: [], error: "SSH tunnel not open — run a query first to establish the tunnel" });
          setSchemaLoading(false);
          return;
        }
        tunnelPort = port;
      }

      const effectiveHost = tunnelPort !== undefined ? "127.0.0.1" : conn.host;
      const effectivePort = tunnelPort ?? conn.port;
      const effectiveSsl  = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const raw = await invoke<string>("get_schema", {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          effectiveHost,
        port:          effectivePort,
        database:      db,
        username:      conn.username,
        sslMode:       effectiveSsl,
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
      });

      const parsed: SchemaResult = JSON.parse(raw);

      // For SQLite — fetch programmable objects separately via safe Rust path
      if (conn.engine === "sqlite") {
        try {
          const objRaw = await invoke<string>("get_sqlite_objects", {
            database: conn.database,
          });

          const objParsed = JSON.parse(objRaw);

          // Multi-result shape — get the first result's rows
          const rows: (string | null)[][] =
            objParsed.results?.[0]?.rows ?? [];

          const views: ViewInfo[]     = [];
          const triggers: TriggerInfo[] = [];
          const indexes: IndexInfo[]  = [];

          for (const row of rows) {
            const type    = row[0] ?? "";
            const name    = row[1] ?? "";
            const tblName = row[2] ?? "";

            if (type === "view") {
              views.push({ name, schema: "" });
            } else if (type === "trigger") {
              triggers.push({
                name, tableName: tblName,
                event: "", timing: "",
              });
            } else if (type === "index") {
              indexes.push({
                name, tableName: tblName,
                columns: "", isUnique: false, isPrimary: false,
              });
            }
          }

          parsed.views    = views;
          parsed.triggers = triggers;
          parsed.indexes  = indexes;
        } catch (e) {
          console.error("Failed to load SQLite objects:", e);
          // Non-fatal — tables still show correctly
        }
      }

      schemaCache.current.set(cacheKey, parsed);
      setSchema(parsed);
    } catch (e) {
      console.error("Schema load failed:", e);
    } finally {
      setSchemaLoading(false);
    }
  }

  // Drop every cached schema for a connection (all of its databases). Used when
  // a connection is edited/refreshed so stale schemas across databases clear.
  function purgeSchemaCache(connId: string) {
    for (const key of [...schemaCache.current.keys()]) {
      if (key === connId || key.startsWith(`${connId}::`)) {
        schemaCache.current.delete(key);
      }
    }
  }

  // Fetch the list of databases on a connection's server, then load the schema
  // for the tab's active database (defaulting to the connection's saved one).
  // Called when a connection is selected. SQLite returns an empty list, in
  // which case the sidebar shows tables directly with no database layer.
  async function loadDatabases(conn: ConnectionConfig, preferredDb?: string) {
    const defaultDb = preferredDb ?? conn.database;

    // SQLite has no server-side database list — go straight to the schema.
    if (conn.engine === "sqlite") {
      setDatabases([]);
      loadSchema(conn, defaultDb);
      return;
    }

    // Serve a cached list instantly, but still (re)load the schema.
    if (dbListCache.current.has(conn.id)) {
      setDatabases(dbListCache.current.get(conn.id)!);
      loadSchema(conn, defaultDb);
      return;
    }

    setDatabases([]);
    setDatabasesLoading(true);

    try {
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (port) tunnelPort = port;
      }

      const effectiveHost = tunnelPort !== undefined ? "127.0.0.1" : conn.host;
      const effectivePort = tunnelPort ?? conn.port;
      const effectiveSsl  = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const raw = await invoke<string>("list_databases", {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          effectiveHost,
        port:          effectivePort,
        database:      defaultDb,
        username:      conn.username,
        sslMode:       effectiveSsl,
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
      });

      const parsed: { databases?: string[]; error?: string } = JSON.parse(raw);
      let list = parsed.databases ?? [];

      // Always include the connection's saved database, even if the
      // enumeration query couldn't see it (permissions, or it's a system DB
      // we filtered out) — the user explicitly configured it, so it must be
      // browsable. Keep it first so it reads as the default.
      if (defaultDb && !list.includes(defaultDb)) {
        list = [defaultDb, ...list];
      }

      dbListCache.current.set(conn.id, list);
      setDatabases(list);
    } catch (e) {
      console.error("Database list load failed:", e);
      // Fall back to just the saved database so the user can still browse it.
      setDatabases(defaultDb ? [defaultDb] : []);
    } finally {
      setDatabasesLoading(false);
      loadSchema(conn, defaultDb);
    }
  }

  // One collapsible database row in the sidebar accordion. The active database
  // (the one whose schema is loaded) shows expanded with its tree nested below
  // it; clicking its row toggles collapse. Clicking any other row switches the
  // active database and loads its schema. Shared by the rows rendered above the
  // active database's tree and the rows rendered below it.
  function renderDbRow(conn: ConnectionConfig, db: string, activeDb: string) {
    const isActive = db === activeDb;
    const expanded = isActive && !dbTreeCollapsed;
    return (
      <div
        key={db}
        onClick={() => {
          if (isActive) {
            setDbTreeCollapsed(c => !c);
            return;
          }
          updateActiveTab({ activeDatabase: db });
          setSchema(null);
          setExpandedTables(new Set());
          setExpandedSections(new Set());
          setExpandedSchemas(new Set(["public"]));
          setDbTreeCollapsed(false);
          loadSchema(conn, db);
        }}
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
          fontSize: 11, flex: 1, fontFamily: "monospace",
          color: isActive ? "var(--text)" : "var(--text-secondary)",
          fontWeight: isActive ? 600 : 400,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {db}
        </span>
      </div>
    );
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

      await invoke<boolean>("add_history_entry", {
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

  // ── Activity panel: load + kill ──────────────────────────────────────────
  // Builds the connection string for the active tab's connection (same path
  // as execute_query) and asks the C# side for currently-running queries.
  // No-op when no connection, SQLite connection, or activity panel closed.
  async function loadActivity(conn: ConnectionConfig | null, silent = false) {
    if (!conn || conn.engine === "sqlite") {
      setActivityRows([]);
      return;
    }
    if (!silent) setActivityLoading(true);
    try {
      // Same tunnel handling as runQuery — if SSH is enabled we route via
      // 127.0.0.1:<tunnelPort> with SSL disabled (the tunnel is already
      // encrypted). Passing tunnelPort:0 / a missing field to Rust trips
      // its "port must be valid" check, hence the undefined fallback.
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (!port) {
          setActivityError("SSH tunnel failed");
          setActivityRows([]);
          return;
        }
        tunnelPort = port;
      }
      const effectiveSslMode = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const connectionString = await invoke<string>("build_connection_string", {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          conn.host,
        port:          conn.port,
        database:      conn.database,
        username:      conn.username,
        sslMode:       effectiveSslMode,
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
        tunnelPort:    tunnelPort,
      });

      const raw = await invoke<string>("get_activity", {
        connectionString,
        engine: conn.engine,
      });

      const parsed = JSON.parse(raw);
      if (parsed.error) {
        setActivityError(parsed.error);
        setActivityRows([]);
      } else {
        setActivityError(null);
        setActivityRows(parsed.rows ?? []);
      }
    } catch (e) {
      setActivityError(String(e));
      setActivityRows([]);
    } finally {
      if (!silent) setActivityLoading(false);
    }
  }

  // Kill a session and immediately refresh the list. The DB enforces "you can
  // only kill your own queries" via permission checks; we surface the error
  // unchanged so the user sees the DB's own message.
  async function killActivity(row: ActivityRow) {
    const conn = activeTab.connection;
    if (!conn || conn.engine === "sqlite") return;
    try {
      // Reuse the existing tunnel for this connection if one is open.
      // openTunnel is idempotent via tunnelPortsRef cache, so this is cheap.
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (!port) {
          setActivityError("SSH tunnel failed");
          return;
        }
        tunnelPort = port;
      }
      const effectiveSslMode = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const connectionString = await invoke<string>("build_connection_string", {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          conn.host,
        port:          conn.port,
        database:      conn.database,
        username:      conn.username,
        sslMode:       effectiveSslMode,
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
        tunnelPort:    tunnelPort,
      });

      const raw = await invoke<string>("kill_session", {
        connectionString,
        engine: conn.engine,
        pid:    row.pid,
      });
      const parsed = JSON.parse(raw);
      if (parsed.error) {
        setActivityError(parsed.error);
      } else {
        setActivityError(null);
        // Refresh silently so the user sees the kill take effect immediately
        await loadActivity(conn, true);
      }
    } catch (e) {
      setActivityError(String(e));
    }
  }

  // 5-second poll: runs only when panel open, document visible, and there's
  // a non-SQLite connection. setInterval is paused (cleared) when any of
  // those conditions go false — no wasted DB connections in the background.
  useEffect(() => {
    if (!showActivity) return;
    if (!activeTab.connection) return;
    if (activeTab.connection.engine === "sqlite") return;

    let active = true;
    const tick = () => {
      if (!active) return;
      if (document.visibilityState !== "visible") return;
      // Silent refresh — don't flash a spinner every 5s
      loadActivity(activeTab.connection, true);
    };
    // Immediate load, then every 5s
    tick();
    const id = setInterval(tick, 5000);
    return () => { active = false; clearInterval(id); };
  }, [showActivity, activeTab.connection?.id]);

  // ── Command palette: item assembly + fuzzy search ──────────────────────
  //
  // Items are assembled fresh each render of the palette modal. Cheap (~1ms
  // for a typical workspace) and avoids stale references to changed state.
  //
  // Categories:
  //   command   — actions like "Format SQL", "Toggle theme", "Open settings"
  //   connection— switch active connection (rebuilds tab.connection)
  //   table     — schema entries; selecting inserts SELECT * FROM <name>
  //   tab       — jump to any open editor tab
  //   saved     — saved-query library entries; loads SQL into current tab
  //
  // The `onSelect` closure captures all state needed at click time, so
  // closing the palette and invoking the item is one statement.
  function assemblePaletteItems(): PaletteItem[] {
    const items: PaletteItem[] = [];

    // ── Commands (action verbs) ──────────────────────────────────────────
    items.push({
      id: "cmd:format",
      category: "command",
      label: "Format SQL",
      secondary: "Ctrl+Shift+F",
      onSelect: () => { formatSqlRef.current(); },
    });
    items.push({
      id: "cmd:activity",
      category: "command",
      label: showActivity ? "Hide Activity panel" : "Show Activity panel",
      secondary: "Ctrl+Shift+A",
      onSelect: () => { setShowActivity(v => !v); },
    });
    items.push({
      id: "cmd:settings",
      category: "command",
      label: "Open Settings",
      secondary: "",
      onSelect: () => { setShowSettings(true); },
    });
    items.push({
      id: "cmd:history",
      category: "command",
      label: showHistory ? "Hide query history" : "Show query history",
      secondary: "",
      onSelect: () => { setShowHistory(v => !v); },
    });
    items.push({
      id: "cmd:newtab",
      category: "command",
      label: "New query tab",
      secondary: "Cmd+T",
      onSelect: () => {
        const newTab = createTab();
        // Inherit current connection so new tab is immediately usable
        if (activeTab.connection) newTab.connection = activeTab.connection;
        setTabs(prev => [...prev, newTab]);
        setActiveTabId(newTab.id);
      },
    });
    items.push({
      id: "cmd:theme-light",
      category: "command",
      label: "Switch to Light theme",
      secondary: "",
      onSelect: () => { setThemePreference("light"); },
    });
    items.push({
      id: "cmd:theme-dark",
      category: "command",
      label: "Switch to Dark theme",
      secondary: "",
      onSelect: () => { setThemePreference("dark"); },
    });
    items.push({
      id: "cmd:theme-system",
      category: "command",
      label: "Theme: follow system",
      secondary: "",
      onSelect: () => { setThemePreference("system"); },
    });
    items.push({
      id: "cmd:theme-solarized",
      category: "command",
      label: showDiagram ? "Hide ER Diagram" : "Show ER Diagram",
      secondary: "",
      onSelect: () => {
        setShowDiagram(prev => {
          const next = !prev;
          if (next) updateActiveTab({ activeResult: -2 });
          else if (activeTab.activeResult === -2) updateActiveTab({ activeResult: 0 });
          return next;
        });
      },
    });

    // ── Connections ──────────────────────────────────────────────────────
    // Selecting a connection swaps it into the active tab. This mirrors
    // what clicking a connection in the sidebar does.
    for (const c of connections) {
      items.push({
        id: `conn:${c.id}`,
        category: "connection",
        label: c.name,
        secondary: `${c.engine} · ${c.host}`,
        onSelect: () => {
          updateActiveTab({ connection: c, title: c.name });
        },
      });
    }

    // ── Tables (from current connection's schema cache) ──────────────────
    // We only enumerate tables for the active connection — listing tables
    // from connections you'd have to switch to first would be misleading.
    // The action inserts SELECT * FROM <name> at cursor, matching what
    // clicking a table in the sidebar already does.
    if (schema && activeTab.connection) {
      for (const t of schema.tables) {
        const qualified = t.schema && t.schema !== "public" && t.schema !== "dbo"
          ? `${t.schema}.${t.name}`
          : t.name;
        items.push({
          id: `tbl:${qualified}`,
          category: "table",
          label: t.name,
          secondary: t.schema || "",
          onSelect: () => {
            const editor = editorRef.current;
            if (!editor) return;
            const sql = `SELECT * FROM ${qualified} LIMIT 100`;
            // Use Monaco's edit API so it's a single undoable op
            const sel = editor.getSelection();
            editor.executeEdits("palette-insert-table", [{
              range: sel ?? editor.getModel()!.getFullModelRange(),
              text: sql,
              forceMoveMarkers: true,
            }]);
            editor.focus();
          },
        });
      }
      // Views are first-class navigation targets too
      for (const v of schema.views) {
        const qualified = v.schema && v.schema !== "public" && v.schema !== "dbo"
          ? `${v.schema}.${v.name}`
          : v.name;
        items.push({
          id: `view:${qualified}`,
          category: "table",
          label: v.name,
          secondary: `view · ${v.schema}`,
          onSelect: () => {
            const editor = editorRef.current;
            if (!editor) return;
            const sql = `SELECT * FROM ${qualified} LIMIT 100`;
            const sel = editor.getSelection();
            editor.executeEdits("palette-insert-view", [{
              range: sel ?? editor.getModel()!.getFullModelRange(),
              text: sql,
              forceMoveMarkers: true,
            }]);
            editor.focus();
          },
        });
      }
    }

    // ── Tabs (jump to any open editor tab) ──────────────────────────────
    for (const t of tabs) {
      if (t.id === activeTabId) continue; // skip current — pointless target
      items.push({
        id: `tab:${t.id}`,
        category: "tab",
        label: t.title || "Untitled",
        secondary: t.connection?.name ?? "",
        onSelect: () => { setActiveTabId(t.id); },
      });
    }

    // ── Saved queries ────────────────────────────────────────────────────
    // Mirrors the saved-query panel: clicking loads SQL into the active tab.
    for (const q of savedQueries) {
      items.push({
        id: `saved:${q.id}`,
        category: "saved",
        label: q.meta?.name ?? "Untitled query",
        secondary: (q.meta?.tags ?? []).join(", "),
        onSelect: () => {
          editorRef.current?.setValue(q.sql);
          editorRef.current?.focus();
        },
      });
    }

    return items;
  }

  // Fuse instance is rebuilt on every render of the open palette — cheap,
  // and keeps results in sync with state changes (new tab opens, schema
  // arrives async, etc). Configured for:
  //   - Search across label (primary) and secondary fields
  //   - label weighted 2x because that's the human-readable name
  //   - threshold 0.4: tolerant of typos like "usrs" → "users" but not
  //     of unrelated words. Default 0.6 is too permissive and surfaces
  //     too much noise for a command palette.
  //   - ignoreLocation: don't penalise matches that aren't at the start;
  //     "log" should match "audit_log" as readily as "logs"
  const paletteItems = showPalette ? assemblePaletteItems() : [];
  const filteredPalette = (() => {
    if (!showPalette) return [];
    if (!paletteQuery.trim()) return [];   // empty state: show nothing
    const fuse = new Fuse(paletteItems, {
      keys: [
        { name: "label",     weight: 2 },
        { name: "secondary", weight: 1 },
      ],
      threshold: 0.4,
      ignoreLocation: true,
      minMatchCharLength: 1,
    });
    return fuse.search(paletteQuery).slice(0, 50).map(r => r.item);
  })();

  // Clamp paletteIndex so it never points off the end of the result list.
  // Without this, deleting characters can leave the cursor highlighted on
  // a row that no longer exists.
  useEffect(() => {
    if (paletteIndex >= filteredPalette.length) {
      setPaletteIndex(Math.max(0, filteredPalette.length - 1));
    }
  }, [filteredPalette.length, paletteIndex]);

  // Reset query + cursor when the palette opens or closes — opening fresh
  // should always start with an empty search, not whatever was there before.
  useEffect(() => {
    if (showPalette) {
      setPaletteQuery("");
      setPaletteIndex(0);
    }
  }, [showPalette]);

  async function exportResults(format: "csv" | "json") {
    const result = activeTab.results[activeTab.activeResult];
    if (!result || result.isMessage) return;

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

  //Get Schma Object Definition (for tables, views, procs etc)
  async function openDefinition(
    name: string,
    type: string,
    schema: string,
    conn: ConnectionConfig,
    _extra: any
  ) {
    try {
      const raw = await invoke<string>("get_object_definition", {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          conn.host,
        port:          conn.port,
        database:      conn.database,
        username:      conn.username,
        sslMode:       conn.sslMode ?? "prefer",
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
        objectName:    name,
        objectType:    type,
        schemaName:    schema || "dbo",
      });

      const parsed: { definition?: string; error?: string } = JSON.parse(raw);

      if (parsed.error) {
        updateActiveTab({ error: parsed.error });
        return;
      }

      // Save current SQL to active tab
      const currentSql = editorRef.current?.getValue() ?? "";
      const newTab = createTab();
      newTab.title      = name;
      newTab.sql        = parsed.definition ?? "";
      newTab.connection = conn;

      setTabs(prev => {
        const updated = prev.map(t =>
          t.id === activeTabId ? { ...t, sql: currentSql } : t
        );
        return [...updated, newTab];
      });

      setActiveTabId(newTab.id);
      setTimeout(() => {
        editorRef.current?.setValue(parsed.definition ?? "");
      }, 0);

    } catch (e) {
      updateActiveTab({ error: `Failed to load definition: ${String(e)}` });
    }
  }

  function handleCellEdit(rowIndex: number, colIndex: number) {
  updateActiveTab({ editingCell: { rowIndex, colIndex } });
}

function handleCellCommit(
  rowIndex: number, colIndex: number, newValue: string
) {
  const tab     = activeTabRef.current;
  const result  = tab.results[tab.activeResult];
  if (!result) return;

  const colName  = result.columns[colIndex];
  const oldValue = result.rows[rowIndex]?.[colIndex] ?? null;

  // Remove any existing edit for this cell and add the new one
  const existing = tab.pendingEdits.filter(
    e => !(e.rowIndex === rowIndex && e.colIndex === colIndex)
  );

  // If value unchanged from original — don't add to pending
  if (newValue === (oldValue ?? "")) {
    updateActiveTab({ editingCell: null, pendingEdits: existing });
    return;
  }

  updateActiveTab({
    editingCell:  null,
    pendingEdits: [...existing, {
      rowIndex, colIndex, colName,
      oldValue, newValue,
    }],
  });
}

  function handleCellCancel() {
    updateActiveTab({ editingCell: null });
  }

  async function handleCommitAll() {
    const tab    = activeTabRef.current;
    const conn   = tab.connection;
    const result = tab.results[tab.activeResult];
    if (!conn || !result || tab.pendingEdits.length === 0) return;

    // Find table info
    const sqlText  = result.sql ?? "";
    const match    = sqlText.match(/FROM\s+(?:\w+\.)*[\[\`"]?(\w+)[\]\`"]?/i);
    const tableName = match?.[1] ?? "";
    const tableInfo = schema?.tables.find(
      t => t.name.toLowerCase() === tableName.toLowerCase());

    if (!tableInfo) {
      updateActiveTab({ error: "Cannot commit — table not found in schema" });
      return;
    }

    const pkColumns = tableInfo.columns.filter(c => c.isPrimaryKey);
    if (pkColumns.length === 0) {
      updateActiveTab({ error: "Cannot commit — no primary key found" });
      return;
    }

    // Group edits by row
    const rowGroups = new Map<number, PendingEdit[]>();
    for (const edit of tab.pendingEdits) {
      const group = rowGroups.get(edit.rowIndex) ?? [];
      group.push(edit);
      rowGroups.set(edit.rowIndex, group);
    }

    // Execute one UPDATE per row
    const errors: string[] = [];
    for (const [rowIndex, edits] of rowGroups) {
      const pkValues = pkColumns.map(pk => {
        const pkColIdx = result.columns.indexOf(pk.name);
        return pkColIdx >= 0 ? result.rows[rowIndex]?.[pkColIdx] ?? null : null;
      });

      const sql = generateUpdateSql(
        tableInfo.name,
        tableInfo.schema,
        edits,
        pkColumns,
        pkValues,
        conn.engine,
      );

      try {
        const connStr = await invoke<string>("build_connection_string", {
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

        const raw = await invoke<string>("execute_query", {
          connectionString: connStr,
          sql,
          engine:   conn.engine,
          readOnly: false,
          rowLimit: settingsRef.current.resultRowLimit,
        });

        const parsed = JSON.parse(raw);
        if (parsed.results?.[0]?.error) {
          errors.push(parsed.results[0].error);
        }
      } catch (e) {
        errors.push(String(e));
      }
    }

    if (errors.length > 0) {
      updateActiveTab({ error: `Commit failed: ${errors.join("; ")}` });
      return;
    }

    // Apply edits to the result rows in state
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId) return t;
      const newResults = t.results.map((r, ri) => {
        if (ri !== t.activeResult) return r;
        const newRows = r.rows.map((row, rowIdx) => {
          const rowEdits = tab.pendingEdits.filter(
            e => e.rowIndex === rowIdx);
          if (rowEdits.length === 0) return row;
          const newRow = [...row];
          for (const edit of rowEdits) {
            newRow[edit.colIndex] = edit.newValue;
          }
          return newRow;
        });
        return { ...r, rows: newRows };
      });
      return { ...t, results: newResults, pendingEdits: [], editingCell: null };
    }));
  }

  function handleRollbackAll() {
    updateActiveTab({ pendingEdits: [], editingCell: null });
  }

  async function handleSaveQuery() {
    const sql = editorRef.current?.getValue() ?? "";
    const id  = saveQueryName.trim().toLowerCase().replace(/\s+/g, "-") || `query-${Date.now()}`;
    const now = new Date().toISOString();
    const meta = {
      name:        saveQueryName.trim() || id,
      description: saveQueryDesc.trim() || null,
      tags:        saveQueryTags.split(",").map(t => t.trim()).filter(Boolean),
      engine_hint: activeTab?.connection?.engine ?? null,
      created_at:  now,
      updated_at:  now,
    };
    await invoke("save_query", { id, sql, metaJson: JSON.stringify(meta) });
    setSaveQueryOpen(false);
    setSaveQueryName("");
    setSaveQueryTags("");
    setSaveQueryDesc("");
    loadSavedQueries(); // refresh the library panel
  }

  async function loadSavedQueries() {
    const raw = await invoke<string>("list_queries");
    setSavedQueries(JSON.parse(raw));
  }

  // Load on mount
  useEffect(() => { loadSavedQueries(); }, []);

  return (
    <div style={{
      display: "flex", height: "100vh", width: "100vw",
      background: "var(--bg)", color: "var(--text)", fontFamily: "monospace",
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
            background: "var(--lock-overlay)",
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
            color: "var(--text)",
            marginBottom: 8,
            fontFamily: "monospace",
          }}>
            DbArk is locked
          </div>
          <div style={{
            fontSize: 13,
            color: "var(--text-tertiary)",
            fontFamily: "monospace",
          }}>
            Click anywhere to unlock
          </div>
          <div style={{
            marginTop: 32,
            fontSize: 11,
            color: "var(--text-disabled)",
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
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "4px 0",
            minWidth: 160,
            boxShadow: "var(--shadow)",
          }}>
            <button
              onClick={() => {
                setEditingConnection(contextMenu.connection);
                setShowAddForm(true);
                setContextMenu(null);
              }}
              style={{
                display: "block", width: "100%", padding: "8px 16px",
                background: "none", border: "none", color: "var(--text)",
                fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
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
                background: "none", border: "none", color: "var(--error)",
                fontSize: 12, fontFamily: "monospace", cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              🗑️ Delete connection
            </button>
          </div>
        </>
      )}
      {/* END Connection Context menu */}
      {/* Schema object context menu */}
      {schemaContextMenu && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999 }}
            onClick={() => setSchemaContextMenu(null)}
          />
          <div style={{
            position: "fixed",
            left: schemaContextMenu.x,
            top: schemaContextMenu.y,
            zIndex: 1000,
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "4px 0",
            minWidth: 200,
            boxShadow: "var(--shadow)",
          }}>
            {/* Header */}
            <div style={{
              padding: "6px 16px",
              fontSize: 10, color: "var(--text-disabled)",
              fontFamily: "monospace",
              borderBottom: "1px solid var(--border)",
              marginBottom: 4,
            }}>
              {schemaContextMenu.type.toUpperCase()} · {schemaContextMenu.name}
            </div>

            {/* Open Definition — all types except index */}
            {schemaContextMenu.type !== "index" && (
              <button
                onClick={() => {
                  openDefinition(
                    schemaContextMenu.name,
                    schemaContextMenu.type,
                    schemaContextMenu.schema,
                    schemaContextMenu.connection,
                    schemaContextMenu.extra,
                  );
                  setSchemaContextMenu(null);
                }}
                style={menuItemStyle}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                📄 Open Definition
              </button>
            )}

            {/* Index — Open Definition */}
            {schemaContextMenu.type === "index" && (
              <button
                onClick={() => {
                  openDefinition(
                    schemaContextMenu.name,
                    schemaContextMenu.type,
                    schemaContextMenu.schema,
                    schemaContextMenu.connection,
                    schemaContextMenu.extra,
                  );
                  setSchemaContextMenu(null);
                }}
                style={menuItemStyle}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                📄 Open Definition
              </button>
            )}

            {/* Table-specific scripts */}
            {schemaContextMenu.type === "table" && (() => {
              const table = schema?.tables.find(
                t => t.name === schemaContextMenu.name);
              const engine = schemaContextMenu.connection.engine;
              if (!table) return null;
              return (
                <>
                  <div style={{
                    height: 1, background: "var(--surface-3)",
                    margin: "4px 0",
                  }} />
                  {(["select", "insert", "update", "delete"] as const).map(type => (
                    <button
                      key={type}
                      onClick={() => {
                        setEditorScript(scriptTable(table, type, engine));
                        setSchemaContextMenu(null);
                      }}
                      style={menuItemStyle}
                      onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                      onMouseLeave={e => (e.currentTarget.style.background = "none")}
                    >
                      ✦ Script {type.toUpperCase()}
                    </button>
                  ))}
                </>
              );
            })()}

            {/* View — quick query */}
            {schemaContextMenu.type === "view" && (
              <button
                onClick={() => {
                  const engine = schemaContextMenu.connection.engine;
                  const limit  = engine === "sqlserver"
                    ? `SELECT TOP 100 * FROM ${schemaContextMenu.name}`
                    : `SELECT * FROM ${schemaContextMenu.name} LIMIT 100`;
                  setEditorScript(limit);
                  setSchemaContextMenu(null);
                }}
                style={menuItemStyle}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                ▶ Query View
              </button>
            )}

            {/* Procedure — Script EXECUTE */}
            {schemaContextMenu.type === "procedure" && (() => {
              const proc = schema?.procedures.find(
                p => p.name === schemaContextMenu.name);
              const engine = schemaContextMenu.connection.engine;
              if (!proc) return null;
              return (
                <>
                  <div style={{ height: 1, background: "var(--surface-3)", margin: "4px 0" }} />
                  <button
                    onClick={() => {
                      setEditorScript(scriptExecute(proc, engine));
                      setSchemaContextMenu(null);
                    }}
                    style={menuItemStyle}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    ▶ Script EXECUTE
                  </button>
                </>
              );
            })()}

            {/* Drop and Create — tables, procedures, functions, views */}
            {["table", "procedure", "function", "view"].includes(
              schemaContextMenu.type) && (
              <button
                onClick={async () => {
                  await scriptDropAndCreate(
                    schemaContextMenu.name,
                    schemaContextMenu.type,
                    schemaContextMenu.schema,
                    schemaContextMenu.connection,
                    schemaContextMenu.extra,
                  );
                  setSchemaContextMenu(null);
                }}
                style={menuItemStyle}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                ⬇ Script DROP and CREATE
              </button>
            )}

            {/* Script CREATE OR ALTER — procedures, functions, views, triggers */}
            {["procedure", "function", "view", "trigger"].includes(
              schemaContextMenu.type) && (
              <button
                onClick={async () => {
                  const conn = schemaContextMenu.connection;
                  const raw  = await invoke<string>("get_object_definition", {
                    credentialRef: conn.credentialRef,
                    engine:        conn.engine,
                    host:          conn.host,
                    port:          conn.port,
                    database:      conn.database,
                    username:      conn.username,
                    sslMode:       conn.sslMode ?? "prefer",
                    sqlInstance:   conn.sqlInstance ?? "",
                    windowsAuth:   conn.windowsAuth ?? false,
                    objectName:    schemaContextMenu.name,
                    objectType:    schemaContextMenu.type,
                    schemaName:    schemaContextMenu.schema || "dbo",
                  });

                  const parsed: { definition?: string; error?: string } =
                    JSON.parse(raw);
                  if (parsed.error) {
                    updateActiveTab({ error: parsed.error });
                    setSchemaContextMenu(null);
                    return;
                  }

                  // Pre-apply idempotent rewrite
                  let definition = parsed.definition ?? "";
                  if (conn.engine === "sqlserver") {
                    definition = definition.replace(
                      /CREATE\s+(PROCEDURE|FUNCTION|VIEW|TRIGGER)/gi,
                      "CREATE OR ALTER $1"
                    );
                  } else {
                    definition = definition.replace(
                      /CREATE\s+(PROCEDURE|FUNCTION|VIEW)/gi,
                      "CREATE OR REPLACE $1"
                    );
                  }

                  const currentSql = editorRef.current?.getValue() ?? "";
                  const newTab     = createTab();
                  newTab.title     = schemaContextMenu.name;
                  newTab.sql       = definition;
                  newTab.connection = conn;

                  setTabs(prev => {
                    const updated = prev.map(t =>
                      t.id === activeTabId ? { ...t, sql: currentSql } : t
                    );
                    return [...updated, newTab];
                  });
                  setActiveTabId(newTab.id);
                  setTimeout(() => editorRef.current?.setValue(definition), 0);
                  setSchemaContextMenu(null);
                }}
                style={menuItemStyle}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                ✦ Script CREATE OR ALTER
              </button>
            )}

            {/* Drop — all types */}
            <div style={{ height: 1, background: "var(--surface-3)", margin: "4px 0" }} />
            <button
              onClick={() => {
                const dropSql = buildDropSql(
                  schemaContextMenu.connection.engine,
                  schemaContextMenu.type,
                  schemaContextMenu.name,
                  schemaContextMenu.schema,
                  schemaContextMenu.extra?.tableName ?? "",
                );
                setDropConfirm({
                  name:      schemaContextMenu.name,
                  type:      schemaContextMenu.type,
                  schema:    schemaContextMenu.schema,
                  tableName: schemaContextMenu.extra?.tableName ?? "",
                  dropSql,
                  connection: schemaContextMenu.connection,
                });
                setSchemaContextMenu(null);
              }}
              style={{ ...menuItemStyle, color: "var(--error)" }}
              onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
              onMouseLeave={e => (e.currentTarget.style.background = "none")}
            >
              🗑️ Drop {schemaContextMenu.type}
            </button>
          </div>
        </>
      )}
      {/* END Schema object context menu */}
      {/* Delete confirmation */}
      {deletingConnection && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.6)" }}
            onClick={() => setDeletingConnection(null)} />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", minWidth: 340,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              Delete connection
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 20, lineHeight: 1.6 }}>
              Delete <strong style={{ color: "var(--text)" }}>{deletingConnection.name}</strong>?
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
                  flex: 1, padding: "8px 0", background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6, cursor: "pointer",
                  fontSize: 12, fontFamily: "monospace",
                }}
              >
                Delete
              </button>
              <button
                onClick={() => setDeletingConnection(null)}
                style={{
                  flex: 1, padding: "8px 0", background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
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
      {/* Drop object confirmation */}
      {dropConfirm && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999,
              background: "rgba(0,0,0,0.6)" }}
            onClick={() => setDropConfirm(null)}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", minWidth: 380, maxWidth: 520,
            boxShadow: "var(--shadow-lg)",
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center",
              gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                Drop {dropConfirm.type}
              </div>
            </div>

            {/* Warning text */}
            <div style={{ fontSize: 12, color: "var(--text-secondary)",
              marginBottom: 16, lineHeight: 1.6 }}>
              This will permanently drop{" "}
              <strong style={{ color: "var(--text)" }}>
                {dropConfirm.name}
              </strong>.
              This action cannot be undone.
            </div>

            {/* SQL preview */}
            <div style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 20,
              fontFamily: "monospace",
              fontSize: 12,
              color: "var(--error)",
            }}>
              {dropConfirm.dropSql}
            </div>

            {/* Buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    const conn = dropConfirm.connection;
                    await invoke("drop_object", {
                      credentialRef: conn.credentialRef,
                      engine:        conn.engine,
                      host:          conn.host,
                      port:          conn.port,
                      database:      conn.database,
                      username:      conn.username,
                      sslMode:       conn.sslMode ?? "prefer",
                      sqlInstance:   conn.sqlInstance ?? "",
                      windowsAuth:   conn.windowsAuth ?? false,
                      objectName:    dropConfirm.name,
                      objectType:    dropConfirm.type,
                      schemaName:    dropConfirm.schema,
                      tableName:     dropConfirm.tableName,
                    });

                    // Invalidate schema cache and reload
                    purgeSchemaCache(conn.id);
                    schemaConnectionId.current = null;
                    setSchema(null);
                    setExpandedTables(new Set());
                    setExpandedSections(new Set());
                    loadSchema(conn, activeTabRef.current.activeDatabase ?? conn.database);

                    setDropConfirm(null);
                  } catch (e) {
                    // Show error in results area
                    updateActiveTab({ error: `Drop failed: ${String(e)}` });
                    setDropConfirm(null);
                  }
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace", fontWeight: 600,
                }}
              >
                Drop {dropConfirm.type}
              </button>
              <button
                onClick={() => setDropConfirm(null)}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
      {/* END Drop object confirmation */}
      {/* Kill session confirmation — uses the same shell as Drop object.
          Destructive action, must be confirmed; runs through killActivity()
          which surfaces DB-level permission errors back to the user. */}
      {killPending && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999,
              background: "rgba(0,0,0,0.6)" }}
            onClick={() => setKillPending(null)}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", minWidth: 380, maxWidth: 520,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ display: "flex", alignItems: "center",
              gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                Kill session
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)",
              marginBottom: 16, lineHeight: 1.6 }}>
              This will cancel session{" "}
              <strong style={{ color: "var(--text)" }}>#{killPending.pid}</strong>
              {killPending.user && <> running as <strong style={{ color: "var(--text)" }}>{killPending.user}</strong></>}.
              {" "}The query in progress will be interrupted.
            </div>
            {killPending.query && (
              <div style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "10px 14px",
                marginBottom: 20,
                fontFamily: "monospace",
                fontSize: 11,
                color: "var(--text)",
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {killPending.query}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  const target = killPending;
                  setKillPending(null);
                  if (target) await killActivity(target);
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace", fontWeight: 600,
                }}
              >
                Kill session
              </button>
              <button
                onClick={() => setKillPending(null)}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
      )}
      {/* END Kill session confirmation */}

      {/* Command palette — Ctrl+P / Cmd+P
          Positioned ~120px from top (not center) so results stay visible
          even as the list grows. 540px width matches VS Code's palette.
          Escape closes. Up/Down navigates. Enter activates.
          Click outside (overlay) closes. */}
      {showPalette && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999,
              background: "rgba(0,0,0,0.4)" }}
            onClick={() => setShowPalette(false)}
          />
          <div style={{
            position: "fixed", top: 120, left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 10,
            width: 540, maxHeight: "60vh",
            boxShadow: "var(--shadow-lg)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}>
            {/* Search input */}
            <input
              autoFocus
              type="text"
              value={paletteQuery}
              onChange={e => { setPaletteQuery(e.target.value); setPaletteIndex(0); }}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowPalette(false);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIndex(i => Math.min(i + 1, filteredPalette.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIndex(i => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const item = filteredPalette[paletteIndex];
                  if (item) {
                    setShowPalette(false);
                    // Defer the action to next tick so the modal can unmount
                    // before the action mutates state that the modal touched
                    // (e.g. setActiveTabId, which would otherwise re-render
                    // the modal mid-close).
                    setTimeout(() => item.onSelect(), 0);
                  }
                }
              }}
              placeholder="Type to search connections, tables, tabs, commands…"
              style={{
                background: "transparent",
                border: "none",
                borderBottom: filteredPalette.length > 0
                  ? "1px solid var(--border)"
                  : "1px solid transparent",
                color: "var(--text)",
                fontSize: 14,
                fontFamily: "monospace",
                padding: "14px 18px",
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />

            {/* Results list — scrollable. Empty until user types something. */}
            {filteredPalette.length > 0 && (
              <div style={{
                flex: 1,
                overflow: "auto",
                padding: "4px 0",
              }}>
                {filteredPalette.map((item, i) => (
                  <div
                    key={item.id}
                    ref={el => {
                      // Auto-scroll the highlighted row into view when
                      // navigating with arrow keys past the visible region.
                      if (i === paletteIndex && el) {
                        el.scrollIntoView({ block: "nearest" });
                      }
                    }}
                    onMouseEnter={() => setPaletteIndex(i)}
                    onClick={() => {
                      setShowPalette(false);
                      setTimeout(() => item.onSelect(), 0);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 18px",
                      cursor: "pointer",
                      background: i === paletteIndex
                        ? "var(--accent-bg)"
                        : "transparent",
                      borderLeft: i === paletteIndex
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                    }}
                  >
                    {/* Category icon — small, monospace, low contrast */}
                    <span style={{
                      fontSize: 11,
                      width: 14,
                      textAlign: "center",
                      color: "var(--text-tertiary)",
                      flexShrink: 0,
                    }}>
                      {item.category === "command"    ? "▸" :
                       item.category === "connection" ? "◉" :
                       item.category === "table"      ? "⊞" :
                       item.category === "tab"        ? "❏" :
                                                        "★"}
                    </span>
                    {/* Primary label */}
                    <span style={{
                      flex: 1,
                      fontSize: 13,
                      fontFamily: "monospace",
                      color: i === paletteIndex
                        ? "var(--text)"
                        : "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {item.label}
                    </span>
                    {/* Secondary — schema, host, keybinding hint, etc */}
                    {item.secondary && (
                      <span style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        color: "var(--text-disabled)",
                        flexShrink: 0,
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {item.secondary}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Footer hint line — only when results exist */}
            {filteredPalette.length > 0 && (
              <div style={{
                padding: "6px 18px",
                borderTop: "1px solid var(--border)",
                fontSize: 10,
                fontFamily: "monospace",
                color: "var(--text-disabled)",
                display: "flex",
                gap: 16,
                flexShrink: 0,
              }}>
                <span>↑↓ navigate</span>
                <span>↵ select</span>
                <span>esc close</span>
              </div>
            )}
          </div>
        </>
      )}
      {/* END Command palette */}
      {/* Settings modal */}
      {showSettings && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999,
              background: "rgba(0,0,0,0.6)" }}
            onClick={() => setShowSettings(false)}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "0", width: 480, maxHeight: "80vh",
            boxShadow: "var(--shadow-lg)",
            display: "flex", flexDirection: "column",
          }}>

            {/* Header */}
            <div style={{
              padding: "16px 24px",
              borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center",
              justifyContent: "space-between", flexShrink: 0,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                ⚙ Settings
              </div>
              <button
                onClick={() => setShowSettings(false)}
                style={{ background: "none", border: "none",
                  color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>

              {/* Section: Query */}
              <SettingsSection label="Query">
                <SettingsRow
                  label="Query timeout"
                  description="Maximum time a query can run before being cancelled"
                >
                  <select
                    value={settingsDraft.queryTimeoutSecs}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, queryTimeoutSecs: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    {[5, 15, 30, 60, 120, 300].map(v => (
                      <option key={v} value={v}>{v}s</option>
                    ))}
                  </select>
                </SettingsRow>

                <SettingsRow
                  label="Result row limit"
                  description="Maximum rows returned per query — use WHERE to filter large sets"
                >
                  <select
                    value={settingsDraft.resultRowLimit}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, resultRowLimit: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    {[50000, 250000, 5000000, 0].map(v => (
                      <option key={v} value={v}>
                        {v === 0 ? "Unlimited" : `${v.toLocaleString()} rows`}
                      </option>
                    ))}
                  </select>
                </SettingsRow>

                <SettingsRow
                  label="Result auto-clear"
                  description="Automatically clear results after this period of inactivity"
                >
                  <select
                    value={settingsDraft.resultClearMins}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, resultClearMins: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    <option value={1}>1 min</option>
                    <option value={5}>5 min</option>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={0}>Never</option>
                  </select>
                </SettingsRow>
              </SettingsSection>

              {/* Section: Security */}
              <SettingsSection label="Security">
                <SettingsRow
                  label="Inactivity lock"
                  description="Lock the app after this period of inactivity"
                >
                  <select
                    value={settingsDraft.lockTimeoutMins}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, lockTimeoutMins: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    <option value={1}>1 min</option>
                    <option value={5}>5 min</option>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={60}>60 min</option>
                    <option value={120}>2 hours</option>
                    <option value={0}>Disabled</option>
                  </select>
                </SettingsRow>

                <SettingsRow
                  label="Clipboard auto-clear"
                  description="Clear clipboard after copying a cell value"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={settingsDraft.clipboardClearEnabled}
                      onChange={e => setSettingsDraft(s => ({
                        ...s, clipboardClearEnabled: e.target.checked
                      }))}
                      style={{ width: 14, height: 14, cursor: "pointer" }}
                    />
                    {settingsDraft.clipboardClearEnabled && (
                      <select
                        value={settingsDraft.clipboardClearSecs}
                        onChange={e => setSettingsDraft(s => ({
                          ...s, clipboardClearSecs: Number(e.target.value)
                        }))}
                        style={selectStyle}
                      >
                        <option value={30}>after 30s</option>
                        <option value={60}>after 60s</option>
                        <option value={120}>after 2 min</option>
                        <option value={300}>after 5 min</option>
                      </select>
                    )}
                  </div>
                </SettingsRow>

                <SettingsRow
                  label="Audit log"
                  description="Append every executed query to ~/.dbark/audit.log"
                >
                  <input
                    type="checkbox"
                    checked={settingsDraft.auditLogEnabled}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, auditLogEnabled: e.target.checked
                    }))}
                    style={{ width: 14, height: 14, cursor: "pointer" }}
                  />
                </SettingsRow>
              </SettingsSection>

              {/* Section: History */}
              <SettingsSection label="History">
                <SettingsRow
                  label="Query history retention"
                  description="How long to keep query history entries"
                >
                  <select
                    value={settingsDraft.historyRetentionDays}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, historyRetentionDays: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={365}>1 year</option>
                    <option value={0}>Forever</option>
                  </select>
                </SettingsRow>
              </SettingsSection>

              {/* Section: Appearance */}
              {/* Theme applies immediately on change rather than waiting for
                  Save — matches user expectation for visual preferences. */}
              <SettingsSection label="Appearance">
                <SettingsRow
                  label="Theme"
                  description="System follows your OS; choose Light or Dark to override"
                >
                  <select
                    value={themePreference}
                    onChange={e => setThemePreference(e.target.value as ThemePreference)}
                    style={selectStyle}
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </SettingsRow>
              </SettingsSection>
            </div>
            {/* Footer */}
            <div style={{
              padding: "12px 24px",
              borderTop: "1px solid var(--border)",
              display: "flex", gap: 8, flexShrink: 0,
            }}>
              <button
                onClick={async () => {
                  try {
                    // Map camelCase back to snake_case for Rust
                    const toSave = {
                      query_timeout_secs:      settingsDraft.queryTimeoutSecs,
                      lock_timeout_mins:       settingsDraft.lockTimeoutMins,
                      result_row_limit:        settingsDraft.resultRowLimit,
                      history_retention_days:  settingsDraft.historyRetentionDays,
                      result_clear_mins:       settingsDraft.resultClearMins,
                      audit_log_enabled:       settingsDraft.auditLogEnabled,
                      clipboard_clear_enabled: settingsDraft.clipboardClearEnabled,
                      clipboard_clear_secs:    settingsDraft.clipboardClearSecs,
                    };
                    await invoke("save_settings", {
                      settingsJson: JSON.stringify(toSave)
                    });
                    setSettings(settingsDraft);
                    setAuditLogEnabled(settingsDraft.auditLogEnabled);
                    setShowSettings(false);
                  } catch (e) {
                    console.error("Failed to save settings:", e);
                  }
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--accent)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                Save
              </button>
              <button
                onClick={() => setShowSettings(false)}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => setSettingsDraft(DEFAULT_SETTINGS)}
                style={{
                  padding: "8px 14px",
                  background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                Reset defaults
              </button>
            </div>
          </div>
        </>
      )}
      {/* END Settings Modal */}
      {/* Begin Save Query Modal */}
        {saveQueryOpen && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}>
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 24, width: 380,
          }}>
            <div style={{ color: "var(--text)", fontWeight: 600, marginBottom: 16 }}>
              Save Query
            </div>
            <input
              autoFocus
              placeholder="Query name"
              value={saveQueryName}
              onChange={e => setSaveQueryName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSaveQuery(); if (e.key === "Escape") setSaveQueryOpen(false); }}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Tags (comma-separated, optional)"
              value={saveQueryTags}
              onChange={e => setSaveQueryTags(e.target.value)}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Description (optional)"
              value={saveQueryDesc}
              onChange={e => setSaveQueryDesc(e.target.value)}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 16, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setSaveQueryOpen(false)}
                style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={handleSaveQuery}
                style={{ padding: "6px 14px", background: "var(--accent-hover)", border: "none", borderRadius: 4, color: "white", cursor: "pointer" }}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
      {/* END Save Query Modal */}
      {/*Begin DBeaver Import Modal */}
        {showDbeaverImport && (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.6)" }}
            onClick={() => { setShowDbeaverImport(false); setDbeaverResult(null); }}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", width: 440,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              Import from DBeaver
            </div>

            {!dbeaverResult && (
              <>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 20, lineHeight: 1.6 }}>
                  Reads <code style={{ color: "var(--text-secondary)" }}>~/.dbeaver/data-sources.json</code> and
                  imports all PostgreSQL, MySQL, SQLite, and SQL Server connections into DbArk.
                  Passwords are moved to the OS keychain.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleDbeaverImport}
                    disabled={dbeaverImporting}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: "var(--accent)", color: "white",
                      border: "none", borderRadius: 6,
                      cursor: dbeaverImporting ? "not-allowed" : "pointer",
                      fontSize: 12, fontFamily: "monospace",
                    }}
                  >
                    {dbeaverImporting ? "Importing…" : "Import connections"}
                  </button>
                  <button
                    onClick={() => setShowDbeaverImport(false)}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: "transparent", color: "var(--text-tertiary)",
                      border: "1px solid var(--border)", borderRadius: 6,
                      cursor: "pointer", fontSize: 12, fontFamily: "monospace",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {dbeaverResult && (
              <>
                {dbeaverResult.error && (
                  <div style={{
                    padding: "10px 14px", borderRadius: 6, marginBottom: 16,
                    background: "var(--error-bg)", border: "1px solid var(--error)",
                    color: "var(--error)", fontSize: 12, fontFamily: "monospace",
                  }}>
                    ❌ {dbeaverResult.error}
                  </div>
                )}

                {dbeaverResult.imported.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--success)", marginBottom: 8, fontFamily: "monospace" }}>
                      ✓ {dbeaverResult.imported.length} connection{dbeaverResult.imported.length > 1 ? "s" : ""} imported
                    </div>
                    {dbeaverResult.imported.map(c => (
                      <div key={c.name} style={{
                        fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace",
                        padding: "2px 0",
                      }}>
                        · {c.name} ({c.engine} · {c.host})
                      </div>
                    ))}
                  </div>
                )}

                {dbeaverResult.skipped.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--warning)", marginBottom: 8, fontFamily: "monospace" }}>
                      ⚠ {dbeaverResult.skipped.length} skipped
                    </div>
                    {dbeaverResult.skipped.map(s => (
                      <div key={s} style={{
                        fontSize: 11, color: "var(--text-disabled)", fontFamily: "monospace",
                        padding: "2px 0",
                      }}>
                        · {s}
                      </div>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => { setShowDbeaverImport(false); setDbeaverResult(null); }}
                  style={{
                    width: "100%", padding: "8px 0",
                    background: "transparent", color: "var(--text-tertiary)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    cursor: "pointer", fontSize: 12, fontFamily: "monospace",
                  }}
                >
                  Close
                </button>
              </>
            )}
          </div>
        </>
      )}
      {/* END DBeaver Import Modal */}
      {/* Sidebar */}
      <div style={{
        width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth,
        background: "var(--surface)", borderRight: "1px solid var(--border)",
        display: "flex", flexDirection: "column", overflow: "hidden", flexShrink: 0,
      }}>
        {/* Sidebar header */}
        <div style={{
          padding: "12px 14px", borderBottom: "1px solid var(--border)",
          display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
        }}>
          <span style={{ color: "var(--accent)", fontWeight: 700, fontSize: 14, letterSpacing: ".02em" }}>DbArk</span>
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
            {showQueryLibrary && (
            <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8, marginBottom: 8 }}>
              <input
                placeholder="Search queries..."
                value={querySearch}
                onChange={e => setQuerySearch(e.target.value)}
                style={{
                  width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                  borderRadius: 4, padding: "4px 8px", color: "var(--text)",
                  fontSize: 12, boxSizing: "border-box", marginBottom: 6,
                }}
              />
              {savedQueries
                .filter(q => {
                  const s = querySearch.toLowerCase();
                  return !s
                    || q.meta.name.toLowerCase().includes(s)
                    || (q.meta.tags ?? []).some((t: string) => t.toLowerCase().includes(s));
                })
                .map(q => (
                  <div key={q.id}
                    style={{
                      padding: "5px 8px", borderRadius: 4, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    onClick={() => {
                      editorRef.current?.setValue(q.sql);
                      editorRef.current?.focus();
                    }}
                  >
                    <div>
                      <div style={{ color: "var(--text)", fontSize: 12 }}>{q.meta.name}</div>
                      {q.meta.tags?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
                          {q.meta.tags.map((t: string) => (
                            <span key={t} style={{
                              fontSize: 10, background: "var(--accent-bg)",
                              color: "var(--accent-hover)", borderRadius: 3, padding: "1px 5px",
                            }}>{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        invoke("delete_query", { id: q.id }).then(loadSavedQueries);
                      }}
                      style={{
                        background: "transparent", border: "none",
                        color: "var(--text-disabled)", cursor: "pointer", fontSize: 14, padding: 2,
                      }}
                      title="Delete query"
                    >✕</button>
                  </div>
                ))}
              {savedQueries.length === 0 && (
                <div style={{ color: "var(--text-disabled)", fontSize: 11, padding: "4px 8px" }}>
                  No saved queries. Press Cmd+S to save.
                </div>
              )}
            </div>
          )}
            {/* Connections section label */}
            <div style={{ padding: "8px 14px 4px", borderBottom: "1px solid var(--border)", fontSize: 10, fontWeight: 600, color: "var(--text-disabled)", textTransform: "uppercase", letterSpacing: ".06em" }}>
              Connections &nbsp;&nbsp;
              <button onClick={() => setShowAddForm(v => !v)} title="Add connection" style={{
                  background: "none", border: "1px solid var(--border)", borderRadius: 4,
                  color: "var(--text-secondary)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 7px", flexShrink: 0,
                }}>
                  {showAddForm ? "×" : "+"}
              </button>
              <button
                onClick={() => setShowQueryLibrary(v => !v)}
                title="Saved queries"
                style={{
                  background: showQueryLibrary ? "var(--accent-bg)" : "transparent",
                  border: "none", color: "var(--text-secondary)", cursor: "pointer",
                  padding: "2px 6px", borderRadius: 4, fontSize: 14,
                }}
              >
                📋
              </button>
              <button
                onClick={() => setShowDbeaverImport(true)}
                title="Import from DBeaver"
                style={{
                  background: "none", border: "1px solid var(--border)", borderRadius: 4,
                  color: "var(--text-secondary)", cursor: "pointer", fontSize: 11,
                  lineHeight: 1, padding: "2px 7px", flexShrink: 0,
                  fontFamily: "monospace",
                }}
              >
                ↓ DBeaver
              </button>
            </div>

            {connections.length === 0 ? (
              <div style={{ padding: "6px 14px 10px", color: "var(--text-disabled)", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
                No connections yet.<br />Click + to add one.
              </div>
            ) : (groupedConnections.map(([groupKey, groupConns]) => {
          const isUngrouped = groupKey === "__ungrouped__";
          const collapsed   = collapsedGroups.has(groupKey);
          const groupLabel  = isUngrouped ? null : groupKey;

          return (
            <div key={groupKey}>
              {/* Group header — only show if named group */}
             {groupLabel && (
              <div
                onClick={() => toggleGroup(groupKey)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "5px 14px",
                  cursor: "pointer",
                  borderBottom: "1px solid var(--border)",
                  borderTop: "1px solid var(--border)",
                  background: "var(--surface)",
                  userSelect: "none",
                }}
                onMouseEnter={e =>
                  (e.currentTarget.style.background = "var(--surface)")}
                onMouseLeave={e =>
                  (e.currentTarget.style.background = "var(--surface)")}
              >
                <span style={{
                  fontSize: 8, color: "var(--text-disabled)",
                  flexShrink: 0, width: 10,
                }}>
                  {collapsed ? "▸" : "▾"}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: "var(--accent)",                       // ← accent color instead of var(--text-disabled)
                  flex: 1,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                  fontFamily: "monospace",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {groupLabel}
                </span>
                <span style={{
                  fontSize: 9, color: "var(--text-disabled)",
                  fontFamily: "monospace", flexShrink: 0,
                }}>
                  {groupConns.length}
                </span>
              </div>
            )}

              {/* Connection rows — hidden when group is collapsed */}
              {!collapsed && groupConns.map((conn) => (
                <div key={conn.id}>
                  {/* Connection row — indent if in a named group */}
                  <div
                    onClick={() => {
                      schemaConnectionId.current = conn.id;
                      updateActiveTab({
                        connection: conn,
                        file:       null,
                        title:      conn.name,
                        joinTables: [],
                        results:    [],
                        activeResult: 0,
                        error:      null,
                        activeDatabase: conn.database,
                      });
                      setSchema(null);
                      setExpandedTables(new Set());
                      setExpandedSections(new Set());
                      setDbFilter("");
                      setDbTreeCollapsed(false);
                      loadDatabases(conn, conn.database);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        x: e.clientX, y: e.clientY,
                        connection: conn,
                      });
                    }}
                    style={{
                      padding: "9px 14px",
                      paddingLeft: groupLabel ? 22 : 14,
                      cursor: "pointer",
                      borderBottom: "1px solid var(--surface-3)",
                      borderLeft: `3px solid ${
                        activeTab.connection?.id === conn.id
                          ? conn.color
                          : "transparent"
                      }`,
                      background: activeTab.connection?.id === conn.id
                        ? "var(--surface-3)"
                        : "transparent",
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

                  {/* Schema tree — only shown for the active connection */}
                  {activeTab.connection?.id === conn.id && (
                    <div style={{ background: "var(--bg)", borderBottom: "1px solid var(--border)" }}>
                      {/* Database list — every database on this connection's
                          server. SQLite has none (single file), so this block
                          is skipped and the schema renders directly below.
                          Selecting a database loads its schema and points
                          query execution at it. */}
                      {databasesLoading && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-disabled)", fontFamily: "monospace" }}>
                          Loading databases…
                        </div>
                      )}
                      {conn.engine !== "sqlite" && databases.length > 0 && (() => {
                        const activeDb = activeTab.activeDatabase ?? conn.database;
                        const q = dbFilter.trim().toLowerCase();
                        const filtered = q
                          ? databases.filter(d => d.toLowerCase().includes(q))
                          : databases;
                        // The filter input appears once a server has enough
                        // databases that scanning becomes slower than typing.
                        const showFilter = databases.length > 6;
                        // Rows up to and including the active database render
                        // here; the active database's schema tree renders right
                        // after them (next sibling), and the remaining database
                        // rows render below the tree. That positioning is what
                        // makes the active database expand *inline* with its
                        // tables nested beneath it, accordion-style.
                        const activeIndex = filtered.indexOf(activeDb);
                        const firstSegment = activeIndex >= 0
                          ? filtered.slice(0, activeIndex + 1)
                          : filtered;
                        return (
                          <div>
                            <div style={{
                              display: "flex", alignItems: "center", gap: 6,
                              padding: "6px 14px 4px",
                            }}>
                              <span style={{
                                fontSize: 9, color: "var(--text-tertiary)",
                                fontFamily: "monospace", textTransform: "uppercase",
                                letterSpacing: ".06em", flex: 1,
                              }}>
                                Databases
                              </span>
                              <span style={{
                                fontSize: 9, color: "var(--text-disabled)",
                                fontFamily: "monospace", flexShrink: 0,
                              }}>
                                {q ? `${filtered.length}/${databases.length}` : databases.length}
                              </span>
                            </div>

                            {showFilter && (
                              <div style={{
                                display: "flex", alignItems: "center", gap: 6,
                                margin: "0 10px 6px", padding: "4px 8px",
                                border: "1px solid var(--border)", borderRadius: 5,
                                background: "var(--bg)",
                              }}>
                                <span style={{ fontSize: 10, color: "var(--text-disabled)", flexShrink: 0 }}>⌕</span>
                                <input
                                  value={dbFilter}
                                  onChange={(e) => setDbFilter(e.target.value)}
                                  placeholder="Filter databases…"
                                  spellCheck={false}
                                  style={{
                                    border: "none", outline: "none", background: "transparent",
                                    flex: 1, fontSize: 11, fontFamily: "monospace",
                                    color: "var(--text)", padding: 0,
                                  }}
                                />
                                {dbFilter && (
                                  <span
                                    onClick={() => setDbFilter("")}
                                    title="Clear filter"
                                    style={{ fontSize: 10, color: "var(--text-disabled)", cursor: "pointer", flexShrink: 0 }}
                                  >✕</span>
                                )}
                              </div>
                            )}

                            {filtered.length === 0 && (
                              <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--text-disabled)", fontFamily: "monospace" }}>
                                No databases match “{dbFilter}”
                              </div>
                            )}
                            {firstSegment.map(db => renderDbRow(conn, db, activeDb))}
                          </div>
                        );
                      })()}

                      {/* Active database's schema tree — renders inline right
                          beneath the active database row (its previous sibling),
                          indented so the tables read as nested under it. Hidden
                          when the database is collapsed or filtered out of view. */}
                      {(() => {
                        const hasDbLayer = conn.engine !== "sqlite" && databases.length > 0;
                        if (hasDbLayer) {
                          const fq = dbFilter.trim().toLowerCase();
                          const activeDbName = activeTab.activeDatabase ?? conn.database;
                          const activeVisible = !fq || activeDbName.toLowerCase().includes(fq);
                          // Collapsed, or the active database is filtered out of
                          // the list above — either way, show no tree.
                          if (dbTreeCollapsed || !activeVisible) return null;
                        }
                        return (
                      <div style={{
                        borderLeft: hasDbLayer ? "2px solid var(--border)" : "none",
                        marginLeft: hasDbLayer ? 8 : 0,
                      }}>

                      {schemaLoading && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-disabled)", fontFamily: "monospace" }}>
                          Loading schema…
                        </div>
                      )}

                      {schema?.error && !(conn.sshEnabled && !tunnelPorts[conn.id]) && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--error)", fontFamily: "monospace" }}>
                          {schema.error}
                        </div>
                      )}
                      {schema?.error && conn.sshEnabled && !tunnelPorts[conn.id] && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--warning)", fontFamily: "monospace" }}>
                          ⚠ Run a query to open the SSH tunnel, then schema will load
                        </div>
                      )}

                      {schema && !schema.error && (() => {
                        const safeSchema = {
                          tables:     schema.tables     ?? [],
                          procedures: schema.procedures ?? [],
                          functions:  schema.functions  ?? [],
                          views:      schema.views      ?? [],
                          triggers:   schema.triggers   ?? [],
                          indexes:    schema.indexes    ?? [],
                        };
                        return (
                        <>
                          {/* Schema toolbar — Refresh + Diagram */}
                          <div style={{ padding: "5px 14px 3px", display: "flex", justifyContent: "flex-end", gap: 6 }}>
                            {safeSchema.tables.length > 0 && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  // Only switch this connection's schema into view if it isn't already
                                  if (activeTab.connection?.id !== conn.id) {
                                    updateActiveTab({
                                      connection: conn,
                                      file:       null,
                                      title:      conn.name,
                                      joinTables: [],
                                      results:    [],
                                      activeResult: 0,
                                      error:      null,
                                    });
                                  }
                                  setShowDiagram(true);
                                  updateActiveTab({ activeResult: -2 });
                                }}
                                style={{
                                  background: "none",
                                  border: "1px solid var(--border)",
                                  borderRadius: 4,
                                  color: showDiagram && activeTab.connection?.id === conn.id
                                    ? "var(--accent)"
                                    : "var(--text-disabled)",
                                  cursor: "pointer", fontSize: 10, fontFamily: "monospace",
                                  padding: "2px 8px",
                                }}
                                title="Show ER diagram"
                              >
                                ⊞ diagram
                              </button>
                            )}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                const db = activeTab.activeDatabase ?? conn.database;
                                schemaCache.current.delete(`${conn.id}::${db}`);
                                loadSchema(conn, db);
                              }}
                              style={{ background: "none", border: "none", color: "var(--text-disabled)",
                                cursor: "pointer", fontSize: 10, fontFamily: "monospace", padding: "2px 4px" }}
                              title="Refresh schema"
                            >
                              ↻ refresh
                            </button>
                          </div>
                          {/* Tables section */}
                          <SchemaSection
                            label="Tables"
                            icon="▤"
                            count={safeSchema.tables.length}
                            sectionKey={`${conn.id}-tables`}
                            expanded={expandedSections.has(`${conn.id}-tables`)}
                            onToggle={() => toggleSection(`${conn.id}-tables`)}
                          >
                            {(conn.engine === "postgres" || conn.engine === "cockroachdb") && tablesBySchema.size > 1
                              ? // Postgres/CockroachDB with multiple schemas — show schema grouping
                                [...tablesBySchema.entries()].map(([schemaName, tables]) => (
                                  <div key={schemaName}>
                                    {/* Schema header */}
                                    <div
                                      onClick={() => {
                                        setExpandedSchemas(prev => {
                                          const next = new Set(prev);
                                          next.has(schemaName)
                                            ? next.delete(schemaName)
                                            : next.add(schemaName);
                                          return next;
                                        });
                                      }}
                                      style={{
                                        display: "flex", alignItems: "center", gap: 6,
                                        padding: "5px 14px",
                                        cursor: "pointer",
                                        borderTop: "1px solid var(--border)",
                                        background: "var(--bg)",
                                      }}
                                      onMouseEnter={e =>
                                        (e.currentTarget.style.background = "var(--bg)")}
                                      onMouseLeave={e =>
                                        (e.currentTarget.style.background = "var(--bg)")}
                                    >
                                      <span style={{
                                        fontSize: 9, color: "var(--accent)",
                                        flexShrink: 0, width: 10,
                                      }}>
                                        {expandedSchemas.has(schemaName) ? "▾" : "▸"}
                                      </span>
                                      <span style={{
                                        fontSize: 10, color: "var(--accent)",
                                        fontFamily: "monospace", flex: 1,
                                        fontWeight: 600, letterSpacing: ".03em",
                                      }}>
                                        {schemaName}
                                      </span>
                                      <span style={{
                                        fontSize: 9, color: "var(--text-disabled)",
                                        fontFamily: "monospace", flexShrink: 0,
                                      }}>
                                        {tables.length}
                                      </span>
                                    </div>

                                    {/* Schema sidebar toolbar — Diagram toggle */}
                                    {schema && schema.tables.length > 0 && (
                                      <div style={{
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "space-between",
                                        padding: "6px 14px",
                                        borderBottom: "1px solid var(--border)",
                                        background: "var(--bg)",
                                      }}>
                                        <span style={{
                                          fontSize: 10,
                                          color: "var(--text-tertiary)",
                                          fontFamily: "monospace",
                                          textTransform: "uppercase",
                                          letterSpacing: "0.05em",
                                        }}>
                                          Schema
                                        </span>
                                        <button
                                          onClick={() => {
                                            setShowDiagram(true);
                                            updateActiveTab({ activeResult: -2 });
                                          }}
                                          title="Show ER diagram of this connection's tables"
                                          style={{
                                            fontSize: 10,
                                            fontFamily: "monospace",
                                            color: showDiagram ? "var(--accent)" : "var(--text-tertiary)",
                                            background: "none",
                                            border: "1px solid var(--border)",
                                            borderRadius: 4,
                                            padding: "3px 8px",
                                            cursor: "pointer",
                                          }}
                                        >
                                          ⊞ Diagram
                                        </button>
                                      </div>
                                    )}

                                    {/* Tables under this schema */}
                                    {expandedSchemas.has(schemaName) && tables.map(table => (
                                      <div key={`${schemaName}.${table.name}`}>
                                        <div
                                          onClick={() => {
                                            const next = new Set(expandedTables);
                                            next.has(`${schemaName}.${table.name}`)
                                              ? next.delete(`${schemaName}.${table.name}`)
                                              : next.add(`${schemaName}.${table.name}`);
                                            setExpandedTables(next);
                                          }}
                                          onDoubleClick={() => {
                                            const q = `SELECT * FROM ${schemaName}.${table.name} LIMIT 100`;
                                            editorRef.current?.setValue(q);
                                            editorRef.current?.focus();
                                          }}
                                          onContextMenu={(e) => {
                                            e.preventDefault();
                                            setSchemaContextMenu({
                                              x: e.clientX, y: e.clientY,
                                              name: table.name,
                                              type: "table",
                                              schema: schemaName,
                                              connection: conn,
                                            });
                                          }}
                                          title="Click to expand · Double-click to query"
                                          style={{
                                            display: "flex", alignItems: "center", gap: 6,
                                            padding: "5px 14px 5px 24px",
                                            cursor: "pointer",
                                            borderTop: "1px solid var(--border)",
                                          }}
                                        >
                                          <span style={{
                                            fontSize: 9, color: "var(--text-disabled)",
                                            flexShrink: 0, width: 10,
                                          }}>
                                            {expandedTables.has(`${schemaName}.${table.name}`)
                                              ? "▾" : "▸"}
                                          </span>
                                          <span style={{
                                            fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                            overflow: "hidden", textOverflow: "ellipsis",
                                            whiteSpace: "nowrap", fontFamily: "monospace",
                                          }}>
                                            {table.name}
                                          </span>
                                          <span style={{
                                            fontSize: 9, color: "var(--text-disabled)",
                                            fontFamily: "monospace", flexShrink: 0,
                                          }}>
                                            {table.columns?.length ?? 0}
                                          </span>
                                        </div>

                                        {/* Columns */}
                                        {expandedTables.has(`${schemaName}.${table.name}`) &&
                                          (table.columns ?? []).map(col => (
                                            <div
                                              key={col.name}
                                              style={{
                                                display: "flex", alignItems: "center", gap: 6,
                                                padding: "3px 14px 3px 36px",
                                                borderTop: "1px solid var(--bg)",
                                              }}
                                            >
                                              {col.isPrimaryKey && (
                                                <span style={{
                                                  fontSize: 8, color: "var(--warning)", flexShrink: 0,
                                                }}>🔑</span>
                                              )}
                                              <span style={{
                                                fontSize: 11,
                                                color: col.isPrimaryKey ? "var(--text)" : "var(--text-tertiary)",
                                                fontFamily: "monospace", flex: 1,
                                                overflow: "hidden", textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}>
                                                {col.name}
                                              </span>
                                              <span style={{
                                                fontSize: 9, color: "var(--text-disabled)",
                                                fontFamily: "monospace", flexShrink: 0,
                                              }}>
                                                {col.dataType}
                                              </span>
                                            </div>
                                          ))}
                                      </div>
                                    ))}
                                  </div>
                                ))
                              : // All other engines (or single-schema Postgres)
                                safeSchema.tables.map(table => (
                                  <div key={`${table.schema ?? "public"}.${table.name}`}>
                                    <div
                                      onClick={() => {
                                        const next = new Set(expandedTables);
                                        next.has(table.name)
                                          ? next.delete(table.name)
                                          : next.add(table.name);
                                        setExpandedTables(next);
                                      }}
                                      onDoubleClick={() => {
                                        const q = conn.engine === "sqlserver"
                                          ? `SELECT TOP 100 * FROM ${table.name}`
                                          : `SELECT * FROM ${table.name} LIMIT 100`;
                                        editorRef.current?.setValue(q);
                                        editorRef.current?.focus();
                                      }}
                                      onContextMenu={(e) => {
                                        e.preventDefault();
                                        setSchemaContextMenu({
                                          x: e.clientX, y: e.clientY,
                                          name: table.name, type: "table",
                                          schema: table.schema || "dbo",
                                          connection: conn,
                                        });
                                      }}
                                      title="Click to expand · Double-click to query"
                                      style={{
                                        display: "flex", alignItems: "center", gap: 6,
                                        padding: "5px 14px", cursor: "pointer",
                                        borderTop: "1px solid var(--border)",
                                      }}
                                    >
                                      <span style={{
                                        fontSize: 9, color: "var(--text-disabled)",
                                        flexShrink: 0, width: 10,
                                      }}>
                                        {expandedTables.has(table.name) ? "▾" : "▸"}
                                      </span>
                                      <span style={{
                                        fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                        overflow: "hidden", textOverflow: "ellipsis",
                                        whiteSpace: "nowrap", fontFamily: "monospace",
                                      }}>
                                        {table.name}
                                      </span>
                                      <span style={{
                                        fontSize: 9, color: "var(--text-disabled)",
                                        fontFamily: "monospace", flexShrink: 0,
                                      }}>
                                        {table.columns?.length ?? 0}
                                      </span>
                                    </div>

                                    {expandedTables.has(table.name) &&
                                      (table.columns ?? []).map(col => (
                                        <div
                                          key={col.name}
                                          style={{
                                            display: "flex", alignItems: "center", gap: 6,
                                            padding: "3px 14px 3px 26px",
                                            borderTop: "1px solid var(--bg)",
                                          }}
                                        >
                                          {col.isPrimaryKey && (
                                            <span style={{
                                              fontSize: 8, color: "var(--warning)", flexShrink: 0,
                                            }}>🔑</span>
                                          )}
                                          <span style={{
                                            fontSize: 11,
                                            color: col.isPrimaryKey ? "var(--text)" : "var(--text-tertiary)",
                                            fontFamily: "monospace", flex: 1,
                                            overflow: "hidden", textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                          }}>
                                            {col.name}
                                          </span>
                                          <span style={{
                                            fontSize: 9, color: "var(--text-disabled)",
                                            fontFamily: "monospace", flexShrink: 0,
                                          }}>
                                            {col.dataType}
                                          </span>
                                        </div>
                                      ))}
                                  </div>
                                ))
                            }
                          </SchemaSection>

                          {/* Stored Procedures */}
                          <SchemaSection
                            label="Stored Procedures"
                            icon="⚙"
                            count={safeSchema.procedures.length}
                            sectionKey={`${conn.id}-procedures`}
                            expanded={expandedSections.has(`${conn.id}-procedures`)}
                            onToggle={() => toggleSection(`${conn.id}-procedures`)}
                            emptyMessage={conn.engine === "sqlite"
                              ? "SQLite doesn't support stored procedures"
                              : undefined}
                          >
                            {safeSchema.procedures.map(proc => (
                              <div key={`${proc.schema}.${proc.name}`}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSchemaContextMenu({
                                    x: e.clientX, y: e.clientY,
                                    name: proc.name, type: "procedure",
                                    schema: proc.schema, connection: conn,
                                  });
                                }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 6,
                                  padding: "5px 14px 5px 20px",
                                  borderTop: "1px solid var(--border)", cursor: "default",
                                }}
                              >
                                <span style={{ fontSize: 10, color: "var(--accent)", flexShrink: 0 }}>ƒ</span>
                                <span style={{ fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {proc.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "monospace", flexShrink: 0 }}>
                                  {proc.parameterCount}p
                                </span>
                              </div>
                            ))}
                          </SchemaSection>

                          {/* Functions */}
                          <SchemaSection
                            label="Functions"
                            icon="λ"
                            count={safeSchema.functions.length}
                            sectionKey={`${conn.id}-functions`}
                            expanded={expandedSections.has(`${conn.id}-functions`)}
                            onToggle={() => toggleSection(`${conn.id}-functions`)}
                            emptyMessage={conn.engine === "sqlite"
                              ? "SQLite doesn't support user-defined functions"
                              : undefined}
                          >
                            {safeSchema.functions.map(fn => (
                              <div key={`${fn.schema}.${fn.name}`}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSchemaContextMenu({
                                    x: e.clientX, y: e.clientY,
                                    name: fn.name, type: "function",
                                    schema: fn.schema, connection: conn,
                                  });
                                }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 6,
                                  padding: "5px 14px 5px 20px",
                                  borderTop: "1px solid var(--border)",
                                }}
                              >
                                <span style={{ fontSize: 10,
                                  color: fn.functionType === "table" ? "var(--success)" : "var(--warning)",
                                  flexShrink: 0 }}>
                                  λ
                                </span>
                                <span style={{ fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {fn.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "monospace", flexShrink: 0 }}>
                                  {fn.functionType}
                                </span>
                              </div>
                            ))}
                          </SchemaSection>

                          {/* Views */}
                          <SchemaSection
                            label="Views"
                            icon="◫"
                            count={safeSchema.views.length}
                            sectionKey={`${conn.id}-views`}
                            expanded={expandedSections.has(`${conn.id}-views`)}
                            onToggle={() => toggleSection(`${conn.id}-views`)}
                          >
                            {safeSchema.views.map(view => (
                              <div key={`${view.schema}.${view.name}`}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSchemaContextMenu({
                                    x: e.clientX, y: e.clientY,
                                    name: view.name, type: "view",
                                    schema: view.schema, connection: conn,
                                  });
                                }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 6,
                                  padding: "5px 14px 5px 20px",
                                  borderTop: "1px solid var(--border)", cursor: "pointer",
                                }}
                            onDoubleClick={() => {
                              const limit = conn.engine === "sqlserver"
                                ? `SELECT TOP 100 * FROM ${view.name}`
                                : `SELECT * FROM ${view.name} LIMIT 100`;
                              editorRef.current?.setValue(limit);
                              editorRef.current?.focus();
                            }}
                                title="Double-click to query"
                              >
                                <span style={{ fontSize: 9, color: "var(--info)", flexShrink: 0 }}>◫</span>
                                <span style={{ fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {view.name}
                                </span>
                              </div>
                            ))}
                          </SchemaSection>

                          {/* Triggers */}
                          <SchemaSection
                            label="Triggers"
                            icon="⚡"
                            count={safeSchema.triggers.length}
                            sectionKey={`${conn.id}-triggers`}
                            expanded={expandedSections.has(`${conn.id}-triggers`)}
                            onToggle={() => toggleSection(`${conn.id}-triggers`)}
                          >
                            {safeSchema.triggers.map(trigger => (
                              <div key={trigger.name}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSchemaContextMenu({
                                    x: e.clientX, y: e.clientY,
                                    name: trigger.name, type: "trigger",
                                    schema: trigger.tableName, connection: conn,
                                  });
                                }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 6,
                                  padding: "5px 14px 5px 20px",
                                  borderTop: "1px solid var(--border)",
                                }}
                              >
                                <span style={{ fontSize: 9, color: "var(--error)", flexShrink: 0 }}>⚡</span>
                                <span style={{ fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {trigger.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "monospace",
                                  flexShrink: 0, textAlign: "right" }}>
                                  {trigger.timing} {trigger.event}
                                </span>
                              </div>
                            ))}
                          </SchemaSection>

                          {/* Indexes */}
                          <SchemaSection
                            label="Indexes"
                            icon="⊞"
                            count={safeSchema.indexes.length}
                            sectionKey={`${conn.id}-indexes`}
                            expanded={expandedSections.has(`${conn.id}-indexes`)}
                            onToggle={() => toggleSection(`${conn.id}-indexes`)}
                          >
                            {safeSchema.indexes.map(idx => (
                              <div key={`${idx.tableName}.${idx.name}`}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  setSchemaContextMenu({
                                    x: e.clientX, y: e.clientY,
                                    name: idx.name, type: "index",
                                    schema: idx.tableName, connection: conn,
                                    extra: conn.engine === "sqlite"
                                      ? undefined  // ← SQLite: fetch from sqlite_master instead
                                      : {
                                          tableName: idx.tableName,
                                          columns:   idx.columns,
                                          isUnique:  idx.isUnique,
                                          isPrimary: idx.isPrimary,
                                        }
                                  });
                                }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 6,
                                  padding: "5px 14px 5px 20px",
                                  borderTop: "1px solid var(--border)",
                                }}
                              >
                                <span style={{ fontSize: 9,
                                  color: idx.isPrimary ? "var(--warning)" : idx.isUnique ? "var(--accent)" : "var(--text-disabled)",
                                  flexShrink: 0 }}>
                                  {idx.isPrimary ? "🔑" : idx.isUnique ? "◈" : "◇"}
                                </span>
                                <span style={{ fontSize: 11, color: "var(--text-secondary)", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {idx.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "monospace",
                                  flexShrink: 0, maxWidth: 80, overflow: "hidden",
                                  textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                                  title={idx.columns}>
                                  {idx.tableName}
                                </span>
                              </div>
                            ))}
                          </SchemaSection>
                          </>
                          );
                        })()}
                      </div>
                        );
                      })()}

                      {/* Remaining databases, listed below the active database's
                          tree so the active one expands inline between its
                          siblings — true accordion behaviour. */}
                      {conn.engine !== "sqlite" && databases.length > 0 && (() => {
                        const activeDb = activeTab.activeDatabase ?? conn.database;
                        const q = dbFilter.trim().toLowerCase();
                        const filtered = q
                          ? databases.filter(d => d.toLowerCase().includes(q))
                          : databases;
                        const activeIndex = filtered.indexOf(activeDb);
                        if (activeIndex < 0) return null;
                        const rest = filtered.slice(activeIndex + 1);
                        if (rest.length === 0) return null;
                        return (
                          <>{rest.map(db => renderDbRow(conn, db, activeDb))}</>
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
              </div>
          );
          }))}
            {/* Files section */}
            <div style={{ borderTop: "1px solid var(--border)", marginTop: 4 }}>
              <div style={{
                padding: "8px 14px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-disabled)",
                textTransform: "uppercase", letterSpacing: ".06em",
                display: "flex", alignItems: "center", justifyContent: "space-between",
              }}>
                <span>Files</span>
                <button onClick={openFile} title="Open file" style={{
                  background: "none", border: "1px solid var(--border)", borderRadius: 4,
                  color: "var(--text-secondary)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: "1px 6px",
                }}>
                  +
                </button>
              </div>

              {recentFiles.length === 0 ? (
                <div style={{ padding: "6px 14px 10px", color: "var(--text-disabled)", fontSize: 11 }}>
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
                        results:    [],
                        activeResult: 0,
                        error:      null,
                      });
                      editorRef.current?.setValue("SELECT * FROM data LIMIT 100");
                    }}
                    style={{
                      padding: "8px 14px", cursor: "pointer",
                      borderBottom: "1px solid var(--border)",
                      borderLeft: `3px solid ${activeTab.file?.id === file.id ? "var(--success)" : "transparent"}`,
                      background: activeTab.file?.id === file.id ? "var(--surface-2)" : "transparent",
                    }}
                  >
                    <div style={{ fontSize: 12, fontWeight: 500, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 2 }}>
                      {file.name}
                    </div>
                    <span style={{
                      fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 20,
                      background: "var(--success-bg)", color: "var(--success)",
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

      {/* Sidebar footer — settings gear */}
      <div style={{
        borderTop: "1px solid var(--border)",
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexShrink: 0,
      }}>
        <button
          onClick={() => {
            setSettingsDraft({ ...settings });
            setShowSettings(true);
          }}
          title="Settings"
          style={{
            background: "none", border: "none",
            color: "var(--text-disabled)", cursor: "pointer",
            fontSize: 16, padding: "4px 6px",
            borderRadius: 6, transition: "color .15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={e => (e.currentTarget.style.color = "var(--text-disabled)")}
        >
          ⚙
        </button>
      </div>

      {/* Sidebar resize handle */}
      <div
        onMouseDown={onSidebarDragStart}
        style={{ width: 4, cursor: "col-resize", background: "transparent", flexShrink: 0, transition: "background .15s", zIndex: 10 }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--accent-bg)")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        {/* Tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
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
                borderRight: "1px solid var(--border)",
                borderBottom: `2px solid ${tab.id === activeTabId ? "var(--accent)" : "transparent"}`,
                background: tab.id === activeTabId ? "var(--surface)" : "transparent",
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
                  background: "var(--success)", flexShrink: 0,
                }} />
              )}

              {/* Tab title */}
              <span style={{
                fontSize: 12,
                color: tab.id === activeTabId ? "var(--text)" : "var(--text-tertiary)",
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
                    color: "var(--text-disabled)", cursor: "pointer",
                    fontSize: 14, lineHeight: 1,
                    padding: "2px 4px", flexShrink: 0,
                    borderRadius: 3,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--error)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-disabled)")}
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
              color: "var(--text-disabled)", cursor: "pointer",
              fontSize: 18, lineHeight: 1,
              padding: "0 12px", height: 38,
              flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-disabled)")}
            title="New tab (Cmd+T)"
          >
            +
          </button>
        </div>

        {/* Toolbar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "8px 14px",
          borderBottom: "1px solid var(--border)", background: "var(--surface)",
          flexShrink: 0, flexWrap: "wrap", minHeight: 44,
        }}>
          {/* Active connection pill */}
          {activeTab.connection?.sshEnabled && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 6,
              background: tunnelPorts[activeTab.connection.id]
                ? "var(--success-bg)"
                : tunnelLoading[activeTab.connection.id]
                ? "var(--warning-bg)"
                : "var(--error-bg)",
              border: `1px solid ${tunnelPorts[activeTab.connection.id]
                ? "var(--success)"
                : tunnelLoading[activeTab.connection.id]
                ? "var(--warning)"
                : "var(--error)"}`,
              fontSize: 11, fontFamily: "monospace",
              color: tunnelPorts[activeTab.connection.id]
                ? "var(--success)"
                : tunnelLoading[activeTab.connection.id]
                ? "var(--warning)"
                : "var(--error)",
            }}>
              {tunnelLoading[activeTab.connection.id]
                ? "⏳ Opening tunnel…"
                : tunnelPorts[activeTab.connection.id]
                ? `🔒 SSH :${tunnelPorts[activeTab.connection.id]}`
                : "⚠ No tunnel"}
            </div>
          )}

          {/* Active file pill */}
          {activeTab.file && (
            <div style={{
              display: "flex", alignItems: "center", gap: 8, padding: "4px 10px",
              background: "var(--surface-2)", borderRadius: 6, border: "1px solid var(--success)",
            }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: "var(--text)" }}>{activeTab.file.name}</span>
              <span style={{
                fontSize: 9, fontWeight: 600, padding: "1px 6px", borderRadius: 20,
                background: "var(--success-bg)", color: "var(--success)",
                textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "monospace",
              }}>
                {activeTab.file.type}
              </span>
            </div>
          )}

          {/* Run Query Button */}
          <button
            onClick={runQuery}
            disabled={activeTab.loading || (!activeTab.connection && !activeTab.file)}
            style={{
              padding: "6px 14px",
              background: activeTab.loading || (!activeTab.connection && !activeTab.file) ? "var(--surface-3)" : "var(--accent)",
              color: "white", border: "none", borderRadius: 6,
              cursor: activeTab.loading || (!activeTab.connection && !activeTab.file) ? "not-allowed" : "pointer",
              fontSize: 12, fontFamily: "monospace", flexShrink: 0, whiteSpace: "nowrap",
            }}
          >
            {activeTab.loading
              ? <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Spinner size={12} /> Running...
                </span>
              : "▶ Run (Cmd+Enter)"}
          </button>
          {/* Include Plan toggle — per tab. Hidden when there's no DB
              connection (plans are meaningless for flat-file DuckDB queries).
              All 6 engines are supported: Postgres + Cockroach use ANALYZE
              FORMAT JSON, SQL Server uses STATISTICS XML ON, MySQL/MariaDB
              use EXPLAIN FORMAT=JSON, SQLite uses EXPLAIN QUERY PLAN.
              Persists in tab state, so a user can keep plan-mode on for
              one tab while running normal queries elsewhere. */}
          {activeTab.connection && !activeTab.file && (
            <button
              onClick={() => updateActiveTab({ includePlan: !activeTab.includePlan })}
              title={activeTab.includePlan
                ? "Plan capture on — Run will produce an execution plan instead of query results"
                : "Wrap the next query with EXPLAIN to capture its execution plan"}
              style={{
                padding: "6px 12px",
                background: activeTab.includePlan ? "var(--warning-bg)" : "transparent",
                color: activeTab.includePlan ? "var(--warning)" : "var(--text-secondary)",
                border: `1px solid ${activeTab.includePlan ? "var(--warning)" : "var(--border)"}`,
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 11,
                fontFamily: "monospace",
                flexShrink: 0,
                whiteSpace: "nowrap",
              }}
            >
              {activeTab.includePlan ? "▸ Plan ON" : "▸ Plan"}
            </button>
          )}
          {wasRewritten && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 6,
              background: "var(--warning-bg)",
              border: "1px solid var(--warning)",
              fontSize: 11, fontFamily: "monospace",
              color: "var(--warning)", flexShrink: 0,
            }}
              title="CREATE statements were automatically rewritten to CREATE OR ALTER / CREATE OR REPLACE"
            >
              ✦ Smart DDL applied
            </div>
          )}
          {/* Show History Button */}
          <button
            onClick={() => {
              setShowHistory(h => !h);
              if (!showHistory) loadHistory(activeTab.connection);
            }}
            style={{
              padding: "6px 14px",
              background: showHistory ? "var(--surface-2)" : "none",
              color: showHistory ? "var(--text)" : "var(--text-tertiary)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 12,
              fontFamily: "monospace",
              flexShrink: 0,
            }}
          >
            ⏱ History
          </button>

          {/* Audit Log Button */}
          <button
            onClick={() => {
              const next = !auditLogEnabled;
              setAuditLogEnabled(next);
              localStorage.setItem("dbark_audit_log", String(next));
            }}
            title={auditLogEnabled ? "Audit log ON — click to disable" : "Audit log OFF — click to enable"}
            style={{
              padding: "6px 10px",
              background: auditLogEnabled ? "var(--success-bg)" : "none",
              color: auditLogEnabled ? "var(--success)" : "var(--text-disabled)",
              border: `1px solid ${auditLogEnabled ? "var(--success)" : "var(--border)"}`,
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 11,
              fontFamily: "monospace",
              flexShrink: 0,
            }}
          >
            📋 {auditLogEnabled ? "Audit ON" : "Audit OFF"}
          </button>

          {/* Export menu — only show if there's a result to export */}
          {activeTab.results.length > 0 && !activeTab.results[activeTab.activeResult]?.isMessage && (
            <div style={{ position: "relative", display: "inline-block" }}>
              <button
                onClick={() => setShowExportMenu(e => !e)}
                style={{
                  padding: "6px 14px",
                  background: "none",
                  color: "var(--text-tertiary)",
                  border: "1px solid var(--border)",
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
                    background: "var(--surface-2)",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "4px 0",
                    minWidth: 140,
                    boxShadow: "var(--shadow)",
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
                          color: "var(--text)", fontSize: 12,
                          fontFamily: "monospace", cursor: "pointer",
                          textAlign: "left",
                        }}
                        onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-3)")}
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

          {/* Row Count Display */}
          {activeTab.duration !== null && !activeTab.loading && (
            <span style={{ color: "var(--text-tertiary)", fontSize: 11, whiteSpace: "nowrap" }}>
              {activeTab.results.length > 1
                ? `${activeTab.results.length} statements · `
                : activeTab.results[0]?.rowCount
                ? `${activeTab.results[0].rowCount} rows · `
                : ""}
              {activeTab.duration}ms
              {activeTab.results.some(r => r.truncated) && (
                <span style={{ color: "var(--warning)", marginLeft: 8 }}>
                  ⚠ results truncated at {settings.resultRowLimit.toLocaleString()} rows
                </span>
              )}
              {!activeTab.results.some(r => r.truncated)
                && activeTab.results.some(r => r.largeResult) && (
                <span style={{ color: "var(--warning)", marginLeft: 8 }}>
                  ⚠ large result ({Math.max(...activeTab.results.map(r => r.rowCount ?? 0)).toLocaleString()} rows loaded) — performance may be affected
                </span>
              )}
            </span>
          )}
        </div>
        
        {/* History panel — only shown when a connection is active and history is toggled on */}
        {showHistory && (
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
             <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace" }}>
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
                  background: "none", border: "none", color: "var(--text-tertiary)",
                  cursor: "pointer", fontSize: 11, fontFamily: "monospace",
                }}
              >
                Clear
              </button>
            </div>

            {history.length === 0 ? (
              <div style={{ padding: "12px 14px", color: "var(--text-disabled)", fontSize: 12, fontFamily: "monospace" }}>
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
                    color: "var(--text-disabled)",
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
            fileName={activeTab.file.name}
            activeConnection={activeTab.connection}
            selected={activeTab.joinTables}
            onToggle={handleToggleJoinTable}
            onInsert={handleInsertJoinTable}
          />
        )}

        {/* Editor — lazy-loaded so Monaco doesn't block first paint */}
        <div style={{ height: editorHeight, minHeight: editorHeight, maxHeight: editorHeight, borderBottom: "1px solid var(--border)", flexShrink: 0, overflow: "hidden" }}>
          <Suspense fallback={
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontFamily: "monospace", fontSize: 13 }}>
              Loading editor…
            </div>
          }>
            <SqlEditor
              beforeMount={handleBeforeMount}
              onMount={handleEditorMount}
              theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
            />
          </Suspense>
        </div>

        {/* Drag handle */}
        <div
          onMouseDown={onEditorDragStart}
          style={{ height: 4, cursor: "row-resize", background: "transparent", flexShrink: 0, transition: "background .15s", zIndex: 10 }}
          onMouseEnter={e => (e.currentTarget.style.background = "var(--accent-bg)")}
          onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
        />

        {/* Results area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Error display */}
          {activeTab.error && (
            <div style={{
              padding: "10px 14px",
              background: "var(--error-bg)",
              borderBottom: "1px solid var(--error)",
              color: "var(--error)", fontSize: 12,
              wordBreak: "break-word", flexShrink: 0,
            }}>
              ❌ {activeTab.error}
            </div>
          )}

          {/* Result tab bar — shown when multiple results OR Activity panel open.
              Activity is a virtual "tab" at the right end with activeResult = -1. */}
          {(activeTab.results.length > 1 || (showActivity && activeTab.connection?.engine !== "sqlite") || showDiagram) && (
            <div style={{
              display: "flex",
              alignItems: "center",
              background: "var(--bg)",
              borderBottom: "1px solid var(--border)",
              overflowX: "auto",
              flexShrink: 0,
            }}>
              {activeTab.results.map((result, i) => (
                <button
                  key={i}
                  onClick={() => updateActiveTab({ activeResult: i })}
                  style={{
                    padding: "6px 14px",
                    background: "none",
                    border: "none",
                    borderBottom: `2px solid ${
                      activeTab.activeResult === i ? "var(--accent)" : "transparent"
                    }`,
                    color: activeTab.activeResult === i ? "var(--text)" : "var(--text-tertiary)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "monospace",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {result.isPlan
                    ? `▣ Execution Plan`
                    : result.error
                    ? `❌ Result ${i + 1}`
                    : result.isMessage
                    ? `✓ Result ${i + 1}`
                    : `⊞ Result ${i + 1}`}
                  {result.error
                    ? `❌ Result ${i + 1}`
                    : result.isMessage
                    ? `✓ Result ${i + 1}`
                    : `⊞ Result ${i + 1}`}
                  {result.sql && (
                    <span style={{
                      marginLeft: 6,
                      color: "var(--text-disabled)",
                      fontSize: 10,
                      maxWidth: 120,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      display: "inline-block",
                      verticalAlign: "middle",
                    }}>
                      {result.sql}
                    </span>
                  )}
                </button>
              ))}
              {/* Activity tab — virtual tab at the right end.
                  Only when panel is open and connection supports activity. */}
              {showActivity && activeTab.connection?.engine !== "sqlite" && (
                <button
                  onClick={() => updateActiveTab({ activeResult: -1 })}
                  title="Active queries (Ctrl+Shift+A to toggle)"
                  style={{
                    padding: "6px 14px",
                    marginLeft: "auto",  // push to right end
                    background: "none",
                    border: "none",
                    borderBottom: `2px solid ${
                      activeTab.activeResult === -1 ? "var(--accent)" : "transparent"
                    }`,
                    color: activeTab.activeResult === -1 ? "var(--text)" : "var(--text-tertiary)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "monospace",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>⚡ Activity</span>
                  {activityRows.length > 0 && (
                    <span style={{
                      background: "var(--accent-bg)",
                      color: "var(--accent)",
                      borderRadius: 10,
                      padding: "0 6px",
                      fontSize: 10,
                      fontFamily: "monospace",
                    }}>
                      {activityRows.length}
                    </span>
                  )}
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowActivity(false);
                      // If user was viewing activity, drop them back on first result
                      if (activeTab.activeResult === -1) {
                        updateActiveTab({ activeResult: 0 });
                      }
                    }}
                    style={{
                      color: "var(--text-disabled)",
                      fontSize: 12,
                      marginLeft: 2,
                      padding: "0 2px",
                    }}
                    title="Close Activity panel"
                  >
                    ✕
                  </span>
                </button>
              )}
              {/* Diagram tab — virtual tab at the right end.
              Only when panel is open and schema is loaded. */}
              {showDiagram && schema && (
                <button
                  onClick={() => updateActiveTab({ activeResult: -2 })}
                  title="ER diagram of this connection's tables"
                  style={{
                    padding: "6px 14px",
                    // marginLeft: "auto" only if Activity isn't also shown — otherwise
                    // Activity already pushed to the right and Diagram sits next to it
                    marginLeft: showActivity ? 0 : "auto",
                    background: "none",
                    border: "none",
                    borderBottom: `2px solid ${
                      activeTab.activeResult === -2 ? "var(--accent)" : "transparent"
                    }`,
                    color: activeTab.activeResult === -2 ? "var(--text)" : "var(--text-tertiary)",
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "monospace",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span>⊞ Diagram</span>
                  <span
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowDiagram(false);
                      if (activeTab.activeResult === -2) {
                        updateActiveTab({ activeResult: 0 });
                      }
                    }}
                    style={{
                      color: "var(--text-disabled)",
                      fontSize: 12,
                      marginLeft: 2,
                      padding: "0 2px",
                    }}
                    title="Close Diagram panel"
                  >
                    ✕
                  </span>
                </button>
              )}
            </div>
          )}

          {/* Active result */}
          {(() => {
            // Activity panel — virtual "result" at index -1.
            // Bottom panel peer to result tabs. Renders even when there
            // are no query results — that's the whole point: monitor
            // server activity while writing the next query.
            // Diagram panel — virtual "result" at index -2.
            // Renders the ER diagram for the connection's schema.
            if (activeTab.activeResult === -2 && showDiagram && schema) {
              return (
                <ErDiagram schema={schema as any} />
              );
            }

            if (activeTab.activeResult === -1 && showActivity) {
              return (
                <ActivityPanelBody
                  rows={activityRows}
                  loading={activityLoading}
                  error={activityError}
                  engine={activeTab.connection?.engine ?? ""}
                  onRefresh={() => loadActivity(activeTab.connection, false)}
                  onKillRequest={(row) => setKillPending(row)}
                />
              );
            }

            const result = activeTab.results[activeTab.activeResult];
            if (!result) {
              if (!activeTab.error && !activeTab.loading) {
                return (
                  <div style={{ padding: "40px 16px", color: "var(--text-disabled)",
                    fontSize: 13, textAlign: "center" }}>
                    {activeTab.file
                      ? "Write a query using \"data\" as the table name"
                      : activeTab.connection
                      ? "Write a query and press Cmd+Enter to run it"
                      : "Select a connection or open a file to get started"}
                  </div>
                );
              }
              return null;
            }

            if (result.error) {
              return (
                <div style={{
                  padding: "10px 14px",
                  background: "var(--error-bg)",
                  color: "var(--error)", fontSize: 12,
                  wordBreak: "break-word",
                }}>
                  ❌ {result.error}
                </div>
              );
            }

            // Execution plan branch — replace the data grid with the tree.
            // Checked before isMessage so plan results never get rendered
            // as a single-row "command completed" message.
            if (result.isPlan) {
              return <PlanResultRenderer result={result} />;
            }

            if (result.isMessage) {
              return (
                <div style={{
                  padding: "20px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ color: "var(--success)", fontSize: 18 }}>✓</span>
                    <span style={{
                      color: "var(--text-secondary)", fontSize: 13, fontFamily: "monospace",
                    }}>
                      {result.rows[0]?.[0] ?? "Command completed successfully."}
                    </span>
                  </div>
                  {result.wasRewritten && (
                    <div style={{
                      fontSize: 11, color: "var(--warning)",
                      fontFamily: "monospace", paddingLeft: 28,
                    }}>
                      ✦ Automatically rewritten to CREATE OR ALTER / CREATE OR REPLACE
                    </div>
                  )}
                </div>
              );
            }

            if (result.rows.length === 0) {
              return (
                <div style={{ padding: "16px", color: "var(--text-tertiary)", fontSize: 13 }}>
                  Query executed successfully — 0 rows returned
                </div>
              );
            }

            return <ResultsGrid
                    result={result}
                    connection={activeTab.connection}
                    schema={schema}
                    pendingEdits={activeTab.pendingEdits}
                    editingCell={activeTab.editingCell}
                    onCellEdit={handleCellEdit}
                    onCellCommit={handleCellCommit}
                    onCellCancel={handleCellCancel}
                    onCommitAll={handleCommitAll}
                    onRollbackAll={handleRollbackAll}
                  />;
          })()}
        </div>
      </div>
    </div>
  );
}

export default App;