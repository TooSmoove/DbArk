// ─────────────────────────────────────────────────────────────────────────
// Saved queries — pure reducer (code-audit item A-1).
//
// Holds the Cmd+S save dialog (visibility + three form fields) and the query
// library panel (entries, search text, visibility). SAVE_COMPLETE is the
// atomic transition: close the dialog AND clear all three fields in one
// action — previously four consecutive setState calls in the save handler.
// The save_query/list_queries/delete_query IPC stays at the dispatch sites.
// Pure — no DOM, no IPC.
//
// Also retires the `any[]` typing on the library entries: SavedQuery mirrors
// the meta object handleSaveQuery builds and list_queries returns.
// ─────────────────────────────────────────────────────────────────────────

export interface SavedQueryMeta {
  name: string;
  description: string | null;
  tags: string[];
  engine_hint: string | null;
  created_at: string;
  updated_at: string;
}

export interface SavedQuery {
  id: string;
  sql: string;
  meta: SavedQueryMeta;
}

export interface SavedQueriesState {
  /** Whether the Cmd+S save dialog is open. */
  saveOpen: boolean;
  /** Save-dialog form fields. */
  name: string;
  tags: string;
  desc: string;
  /** Library entries from list_queries. */
  queries: SavedQuery[];
  /** Library search text. */
  search: string;
  /** Whether the sidebar shows the query library. */
  showLibrary: boolean;
}

export type SavedQueriesAction =
  | { type: "SET_SAVE_OPEN"; open: boolean }
  /** Merge edited form fields (name / tags / desc). */
  | { type: "UPDATE_FORM"; patch: Partial<Pick<SavedQueriesState, "name" | "tags" | "desc">> }
  /** Save succeeded: close the dialog AND clear all three fields — atomically. */
  | { type: "SAVE_COMPLETE" }
  | { type: "SET_QUERIES"; queries: SavedQuery[] }
  | { type: "SET_SEARCH"; search: string }
  | { type: "TOGGLE_LIBRARY" };

export function savedQueriesReducer(
  state: SavedQueriesState,
  action: SavedQueriesAction,
): SavedQueriesState {
  switch (action.type) {
    case "SET_SAVE_OPEN":
      return { ...state, saveOpen: action.open };

    case "UPDATE_FORM":
      return { ...state, ...action.patch };

    case "SAVE_COMPLETE":
      return { ...state, saveOpen: false, name: "", tags: "", desc: "" };

    case "SET_QUERIES":
      return { ...state, queries: action.queries };

    case "SET_SEARCH":
      return { ...state, search: action.search };

    case "TOGGLE_LIBRARY":
      return { ...state, showLibrary: !state.showLibrary };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — dialog closed, empty form, no entries, library hidden. */
export function initSavedQueriesState(): SavedQueriesState {
  return {
    saveOpen: false,
    name: "",
    tags: "",
    desc: "",
    queries: [],
    search: "",
    showLibrary: false,
  };
}
