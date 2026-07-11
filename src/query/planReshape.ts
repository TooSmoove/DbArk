// Pure query-response reshaping.
//
// Extracted from App.tsx's runQuery so the execution-plan handling has a single
// responsibility and can be unit-tested without React or IPC. Every function
// here is pure: it takes the parsed IPC payload(s) and returns new result
// arrays. Only difference from the inline original is the removal of trace-level
// console.* debug logging (diagnostics, not behavior).
import type { QueryResult } from "../types";
import type { EngineName } from "../engines";
import { toIpcError } from "../ipc";

/** Loose shape of a parsed IPC query response, before normalization. */
export interface RawQueryResponse {
  results?: QueryResult[];
  rowCount?: number;
  error?:   string;
  // Single-result (flat-file) responses carry the result fields at top level.
  columns?: string[];
  rows?:    (string | null)[][];
}

/** Normalised multi-result envelope used by the rest of runQuery. */
export interface NormalisedResponse {
  results:   QueryResult[];
  rowCount?: number;
  error?:    string;
}

/**
 * Normalise a parsed IPC response into the multi-result envelope.
 *
 * DB queries already return `{ results: [...] }`; flat-file queries return a
 * single result at the top level, which we wrap. A top-level `error` becomes an
 * empty-result envelope carrying that error.
 */
export function normaliseQueryResponse(parsed: RawQueryResponse): NormalisedResponse {
  return parsed.results
    ? (parsed as NormalisedResponse)          // already multi-result shape (DB query)
    : parsed.error
    ? { results: [], error: parsed.error }
    : { results: [{ ...parsed, sql: "" } as QueryResult] }; // wrap single result
}

/** True when a cell looks like a ShowPlanXML / XML plan payload. */
function isPlanXmlCell(cell: string | null): cell is string {
  if (typeof cell !== "string") return false;
  const trimmed = cell.trimStart();
  if (!trimmed.startsWith("<")) return false;
  const head = trimmed.slice(0, 200);
  return head.includes("ShowPlanXML") || head.includes("<?xml");
}

/**
 * SQL Server plan reshaping.
 *
 * `SET STATISTICS XML` returns the data result set(s) plus a result set whose
 * single cell holds the ShowPlanXML. Locate that XML cell, drop it from the data
 * results, and append a single `isPlan` result carrying the raw XML for the plan
 * renderer. If no XML cell is found (permissions/driver), the results are
 * returned unchanged.
 */
export function reshapeSqlServerPlan(
  results: QueryResult[],
  engine:  EngineName,
): QueryResult[] {
  let planResult: QueryResult | undefined;
  let planCell = "";

  for (const r of results) {
    for (const row of r.rows ?? []) {
      for (const cell of row) {
        if (isPlanXmlCell(cell)) {
          planResult = r;
          planCell = cell;
          break;
        }
      }
      if (planCell) break;
    }
    if (planCell) break;
  }

  if (!planResult || !planCell) return results;

  const dataResults = results.filter(r => r !== planResult && !r.isMessage);
  const reshapedPlan: QueryResult = {
    ...planResult,
    columns: ["plan"],
    rows: [[planCell]],
    rowCount: 1,
    isPlan: true,
    planEngine: engine,
  };
  return [...dataResults, reshapedPlan];
}

/**
 * EXPLAIN plan appending for Postgres / MySQL / MariaDB / SQLite / CockroachDB.
 *
 * For these engines EXPLAIN is a second query whose raw JSON is passed as
 * `planRaw`. The plan (or a plan-scoped error) is appended as a single extra
 * `isPlan` result so the data result from the first call is preserved.
 */
export function appendExplainPlan(
  results: QueryResult[],
  planRaw: string,
  engine:  EngineName,
): QueryResult[] {
  const out = [...results];
  try {
    const planParsed = JSON.parse(planRaw) as RawQueryResponse;
    if (planParsed.error) {
      out.push({
        columns: [],
        rows: [],
        rowCount: 0,
        error: planParsed.error,
        isPlan: true,
        planEngine: engine,
      });
    } else {
      // EXPLAIN against these engines produces exactly one result set; take the
      // first and ignore extras defensively.
      const planResults: QueryResult[] = planParsed.results ?? [planParsed as QueryResult];
      if (planResults[0]) {
        out.push({
          ...planResults[0],
          isPlan: true,
          planEngine: engine,
        });
      }
    }
  } catch (e) {
    out.push({
      columns: [],
      rows: [],
      rowCount: 0,
      error: `Plan parse failed: ${toIpcError(e).message}`,
      isPlan: true,
      planEngine: engine,
    });
  }
  return out;
}
