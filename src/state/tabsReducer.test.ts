import { describe, it, expect } from "vitest";
import { tabsReducer, initTabsState, type TabsState } from "./tabsReducer";
import { createTab } from "../appState";
import type { Tab } from "../types";

function tab(id: string, over: Partial<Tab> = {}): Tab {
  return { ...createTab(id), ...over };
}
function state(tabs: Tab[], activeTabId = tabs[0].id): TabsState {
  return { tabs, activeTabId };
}

describe("initTabsState", () => {
  it("starts with one active empty tab", () => {
    const s = initTabsState();
    expect(s.tabs).toHaveLength(1);
    expect(s.activeTabId).toBe(s.tabs[0].id);
    expect(s.tabs[0].sql).toBe("");
  });
});

describe("SET_ACTIVE", () => {
  it("changes the active id without touching tabs", () => {
    const s = state([tab("a"), tab("b")]);
    const next = tabsReducer(s, { type: "SET_ACTIVE", id: "b" });
    expect(next.activeTabId).toBe("b");
    expect(next.tabs).toBe(s.tabs); // same reference — tabs untouched
  });
});

describe("UPDATE_TAB", () => {
  it("merges updates into the matching tab only", () => {
    const s = state([tab("a", { sql: "x" }), tab("b", { sql: "y" })]);
    const next = tabsReducer(s, { type: "UPDATE_TAB", id: "b", updates: { sql: "Z" } });
    expect(next.tabs.find(t => t.id === "b")!.sql).toBe("Z");
    expect(next.tabs.find(t => t.id === "a")!.sql).toBe("x");
  });
  it("is a no-op when id does not match (faithful editorRef-quirk behavior)", () => {
    const s = state([tab("a"), tab("b")]);
    const next = tabsReducer(s, { type: "UPDATE_TAB", id: "no-such-id", updates: { sql: "Z" } });
    expect(next.tabs.map(t => t.sql)).toEqual(["", ""]);
  });
});

describe("UPDATE_ACTIVE_TAB", () => {
  it("targets whichever tab is active", () => {
    const s = state([tab("a"), tab("b")], "b");
    const next = tabsReducer(s, { type: "UPDATE_ACTIVE_TAB", updates: { loading: true } });
    expect(next.tabs.find(t => t.id === "b")!.loading).toBe(true);
    expect(next.tabs.find(t => t.id === "a")!.loading).toBe(false);
  });
});

describe("APPEND_ACTIVATE", () => {
  it("appends a tab and activates it", () => {
    const s = state([tab("a")]);
    const next = tabsReducer(s, { type: "APPEND_ACTIVATE", tab: tab("b") });
    expect(next.tabs.map(t => t.id)).toEqual(["a", "b"]);
    expect(next.activeTabId).toBe("b");
  });
  it("persists saveSql into saveToId before appending", () => {
    const s = state([tab("a", { sql: "old" })]);
    const next = tabsReducer(s, {
      type: "APPEND_ACTIVATE", tab: tab("b", { sql: "new" }), saveToId: "a", saveSql: "typed",
    });
    expect(next.tabs.find(t => t.id === "a")!.sql).toBe("typed");
    expect(next.tabs.find(t => t.id === "b")!.sql).toBe("new");
    expect(next.activeTabId).toBe("b");
  });
});

describe("CLOSE", () => {
  it("never closes the last remaining tab", () => {
    const s = state([tab("a")]);
    expect(tabsReducer(s, { type: "CLOSE", closeId: "a" })).toBe(s);
  });
  it("removes a non-active tab and keeps the active one", () => {
    const s = state([tab("a"), tab("b"), tab("c")], "a");
    const next = tabsReducer(s, { type: "CLOSE", closeId: "c" });
    expect(next.tabs.map(t => t.id)).toEqual(["a", "b"]);
    expect(next.activeTabId).toBe("a");
  });
  it("reselects the neighbour at the same index when closing the active tab", () => {
    const s = state([tab("a"), tab("b"), tab("c")], "b");
    const next = tabsReducer(s, { type: "CLOSE", closeId: "b" });
    expect(next.tabs.map(t => t.id)).toEqual(["a", "c"]);
    expect(next.activeTabId).toBe("c"); // min(idx=1, len=1) → index 1 → "c"
  });
  it("clamps reselection when closing the last (rightmost) active tab", () => {
    const s = state([tab("a"), tab("b"), tab("c")], "c");
    const next = tabsReducer(s, { type: "CLOSE", closeId: "c" });
    expect(next.activeTabId).toBe("b"); // min(idx=2, len-1=1) → index 1 → "b"
  });
  it("persists saveSql into the active tab before closing", () => {
    const s = state([tab("a", { sql: "old" }), tab("b")], "a");
    const next = tabsReducer(s, { type: "CLOSE", closeId: "b", saveSql: "typed" });
    expect(next.tabs.find(t => t.id === "a")!.sql).toBe("typed");
  });
  it("applies saveSql but removes nothing when closeId is absent (faithful quirk)", () => {
    const s = state([tab("a", { sql: "old" }), tab("b")], "a");
    const next = tabsReducer(s, { type: "CLOSE", closeId: "ghost", saveSql: "typed" });
    expect(next.tabs.map(t => t.id)).toEqual(["a", "b"]);
    expect(next.tabs.find(t => t.id === "a")!.sql).toBe("typed");
    expect(next.activeTabId).toBe("a");
  });
});

describe("TOGGLE_JOIN_TABLE", () => {
  it("attaches a table that is not present", () => {
    const s = state([tab("a", { joinTables: [] })]);
    const next = tabsReducer(s, { type: "TOGGLE_JOIN_TABLE", id: "a", table: "orders", attach: true });
    expect(next.tabs[0].joinTables).toEqual(["orders"]);
  });
  it("detaches a present table", () => {
    const s = state([tab("a", { joinTables: ["orders", "users"] })]);
    const next = tabsReducer(s, { type: "TOGGLE_JOIN_TABLE", id: "a", table: "orders", attach: false });
    expect(next.tabs[0].joinTables).toEqual(["users"]);
  });
  it("is a no-op when attach state already matches (no needless re-render churn)", () => {
    const s = state([tab("a", { joinTables: ["orders"] })]);
    const next = tabsReducer(s, { type: "TOGGLE_JOIN_TABLE", id: "a", table: "orders", attach: true });
    expect(next.tabs[0]).toBe(s.tabs[0]); // same tab reference returned
  });
});

describe("APPLY_TABS / APPLY_ACTIVE (useState-compatible passthroughs)", () => {
  it("APPLY_TABS accepts a plain value", () => {
    const s = state([tab("a")]);
    const next = tabsReducer(s, { type: "APPLY_TABS", updater: [tab("a"), tab("b")] });
    expect(next.tabs.map(t => t.id)).toEqual(["a", "b"]);
  });
  it("APPLY_TABS accepts an updater function (prev => next)", () => {
    const s = state([tab("a"), tab("b")]);
    const next = tabsReducer(s, {
      type: "APPLY_TABS",
      updater: prev => prev.filter(t => t.id !== "a"),
    });
    expect(next.tabs.map(t => t.id)).toEqual(["b"]);
  });
  it("APPLY_ACTIVE accepts a value and an updater", () => {
    const s = state([tab("a"), tab("b")], "a");
    expect(tabsReducer(s, { type: "APPLY_ACTIVE", updater: "b" }).activeTabId).toBe("b");
    expect(tabsReducer(s, { type: "APPLY_ACTIVE", updater: () => "b" }).activeTabId).toBe("b");
  });
});

describe("immutability", () => {
  it("never mutates the input state or tabs array", () => {
    const s = state([tab("a"), tab("b")]);
    const snapshot = JSON.stringify(s);
    tabsReducer(s, { type: "UPDATE_TAB", id: "a", updates: { sql: "changed" } });
    tabsReducer(s, { type: "CLOSE", closeId: "b" });
    tabsReducer(s, { type: "APPEND_ACTIVATE", tab: tab("c") });
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});
