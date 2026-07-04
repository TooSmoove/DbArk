// Extracted from App.tsx (code-audit item A-1).
import { useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { ipc, toIpcError } from "../ipc";
import type {
  ConnectionConfig,
} from "../types";
import { icon14 } from "../ui/styles";

// ---- Add connection form ----------------------------------
export function AddConnectionForm({
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

  // SQLite is a bare file path: no host, port, credentials, SSL, or SSH tunnel.
  // The form hides those fields and the save/test paths strip their values so a
  // half-filled MySQL form switched to SQLite can't leak stale host/user data
  // into the TOML.
  const isSqlite = form.engine === "sqlite";

  const fieldStyle: React.CSSProperties = {
    width: "100%", padding: "6px 10px", background: "var(--bg)",
    border: "1px solid var(--border)", borderRadius: 6, color: "var(--text)",
    fontSize: 12, fontFamily: "var(--mono)", marginTop: 3,
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
        host:        isSqlite ? "" : form.host,
        port:        isSqlite ? 0  : (parseInt(form.port) || defaultPort[form.engine] || 3306),
        database:    form.database,
        username:    isSqlite ? "" : form.username,
        color:       form.color,
        group:       form.group,
        folderPath:  connectionsFolder,
        sslMode:     form.sslMode,
        readOnly:    form.readOnly,
        sqlInstance: form.sqlInstance,
        windowsAuth: form.windowsAuth,
        // Pass existing filePath when editing so ConnectionManager overwrites it
        existingFilePath: editingConnection?.filePath ?? "",
        sshEnabled:  isSqlite ? false : form.sshEnabled,
        sshHost:     form.sshHost,
        sshPort:     parseInt(form.sshPort) || 22,
        sshUser:     form.sshUser,
        sshKeyPath:  form.sshKeyPath,
      };

      try {
        await ipc("save_connection", {
          requestJson: JSON.stringify(request),
        });
      } catch (e) {
        setError(toIpcError(e).message);
        return;
      }

      const newRef = `dbark:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`;

      if (!isSqlite && form.sshEnabled && form.sshPassword) {
        await ipc("store_credential", {
          target:   `dbark-ssh:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.sshUser}`,
          username: form.sshUser,
          password: form.sshPassword,
        });
      }

      if (!isSqlite && form.password) {
        // User entered a new password — store it under the new ref
        await ipc("store_credential", {
          target:   newRef,
          username: form.username,
          password: form.password,
        });
        // Clean up old ref if name changed
        if (editingConnection && editingConnection.credentialRef !== newRef) {
          await ipc("delete_credential", { target: editingConnection.credentialRef });
        }
      } else if (!isSqlite && editingConnection) {
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
      setError(toIpcError(e).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: "12px 14px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12, color: "var(--text)" }}>
        {editingConnection ? "Edit connection" : "Add connection"}
      </div>

     {/* Engine sits directly under Name: choosing it decides which of the
         fields below exist at all, so it has to come before them. */}
     {[
        { label: "Name",     key: "name",     placeholder: "My Database", type: "text" },
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

      {/* SQLite: the database IS a file — pick it, done. */}
      {isSqlite && (
        <label style={labelStyle}>
          Database file
          <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
            <input
              style={{ ...fieldStyle, marginTop: 0, flex: 1 }}
              type="text"
              value={form.database}
              onChange={e => setForm(f => ({ ...f, database: e.target.value }))}
              placeholder="C:\Users\keith\dbark_test.db"
              autoCorrect="off" autoCapitalize="off" spellCheck={false}
            />
            <button
              type="button"
              onClick={async () => {
                const { open } = await import("@tauri-apps/plugin-dialog");
                const selected = await open({
                  multiple: false,
                  filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
                });
                if (selected && typeof selected === "string")
                  setForm(f => ({ ...f, database: selected }));
              }}
              style={{
                padding: "6px 10px", background: "var(--surface-2)",
                border: "1px solid var(--border)", borderRadius: 6,
                color: "var(--text-secondary)", cursor: "pointer", fontSize: 11,
                fontFamily: "var(--mono)", flexShrink: 0,
              }}
            >
              Browse
            </button>
          </div>
        </label>
      )}

     {[
        ...(!isSqlite ? [
          { label: "Host",     key: "host",     placeholder: "localhost", type: "text" },
          { label: "Port",     key: "port",     placeholder: "3306",      type: "text" },
          { label: "Database", key: "database", placeholder: "mydb",      type: "text" },
        ] : []),
        ...(!isSqlite && !form.windowsAuth ? [
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
      {!isSqlite && !form.windowsAuth && (
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
              style={icon14}
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

      {!isSqlite && (
      <label style={labelStyle}>
        SSL Mode
        {form.sshEnabled && (
          <span style={{
            marginLeft: 8, fontSize: 10, color: "var(--warning)",
            fontFamily: "var(--mono)",
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
      )}

      {/* SSH Tunnel — meaningless for a local file, hidden for SQLite */}
      {!isSqlite && (
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
            style={icon14}
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
                    fontFamily: "var(--mono)", flexShrink: 0,
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
      )}
      {/* END SSH Tunnel */}

      {/* Read-only connection */}
      <label style={{ ...labelStyle, display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={form.readOnly}
          onChange={e => setForm(f => ({ ...f, readOnly: e.target.checked }))}
          style={icon14}
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
          <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--mono)" }}>{form.color}</span>
        </div>
      </label>

      {error && <div style={{ fontSize: 11, color: "var(--error)", marginBottom: 8, wordBreak: "break-word" }}>{error}</div>}

      {/* Test connection */}
      <div style={{ marginBottom: 8 }}>
        <button
          onClick={async () => {
            if (!form.database || (!isSqlite && !form.host)) {
              setTestResult("error");
              setTestMessage(isSqlite
                ? "Database file is required to test"
                : "Host and database are required to test");
              return;
            }
            setTesting(true);
            setTestResult(null);
            setTestMessage("");
            try {
              const msg = await invoke<string>("test_connection", {
                params: {
                  credentialRef: editingConnection?.credentialRef ??
                    `dbark:${form.name.toLowerCase().replace(/\s+/g, "-")}:${form.username}`,
                  engine:      form.engine,
                  host:        isSqlite ? "" : form.host,
                  port:        isSqlite ? 0  : (parseInt(form.port) || defaultPort[form.engine] || 3306),
                  database:    form.database,
                  username:    isSqlite ? "" : form.username,
                  sslMode:     form.sslMode,
                  sqlInstance: form.sqlInstance,
                  windowsAuth: form.windowsAuth,
                },
              });
              setTestResult("success");
              setTestMessage(msg);
            } catch (e) {
              setTestResult("error");
              setTestMessage(toIpcError(e).message);
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
            fontSize: 12, fontFamily: "var(--mono)",
          }}
        >
          {testing ? "Testing…" : "⚡ Test connection"}
        </button>

        {testResult && (
          <div style={{
            marginTop: 6, padding: "6px 10px", borderRadius: 6, fontSize: 11,
            fontFamily: "var(--mono)",
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
          fontSize: 12, fontFamily: "var(--mono)",
        }}>
          {saving ? "Saving..." : "Save"}
        </button>
        <button onClick={onCancel} style={{
          flex: 1, padding: "7px 0", background: "transparent", color: "var(--text-tertiary)",
          border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer",
          fontSize: 12, fontFamily: "var(--mono)",
        }}>
          Cancel
        </button>
      </div>
    </div>
  );
}
