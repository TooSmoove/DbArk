import type { SchemaContextMenu, SchemaResult } from "../types";
import { scriptTable, scriptExecute } from "../sql/scripting";

// Presentational context menu for a schema object (table/view/procedure/etc).
// Named SchemaObjectMenu to avoid colliding with the SchemaContextMenu *type*.
// All business logic (IPC, tab creation, drop confirmation) is passed in as
// callbacks; the pure SQL-skeleton builders are imported directly since they
// are pure functions with their own unit tests.
interface SchemaObjectMenuProps {
  menu:   SchemaContextMenu;
  schema: SchemaResult | null;
  onClose:                () => void;
  onOpenDefinition:       (menu: SchemaContextMenu) => void;
  onSetScript:            (sql: string) => void;
  onScriptDropAndCreate:  (menu: SchemaContextMenu) => void | Promise<void>;
  onScriptCreateOrAlter:  (menu: SchemaContextMenu) => void | Promise<void>;
  onRequestDrop:          (menu: SchemaContextMenu) => void;
}

const dividerStyle = { height: 1, background: "var(--surface-3)", margin: "4px 0" } as const;

export function SchemaObjectMenu({
  menu,
  schema,
  onClose,
  onOpenDefinition,
  onSetScript,
  onScriptDropAndCreate,
  onScriptCreateOrAlter,
  onRequestDrop,
}: SchemaObjectMenuProps) {
  const engine = menu.connection.engine;

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 999 }}
        onClick={onClose}
      />
      <div style={{
        position: "fixed",
        left: menu.x,
        top: menu.y,
        zIndex: 1000,
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: "4px 0",
        minWidth: 200,
        boxShadow: "var(--shadow)",
      }}>
        {/* Header */}
        <div style={{
          padding: "6px 16px",
          fontSize: 10, color: "var(--text-disabled)",
          fontFamily: "var(--mono)",
          borderBottom: "1px solid var(--border)",
          marginBottom: 4,
        }}>
          {menu.type.toUpperCase()} · {menu.name}
        </div>

        {/* Open Definition — shown for every object type */}
        <button
          onClick={() => { onOpenDefinition(menu); onClose(); }}
          className="menu-item"
        >
          📄 Open Definition
        </button>

        {/* Table-specific CRUD scripts */}
        {menu.type === "table" && (() => {
          const table = schema?.tables.find(t => t.name === menu.name);
          if (!table) return null;
          return (
            <>
              <div style={dividerStyle} />
              {(["select", "insert", "update", "delete"] as const).map(type => (
                <button
                  key={type}
                  onClick={() => { onSetScript(scriptTable(table, type, engine)); onClose(); }}
                  className="menu-item"
                >
                  ✦ Script {type.toUpperCase()}
                </button>
              ))}
            </>
          );
        })()}

        {/* View — quick query */}
        {menu.type === "view" && (
          <button
            onClick={() => {
              const limit = engine === "sqlserver"
                ? `SELECT TOP 100 * FROM ${menu.name}`
                : `SELECT * FROM ${menu.name} LIMIT 100`;
              onSetScript(limit);
              onClose();
            }}
            className="menu-item"
          >
            ▶ Query View
          </button>
        )}

        {/* Procedure — Script EXECUTE */}
        {menu.type === "procedure" && (() => {
          const proc = schema?.procedures.find(p => p.name === menu.name);
          if (!proc) return null;
          return (
            <>
              <div style={dividerStyle} />
              <button
                onClick={() => { onSetScript(scriptExecute(proc, engine)); onClose(); }}
                className="menu-item"
              >
                ▶ Script EXECUTE
              </button>
            </>
          );
        })()}

        {/* Drop and Create — tables, procedures, functions, views */}
        {["table", "procedure", "function", "view"].includes(menu.type) && (
          <button
            onClick={async () => { await onScriptDropAndCreate(menu); onClose(); }}
            className="menu-item"
          >
            ⬇ Script DROP and CREATE
          </button>
        )}

        {/* Script CREATE OR ALTER — procedures, functions, views, triggers */}
        {["procedure", "function", "view", "trigger"].includes(menu.type) && (
          <button
            onClick={async () => { await onScriptCreateOrAlter(menu); onClose(); }}
            className="menu-item"
          >
            ✦ Script CREATE OR ALTER
          </button>
        )}

        {/* Drop — all types */}
        <div style={dividerStyle} />
        <button
          onClick={() => { onRequestDrop(menu); onClose(); }}
          className="menu-item menu-item--danger"
        >
          🗑️ Drop {menu.type}
        </button>
      </div>
    </>
  );
}
