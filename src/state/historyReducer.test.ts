import { describe, it, expect } from "vitest";
import { historyReducer, initHistoryState } from "./historyReducer";
import type { HistoryEntry } from "../types";

const entry = { id: 1, sql: "SELECT 1" } as unknown as HistoryEntry;

describe("historyReducer", () => {
  it("starts closed and empty", () => {
    expect(initHistoryState()).toEqual({ open: false, entries: [] });
  });
  it("TOGGLE_HISTORY flips; SET_HISTORY_OPEN sets explicitly", () => {
    let s = historyReducer(initHistoryState(), { type: "TOGGLE_HISTORY" });
    expect(s.open).toBe(true);
    s = historyReducer(s, { type: "SET_HISTORY_OPEN", open: false });
    expect(s.open).toBe(false);
  });
  it("SET_ENTRIES replaces; CLEAR_ENTRIES empties without closing", () => {
    let s = historyReducer({ open: true, entries: [] }, { type: "SET_ENTRIES", entries: [entry] });
    expect(s.entries).toEqual([entry]);
    s = historyReducer(s, { type: "CLEAR_ENTRIES" });
    expect(s.entries).toEqual([]);
    expect(s.open).toBe(true); // clearing the log keeps the panel open (parity)
  });
});
