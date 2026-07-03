import { describe, it, expect } from "vitest";
import {
  savedQueriesReducer,
  initSavedQueriesState,
  type SavedQueriesState,
  type SavedQuery,
} from "./savedQueriesReducer";

function base(over: Partial<SavedQueriesState> = {}): SavedQueriesState {
  return { ...initSavedQueriesState(), ...over };
}

const entry: SavedQuery = {
  id: "top-customers",
  sql: "SELECT * FROM customers",
  meta: {
    name: "Top customers",
    description: null,
    tags: ["sales"],
    engine_hint: "postgres",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
};

describe("initSavedQueriesState", () => {
  it("starts closed and empty", () => {
    const s = initSavedQueriesState();
    expect(s.saveOpen).toBe(false);
    expect(s.name).toBe("");
    expect(s.tags).toBe("");
    expect(s.desc).toBe("");
    expect(s.queries).toEqual([]);
    expect(s.search).toBe("");
    expect(s.showLibrary).toBe(false);
  });
});

describe("save dialog", () => {
  it("SET_SAVE_OPEN opens and closes without touching the form", () => {
    const s = base({ name: "draft" });
    let next = savedQueriesReducer(s, { type: "SET_SAVE_OPEN", open: true });
    expect(next.saveOpen).toBe(true);
    expect(next.name).toBe("draft"); // Escape/Cancel keep typed values (parity)
    next = savedQueriesReducer(next, { type: "SET_SAVE_OPEN", open: false });
    expect(next.saveOpen).toBe(false);
    expect(next.name).toBe("draft");
  });
  it("UPDATE_FORM merges single-field patches", () => {
    let s = base();
    s = savedQueriesReducer(s, { type: "UPDATE_FORM", patch: { name: "My query" } });
    s = savedQueriesReducer(s, { type: "UPDATE_FORM", patch: { tags: "a, b" } });
    s = savedQueriesReducer(s, { type: "UPDATE_FORM", patch: { desc: "notes" } });
    expect(s.name).toBe("My query");
    expect(s.tags).toBe("a, b");
    expect(s.desc).toBe("notes");
  });
  it("SAVE_COMPLETE closes the dialog AND clears all three fields atomically", () => {
    const s = base({ saveOpen: true, name: "My query", tags: "a", desc: "d" });
    const next = savedQueriesReducer(s, { type: "SAVE_COMPLETE" });
    expect(next.saveOpen).toBe(false);
    expect(next.name).toBe("");
    expect(next.tags).toBe("");
    expect(next.desc).toBe("");
  });
  it("SAVE_COMPLETE leaves the library state alone (refresh arrives separately)", () => {
    const s = base({ queries: [entry], search: "top", showLibrary: true });
    const next = savedQueriesReducer(s, { type: "SAVE_COMPLETE" });
    expect(next.queries).toEqual([entry]);
    expect(next.search).toBe("top");
    expect(next.showLibrary).toBe(true);
  });
});

describe("library", () => {
  it("SET_QUERIES replaces the entries", () => {
    const next = savedQueriesReducer(base(), { type: "SET_QUERIES", queries: [entry] });
    expect(next.queries).toEqual([entry]);
  });
  it("SET_SEARCH sets the filter text", () => {
    expect(savedQueriesReducer(base(), { type: "SET_SEARCH", search: "cust" }).search).toBe("cust");
  });
  it("TOGGLE_LIBRARY flips visibility", () => {
    let s = savedQueriesReducer(base(), { type: "TOGGLE_LIBRARY" });
    expect(s.showLibrary).toBe(true);
    s = savedQueriesReducer(s, { type: "TOGGLE_LIBRARY" });
    expect(s.showLibrary).toBe(false);
  });
});
