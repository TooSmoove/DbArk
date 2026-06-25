// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";
import type { ActivityRow } from "../types";

export function KillSessionDialog({ killPending, setKillPending, killActivity }: { killPending: ActivityRow; setKillPending: Dispatch<SetStateAction<ActivityRow | null>>; killActivity: (row: ActivityRow) => void }) {
  return (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999,
              background: "rgba(0,0,0,0.6)" }}
            onClick={() => setKillPending(null)}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", minWidth: 380, maxWidth: 520,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ display: "flex", alignItems: "center",
              gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                Kill session
              </div>
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)",
              marginBottom: 16, lineHeight: 1.6 }}>
              This will cancel session{" "}
              <strong style={{ color: "var(--text)" }}>#{killPending.pid}</strong>
              {killPending.user && <> running as <strong style={{ color: "var(--text)" }}>{killPending.user}</strong></>}.
              {" "}The query in progress will be interrupted.
            </div>
            {killPending.query && (
              <div style={{
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "10px 14px",
                marginBottom: 20,
                fontFamily: "monospace",
                fontSize: 11,
                color: "var(--text)",
                maxHeight: 120,
                overflow: "auto",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}>
                {killPending.query}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  const target = killPending;
                  setKillPending(null);
                  if (target) await killActivity(target);
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace", fontWeight: 600,
                }}
              >
                Kill session
              </button>
              <button
                onClick={() => setKillPending(null)}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "monospace",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
  );
}
