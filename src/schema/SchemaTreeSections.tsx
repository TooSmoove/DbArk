import type {
  ConnectionConfig, ProcedureInfo, FunctionInfo, ViewInfo, TriggerInfo, IndexInfo,
  SchemaContextMenu,
} from "../types";
import { SchemaSection } from "../ui";
import { ellipsisLabel } from "../ui/styles";

// Presentational schema-tree sections for the object categories that render a
// flat list of items. Extracted from App.tsx; each is a thin wrapper around the
// shared <SchemaSection>. Business actions (open context menu, query a view)
// are passed in as callbacks.
type OpenMenu = (menu: SchemaContextMenu) => void;

interface SectionBase {
  conn:       ConnectionConfig;
  expanded:   boolean;
  onToggle:   () => void;
  onOpenMenu: OpenMenu;
}

const itemRowStyle = {
  display: "flex", alignItems: "center", gap: 6,
  padding: "5px 14px 5px 20px",
  borderTop: "1px solid var(--border)",
} as const;

const microMono = {
  fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)", flexShrink: 0,
} as const;

export function ProceduresSection({ procedures, conn, expanded, onToggle, onOpenMenu }:
  SectionBase & { procedures: ProcedureInfo[] }) {
  return (
    <SchemaSection
      label="Stored Procedures"
      icon="⚙"
      count={procedures.length}
      sectionKey={`${conn.id}-procedures`}
      expanded={expanded}
      onToggle={onToggle}
      emptyMessage={conn.engine === "sqlite" ? "SQLite doesn't support stored procedures" : undefined}
    >
      {procedures.map(proc => (
        <div key={`${proc.schema}.${proc.name}`}
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenMenu({ x: e.clientX, y: e.clientY, name: proc.name, type: "procedure", schema: proc.schema, connection: conn });
          }}
          style={{ ...itemRowStyle, cursor: "default" }}
        >
          <span style={{ fontSize: 10, color: "var(--accent)", flexShrink: 0 }}>ƒ</span>
          <span style={ellipsisLabel}>{proc.name}</span>
          <span style={microMono}>{proc.parameterCount}p</span>
        </div>
      ))}
    </SchemaSection>
  );
}

export function FunctionsSection({ functions, conn, expanded, onToggle, onOpenMenu }:
  SectionBase & { functions: FunctionInfo[] }) {
  return (
    <SchemaSection
      label="Functions"
      icon="λ"
      count={functions.length}
      sectionKey={`${conn.id}-functions`}
      expanded={expanded}
      onToggle={onToggle}
      emptyMessage={conn.engine === "sqlite" ? "SQLite doesn't support user-defined functions" : undefined}
    >
      {functions.map(fn => (
        <div key={`${fn.schema}.${fn.name}`}
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenMenu({ x: e.clientX, y: e.clientY, name: fn.name, type: "function", schema: fn.schema, connection: conn });
          }}
          style={itemRowStyle}
        >
          <span style={{ fontSize: 10, color: fn.functionType === "table" ? "var(--success)" : "var(--warning)", flexShrink: 0 }}>λ</span>
          <span style={ellipsisLabel}>{fn.name}</span>
          <span style={microMono}>{fn.functionType}</span>
        </div>
      ))}
    </SchemaSection>
  );
}

export function ViewsSection({ views, conn, expanded, onToggle, onOpenMenu, onQuery }:
  SectionBase & { views: ViewInfo[]; onQuery: (sql: string) => void }) {
  return (
    <SchemaSection
      label="Views"
      icon="◫"
      count={views.length}
      sectionKey={`${conn.id}-views`}
      expanded={expanded}
      onToggle={onToggle}
    >
      {views.map(view => (
        <div key={`${view.schema}.${view.name}`}
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenMenu({ x: e.clientX, y: e.clientY, name: view.name, type: "view", schema: view.schema, connection: conn });
          }}
          style={{ ...itemRowStyle, cursor: "pointer" }}
          onDoubleClick={() => {
            const limit = conn.engine === "sqlserver"
              ? `SELECT TOP 100 * FROM ${view.name}`
              : `SELECT * FROM ${view.name} LIMIT 100`;
            onQuery(limit);
          }}
          title="Double-click to query"
        >
          <span style={{ fontSize: 9, color: "var(--info)", flexShrink: 0 }}>◫</span>
          <span style={ellipsisLabel}>{view.name}</span>
        </div>
      ))}
    </SchemaSection>
  );
}

export function TriggersSection({ triggers, conn, expanded, onToggle, onOpenMenu }:
  SectionBase & { triggers: TriggerInfo[] }) {
  return (
    <SchemaSection
      label="Triggers"
      icon="⚡"
      count={triggers.length}
      sectionKey={`${conn.id}-triggers`}
      expanded={expanded}
      onToggle={onToggle}
    >
      {triggers.map(trigger => (
        <div key={trigger.name}
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenMenu({ x: e.clientX, y: e.clientY, name: trigger.name, type: "trigger", schema: trigger.tableName, connection: conn });
          }}
          style={itemRowStyle}
        >
          <span style={{ fontSize: 9, color: "var(--error)", flexShrink: 0 }}>⚡</span>
          <span style={ellipsisLabel}>{trigger.name}</span>
          <span style={{ ...microMono, textAlign: "right" }}>{trigger.timing} {trigger.event}</span>
        </div>
      ))}
    </SchemaSection>
  );
}

export function IndexesSection({ indexes, conn, expanded, onToggle, onOpenMenu }:
  SectionBase & { indexes: IndexInfo[] }) {
  return (
    <SchemaSection
      label="Indexes"
      icon="⊞"
      count={indexes.length}
      sectionKey={`${conn.id}-indexes`}
      expanded={expanded}
      onToggle={onToggle}
    >
      {indexes.map(idx => (
        <div key={`${idx.tableName}.${idx.name}`}
          onContextMenu={(e) => {
            e.preventDefault();
            onOpenMenu({
              x: e.clientX, y: e.clientY,
              name: idx.name, type: "index",
              schema: idx.tableName, connection: conn,
              extra: conn.engine === "sqlite"
                ? undefined
                : { tableName: idx.tableName, columns: idx.columns, isUnique: idx.isUnique, isPrimary: idx.isPrimary },
            });
          }}
          style={itemRowStyle}
        >
          <span style={{ fontSize: 9, color: idx.isPrimary ? "var(--warning)" : idx.isUnique ? "var(--accent)" : "var(--text-disabled)", flexShrink: 0 }}>
            {idx.isPrimary ? "🔑" : idx.isUnique ? "◈" : "◇"}
          </span>
          <span style={ellipsisLabel}>{idx.name}</span>
          <span style={{ fontSize: 9, color: "var(--text-disabled)", fontFamily: "var(--mono)", flexShrink: 0, maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            title={idx.columns}>
            {idx.tableName}
          </span>
        </div>
      ))}
    </SchemaSection>
  );
}
