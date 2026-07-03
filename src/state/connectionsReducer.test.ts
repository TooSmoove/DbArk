import { describe, it, expect } from "vitest";
import {
  connectionsReducer,
  initConnectionsState,
  toggledGroup,
  type ConnectionsState,
} from "./connectionsReducer";
import type { ConnectionConfig, ConnectionMenu, DbeaverImportResult } from "../types";

function base(over: Partial<ConnectionsState> = {}): ConnectionsState {
  return { ...initConnectionsState(), ...over };
}

const conn = { id: "c1", name: "local", engine: "postgres" } as unknown as ConnectionConfig;
const menu = { x: 10, y: 20, connection: conn } as ConnectionMenu;

describe("initConnectionsState", () => {
  it("starts empty with everything closed", () => {
    const s = initConnectionsState();
    expect(s.connections).toEqual([]);
    expect(s.showAddForm).toBe(false);
    expect(s.editingConnection).toBeNull();
    expect(s.deletingConnection).toBeNull();
    expect(s.contextMenu).toBeNull();
    expect(s.collapsedGroups.size).toBe(0);
    expect(s.showDbeaverImport).toBe(false);
    expect(s.dbeaverImporting).toBe(false);
    expect(s.dbeaverResult).toBeNull();
  });
});

describe("atomic form transitions", () => {
  it("OPEN_EDIT_FORM sets the editee, opens the form, AND closes the menu", () => {
    const s = base({ contextMenu: menu });
    const next = connectionsReducer(s, { type: "OPEN_EDIT_FORM", connection: conn });
    expect(next.editingConnection).toBe(conn);
    expect(next.showAddForm).toBe(true);
    expect(next.contextMenu).toBeNull();
  });
  it("CLOSE_FORM closes the form AND clears the editee", () => {
    const s = base({ showAddForm: true, editingConnection: conn });
    const next = connectionsReducer(s, { type: "CLOSE_FORM" });
    expect(next.showAddForm).toBe(false);
    expect(next.editingConnection).toBeNull();
  });
  it("TOGGLE_ADD_FORM flips the flag without touching editing state", () => {
    const s = base({ showAddForm: false, editingConnection: conn });
    const next = connectionsReducer(s, { type: "TOGGLE_ADD_FORM" });
    expect(next.showAddForm).toBe(true);
    expect(next.editingConnection).toBe(conn); // deliberately untouched (parity)
    expect(connectionsReducer(next, { type: "TOGGLE_ADD_FORM" }).showAddForm).toBe(false);
  });
});

describe("context menu + delete flow", () => {
  it("OPEN/CLOSE_CONTEXT_MENU", () => {
    let s = connectionsReducer(base(), { type: "OPEN_CONTEXT_MENU", menu });
    expect(s.contextMenu).toBe(menu);
    s = connectionsReducer(s, { type: "CLOSE_CONTEXT_MENU" });
    expect(s.contextMenu).toBeNull();
  });
  it("REQUEST_DELETE opens the confirm dialog AND closes the menu", () => {
    const s = base({ contextMenu: menu });
    const next = connectionsReducer(s, { type: "REQUEST_DELETE", connection: conn });
    expect(next.deletingConnection).toBe(conn);
    expect(next.contextMenu).toBeNull();
  });
  it("CLOSE_DELETE clears only the pending delete", () => {
    const s = base({ deletingConnection: conn, showAddForm: true });
    const next = connectionsReducer(s, { type: "CLOSE_DELETE" });
    expect(next.deletingConnection).toBeNull();
    expect(next.showAddForm).toBe(true);
  });
});

describe("collapsed groups", () => {
  it("toggledGroup adds an absent group and removes a present one, immutably", () => {
    const groups = new Set(["Production"]);
    const added = toggledGroup(groups, "Staging");
    expect(added.has("Staging")).toBe(true);
    const removed = toggledGroup(added, "Production");
    expect(removed.has("Production")).toBe(false);
    expect([...groups]).toEqual(["Production"]); // input untouched
  });
  it("SET_COLLAPSED_GROUPS replaces the set (restore-from-storage path)", () => {
    const restored = new Set(["Prod", "Local"]);
    const next = connectionsReducer(base(), { type: "SET_COLLAPSED_GROUPS", groups: restored });
    expect(next.collapsedGroups).toBe(restored);
  });
});

describe("DBeaver import lifecycle", () => {
  const result: DbeaverImportResult = { imported: [], skipped: ["dup"], error: undefined };
  it("IMPORT_START raises the flag; IMPORT_DONE lowers it; result is separate", () => {
    let s = connectionsReducer(base(), { type: "IMPORT_START" });
    expect(s.dbeaverImporting).toBe(true);
    s = connectionsReducer(s, { type: "SET_IMPORT_RESULT", result });
    expect(s.dbeaverResult).toBe(result);
    s = connectionsReducer(s, { type: "IMPORT_DONE" });
    expect(s.dbeaverImporting).toBe(false);
    expect(s.dbeaverResult).toBe(result); // done does not clear the result
  });
  it("CLOSE_IMPORT closes the modal AND clears the result atomically", () => {
    const s = base({ showDbeaverImport: true, dbeaverResult: result });
    const next = connectionsReducer(s, { type: "CLOSE_IMPORT" });
    expect(next.showDbeaverImport).toBe(false);
    expect(next.dbeaverResult).toBeNull();
  });
  it("SET_IMPORT_OPEN(false) closes WITHOUT clearing the result (plain close)", () => {
    const s = base({ showDbeaverImport: true, dbeaverResult: result });
    const next = connectionsReducer(s, { type: "SET_IMPORT_OPEN", open: false });
    expect(next.showDbeaverImport).toBe(false);
    expect(next.dbeaverResult).toBe(result); // parity with the original close button
  });
});

describe("plain setters", () => {
  it("SET_CONNECTIONS and SET_CONNECTIONS_FOLDER", () => {
    let s = connectionsReducer(base(), { type: "SET_CONNECTIONS", connections: [conn] });
    s = connectionsReducer(s, { type: "SET_CONNECTIONS_FOLDER", folder: "/home/u/.dbark/connections" });
    expect(s.connections).toEqual([conn]);
    expect(s.connectionsFolder).toBe("/home/u/.dbark/connections");
  });
});

describe("SSH tunnel state", () => {
  it("SET_TUNNEL_LOADING merges per-connection flags", () => {
    let s = connectionsReducer(base(), { type: "SET_TUNNEL_LOADING", connId: "c1", loading: true });
    s = connectionsReducer(s, { type: "SET_TUNNEL_LOADING", connId: "c2", loading: true });
    s = connectionsReducer(s, { type: "SET_TUNNEL_LOADING", connId: "c1", loading: false });
    expect(s.tunnelLoading).toEqual({ c1: false, c2: true });
  });
  it("SET_TUNNEL_PORTS replaces the map", () => {
    const s = connectionsReducer(base(), { type: "SET_TUNNEL_PORTS", ports: { c1: 15432 } });
    expect(s.tunnelPorts).toEqual({ c1: 15432 });
  });
});
