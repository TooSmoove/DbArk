import { describe, it, expect } from "vitest";
import {
  schemaDataReducer,
  initSchemaDataState,
  type SchemaDataState,
} from "./schemaDataReducer";
import type { SchemaResult, SchemaContextMenu, DropConfirm, ConnectionConfig } from "../types";

function base(over: Partial<SchemaDataState> = {}): SchemaDataState {
  return { ...initSchemaDataState(), ...over };
}

const fakeSchema = { tables: [], procedures: [], functions: [], views: [], triggers: [], indexes: [] } as unknown as SchemaResult;
const fakeConn = { id: "c1", name: "local", engine: "postgres" } as unknown as ConnectionConfig;

describe("initSchemaDataState", () => {
  it("starts unloaded with both menus closed", () => {
    const s = initSchemaDataState();
    expect(s.schema).toBeNull();
    expect(s.schemaLoading).toBe(false);
    expect(s.databases).toEqual([]);
    expect(s.databasesLoading).toBe(false);
    expect(s.dbFilter).toBe("");
    expect(s.schemaContextMenu).toBeNull();
    expect(s.dropConfirm).toBeNull();
  });
});

describe("SCHEMA_LOAD_START (atomic transition)", () => {
  it("clears the old schema AND raises the loading flag in one action", () => {
    const s = base({ schema: fakeSchema, schemaLoading: false });
    const next = schemaDataReducer(s, { type: "SCHEMA_LOAD_START" });
    expect(next.schema).toBeNull();
    expect(next.schemaLoading).toBe(true);
  });
  it("leaves databases and menus untouched", () => {
    const menu = { x: 1, y: 2, name: "t", type: "table", schema: "public", connection: fakeConn } as SchemaContextMenu;
    const s = base({ databases: ["db1"], schemaContextMenu: menu });
    const next = schemaDataReducer(s, { type: "SCHEMA_LOAD_START" });
    expect(next.databases).toEqual(["db1"]);
    expect(next.schemaContextMenu).toBe(menu);
  });
});

describe("DATABASES_LOAD_START (atomic transition)", () => {
  it("clears the list AND raises the loading flag in one action", () => {
    const s = base({ databases: ["old"], databasesLoading: false });
    const next = schemaDataReducer(s, { type: "DATABASES_LOAD_START" });
    expect(next.databases).toEqual([]);
    expect(next.databasesLoading).toBe(true);
  });
  it("does not touch the schema", () => {
    const s = base({ schema: fakeSchema });
    expect(schemaDataReducer(s, { type: "DATABASES_LOAD_START" }).schema).toBe(fakeSchema);
  });
});

describe("plain setters", () => {
  it("SET_SCHEMA stores a result (loading flag is separate)", () => {
    const s = base({ schemaLoading: true });
    const next = schemaDataReducer(s, { type: "SET_SCHEMA", schema: fakeSchema });
    expect(next.schema).toBe(fakeSchema);
    expect(next.schemaLoading).toBe(true); // deliberately untouched
  });
  it("SET_SCHEMA_LOADING / SET_DATABASES_LOADING flip their flags only", () => {
    let s = base({ schemaLoading: true, databasesLoading: true });
    s = schemaDataReducer(s, { type: "SET_SCHEMA_LOADING", loading: false });
    s = schemaDataReducer(s, { type: "SET_DATABASES_LOADING", loading: false });
    expect(s.schemaLoading).toBe(false);
    expect(s.databasesLoading).toBe(false);
  });
  it("SET_DATABASES replaces the list; SET_DB_FILTER sets the filter", () => {
    let s = base();
    s = schemaDataReducer(s, { type: "SET_DATABASES", databases: ["a", "b"] });
    s = schemaDataReducer(s, { type: "SET_DB_FILTER", filter: "a" });
    expect(s.databases).toEqual(["a", "b"]);
    expect(s.dbFilter).toBe("a");
  });
});

describe("menus", () => {
  it("SET_SCHEMA_MENU opens and closes the context menu", () => {
    const menu = { x: 10, y: 20, name: "users", type: "table", schema: "public", connection: fakeConn } as SchemaContextMenu;
    let s = schemaDataReducer(base(), { type: "SET_SCHEMA_MENU", menu });
    expect(s.schemaContextMenu).toBe(menu);
    s = schemaDataReducer(s, { type: "SET_SCHEMA_MENU", menu: null });
    expect(s.schemaContextMenu).toBeNull();
  });
  it("SET_DROP_CONFIRM opens and closes the drop dialog", () => {
    const dc = { name: "users", type: "table", schema: "public", tableName: "", dropSql: "DROP TABLE users", connection: fakeConn } as DropConfirm;
    let s = schemaDataReducer(base(), { type: "SET_DROP_CONFIRM", dropConfirm: dc });
    expect(s.dropConfirm).toBe(dc);
    s = schemaDataReducer(s, { type: "SET_DROP_CONFIRM", dropConfirm: null });
    expect(s.dropConfirm).toBeNull();
  });
});
