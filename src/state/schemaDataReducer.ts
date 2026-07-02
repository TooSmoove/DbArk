// ─────────────────────────────────────────────────────────────────────────
// Schema-explorer data + menus — pure reducer (code-audit item A-1).
//
// Holds the async-loaded schema/database data, their loading flags, the
// database filter, and the two schema-explorer menus (right-click context
// menu + drop confirmation). The LOAD_START actions make the
// "clear data + raise loading flag" transition atomic — previously two
// separate setState calls that could interleave with renders. Pure — no
// DOM, no IPC.
// ─────────────────────────────────────────────────────────────────────────

import type { SchemaResult, SchemaContextMenu, DropConfirm } from "../types";

export interface SchemaDataState {
  /** Parsed schema for the active connection/database (null while unloaded). */
  schema: SchemaResult | null;
  schemaLoading: boolean;
  /** Server-side database list for the active connection. */
  databases: string[];
  databasesLoading: boolean;
  /** Filter text for the database list. */
  dbFilter: string;
  /** Right-click context menu on a schema object (null = closed). */
  schemaContextMenu: SchemaContextMenu | null;
  /** Drop-object confirmation dialog (null = closed). */
  dropConfirm: DropConfirm | null;
}

export type SchemaDataAction =
  /** Begin loading a schema: clears the old schema and raises the flag atomically. */
  | { type: "SCHEMA_LOAD_START" }
  | { type: "SET_SCHEMA"; schema: SchemaResult | null }
  | { type: "SET_SCHEMA_LOADING"; loading: boolean }
  /** Begin loading the database list: clears it and raises the flag atomically. */
  | { type: "DATABASES_LOAD_START" }
  | { type: "SET_DATABASES"; databases: string[] }
  | { type: "SET_DATABASES_LOADING"; loading: boolean }
  | { type: "SET_DB_FILTER"; filter: string }
  | { type: "SET_SCHEMA_MENU"; menu: SchemaContextMenu | null }
  | { type: "SET_DROP_CONFIRM"; dropConfirm: DropConfirm | null };

export function schemaDataReducer(
  state: SchemaDataState,
  action: SchemaDataAction,
): SchemaDataState {
  switch (action.type) {
    case "SCHEMA_LOAD_START":
      return { ...state, schema: null, schemaLoading: true };

    case "SET_SCHEMA":
      return { ...state, schema: action.schema };

    case "SET_SCHEMA_LOADING":
      return { ...state, schemaLoading: action.loading };

    case "DATABASES_LOAD_START":
      return { ...state, databases: [], databasesLoading: true };

    case "SET_DATABASES":
      return { ...state, databases: action.databases };

    case "SET_DATABASES_LOADING":
      return { ...state, databasesLoading: action.loading };

    case "SET_DB_FILTER":
      return { ...state, dbFilter: action.filter };

    case "SET_SCHEMA_MENU":
      return { ...state, schemaContextMenu: action.menu };

    case "SET_DROP_CONFIRM":
      return { ...state, dropConfirm: action.dropConfirm };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — nothing loaded, no filter, both menus closed. */
export function initSchemaDataState(): SchemaDataState {
  return {
    schema: null,
    schemaLoading: false,
    databases: [],
    databasesLoading: false,
    dbFilter: "",
    schemaContextMenu: null,
    dropConfirm: null,
  };
}
