// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";

export function LockOverlay({ setLocked, resetInactivityTimer }: { setLocked: Dispatch<SetStateAction<boolean>>; resetInactivityTimer: () => void }) {
  return (
        <div
          onClick={() => {
            setLocked(false);
            resetInactivityTimer();
          }}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "var(--lock-overlay)",
            backdropFilter: "blur(12px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            userSelect: "none",
          }}
        >
          <div style={{
            fontSize: 48,
            marginBottom: 24,
          }}>
            🔒
          </div>
          <div style={{
            fontSize: 20,
            fontWeight: 700,
            color: "var(--text)",
            marginBottom: 8,
            fontFamily: "var(--mono)",
          }}>
            DbArk is locked
          </div>
          <div style={{
            fontSize: 13,
            color: "var(--text-tertiary)",
            fontFamily: "var(--mono)",
          }}>
            Click anywhere to unlock
          </div>
          <div style={{
            marginTop: 32,
            fontSize: 11,
            color: "var(--text-disabled)",
            fontFamily: "var(--mono)",
          }}>
            Locked after 15 minutes of inactivity
          </div>
        </div>
  );
}
