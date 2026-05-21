// src/components/ErDiagram/diagramUtils.ts
//
// Pure functions for the ER diagram:
//   - buildDiagramData:   schema + selection → nodes + edges
//   - detectJunctionTables: returns the set of junction table IDs
//   - exportDiagramSVG:   serialise the live <svg> and trigger a download
//   - exportDiagramPNG:   rasterise the live <svg> via html-to-image and download

import { toPng } from "html-to-image";
import type {
  SchemaResult,
  TableInfo,
  ForeignKey,
  DiagramNode,
  DiagramEdge,
} from "./diagramTypes";

// ── Layout constants ────────────────────────────────────────────────────────
//
// Kept in one place so DiagramCanvas.tsx imports them rather than redefining.

export const TABLE_WIDTH = 240;
export const HEADER_HEIGHT = 32;
export const ROW_HEIGHT = 22;

// ── Junction table detection ────────────────────────────────────────────────
//
// A junction table is a pure many-to-many bridge: exactly two outgoing FKs,
// and the table's primary key is exactly the set of those two FK source
// columns (no extra business columns). This is the conservative definition
// that avoids false positives on tables that happen to have two FKs plus
// data columns.

export function detectJunctionTables(
  tables: TableInfo[],
  foreignKeys: ForeignKey[],
): Set<string> {
  const tableId = (schema: string, name: string) => `${schema}.${name}`;

  // Group FKs by source table
  const fkBySourceTable = new Map<string, ForeignKey[]>();
  for (const fk of foreignKeys) {
    const id = tableId(fk.sourceSchema, fk.sourceTable);
    const list = fkBySourceTable.get(id) ?? [];
    list.push(fk);
    fkBySourceTable.set(id, list);
  }

  const junctions = new Set<string>();

  for (const table of tables) {
    const id = tableId(table.schema, table.name);
    const fks = fkBySourceTable.get(id) ?? [];

    // Group FKs by constraint name (composite FKs share a constraint)
    const fksByConstraint = new Map<string, ForeignKey[]>();
    for (const fk of fks) {
      const list = fksByConstraint.get(fk.constraintName) ?? [];
      list.push(fk);
      fksByConstraint.set(fk.constraintName, list);
    }

    // Two distinct FK constraints required
    if (fksByConstraint.size !== 2) continue;

    // PK columns must equal the union of FK source columns
    const pkCols = new Set(
      table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    );
    const fkCols = new Set(fks.map((fk) => fk.sourceColumn));

    if (pkCols.size === 0) continue;
    if (pkCols.size !== fkCols.size) continue;

    let matches = true;
    for (const col of pkCols) {
      if (!fkCols.has(col)) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    junctions.add(id);
  }

  return junctions;
}

// ── Build diagram data from schema + selection ──────────────────────────────

interface BuildResult {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export function buildDiagramData(
  schema: SchemaResult,
  selectedTableIds: Set<string>,
): BuildResult {
  const tableId = (s: string, n: string) => `${s}.${n}`;

  // Filter tables by selection
  const visibleTables = schema.tables.filter((t) =>
    selectedTableIds.has(tableId(t.schema, t.name)),
  );
  const visibleIds = new Set(
    visibleTables.map((t) => tableId(t.schema, t.name)),
  );

  // Detect junctions across the FULL schema (not just visible) so we don't
  // mis-classify a junction as a regular table when its peer is hidden.
  const junctions = detectJunctionTables(
    schema.tables,
    schema.foreignKeys ?? [],
  );

  // Build nodes — sized by column count
  const nodes: DiagramNode[] = visibleTables.map((t) => {
    const id = tableId(t.schema, t.name);
    return {
      id,
      schema: t.schema,
      name: t.name,
      columns: t.columns,
      isJunction: junctions.has(id),
      width: TABLE_WIDTH,
      height: HEADER_HEIGHT + Math.max(t.columns.length, 1) * ROW_HEIGHT,
    };
  });

  // Build edges — only when both endpoints are visible. Collapse composite FKs
  // (same constraint name, multiple columns) into a single edge labelled with
  // the first column pair to keep the diagram readable. The cardinality is
  // 1:N by default; M:N is implied by the junction table badge on the source.
  const seen = new Set<string>();
  const edges: DiagramEdge[] = [];

  for (const fk of schema.foreignKeys ?? []) {
    const src = tableId(fk.sourceSchema, fk.sourceTable);
    const tgt = tableId(fk.targetSchema, fk.targetTable);
    if (!visibleIds.has(src) || !visibleIds.has(tgt)) continue;
    if (seen.has(fk.constraintName)) continue;
    seen.add(fk.constraintName);

    edges.push({
      id: fk.constraintName,
      source: src,
      target: tgt,
      constraintName: fk.constraintName,
      sourceColumn: fk.sourceColumn,
      targetColumn: fk.targetColumn,
      // M:N is shown via the junction badge on the source table, not on the
      // edge itself — the edge between a junction and its peer is still 1:N
      // at the FK level. This matches how SSMS/Workbench label things.
      cardinality: "1:N",
    });
  }

  return { nodes, edges };
}

// ── Export: SVG ─────────────────────────────────────────────────────────────
//
// Serialise the live SVG node. Inline the computed styles for foreground
// elements so the downloaded SVG renders standalone (without the surrounding
// app stylesheet).

export function exportDiagramSVG(svg: SVGSVGElement, filename = "er-diagram.svg"): void {
  const clone = svg.cloneNode(true) as SVGSVGElement;

  // Inline a minimal stylesheet so the SVG renders without our app CSS
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `
    .er-table-rect { fill: #1e2026; stroke: rgba(255,255,255,0.12); stroke-width: 1; }
    .er-table-header { fill: #16181c; }
    .er-table-name { fill: #e8e9ec; font-family: 'IBM Plex Mono', monospace; font-size: 12px; font-weight: 600; }
    .er-table-schema { fill: #6b7280; font-family: 'IBM Plex Mono', monospace; font-size: 10px; }
    .er-column-text { fill: #e8e9ec; font-family: 'IBM Plex Mono', monospace; font-size: 11px; }
    .er-column-type { fill: #9ca3af; font-family: 'IBM Plex Mono', monospace; font-size: 10px; }
    .er-pk-badge { fill: #f59e0b; }
    .er-fk-badge { fill: #6c63ff; }
    .er-edge-line { stroke: #6c63ff; stroke-width: 1.5; fill: none; }
    .er-edge-label { fill: #9ca3af; font-family: 'IBM Plex Mono', monospace; font-size: 10px; }
    .er-junction-badge { fill: #10b981; }
  `;
  clone.insertBefore(style, clone.firstChild);

  const serialised = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialised], { type: "image/svg+xml;charset=utf-8" });
  triggerDownload(URL.createObjectURL(blob), filename);
}

// ── Export: PNG ─────────────────────────────────────────────────────────────
//
// Uses html-to-image to rasterise. Bumps pixelRatio for retina/4K so the
// export looks crisp when pasted into a doc or slide.

export async function exportDiagramPNG(
  svg: SVGSVGElement,
  filename = "er-diagram.png",
): Promise<void> {
  // html-to-image expects an HTMLElement. Wrap the SVG temporarily.
  const wrapper = document.createElement("div");
  wrapper.style.background = "#0e0f11";
  wrapper.style.display = "inline-block";
  wrapper.style.position = "absolute";
  wrapper.style.top = "-99999px";
  const clone = svg.cloneNode(true) as SVGSVGElement;
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  try {
    const dataUrl = await toPng(wrapper, {
      pixelRatio: 2,
      backgroundColor: "#0e0f11",
    });
    triggerDownload(dataUrl, filename);
  } finally {
    document.body.removeChild(wrapper);
  }
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (href.startsWith("blob:")) URL.revokeObjectURL(href);
}
