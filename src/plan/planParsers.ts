// ─────────────────────────────────────────────────────────────────────────
// Execution-plan parsing & analysis (pure, no React).
// Extracted from App.tsx (code-audit item A-1). Each engine's EXPLAIN output
// (Postgres JSON, SQL Server XML, MySQL JSON, SQLite EXPLAIN QUERY PLAN)
// normalises into the shared PlanNode shape.
// ─────────────────────────────────────────────────────────────────────────
import type { PlanNode, QueryResult } from "../types";

/** Returns true if the SQL looks like a SELECT-ish statement we can safely
 *  wrap with an EXPLAIN/SHOWPLAN. Conservative — anything that isn't
 *  obviously a read is rejected. */
function isPlanSafeSql(sql: string): boolean {
  // Strip leading comments and whitespace to find the first keyword
  const stripped = sql
    .replace(/^\s*--[^\n]*\n/g, "")  // line comments at start
    .replace(/^\s*\/\*[\s\S]*?\*\//g, "")  // block comments at start
    .trim();
  const first = stripped.split(/\s+/)[0]?.toUpperCase() ?? "";
  // CTEs (WITH ...) are SELECT-adjacent and safe to plan
  return first === "SELECT" || first === "WITH";
}

/** Wraps user SQL with the engine-appropriate plan-capture statement.
 *  Returns the wrapped SQL, or null if the statement isn't plan-safe. */
export function wrapPlanSql(sql: string, engine: string): string | null {
  if (!isPlanSafeSql(sql)) return null;
  const clean = sql.trim().replace(/;\s*$/, "");
  switch (engine.toLowerCase()) {
    case "postgres":
      // ANALYZE actually executes the query. FORMAT JSON gives us a
      // parse-friendly tree. BUFFERS reports cache hits/reads.
      return `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${clean}`;
    case "cockroachdb":
      // CockroachDB doesn't accept Postgres's parenthesised option list
      // and has no JSON output mode. Plain EXPLAIN returns a tabular
      // plan — we render it like the SQLite EXPLAIN QUERY PLAN output.
      // EXPLAIN ANALYZE exists too but emits prose, not a parseable
      // structure, so we stick with the cheaper non-analyzing form.
      return `EXPLAIN ${clean}`;
    case "sqlserver":
      return `BEGIN\nSET STATISTICS XML ON;\n${clean};\nSET STATISTICS XML OFF;\nEND`;
    case "mysql":
    case "mariadb":
      return `EXPLAIN FORMAT=JSON ${clean}`;
    case "sqlite":
      return `EXPLAIN QUERY PLAN ${clean}`;
    default:
      return null;
  }
}

/** Postgres EXPLAIN (FORMAT JSON, ANALYZE) returns an array with one element
 *  per top-level statement. Each element has a "Plan" property which is the
 *  root of the tree. Sub-plans are in "Plans" arrays. Field names use
 *  Capital Case With Spaces (e.g. "Node Type", "Total Cost"). */
export function parsePostgresPlan(json: string): PlanNode | null {
  try {
    const parsed = JSON.parse(json);
    // Postgres returns [{ Plan: {...}, ... }]. Take the first statement.
    const root = Array.isArray(parsed) ? parsed[0]?.Plan : parsed?.Plan;
    if (!root) return null;
    return convertPostgresNode(root);
  } catch (e) {
    console.error("parsePostgresPlan failed:", e);
    return null;
  }
}

// Raw engine-emitted plan JSON. Shapes vary by engine and version and the
// converters below probe them dynamically, so one documented escape hatch
// here beats scattering `any` across every parser.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawPlanNode = any;

function convertPostgresNode(n: RawPlanNode): PlanNode {
  // Build a "detail" line — for a Seq Scan that's the table name, for a
  // Hash Join it's the join condition, etc. Keeping it short and readable
  // is more useful than dumping every property.
  const label = n["Node Type"] ?? "Unknown";
  const detail = (() => {
    const parts: string[] = [];
    if (n["Relation Name"]) {
      parts.push(`on ${n["Schema"] ? `${n["Schema"]}.` : ""}${n["Relation Name"]}`);
      if (n["Alias"] && n["Alias"] !== n["Relation Name"]) parts.push(`as ${n["Alias"]}`);
    }
    if (n["Index Name"]) parts.push(`using ${n["Index Name"]}`);
    if (n["Join Type"]) parts.push(`(${n["Join Type"]})`);
    return parts.join(" ");
  })();

  // meta: secondary properties shown beneath the node in a small key-value list
  const meta: Record<string, string> = {};
  if (n["Index Cond"])    meta["Index Cond"]    = n["Index Cond"];
  if (n["Filter"])        meta["Filter"]        = n["Filter"];
  if (n["Hash Cond"])     meta["Hash Cond"]     = n["Hash Cond"];
  if (n["Join Filter"])   meta["Join Filter"]   = n["Join Filter"];
  if (n["Sort Key"])      meta["Sort Key"]      = Array.isArray(n["Sort Key"])
    ? n["Sort Key"].join(", ") : String(n["Sort Key"]);
  if (n["Rows Removed by Filter"] != null && n["Rows Removed by Filter"] > 0) {
    meta["Rows Removed"] = String(n["Rows Removed by Filter"]);
  }
  if (n["Shared Hit Blocks"] != null || n["Shared Read Blocks"] != null) {
    meta["Buffers"] = `${n["Shared Hit Blocks"] ?? 0} hit / ${n["Shared Read Blocks"] ?? 0} read`;
  }

  return {
    label,
    detail,
    cost:    n["Total Cost"] ?? 0,
    rows:    n["Actual Rows"] ?? n["Plan Rows"] ?? 0,
    actualMs: n["Actual Total Time"] != null
      ? Math.round(n["Actual Total Time"] * 100) / 100  // round to 0.01ms
      : undefined,
    children: Array.isArray(n["Plans"]) ? n["Plans"].map(convertPostgresNode) : [],
    meta,
  };
}

// ── SQL Server XML plan parser ──────────────────────────────────────────────
// SET STATISTICS XML ON returns a single column containing a ShowPlanXML
// document. The tree lives under <ShowPlanXML><BatchSequence><Batch>
// <Statements><StmtSimple><QueryPlan><RelOp>. Each <RelOp> has:
//   - LogicalOp attribute   ("Inner Join", "Index Seek", etc) — used as label
//   - PhysicalOp attribute  ("Hash Match", "Clustered Index Seek", etc)
//   - EstimateCPU, EstimateRows, EstimateIO attributes
//   - Optional <RunTimeInformation> with actual stats (present with
//     STATISTICS XML ON, absent with SHOWPLAN_XML ON)
//   - One or more nested <RelOp> as children, typically wrapped in
//     phase-specific elements like <Hash>, <NestedLoops>, <Compute Scalar>.
//
// We use the browser's DOMParser — available everywhere, no external dep.
// XML traversal uses getElementsByTagName which returns live HTMLCollection;
// we collect immediate <RelOp> descendants via a recursive scan that stops
// at the first nested RelOp level.

export function parseSqlServerPlan(xml: string): PlanNode | null {
  try {
    // Quick sanity check: if the input doesn't start with `<` after
    // trimming, it can't possibly be XML. Skip DOMParser entirely and
    // log a clear diagnostic.
    const head = xml.trimStart().slice(0, 100);
    if (!head.startsWith("<")) {
      console.error(
        "parseSqlServerPlan: expected XML, got:",
        head.length === 0 ? "(empty string)" : head.slice(0, 50)
      );
      return null;
    }
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    // DOMParser returns a document with <parsererror> on failure rather
    // than throwing. Detect that explicitly.
    if (doc.querySelector("parsererror")) {
      console.error("parseSqlServerPlan: XML parse error", doc.querySelector("parsererror")?.textContent);
      return null;
    }
    // Find the first RelOp anywhere in the document — that's the root
    // operator. We don't care about the wrapping batch/statement layers
    // for tree rendering.
    const firstRelOp = doc.querySelector("RelOp");
    if (!firstRelOp) return null;
    return convertSqlServerNode(firstRelOp);
  } catch (e) {
    console.error("parseSqlServerPlan failed:", e);
    return null;
  }
}

// Find all <RelOp> child operators of `el` at one level deep. SQL Server
// nests RelOps inside operator-specific wrapper elements (<Hash>, <Sort>,
// <NestedLoops>, etc), so a direct .children scan doesn't work. We
// recursively walk children but stop descending whenever we hit a RelOp —
// that's a child operator in the tree, not a grandchild.
function findChildRelOps(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: Element) => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c.tagName === "RelOp") {
        out.push(c);
      } else {
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

function convertSqlServerNode(el: Element): PlanNode {
  // Prefer PhysicalOp for the label — it's what shows in SSMS's tree
  // (Index Seek, Clustered Index Scan, Hash Match, etc). Fall back to
  // LogicalOp if PhysicalOp is missing.
  const physical = el.getAttribute("PhysicalOp") ?? "";
  const logical  = el.getAttribute("LogicalOp") ?? "";
  const label = physical || logical || "Unknown";

  // Build detail line — most operator types nest the table/index reference
  // inside a phase wrapper. We look for the first <Object> element which
  // is where SQL Server records the target object.
  const objectEl = el.querySelector(":scope > * > Object")
                ?? el.querySelector(":scope > * > * > Object");
  const detail = (() => {
    if (!objectEl) {
      // Some operators (Compute Scalar, Filter) have no object — fall
      // back to the LogicalOp when label is the PhysicalOp.
      return physical && logical && physical !== logical ? `(${logical})` : "";
    }
    const schema = (objectEl.getAttribute("Schema") ?? "").replace(/[[\]]/g, "");
    const table  = (objectEl.getAttribute("Table")  ?? "").replace(/[[\]]/g, "");
    const index  = (objectEl.getAttribute("Index")  ?? "").replace(/[[\]]/g, "");
    const parts: string[] = [];
    if (table) parts.push(`on ${schema && schema !== "dbo" ? schema + "." : ""}${table}`);
    if (index) parts.push(`using ${index}`);
    return parts.join(" ");
  })();

  // EstimateRows and EstimatedTotalSubtreeCost give us numeric ranking.
  // STATISTICS XML adds <RunTimeInformation> with actual stats — prefer
  // those when present.
  const estRows  = parseFloat(el.getAttribute("EstimateRows") ?? "0");
  const subtree  = parseFloat(el.getAttribute("EstimatedTotalSubtreeCost") ?? "0");
  const runtime  = el.querySelector(":scope > RunTimeInformation > RunTimeCountersPerThread");
  const actualRows = runtime
    ? parseFloat(runtime.getAttribute("ActualRows") ?? "0")
    : null;
  // SQL Server reports ActualCPUms and ActualElapsedms per thread; we sum
  // them by summing all <RunTimeCountersPerThread> elements.
  let actualMs: number | undefined;
  const allRuntime = el.querySelectorAll(":scope > RunTimeInformation > RunTimeCountersPerThread");
  if (allRuntime.length > 0) {
    let total = 0;
    allRuntime.forEach(rt => {
      total += parseFloat(rt.getAttribute("ActualElapsedms") ?? "0");
    });
    actualMs = Math.round(total * 100) / 100;
  }

  // meta: surface useful per-operator details. Each operator type stores
  // its specifics in a child element matching its name (<Hash>, <Sort>,
  // <NestedLoops>, etc). We pick out the ones users care about.
  const meta: Record<string, string> = {};
  const predicates = el.querySelectorAll(":scope > * > Predicate ScalarOperator");
  if (predicates.length > 0) {
    const text = Array.from(predicates).map(p => p.getAttribute("ScalarString") ?? "").filter(Boolean);
    if (text.length > 0) meta["Predicate"] = text.join(" AND ");
  }
  // Seek predicates — what an Index Seek is filtering on
  const seekPreds = el.querySelectorAll(":scope > IndexScan SeekPredicates SeekPredicate ScalarOperator");
  if (seekPreds.length > 0) {
    const text = Array.from(seekPreds).map(p => p.getAttribute("ScalarString") ?? "").filter(Boolean);
    if (text.length > 0) meta["Seek"] = text.join(", ");
  }
  if (actualRows != null && estRows > 0) {
    const ratio = actualRows / estRows;
    if (ratio > 10 || ratio < 0.1) {
      // Estimate badly off — useful to surface
      meta["Estimate"] = `${estRows.toFixed(0)} expected, ${actualRows.toFixed(0)} actual`;
    }
  }

  return {
    label,
    detail,
    cost: subtree,
    rows: actualRows ?? estRows,
    actualMs,
    children: findChildRelOps(el).map(convertSqlServerNode),
    meta,
  };
}

// ── MySQL JSON plan parser ──────────────────────────────────────────────────
// EXPLAIN FORMAT=JSON returns a single column "EXPLAIN" with a JSON document.
// The shape is:
//   { "query_block": { "select_id": 1, "cost_info": {...}, "table": {...},
//                      "nested_loop": [{"table": {...}}, ...], ... } }
//
// MySQL's tree is irregular compared to Postgres — instead of a uniform
// "Plans" children array, child operators appear under multiple possible
// keys: nested_loop, ordering_operation, grouping_operation, materialized_
// from_subquery, attached_subqueries, table. We probe for each shape.
//
// Where a node has "table", that's the table-access detail bundled into
// the same node as the operator above it. We treat that as a single
// PlanNode and record the table name as `detail`.

export function parseMysqlPlan(json: string): PlanNode | null {
  try {
    const parsed = JSON.parse(json);

    // MySQL 8.4+ ships a new "v2.0" JSON plan schema with a fundamentally
    // different shape: a top-level `query_plan` object instead of
    // `query_block`, uniform `inputs[]` children instead of irregular
    // nested_loop / ordering_operation wrappers, and renamed cost/rows
    // fields. Detect by either the explicit version marker or the
    // presence of `query_plan`, and route to the v2 parser.
    if (parsed?.json_schema_version === "2.0" || parsed?.query_plan) {
      return parsed.query_plan ? convertMysqlV2Node(parsed.query_plan) : null;
    }

    // Legacy schema (MySQL 5.7 through 8.3, MariaDB)
    const block = parsed?.query_block;
    if (!block) return null;
    return convertMysqlBlock(block);
  } catch (e) {
    console.error("parseMysqlPlan failed:", e);
    return null;
  }
}

// MySQL 8.4+ "v2.0" plan schema. Every node has the same shape:
//   { operation, access_type, inputs?, table_name?, schema_name?,
//     used_columns?, estimated_rows?, estimated_total_cost?,
//     limit?, limit_offset?, index_name?, condition?, ... }
// `operation` is a human-readable label MySQL has already formatted
// (e.g. "Table scan on db", "Limit: 100 row(s)", "Nested loop inner join").
// Children are uniformly in `inputs[]` — no irregular wrappers to probe.
function convertMysqlV2Node(n: RawPlanNode): PlanNode {
  const op: string = n.operation ?? n.access_type ?? "Node";
  const label = shortenMysqlV2Label(op);

  const meta: Record<string, string> = {};
  if (n.schema_name && n.table_name) {
    meta["Table"] = `${n.schema_name}.${n.table_name}`;
  } else if (n.table_name) {
    meta["Table"] = n.table_name;
  }
  if (n.access_type)  meta["Access"]    = n.access_type;
  if (n.index_name)   meta["Index"]     = n.index_name;
  if (n.condition)    meta["Condition"] = n.condition;
  if (n.limit != null) meta["Limit"]   = String(n.limit);
  if (n.limit_offset)  meta["Offset"]  = String(n.limit_offset);
  if (Array.isArray(n.used_columns) && n.used_columns.length > 0) {
    // Truncate long column lists — a SELECT * on a wide table dumps
    // dozens of names and crushes the meta panel.
    const cols = n.used_columns as string[];
    meta["Columns"] = cols.length > 8
      ? `${cols.slice(0, 8).join(", ")}, … (+${cols.length - 8} more)`
      : cols.join(", ");
  }

  return {
    label,
    // Only set detail when the shortened label dropped useful info.
    detail: op === label ? "" : op,
    cost: parseFloat(n.estimated_total_cost ?? "0"),
    rows: parseFloat(n.estimated_rows ?? "0"),
    children: Array.isArray(n.inputs) ? n.inputs.map(convertMysqlV2Node) : [],
    meta,
  };
}

// Pulls a compact tree-node label out of MySQL's verbose `operation` string.
//   "Table scan on db"               → "Table Scan"
//   "Limit: 100 row(s)"              → "Limit"
//   "Nested loop inner join"         → "Nested Loop Inner Join"
//   "Index lookup on t using PRIMARY" → "Index Lookup"
// The full operation string is preserved in PlanNode.detail so nothing
// is lost — just rearranged for the tree visualisation.
function shortenMysqlV2Label(op: string): string {
  let s = op;
  const onIdx = s.search(/\s+on\s+/i);
  if (onIdx > 0) s = s.slice(0, onIdx);
  const colonIdx = s.indexOf(":");
  if (colonIdx > 0) s = s.slice(0, colonIdx);
  s = s.trim();
  return s.split(/\s+/)
    .map(w => w.length > 0 ? w[0].toUpperCase() + w.slice(1) : w)
    .join(" ");
}

function convertMysqlBlock(block: RawPlanNode): PlanNode {
  // Try each wrapper key in priority order — these mirror MySQL's
  // documented EXPLAIN JSON structure. The outermost wrapper becomes the
  // operator label.
  if (block.union_result) {
    return {
      label: "Union",
      detail: block.union_result.using_temporary_table ? "(temp table)" : "",
      cost: 0,
      rows: 0,
      children: (block.union_result.query_specifications ?? [])
        .map((s: RawPlanNode) => convertMysqlBlock(s.query_block ?? s)),
      meta: {},
    };
  }
  if (block.ordering_operation) {
    return {
      label: "Sort",
      detail: block.ordering_operation.using_filesort ? "(filesort)" : "",
      cost: 0,
      rows: 0,
      children: [convertMysqlBlock(block.ordering_operation)],
      meta: {},
    };
  }
  if (block.grouping_operation) {
    return {
      label: "Group",
      detail: block.grouping_operation.using_filesort ? "(filesort)" : "",
      cost: 0,
      rows: 0,
      children: [convertMysqlBlock(block.grouping_operation)],
      meta: {},
    };
  }
  if (Array.isArray(block.nested_loop)) {
    // Nested loop is the join structure. Each entry is { table: {...} }.
    // We render as a Join node with each table as a child.
    return {
      label: "Nested Loop Join",
      detail: `${block.nested_loop.length} tables`,
      cost: parseFloat(block.cost_info?.query_cost ?? "0"),
      rows: 0,
      children: block.nested_loop.map((nl: RawPlanNode) => convertMysqlTable(nl.table ?? nl)),
      meta: {},
    };
  }
  if (block.table) {
    return convertMysqlTable(block.table);
  }
  // Unknown shape — render as a placeholder with the raw block name
  return {
    label: "Query Block",
    detail: "",
    cost: parseFloat(block.cost_info?.query_cost ?? "0"),
    rows: 0,
    children: [],
    meta: {},
  };
}

function convertMysqlTable(t: RawPlanNode): PlanNode {
  // Each table node has:
  //   access_type: "ALL" | "index" | "ref" | "range" | "const" | "eq_ref" | ...
  //   table_name, key (index name), rows_examined_per_scan, filtered (%)
  //   cost_info: { read_cost, eval_cost, prefix_cost, data_read_per_join }
  //   used_columns, attached_condition
  //   materialized_from_subquery, attached_subqueries (for nested cases)
  const accessType = t.access_type ?? "?";
  // Map MySQL's access_type to a readable label
  const label = ({
    ALL:      "Full Table Scan",
    index:    "Index Scan",
    range:    "Index Range Scan",
    ref:      "Ref Lookup",
    eq_ref:   "Eq Ref Lookup",
    const:    "Constant Lookup",
    system:   "System Lookup",
    fulltext: "Fulltext Search",
  } as Record<string, string>)[accessType] ?? `Access (${accessType})`;

  const parts: string[] = [];
  if (t.table_name) parts.push(`on ${t.table_name}`);
  if (t.key)        parts.push(`using ${t.key}`);
  if (t.using_index === true) parts.push("(index only)");
  const detail = parts.join(" ");

  const meta: Record<string, string> = {};
  if (t.possible_keys) meta["Possible Keys"] = (t.possible_keys as string[]).join(", ");
  if (t.attached_condition) meta["Condition"] = t.attached_condition;
  if (t.filtered != null && t.filtered < 100) meta["Filtered"] = `${t.filtered}%`;
  if (t.cost_info?.read_cost != null) meta["Read Cost"] = String(t.cost_info.read_cost);
  if (t.cost_info?.eval_cost != null) meta["Eval Cost"] = String(t.cost_info.eval_cost);

  const children: PlanNode[] = [];
  // Subqueries materialized in the FROM clause — render as a child node
  if (t.materialized_from_subquery?.query_block) {
    children.push(convertMysqlBlock(t.materialized_from_subquery.query_block));
  }
  // Attached subqueries — present in WHERE clauses
  if (Array.isArray(t.attached_subqueries)) {
    for (const sub of t.attached_subqueries) {
      if (sub.query_block) children.push(convertMysqlBlock(sub.query_block));
    }
  }

  return {
    label,
    detail,
    cost: parseFloat(t.cost_info?.prefix_cost ?? t.cost_info?.read_cost ?? "0"),
    rows: parseFloat(t.rows_examined_per_scan ?? t.rows ?? "0"),
    children,
    meta,
  };
}

// ── SQLite EXPLAIN QUERY PLAN parser ────────────────────────────────────────
// SQLite returns a *tabular* result rather than a JSON or XML tree:
//   id | parent | notused | detail
//   3  | 0      | 0       | SCAN TABLE foo
//   5  | 0      | 0       | SEARCH TABLE bar USING INDEX bar_x_idx (x=?)
//   8  | 5      | 0       | USE TEMP B-TREE FOR ORDER BY
//
// Each row is one access plan; parent is the id of the row's parent node
// (0 = root). We reconstruct the tree by walking parent references.
//
// `detail` is free-form text like "SCAN TABLE foo" — we keep it as-is for
// label since SQLite doesn't separate operator name from target.

export function parseSqlitePlan(result: QueryResult): PlanNode | null {
  if (!result.rows || result.rows.length === 0) return null;
  // SQLite EXPLAIN QUERY PLAN columns are: id, parent, notused, detail.
  // Column index varies — find them by name first, fall back to position.
  const cols = result.columns ?? [];
  const idxId     = cols.findIndex(c => c.toLowerCase() === "id");
  const idxParent = cols.findIndex(c => c.toLowerCase() === "parent");
  const idxDetail = cols.findIndex(c => c.toLowerCase() === "detail");
  const ID     = idxId     >= 0 ? idxId     : 0;
  const PARENT = idxParent >= 0 ? idxParent : 1;
  const DETAIL = idxDetail >= 0 ? idxDetail : 3;

  // Build a map of id → PlanNode plus a parent-reference list
  const nodes = new Map<string, PlanNode & { _parent: string }>();
  for (const row of result.rows) {
    const id     = row[ID]     ?? "";
    const parent = row[PARENT] ?? "0";
    const detail = row[DETAIL] ?? "";
    if (!id) continue;
    nodes.set(id, {
      label: detail,
      detail: "",
      cost: 0,
      rows: 0,
      children: [],
      meta: {},
      _parent: parent,
    });
  }
  if (nodes.size === 0) return null;

  // Wire children to parents. parent="0" means top-level — those go under
  // a synthetic root so the user sees a single tree even when there are
  // multiple top-level access paths.
  const rootChildren: PlanNode[] = [];
  for (const node of nodes.values()) {
    if (node._parent === "0" || !nodes.has(node._parent)) {
      rootChildren.push(node);
    } else {
      nodes.get(node._parent)!.children.push(node);
    }
  }
  if (rootChildren.length === 1) return rootChildren[0];
  return {
    label: "Query Plan",
    detail: `${rootChildren.length} top-level paths`,
    cost: 0,
    rows: 0,
    children: rootChildren,
    meta: {},
  };
}

// ── Hot node detection ──────────────────────────────────────────────────────
// "Most expensive" is defined as: nodes whose cost (or actualMs if present)
// is in the top 20% of all nodes in the tree. Minimum threshold of 1.0 so
// trivial queries don't get spurious highlights on every node.

export function collectAllNodes(root: PlanNode): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode) => { out.push(n); n.children.forEach(walk); };
  walk(root);
  return out;
}

export function hotNodeThreshold(root: PlanNode): number {
  const all = collectAllNodes(root);
  // Prefer actualMs when present (more meaningful than cost estimate)
  const useActual = all.some(n => n.actualMs != null);
  const values = all
    .map(n => useActual ? (n.actualMs ?? 0) : n.cost)
    .filter(v => v > 0)
    .sort((a, b) => b - a);   // descending
  if (values.length === 0) return Infinity;
  // 80th percentile — top 20% are hot
  const idx = Math.floor(values.length * 0.2);
  return Math.max(values[idx] ?? Infinity, 1.0);
}

export function isHotNode(node: PlanNode, threshold: number, useActual: boolean): boolean {
  const v = useActual ? (node.actualMs ?? 0) : node.cost;
  return v >= threshold;
}

// ── Tree renderer ───────────────────────────────────────────────────────────
// Vertical indented tree. Each node renders as:
//   • Operator name (bold) + brief detail (muted)
//   • Cost / rows / actualMs row (small, monospace)
//   • Optional meta key-value table (filters, sort keys, etc)
//   • Children indented and rendered recursively
// Hot nodes get an amber left-border + amber operator name.

