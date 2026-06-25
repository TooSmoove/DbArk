// Extracted from App.tsx (code-audit item A-1).
import type { Dispatch, SetStateAction, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toIpcError } from "../ipc";
import type { ConnectionConfig, SchemaResult, Tab, DropConfirm } from "../types";
import { modalBackdrop } from "../ui/styles";

export function DropObjectDialog({ dropConfirm, setDropConfirm, purgeSchemaCache, schemaConnectionIdRef, setSchema, setExpandedTables, setExpandedSections, loadSchema, activeTabRef, updateActiveTab }: { dropConfirm: DropConfirm; setDropConfirm: Dispatch<SetStateAction<DropConfirm | null>>; purgeSchemaCache: (connId: string) => void; schemaConnectionIdRef: RefObject<string | null>; setSchema: Dispatch<SetStateAction<SchemaResult | null>>; setExpandedTables: Dispatch<SetStateAction<Set<string>>>; setExpandedSections: Dispatch<SetStateAction<Set<string>>>; loadSchema: (conn: ConnectionConfig, database?: string) => void; activeTabRef: RefObject<Tab>; updateActiveTab: (updates: Partial<Tab>) => void }) {
  return (
        <>
          <div
            style={modalBackdrop}
            onClick={() => setDropConfirm(null)}
          />
          <div style={{
            position: "fixed", top: "50%", left: "50%",
            transform: "translate(-50%,-50%)",
            zIndex: 1000, background: "var(--surface-2)",
            border: "1px solid var(--border)", borderRadius: 12,
            padding: "24px 28px", minWidth: 380, maxWidth: 520,
            boxShadow: "var(--shadow-lg)",
          }}>
            {/* Header */}
            <div style={{ display: "flex", alignItems: "center",
              gap: 10, marginBottom: 12 }}>
              <span style={{ fontSize: 20 }}>⚠️</span>
              <div style={{ fontSize: 14, fontWeight: 700, color: "var(--text)" }}>
                Drop {dropConfirm.type}
              </div>
            </div>

            {/* Warning text */}
            <div style={{ fontSize: 12, color: "var(--text-secondary)",
              marginBottom: 16, lineHeight: 1.6 }}>
              This will permanently drop{" "}
              <strong style={{ color: "var(--text)" }}>
                {dropConfirm.name}
              </strong>.
              This action cannot be undone.
            </div>

            {/* SQL preview */}
            <div style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 20,
              fontFamily: "var(--mono)",
              fontSize: 12,
              color: "var(--error)",
            }}>
              {dropConfirm.dropSql}
            </div>

            {/* Buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={async () => {
                  try {
                    const conn = dropConfirm.connection;
                    await invoke("drop_object", {
                      objectName:    dropConfirm.name,
                      objectType:    dropConfirm.type,
                      schemaName:    dropConfirm.schema,
                      tableName:     dropConfirm.tableName,
                      params: {
                        credentialRef: conn.credentialRef,
                        engine:        conn.engine,
                        host:          conn.host,
                        port:          conn.port,
                        database:      conn.database,
                        username:      conn.username,
                        sslMode:       conn.sslMode ?? "prefer",
                        sqlInstance:   conn.sqlInstance ?? "",
                        windowsAuth:   conn.windowsAuth ?? false,
                      },
                    });

                    // Invalidate schema cache and reload
                    purgeSchemaCache(conn.id);
                    schemaConnectionIdRef.current = null;
                    setSchema(null);
                    setExpandedTables(new Set());
                    setExpandedSections(new Set());
                    loadSchema(conn, activeTabRef.current.activeDatabase ?? conn.database);

                    setDropConfirm(null);
                  } catch (e) {
                    // Show error in results area
                    updateActiveTab({ error: `Drop failed: ${toIpcError(e).message}` });
                    setDropConfirm(null);
                  }
                }}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "var(--error)", color: "white",
                  border: "none", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "var(--mono)", fontWeight: 600,
                }}
              >
                Drop {dropConfirm.type}
              </button>
              <button
                onClick={() => setDropConfirm(null)}
                style={{
                  flex: 1, padding: "8px 0",
                  background: "transparent", color: "var(--text-tertiary)",
                  border: "1px solid var(--border)", borderRadius: 6,
                  cursor: "pointer", fontSize: 12,
                  fontFamily: "var(--mono)",
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </>
  );
}
