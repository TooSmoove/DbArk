// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";
import type { PaletteItem } from "../types";

export function CommandPalette({ setShowPalette, paletteQuery, setPaletteQuery, paletteIndex, setPaletteIndex, filteredPalette }: { setShowPalette: Dispatch<SetStateAction<boolean>>; paletteQuery: string; setPaletteQuery: Dispatch<SetStateAction<string>>; paletteIndex: number; setPaletteIndex: Dispatch<SetStateAction<number>>; filteredPalette: PaletteItem[] }) {
  return (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999,
              background: "var(--scrim)" }}
            onClick={() => setShowPalette(false)}
          />
          <div style={{
            position: "fixed", top: 120, left: "50%",
            transform: "translateX(-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 10,
            width: 540, maxHeight: "60vh",
            boxShadow: "var(--shadow-lg)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
          }}>
            {/* Search input */}
            <input
              autoFocus
              type="text"
              value={paletteQuery}
              onChange={e => { setPaletteQuery(e.target.value); setPaletteIndex(0); }}
              onKeyDown={e => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setShowPalette(false);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setPaletteIndex(i => Math.min(i + 1, filteredPalette.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setPaletteIndex(i => Math.max(i - 1, 0));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  const item = filteredPalette[paletteIndex];
                  if (item) {
                    setShowPalette(false);
                    // Defer the action to next tick so the modal can unmount
                    // before the action mutates state that the modal touched
                    // (e.g. setActiveTabId, which would otherwise re-render
                    // the modal mid-close).
                    setTimeout(() => item.onSelect(), 0);
                  }
                }
              }}
              placeholder="Type to search connections, tables, tabs, commands…"
              style={{
                background: "transparent",
                border: "none",
                borderBottom: filteredPalette.length > 0
                  ? "1px solid var(--border)"
                  : "1px solid transparent",
                color: "var(--text)",
                fontSize: 14,
                fontFamily: "var(--mono)",
                padding: "14px 18px",
                outline: "none",
                width: "100%",
                boxSizing: "border-box",
              }}
            />

            {/* Results list — scrollable. Empty until user types something. */}
            {filteredPalette.length > 0 && (
              <div style={{
                flex: 1,
                overflow: "auto",
                padding: "4px 0",
              }}>
                {filteredPalette.map((item, i) => (
                  <div
                    key={item.id}
                    ref={el => {
                      // Auto-scroll the highlighted row into view when
                      // navigating with arrow keys past the visible region.
                      if (i === paletteIndex && el) {
                        el.scrollIntoView({ block: "nearest" });
                      }
                    }}
                    onMouseEnter={() => setPaletteIndex(i)}
                    onClick={() => {
                      setShowPalette(false);
                      setTimeout(() => item.onSelect(), 0);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "6px 18px",
                      cursor: "pointer",
                      background: i === paletteIndex
                        ? "var(--accent-bg)"
                        : "transparent",
                      borderLeft: i === paletteIndex
                        ? "2px solid var(--accent)"
                        : "2px solid transparent",
                    }}
                  >
                    {/* Category icon — small, monospace, low contrast */}
                    <span style={{
                      fontSize: 11,
                      width: 14,
                      textAlign: "center",
                      color: "var(--text-tertiary)",
                      flexShrink: 0,
                    }}>
                      {item.category === "command"    ? "▸" :
                       item.category === "connection" ? "◉" :
                       item.category === "table"      ? "⊞" :
                       item.category === "tab"        ? "❏" :
                                                        "★"}
                    </span>
                    {/* Primary label */}
                    <span style={{
                      flex: 1,
                      fontSize: 13,
                      fontFamily: "var(--mono)",
                      color: i === paletteIndex
                        ? "var(--text)"
                        : "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}>
                      {item.label}
                    </span>
                    {/* Secondary — schema, host, keybinding hint, etc */}
                    {item.secondary && (
                      <span style={{
                        fontSize: 11,
                        fontFamily: "var(--mono)",
                        color: "var(--text-disabled)",
                        flexShrink: 0,
                        maxWidth: 200,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {item.secondary}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Footer hint line — only when results exist */}
            {filteredPalette.length > 0 && (
              <div style={{
                padding: "6px 18px",
                borderTop: "1px solid var(--border)",
                fontSize: 10,
                fontFamily: "var(--mono)",
                color: "var(--text-disabled)",
                display: "flex",
                gap: 16,
                flexShrink: 0,
              }}>
                <span>↑↓ navigate</span>
                <span>↵ select</span>
                <span>esc close</span>
              </div>
            )}
          </div>
        </>
  );
}
