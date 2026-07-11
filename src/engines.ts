// ─────────────────────────────────────────────────────────────────────────
// The canonical engine-name list — the frontend's single source of truth
// (code-audit item A-2). The Rust host owns the matching list in
// src-tauri/src/engine.rs (Engine::parse) and the C# layer in
// src-csharp/Shared/EngineNames.cs; keep the three in sync when adding an
// engine. The wire contract is canonical lowercase.
// ─────────────────────────────────────────────────────────────────────────

export const ENGINE_NAMES = [
  "sqlserver",
  "postgres",
  "cockroachdb",
  "mysql",
  "mariadb",
  "sqlite",
] as const;

/** One of the six engines DbArk speaks, in canonical lowercase. */
export type EngineName = (typeof ENGINE_NAMES)[number];

/** Exact-match runtime check that narrows a wire string to EngineName. */
export function isEngineName(value: string): value is EngineName {
  return (ENGINE_NAMES as readonly string[]).includes(value);
}

/**
 * Narrow a string from an untrusted boundary (imports, old config files) to
 * an EngineName, throwing with a useful message instead of letting a bogus
 * engine name travel deeper into the app.
 */
export function toEngineName(value: string): EngineName {
  if (!isEngineName(value)) throw new Error(`Unsupported engine: ${value}`);
  return value;
}
