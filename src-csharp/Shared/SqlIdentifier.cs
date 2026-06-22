#nullable enable

/// <summary>
/// Per-engine SQL identifier and string-literal quoting (audit H-1) — the C# twin of
/// the Rust <c>quote_ident</c> in <c>src-tauri/src/main.rs</c>; keep the two in sync.
///
/// SchemaExplorer reconstructs DDL and builds catalog queries from the object name and
/// schema of whatever node the user right-clicked in the schema tree. Those names arrive
/// from the frontend over IPC and are untrusted: a name containing the engine's quote
/// character (or an apostrophe) must not be able to break out of the identifier — or the
/// string literal — it is interpolated into. <see cref="Quote"/> handles the former,
/// <see cref="EscapeLiteral"/> the latter.
///
/// Pure and P/Invoke-free on purpose, so it unit-tests with no DB harness (same
/// Shared-file pattern as <see cref="DuckDbTableBuilder"/> / <see cref="DuckDbFileScan"/>).
/// </summary>
public static class SqlIdentifier
{
    /// <summary>
    /// Quotes <paramref name="ident"/> for <paramref name="engine"/>, doubling that
    /// engine's closing delimiter so the identifier can't terminate early:
    /// SQL Server <c>[..]</c> (<c>]</c>→<c>]]</c>), MySQL/MariaDB <c>`..`</c>
    /// (<c>`</c>→<c>``</c>), and everything else (Postgres, CockroachDB) the
    /// SQL-standard <c>"..".</c> (<c>"</c>→<c>""</c>).
    /// </summary>
    public static string Quote(string engine, string ident)
    {
        ident ??= "";
        return (engine ?? "").ToLowerInvariant() switch
        {
            "sqlserver"          => "[" + ident.Replace("]", "]]") + "]",
            "mysql" or "mariadb" => "`" + ident.Replace("`", "``") + "`",
            _                    => "\"" + ident.Replace("\"", "\"\"") + "\"",
        };
    }

    /// <summary>
    /// Escapes <paramref name="value"/> for embedding inside a single-quoted SQL string
    /// literal, doubling embedded single quotes. The surrounding quotes are NOT added —
    /// the call site keeps them, e.g. <c>WHERE table_name = '{SqlIdentifier.EscapeLiteral(name)}'</c>.
    /// (Parameterized queries are stronger still and are the preferred fix wherever the
    /// driver supports binding; this exists for the raw-ODBC path that does not.)
    /// </summary>
    public static string EscapeLiteral(string value) => (value ?? "").Replace("'", "''");
}
