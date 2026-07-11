import type React from "react";
import type {
  ConnectionConfig, TableInfo, SchemaResult, SchemaContextMenu,
} from "../types";
import { SchemaSection } from "../ui";
import { microMutedLabel } from "../ui/styles";

// A single table row plus its (expandable) column list. Shared by both the
// schema-grouped and flat branches of TablesSection; the differing indentation
// is passed in via rowPadding / colPadding.
interface TableTreeItemProps {
  table:         TableInfo;
  expanded:      boolean;
  onToggle:      () => void;
  onQuery:       () => void;
  onContextMenu: React.MouseEventHandler<HTMLDivElement>;
  rowPadding:    string;
  colPadding:    string;
}

function TableTreeItem({ table, expanded, onToggle, onQuery, onContextMenu, rowPadding, colPadding }: TableTreeItemProps) {
  return (
    <div>
      <div
        onClick={onToggle}
        onDoubleClick={onQuery}
        onContextMenu={onContextMenu}
        title="Click to expand · Double-click to query"
        style={{
          display: "flex", alignItems: "center", gap: 6,
          padding: rowPadding, cursor: "pointer",
          borderTop: "1px solid var(--border)",
        }}
      >
        <span style={{ fontSize: 9, color: "var(--text-disabled)", flexShrink: 0, width: 10 }}>
          {expanded ? "▾" : "▸"}
        </span>
        <span style={{
          fontSize: 11, color: "var(--text-secondary)", flex: 1,
          overflow: "hidden", textOverflow: "ellipsis",
          whiteSpace: "nowrap", fontFamily: "var(--mono)",
        }}>
          {table.name}
        </span>
        <span style={microMutedLabel}>{table.columns?.length ?? 0}</span>
      </div>

      {expanded && (table.columns ?? []).map(col => (
        <div
          key={col.name}
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: colPadding, borderTop: "1px solid var(--bg)",
          }}
        >
          {col.isPrimaryKey && (
            <span style={{ fontSize: 8, color: "var(--warning)", flexShrink: 0 }}>🔑</span>
          )}
          <span style={{
            fontSize: 11,
            color: col.isPrimaryKey ? "var(--text)" : "var(--text-tertiary)",
            fontFamily: "var(--mono)", flex: 1,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>
            {col.name}
          </span>
          <span style={microMutedLabel}>{col.dataType}</span>
        </div>
      ))}
    </div>
  );
}

interface TablesSectionProps {
  conn:            ConnectionConfig;
  tables:          TableInfo[];
  tablesBySchema:  Map<string, TableInfo[]>;
  schema:          SchemaResult | null;
  expanded:        boolean;
  onToggle:        () => void;
  expandedSchemas: Set<string>;
  expandedTables:  Set<string>;
  onToggleSchema:  (key: string) => void;
  onToggleTable:   (key: string) => void;
  onQuery:         (sql: string) => void;
  onOpenMenu:      (menu: SchemaContextMenu) => void;
  showDiagram:     boolean;
  onShowDiagram:   () => void;
}

export function TablesSection({
  conn, tables, tablesBySchema, schema, expanded, onToggle,
  expandedSchemas, expandedTables, onToggleSchema, onToggleTable,
  onQuery, onOpenMenu, showDiagram, onShowDiagram,
}: TablesSectionProps) {
  // Postgres/CockroachDB with multiple schemas get a schema-grouped tree;
  // everything else (and single-schema Postgres) renders a flat table list.
  const grouped = (conn.engine === "postgres" || conn.engine === "cockroachdb") && tablesBySchema.size > 1;

  return (
    <SchemaSection
      label="Tables"
      icon="▤"
      count={tables.length}
      sectionKey={`${conn.id}-tables`}
      expanded={expanded}
      onToggle={onToggle}
    >
      {grouped
        ? [...tablesBySchema.entries()].map(([schemaName, schemaTables]) => (
            <div key={schemaName}>
              {/* Schema header */}
              <div
                onClick={() => onToggleSchema(schemaName)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "5px 14px", cursor: "pointer",
                  borderTop: "1px solid var(--border)", background: "var(--bg)",
                }}
                onMouseEnter={e => (e.currentTarget.style.background = "var(--bg)")}
                onMouseLeave={e => (e.currentTarget.style.background = "var(--bg)")}
              >
                <span style={{ fontSize: 9, color: "var(--accent)", flexShrink: 0, width: 10 }}>
                  {expandedSchemas.has(schemaName) ? "▾" : "▸"}
                </span>
                <span style={{
                  fontSize: 10, color: "var(--accent)", fontFamily: "var(--mono)",
                  flex: 1, fontWeight: 600, letterSpacing: ".03em",
                }}>
                  {schemaName}
                </span>
                <span style={microMutedLabel}>{schemaTables.length}</span>
              </div>

              {/* Schema sidebar toolbar — Diagram toggle */}
              {schema && schema.tables.length > 0 && (
                <div style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "6px 14px", borderBottom: "1px solid var(--border)", background: "var(--bg)",
                }}>
                  <span style={{
                    fontSize: 10, color: "var(--text-tertiary)", fontFamily: "var(--mono)",
                    textTransform: "uppercase", letterSpacing: "0.05em",
                  }}>
                    Schema
                  </span>
                  <button
                    onClick={onShowDiagram}
                    title="Show ER diagram of this connection's tables"
                    style={{
                      fontSize: 10, fontFamily: "var(--mono)",
                      color: showDiagram ? "var(--accent)" : "var(--text-tertiary)",
                      background: "none", border: "1px solid var(--border)",
                      borderRadius: 4, padding: "3px 8px", cursor: "pointer",
                    }}
                  >
                    ⊞ Diagram
                  </button>
                </div>
              )}

              {/* Tables under this schema */}
              {expandedSchemas.has(schemaName) && schemaTables.map(table => (
                <TableTreeItem
                  key={`${schemaName}.${table.name}`}
                  table={table}
                  expanded={expandedTables.has(`${schemaName}.${table.name}`)}
                  onToggle={() => onToggleTable(`${schemaName}.${table.name}`)}
                  onQuery={() => onQuery(`SELECT * FROM ${schemaName}.${table.name} LIMIT 100`)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onOpenMenu({ x: e.clientX, y: e.clientY, name: table.name, type: "table", schema: schemaName, connection: conn });
                  }}
                  rowPadding="5px 14px 5px 24px"
                  colPadding="3px 14px 3px 36px"
                />
              ))}
            </div>
          ))
        : tables.map(table => (
            <TableTreeItem
              key={`${table.schema ?? "public"}.${table.name}`}
              table={table}
              expanded={expandedTables.has(table.name)}
              onToggle={() => onToggleTable(table.name)}
              onQuery={() => onQuery(conn.engine === "sqlserver"
                ? `SELECT TOP 100 * FROM ${table.name}`
                : `SELECT * FROM ${table.name} LIMIT 100`)}
              onContextMenu={(e) => {
                e.preventDefault();
                onOpenMenu({ x: e.clientX, y: e.clientY, name: table.name, type: "table", schema: table.schema || "dbo", connection: conn });
              }}
              rowPadding="5px 14px"
              colPadding="3px 14px 3px 26px"
            />
          ))}
    </SchemaSection>
  );
}
