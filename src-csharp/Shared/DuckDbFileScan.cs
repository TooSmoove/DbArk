#nullable enable

/// <summary>
/// Builds the DuckDB relation expression that exposes a flat file as a table, with the
/// file path safely single-quote-escaped (audit H-1).
///
/// THE BUG THIS FIXES: the path used to be interpolated raw —
/// <c>read_csv_auto('{normPath}')</c> / <c>SELECT * FROM '{normPath}'</c>. A path
/// containing an apostrophe (e.g. <c>/Users/O'Brien/data.csv</c>) closed the literal
/// early: it broke the statement and was a SQL-injection seam reachable through the
/// file picker. Three separate call sites duplicated that switch; they all now route
/// through this one helper, so the escaping lives in exactly one tested place (DRY).
///
/// Pure and P/Invoke-free on purpose, so it unit-tests with no DuckDB harness — the
/// same Shared-file pattern as <see cref="NativeString"/> / <see cref="DuckDbTableBuilder"/>.
/// It is &lt;Compile Include&gt;-linked into FileQueryEngine (which uses it) and into the
/// test project (which tests it).
/// </summary>
public static class DuckDbFileScan
{
    /// <summary>
    /// Returns a DuckDB relation expression for the file at <paramref name="normPath"/>
    /// (forward-slash normalised), chosen by the lowercased <paramref name="ext"/>:
    /// <c>read_csv_auto(...)</c> for <c>.csv</c>, <c>read_json_auto(...)</c> for
    /// <c>.json</c>, and a bare quoted path (DuckDB infers the reader from the
    /// extension) for anything else. The path is single-quote-escaped in every branch.
    /// Intended to be dropped in after <c>FROM</c>:
    /// <c>$"SELECT * FROM {DuckDbFileScan.ScanExpr(ext, normPath)}"</c>.
    /// </summary>
    public static string ScanExpr(string ext, string normPath)
    {
        // Reuse the one escaping routine so file paths and staged values can't drift.
        string path = DuckDbTableBuilder.QuoteLiteral(normPath ?? "");
        return (ext ?? "").ToLowerInvariant() switch
        {
            ".csv"  => $"read_csv_auto({path})",
            ".json" => $"read_json_auto({path})",
            _       => path,
        };
    }
}
