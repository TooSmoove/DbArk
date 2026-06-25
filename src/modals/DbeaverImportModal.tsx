// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction } from "react";
import type { DbeaverImportResult } from "../types";

export function DbeaverImportModal({ setShowDbeaverImport, dbeaverResult, setDbeaverResult, handleDbeaverImport, dbeaverImporting }: { setShowDbeaverImport: Dispatch<SetStateAction<boolean>>; dbeaverResult: DbeaverImportResult | null; setDbeaverResult: Dispatch<SetStateAction<DbeaverImportResult | null>>; handleDbeaverImport: () => void; dbeaverImporting: boolean }) {
  return (
        <>
          <div
            style={{ position: "fixed", inset: 0, zIndex: 999, background: "rgba(0,0,0,0.6)" }}
            onClick={() => { setShowDbeaverImport(false); setDbeaverResult(null); }}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", width: 440,
            boxShadow: "var(--shadow-lg)",
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
              Import from DBeaver
            </div>

            {!dbeaverResult && (
              <>
                <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginBottom: 20, lineHeight: 1.6 }}>
                  Reads <code style={{ color: "var(--text-secondary)" }}>~/.dbeaver/data-sources.json</code> and
                  imports all PostgreSQL, MySQL, SQLite, and SQL Server connections into DbArk.
                  Passwords are moved to the OS keychain.
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={handleDbeaverImport}
                    disabled={dbeaverImporting}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: "var(--accent)", color: "white",
                      border: "none", borderRadius: 6,
                      cursor: dbeaverImporting ? "not-allowed" : "pointer",
                      fontSize: 12, fontFamily: "monospace",
                    }}
                  >
                    {dbeaverImporting ? "Importing…" : "Import connections"}
                  </button>
                  <button
                    onClick={() => setShowDbeaverImport(false)}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: "transparent", color: "var(--text-tertiary)",
                      border: "1px solid var(--border)", borderRadius: 6,
                      cursor: "pointer", fontSize: 12, fontFamily: "monospace",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}

            {dbeaverResult && (
              <>
                {dbeaverResult.error && (
                  <div style={{
                    padding: "10px 14px", borderRadius: 6, marginBottom: 16,
                    background: "var(--error-bg)", border: "1px solid var(--error)",
                    color: "var(--error)", fontSize: 12, fontFamily: "monospace",
                  }}>
                    ❌ {dbeaverResult.error}
                  </div>
                )}

                {dbeaverResult.imported.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--success)", marginBottom: 8, fontFamily: "monospace" }}>
                      ✓ {dbeaverResult.imported.length} connection{dbeaverResult.imported.length > 1 ? "s" : ""} imported
                    </div>
                    {dbeaverResult.imported.map(c => (
                      <div key={c.name} style={{
                        fontSize: 11, color: "var(--text-tertiary)", fontFamily: "monospace",
                        padding: "2px 0",
                      }}>
                        · {c.name} ({c.engine} · {c.host})
                      </div>
                    ))}
                  </div>
                )}

                {dbeaverResult.skipped.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--warning)", marginBottom: 8, fontFamily: "monospace" }}>
                      ⚠ {dbeaverResult.skipped.length} skipped
                    </div>
                    {dbeaverResult.skipped.map(s => (
                      <div key={s} style={{
                        fontSize: 11, color: "var(--text-disabled)", fontFamily: "monospace",
                        padding: "2px 0",
                      }}>
                        · {s}
                      </div>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => { setShowDbeaverImport(false); setDbeaverResult(null); }}
                  style={{
                    width: "100%", padding: "8px 0",
                    background: "transparent", color: "var(--text-tertiary)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    cursor: "pointer", fontSize: 12, fontFamily: "monospace",
                  }}
                >
                  Close
                </button>
              </>
            )}
          </div>
        </>
  );
}
