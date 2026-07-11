#nullable enable
using System;
using System.Collections.Generic;

/// <summary>
/// The canonical engine-name list — the C# layer's single source of truth
/// (audit A-2/A-3). Compile-included per project like the other Shared files.
/// The Rust host has the matching list in <c>src-tauri/src/engine.rs</c>
/// (<c>Engine::parse</c>) and the frontend in <c>src/types/engine.ts</c>;
/// keep the three in sync when adding an engine.
///
/// The wire contract is canonical lowercase: <see cref="IsKnown"/> is
/// case-sensitive on purpose (it backs config validation), while the
/// per-DLL registries stay case-insensitive for defensive robustness.
/// </summary>
internal static class EngineNames
{
    public const string SqlServer = "sqlserver";
    public const string Postgres = "postgres";
    public const string CockroachDb = "cockroachdb";
    public const string MySql = "mysql";
    public const string MariaDb = "mariadb";
    public const string Sqlite = "sqlite";

    /// <summary>Every engine DbArk speaks, in canonical lowercase.</summary>
    public static readonly IReadOnlyList<string> All = new[]
    {
        SqlServer, Postgres, CockroachDb, MySql, MariaDb, Sqlite,
    };

    /// <summary>Exact-match membership test against the canonical list.</summary>
    public static bool IsKnown(string engine)
    {
        foreach (var name in All)
            if (string.Equals(name, engine, StringComparison.Ordinal))
                return true;
        return false;
    }
}
