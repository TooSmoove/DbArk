// Extracted from App.tsx (code-audit item A-1).
import type React from "react";

export const selectStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 12,
  fontFamily: "var(--mono)",
  padding: "5px 10px",
  cursor: "pointer",
  outline: "none",
};

// ── Shared repeated style objects (code-audit item A-1, Tier 2) ──────────────
// Previously duplicated verbatim across many components. Centralised here so a
// tweak happens in one place. Each is the exact object it replaced — no visual
// change.

/** Full-screen dim backdrop behind modals/dialogs. */
export const modalBackdrop: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.6)",
};

/** Single-line elided label, monospace, fills available width. */
export const ellipsisLabel: React.CSSProperties = {
  fontSize: 11, color: "var(--text-secondary)", flex: 1,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  fontFamily: "var(--mono)",
};

/** Tiny muted monospace caption (badges, meta rows). */
export const microMutedLabel: React.CSSProperties = {
  fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)", flexShrink: 0,
};

/** 14×14 clickable icon affordance. */
export const icon14: React.CSSProperties = {
  width: 14, height: 14, cursor: "pointer",
};
