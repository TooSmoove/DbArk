import { describe, it, expect } from "vitest";
import { paletteReducer, initPaletteState, type PaletteState } from "./paletteReducer";

function base(over: Partial<PaletteState> = {}): PaletteState {
  return { ...initPaletteState(), ...over };
}

describe("open/close", () => {
  it("OPEN_PALETTE opens FRESH: empty query, cursor at top — atomically", () => {
    const s = base({ open: false, query: "stale", index: 7 });
    expect(paletteReducer(s, { type: "OPEN_PALETTE" })).toEqual({ open: true, query: "", index: 0 });
  });
  it("CLOSE_PALETTE closes without clearing (open resets anyway)", () => {
    const s = base({ open: true, query: "q", index: 2 });
    const next = paletteReducer(s, { type: "CLOSE_PALETTE" });
    expect(next.open).toBe(false);
    expect(next.query).toBe("q");
  });
});

describe("typing", () => {
  it("SET_QUERY sets the query AND resets the cursor", () => {
    const s = base({ index: 5 });
    const next = paletteReducer(s, { type: "SET_QUERY", query: "conn" });
    expect(next.query).toBe("conn");
    expect(next.index).toBe(0);
  });
});

describe("navigation clamping", () => {
  it("MOVE_SELECTION +1 stops at the last row", () => {
    const s = base({ index: 4 });
    expect(paletteReducer(s, { type: "MOVE_SELECTION", delta: 1, max: 5 }).index).toBe(4);
    expect(paletteReducer(base({ index: 3 }), { type: "MOVE_SELECTION", delta: 1, max: 5 }).index).toBe(4);
  });
  it("MOVE_SELECTION -1 stops at 0", () => {
    expect(paletteReducer(base({ index: 0 }), { type: "MOVE_SELECTION", delta: -1, max: 5 }).index).toBe(0);
  });
  it("MOVE_SELECTION with an empty list pins to 0", () => {
    expect(paletteReducer(base({ index: 3 }), { type: "MOVE_SELECTION", delta: 1, max: 0 }).index).toBe(0);
  });
  it("SET_INDEX sets directly (hover)", () => {
    expect(paletteReducer(base(), { type: "SET_INDEX", index: 3 }).index).toBe(3);
  });
  it("CLAMP_SELECTION pulls a stranded cursor back to the last row", () => {
    // list shrank from 10 to 3 while the cursor sat on row 7
    expect(paletteReducer(base({ index: 7 }), { type: "CLAMP_SELECTION", max: 3 }).index).toBe(2);
  });
  it("CLAMP_SELECTION is a no-op when the cursor is in range (same object)", () => {
    const s = base({ index: 1 });
    expect(paletteReducer(s, { type: "CLAMP_SELECTION", max: 5 })).toBe(s);
  });
  it("CLAMP_SELECTION with an empty list pins to 0", () => {
    expect(paletteReducer(base({ index: 2 }), { type: "CLAMP_SELECTION", max: 0 }).index).toBe(0);
  });
});
