// ─────────────────────────────────────────────────────────────────────────
// Command palette — pure reducer (code-audit item A-1, final pass).
//
// Holds the palette's visibility, search query, and selection cursor. The
// combos are atomic: OPEN_PALETTE opens fresh (empty query, cursor at 0 —
// this replaces a reset-on-open useEffect); SET_QUERY resets the cursor;
// MOVE_SELECTION and CLAMP_SELECTION own the bounds arithmetic that used to
// live inline in keydown handlers. Pure — no DOM, no IPC.
// ─────────────────────────────────────────────────────────────────────────

export interface PaletteState {
  /** Whether the palette is open. */
  open: boolean;
  /** Fuzzy-search query. */
  query: string;
  /** Highlighted row index in the filtered list. */
  index: number;
}

export type PaletteAction =
  /** Open fresh: empty query, cursor at the top — atomically. */
  | { type: "OPEN_PALETTE" }
  | { type: "CLOSE_PALETTE" }
  /** Typing: set the query AND reset the cursor to the top — atomically. */
  | { type: "SET_QUERY"; query: string }
  /** Direct selection (mouse hover). */
  | { type: "SET_INDEX"; index: number }
  /** Arrow-key navigation, clamped to [0, max-1]. `max` = filtered list length. */
  | { type: "MOVE_SELECTION"; delta: number; max: number }
  /** Re-clamp after the filtered list shrinks under the cursor. */
  | { type: "CLAMP_SELECTION"; max: number };

/** Clamp an index into [0, max-1]; an empty list pins the cursor to 0. */
function clamp(index: number, max: number): number {
  if (max <= 0) return 0;
  return Math.min(Math.max(index, 0), max - 1);
}

export function paletteReducer(
  state: PaletteState,
  action: PaletteAction,
): PaletteState {
  switch (action.type) {
    case "OPEN_PALETTE":
      return { open: true, query: "", index: 0 };

    case "CLOSE_PALETTE":
      return { ...state, open: false };

    case "SET_QUERY":
      return { ...state, query: action.query, index: 0 };

    case "SET_INDEX":
      return { ...state, index: action.index };

    case "MOVE_SELECTION":
      return { ...state, index: clamp(state.index + action.delta, action.max) };

    case "CLAMP_SELECTION":
      return state.index >= action.max
        ? { ...state, index: clamp(state.index, action.max) }
        : state;

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — closed, empty, cursor at the top. */
export function initPaletteState(): PaletteState {
  return { open: false, query: "", index: 0 };
}
