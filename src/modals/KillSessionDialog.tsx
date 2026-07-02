// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch } from "react";
import type { ActivityRow } from "../types";
import type { ActivityAction } from "../state/activityReducer";
import { modalBackdrop } from "../ui/styles";

export function KillSessionDialog({ killPending, dispatchActivity, killActivity }: { killPending: ActivityRow; dispatchActivity: Dispatch<ActivityAction>; killActivity: (row: ActivityRow) => void }) {
  return (
        <>
          <div
            style={modalBackdrop}
            onClick={() => dispatchActivity({ type: "SET_KILL_PENDING", row: null })}
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
                fontFamily: "var(--mono)",
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
                  dispatchActivity({ type: "SET_KILL_PENDING", row: null });
                  if (target) await killActivity(target);
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "var(--mono)", fontWeight: 600,
                }}
              >
                Kill session
              </button>
              <button
                onClick={() => dispatchActivity({ type: "SET_KILL_PENDING", row: null })}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "transparent", color: "var(--text-secondary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "var(--mono)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
  );
}
