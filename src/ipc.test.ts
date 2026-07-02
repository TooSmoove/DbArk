import { describe, it, expect } from "vitest";
import { extractPayloadError } from "./ipc";

// Regression tests for the silent-drop bug: a DROP that failed at the
// database level came back as a *successful* IPC payload with the error
// in-band, and the caller ignored it — so the object survived while the
// UI proceeded as if it had been dropped.

describe("extractPayloadError", () => {
  it("returns null for a clean multi-result payload", () => {
    const raw = JSON.stringify({ results: [{ columns: [], rows: [], rowCount: 0 }] });
    expect(extractPayloadError(raw)).toBeNull();
  });

  it("finds a top-level error", () => {
    const raw = JSON.stringify({ results: [], error: "Cannot open database" });
    expect(extractPayloadError(raw)).toBe("Cannot open database");
  });

  it("finds a per-statement error inside results[]", () => {
    // The exact shape of a failed DROP: statement error inside a result entry.
    const raw = JSON.stringify({
      results: [{ columns: [], rows: [], rowCount: 0, error: "Cannot drop the table 'users', because it does not exist or you do not have permission." }],
    });
    expect(extractPayloadError(raw)).toMatch(/Cannot drop the table/);
  });

  it("ignores an empty-string error (MultiResult.Error defaults to \"\")", () => {
    const raw = JSON.stringify({ results: [{ rowCount: 1 }], error: "" });
    expect(extractPayloadError(raw)).toBeNull();
  });

  it("returns the first failing statement when several results exist", () => {
    const raw = JSON.stringify({
      results: [{ rowCount: 1 }, { error: "second failed" }, { error: "third failed" }],
    });
    expect(extractPayloadError(raw)).toBe("second failed");
  });

  it("treats a non-JSON payload as a legacy bare error string", () => {
    expect(extractPayloadError("Connection is read-only — statement not allowed: DROP"))
      .toBe("Connection is read-only — statement not allowed: DROP");
  });

  it("returns null for non-object JSON payloads (bool-shaped commands)", () => {
    expect(extractPayloadError("true")).toBeNull();
  });
});
