import { useReducer, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionConfig, SchemaResult, ViewInfo, TriggerInfo, IndexInfo,
} from "../types";
import {
  schemaDataReducer, initSchemaDataState,
  type SchemaDataState, type SchemaDataAction,
} from "../state/schemaDataReducer";
import {
  schemaTreeReducer, initSchemaTreeState,
  type SchemaTreeState, type SchemaTreeAction,
} from "../state/schemaTreeReducer";

// Owns schema-explorer data + tree-view reducers, the per-connection schema and
// database-list caches, and the three IPC loaders. `openTunnel` is injected
// (it belongs to the connection layer). Extracted from App.tsx so schema
// browsing is one cohesive unit.
interface UseSchemaDeps {
  openTunnel: (conn: ConnectionConfig) => Promise<number | null>;
}

export interface UseSchema {
  schemaData:         SchemaDataState;
  dispatchSchema:     React.Dispatch<SchemaDataAction>;
  schemaTree:         SchemaTreeState;
  dispatchTree:       React.Dispatch<SchemaTreeAction>;
  loadSchema:         (conn: ConnectionConfig, database?: string) => Promise<void>;
  loadDatabases:      (conn: ConnectionConfig, preferredDb?: string) => Promise<void>;
  purgeSchemaCache:   (connId: string) => void;
  schemaCache:        React.MutableRefObject<Map<string, SchemaResult>>;
  dbListCache:        React.MutableRefObject<Map<string, string[]>>;
  schemaConnectionId: React.MutableRefObject<string | null>;
  schemaRef:          React.MutableRefObject<SchemaResult | null>;
}

export function useSchema({ openTunnel }: UseSchemaDeps): UseSchema {
  const [schemaData, dispatchSchema] = useReducer(schemaDataReducer, undefined, initSchemaDataState);
  const [schemaTree, dispatchTree]   = useReducer(schemaTreeReducer, undefined, initSchemaTreeState);

  const schemaCache        = useRef<Map<string, SchemaResult>>(new Map());
  const dbListCache        = useRef<Map<string, string[]>>(new Map());
  const schemaConnectionId = useRef<string | null>(null);
  const schemaRef          = useRef<SchemaResult | null>(null);

  // Mirror the latest schema into a ref for closures that need it without
  // re-subscribing (e.g. the command palette, query autocompletion).
  useEffect(() => { schemaRef.current = schemaData.schema; }, [schemaData.schema]);

  async function loadSchema(conn: ConnectionConfig, database?: string) {
    const db      = database ?? conn.database;
    const cacheKey = `${conn.id}::${db}`;

    if (schemaCache.current.has(cacheKey)) {
      dispatchSchema({ type: "SET_SCHEMA", schema: schemaCache.current.get(cacheKey)! });
      return;
    }

    if (schemaCache.current.size >= 5) {
      const firstKey = schemaCache.current.keys().next().value;
      schemaCache.current.delete(firstKey!);
    }

    dispatchTree({ type: "RESET_SCHEMAS" });
    dispatchSchema({ type: "SCHEMA_LOAD_START" });

    try {
      // Open SSH tunnel first if needed
      let tunnelPort: number | undefined;
      if (conn.sshEnabled) {
        const port = await openTunnel(conn);
        if (!port) {
          dispatchSchema({ type: "SET_SCHEMA", schema: { tables: [], procedures: [], functions: [], views: [], triggers: [], indexes: [], error: "SSH tunnel not open — run a query first to establish the tunnel" } });
          dispatchSchema({ type: "SET_SCHEMA_LOADING", loading: false });
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
      dispatchSchema({ type: "SET_SCHEMA", schema: parsed });
    } catch (e) {
      console.error("Schema load failed:", e);
    } finally {
      dispatchSchema({ type: "SET_SCHEMA_LOADING", loading: false });
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
  async function loadDatabases(conn: ConnectionConfig, preferredDb?: string) {
    const defaultDb = preferredDb ?? conn.database;

    // SQLite has no server-side database list — go straight to the schema.
    if (conn.engine === "sqlite") {
      dispatchSchema({ type: "SET_DATABASES", databases: [] });
      loadSchema(conn, defaultDb);
      return;
    }

    // Serve a cached list instantly, but still (re)load the schema.
    if (dbListCache.current.has(conn.id)) {
      dispatchSchema({ type: "SET_DATABASES", databases: dbListCache.current.get(conn.id)! });
      loadSchema(conn, defaultDb);
      return;
    }

    dispatchSchema({ type: "DATABASES_LOAD_START" });

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
      // enumeration query couldn't see it (permissions, or a system DB we
      // filtered out) — the user explicitly configured it, so it must be
      // browsable. Keep it first so it reads as the default.
      if (defaultDb && !list.includes(defaultDb)) {
        list = [defaultDb, ...list];
      }

      dbListCache.current.set(conn.id, list);
      dispatchSchema({ type: "SET_DATABASES", databases: list });
    } catch (e) {
      console.error("Database list load failed:", e);
      // Fall back to just the saved database so the user can still browse it.
      dispatchSchema({ type: "SET_DATABASES", databases: defaultDb ? [defaultDb] : [] });
    } finally {
      dispatchSchema({ type: "SET_DATABASES_LOADING", loading: false });
      loadSchema(conn, defaultDb);
    }
  }

  return {
    schemaData, dispatchSchema, schemaTree, dispatchTree,
    loadSchema, loadDatabases, purgeSchemaCache,
    schemaCache, dbListCache, schemaConnectionId, schemaRef,
  };
}
