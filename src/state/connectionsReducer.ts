// ─────────────────────────────────────────────────────────────────────────
// Connection manager — pure reducer (code-audit item A-1).
//
// Holds the connection list, the TOML folder path, the add/edit form, the
// right-click menu, the delete confirmation, sidebar group collapse, and the
// DBeaver import flow. The multi-setter sequences that used to live at the
// call sites ("set editing + open form + close menu") are now single atomic
// actions. Pure — no DOM, no IPC, no localStorage (persistence of
// collapsedGroups happens at the dispatch site via `toggledGroup`).
// ─────────────────────────────────────────────────────────────────────────

import type { ConnectionConfig, ConnectionMenu, DbeaverImportResult } from "../types";

export interface ConnectionsState {
  /** Connections parsed from the TOML folder. */
  connections: ConnectionConfig[];
  /** Absolute path of ~/.dbark/connections. */
  connectionsFolder: string;
  /** Whether the add/edit connection form is open. */
  showAddForm: boolean;
  /** Connection being edited in the form (null = the form adds a new one). */
  editingConnection: ConnectionConfig | null;
  /** Connection pending delete confirmation (null = dialog closed). */
  deletingConnection: ConnectionConfig | null;
  /** Right-click menu on a sidebar connection (null = closed). */
  contextMenu: ConnectionMenu | null;
  /** Collapsed sidebar group names (persisted to localStorage by the caller). */
  collapsedGroups: Set<string>;
  /** DBeaver import modal open flag, in-flight flag, and result. */
  showDbeaverImport: boolean;
  dbeaverImporting: boolean;
  dbeaverResult: DbeaverImportResult | null;
}

export type ConnectionsAction =
  | { type: "SET_CONNECTIONS"; connections: ConnectionConfig[] }
  | { type: "SET_CONNECTIONS_FOLDER"; folder: string }
  /** The sidebar "+" button: flips the form without touching editing state. */
  | { type: "TOGGLE_ADD_FORM" }
  /** Context menu "Edit": set the editee, open the form, close the menu — atomically. */
  | { type: "OPEN_EDIT_FORM"; connection: ConnectionConfig }
  /** Form save/cancel: close the form and clear the editee — atomically. */
  | { type: "CLOSE_FORM" }
  | { type: "OPEN_CONTEXT_MENU"; menu: ConnectionMenu }
  | { type: "CLOSE_CONTEXT_MENU" }
  /** Context menu "Delete": open the confirm dialog and close the menu — atomically. */
  | { type: "REQUEST_DELETE"; connection: ConnectionConfig }
  | { type: "CLOSE_DELETE" }
  | { type: "SET_COLLAPSED_GROUPS"; groups: Set<string> }
  | { type: "SET_IMPORT_OPEN"; open: boolean }
  /** Import modal dismiss: close AND clear the previous result — atomically. */
  | { type: "CLOSE_IMPORT" }
  | { type: "IMPORT_START" }
  | { type: "SET_IMPORT_RESULT"; result: DbeaverImportResult }
  | { type: "IMPORT_DONE" };

/**
 * Toggle a group's membership, returning a new set. Exported so the dispatch
 * site can persist the exact value it dispatches (localStorage is a side
 * effect and must not live inside the reducer).
 */
export function toggledGroup(groups: Set<string>, group: string): Set<string> {
  const next = new Set(groups);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  return next;
}

export function connectionsReducer(
  state: ConnectionsState,
  action: ConnectionsAction,
): ConnectionsState {
  switch (action.type) {
    case "SET_CONNECTIONS":
      return { ...state, connections: action.connections };

    case "SET_CONNECTIONS_FOLDER":
      return { ...state, connectionsFolder: action.folder };

    case "TOGGLE_ADD_FORM":
      return { ...state, showAddForm: !state.showAddForm };

    case "OPEN_EDIT_FORM":
      return {
        ...state,
        editingConnection: action.connection,
        showAddForm: true,
        contextMenu: null,
      };

    case "CLOSE_FORM":
      return { ...state, showAddForm: false, editingConnection: null };

    case "OPEN_CONTEXT_MENU":
      return { ...state, contextMenu: action.menu };

    case "CLOSE_CONTEXT_MENU":
      return { ...state, contextMenu: null };

    case "REQUEST_DELETE":
      return { ...state, deletingConnection: action.connection, contextMenu: null };

    case "CLOSE_DELETE":
      return { ...state, deletingConnection: null };

    case "SET_COLLAPSED_GROUPS":
      return { ...state, collapsedGroups: action.groups };

    case "SET_IMPORT_OPEN":
      return { ...state, showDbeaverImport: action.open };

    case "CLOSE_IMPORT":
      return { ...state, showDbeaverImport: false, dbeaverResult: null };

    case "IMPORT_START":
      return { ...state, dbeaverImporting: true };

    case "SET_IMPORT_RESULT":
      return { ...state, dbeaverResult: action.result };

    case "IMPORT_DONE":
      return { ...state, dbeaverImporting: false };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — no connections loaded, everything closed. */
export function initConnectionsState(): ConnectionsState {
  return {
    connections: [],
    connectionsFolder: "",
    showAddForm: false,
    editingConnection: null,
    deletingConnection: null,
    contextMenu: null,
    collapsedGroups: new Set(),
    showDbeaverImport: false,
    dbeaverImporting: false,
    dbeaverResult: null,
  };
}
