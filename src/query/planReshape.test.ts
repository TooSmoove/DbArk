import { describe, it, expect } from "vitest";
import {
  normaliseQueryResponse,
  reshapeSqlServerPlan,
  appendExplainPlan,
} from "./planReshape";
import type { QueryResult } from "../types";

// ---- normaliseQueryResponse -------------------------------
describe("normaliseQueryResponse", () => {
  it("passes through an already multi-result DB response", () => {
    const input = { results: [{ columns: ["a"], rows: [["1"]], rowCount: 1 }], rowCount: 1 };
    expect(normaliseQueryResponse(input)).toBe(input);
  });

  it("maps a top-level error to an empty-result envelope", () => {
    expect(normaliseQueryResponse({ error: "boom" })).toEqual({ results: [], error: "boom" });
  });

  it("wraps a single flat-file result into the multi-result shape", () => {
    const out = normaliseQueryResponse({ columns: ["a"], rows: [["1"]], rowCount: 1 });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({ columns: ["a"], rows: [["1"]], rowCount: 1, sql: "" });
  });
});

// ---- reshapeSqlServerPlan ---------------------------------
describe("reshapeSqlServerPlan", () => {
  const dataResult: QueryResult = { columns: ["id"], rows: [["1"], ["2"]], rowCount: 2 };
  const xmlResult: QueryResult = {
    columns: ["Microsoft SQL Server 2005 XML Showplan"],
    rows: [['<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver">...</ShowPlanXML>']],
    rowCount: 1,
  };

  it("splits the ShowPlanXML cell into a tagged isPlan result and keeps the data", () => {
    const out = reshapeSqlServerPlan([dataResult, xmlResult], "sqlserver");
    expect(out).toHaveLength(2);
    const plan = out.find(r => r.isPlan)!;
    expect(plan.columns).toEqual(["plan"]);
    expect(plan.rows[0][0]).toContain("ShowPlanXML");
    expect(plan.planEngine).toBe("sqlserver");
    // data result preserved, not tagged
    expect(out.find(r => !r.isPlan)).toMatchObject({ columns: ["id"], rowCount: 2 });
  });

  it("detects a plan cell that starts with an XML declaration", () => {
    const decl: QueryResult = { columns: ["p"], rows: [['<?xml version="1.0"?><ShowPlanXML/>']], rowCount: 1 };
    const out = reshapeSqlServerPlan([decl], "sqlserver");
    expect(out.some(r => r.isPlan)).toBe(true);
  });

  it("drops isMessage rows from the data side", () => {
    const msg: QueryResult = { columns: [], rows: [], rowCount: 0, isMessage: true };
    const out = reshapeSqlServerPlan([dataResult, msg, xmlResult], "sqlserver");
    expect(out.some(r => r.isMessage)).toBe(false);
  });

  it("returns the results unchanged when no XML cell is present", () => {
    const input = [dataResult];
    const out = reshapeSqlServerPlan(input, "sqlserver");
    expect(out).toBe(input);
  });
});

// ---- appendExplainPlan ------------------------------------
describe("appendExplainPlan", () => {
  const data: QueryResult = { columns: ["id"], rows: [["1"]], rowCount: 1 };

  it("appends the first plan result tagged isPlan without mutating the input", () => {
    const input = [data];
    const planRaw = JSON.stringify({ results: [{ columns: ["QUERY PLAN"], rows: [["Seq Scan"]], rowCount: 1 }] });
    const out = appendExplainPlan(input, planRaw, "postgres");
    expect(input).toHaveLength(1);            // not mutated
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ isPlan: true, planEngine: "postgres", columns: ["QUERY PLAN"] });
  });

  it("wraps a single-result plan shape that has no .results array", () => {
    const planRaw = JSON.stringify({ columns: ["QUERY PLAN"], rows: [["Index Scan"]], rowCount: 1 });
    const out = appendExplainPlan([data], planRaw, "mysql");
    expect(out[1]).toMatchObject({ isPlan: true, planEngine: "mysql", rows: [["Index Scan"]] });
  });

  it("appends a plan-scoped error result when the plan call returned an error", () => {
    const planRaw = JSON.stringify({ error: "permission denied" });
    const out = appendExplainPlan([data], planRaw, "postgres");
    expect(out[1]).toMatchObject({ isPlan: true, planEngine: "postgres", error: "permission denied" });
  });

  it("appends a parse-failure result when planRaw is not valid JSON", () => {
    const out = appendExplainPlan([data], "not json{", "postgres");
    expect(out[1].isPlan).toBe(true);
    expect(out[1].error).toContain("Plan parse failed");
  });
});
