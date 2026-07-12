#nullable enable
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("QueryExecutor.Tests")]
// Integration + container test assemblies reach the internal engine registry
// (QueryEngines / IQueryEngine). Declared in source (not just the csproj
// <InternalsVisibleTo> items) so the grant is embedded here and editing this
// file forces QueryExecutor to recompile — a csproj-only grant can be missed by
// an incremental build and surfaces as CS0122 in the referencing test project.
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("QueryExecutor.ContainerTests")]

public static class QueryExecutor
{
    // Per-invocation result row cap, set from the user resultRowLimit setting
    // at the top of ExecuteQuery before any executor runs. Safe as a static:
    // FFI calls are serialized one at a time, so there is no concurrent writer.
    public static int ActiveRowLimit = 10_000;
    // Soft guard: when the cap is high or unlimited (0), results past this size are
    // FLAGGED (not truncated) so the UI can warn that performance may suffer.
    public const int LargeResultThreshold = 500_000;

    // ── NativeAOT entry points ──────────────────────────────────────────────

    // NOTE: test_connection is a legacy pointer-validity check only.
    // It does NOT open a socket or verify credentials. Rust should call the
    // engine-specific test_*_connection entry points for real connection tests.
    [UnmanagedCallersOnly(EntryPoint = "test_connection")]
    public static int TestConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            return string.IsNullOrEmpty(connectionString) ? 0 : 1;
        }
        catch
        {
            return 0;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "execute_query")]
    public static IntPtr ExecuteQuery(
        IntPtr connectionStringPtr,
        IntPtr sqlPtr,
        IntPtr enginePtr,
        IntPtr readOnlyPtr,
        IntPtr rowLimitPtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var sql = Marshal.PtrToStringUTF8(sqlPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";
            var readOnly = Marshal.PtrToStringUTF8(readOnlyPtr) == "true";

            // Result row cap from the user setting (string over FFI, like readOnly).
            // Clamp to a floor so a bad/zero value cannot empty the grid.
            ActiveRowLimit = int.TryParse(Marshal.PtrToStringUTF8(rowLimitPtr), out var rl) && rl > 0
                ? rl : 10_000;

            // Engine dispatch (audit A-2): resolve once, ask the engine for
            // its capabilities instead of matching names inline.
            var queryEngine = QueryEngines.Resolve(engine);

            if (queryEngine.UsesBatchPath)
            {
                List<string> batches = queryEngine.SplitBatches(sql);

                if (batches.Count == 0)
                    return Marshal.StringToCoTaskMemUTF8(
                        JsonSerializer.Serialize(
                            new MultiResult { Results = new List<QueryResult>() },
                            AppJsonContext.Default.MultiResult));

                var batchResults = RunBatches(connectionString, batches, engine, readOnly);
                return Marshal.StringToCoTaskMemUTF8(
                    JsonSerializer.Serialize(
                        new MultiResult { Results = batchResults },
                        AppJsonContext.Default.MultiResult));
            }

            var statements = SqlStatementSplitter.Split(sql);

            if (statements.Count == 0)
                return Marshal.StringToCoTaskMemUTF8("No statements found");

            // Enforce read-only on all statements upfront
            if (readOnly)
            {
                foreach (var stmt in statements)
                {
                    if (!IsReadOnlyStatement(stmt))
                        return Marshal.StringToCoTaskMemUTF8(
                            $"Connection is read-only — statement not allowed: {stmt.Split('\n')[0].Trim()}");
                }
            }

            var results = new List<QueryResult>();

            foreach (var stmt in statements)
            {
                var stmtResults = ExecuteStatement(connectionString, stmt, engine);
                results.AddRange(stmtResults);

                // Stop at first error in any result set this statement produced
                if (stmtResults.Any(r => r.Error != null))
                    break;
            }

            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(
                    new MultiResult { Results = results },
                    AppJsonContext.Default.MultiResult));
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8(ex.Message);
        }
    }

    private static List<QueryResult> RunBatches(
       string connectionString, List<string> batches, string engine, bool readOnly)
    {
        var results = new List<QueryResult>();

        foreach (var batch in batches)
        {
            // D2: split THIS batch into statements for validation ONLY.
            // Execution still sends the batch whole (preserving scope).
            if (readOnly)
            {
                foreach (var stmt in SqlStatementSplitter.Split(batch))
                {
                    if (!IsReadOnlyStatement(stmt))
                    {
                        results.Add(new QueryResult
                        {
                            Error = "Connection is read-only — statement not allowed: "
                                    + stmt.Split('\n')[0].Trim(),
                        });
                        return results;   // stop the whole run on violation
                    }
                }
            }

            var batchResults = ExecuteBatch(connectionString, batch, engine);
            results.AddRange(batchResults);

            // Stop at the first batch that errored (matches prior behaviour).
            if (batchResults.Any(r => r.Error != null))
                break;
        }

        return results;
    }

    private static List<QueryResult> ExecuteBatch(
      string connectionString, string batch, string engine)
    {
        try
        {
            var strippedSql = StripLeadingComments(batch).TrimStart();
            var sqlForStorage = strippedSql.Length > 500 ? strippedSql[..500] + "…" : strippedSql;

            // D3: DDL auto-rewrite applies to SINGLE-statement batches only.
            // Multi-statement batches pass through unrewritten (documented).
            var statementCount = SqlStatementSplitter.Split(batch).Count;
            string sqlToRun = batch;
            bool wasRewritten = false;
            if (statementCount == 1)
            {
                var rewritten = RewriteDdlStatement(batch, engine);
                if (rewritten != batch)
                {
                    sqlToRun = rewritten;
                    wasRewritten = true;
                }
            }

            // Engine dispatch (audit A-2): one registry lookup replaces the
            // per-engine switch. SQLite (legacy statement path) throws here by
            // design; unknown engines are rejected by the registry.
            List<QueryResult> dispatchResults =
                QueryEngines.Resolve(engine).ExecuteBatch(connectionString, sqlToRun);

            foreach (var r in dispatchResults)
            {
                r.Sql = sqlForStorage;
                r.WasRewritten = wasRewritten;
            }
            return dispatchResults;
        }
        catch (Exception ex)
        {
            var stripped = StripLeadingComments(batch).TrimStart();
            return new List<QueryResult> {
                new QueryResult {
                    Error = ex.Message,
                    Sql = stripped.Length > 500 ? stripped[..500] + "…" : stripped,
                }
            };
        }
    }
    internal static List<QueryResult> HarvestReader(System.Data.IDataReader reader)
    {
        var results = new List<QueryResult>();
        bool anyResultSet = false;

        do
        {
            if (reader.FieldCount > 0)
            {
                anyResultSet = true;
                results.Add(ReaderToQueryResult(reader));
            }
        }
        while (reader.NextResult());

        if (!anyResultSet)
        {
            int affected = reader.RecordsAffected; // cumulative; -1 if N/A
            results.Add(new QueryResult
            {
                Columns = new List<string> { "Message" },
                Rows = new List<List<string?>> {
                    new() {
                        affected >= 0
                            ? $"({affected} row{(affected == 1 ? "" : "s")} affected)"
                            : "Command completed successfully."
                    }
                },
                RowCount = 0,
                IsMessage = true,
            });
        }

        return results;
    }

    // ── Non-query dispatch ──────────────────────────────────────────────────

    private static int ExecuteNonQuery(string connectionString, string sql, string engine)
    {
        return QueryEngines.Resolve(engine).ExecuteNonQuery(connectionString, sql);
    }


    // ── Read-only guard ─────────────────────────────────────────────────────

    private static bool IsReadOnlyStatement(string sql)
    {
        var trimmed = StripLeadingComments(sql).TrimStart().ToUpperInvariant();

        // WITH ... SELECT is read-only; WITH ... DELETE/INSERT/UPDATE/MERGE is not.
        // Scan past the CTE body to find the actual DML verb before deciding.
        if (trimmed.StartsWith("WITH"))
        {
            var verb = GetVerbAfterCte(trimmed);
            return verb.StartsWith("SELECT") || verb.StartsWith("TABLE");
        }

        return trimmed.StartsWith("SELECT")
               || trimmed.StartsWith("SHOW")
               || trimmed.StartsWith("DESCRIBE")
               || trimmed.StartsWith("EXPLAIN")
               || trimmed.StartsWith("SET STATISTICS XML")
               || trimmed.StartsWith("SET SHOWPLAN_XML")
               || trimmed.StartsWith("SET STATISTICS PROFILE")
               || IsPlanCaptureBatch(trimmed);
    }
    /// <summary>
    /// Returns true when the SQL is a plan-capture batch — specifically a
    /// BEGIN...END block that contains STATISTICS XML or SHOWPLAN_XML directives.
    /// Tight check: a generic BEGIN TRANSACTION...COMMIT batch will not match,
    /// nor will a BEGIN...END containing arbitrary DML. The block must contain
    /// at least one plan-capture SET directive to qualify.
    /// </summary>
    private static bool IsPlanCaptureBatch(string upperTrimmed)
    {
        if (!upperTrimmed.StartsWith("BEGIN")) return false;
        // The very first thing after BEGIN should be either whitespace or
        // a newline — distinguishes our wrapper from "BEGIN TRANSACTION".
        // We only need to check that the block contains a plan-capture
        // directive to know it's our wrapper.
        return upperTrimmed.Contains("STATISTICS XML")
            || upperTrimmed.Contains("SHOWPLAN_XML")
            || upperTrimmed.Contains("STATISTICS PROFILE");
    }

    // Scans past CTE definitions — WITH [RECURSIVE] name AS (...), name AS (...) —
    // and returns the text that follows them (the actual DML verb). Handles nested
    // parentheses correctly so a subquery inside a CTE body doesn't confuse the scan.
    private static string GetVerbAfterCte(string upperSql)
    {
        int i = 4; // skip "WITH"

        while (i < upperSql.Length)
        {
            // Skip whitespace
            while (i < upperSql.Length && char.IsWhiteSpace(upperSql[i])) i++;

            // Skip optional RECURSIVE keyword
            if (i + 9 <= upperSql.Length && upperSql.Substring(i, 9) == "RECURSIVE")
            {
                i += 9;
                continue;
            }

            // Skip CTE name (identifier)
            while (i < upperSql.Length
                && (char.IsLetterOrDigit(upperSql[i]) || upperSql[i] == '_')) i++;

            // Skip whitespace then AS
            while (i < upperSql.Length && char.IsWhiteSpace(upperSql[i])) i++;
            if (i + 2 <= upperSql.Length && upperSql.Substring(i, 2) == "AS")
                i += 2;
            while (i < upperSql.Length && char.IsWhiteSpace(upperSql[i])) i++;

            // Skip the parenthesised CTE body — track depth for nested parens
            if (i < upperSql.Length && upperSql[i] == '(')
            {
                int depth = 1;
                i++;
                while (i < upperSql.Length && depth > 0)
                {
                    if (upperSql[i] == '(') depth++;
                    else if (upperSql[i] == ')') depth--;
                    i++;
                }
            }

            // Skip whitespace
            while (i < upperSql.Length && char.IsWhiteSpace(upperSql[i])) i++;

            // Another CTE in the list — loop
            if (i < upperSql.Length && upperSql[i] == ',') { i++; continue; }

            // Whatever remains is the final DML verb (SELECT, INSERT, UPDATE, etc.)
            return i < upperSql.Length ? upperSql[i..] : "";
        }

        return "";
    }

    // ── Statement execution ─────────────────────────────────────────────────

    private static List<QueryResult> ExecuteStatement(
    string connectionString, string sql, string engine)
    {
        try
        {
            var strippedSql = StripLeadingComments(sql).TrimStart();
            var sqlForStorage = strippedSql.Length > 500 ? strippedSql[..500] + "…" : strippedSql;

            // CockroachDB CALL guard
            if (engine.Equals("cockroachdb", StringComparison.OrdinalIgnoreCase)
                && strippedSql.StartsWith("CALL", StringComparison.OrdinalIgnoreCase))
            {
                return new List<QueryResult> {
                new QueryResult
                {
                    Columns = new List<string> { "Message" },
                    Rows = new List<List<string?>>
                    {
                        new() { "CockroachDB procedures do not return result sets. " +
                                "Use SELECT * FROM function_name() to return rows." }
                    },
                    IsMessage = true,
                    Sql = sqlForStorage,
                }
            };
            }

            var rewrittenSql = RewriteDdlStatement(sql, engine);
            var isSelect = IsReadOnlyStatement(rewrittenSql);

            if (!isSelect)
            {
                int rowsAffected = ExecuteNonQuery(connectionString, rewrittenSql, engine);
                return new List<QueryResult> {
                new QueryResult
                {
                    Columns = new List<string> { "Message" },
                    Rows = new List<List<string?>>
                    {
                        new() {
                            rowsAffected >= 0
                                ? $"({rowsAffected} row{(rowsAffected == 1 ? "" : "s")} affected)"
                                : "Command completed successfully."
                        }
                    },
                    RowCount = 0,
                    Truncated = false,
                    IsMessage = true,
                    Sql = sqlForStorage,
                    WasRewritten = rewrittenSql != sql,
                }
            };
            }

            // Engine dispatch (audit A-2): one registry lookup replaces the
            // per-engine switch. Only SQL Server naturally returns multiple
            // result sets per statement (STATISTICS XML); other engines wrap
            // their single QueryResult in a one-element list.
            List<QueryResult> dispatchResults =
                QueryEngines.Resolve(engine).ExecuteStatement(connectionString, rewrittenSql);

            foreach (var r in dispatchResults)
            {
                r.Sql = sqlForStorage;
                r.WasRewritten = rewrittenSql != sql;
            }
            return dispatchResults;
        }
        catch (Exception ex)
        {
            var stripped = StripLeadingComments(sql).TrimStart();
            return new List<QueryResult> {
                new QueryResult
                {
                    Error = ex.Message,
                    Sql = stripped.Length > 500 ? stripped[..500] + "…" : stripped,
                }
            };
        }
    }

    // ── Shared reader helper ────────────────────────────────────────────────

    internal static QueryResult ReaderToQueryResult(System.Data.IDataReader reader)
    {
        var columns = new List<string>();
        var rows = new List<List<string?>>();
        int rowLimit = ActiveRowLimit;
        bool truncated = false;

        for (int i = 0; i < reader.FieldCount; i++)
            columns.Add(reader.GetName(i));

        int rowCount = 0;
        while (reader.Read())
        {
            if (rowLimit > 0 && rowCount >= rowLimit) { truncated = true; break; }
            var row = new List<string?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row.Add(reader.IsDBNull(i) ? null : reader.GetValue(i)?.ToString());
            rows.Add(row);
            rowCount++;
        }

        return new QueryResult
        {
            Columns = columns,
            Rows = rows,
            RowCount = rowCount,
            Truncated = truncated,
            LargeResult = rowCount >= LargeResultThreshold && (rowLimit == 0 || rowLimit > LargeResultThreshold),
        };
    }

    // ── Smart DDL rewriter ──────────────────────────────────────────────────

    private static string RewriteDdlStatement(string sql, string engine)
    {
        var trimmed = sql.TrimStart();
        var upper = trimmed.ToUpperInvariant();

        if (upper.Contains("OR ALTER") || upper.Contains("OR REPLACE"))
            return sql; // already idempotent

        if (!upper.StartsWith("CREATE "))
            return sql;

        return engine.ToLowerInvariant() switch
        {
            "sqlserver" => RewriteSqlServer(sql, upper),
            "mysql" or "mariadb" => RewriteMySqlOrPostgres(sql, upper, "OR REPLACE"),
            "postgres" or "cockroachdb" => RewriteMySqlOrPostgres(sql, upper, "OR REPLACE"),
            _ => sql,
        };
    }

    private static string RewriteSqlServer(string sql, string upper)
    {
        // SQL Server supports CREATE OR ALTER for PROCEDURE, FUNCTION, VIEW, TRIGGER.
        // Use a regex to handle any whitespace (spaces, tabs, newlines) between
        // CREATE and the keyword — a naive string match breaks on formatted SQL.
        string[] supported = { "PROCEDURE", "FUNCTION", "VIEW", "TRIGGER" };
        foreach (var keyword in supported)
        {
            var match = Regex.Match(upper,
                $@"CREATE\s+{keyword}(?=[^A-Z0-9_]|$)",
                RegexOptions.IgnoreCase);

            if (match.Success)
            {
                return sql[..match.Index]
                    + $"CREATE OR ALTER {keyword}"
                    + sql[(match.Index + match.Length)..];
            }
        }
        return sql;
    }

    private static string RewriteMySqlOrPostgres(string sql, string upper, string modifier)
    {
        // MySQL / MariaDB / Postgres / CockroachDB support CREATE OR REPLACE for
        // PROCEDURE, FUNCTION, VIEW.
        // NOTE: Triggers do NOT support OR REPLACE in MySQL — omitted intentionally.
        string[] supported = { "PROCEDURE", "FUNCTION", "VIEW" };
        foreach (var keyword in supported)
        {
            var match = Regex.Match(upper,
                $@"CREATE\s+{keyword}(?=[^A-Z0-9_]|$)",
                RegexOptions.IgnoreCase);

            if (match.Success)
            {
                return sql[..match.Index]
                    + $"CREATE {modifier} {keyword}"
                    + sql[(match.Index + match.Length)..];
            }
        }
        return sql;
    }

    // ── Comment stripper ────────────────────────────────────────────────────

    private static string StripLeadingComments(string sql)
    {
        bool inBlock = false, foundCode = false;
        int i = 0;
        var sb = new StringBuilder();
        while (i < sql.Length)
        {
            if (inBlock)
            {
                if (i + 1 < sql.Length && sql[i] == '*' && sql[i + 1] == '/')
                { inBlock = false; i += 2; }
                else i++;
                continue;
            }
            if (!foundCode && i + 1 < sql.Length && sql[i] == '/' && sql[i + 1] == '*')
            { inBlock = true; i += 2; continue; }
            if (!foundCode && i + 1 < sql.Length && sql[i] == '-' && sql[i + 1] == '-')
            { while (i < sql.Length && sql[i] != '\n') i++; continue; }
            if (!foundCode && (sql[i] == '\n' || sql[i] == '\r'
                                || sql[i] == ' ' || sql[i] == '\t'))
            { i++; continue; }
            foundCode = true;
            sb.Append(sql[i++]);
        }
        return sb.ToString();
    }


}
