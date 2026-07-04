#nullable enable

using System;

/// <summary>
/// The single parser for DbArk's SQLite connection-string contract (audit A-3).
///
/// The Rust host builds SQLite connection strings as <c>Data Source={path}</c>
/// (see <c>build_sqlite_conn</c> in <c>src-tauri/src/main.rs</c> — keep the two
/// in sync), and every engine DLL that opens a SQLite file parses the path back
/// out here. Before this type existed the parse was copy-pasted across
/// QueryExecutor, FileQueryEngine and SchemaExplorer — five sites, one of which
/// had already drifted into a buggy <c>.Replace</c> variant that stripped the
/// prefix anywhere in the string instead of only at the start.
///
/// Pure and P/Invoke-free on purpose, so it unit-tests with no DB harness
/// (same Shared-file pattern as <see cref="SqlIdentifier"/> /
/// <see cref="DuckDbTableBuilder"/>).
/// </summary>
public static class SqliteConnectionString
{
    private const string Prefix = "Data Source=";

    /// <summary>
    /// Extracts the database file path from a SQLite connection string.
    /// Accepts the <c>Data Source={path}</c> form the Rust host builds
    /// (prefix matched case-insensitively, at the start only) or a bare
    /// path, which is returned as-is. The result is trimmed.
    /// </summary>
    public static string ExtractPath(string? connectionString)
    {
        var s = (connectionString ?? string.Empty).Trim();
        return s.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase)
            ? s[Prefix.Length..].Trim()
            : s;
    }
}
