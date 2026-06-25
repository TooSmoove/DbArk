// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";

export function SaveQueryModal({ saveQueryName, setSaveQueryName, saveQueryTags, setSaveQueryTags, saveQueryDesc, setSaveQueryDesc, handleSaveQuery, setSaveQueryOpen }: { saveQueryName: string; setSaveQueryName: Dispatch<SetStateAction<string>>; saveQueryTags: string; setSaveQueryTags: Dispatch<SetStateAction<string>>; saveQueryDesc: string; setSaveQueryDesc: Dispatch<SetStateAction<string>>; handleSaveQuery: () => void; setSaveQueryOpen: Dispatch<SetStateAction<boolean>> }) {
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
              onChange={e => setSaveQueryName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSaveQuery(); if (e.key === "Escape") setSaveQueryOpen(false); }}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Tags (comma-separated, optional)"
              value={saveQueryTags}
              onChange={e => setSaveQueryTags(e.target.value)}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 10, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <input
              placeholder="Description (optional)"
              value={saveQueryDesc}
              onChange={e => setSaveQueryDesc(e.target.value)}
              style={{
                width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, padding: "6px 10px", color: "var(--text)",
                marginBottom: 16, boxSizing: "border-box", fontSize: 13,
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setSaveQueryOpen(false)}
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
