import type { SavedQuery } from "../state/savedQueriesReducer";

// Presentational saved-query library panel for the sidebar. All state and IPC
// live in App; this component only renders and calls back.
interface QueryLibraryPanelProps {
  queries:        SavedQuery[];
  search:         string;
  onSearchChange: (search: string) => void;
  onSelect:       (sql: string) => void;
  onDelete:       (id: string) => void;
}

export function QueryLibraryPanel({
  queries,
  search,
  onSearchChange,
  onSelect,
  onDelete,
}: QueryLibraryPanelProps) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)", paddingBottom: 8, marginBottom: 8 }}>
      <input
        placeholder="Search queries..."
        value={search}
        onChange={e => onSearchChange(e.target.value)}
        style={{
          width: "100%", background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 4, padding: "4px 8px", color: "var(--text)",
          fontSize: 12, boxSizing: "border-box", marginBottom: 6,
        }}
      />
      {queries
        .filter(q => {
          const s = search.toLowerCase();
          return !s
            || q.meta.name.toLowerCase().includes(s)
            || (q.meta.tags ?? []).some((t: string) => t.toLowerCase().includes(s));
        })
        .map(q => (
          <div key={q.id}
            style={{
              padding: "5px 8px", borderRadius: 4, cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "space-between",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "var(--surface-2)")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}
            onClick={() => onSelect(q.sql)}
          >
            <div>
              <div style={{ color: "var(--text)", fontSize: 12 }}>{q.meta.name}</div>
              {q.meta.tags?.length > 0 && (
                <div style={{ display: "flex", gap: 4, marginTop: 2, flexWrap: "wrap" }}>
                  {q.meta.tags.map((t: string) => (
                    <span key={t} style={{
                      fontSize: 10, background: "var(--accent-bg)",
                      color: "var(--accent-hover)", borderRadius: 3, padding: "1px 5px",
                    }}>{t}</span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={e => {
                e.stopPropagation();
                onDelete(q.id);
              }}
              style={{
                background: "transparent", border: "none",
                color: "var(--text-disabled)", cursor: "pointer", fontSize: 14, padding: 2,
              }}
              title="Delete query"
            >✕</button>
          </div>
        ))}
      {queries.length === 0 && (
        <div style={{ color: "var(--text-disabled)", fontSize: 11, padding: "4px 8px" }}>
          No saved queries. Press Cmd+S to save.
        </div>
      )}
    </div>
  );
}
