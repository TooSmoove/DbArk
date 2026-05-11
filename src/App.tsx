import { invoke } from "@tauri-apps/api/core";
import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import Editor from "@monaco-editor/react";
import type { OnMount } from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";
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
  error?:    string;
  isMessage?: boolean;
  sql?:      string;  
  wasRewritten?: boolean; 
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

interface SchemaResult {
  tables:     TableInfo[];
  procedures: ProcedureInfo[];
  functions:  FunctionInfo[];
  views:      ViewInfo[];
  triggers:   TriggerInfo[];
  indexes:    IndexInfo[];
  error?:     string;
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
  };
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
  resultRowLimit:        10_000,
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

      const newRef = `devsql:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`;

      if (form.sshEnabled && form.sshPassword) {
        await invoke<boolean>("store_credential", {
          target:   `devsql-ssh:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.sshUser}`,
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
              Updates the password DevSql uses to connect. Change the password on the server first, then update it here.
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
        {form.sshEnabled && (
          <span style={{
            marginLeft: 8, fontSize: 10, color: "#f59e0b",
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
        borderTop: "1px solid #2d2f36",
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
            <div style={{ fontSize: 12, color: "#e8e9ec", marginBottom: 2 }}>
              SSH Tunnel
            </div>
            <div style={{ fontSize: 10, color: "#4b5563" }}>
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
                    padding: "6px 10px", background: "#1e2026",
                    border: "1px solid #2d2f36", borderRadius: 6,
                    color: "#9ca3af", cursor: "pointer", fontSize: 11,
                    fontFamily: "monospace", flexShrink: 0,
                  }}
                >
                  Browse
                </button>
              </div>
            </label>
            <label style={labelStyle}>
              SSH Password <span style={{ color: "#4b5563" }}>(if key requires passphrase)</span>
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

      {/* Pending edits toolbar */}
      {pendingEdits.length > 0 && (
        <div style={{
          padding: "6px 14px",
          borderBottom: "1px solid #1e2026",
          background: "rgba(245,158,11,0.08)",
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 11, color: "#f59e0b",
            fontFamily: "monospace", flex: 1,
          }}>
            ⚠ {pendingEdits.length} unsaved change{pendingEdits.length > 1 ? "s" : ""}
          </span>
          <button
            onClick={onCommitAll}
            style={{
              padding: "4px 12px",
              background: "#10b981", color: "white",
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
              background: "transparent", color: "#6b7280",
              border: "1px solid #2d2f36", borderRadius: 6,
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
                  {row.getVisibleCells().map((cell, colIdx) => {
                  const rowIdx     = virtualRow.index;
                  const isEditing  = editingCell?.rowIndex === rowIdx
                                  && editingCell?.colIndex === colIdx;
                  const pending    = pendingEdits.find(
                    e => e.rowIndex === rowIdx && e.colIndex === colIdx);
                  const cellValue  = pending ? pending.newValue
                                  : cell.getValue() as string | null;
                  const isModified = !!pending;

                  return (
                    <td
                      key={cell.id}
                      onDoubleClick={() => {
                        if (!canEdit) return;
                        const val = cell.getValue() as string | null;
                        if (val === null && !hasPk) return;
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
                        borderBottom: "1px solid #1e2026",
                        color: isModified ? "#f59e0b" : "#e8e9ec",
                        whiteSpace: "nowrap",
                        maxWidth: 320,
                        overflow: "hidden",
                        textOverflow: isEditing ? "clip" : "ellipsis",
                        cursor: canEdit ? "pointer" : "default",
                        background: isEditing
                          ? "rgba(108,99,255,0.15)"
                          : isModified
                          ? "rgba(245,158,11,0.08)"
                          : copiedCell === cell.id
                          ? "rgba(108,99,255,0.15)"
                          : virtualRow.index % 2 === 0 ? "#0e0f11" : "#13141a",
                        transition: "background .15s",
                      }}
                      onClick={() => {
                        if (isEditing) return;
                        const val = cell.getValue() as string | null;
                        if (val === null) return;
                        import("@tauri-apps/plugin-clipboard-manager").then(
                          ({ writeText, readText, clear }) => {
                            writeText(val).then(() => {
                              setCopiedCell(cell.id);
                              setTimeout(() => setCopiedCell(null), 800);
                              setTimeout(() => {
                                readText().then(current => {
                                  if (current === val) clear().catch(() => {});
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
                            background: "rgba(108,99,255,0.15)",
                            border: "none",
                            borderBottom: "2px solid #6c63ff",
                            color: "#e8e9ec",
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
                            // Commit on blur if value changed
                            const newVal = e.target.value;
                            const orig   = cell.getValue() as string | null;
                            if (newVal !== (orig ?? "")) {
                              onCellCommit(rowIdx, colIdx, newVal);
                            } else {
                              onCellCancel();
                            }
                          }}
                          onClick={e => e.stopPropagation()}
                        />
                      ) : (
                        cellValue === null
                          ? <span style={{ color: "#6b7280", fontStyle: "italic" }}>NULL</span>
                          : isModified
                          ? <span style={{ color: "#f59e0b" }}>{cellValue}</span>
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

        {rows.length === 0 && filterText && (
          <div style={{ padding: "24px 14px", color: "#4b5563", fontSize: 13, textAlign: "center" }}>
            No rows match "{filterText}"
          </div>
        )}
      </div>

      {/* Edit Status Indicator */}
      {!canEdit && connection && (
      <div style={{
        padding: "4px 14px",
        background: "#13141a",
        borderTop: "1px solid #1e2026",
        fontSize: 10, color: "#374151",
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
    <div style={{ borderTop: "1px solid #1e2026" }}>
      <div
        onClick={onToggle}
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: "6px 14px", cursor: "pointer",
          background: expanded ? "#0e0f11" : "transparent",
          transition: "background .1s",
        }}
        onMouseEnter={e => (e.currentTarget.style.background = "#0e0f11")}
        onMouseLeave={e => (e.currentTarget.style.background = expanded ? "#0e0f11" : "transparent")}
      >
        <span style={{ fontSize: 9, color: "#4b5563", width: 10, flexShrink: 0 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "monospace",
          fontWeight: 600, flex: 1, textTransform: "uppercase", letterSpacing: ".05em" }}>
          {label}
        </span>
        <span style={{ fontSize: 9, color: "#374151", fontFamily: "monospace" }}>
          {count}
        </span>
      </div>

      {expanded && (
        <div style={{ background: "#080909" }}>
          {emptyMessage ? (
            <div style={{ padding: "8px 14px 8px 20px", fontSize: 10,
              color: "#374151", fontFamily: "monospace", fontStyle: "italic" }}>
              {emptyMessage}
            </div>
          ) : count === 0 ? (
            <div style={{ padding: "8px 14px 8px 20px", fontSize: 10,
              color: "#374151", fontFamily: "monospace" }}>
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
        fontSize: 10, fontWeight: 600, color: "#4b5563",
        fontFamily: "monospace", textTransform: "uppercase",
        letterSpacing: ".08em", marginBottom: 12,
        paddingBottom: 6, borderBottom: "1px solid #2d2f36",
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
          fontSize: 12, color: "#e8e9ec",
          marginBottom: 2, fontFamily: "monospace",
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 10, color: "#4b5563",
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
  background: "#0e0f11",
  border: "1px solid #2d2f36",
  borderRadius: 6,
  color: "#e8e9ec",
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
  const [connectionsFolder, setConnectionsFolder] = useState("");
  const [schema, setSchema] = useState<SchemaResult | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [expandedTables, setExpandedTables] = useState<Set<string>>(new Set());
  const [expandedSchemas, setExpandedSchemas] = useState<Set<string>>(new Set(["public"]));
  const schemaRef = useRef<SchemaResult | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [locked, setLocked] = useState(false);
  const [saveQueryOpen, setSaveQueryOpen] = useState(false);
  const [saveQueryName, setSaveQueryName] = useState("");
  const [saveQueryTags, setSaveQueryTags] = useState("");
  const [saveQueryDesc, setSaveQueryDesc] = useState("");
  const inactivityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeTabRef = useRef<Tab>(activeTab);
  const runQueryRef = useRef<() => Promise<void>>(async () => {});
  const sqlSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schemaCache = useRef<Map<string, SchemaResult>>(new Map());
  
  const handleJoinSelectionChange = useCallback((tables: string[]) => {
    updateActiveTab({ joinTables: tables });
  }, [activeTabId])
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

  useEffect(() => {
    invoke<string>("load_settings")
      .then(raw => {
        try {
          const loaded = JSON.parse(raw);
          // Map snake_case from Rust to camelCase
          const mapped: AppSettings = {
            queryTimeoutSecs:      loaded.query_timeout_secs      ?? 30,
            lockTimeoutMins:       loaded.lock_timeout_mins       ?? 15,
            resultRowLimit:        loaded.result_row_limit        ?? 10_000,
            historyRetentionDays:  loaded.history_retention_days  ?? 90,
            resultClearMins:       loaded.result_clear_mins       ?? 5,
            auditLogEnabled:       loaded.audit_log_enabled       ?? false,
            clipboardClearEnabled: loaded.clipboard_clear_enabled ?? true,
            clipboardClearSecs:    loaded.clipboard_clear_secs    ?? 60,
          };
          const stored = localStorage.getItem("devsql_collapsed_groups");

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
    const stored = localStorage.getItem("devsql_audit_log");
    if (stored === "true") setAuditLogEnabled(true);
  }, []);

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
        "devsql_collapsed_groups",
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
          target:   `devsql-ssh:${conn.id}:${conn.sshUser}`,
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
      const sql = editorRef.current?.getValue()?.trim() ?? "";
      console.log("Ctrl+S caught, sql:", sql, "editorRef:", editorRef.current);
      console.log("setting saveQueryOpen to true");
      setSaveQueryOpen(true);
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
        connection: null,
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
    background: "none", border: "none", color: "#e8e9ec",
    fontSize: 12, fontFamily: "monospace", cursor: "pointer",
    textAlign: "left",
  };
  //END CRUD Script function

  //Run Query Function
  const runQuery = useCallback(async () => {
    if (locked) return;
    const sql = editorRef.current?.getValue()?.trim() ?? "";
    if (!sql) return;

    const tab = activeTabRef.current;

    updateActiveTab({ loading: true, error: null, results: [], activeResult: 0 });

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
            database:      conn.database,
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
        });
      } else {
        updateActiveTab({ loading: false, error: "Select a connection or open a file first" });
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
    const ms = Math.round(performance.now() - start);

    // Top-level error (connection failed etc)
    if (normalised.error) {
      const tabId = activeTabRef.current.id;
      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, loading: false, duration: ms, results: [], error: normalised.error! }
          : t
      ));
      return;
    }

    const results = normalised.results ?? [];
    const firstError = results.find(r => r.error);
    const tabId = activeTabRef.current.id; // ← capture the ref, not the closure

    // Result auto-clear — in runQuery after setting results:
    if (settings.resultClearMins > 0) {
      setTimeout(() => {
        setTabs(prev => prev.map(t =>
          t.id === tabId ? { ...t, results: [], error: null } : t
        ));
      }, settings.resultClearMins * 60 * 1000);
    }

    setTabs(prev => prev.map(t =>
      t.id === tabId
        ? {
            ...t,
            loading:      false,
            duration:     ms,
            results:      results,
            activeResult: 0,
            error:        firstError?.error ?? null,
          }
        : t
    ));

    updateActiveTab({
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
      const tabId = activeTabRef.current.id;
      setTabs(prev => prev.map(t =>
        t.id === tabId
          ? { ...t, loading: false, error: String(e) }
          : t
      ));
    }
  }, [locked, showHistory, activeTabId, auditLogEnabled]);

  useEffect(() => { runQueryRef.current = runQuery; }, [runQuery]);
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
    if (schemaCache.current.has(conn.id)) {
      setSchema(schemaCache.current.get(conn.id)!);
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
        database:      conn.database,
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

      schemaCache.current.set(conn.id, parsed);
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

  const [savedQueries, setSavedQueries]     = useState<any[]>([]);
  const [querySearch, setQuerySearch]       = useState("");
  const [showQueryLibrary, setShowQueryLibrary] = useState(false);

  async function loadSavedQueries() {
    const raw = await invoke<string>("list_queries");
    setSavedQueries(JSON.parse(raw));
  }

  // Load on mount
  useEffect(() => { loadSavedQueries(); }, []);

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
            background: "#1e2026",
            border: "1px solid #2d2f36",
            borderRadius: 8,
            padding: "4px 0",
            minWidth: 200,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          }}>
            {/* Header */}
            <div style={{
              padding: "6px 16px",
              fontSize: 10, color: "#4b5563",
              fontFamily: "monospace",
              borderBottom: "1px solid #2d2f36",
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
                onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
                onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
                    height: 1, background: "#2d2f36",
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
                      onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
                onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
                  <div style={{ height: 1, background: "#2d2f36", margin: "4px 0" }} />
                  <button
                    onClick={() => {
                      setEditorScript(scriptExecute(proc, engine));
                      setSchemaContextMenu(null);
                    }}
                    style={menuItemStyle}
                    onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
                onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
                onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
                onMouseLeave={e => (e.currentTarget.style.background = "none")}
              >
                ✦ Script CREATE OR ALTER
              </button>
            )}

            {/* Drop — all types */}
            <div style={{ height: 1, background: "#2d2f36", margin: "4px 0" }} />
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
              style={{ ...menuItemStyle, color: "#ef4444" }}
              onMouseEnter={e => (e.currentTarget.style.background = "#2d2f36")}
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
            zIndex: 1000, background: "#1e2026",
            border: "1px solid #2d2f36", borderRadius: 12,
            padding: "24px 28px", minWidth: 380, maxWidth: 520,
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center",
              gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e8e9ec" }}>
                Drop {dropConfirm.type}
              </div>
            </div>

            {/* Warning text */}
            <div style={{ fontSize: 12, color: "#9ca3af",
              marginBottom: 16, lineHeight: 1.6 }}>
              This will permanently drop{" "}
              <strong style={{ color: "#e8e9ec" }}>
                {dropConfirm.name}
              </strong>.
              This action cannot be undone.
            </div>

            {/* SQL preview */}
            <div style={{
              background: "#0e0f11",
              border: "1px solid #2d2f36",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 20,
              fontFamily: "monospace",
              fontSize: 12,
              color: "#ef4444",
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
                    schemaCache.current.delete(conn.id);
                    schemaConnectionId.current = null;
                    setSchema(null);
                    setExpandedTables(new Set());
                    setExpandedSections(new Set());
                    loadSchema(conn);

                    setDropConfirm(null);
                  } catch (e) {
                    // Show error in results area
                    updateActiveTab({ error: `Drop failed: ${String(e)}` });
                    setDropConfirm(null);
                  }
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "#ef4444", color: "white",
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
                  background: "transparent", color: "#6b7280",
                  border: "1px solid #2d2f36", borderRadius: 6,
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
            zIndex: 1000, background: "#1e2026",
            border: "1px solid #2d2f36", borderRadius: 12,
            padding: "0", width: 480, maxHeight: "80vh",
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
            display: "flex", flexDirection: "column",
          }}>

            {/* Header */}
            <div style={{
              padding: "16px 24px",
              borderBottom: "1px solid #2d2f36",
              display: "flex", alignItems: "center",
              justifyContent: "space-between", flexShrink: 0,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#e8e9ec" }}>
                ⚙ Settings
              </div>
              <button
                onClick={() => setShowSettings(false)}
                style={{ background: "none", border: "none",
                  color: "#4b5563", cursor: "pointer", fontSize: 18 }}
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
                    {[1000, 5000, 10000, 25000].map(v => (
                      <option key={v} value={v}>
                        {v.toLocaleString()} rows
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
                  description="Append every executed query to ~/.devsql/audit.log"
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
            </div>
            {/* Footer */}
            <div style={{
              padding: "12px 24px",
              borderTop: "1px solid #2d2f36",
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
                  background: "#6c63ff", color: "white",
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
                  background: "transparent", color: "#6b7280",
                  border: "1px solid #2d2f36", borderRadius: 6,
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
                  background: "transparent", color: "#4b5563",
                  border: "1px solid #2d2f36", borderRadius: 6,
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
            background: "#1a1d23", border: "1px solid #2a2d35",
            borderRadius: 8, padding: 24, width: 380,
          }}>
            <div style={{ color: "#e8e9ec", fontWeight: 600, marginBottom: 16 }}>
              Save Query
            </div>
            <input
              autoFocus
              placeholder="Query name"
              value={saveQueryName}
              onChange={e => setSaveQueryName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSaveQuery(); if (e.key === "Escape") setSaveQueryOpen(false); }}
              style={{
                width: "100%", background: "#0d0f13", border: "1px solid #2a2d35",
                borderRadius: 4, padding: "6px 10px", color: "#e8e9ec",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Tags (comma-separated, optional)"
              value={saveQueryTags}
              onChange={e => setSaveQueryTags(e.target.value)}
              style={{
                width: "100%", background: "#0d0f13", border: "1px solid #2a2d35",
                borderRadius: 4, padding: "6px 10px", color: "#e8e9ec",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Description (optional)"
              value={saveQueryDesc}
              onChange={e => setSaveQueryDesc(e.target.value)}
              style={{
                width: "100%", background: "#0d0f13", border: "1px solid #2a2d35",
                borderRadius: 4, padding: "6px 10px", color: "#e8e9ec",
                marginBottom: 16, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setSaveQueryOpen(false)}
                style={{ padding: "6px 14px", background: "transparent", border: "1px solid #2a2d35", borderRadius: 4, color: "#9ca3af", cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={handleSaveQuery}
                style={{ padding: "6px 14px", background: "#7c3aed", border: "none", borderRadius: 4, color: "#fff", cursor: "pointer" }}>
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
            zIndex: 1000, background: "#1e2026",
            border: "1px solid #2d2f36", borderRadius: 12,
            padding: "24px 28px", width: 440,
            boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#e8e9ec", marginBottom: 8 }}>
              Import from DBeaver
            </div>

            {!dbeaverResult && (
              <>
                <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 20, lineHeight: 1.6 }}>
                  Reads <code style={{ color: "#9ca3af" }}>~/.dbeaver/data-sources.json</code> and
                  imports all PostgreSQL, MySQL, SQLite, and SQL Server connections into DbArk.
                  Passwords are moved to the OS keychain.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleDbeaverImport}
                    disabled={dbeaverImporting}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: "#6c63ff", color: "white",
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
                      background: "transparent", color: "#6b7280",
                      border: "1px solid #2d2f36", borderRadius: 6,
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
                    background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)",
                    color: "#ef4444", fontSize: 12, fontFamily: "monospace",
                  }}>
                    ❌ {dbeaverResult.error}
                  </div>
                )}

                {dbeaverResult.imported.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "#10b981", marginBottom: 8, fontFamily: "monospace" }}>
                      ✓ {dbeaverResult.imported.length} connection{dbeaverResult.imported.length > 1 ? "s" : ""} imported
                    </div>
                    {dbeaverResult.imported.map(c => (
                      <div key={c.name} style={{
                        fontSize: 11, color: "#6b7280", fontFamily: "monospace",
                        padding: "2px 0",
                      }}>
                        · {c.name} ({c.engine} · {c.host})
                      </div>
                    ))}
                  </div>
                )}

                {dbeaverResult.skipped.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "#f59e0b", marginBottom: 8, fontFamily: "monospace" }}>
                      ⚠ {dbeaverResult.skipped.length} skipped
                    </div>
                    {dbeaverResult.skipped.map(s => (
                      <div key={s} style={{
                        fontSize: 11, color: "#4b5563", fontFamily: "monospace",
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
                    background: "transparent", color: "#6b7280",
                    border: "1px solid #2d2f36", borderRadius: 6,
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
            {showQueryLibrary && (
            <div style={{ borderBottom: "1px solid #1e2028", paddingBottom: 8, marginBottom: 8 }}>
              <input
                placeholder="Search queries..."
                value={querySearch}
                onChange={e => setQuerySearch(e.target.value)}
                style={{
                  width: "100%", background: "#0d0f13", border: "1px solid #2a2d35",
                  borderRadius: 4, padding: "4px 8px", color: "#e8e9ec",
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
                    onMouseEnter={e => (e.currentTarget.style.background = "#1e2028")}
                    onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
                    onClick={() => {
                      editorRef.current?.setValue(q.sql);
                      editorRef.current?.focus();
                    }}
                  >
                    <div>
                      <div style={{ color: "#e8e9ec", fontSize: 12 }}>{q.meta.name}</div>
                      {q.meta.tags?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
                          {q.meta.tags.map((t: string) => (
                            <span key={t} style={{
                              fontSize: 10, background: "rgba(124,58,237,0.2)",
                              color: "#a78bfa", borderRadius: 3, padding: "1px 5px",
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
                        color: "#4b5563", cursor: "pointer", fontSize: 14, padding: 2,
                      }}
                      title="Delete query"
                    >✕</button>
                  </div>
                ))}
              {savedQueries.length === 0 && (
                <div style={{ color: "#4b5563", fontSize: 11, padding: "4px 8px" }}>
                  No saved queries. Press Cmd+S to save.
                </div>
              )}
            </div>
          )}
            {/* Connections section label */}
            <div style={{ padding: "8px 14px 4px", borderBottom: "1px solid #1e2026", fontSize: 10, fontWeight: 600, color: "#4b5563", textTransform: "uppercase", letterSpacing: ".06em" }}>
              Connections &nbsp;&nbsp;
              <button onClick={() => setShowAddForm(v => !v)} title="Add connection" style={{
                  background: "none", border: "1px solid #2d2f36", borderRadius: 4,
                  color: "#9ca3af", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 7px", flexShrink: 0,
                }}>
                  {showAddForm ? "×" : "+"}
              </button>
              <button
                onClick={() => setShowQueryLibrary(v => !v)}
                title="Saved queries"
                style={{
                  background: showQueryLibrary ? "rgba(124,58,237,0.2)" : "transparent",
                  border: "none", color: "#9ca3af", cursor: "pointer",
                  padding: "2px 6px", borderRadius: 4, fontSize: 14,
                }}
              >
                📋
              </button>
              <button
                onClick={() => setShowDbeaverImport(true)}
                title="Import from DBeaver"
                style={{
                  background: "none", border: "1px solid #2d2f36", borderRadius: 4,
                  color: "#9ca3af", cursor: "pointer", fontSize: 11,
                  lineHeight: 1, padding: "2px 7px", flexShrink: 0,
                  fontFamily: "monospace",
                }}
              >
                ↓ DBeaver
              </button>
            </div>

            {connections.length === 0 ? (
              <div style={{ padding: "6px 14px 10px", color: "#4b5563", fontSize: 12, textAlign: "center", lineHeight: 1.6 }}>
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
                  borderBottom: "1px solid #1e2026",
                  borderTop: "2px solid #13141a",        // ← adds top separation
                  background: "#16181c",                  // ← slightly lighter, distinct from #0e0f11
                  userSelect: "none",
                }}
                onMouseEnter={e =>
                  (e.currentTarget.style.background = "#1a1c22")}
                onMouseLeave={e =>
                  (e.currentTarget.style.background = "#16181c")}
              >
                <span style={{
                  fontSize: 8, color: "#4b5563",
                  flexShrink: 0, width: 10,
                }}>
                  {collapsed ? "▸" : "▾"}
                </span>
                <span style={{
                  fontSize: 10, fontWeight: 600,
                  color: "#6c63ff",                       // ← accent color instead of #4b5563
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
                  fontSize: 9, color: "#374151",
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
                      });
                      setSchema(null);
                      setExpandedTables(new Set());
                      setExpandedSections(new Set());
                      loadSchema(conn);
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
                      borderBottom: "1px solid #1e2026",
                      borderLeft: `3px solid ${
                        activeTab.connection?.id === conn.id
                          ? conn.color
                          : "transparent"
                      }`,
                      background: activeTab.connection?.id === conn.id
                        ? "#1e2026"
                        : "transparent",
                      transition: "background .1s",
                    }}
                  >
                    <div style={{
                      fontSize: 12, fontWeight: 500,
                      marginBottom: 3, color: "#e8e9ec",
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
                        fontSize: 10, color: "#4b5563",
                        overflow: "hidden", textOverflow: "ellipsis",
                        whiteSpace: "nowrap", minWidth: 0,
                      }}>
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

                      {schema?.error && !(conn.sshEnabled && !tunnelPorts[conn.id]) && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "#ef4444", fontFamily: "monospace" }}>
                          {schema.error}
                        </div>
                      )}
                      {schema?.error && conn.sshEnabled && !tunnelPorts[conn.id] && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "#f59e0b", fontFamily: "monospace" }}>
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
                          {/* Refresh button */}
                          <div style={{ padding: "5px 14px 3px", display: "flex", justifyContent: "flex-end" }}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                schemaCache.current.delete(conn.id);
                                loadSchema(conn);
                              }}
                              style={{ background: "none", border: "none", color: "#4b5563",
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
                                        borderTop: "1px solid #1a1b21",
                                        background: "#0a0b0d",
                                      }}
                                      onMouseEnter={e =>
                                        (e.currentTarget.style.background = "#111318")}
                                      onMouseLeave={e =>
                                        (e.currentTarget.style.background = "#0a0b0d")}
                                    >
                                      <span style={{
                                        fontSize: 9, color: "#6c63ff",
                                        flexShrink: 0, width: 10,
                                      }}>
                                        {expandedSchemas.has(schemaName) ? "▾" : "▸"}
                                      </span>
                                      <span style={{
                                        fontSize: 10, color: "#6c63ff",
                                        fontFamily: "monospace", flex: 1,
                                        fontWeight: 600, letterSpacing: ".03em",
                                      }}>
                                        {schemaName}
                                      </span>
                                      <span style={{
                                        fontSize: 9, color: "#374151",
                                        fontFamily: "monospace", flexShrink: 0,
                                      }}>
                                        {tables.length}
                                      </span>
                                    </div>

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
                                            borderTop: "1px solid #1a1b21",
                                          }}
                                        >
                                          <span style={{
                                            fontSize: 9, color: "#4b5563",
                                            flexShrink: 0, width: 10,
                                          }}>
                                            {expandedTables.has(`${schemaName}.${table.name}`)
                                              ? "▾" : "▸"}
                                          </span>
                                          <span style={{
                                            fontSize: 11, color: "#9ca3af", flex: 1,
                                            overflow: "hidden", textOverflow: "ellipsis",
                                            whiteSpace: "nowrap", fontFamily: "monospace",
                                          }}>
                                            {table.name}
                                          </span>
                                          <span style={{
                                            fontSize: 9, color: "#374151",
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
                                                borderTop: "1px solid #111318",
                                              }}
                                            >
                                              {col.isPrimaryKey && (
                                                <span style={{
                                                  fontSize: 8, color: "#f59e0b", flexShrink: 0,
                                                }}>🔑</span>
                                              )}
                                              <span style={{
                                                fontSize: 11,
                                                color: col.isPrimaryKey ? "#e8e9ec" : "#6b7280",
                                                fontFamily: "monospace", flex: 1,
                                                overflow: "hidden", textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}>
                                                {col.name}
                                              </span>
                                              <span style={{
                                                fontSize: 9, color: "#374151",
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
                                        borderTop: "1px solid #1a1b21",
                                      }}
                                    >
                                      <span style={{
                                        fontSize: 9, color: "#4b5563",
                                        flexShrink: 0, width: 10,
                                      }}>
                                        {expandedTables.has(table.name) ? "▾" : "▸"}
                                      </span>
                                      <span style={{
                                        fontSize: 11, color: "#9ca3af", flex: 1,
                                        overflow: "hidden", textOverflow: "ellipsis",
                                        whiteSpace: "nowrap", fontFamily: "monospace",
                                      }}>
                                        {table.name}
                                      </span>
                                      <span style={{
                                        fontSize: 9, color: "#374151",
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
                                            borderTop: "1px solid #111318",
                                          }}
                                        >
                                          {col.isPrimaryKey && (
                                            <span style={{
                                              fontSize: 8, color: "#f59e0b", flexShrink: 0,
                                            }}>🔑</span>
                                          )}
                                          <span style={{
                                            fontSize: 11,
                                            color: col.isPrimaryKey ? "#e8e9ec" : "#6b7280",
                                            fontFamily: "monospace", flex: 1,
                                            overflow: "hidden", textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                          }}>
                                            {col.name}
                                          </span>
                                          <span style={{
                                            fontSize: 9, color: "#374151",
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
                                  borderTop: "1px solid #1a1b21", cursor: "default",
                                }}
                              >
                                <span style={{ fontSize: 10, color: "#6c63ff", flexShrink: 0 }}>ƒ</span>
                                <span style={{ fontSize: 11, color: "#9ca3af", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {proc.name}
                                </span>
                                <span style={{ fontSize: 9, color: "#374151", fontFamily: "monospace", flexShrink: 0 }}>
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
                                  borderTop: "1px solid #1a1b21",
                                }}
                              >
                                <span style={{ fontSize: 10,
                                  color: fn.functionType === "table" ? "#10b981" : "#f59e0b",
                                  flexShrink: 0 }}>
                                  λ
                                </span>
                                <span style={{ fontSize: 11, color: "#9ca3af", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {fn.name}
                                </span>
                                <span style={{ fontSize: 9, color: "#374151", fontFamily: "monospace", flexShrink: 0 }}>
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
                                  borderTop: "1px solid #1a1b21", cursor: "pointer",
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
                                <span style={{ fontSize: 9, color: "#3b82f6", flexShrink: 0 }}>◫</span>
                                <span style={{ fontSize: 11, color: "#9ca3af", flex: 1,
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
                                  borderTop: "1px solid #1a1b21",
                                }}
                              >
                                <span style={{ fontSize: 9, color: "#ef4444", flexShrink: 0 }}>⚡</span>
                                <span style={{ fontSize: 11, color: "#9ca3af", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {trigger.name}
                                </span>
                                <span style={{ fontSize: 9, color: "#374151", fontFamily: "monospace",
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
                                  borderTop: "1px solid #1a1b21",
                                }}
                              >
                                <span style={{ fontSize: 9,
                                  color: idx.isPrimary ? "#f59e0b" : idx.isUnique ? "#6c63ff" : "#4b5563",
                                  flexShrink: 0 }}>
                                  {idx.isPrimary ? "🔑" : idx.isUnique ? "◈" : "◇"}
                                </span>
                                <span style={{ fontSize: 11, color: "#9ca3af", flex: 1,
                                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                                  fontFamily: "monospace" }}>
                                  {idx.name}
                                </span>
                                <span style={{ fontSize: 9, color: "#374151", fontFamily: "monospace",
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
                  )}
                </div>
              ))}
              </div>
          );
          }))}
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
                        results:    [],
                        activeResult: 0,
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

      {/* Sidebar footer — settings gear */}
      <div style={{
        borderTop: "1px solid #1e2026",
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
            color: "#4b5563", cursor: "pointer",
            fontSize: 16, padding: "4px 6px",
            borderRadius: 6, transition: "color .15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = "#9ca3af")}
          onMouseLeave={e => (e.currentTarget.style.color = "#4b5563")}
        >
          ⚙
        </button>
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
          {activeTab.connection?.sshEnabled && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 6,
              background: tunnelPorts[activeTab.connection.id]
                ? "rgba(16,185,129,0.1)"
                : tunnelLoading[activeTab.connection.id]
                ? "rgba(245,158,11,0.1)"
                : "rgba(239,68,68,0.1)",
              border: `1px solid ${tunnelPorts[activeTab.connection.id]
                ? "rgba(16,185,129,0.2)"
                : tunnelLoading[activeTab.connection.id]
                ? "rgba(245,158,11,0.2)"
                : "rgba(239,68,68,0.2)"}`,
              fontSize: 11, fontFamily: "monospace",
              color: tunnelPorts[activeTab.connection.id]
                ? "#10b981"
                : tunnelLoading[activeTab.connection.id]
                ? "#f59e0b"
                : "#ef4444",
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

          {/* Run Query Button */}
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
          {wasRewritten && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "4px 10px", borderRadius: 6,
              background: "rgba(245,158,11,0.1)",
              border: "1px solid rgba(245,158,11,0.2)",
              fontSize: 11, fontFamily: "monospace",
              color: "#f59e0b", flexShrink: 0,
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

          {/* Audit Log Button */}
          <button
            onClick={() => {
              const next = !auditLogEnabled;
              setAuditLogEnabled(next);
              localStorage.setItem("devsql_audit_log", String(next));
            }}
            title={auditLogEnabled ? "Audit log ON — click to disable" : "Audit log OFF — click to enable"}
            style={{
              padding: "6px 10px",
              background: auditLogEnabled ? "rgba(16,185,129,0.1)" : "none",
              color: auditLogEnabled ? "#10b981" : "#4b5563",
              border: `1px solid ${auditLogEnabled ? "rgba(16,185,129,0.2)" : "#2d2f36"}`,
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

          {/* Row Count Display */}
          {activeTab.duration !== null && !activeTab.loading && (
            <span style={{ color: "#6b7280", fontSize: 11, whiteSpace: "nowrap" }}>
              {activeTab.results.length > 1
                ? `${activeTab.results.length} statements · `
                : activeTab.results[0]?.rowCount
                ? `${activeTab.results[0].rowCount} rows · `
                : ""}
              {activeTab.duration}ms
              {activeTab.results.some(r => r.truncated) && (
                <span style={{ color: "#f59e0b", marginLeft: 8 }}>
                  ⚠ some results truncated at 10,000 rows
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
            beforeMount={handleBeforeMount}
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
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Error display */}
          {activeTab.error && (
            <div style={{
              padding: "10px 14px",
              background: "rgba(239,68,68,0.1)",
              borderBottom: "1px solid rgba(239,68,68,0.2)",
              color: "#ef4444", fontSize: 12,
              wordBreak: "break-word", flexShrink: 0,
            }}>
              ❌ {activeTab.error}
            </div>
          )}

          {/* Result tab bar — only shown when multiple results */}
          {activeTab.results.length > 1 &&  (
            <div style={{
              display: "flex",
              alignItems: "center",
              background: "#0e0f11",
              borderBottom: "1px solid #1e2026",
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
                      activeTab.activeResult === i ? "#6c63ff" : "transparent"
                    }`,
                    color: activeTab.activeResult === i ? "#e8e9ec" : "#6b7280",
                    cursor: "pointer",
                    fontSize: 11,
                    fontFamily: "monospace",
                    whiteSpace: "nowrap",
                    flexShrink: 0,
                  }}
                >
                  {result.error
                    ? `❌ Result ${i + 1}`
                    : result.isMessage
                    ? `✓ Result ${i + 1}`
                    : `⊞ Result ${i + 1}`}
                  {result.sql && (
                    <span style={{
                      marginLeft: 6,
                      color: "#4b5563",
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
            </div>
          )}

          {/* Active result */}
          {(() => {
            const result = activeTab.results[activeTab.activeResult];
            if (!result) {
              if (!activeTab.error && !activeTab.loading) {
                return (
                  <div style={{ padding: "40px 16px", color: "#374151",
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
                  background: "rgba(239,68,68,0.1)",
                  color: "#ef4444", fontSize: 12,
                  wordBreak: "break-word",
                }}>
                  ❌ {result.error}
                </div>
              );
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
                    <span style={{ color: "#10b981", fontSize: 18 }}>✓</span>
                    <span style={{
                      color: "#9ca3af", fontSize: 13, fontFamily: "monospace",
                    }}>
                      {result.rows[0]?.[0] ?? "Command completed successfully."}
                    </span>
                  </div>
                  {result.wasRewritten && (
                    <div style={{
                      fontSize: 11, color: "#f59e0b",
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
                <div style={{ padding: "16px", color: "#6b7280", fontSize: 13 }}>
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