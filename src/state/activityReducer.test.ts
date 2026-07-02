import { describe, it, expect } from "vitest";
import {
  activityReducer,
  initActivityState,
  type ActivityState,
} from "./activityReducer";
import type { ActivityRow } from "../types";

function base(over: Partial<ActivityState> = {}): ActivityState {
  return { ...initActivityState(), ...over };
}

const row = { pid: "42", query: "SELECT 1" } as unknown as ActivityRow;

describe("initActivityState", () => {
  it("starts closed, empty, healthy", () => {
    const s = initActivityState();
    expect(s.showActivity).toBe(false);
    expect(s.rows).toEqual([]);
    expect(s.error).toBeNull();
    expect(s.errorCode).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.killPending).toBeNull();
  });
});

describe("panel visibility", () => {
  it("TOGGLE_ACTIVITY flips; SET_ACTIVITY_OPEN sets explicitly", () => {
    let s = activityReducer(base(), { type: "TOGGLE_ACTIVITY" });
    expect(s.showActivity).toBe(true);
    s = activityReducer(s, { type: "SET_ACTIVITY_OPEN", open: false });
    expect(s.showActivity).toBe(false);
  });
});

describe("load lifecycle (atomic transitions)", () => {
  it("LOAD_SUCCESS sets rows AND clears error + errorCode in one action", () => {
    const s = base({ error: "old failure", errorCode: "permission", rows: [] });
    const next = activityReducer(s, { type: "LOAD_SUCCESS", rows: [row] });
    expect(next.rows).toEqual([row]);
    expect(next.error).toBeNull();
    expect(next.errorCode).toBeNull();
  });
  it("LOAD_ERROR sets error + errorCode AND clears rows in one action", () => {
    const s = base({ rows: [row] });
    const next = activityReducer(s, { type: "LOAD_ERROR", error: "boom", code: "permission" });
    expect(next.error).toBe("boom");
    expect(next.errorCode).toBe("permission");
    expect(next.rows).toEqual([]);
  });
  it("LOAD_ERROR with a null code (SSH fail / transport catch)", () => {
    const next = activityReducer(base(), { type: "LOAD_ERROR", error: "SSH tunnel failed", code: null });
    expect(next.error).toBe("SSH tunnel failed");
    expect(next.errorCode).toBeNull();
  });
});

describe("silent-poll parity", () => {
  it("non-silent LOAD_START raises the spinner; LOAD_DONE lowers it", () => {
    let s = activityReducer(base(), { type: "LOAD_START", silent: false });
    expect(s.loading).toBe(true);
    s = activityReducer(s, { type: "LOAD_DONE", silent: false });
    expect(s.loading).toBe(false);
  });
  it("silent LOAD_START/LOAD_DONE never touch the spinner (the 5s poll must not flicker)", () => {
    // Poll while a non-silent load is somehow in flight: silent must not clear it.
    let s = base({ loading: true });
    s = activityReducer(s, { type: "LOAD_START", silent: true });
    expect(s.loading).toBe(true);
    s = activityReducer(s, { type: "LOAD_DONE", silent: true });
    expect(s.loading).toBe(true);
    // And from idle, a silent cycle never raises it.
    let idle = base({ loading: false });
    idle = activityReducer(idle, { type: "LOAD_START", silent: true });
    expect(idle.loading).toBe(false);
  });
});

describe("kill flow", () => {
  it("SET_KILL_PENDING opens and closes the confirm dialog", () => {
    let s = activityReducer(base(), { type: "SET_KILL_PENDING", row });
    expect(s.killPending).toBe(row);
    s = activityReducer(s, { type: "SET_KILL_PENDING", row: null });
    expect(s.killPending).toBeNull();
  });
  it("KILL_ERROR sets the error, clears the code, and KEEPS the rows", () => {
    const s = base({ rows: [row], errorCode: "permission" });
    const next = activityReducer(s, { type: "KILL_ERROR", error: "cannot kill" });
    expect(next.error).toBe("cannot kill");
    expect(next.errorCode).toBeNull();
    expect(next.rows).toEqual([row]); // list is still valid after a failed kill
  });
  it("CLEAR_ERROR clears both error fields", () => {
    const s = base({ error: "x", errorCode: "y" });
    const next = activityReducer(s, { type: "CLEAR_ERROR" });
    expect(next.error).toBeNull();
    expect(next.errorCode).toBeNull();
  });
  it("SET_ERROR sets the message only — errorCode and rows untouched (kill tunnel-fail parity)", () => {
    const s = base({ rows: [row], errorCode: "permission" });
    const next = activityReducer(s, { type: "SET_ERROR", error: "SSH tunnel failed" });
    expect(next.error).toBe("SSH tunnel failed");
    expect(next.errorCode).toBe("permission"); // deliberately untouched — original behavior
    expect(next.rows).toEqual([row]);
  });
});

describe("SET_ROWS (early-return clear)", () => {
  it("clears rows without touching errors", () => {
    const s = base({ rows: [row], error: "stale", errorCode: "c" });
    const next = activityReducer(s, { type: "SET_ROWS", rows: [] });
    expect(next.rows).toEqual([]);
    expect(next.error).toBe("stale"); // parity: the early return never cleared errors
  });
});
