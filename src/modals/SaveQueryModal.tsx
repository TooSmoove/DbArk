// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch } from "react";
import type { SavedQueriesAction } from "../state/savedQueriesReducer";

export function SaveQueryModal({ saveQueryName, saveQueryTags, saveQueryDesc, handleSaveQuery, dispatchSavedQueries }: { saveQueryName: string; saveQueryTags: string; saveQueryDesc: string; handleSaveQuery: () => void; dispatchSavedQueries: Dispatch<SavedQueriesAction> }) {
  return (
        <div style={{
          position: "fixed", inset: 0, background: "var(--scrim-strong)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
        }}>
          <div style={{
            background: "var(--surface)", border: "1px solid var(--border)",
            borderRadius: 8, padding: 24, width: 380,
          }}>
            <div style={{ color: "var(--text)", fontWeight: 600, marginBottom: 16 }}>
              Save Query
            </div>
            <input
              autoFocus
              placeholder="Query name"
              value={saveQueryName}
              onChange={e => dispatchSavedQueries({ type: "UPDATE_FORM", patch: { name: e.target.value } })}
              onKeyDown={e => { if (e.key === "Enter") handleSaveQuery(); if (e.key === "Escape") dispatchSavedQueries({ type: "SET_SAVE_OPEN", open: false }); }}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Tags (comma-separated, optional)"
              value={saveQueryTags}
              onChange={e => dispatchSavedQueries({ type: "UPDATE_FORM", patch: { tags: e.target.value } })}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Description (optional)"
              value={saveQueryDesc}
              onChange={e => dispatchSavedQueries({ type: "UPDATE_FORM", patch: { desc: e.target.value } })}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 16, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => dispatchSavedQueries({ type: "SET_SAVE_OPEN", open: false })}
                style={{ padding: "6px 14px", background: "transparent", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-secondary)", cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={handleSaveQuery}
                style={{ padding: "6px 14px", background: "var(--accent-hover)", border: "none", borderRadius: 4, color: "white", cursor: "pointer" }}>
                Save
              </button>
            </div>
          </div>
        </div>
  );
}
