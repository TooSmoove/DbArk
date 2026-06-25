// Extracted from App.tsx (code-audit item A-1).
import type {
  ActivityRow,
} from "../types";

export function ActivityPanelBody({
  rows, loading, error, errorCode, engine, onRefresh, onKillRequest,
}: {
  rows:          ActivityRow[];
  loading:       boolean;
  error:         string | null;
  errorCode:     string | null;
  engine:        string;
  onRefresh:     () => void;
  onKillRequest: (row: ActivityRow) => void;
}) {
  // Format milliseconds → human-readable duration.
  // <1s shows ms; <60s shows seconds; otherwise mm:ss.
  function fmtDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      overflow: "hidden", minHeight: 0,
    }}>
      {/* Header strip — refresh button + status */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8,
        padding: "6px 14px",
        borderBottom: "1px solid var(--border)",
        background: "var(--bg)",
        fontFamily: "var(--mono)", fontSize: 11, flexShrink: 0,
      }}>
        <span style={{ color: "var(--text-secondary)" }}>
          ⚡ Active queries on this connection — auto-refresh every 5s
        </span>
        <span style={{ flex: 1 }} />
        {loading && (
          <span style={{ color: "var(--text-tertiary)" }}>Loading…</span>
        )}
        <button
          onClick={onRefresh}
          style={{
            padding: "3px 10px",
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            color: "var(--text-secondary)",
            fontFamily: "var(--mono)",
            fontSize: 10,
            cursor: "pointer",
          }}
        >
          ↻ Refresh
        </button>
      </div>

      {/* Error banner if last fetch failed.
          Doesn't replace the rows — failed refresh keeps stale data visible,
          which is preferable to blanking the panel on a transient blip. */}
      {/* Permission notice — distinct, actionable styling. A least-privilege
          login that can't read server activity gets the exact GRANT to run,
          not a generic red error or a misleading "idle" empty state. */}
      {error && errorCode === "permission" && (() => {
        const [headline, ...rest] = error.split("\n");
        const grant = rest.join("\n").trim();
        return (
          <div style={{
            padding: "12px 14px",
            background: "var(--warning-bg)",
            color: "var(--text-secondary)",
            fontSize: 12, lineHeight: 1.5,
            borderBottom: "1px solid var(--warning)",
            flexShrink: 0,
          }}>
            <div style={{ marginBottom: grant ? 8 : 0 }}>🔒 {headline}</div>
            {grant && (
              <code style={{
                display: "block",
                padding: "6px 10px",
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "var(--mono)", fontSize: 11,
                color: "var(--text)",
                userSelect: "all", whiteSpace: "pre-wrap",
              }}>{grant}</code>
            )}
          </div>
        );
      })()}

      {error && errorCode !== "permission" && (
        <div style={{
          padding: "8px 14px",
          background: "var(--error-bg)",
          color: "var(--error)",
          fontSize: 11, fontFamily: "var(--mono)",
          borderBottom: "1px solid var(--error)",
          flexShrink: 0,
        }}>
          ❌ {error}
        </div>
      )}

      {/* Empty state */}
      {!loading && rows.length === 0 && !error && (
        <div style={{
          padding: "40px 16px",
          color: "var(--text-disabled)",
          fontSize: 13, textAlign: "center",
        }}>
          No active queries — server is idle (or all activity is from this connection).
        </div>
      )}

      {/* Row list — scrollable. Each row is a card so query text can wrap
          without breaking the table grid. A real table would force
          horizontal scrolling for long queries which is worse UX. */}
      {rows.length > 0 && (
        <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
          {rows.map((row) => (
            <div
              key={row.pid}
              style={{
                padding: "8px 14px",
                borderBottom: "1px solid var(--surface-3)",
                fontFamily: "var(--mono)", fontSize: 11,
                display: "flex", flexDirection: "column", gap: 4,
              }}
            >
              {/* Top meta row — pid, user, db, state, duration, kill */}
              <div style={{
                display: "flex", alignItems: "center", gap: 12,
                color: "var(--text-tertiary)",
              }}>
                <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                  #{row.pid}
                </span>
                {row.user && <span>👤 {row.user}</span>}
                {row.database && <span>🗄 {row.database}</span>}
                {row.state && (
                  <span style={{
                    padding: "1px 6px",
                    background: row.state.toLowerCase() === "active"
                      ? "var(--success-bg)" : "var(--surface-3)",
                    color: row.state.toLowerCase() === "active"
                      ? "var(--success)" : "var(--text-secondary)",
                    borderRadius: 3,
                    fontSize: 10,
                  }}>
                    {row.state}
                  </span>
                )}
                <span style={{ color: "var(--warning)" }}>
                  ⏱ {fmtDuration(row.durationMs)}
                </span>
                {row.host && (
                  <span style={{ color: "var(--text-disabled)" }}>
                    {row.host}
                  </span>
                )}
                <span style={{ flex: 1 }} />
                <button
                  onClick={() => onKillRequest(row)}
                  title={`Kill session ${row.pid}`}
                  style={{
                    padding: "2px 8px",
                    background: "var(--error-bg)",
                    border: "1px solid var(--error)",
                    borderRadius: 3,
                    color: "var(--error)",
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    cursor: "pointer",
                  }}
                >
                  Kill
                </button>
              </div>
              {/* Query text — wraps; we use the raw query as-is and let CSS
                  break long lines. Truncating in TS would hide useful detail. */}
              {row.query && (
                <div style={{
                  color: "var(--text)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 11,
                  paddingLeft: 4,
                  paddingRight: 4,
                  maxHeight: 120,
                  overflow: "auto",
                }}>
                  {row.query}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Footer note for CockroachDB — its pg_stat_activity columns
          are sparse, so we tell the user not to expect everything. */}
      {engine === "cockroachdb" && (
        <div style={{
          padding: "6px 14px",
          fontSize: 10, fontFamily: "var(--mono)",
          color: "var(--text-tertiary)",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}>
          ℹ CockroachDB exposes a subset of Postgres activity columns — some fields may be blank.
        </div>
      )}
    </div>
  );
}
