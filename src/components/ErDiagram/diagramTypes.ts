// src/components/ErDiagram/diagramTypes.ts
//
// Types for the ER diagram. ForeignKey and SchemaResult mirror the C# side
// (SchemaExplorer.cs). DiagramNode and DiagramEdge are the diagram-internal
// shapes consumed by d3-force.
//
// If you already have schema types in a central file (e.g. src/types/schema.ts),
// move ForeignKey + the SchemaResult extension there and import them from this
// file instead. Kept colocated for self-containment.

import type { SimulationNodeDatum, SimulationLinkDatum } from "d3-force";

// ── Mirror of C# SchemaExplorer types ───────────────────────────────────────

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
}

export interface TableInfo {
  name: string;
  schema: string;
  columns: ColumnInfo[];
}

export interface ForeignKey {
  constraintName: string;
  sourceSchema: string;
  sourceTable: string;
  sourceColumn: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
}

// Match SchemaResult shape from C#. If you have an existing definition,
// add the foreignKeys field there and remove this duplicate.
export interface SchemaResult {
  tables: TableInfo[];
  procedures?: unknown[];
  functions?: unknown[];
  views?: unknown[];
  triggers?: unknown[];
  indexes?: unknown[];
  foreignKeys?: ForeignKey[];
  error?: string;
}

// ── Diagram-internal shapes ─────────────────────────────────────────────────

export interface DiagramNode extends SimulationNodeDatum {
  id: string; // schema.tableName
  schema: string;
  name: string;
  columns: ColumnInfo[];
  isJunction: boolean;
  width: number;
  height: number;
}

export interface DiagramEdge extends SimulationLinkDatum<DiagramNode> {
  id: string;
  source: string | DiagramNode;
  target: string | DiagramNode;
  constraintName: string;
  sourceColumn: string;
  targetColumn: string;
  cardinality: "1:N" | "M:N";
}
