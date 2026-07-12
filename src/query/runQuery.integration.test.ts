// ─────────────────────────────────────────────────────────────────────────────
// Frontend integration test: the runQuery data pipeline, end-to-end, across a
// FAKED Tauri IPC boundary.
//
// Unlike the unit tests in this repo (which each pin one pure function), this
// test wires the *real* modules together the way App.tsx's runQuery does —
//
//     invoke()  ──▶  ipc()/toIpcError  ──▶  JSON.parse
//               ──▶  extractPayloadError (in-band DB error detection)
//               ──▶  normaliseQueryResponse / reshapeSqlServerPlan / appendExplainPlan
//               ──▶  tabsReducer (results land on the active tab)
//               ──▶  historyReducer (a history entry is recorded)
//
// The ONLY thing stubbed is the outermost seam: `@tauri-apps/api/core`'s
// `invoke`, which stands in for the Rust host + C# engine. Everything between
// the wire and the state tree is the production code. That makes this a
// regression guard for the whole class of bugs the audit flagged — the
// SyntaxError-on-"ERROR:" crash, the silent failed-DROP, the five-shapes IPC
// contract — at the level where those modules actually meet.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from "vitest";

// A mutable handler the fake `invoke` delegates to. `vi.hoisted` runs before
// the hoisted `vi.mock` factory, so the factory can close over this ref.
const wire = vi.hoisted(() => ({
  handler: (_cmd: string, _args?: unknown): unknown => {
    throw new Error("wire.handler not set by test");
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  // Real Tauri returns a Promise; a throwing handler becomes a rejection, which
  // is exactly the path `ipc()` normalises through `toIpcError`.
  invoke: (cmd: string, args?: unknown) =>
    Promise.resolve().then(() => wire.handler(cmd, args)),
}));

// Real production modules under integration:
import { ipc, toIpcError, extractPayloadError } from "../ipc";
import {
  normaliseQueryResponse,
  reshapeSqlServerPlan,
  appendExplainPlan,
  type RawQueryResponse,
} from "./planReshape";
import { tabsReducer, type TabsState } from "../state/tabsReducer";
import { historyReducer, initHistoryState, type HistoryState } from "../state/historyReducer";
import { toEngineName, type EngineName } from "../engines";
import { createTab } from "../appState";
import type { QueryResult, HistoryEntry, Tab } from "../types";

// ── The pipeline under test ──────────────────────────────────────────────────
// A faithful, React-free transcription of App.tsx's runQuery *data flow*. It
// composes the real ipc/parse/reshape/reducer modules; only the side effects
// (Monaco, timers) are dropped. If the real runQuery's contract with these
// modules drifts, this reassembly breaks — which is the point.

interface RunOpts {
  sql: string;
  engineWire: string; // the raw lowercase engine string off the wire
  connectionId: string;
  connectionName: string;
  file?: string | null;
  joinTables?: string[];
  includePlan?: boolean;
}

interface AppSlice {
  tabs: TabsState;
  history: HistoryState;
}

function rowCountOf(results: QueryResult[]): number {
  return results.reduce((n, r) => n + (r.rowCount ?? 0), 0);
}

async function runQuery(state: AppSlice, opts: RunOpts): Promise<AppSlice> {
  // 1) Narrow the untrusted wire engine string exactly as the app does.
  const engine: EngineName = toEngineName(opts.engineWire);

  // 2) Cross the (faked) IPC boundary through the single ipc() entry point.
  let raw: string;
  try {
    if (opts.file && opts.joinTables && opts.joinTables.length > 0) {
      raw = await ipc<string>("query_file_with_db", {
        filePath: opts.file,
        sql: opts.sql,
        tableNames: opts.joinTables.join(","),
      });
    } else if (opts.file) {
      raw = await ipc<string>("query_file", { filePath: opts.file, sql: opts.sql });
    } else {
      raw = await ipc<string>("execute_query", { sql: opts.sql, engine });
    }
  } catch (e) {
    // Transport/validation failure: the promise rejected. One error path.
    const err = toIpcError(e);
    const tabs = tabsReducer(state.tabs, {
      type: "UPDATE_ACTIVE_TAB",
      updates: { results: [], error: err.message, loading: false },
    });
    const entry = makeEntry(opts, false, 0);
    const history = historyReducer(state.history, {
      type: "SET_ENTRIES",
      entries: [entry, ...state.history.entries],
    });
    return { tabs, history };
  }

  // 3) In-band DB error detection BEFORE trusting the payload (silent-DROP guard).
  const dbError = extractPayloadError(raw);

  // 4) Parse + normalise into the multi-result envelope.
  let results: QueryResult[] = [];
  let topError: string | undefined;
  let parsed: RawQueryResponse | null = null;
  try {
    parsed = JSON.parse(raw) as RawQueryResponse;
  } catch {
    parsed = null; // legacy bare-error string; dbError already carries it
  }
  if (parsed) {
    const norm = normaliseQueryResponse(parsed);
    results = norm.results;
    topError = norm.error;

    // 5) Plan reshaping — the same branch runQuery takes.
    if (engine === "sqlserver") {
      results = reshapeSqlServerPlan(results, engine);
    } else if (opts.includePlan) {
      const planRaw = await ipc<string>("execute_query", {
        sql: `EXPLAIN ${opts.sql}`,
        engine,
      });
      results = appendExplainPlan(results, planRaw, engine);
    }
  }

  // 6) Fold results onto the active tab and record history.
  const errorMsg = dbError ?? topError ?? null;
  const success = errorMsg == null;
  const tabs = tabsReducer(state.tabs, {
    type: "UPDATE_ACTIVE_TAB",
    updates: { results, error: errorMsg, loading: false },
  });
  const entry = makeEntry(opts, success, rowCountOf(results));
  const history = historyReducer(state.history, {
    type: "SET_ENTRIES",
    entries: [entry, ...state.history.entries],
  });
  return { tabs, history };
}

function makeEntry(opts: RunOpts, success: boolean, rowCount: number): HistoryEntry {
  return {
    id: Date.now(),
    connectionId: opts.connectionId,
    connectionName: opts.connectionName,
    sql: opts.sql,
    executedAt: Date.now(),
    durationMs: 1,
    rowCount,
    success,
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function freshApp(): AppSlice {
  const tab: Tab = { ...createTab("t1"), connection: null };
  return {
    tabs: { tabs: [tab], activeTabId: "t1" },
    history: initHistoryState(),
  };
}

const conn = { connectionId: "c1", connectionName: "local-sqlite" };

function activeTab(app: AppSlice): Tab {
  return app.tabs.tabs.find((t) => t.id === app.tabs.activeTabId)!;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runQuery pipeline (integration, faked IPC)", () => {
  beforeEach(() => {
    wire.handler = () => {
      throw new Error("no wire handler configured");
    };
  });

  it("SELECT success: rows land on the active tab and a successful history entry is recorded", async () => {
    wire.handler = (cmd) => {
      expect(cmd).toBe("execute_query");
      return JSON.stringify({
        results: [
          { columns: ["id", "name"], rows: [["1", "ada"], ["2", "alan"]], rowCount: 2 },
        ],
      });
    };

    const app = await runQuery(freshApp(), {
      ...conn,
      engineWire: "sqlite",
      sql: "SELECT id, name FROM users",
    });

    const tab = activeTab(app);
    expect(tab.error).toBeNull();
    expect(tab.results).toHaveLength(1);
    expect(tab.results[0].columns).toEqual(["id", "name"]);
    expect(tab.results[0].rows).toHaveLength(2);
    expect(app.history.entries[0]).toMatchObject({ success: true, rowCount: 2, sql: "SELECT id, name FROM users" });
  });

  it("multi-statement: each result set becomes its own tab result", async () => {
    wire.handler = () =>
      JSON.stringify({
        results: [
          { columns: ["a"], rows: [["1"]], rowCount: 1 },
          { columns: ["b"], rows: [["2"], ["3"]], rowCount: 2 },
        ],
      });

    const app = await runQuery(freshApp(), { ...conn, engineWire: "sqlite", sql: "SELECT 1; SELECT 2" });

    expect(activeTab(app).results).toHaveLength(2);
    expect(app.history.entries[0].rowCount).toBe(3); // summed across result sets
  });

  it("read-only violation comes back as a bare (non-JSON) error string and surfaces as a tab error", async () => {
    // The executor returns a legacy bare string here, not JSON — the exact
    // shape that once crashed the parser with `SyntaxError: Unexpected token 'C'`.
    wire.handler = () => "Connection is read-only — statement not allowed: DROP TABLE users";

    const app = await runQuery(freshApp(), { ...conn, engineWire: "sqlite", sql: "DROP TABLE users" });

    const tab = activeTab(app);
    expect(tab.error).toMatch(/read-only/);
    expect(tab.results).toHaveLength(0);
    expect(app.history.entries[0].success).toBe(false);
  });

  it("failed DROP reported in-band still fails the run (silent-drop regression)", async () => {
    // A successful IPC round-trip whose payload carries a per-statement error.
    // Ignoring the payload would mark this a success while the object survives.
    wire.handler = () =>
      JSON.stringify({
        results: [
          { columns: [], rows: [], rowCount: 0, error: "Cannot drop the table 'users', because it does not exist." },
        ],
      });

    const app = await runQuery(freshApp(), { ...conn, engineWire: "sqlite", sql: "DROP TABLE users" });

    expect(activeTab(app).error).toMatch(/Cannot drop the table/);
    expect(app.history.entries[0].success).toBe(false);
  });

  it("flat-file query: a single top-level result is wrapped into the multi-result envelope", async () => {
    // query_file returns the result fields at the TOP LEVEL (no `results` array).
    wire.handler = (cmd) => {
      expect(cmd).toBe("query_file");
      return JSON.stringify({ columns: ["city"], rows: [["oslo"], ["riga"]], rowCount: 2 });
    };

    const app = await runQuery(freshApp(), {
      ...conn,
      engineWire: "sqlite",
      sql: "SELECT city FROM data",
      file: "/tmp/cities.csv",
    });

    const tab = activeTab(app);
    expect(tab.error).toBeNull();
    expect(tab.results).toHaveLength(1);
    expect(tab.results[0].columns).toEqual(["city"]);
  });

  it("file + DB join routes through query_file_with_db with the checked table names", async () => {
    let seenArgs: { tableNames?: string } | null = null;
    wire.handler = (cmd, args) => {
      expect(cmd).toBe("query_file_with_db");
      seenArgs = args as { tableNames?: string };
      return JSON.stringify({ columns: ["x"], rows: [["1"]], rowCount: 1 });
    };

    await runQuery(freshApp(), {
      ...conn,
      engineWire: "sqlite",
      sql: "SELECT * FROM data JOIN db_orders USING(id)",
      file: "/tmp/data.csv",
      joinTables: ["orders", "customers"],
    });

    expect(seenArgs!.tableNames).toBe("orders,customers");
  });

  it("SQL Server STATISTICS XML: the plan cell is lifted into a dedicated isPlan result", async () => {
    const planXml =
      '<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan"><BatchSequence/></ShowPlanXML>';
    wire.handler = () =>
      JSON.stringify({
        results: [
          { columns: ["id"], rows: [["1"]], rowCount: 1 },
          { columns: ["Microsoft SQL Server 2005 XML Showplan"], rows: [[planXml]], rowCount: 1 },
        ],
      });

    const app = await runQuery(freshApp(), {
      ...conn,
      engineWire: "sqlserver",
      sql: "SET STATISTICS XML ON; SELECT 1",
    });

    const results = activeTab(app).results;
    const plan = results.find((r) => r.isPlan);
    expect(plan).toBeDefined();
    expect(plan!.planEngine).toBe("sqlserver");
    expect(plan!.rows[0][0]).toContain("ShowPlanXML");
    // the data result is preserved, the raw XML result set is not shown as data
    expect(results.some((r) => !r.isPlan && r.columns.includes("id"))).toBe(true);
  });

  it("EXPLAIN plan (postgres): a second IPC call's plan is appended as an isPlan result", async () => {
    wire.handler = (_cmd, args) => {
      const sql = (args as { sql: string }).sql;
      if (sql.startsWith("EXPLAIN")) {
        return JSON.stringify({ results: [{ columns: ["QUERY PLAN"], rows: [["Seq Scan on users"]], rowCount: 1 }] });
      }
      return JSON.stringify({ results: [{ columns: ["id"], rows: [["1"]], rowCount: 1 }] });
    };

    const app = await runQuery(freshApp(), {
      ...conn,
      engineWire: "postgres",
      sql: "SELECT * FROM users",
      includePlan: true,
    });

    const results = activeTab(app).results;
    const plan = results.find((r) => r.isPlan);
    expect(plan).toBeDefined();
    expect(plan!.planEngine).toBe("postgres");
    expect(plan!.rows[0][0]).toContain("Seq Scan");
    // the data result from the first call survives
    expect(results.some((r) => !r.isPlan)).toBe(true);
  });

  it("transport failure: a rejected invoke is normalised and never crashes the pipeline", async () => {
    wire.handler = () => {
      throw new Error("IPC channel closed");
    };

    const app = await runQuery(freshApp(), { ...conn, engineWire: "sqlite", sql: "SELECT 1" });

    expect(activeTab(app).error).toBe("IPC channel closed");
    expect(app.history.entries[0].success).toBe(false);
  });

  it("an unsupported engine name off the wire is rejected before any IPC call", async () => {
    let called = false;
    wire.handler = () => {
      called = true;
      return "{}";
    };

    await expect(
      runQuery(freshApp(), { ...conn, engineWire: "oracle", sql: "SELECT 1" }),
    ).rejects.toThrow(/Unsupported engine: oracle/);
    expect(called).toBe(false);
  });
});
