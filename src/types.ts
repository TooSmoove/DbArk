// ─────────────────────────────────────────────────────────────────────────
// Shared domain types for DbArk.
// Extracted from App.tsx (code-audit item A-1) — pure type declarations,
// no runtime code. Imported across feature modules.
// ─────────────────────────────────────────────────────────────────────────

import type { EngineName } from "./engines";

// ---- Types ------------------------------------------------
export interface ConnectionConfig {
  id: string;
  name: string;
  engine: EngineName;
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

export interface ConnectionListResult {
  connections: ConnectionConfig[];
  error?: string;
}

export interface QueryResult {
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
  planEngine?: EngineName;
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
export interface PlanNode {
  label:    string;
  detail:   string;
  cost:     number;
  rows:     number;
  actualMs?: number;
  children: PlanNode[];
  meta:     Record<string, string>;
}

export interface FileSession {
  id: string;
  name: string;
  path: string;
  type: "csv" | "json" | "xlsx";
}

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
}

export interface ProcedureInfo {
  name:           string;
  schema:         string;
  parameterCount: number;
  created?:       string;
}

export interface FunctionInfo {
  name:           string;
  schema:         string;
  functionType:   string; // scalar | table | window
  parameterCount: number;
}

export interface ViewInfo {
  name:   string;
  schema: string;
}

export interface TriggerInfo {
  name:      string;
  tableName: string;
  event:     string;
  timing:    string;
}

export interface IndexInfo {
  name:      string;
  tableName: string;
  columns:   string;
  isUnique:  boolean;
  isPrimary: boolean;
}

export interface ForeignKey {
  constraintName: string;
  sourceSchema:   string;
  sourceTable:    string;
  sourceColumn:   string;
  targetSchema:   string;
  targetTable:    string;
  targetColumn:   string;
}

export interface SchemaResult {
  tables:       TableInfo[];
  procedures:   ProcedureInfo[];
  functions:    FunctionInfo[];
  views:        ViewInfo[];
  triggers:     TriggerInfo[];
  indexes:      IndexInfo[];
  foreignKeys?: ForeignKey[];   // ← new, optional for backward compat
  error?:       string;
}

export interface HistoryEntry {
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
export interface ActivityRow {
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
export type PaletteCategory = "command" | "connection" | "table" | "tab" | "saved";

export interface PaletteItem {
  id:        string;
  category:  PaletteCategory;
  label:     string;          // primary text — what fuse searches first
  secondary: string;          // shown to the right, lower contrast (schema, db, tag)
  onSelect:  () => void;
}

export interface Tab {
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

export interface AppSettings {
  queryTimeoutSecs:      number;
  lockTimeoutMins:       number; // 0 = disabled
  resultRowLimit:        number;
  historyRetentionDays:  number; // 0 = forever
  resultClearMins:       number; // 0 = never
  auditLogEnabled:       boolean;
  clipboardClearEnabled: boolean;
  clipboardClearSecs:    number;
}

export interface PendingEdit {
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
export type ThemePreference = "system" | "light" | "dark";

export type ResolvedTheme   = "light" | "dark";

// Shape of the Drop-object confirmation dialog state.
export interface DropConfirm {
  name:       string;
  type:       string;
  schema:     string;
  tableName:  string;
  dropSql:    string;
  connection: ConnectionConfig;
}

// Right-click context menu on a schema-explorer object.
export interface SchemaContextMenu {
  x: number;
  y: number;
  name: string;
  type: string; // table | procedure | function | view | trigger | index
  schema: string;
  connection: ConnectionConfig;
  extra?: SchemaMenuIndexExtra;
}

// Index metadata attached when right-clicking an index in the schema
// explorer (non-SQLite engines; SQLite fetches from sqlite_master instead).
// Mirrors IndexInfo minus `name` (columns is the comma-joined list).
export interface SchemaMenuIndexExtra {
  tableName: string;
  columns:   string;
  isUnique:  boolean;
  isPrimary: boolean;
}

// Right-click context menu on a sidebar connection. (Named ConnectionMenu to
// avoid clashing with the ConnectionContextMenu component.)
export interface ConnectionMenu {
  x: number;
  y: number;
  connection: ConnectionConfig;
}

// Result of importing connections from DBeaver's data-sources.json.
export interface DbeaverImportResult {
  imported: { name: string; engine: string; host: string; port: number;
              database: string; username: string; password: string; }[];
  skipped:  string[];
  error?:   string;
}
