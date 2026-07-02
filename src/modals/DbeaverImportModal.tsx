// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch } from "react";
import type { DbeaverImportResult } from "../types";
import type { ConnectionsAction } from "../state/connectionsReducer";
import { modalBackdrop } from "../ui/styles";

export function DbeaverImportModal({ dispatchConn, dbeaverResult, handleDbeaverImport, dbeaverImporting }: { dispatchConn: Dispatch<ConnectionsAction>; dbeaverResult: DbeaverImportResult | null; handleDbeaverImport: () => void; dbeaverImporting: boolean }) {
  return (
        <>
          <div
            style={modalBackdrop}
            onClick={() => dispatchConn({ type: "CLOSE_IMPORT" })}
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
                      fontSize: 12, fontFamily: "var(--mono)",
                    }}
                  >
                    {dbeaverImporting ? "Importing…" : "Import connections"}
                  </button>
                  <button
                    onClick={() => dispatchConn({ type: "SET_IMPORT_OPEN", open: false })}
                    style={{
                      flex: 1, padding: "8px 0",
                      background: "transparent", color: "var(--text-tertiary)",
                      border: "1px solid var(--border)", borderRadius: 6,
                      cursor: "pointer", fontSize: 12, fontFamily: "var(--mono)",
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
                    color: "var(--error)", fontSize: 12, fontFamily: "var(--mono)",
                  }}>
                    ❌ {dbeaverResult.error}
                  </div>
                )}

                {dbeaverResult.imported.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--success)", marginBottom: 8, fontFamily: "var(--mono)" }}>
                      ✓ {dbeaverResult.imported.length} connection{dbeaverResult.imported.length > 1 ? "s" : ""} imported
                    </div>
                    {dbeaverResult.imported.map(c => (
                      <div key={c.name} style={{
                        fontSize: 11, color: "var(--text-tertiary)", fontFamily: "var(--mono)",
                        padding: "2px 0",
                      }}>
                        · {c.name} ({c.engine} · {c.host})
                      </div>
                    ))}
                  </div>
                )}

                {dbeaverResult.skipped.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 11, color: "var(--warning)", marginBottom: 8, fontFamily: "var(--mono)" }}>
                      ⚠ {dbeaverResult.skipped.length} skipped
                    </div>
                    {dbeaverResult.skipped.map(s => (
                      <div key={s} style={{
                        fontSize: 11, color: "var(--text-disabled)", fontFamily: "var(--mono)",
                        padding: "2px 0",
                      }}>
                        · {s}
                      </div>
                    ))}
                  </div>
                )}

                <button
                  onClick={() => dispatchConn({ type: "CLOSE_IMPORT" })}
                  style={{
                    width: "100%", padding: "8px 0",
                    background: "transparent", color: "var(--text-tertiary)",
                    border: "1px solid var(--border)", borderRadius: 6,
                    cursor: "pointer", fontSize: 12, fontFamily: "var(--mono)",
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
