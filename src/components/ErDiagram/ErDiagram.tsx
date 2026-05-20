// src/components/ErDiagram/ErDiagram.tsx
//
// Top-level ER diagram component. Mount this inside the schema panel tab.
//
// Usage:
//   <ErDiagram schema={schemaResult} />
//
// schemaResult is the existing SchemaResult returned by the get_schema Tauri
// command — now with a foreignKeys field populated by the C# SchemaExplorer.

import { useMemo, useState } from "react";
import type { SchemaResult } from "./diagramTypes";
import { buildDiagramData } from "./diagramUtils";
import { DiagramCanvas } from "./DiagramCanvas";
import { TableSelector } from "./TableSelector";
import "./erDiagram.css";

const LARGE_SCHEMA_THRESHOLD = 50;

interface Props {
  schema: SchemaResult;
}

export function ErDiagram({ schema }: Props) {
  const tableIds = useMemo(
    () => schema.tables.map((t) => `${t.schema}.${t.name}`),
    [schema.tables],
  );

  const isLarge = schema.tables.length > LARGE_SCHEMA_THRESHOLD;

  // Default selection: all tables for small schemas, empty for large schemas
  // (so the selector modal opens with a deliberate choice).
  const [selection, setSelection] = useState<Set<string>>(
    () => (isLarge ? new Set() : new Set(tableIds)),
  );
  const [selectorOpen, setSelectorOpen] = useState(isLarge);

  const diagramData = useMemo(
    () => buildDiagramData(schema, selection),
    [schema, selection],
  );

  // Empty-schema / no-FKs short-circuit — render an explanatory message
  // rather than an empty SVG. FK-less schemas can still be useful (each
  // table on its own), so we only short-circuit if there are zero tables.
  if (schema.tables.length === 0) {
    return (
      <div className="er-diagram-empty-state">
        <p>This connection has no tables to diagram.</p>
      </div>
    );
  }

  if (selection.size === 0) {
    return (
      <div className="er-diagram-empty-state">
        <p>
          This schema has {schema.tables.length} tables — too many to auto-layout.
          Pick a subset to render.
        </p>
        <button
          type="button"
          className="er-button-primary"
          onClick={() => setSelectorOpen(true)}
        >
          Select tables
        </button>
        {selectorOpen && (
          <TableSelector
            tables={schema.tables}
            initialSelection={selection}
            onApply={(next) => {
              setSelection(next);
              setSelectorOpen(false);
            }}
            onCancel={() => setSelectorOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="er-diagram">
      <div className="er-diagram-header">
        <button
          type="button"
          className="er-button-secondary"
          onClick={() => setSelectorOpen(true)}
        >
          Tables ({selection.size}/{schema.tables.length})
        </button>
        {(schema.foreignKeys ?? []).length === 0 && (
          <span className="er-diagram-warning">
            No foreign keys detected — tables will render unconnected.
          </span>
        )}
      </div>

      <DiagramCanvas nodes={diagramData.nodes} edges={diagramData.edges} />

      {selectorOpen && (
        <TableSelector
          tables={schema.tables}
          initialSelection={selection}
          onApply={(next) => {
            setSelection(next);
            setSelectorOpen(false);
          }}
          onCancel={() => setSelectorOpen(false)}
        />
      )}
    </div>
  );
}
