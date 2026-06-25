// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "../appState";
import { selectStyle, SettingsSection, SettingsRow } from "../ui";
import type { AppSettings, ThemePreference } from "../types";
import { icon14, modalBackdrop } from "../ui/styles";

export function SettingsModal({ setShowSettings, settingsDraft, setSettingsDraft, themePreference, setThemePreference, setSettings, setAuditLogEnabled }: { setShowSettings: Dispatch<SetStateAction<boolean>>; settingsDraft: AppSettings; setSettingsDraft: Dispatch<SetStateAction<AppSettings>>; themePreference: ThemePreference; setThemePreference: Dispatch<SetStateAction<ThemePreference>>; setSettings: Dispatch<SetStateAction<AppSettings>>; setAuditLogEnabled: Dispatch<SetStateAction<boolean>> }) {
  return (
        <>
          <div
            style={modalBackdrop}
            onClick={() => setShowSettings(false)}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "0", width: 480, maxHeight: "80vh",
            boxShadow: "var(--shadow-lg)",
            display: "flex", flexDirection: "column",
          }}>

            {/* Header */}
            <div style={{
              padding: "16px 24px",
              borderBottom: "1px solid var(--border)",
              display: "flex", alignItems: "center",
              justifyContent: "space-between", flexShrink: 0,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                ⚙ Settings
              </div>
              <button
                onClick={() => setShowSettings(false)}
                style={{ background: "none", border: "none",
                  color: "var(--text-tertiary)", cursor: "pointer", fontSize: 18 }}
              >
                ✕
              </button>
            </div>

            {/* Body */}
            <div style={{ padding: "16px 24px", overflowY: "auto", flex: 1 }}>

              {/* Section: Query */}
              <SettingsSection label="Query">
                <SettingsRow
                  label="Query timeout"
                  description="Maximum time a query can run before being cancelled"
                >
                  <select
                    value={settingsDraft.queryTimeoutSecs}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, queryTimeoutSecs: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    {[5, 15, 30, 60, 120, 300].map(v => (
                      <option key={v} value={v}>{v}s</option>
                    ))}
                  </select>
                </SettingsRow>

                <SettingsRow
                  label="Result row limit"
                  description="Maximum rows returned per query — use WHERE to filter large sets"
                >
                  <select
                    value={settingsDraft.resultRowLimit}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, resultRowLimit: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    {[50000, 250000, 5000000, 0].map(v => (
                      <option key={v} value={v}>
                        {v === 0 ? "Unlimited" : `${v.toLocaleString()} rows`}
                      </option>
                    ))}
                  </select>
                </SettingsRow>

                <SettingsRow
                  label="Result auto-clear"
                  description="Automatically clear results after this period of inactivity"
                >
                  <select
                    value={settingsDraft.resultClearMins}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, resultClearMins: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    <option value={1}>1 min</option>
                    <option value={5}>5 min</option>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={0}>Never</option>
                  </select>
                </SettingsRow>
              </SettingsSection>

              {/* Section: Security */}
              <SettingsSection label="Security">
                <SettingsRow
                  label="Inactivity lock"
                  description="Lock the app after this period of inactivity"
                >
                  <select
                    value={settingsDraft.lockTimeoutMins}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, lockTimeoutMins: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    <option value={1}>1 min</option>
                    <option value={5}>5 min</option>
                    <option value={15}>15 min</option>
                    <option value={30}>30 min</option>
                    <option value={60}>60 min</option>
                    <option value={120}>2 hours</option>
                    <option value={0}>Disabled</option>
                  </select>
                </SettingsRow>

                <SettingsRow
                  label="Clipboard auto-clear"
                  description="Clear clipboard after copying a cell value"
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="checkbox"
                      checked={settingsDraft.clipboardClearEnabled}
                      onChange={e => setSettingsDraft(s => ({
                        ...s, clipboardClearEnabled: e.target.checked
                      }))}
                      style={icon14}
                    />
                    {settingsDraft.clipboardClearEnabled && (
                      <select
                        value={settingsDraft.clipboardClearSecs}
                        onChange={e => setSettingsDraft(s => ({
                          ...s, clipboardClearSecs: Number(e.target.value)
                        }))}
                        style={selectStyle}
                      >
                        <option value={30}>after 30s</option>
                        <option value={60}>after 60s</option>
                        <option value={120}>after 2 min</option>
                        <option value={300}>after 5 min</option>
                      </select>
                    )}
                  </div>
                </SettingsRow>

                <SettingsRow
                  label="Audit log"
                  description="Append every executed query to ~/.dbark/audit.log"
                >
                  <input
                    type="checkbox"
                    checked={settingsDraft.auditLogEnabled}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, auditLogEnabled: e.target.checked
                    }))}
                    style={icon14}
                  />
                </SettingsRow>
              </SettingsSection>

              {/* Section: History */}
              <SettingsSection label="History">
                <SettingsRow
                  label="Query history retention"
                  description="How long to keep query history entries"
                >
                  <select
                    value={settingsDraft.historyRetentionDays}
                    onChange={e => setSettingsDraft(s => ({
                      ...s, historyRetentionDays: Number(e.target.value)
                    }))}
                    style={selectStyle}
                  >
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={90}>90 days</option>
                    <option value={365}>1 year</option>
                    <option value={0}>Forever</option>
                  </select>
                </SettingsRow>
              </SettingsSection>

              {/* Section: Appearance */}
              {/* Theme applies immediately on change rather than waiting for
                  Save — matches user expectation for visual preferences. */}
              <SettingsSection label="Appearance">
                <SettingsRow
                  label="Theme"
                  description="System follows your OS; choose Light or Dark to override"
                >
                  <select
                    value={themePreference}
                    onChange={e => setThemePreference(e.target.value as ThemePreference)}
                    style={selectStyle}
                  >
                    <option value="system">System</option>
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                  </select>
                </SettingsRow>
              </SettingsSection>
            </div>
            {/* Footer */}
            <div style={{
              padding: "12px 24px",
              borderTop: "1px solid var(--border)",
              display: "flex", gap: 8, flexShrink: 0,
            }}>
              <button
                onClick={async () => {
                  try {
                    // Map camelCase back to snake_case for Rust
                    const toSave = {
                      query_timeout_secs:      settingsDraft.queryTimeoutSecs,
                      lock_timeout_mins:       settingsDraft.lockTimeoutMins,
                      result_row_limit:        settingsDraft.resultRowLimit,
                      history_retention_days:  settingsDraft.historyRetentionDays,
                      result_clear_mins:       settingsDraft.resultClearMins,
                      audit_log_enabled:       settingsDraft.auditLogEnabled,
                      clipboard_clear_enabled: settingsDraft.clipboardClearEnabled,
                      clipboard_clear_secs:    settingsDraft.clipboardClearSecs,
                    };
                    await invoke("save_settings", {
                      settingsJson: JSON.stringify(toSave)
                    });
                    setSettings(settingsDraft);
                    setAuditLogEnabled(settingsDraft.auditLogEnabled);
                    setShowSettings(false);
                  } catch (e) {
                    console.error("Failed to save settings:", e);
                  }
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--accent)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "var(--mono)",
                }}
              >
                Save
              </button>
              <button
                onClick={() => setShowSettings(false)}
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
              <button
                onClick={() => setSettingsDraft(DEFAULT_SETTINGS)}
                style={{
                  padding: "8px 14px",
                  background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "var(--mono)",
                }}
              >
                Reset defaults
              </button>
            </div>
          </div>
        </>
  );
}
