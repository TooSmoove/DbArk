import { describe, expect, it } from "vitest";
import { ENGINE_NAMES, isEngineName, toEngineName } from "./engines";

// The canonical engine list backs ConnectionConfig.engine and must stay in
// lockstep with src-tauri/src/engine.rs (Engine::parse) and
// src-csharp/Shared/EngineNames.cs (audit A-2).
describe("engines", () => {
  it("lists exactly the six supported engines in canonical lowercase", () => {
    expect(ENGINE_NAMES).toEqual([
      "sqlserver",
      "postgres",
      "cockroachdb",
      "mysql",
      "mariadb",
      "sqlite",
    ]);
  });

  it("isEngineName is an exact match on the canonical spelling", () => {
    for (const name of ENGINE_NAMES) expect(isEngineName(name)).toBe(true);
    expect(isEngineName("MySQL")).toBe(false); // wire contract is lowercase
    expect(isEngineName("oracle")).toBe(false);
    expect(isEngineName("")).toBe(false);
  });

  it("toEngineName narrows valid names and fails loudly on bogus ones", () => {
    expect(toEngineName("mariadb")).toBe("mariadb");
    expect(() => toEngineName("dbase")).toThrow("Unsupported engine: dbase");
  });
});
