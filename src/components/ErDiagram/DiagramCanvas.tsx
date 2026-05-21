// src/components/ErDiagram/DiagramCanvas.tsx
//
// SVG canvas for the ER diagram. All node and edge rendering is done
// imperatively with d3.selection.join — this keeps 60fps animation working
// for schemas up to ~100 tables, which React's per-tick reconciliation
// cannot match. React owns only the SVG shell, the toolbar, and highlight
// state.
//
// Lifecycle:
//   1. Component mounts → useEffect builds simulation, runs once per resetKey.
//   2. Simulation ticks → tick handler updates DOM positions directly.
//   3. Highlight state changes → second useEffect adjusts opacity classes.
//   4. Component unmounts → simulation.stop() in cleanup.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import type { DiagramNode, DiagramEdge } from "./diagramTypes";
import {
  HEADER_HEIGHT,
  ROW_HEIGHT,
  exportDiagramPNG,
  exportDiagramSVG,
} from "./diagramUtils";

interface Props {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export function DiagramCanvas({ nodes, edges }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const edgeLayerRef = useRef<SVGGElement>(null);
  const nodeLayerRef = useRef<SVGGElement>(null);
  const containerRef = useRef<SVGGElement>(null);

  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  // Map of node id → set of adjacent node ids, derived once per edge change.
  // Used by the highlight effect to dim non-adjacent tables.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      const s = typeof e.source === "string" ? e.source : e.source.id;
      const t = typeof e.target === "string" ? e.target : e.target.id;
      if (!map.has(s)) map.set(s, new Set());
      if (!map.has(t)) map.set(t, new Set());
      map.get(s)!.add(t);
      map.get(t)!.add(s);
    }
    return map;
  }, [edges]);

  // Main simulation effect — runs on mount, when nodes/edges change, or when
  // resetKey ticks (user clicked Reset).
  useEffect(() => {
    if (!svgRef.current || !edgeLayerRef.current || !nodeLayerRef.current) {
      return;
    }

    const svg = d3.select(svgRef.current);
    const edgeLayer = d3.select(edgeLayerRef.current);
    const nodeLayer = d3.select(nodeLayerRef.current);
    const container = d3.select(containerRef.current!);

    const { clientWidth: w, clientHeight: h } = svgRef.current;

    // d3-force mutates nodes/edges, so we work on shallow copies.
    const simNodes: DiagramNode[] = nodes.map((n) => ({ ...n }));
    const simEdges: DiagramEdge[] = edges.map((e) => ({ ...e }));

    const simulation = d3
    .forceSimulation<DiagramNode>(simNodes)
    .force(
      "link",
      d3
        .forceLink<DiagramNode, DiagramEdge>(simEdges)
        .id((d) => d.id)
        .distance(160)
        .strength(0.5),
    )
    .force("charge", d3.forceManyBody().strength(-600).distanceMax(800))
    // forceX/forceY anchor each node individually toward centre — forceCenter
    // only shifts the whole group, which is why tables can drift to the edges.
    .force("x", d3.forceX(w / 2).strength(0.08))
    .force("y", d3.forceY(h / 2).strength(0.08))
    .force(
      "collide",
      d3
        .forceCollide<DiagramNode>()
        .radius((d) => Math.hypot(d.width, d.height) / 2 + 20)
        .strength(0.9),
    )
    .alphaDecay(0.04);  // settle faster (default 0.0228 = ~300 ticks before stop)

    // ── Edge selection ──────────────────────────────────────────────────────
    const edgeSel = edgeLayer
      .selectAll<SVGGElement, DiagramEdge>("g.er-edge")
      .data(simEdges, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "er-edge");
        g.append("path")
          .attr("class", "er-edge-line")
          .attr("marker-end", "url(#er-arrowhead)");
        g.append("text")
          .attr("class", "er-edge-label")
          .attr("text-anchor", "middle")
          .attr("dy", -4);
        return g;
      });

    edgeSel.select("text.er-edge-label").text((d) => d.cardinality);

    // ── Node selection ──────────────────────────────────────────────────────
    const nodeSel = nodeLayer
      .selectAll<SVGGElement, DiagramNode>("g.er-node")
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const g = enter
          .append("g")
          .attr("class", "er-node")
          .attr("data-node-id", (d) => d.id);

        // Body rect
        g.append("rect")
          .attr("class", "er-table-rect")
          .attr("width", (d) => d.width)
          .attr("height", (d) => d.height)
          .attr("rx", 6);

        // Header rect
        g.append("rect")
          .attr("class", "er-table-header")
          .attr("width", (d) => d.width)
          .attr("height", HEADER_HEIGHT)
          .attr("rx", 6);
        // Square off the bottom of the header rect by overlaying a rect
        // — simpler than path-based corners
        g.append("rect")
          .attr("class", "er-table-header")
          .attr("y", HEADER_HEIGHT - 6)
          .attr("width", (d) => d.width)
          .attr("height", 6);

        // Schema label (small, top-left)
        g.append("text")
          .attr("class", "er-table-schema")
          .attr("x", 10)
          .attr("y", 13)
          .text((d) => d.schema);

        // Table name (larger, below schema)
        g.append("text")
          .attr("class", "er-table-name")
          .attr("x", 10)
          .attr("y", 27)
          .text((d) => d.name);

        // Junction badge (top-right) — only on junction tables
        g.filter((d) => d.isJunction)
          .append("text")
          .attr("class", "er-junction-badge")
          .attr("x", (d) => d.width - 10)
          .attr("y", 20)
          .attr("text-anchor", "end")
          .text("M:N");

        // Column rows
        g.each(function (d) {
          const node = d3.select(this);
          d.columns.forEach((col, i) => {
            const y = HEADER_HEIGHT + i * ROW_HEIGHT;

            // Row divider
            if (i > 0) {
              node
                .append("line")
                .attr("class", "er-row-divider")
                .attr("x1", 0)
                .attr("x2", d.width)
                .attr("y1", y)
                .attr("y2", y);
            }

            // PK indicator (left margin)
            if (col.isPrimaryKey) {
              node
                .append("circle")
                .attr("class", "er-pk-badge")
                .attr("cx", 12)
                .attr("cy", y + ROW_HEIGHT / 2)
                .attr("r", 3);
            }

            // Column name
            node
              .append("text")
              .attr("class", "er-column-text")
              .attr("x", col.isPrimaryKey ? 22 : 10)
              .attr("y", y + ROW_HEIGHT / 2 + 4)
              .text(col.name);

            // Column type (right-aligned)
            node
              .append("text")
              .attr("class", "er-column-type")
              .attr("x", d.width - 10)
              .attr("y", y + ROW_HEIGHT / 2 + 4)
              .attr("text-anchor", "end")
              .text(col.dataType);
          });
        });

        // Drag handler — fixes node position while dragging, releases on end
        const drag = d3
          .drag<SVGGElement, DiagramNode>()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, _d) => {
            if (!event.active) simulation.alphaTarget(0);
            // Leave the node pinned where the user dropped it — feels right.
            // Use a Reset Layout click to re-run the simulation from scratch.
          });

        g.call(drag).on("click", (event, d) => {
          event.stopPropagation();
          setHighlightedId((current) => (current === d.id ? null : d.id));
        });

        return g;
      });

    // Centre each node on its (x,y) by offsetting -width/2, -height/2
    const tick = () => {
      nodeSel.attr(
        "transform",
        (d) => `translate(${(d.x ?? 0) - d.width / 2}, ${(d.y ?? 0) - d.height / 2})`,
      );

      edgeSel.select<SVGPathElement>("path.er-edge-line").attr("d", (d) => {
        const s = d.source as DiagramNode;
        const t = d.target as DiagramNode;
        return edgePath(s, t);
      });

      edgeSel.select<SVGTextElement>("text.er-edge-label").attr("transform", (d) => {
        const s = d.source as DiagramNode;
        const t = d.target as DiagramNode;
        const mx = ((s.x ?? 0) + (t.x ?? 0)) / 2;
        const my = ((s.y ?? 0) + (t.y ?? 0)) / 2;
        return `translate(${mx}, ${my})`;
      });
    };

    simulation.on("tick", tick);

    // Zoom & pan on the SVG root, applied to the inner container group
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .filter((event) => {
        // Allow zoom only when not clicking a node — d3-drag handles those
        return !event.target.closest(".er-node") || event.type === "wheel";
      })
      .on("zoom", (event) => {
        container.attr("transform", event.transform.toString());
      });

   svg.call(zoom);

    // Auto-fit to view once the simulation settles. Computes the bounding box of
    // all nodes and applies a zoom transform that fits them in the viewport with
    // padding. Fires once per layout — drag/zoom afterwards is user-controlled.
    simulation.on("end", () => {
      if (simNodes.length === 0) return;

      let minX = Infinity, minY = Infinity;
      let maxX = -Infinity, maxY = -Infinity;
      for (const n of simNodes) {
        const x = n.x ?? 0;
        const y = n.y ?? 0;
        minX = Math.min(minX, x - n.width / 2);
        minY = Math.min(minY, y - n.height / 2);
        maxX = Math.max(maxX, x + n.width / 2);
        maxY = Math.max(maxY, y + n.height / 2);
      }

      const padding = 60;
      const boxW = (maxX - minX) + padding * 2;
      const boxH = (maxY - minY) + padding * 2;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      // Scale down to fit, never scale up past 1×
      const scale = Math.min(w / boxW, h / boxH, 1);
      const tx = w / 2 - cx * scale;
      const ty = h / 2 - cy * scale;

      svg
        .transition()
        .duration(400)
        .call(
          zoom.transform,
          d3.zoomIdentity.translate(tx, ty).scale(scale),
        );
    });

    // Click empty area to clear highlight
    svg.on("click", () => setHighlightedId(null));

    return () => {
      simulation.stop();
      svg.on(".zoom", null);
      svg.on("click", null);
    };
    // resetKey in deps forces a re-run on Reset click
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, resetKey]);

  // ── Highlight effect ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!nodeLayerRef.current || !edgeLayerRef.current) return;

    const nodeLayer = d3.select(nodeLayerRef.current);
    const edgeLayer = d3.select(edgeLayerRef.current);

    if (highlightedId === null) {
      nodeLayer.selectAll<SVGGElement, DiagramNode>("g.er-node").classed("er-dim", false).classed("er-highlight", false);
      edgeLayer.selectAll<SVGGElement, DiagramEdge>("g.er-edge").classed("er-dim", false).classed("er-highlight", false);
      return;
    }

    const adjacent = adjacency.get(highlightedId) ?? new Set();

    nodeLayer
      .selectAll<SVGGElement, DiagramNode>("g.er-node")
      .classed("er-highlight", (d) => d.id === highlightedId || adjacent.has(d.id))
      .classed("er-dim", (d) => d.id !== highlightedId && !adjacent.has(d.id));

    edgeLayer
      .selectAll<SVGGElement, DiagramEdge>("g.er-edge")
      .each(function (d) {
        const s = typeof d.source === "string" ? d.source : d.source.id;
        const t = typeof d.target === "string" ? d.target : d.target.id;
        const isAdjacent = s === highlightedId || t === highlightedId;
        d3.select(this).classed("er-highlight", isAdjacent).classed("er-dim", !isAdjacent);
      });
  }, [highlightedId, adjacency]);

  const handleReset = useCallback(() => {
    setResetKey((k) => k + 1);
    setHighlightedId(null);
  }, []);

  const handleExportPNG = useCallback(() => {
    if (svgRef.current) void exportDiagramPNG(svgRef.current);
  }, []);

  const handleExportSVG = useCallback(() => {
    if (svgRef.current) exportDiagramSVG(svgRef.current);
  }, []);

  return (
    <div className="er-diagram-canvas">
      <div className="er-diagram-controls">
        <button type="button" onClick={handleReset} title="Re-run force layout">
          Reset layout
        </button>
        <button type="button" onClick={handleExportPNG}>Export PNG</button>
        <button type="button" onClick={handleExportSVG}>Export SVG</button>
      </div>
      <svg ref={svgRef} className="er-diagram-svg">
        <defs>
          <marker
            id="er-arrowhead"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <g ref={containerRef}>
          <g ref={edgeLayerRef} />
          <g ref={nodeLayerRef} />
        </g>
      </svg>
    </div>
  );
}

// Compute a path from source table to target table that exits the source
// rectangle and enters the target rectangle on whichever side faces the
// other table. Keeps edges from cutting through tables.
function edgePath(s: DiagramNode, t: DiagramNode): string {
  const sx = s.x ?? 0;
  const sy = s.y ?? 0;
  const tx = t.x ?? 0;
  const ty = t.y ?? 0;

  const dx = tx - sx;
  const dy = ty - sy;

  // Pick exit/entry sides based on dominant axis
  const sourcePt = rectEdgePoint(sx, sy, s.width, s.height, dx, dy);
  const targetPt = rectEdgePoint(tx, ty, t.width, t.height, -dx, -dy);

  // Smooth curve via cubic bezier with horizontal/vertical bias
  const midX = (sourcePt.x + targetPt.x) / 2;
  const midY = (sourcePt.y + targetPt.y) / 2;
  return `M ${sourcePt.x} ${sourcePt.y} Q ${midX} ${midY} ${targetPt.x} ${targetPt.y}`;
}

function rectEdgePoint(
  cx: number,
  cy: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
): { x: number; y: number } {
  // Project the direction (dx, dy) onto the rectangle edge centred at (cx, cy)
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = w / 2;
  const hh = h / 2;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);
  const scale = Math.min(hw / absDx, hh / absDy);
  return { x: cx + dx * scale, y: cy + dy * scale };
}
