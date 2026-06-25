// Extracted from App.tsx (code-audit item A-1).
import type React from "react";

export function SettingsRow({
  label, description, children
}: {
  label: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center",
      justifyContent: "space-between", gap: 16,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 12, color: "var(--text)",
          marginBottom: 2, fontFamily: "monospace",
        }}>
          {label}
        </div>
        <div style={{
          fontSize: 10, color: "var(--text-tertiary)",
          fontFamily: "monospace", lineHeight: 1.5,
        }}>
          {description}
        </div>
      </div>
      <div style={{ flexShrink: 0 }}>
        {children}
      </div>
    </div>
  );
}
