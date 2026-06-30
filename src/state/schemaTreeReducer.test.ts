import { describe, it, expect } from "vitest";
import {
  schemaTreeReducer,
  initSchemaTreeState,
  type SchemaTreeState,
} from "./schemaTreeReducer";

function base(over: Partial<SchemaTreeState> = {}): SchemaTreeState {
  return { ...initSchemaTreeState(), ...over };
}

describe("initSchemaTreeState", () => {
  it("starts with only the public schema expanded", () => {
    const s = initSchemaTreeState();
    expect([...s.expandedSchemas]).toEqual(["public"]);
    expect(s.expandedTables.size).toBe(0);
    expect(s.expandedSections.size).toBe(0);
    expect(s.dbTreeCollapsed).toBe(false);
  });
});

describe("TOGGLE_TABLE / SCHEMA / SECTION", () => {
  it("adds a key when absent", () => {
    const s = base();
    const next = schemaTreeReducer(s, { type: "TOGGLE_TABLE", key: "public.users" });
    expect(next.expandedTables.has("public.users")).toBe(true);
  });
  it("removes a key when present", () => {
    const s = base({ expandedTables: new Set(["public.users"]) });
    const next = schemaTreeReducer(s, { type: "TOGGLE_TABLE", key: "public.users" });
    expect(next.expandedTables.has("public.users")).toBe(false);
  });
  it("toggles schema and section independently", () => {
    let s = base();
    s = schemaTreeReducer(s, { type: "TOGGLE_SCHEMA", key: "sales" });
    s = schemaTreeReducer(s, { type: "TOGGLE_SECTION", key: "Views" });
    expect(s.expandedSchemas.has("sales")).toBe(true);
    expect(s.expandedSections.has("Views")).toBe(true);
  });
  it("does not mutate the input set (immutability)", () => {
    const tables = new Set(["a"]);
    const s = base({ expandedTables: tables });
    schemaTreeReducer(s, { type: "TOGGLE_TABLE", key: "b" });
    expect([...tables]).toEqual(["a"]); // original untouched
  });
});

describe("db tree collapse", () => {
  it("TOGGLE_DB_TREE flips the flag", () => {
    expect(schemaTreeReducer(base({ dbTreeCollapsed: false }), { type: "TOGGLE_DB_TREE" }).dbTreeCollapsed).toBe(true);
    expect(schemaTreeReducer(base({ dbTreeCollapsed: true }), { type: "TOGGLE_DB_TREE" }).dbTreeCollapsed).toBe(false);
  });
  it("SET_DB_TREE_COLLAPSED sets it explicitly", () => {
    expect(schemaTreeReducer(base({ dbTreeCollapsed: true }), { type: "SET_DB_TREE_COLLAPSED", collapsed: false }).dbTreeCollapsed).toBe(false);
  });
});

describe("resets", () => {
  it("COLLAPSE_TABLES empties expandedTables only", () => {
    const s = base({ expandedTables: new Set(["a", "b"]), expandedSections: new Set(["X"]) });
    const next = schemaTreeReducer(s, { type: "COLLAPSE_TABLES" });
    expect(next.expandedTables.size).toBe(0);
    expect(next.expandedSections.has("X")).toBe(true); // untouched
  });
  it("COLLAPSE_SECTIONS empties expandedSections only", () => {
    const s = base({ expandedSections: new Set(["X"]), expandedTables: new Set(["a"]) });
    const next = schemaTreeReducer(s, { type: "COLLAPSE_SECTIONS" });
    expect(next.expandedSections.size).toBe(0);
    expect(next.expandedTables.has("a")).toBe(true);
  });
  it("RESET_SCHEMAS returns to {public}", () => {
    const s = base({ expandedSchemas: new Set(["sales", "hr"]) });
    const next = schemaTreeReducer(s, { type: "RESET_SCHEMAS" });
    expect([...next.expandedSchemas]).toEqual(["public"]);
  });
});
