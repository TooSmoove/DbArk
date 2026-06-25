// Extracted from App.tsx (code-audit item A-1).
import type React from "react";

export function SettingsSection({
  label, children
}: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: "var(--text-disabled)",
        fontFamily: "monospace", textTransform: "uppercase",
        letterSpacing: ".08em", marginBottom: 12,
        paddingBottom: 6, borderBottom: "1px solid var(--border)",
      }}>
        {label}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {children}
      </div>
    </div>
  );
}
