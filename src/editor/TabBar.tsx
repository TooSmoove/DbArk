// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Tab } from "../types";
import { createTab } from "../appState";

type EditorHandle = { getValue: () => string; setValue: (value: string) => void };

export function TabBar({
  tabs, setTabs, activeTabId, setActiveTabId, editorRef,
}: {
  tabs: Tab[];
  setTabs: Dispatch<SetStateAction<Tab[]>>;
  activeTabId: string;
  setActiveTabId: Dispatch<SetStateAction<string>>;
  editorRef: RefObject<EditorHandle | null>;
}) {
  return (
        <div style={{
          display: "flex",
          alignItems: "center",
          background: "var(--bg)",
          borderBottom: "1px solid var(--border)",
          overflowX: "auto",
          flexShrink: 0,
          minHeight: 38,
        }}>
          {tabs.map(tab => (
            <div
              key={tab.id}
              onClick={() => {
                if (tab.id === activeTabId) return; // already active

                // Save current editor content to current tab
                const currentSql = editorRef.current?.getValue() ?? "";
                setTabs(prev => {
                  const updated = prev.map(t =>
                    t.id === activeTabId ? { ...t, sql: currentSql } : t
                  );
                  // Find the target tab's SQL from the updated array
                  const targetTab = updated.find(t => t.id === tab.id);
                  setTimeout(() => editorRef.current?.setValue(targetTab?.sql ?? ""), 0);
                  return updated;
                });
                setActiveTabId(tab.id);
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                height: 38,
                cursor: "pointer",
                borderRight: "1px solid var(--border)",
                borderBottom: `2px solid ${tab.id === activeTabId ? "var(--accent)" : "transparent"}`,
                background: tab.id === activeTabId ? "var(--surface)" : "transparent",
                flexShrink: 0,
                maxWidth: 200,
                minWidth: 120,
                transition: "background .1s",
              }}
            >
              {/* Connection colour dot */}
              {tab.connection && (
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: tab.connection.color, flexShrink: 0,
                }} />
              )}
              {tab.file && (
                <div style={{
                  width: 6, height: 6, borderRadius: "50%",
                  background: "var(--success)", flexShrink: 0,
                }} />
              )}

              {/* Tab title */}
              <span style={{
                fontSize: 12,
                color: tab.id === activeTabId ? "var(--text)" : "var(--text-tertiary)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                flex: 1,
                fontFamily: "var(--mono)",
              }}>
                {tab.title}
              </span>

              {/* Close button — only show if more than one tab */}
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const currentSql = editorRef.current?.getValue() ?? "";
                    const idx = tabs.findIndex(t => t.id === tab.id);
                    setTabs(prev => {
                      const updated = prev.map(t =>
                        t.id === activeTabId ? { ...t, sql: currentSql } : t
                      );
                      const newTabs = updated.filter(t => t.id !== tab.id);
                      if (tab.id === activeTabId) {
                        const nextTab = newTabs[Math.min(idx, newTabs.length - 1)];
                        setActiveTabId(nextTab.id);
                        setTimeout(() => editorRef.current?.setValue(nextTab.sql ?? ""), 0);
                      }
                      return newTabs;
                    });
                  }}
                  style={{
                    background: "none", border: "none",
                    color: "var(--text-disabled)", cursor: "pointer",
                    fontSize: 14, lineHeight: 1,
                    padding: "2px 4px", flexShrink: 0,
                    borderRadius: 3,
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--error)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-disabled)")}
                >
                  ×
                </button>
              )}
            </div>
          ))}

          {/* New tab button */}
          <button
            onClick={() => {
              // Save current editor content before creating new tab
              const currentSql = editorRef.current?.getValue() ?? "";
              const newTab = createTab();
              setTabs(prev => {
                const updated = prev.map(t =>
                  t.id === activeTabId ? { ...t, sql: currentSql } : t
                );
                return [...updated, newTab];
              });
              setActiveTabId(newTab.id);
              setTimeout(() => editorRef.current?.setValue(""), 0);
            }}
            style={{
              background: "none", border: "none",
              color: "var(--text-disabled)", cursor: "pointer",
              fontSize: 18, lineHeight: 1,
              padding: "0 12px", height: 38,
              flexShrink: 0,
            }}
            onMouseEnter={e => (e.currentTarget.style.color = "var(--text)")}
            onMouseLeave={e => (e.currentTarget.style.color = "var(--text-disabled)")}
            title="New tab (Cmd+T)"
          >
            +
          </button>
        </div>
  );
}
