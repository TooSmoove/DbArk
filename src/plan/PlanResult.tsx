// ─────────────────────────────────────────────────────────────────────────
// Execution-plan renderers (presentational React components).
// Extracted from App.tsx (code-audit item A-1).
// ─────────────────────────────────────────────────────────────────────────
import { Fragment } from "react";
import type { PlanNode, QueryResult } from "../types";
import {
  parsePostgresPlan, parseSqlServerPlan, parseMysqlPlan, parseSqlitePlan,
  collectAllNodes, hotNodeThreshold, isHotNode,
} from "./planParsers";

function PlanTreeRenderer({
  root, engine,
}: { root: PlanNode; engine: string }) {
  const allNodes = collectAllNodes(root);
  const useActual = allNodes.some(n => n.actualMs != null);
  const threshold = hotNodeThreshold(root);

  return (
    <div style={{
      flex: 1,
      overflow: "auto",
      padding: "12px 16px",
      fontFamily: "var(--mono)",
      fontSize: 12,
    }}>
      <div style={{
        color: "var(--text-tertiary)",
        fontSize: 11,
        marginBottom: 12,
      }}>
        Execution plan ({engine}) — {allNodes.length} nodes
        {useActual && " · actual times shown"}
      </div>
      <PlanNodeView
        node={root}
        depth={0}
        threshold={threshold}
        useActual={useActual}
      />
    </div>
  );
}

function PlanNodeView({
  node, depth, threshold, useActual,
}: {
  node: PlanNode;
  depth: number;
  threshold: number;
  useActual: boolean;
}) {
  const hot = isHotNode(node, threshold, useActual);
  return (
    <div style={{
      // Tree indentation via left margin grows with depth, but we cap at
      // 8 levels so deeply-nested plans don't push content off-screen.
      marginLeft: Math.min(depth, 8) * 18,
      marginBottom: 8,
    }}>
      <div style={{
        borderLeft: `3px solid ${hot ? "var(--warning)" : "var(--border)"}`,
        background: hot ? "var(--warning-bg)" : "var(--surface)",
        padding: "6px 10px",
        borderRadius: 4,
      }}>
        {/* Header — operator + detail */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <span style={{
            fontWeight: 600,
            color: hot ? "var(--warning)" : "var(--text)",
            fontSize: 13,
          }}>
            {node.label}
          </span>
          {node.detail && (
            <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
              {node.detail}
            </span>
          )}
        </div>

        {/* Stats row — cost, rows, ms */}
        <div style={{
          display: "flex",
          gap: 14,
          marginTop: 3,
          fontSize: 11,
          color: "var(--text-tertiary)",
        }}>
          {node.cost > 0 && (
            <span>
              <span style={{ color: "var(--text-disabled)" }}>cost </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {node.cost.toFixed(2)}
              </span>
            </span>
          )}
          {node.rows > 0 && (
            <span>
              <span style={{ color: "var(--text-disabled)" }}>rows </span>
              <span style={{ color: "var(--text-secondary)" }}>
                {node.rows.toLocaleString()}
              </span>
            </span>
          )}
          {node.actualMs != null && (
            <span>
              <span style={{ color: "var(--text-disabled)" }}>actual </span>
              <span style={{ color: hot ? "var(--warning)" : "var(--text-secondary)" }}>
                {node.actualMs}ms
              </span>
            </span>
          )}
        </div>

        {/* Meta — key/value table when there are extras */}
        {Object.keys(node.meta).length > 0 && (
          <div style={{
            marginTop: 6,
            display: "grid",
            gridTemplateColumns: "auto 1fr",
            gap: "2px 10px",
            fontSize: 11,
          }}>
            {Object.entries(node.meta).map(([k, v]) => (
              <Fragment key={k}>
                <span style={{ color: "var(--text-disabled)" }}>{k}</span>
                <span style={{
                  color: "var(--text-secondary)",
                  wordBreak: "break-all",
                  fontFamily: "var(--mono)",
                }}>
                  {v}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </div>

      {/* Children — recurse */}
      {node.children.map((child, i) => (
        <PlanNodeView
          key={i}
          node={child}
          depth={depth + 1}
          threshold={threshold}
          useActual={useActual}
        />
      ))}
    </div>
  );
}

// ── Top-level plan result renderer ──────────────────────────────────────────
// Routed to from the results-tab branch when result.isPlan is true. Picks
// the right parser by engine, falls back to raw text if parsing fails so
// the user still has something to look at.

export function PlanResultRenderer({ result }: { result: QueryResult }) {
  const engine = (result.planEngine ?? "").toLowerCase();
  // Most engines return the plan as a single-cell document. SQLite is the
  // exception — it returns a multi-row tabular result that the SQLite
  // parser reconstructs into a tree.
  const rawText = result.rows[0]?.[0] ?? "";

  // Diagnostic: SQL Server plan should arrive as a single-column rowset
  // whose first cell is XML. If it's empty, dump the full result so we
  // can see what shape arrived — most often it's the data rowset instead
  // of the plan rowset, meaning the C# multi-result walk didn't pick the
  // right one.
  if (engine === "sqlserver" && !rawText) {
    console.warn(
      "SQL Server plan: first cell empty. Result shape:",
      {
        columns: result.columns,
        rowCount: result.rows.length,
        firstRowFirstCells: result.rows[0]?.slice(0, 3),
        allFirstCells: result.rows.slice(0, 5).map(r => r[0]),
      }
    );
  }

  let root: PlanNode | null = null;
  if (engine === "postgres") {
    root = parsePostgresPlan(rawText);
  } else if (engine === "sqlserver") {
    root = parseSqlServerPlan(rawText);
  } else if (engine === "mysql" || engine === "mariadb") {
    root = parseMysqlPlan(rawText);
  } else if (engine === "sqlite") {
    root = parseSqlitePlan(result);
  } 
  // CockroachDB returns plain EXPLAIN as a multi-row tabular result.
  // The server has already formatted it as a readable indented tree with
  // • markers — building a parser on top of that text format doesn't
  // add value, just fragility across versions. Render directly with a
  // clear header so it reads as the intended output, not a failure path.
  else if (engine === "cockroachdb") {
    const text = result.rows.map(r => r[0] ?? "").join("\n");
    return (
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
        <div style={{
          color: "var(--text-tertiary)",
          fontSize: 11,
          marginBottom: 8,
          fontFamily: "var(--mono)",
        }}>
          Execution plan (cockroachdb) — server-formatted text output.
        </div>
        <pre style={{
          fontSize: 12,
          fontFamily: "var(--mono)",
          color: "var(--text-secondary)",
          whiteSpace: "pre",
          margin: 0,
        }}>
          {text}
        </pre>
      </div>
    );
  }

  if (root) {
    return <PlanTreeRenderer root={root} engine={engine} />;
  }

  // Fallback: parser didn't return a tree (malformed plan, unexpected
  // engine, etc). Show the raw text so the user isn't stuck.
  // For SQLite the rawText is just the first cell — display the full
  // tabular output instead.
  const fallbackText = engine === "sqlite"
    ? result.rows.map(r => r.join("\t")).join("\n")
    : rawText;

  return (
    <div style={{
      flex: 1,
      overflow: "auto",
      padding: "12px 16px",
    }}>
      <div style={{
        color: "var(--text-tertiary)",
        fontSize: 11,
        marginBottom: 8,
        fontFamily: "var(--mono)",
      }}>
        Execution plan ({engine}) — tree rendering failed, raw output below.
      </div>
      <pre style={{
        fontSize: 11,
        fontFamily: "var(--mono)",
        color: "var(--text-secondary)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: 0,
      }}>
        {fallbackText}
      </pre>
    </div>
  );
}

