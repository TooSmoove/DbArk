// ─────────────────────────────────────────────────────────────────────────
// Schema-explorer tree view — pure reducer (code-audit item A-1).
//
// Holds the expand/collapse state of the schema tree. The toggle logic used to
// be duplicated inline at every tree node ("clone the set, has? delete : add");
// it now lives here as one tested transition. Pure — no DOM, no IPC.
// ─────────────────────────────────────────────────────────────────────────

export interface SchemaTreeState {
  /** Expanded table keys (e.g. "schema.table" or "table"). */
  expandedTables: Set<string>;
  /** Expanded schema names (Postgres namespaces). Defaults to {"public"}. */
  expandedSchemas: Set<string>;
  /** Expanded sidebar sections (SPs, Functions, Views, …). */
  expandedSections: Set<string>;
  /** Whether the database tree is collapsed. */
  dbTreeCollapsed: boolean;
}

export type SchemaTreeAction =
  | { type: "TOGGLE_TABLE"; key: string }
  | { type: "TOGGLE_SCHEMA"; key: string }
  | { type: "TOGGLE_SECTION"; key: string }
  | { type: "TOGGLE_DB_TREE" }
  | { type: "SET_DB_TREE_COLLAPSED"; collapsed: boolean }
  /** Collapse all tables (expandedTables → ∅). */
  | { type: "COLLAPSE_TABLES" }
  /** Collapse all sections (expandedSections → ∅). */
  | { type: "COLLAPSE_SECTIONS" }
  /** Reset schema expansion to the default {"public"}. */
  | { type: "RESET_SCHEMAS" };

/** Toggle a key in a set, returning a new set (membership flips). */
function toggle(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function schemaTreeReducer(
  state: SchemaTreeState,
  action: SchemaTreeAction,
): SchemaTreeState {
  switch (action.type) {
    case "TOGGLE_TABLE":
      return { ...state, expandedTables: toggle(state.expandedTables, action.key) };

    case "TOGGLE_SCHEMA":
      return { ...state, expandedSchemas: toggle(state.expandedSchemas, action.key) };

    case "TOGGLE_SECTION":
      return { ...state, expandedSections: toggle(state.expandedSections, action.key) };

    case "TOGGLE_DB_TREE":
      return { ...state, dbTreeCollapsed: !state.dbTreeCollapsed };

    case "SET_DB_TREE_COLLAPSED":
      return { ...state, dbTreeCollapsed: action.collapsed };

    case "COLLAPSE_TABLES":
      return { ...state, expandedTables: new Set() };

    case "COLLAPSE_SECTIONS":
      return { ...state, expandedSections: new Set() };

    case "RESET_SCHEMAS":
      return { ...state, expandedSchemas: new Set(["public"]) };

    default: {
      // Exhaustiveness guard — a new action type without a case fails the build.
      const _never: never = action;
      return _never;
    }
  }
}

/** Initial state — nothing expanded except the default "public" schema. */
export function initSchemaTreeState(): SchemaTreeState {
  return {
    expandedTables: new Set(),
    expandedSchemas: new Set(["public"]),
    expandedSections: new Set(),
    dbTreeCollapsed: false,
  };
}
