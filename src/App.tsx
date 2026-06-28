import { invoke } from "@tauri-apps/api/core";
import { ipc, ipcJson, toIpcError } from "./ipc";
import type {
  ConnectionConfig, ConnectionListResult, QueryResult, FileSession,
  ColumnInfo, TableInfo, ProcedureInfo, ViewInfo, TriggerInfo,
  IndexInfo, SchemaResult, HistoryEntry, ActivityRow,
  PaletteItem, Tab, AppSettings, PendingEdit,
  ThemePreference, ResolvedTheme,
} from "./types";
import { wrapPlanSql, PlanResultRenderer } from "./plan";
import { Spinner, EngineBadge, SchemaSection, LockOverlay, SidebarFooter } from "./ui";
import {
  DeleteConnectionDialog, DropObjectDialog, KillSessionDialog,
  CommandPalette, SettingsModal, SaveQueryModal, DbeaverImportModal,
  ConnectionContextMenu,
} from "./modals";
import { createTab, DEFAULT_SETTINGS } from "./appState";
import { tabsReducer, initTabsState } from "./state/tabsReducer";
import { THEME_STORAGE_KEY, readStoredTheme, resolveTheme } from "./theme";
import { useResizable } from "./hooks";
import { AddConnectionForm, JoinTablesPanel } from "./connections";
import { ResultsGrid } from "./results/ResultsGrid";
import { ActivityPanelBody } from "./activity/ActivityPanelBody";
import { TabBar, HistoryPanel } from "./editor";
import { useState, useReducer, useCallback, useRef, useEffect, useMemo, lazy, Suspense } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { OnMount } from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";

const SqlEditor = lazy(() => import("./components/SqlEditor/SqlEditor"));
import { format as formatSql } from "sql-formatter";
import Fuse from "fuse.js";
import "./theme.css";   // colors — must come first
import "./index.css";   // typography & layout
import "./App.css";     // component classes (.menu-item, etc.)
import { ErDiagram } from "./components/ErDiagram/ErDiagram";
import { ellipsisLabel, microMutedLabel } from "./ui/styles";

// ---- Main App ---------------------------------------------
function App() {
  const editorRef = useRef<any>(null);

  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  // Tab state lives in a pure, unit-tested reducer (code-audit A-1, Tier 3).
  // The wrapper setters below keep every existing call site + child prop
  // working unchanged; they route through the tested APPLY_* passthrough
  // actions. Call sites are migrated to semantic actions incrementally.
  const [tabsState, dispatchTabs] = useReducer(tabsReducer, undefined, initTabsState);
  const { tabs, activeTabId } = tabsState;
  const setTabs = useCallback<Dispatch<SetStateAction<Tab[]>>>(
    updater => dispatchTabs({ type: "APPLY_TABS", updater }),
    [],
  );
  const setActiveTabId = useCallback<Dispatch<SetStateAction<string>>>(
    updater => dispatchTabs({ type: "APPLY_ACTIVE", updater }),
    [],
  );
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
  // Database list for the currently-active connection.
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
  // Structured tag for the last activity error (e.g. "permission") so the panel
  // can show an actionable notice rather than a generic error banner.
  const [activityErrorCode, setActivityErrorCode] = useState<string | null>(null);
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
  const tabsRef = useRef<Tab[]>(tabs);
  const settingsRef  = useRef<AppSettings>(settings); 
  const runQueryRef = useRef<() => Promise<void>>(async () => {});
  const formatSqlRef = useRef<() => void>(() => {});
  const sqlSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schemaCache = useRef<Map<string, SchemaResult>>(new Map());
  
  // Toggle one live table in/out of the join set (checkbox path: attach or
  // detach without touching the editor text).
  const handleToggleJoinTable = useCallback((table: string, next: boolean) => {
    dispatchTabs({ type: "TOGGLE_JOIN_TABLE", id: activeTabId, table, attach: next });
  }, [activeTabId]);

  // Click-to-insert: drop db_<table> at the cursor AND ensure the table is
  // attached, so the identifier you just inserted is always one the query
  // engine actually exposes (no "db_x does not exist" surprise).
  const handleInsertJoinTable = useCallback((table: string) => {
    dispatchTabs({ type: "TOGGLE_JOIN_TABLE", id: activeTabId, table, attach: true });
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
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);
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
      const result = await ipcJson<{ imported: { name: string; engine: string; host: string; port: number; database: string; username: string; password: string; }[]; skipped: string[] }>("import_dbeaver_connections");
      setDbeaverResult(result);

      if (result.imported.length > 0) {
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

          try {
            await ipc("save_connection", {
              requestJson: JSON.stringify(request),
            });

            if (conn.password) {
              const credRef = `dbark:${conn.name.toLowerCase().replace(/\s+/g, "-")}:${conn.username}`;
              await ipc("store_credential", {
                target:   credRef,
                username: conn.username,
                password: conn.password,
              });
            }
          } catch (e) {
            // One bad connection shouldn't abort the whole import batch.
            console.warn(`Skipped importing "${conn.name}": ${toIpcError(e).message}`);
          }
        }
        loadConnections(connectionsFolder);
      }
    } catch (e) {
      setDbeaverResult({ imported: [], skipped: [], error: toIpcError(e).message });
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
        params: {
          tunnelId:    conn.id,
          sshHost:     conn.sshHost,
          sshPort:     conn.sshPort ?? 22,
          sshUser:     conn.sshUser,
          sshKeyPath:  conn.sshKeyPath ?? "",
          sshPassword: sshPassword,
          dbHost:      "127.0.0.1",
          dbPort:      conn.port,
        },
      });

      console.log("open_tunnel invoke result:", localPort);
      tunnelPortsRef.current = { ...tunnelPortsRef.current, [conn.id]: localPort };
      setTunnelPorts({ ...tunnelPortsRef.current });
      return localPort;
    } catch (e) {
      console.error("open_tunnel invoke error:", e);
      updateActiveTab({ error: `SSH tunnel failed: ${toIpcError(e).message}` });
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
      const parsed = await ipcJson<ConnectionListResult>("list_connections", { folderPath: folder });
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
    dispatchTabs({ type: "UPDATE_ACTIVE_TAB", updates });
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
      objectName:    name,
      objectType:    type,
      schemaName:    schema || "dbo",
      params: {
        credentialRef: conn.credentialRef,
        engine:        conn.engine,
        host:          conn.host,
        port:          conn.port,
        database:      conn.database,
        username:      conn.username,
        sslMode:       conn.sslMode ?? "prefer",
        sqlInstance:   conn.sqlInstance ?? "",
        windowsAuth:   conn.windowsAuth ?? false,
      },
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
            tableNames: tab.joinTables.join(","),
            params: {
              credentialRef: conn.credentialRef,
              engine:     conn.engine,
              host:       conn.host,
              port:       conn.port,
              database:   conn.database,
              username:   conn.username,
              sslMode:    conn.sslMode ?? "prefer",
              sqlInstance: conn.sqlInstance ?? "",
              windowsAuth: conn.windowsAuth ?? false,
            },
          });
        } else {
          raw = await ipc<string>("query_file", {
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
            params: {
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
            },
          });

        raw = await ipc<string>("execute_query", {
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
            planRaw = await ipc<string>("execute_query", {
              connectionString,
              sql: wrappedPlanSql,
              engine: conn.engine,
              readOnly: conn.readOnly ?? false,
              rowLimit: settingsRef.current.resultRowLimit,
            });
          } catch (e) {
            planRaw = JSON.stringify({
              error: `Plan capture failed: ${toIpcError(e).message}`,
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
            error: `Plan parse failed: ${toIpcError(e).message}`,
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
      writeTab({ loading: false, error: toIpcError(e).message });
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
          const activeId = activeTabRef.current.id;
          const updated = prev.map(t =>
            t.id === activeId ? { ...t, sql: currentSql } : t
          );
          return [...updated, newTab];
        });
        setActiveTabId(newTab.id);
        setTimeout(() => editorRef.current?.setValue(""), 0);
      });

      // Cmd+W — close tab
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyW, () => {
        // Read the latest tabs from a ref — this callback is registered once at
        // mount, so a captured `tabs` would be stale. Computing here (rather
        // than inside the setTabs updater) keeps setActiveTabId out of the
        // reducer's update phase, avoiding a dispatch-during-render.
        const prev = tabsRef.current;
        if (prev.length <= 1) return;
        const currentSql = editorRef.current?.getValue() ?? "";
        const activeId = activeTabRef.current.id;
        const idx = prev.findIndex(t => t.id === activeId);
        // Save current SQL into the active tab, then remove it.
        const newTabs = prev
          .map(t => (t.id === activeId ? { ...t, sql: currentSql } : t))
          .filter(t => t.id !== activeId);
        const nextTab = newTabs[Math.min(idx, newTabs.length - 1)];
        setTabs(newTabs);
        setActiveTabId(nextTab.id);
        setTimeout(() => editorRef.current?.setValue(nextTab.sql ?? ""), 0);
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
          t.id === activeTabRef.current.id ? { ...t, sql } : t
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
        params: {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          effectiveHost,
          port:          effectivePort,
          database:      db,
          username:      conn.username,
          sslMode:       effectiveSsl,
          sqlInstance:   conn.sqlInstance ?? "",
          windowsAuth:   conn.windowsAuth ?? false,
        },
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
        params: {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          effectiveHost,
          port:          effectivePort,
          database:      defaultDb,
          username:      conn.username,
          sslMode:       effectiveSsl,
          sqlInstance:   conn.sqlInstance ?? "",
          windowsAuth:   conn.windowsAuth ?? false,
        },
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
          fontSize: 11, flex: 1, fontFamily: "var(--mono)",
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
      const parsed = await ipcJson<{ entries?: HistoryEntry[] }>("get_history", {
        connectionId: conn?.id ?? "",
        limit: 100,
      });

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
          setActivityErrorCode(null);
          setActivityRows([]);
          return;
        }
        tunnelPort = port;
      }
      const effectiveSslMode = tunnelPort !== undefined ? "none" : (conn.sslMode ?? "prefer");

      const connectionString = await invoke<string>("build_connection_string", {
        params: {
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
        },
      });

      const parsed = await ipcJson<{ error?: string; code?: string; rows?: ActivityRow[] }>("get_activity", {
        connectionString,
        engine: conn.engine,
      });

      if (parsed.error) {
        setActivityError(parsed.error);
        setActivityErrorCode(parsed.code ?? null);
        setActivityRows([]);
      } else {
        setActivityError(null);
        setActivityErrorCode(null);
        setActivityRows(parsed.rows ?? []);
      }
    } catch (e) {
      setActivityError(toIpcError(e).message);
      setActivityErrorCode(null);
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
        params: {
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
        },
      });

      const parsed = await ipcJson<{ error?: string }>("kill_session", {
        connectionString,
        engine: conn.engine,
        pid:    row.pid,
      });
      if (parsed.error) {
        setActivityError(parsed.error);
        setActivityErrorCode(null);
      } else {
        setActivityError(null);
        setActivityErrorCode(null);
        // Refresh silently so the user sees the kill take effect immediately
        await loadActivity(conn, true);
      }
    } catch (e) {
      setActivityError(toIpcError(e).message);
      setActivityErrorCode(null);
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
      updateActiveTab({ error: `Export failed: ${toIpcError(e).message}` });
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
        objectName:    name,
        objectType:    type,
        schemaName:    schema || "dbo",
        params: {
          credentialRef: conn.credentialRef,
          engine:        conn.engine,
          host:          conn.host,
          port:          conn.port,
          database:      conn.database,
          username:      conn.username,
          sslMode:       conn.sslMode ?? "prefer",
          sqlInstance:   conn.sqlInstance ?? "",
          windowsAuth:   conn.windowsAuth ?? false,
        },
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
      updateActiveTab({ error: `Failed to load definition: ${toIpcError(e).message}` });
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
          params: {
            credentialRef: conn.credentialRef,
            engine:        conn.engine,
            host:          conn.host,
            port:          conn.port,
            database:      conn.database,
            username:      conn.username,
            sslMode:       conn.sslMode ?? "prefer",
            sqlInstance:   conn.sqlInstance ?? "",
            windowsAuth:   conn.windowsAuth ?? false,
          },
        });

        const raw = await ipc<string>("execute_query", {
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
        errors.push(toIpcError(e).message);
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
      background: "var(--bg)", color: "var(--text)", fontFamily: "var(--mono)",
      overflow: "hidden", boxSizing: "border-box",
    }}>

      {locked && <LockOverlay setLocked={setLocked} resetInactivityTimer={resetInactivityTimer} />}

      {contextMenu && <ConnectionContextMenu contextMenu={contextMenu} setContextMenu={setContextMenu} setEditingConnection={setEditingConnection} setShowAddForm={setShowAddForm} setDeletingConnection={setDeletingConnection} />}
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
              fontFamily: "var(--mono)",
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
                className="menu-item"
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
                className="menu-item"
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
                      className="menu-item"
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
                className="menu-item"
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
                    className="menu-item"
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
                className="menu-item"
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
                    objectName:    schemaContextMenu.name,
                    objectType:    schemaContextMenu.type,
                    schemaName:    schemaContextMenu.schema || "dbo",
                    params: {
                      credentialRef: conn.credentialRef,
                      engine:        conn.engine,
                      host:          conn.host,
                      port:          conn.port,
                      database:      conn.database,
                      username:      conn.username,
                      sslMode:       conn.sslMode ?? "prefer",
                      sqlInstance:   conn.sqlInstance ?? "",
                      windowsAuth:   conn.windowsAuth ?? false,
                    },
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
                className="menu-item"
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
              className="menu-item menu-item--danger"
            >
              🗑️ Drop {schemaContextMenu.type}
            </button>
          </div>
        </>
      )}
      {/* END Schema object context menu */}
      {deletingConnection && <DeleteConnectionDialog deletingConnection={deletingConnection} setDeletingConnection={setDeletingConnection} setTabs={setTabs} loadConnections={loadConnections} connectionsFolder={connectionsFolder} />}
      {dropConfirm && <DropObjectDialog dropConfirm={dropConfirm} setDropConfirm={setDropConfirm} purgeSchemaCache={purgeSchemaCache} schemaConnectionIdRef={schemaConnectionId} setSchema={setSchema} setExpandedTables={setExpandedTables} setExpandedSections={setExpandedSections} loadSchema={loadSchema} activeTabRef={activeTabRef} updateActiveTab={updateActiveTab} />}
      {killPending && <KillSessionDialog killPending={killPending} setKillPending={setKillPending} killActivity={killActivity} />}

      {showPalette && <CommandPalette setShowPalette={setShowPalette} paletteQuery={paletteQuery} setPaletteQuery={setPaletteQuery} paletteIndex={paletteIndex} setPaletteIndex={setPaletteIndex} filteredPalette={filteredPalette} />}
      {showSettings && <SettingsModal setShowSettings={setShowSettings} settingsDraft={settingsDraft} setSettingsDraft={setSettingsDraft} themePreference={themePreference} setThemePreference={setThemePreference} setSettings={setSettings} setAuditLogEnabled={setAuditLogEnabled} />}
        {saveQueryOpen && <SaveQueryModal saveQueryName={saveQueryName} setSaveQueryName={setSaveQueryName} saveQueryTags={saveQueryTags} setSaveQueryTags={setSaveQueryTags} saveQueryDesc={saveQueryDesc} setSaveQueryDesc={setSaveQueryDesc} handleSaveQuery={handleSaveQuery} setSaveQueryOpen={setSaveQueryOpen} />}
        {showDbeaverImport && <DbeaverImportModal setShowDbeaverImport={setShowDbeaverImport} dbeaverResult={dbeaverResult} setDbeaverResult={setDbeaverResult} handleDbeaverImport={handleDbeaverImport} dbeaverImporting={dbeaverImporting} />}
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
                  fontFamily: "var(--mono)",
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
                  fontFamily: "var(--mono)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {groupLabel}
                </span>
                <span style={microMutedLabel}>
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
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-disabled)", fontFamily: "var(--mono)" }}>
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
                                fontFamily: "var(--mono)", textTransform: "uppercase",
                                letterSpacing: ".06em", flex: 1,
                              }}>
                                Databases
                              </span>
                              <span style={microMutedLabel}>
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
                                    flex: 1, fontSize: 11, fontFamily: "var(--mono)",
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
                              <div style={{ padding: "6px 14px", fontSize: 11, color: "var(--text-disabled)", fontFamily: "var(--mono)" }}>
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
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--text-disabled)", fontFamily: "var(--mono)" }}>
                          Loading schema…
                        </div>
                      )}

                      {schema?.error && !(conn.sshEnabled && !tunnelPorts[conn.id]) && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--error)", fontFamily: "var(--mono)" }}>
                          {schema.error}
                        </div>
                      )}
                      {schema?.error && conn.sshEnabled && !tunnelPorts[conn.id] && (
                        <div style={{ padding: "8px 14px", fontSize: 11, color: "var(--warning)", fontFamily: "var(--mono)" }}>
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
                                  cursor: "pointer", fontSize: 10, fontFamily: "var(--mono)",
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
                                cursor: "pointer", fontSize: 10, fontFamily: "var(--mono)", padding: "2px 4px" }}
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
                                        fontFamily: "var(--mono)", flex: 1,
                                        fontWeight: 600, letterSpacing: ".03em",
                                      }}>
                                        {schemaName}
                                      </span>
                                      <span style={microMutedLabel}>
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
                                          fontFamily: "var(--mono)",
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
                                            fontFamily: "var(--mono)",
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
                                            whiteSpace: "nowrap", fontFamily: "var(--mono)",
                                          }}>
                                            {table.name}
                                          </span>
                                          <span style={microMutedLabel}>
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
                                                fontFamily: "var(--mono)", flex: 1,
                                                overflow: "hidden", textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                              }}>
                                                {col.name}
                                              </span>
                                              <span style={microMutedLabel}>
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
                                        whiteSpace: "nowrap", fontFamily: "var(--mono)",
                                      }}>
                                        {table.name}
                                      </span>
                                      <span style={microMutedLabel}>
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
                                            fontFamily: "var(--mono)", flex: 1,
                                            overflow: "hidden", textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                          }}>
                                            {col.name}
                                          </span>
                                          <span style={microMutedLabel}>
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
                                <span style={ellipsisLabel}>
                                  {proc.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)", flexShrink: 0 }}>
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
                                <span style={ellipsisLabel}>
                                  {fn.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)", flexShrink: 0 }}>
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
                                <span style={ellipsisLabel}>
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
                                <span style={ellipsisLabel}>
                                  {trigger.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)",
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
                                <span style={ellipsisLabel}>
                                  {idx.name}
                                </span>
                                <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)",
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
                      textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "var(--mono)",
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

      <SidebarFooter settings={settings} setSettingsDraft={setSettingsDraft} setShowSettings={setShowSettings} />

      {/* Sidebar resize handle */}
      <div
        onMouseDown={onSidebarDragStart}
        style={{ width: 4, cursor: "col-resize", background: "transparent", flexShrink: 0, transition: "background .15s", zIndex: 10 }}
        onMouseEnter={e => (e.currentTarget.style.background = "var(--accent-bg)")}
        onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
      />

      {/* Main content */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>

        <TabBar tabs={tabs} setTabs={setTabs} activeTabId={activeTabId} setActiveTabId={setActiveTabId} editorRef={editorRef} />

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
              fontSize: 11, fontFamily: "var(--mono)",
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
                textTransform: "uppercase", letterSpacing: ".05em", fontFamily: "var(--mono)",
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
              fontSize: 12, fontFamily: "var(--mono)", flexShrink: 0, whiteSpace: "nowrap",
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
                fontFamily: "var(--mono)",
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
              fontSize: 11, fontFamily: "var(--mono)",
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
              fontFamily: "var(--mono)",
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
              fontFamily: "var(--mono)",
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
                  fontFamily: "var(--mono)",
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
                        className="menu-item"
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
        
        {showHistory && <HistoryPanel activeTab={activeTab} history={history} setHistory={setHistory} setShowHistory={setShowHistory} editorRef={editorRef} />}

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
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--muted)", fontFamily: "var(--mono)", fontSize: 13 }}>
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
                    fontFamily: "var(--mono)",
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
                    fontFamily: "var(--mono)",
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
                      fontFamily: "var(--mono)",
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
                    fontFamily: "var(--mono)",
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
                  errorCode={activityErrorCode}
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
                      color: "var(--text-secondary)", fontSize: 13, fontFamily: "var(--mono)",
                    }}>
                      {result.rows[0]?.[0] ?? "Command completed successfully."}
                    </span>
                  </div>
                  {result.wasRewritten && (
                    <div style={{
                      fontSize: 11, color: "var(--warning)",
                      fontFamily: "var(--mono)", paddingLeft: 28,
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
