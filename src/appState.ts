// Extracted from App.tsx (code-audit item A-1).
import type {
  Tab, AppSettings,
} from "./types";

export function createTab(id?: string): Tab {
  return {
    id:           id ?? `tab-${Date.now()}`,
    title:        "New tab",
    sql:          "",
    connection:   null,
    file:         null,
    results:      [],        // ← was: result: null
    activeResult: 0,
    error:        null,
    loading:      false,
    duration:     null,
    joinTables:   [],
    pendingEdits: [],
    editingCell:  null,
    includePlan:  false,
    activeDatabase: undefined,
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  queryTimeoutSecs:      30,
  lockTimeoutMins:       15,
  resultRowLimit:        50_000,
  historyRetentionDays:  90,
  resultClearMins:       5,
  auditLogEnabled:       false,
  clipboardClearEnabled: true,
  clipboardClearSecs:    60,
};
