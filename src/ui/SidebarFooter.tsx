// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch } from "react";
import type { SettingsAction } from "../state/settingsReducer";

export function SidebarFooter({
  dispatchSettings,
}: {
  dispatchSettings: Dispatch<SettingsAction>;
}) {
  return (
      <div style={{
        borderTop: "1px solid var(--border)",
        padding: "8px 14px",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexShrink: 0,
      }}>
        <button
          onClick={() => {
            dispatchSettings({ type: "OPEN_SETTINGS" });
          }}
          title="Settings"
          style={{
            background: "none", border: "none",
            color: "var(--text-disabled)", cursor: "pointer",
            fontSize: 16, padding: "4px 6px",
            borderRadius: 6, transition: "color .15s",
          }}
          onMouseEnter={e => (e.currentTarget.style.color = "var(--text-secondary)")}
          onMouseLeave={e => (e.currentTarget.style.color = "var(--text-disabled)")}
        >
          ⚙
        </button>
      </div>
  );
}
