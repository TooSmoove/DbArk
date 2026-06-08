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

public static class QueryExecutor
{
    // Per-invocation result row cap, set from the user resultRowLimit setting
    // at the top of ExecuteQuery before any executor runs. Safe as a static:
    // FFI calls are serialized one at a time, so there is no concurrent writer.
    public static int ActiveRowLimit = 10_000;
    // Soft guard: when the cap is high or unlimited (0), results past this size are
    // FLAGGED (not truncated) so the UI can warn that performance may suffer.
    public const int LargeResultThreshold = 500_000;

    private static readonly System.Collections.Generic.HashSet<string> BatchScopedDdlObjects = new(System.StringComparer.Ordinal) { "PROCEDURE", "PROC", "FUNCTION", "VIEW", "TRIGGER" };

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

    // And change TestMySqlConnection to also delegate to the core helper:
    [UnmanagedCallersOnly(EntryPoint = "test_mysql_connection")]
    public static IntPtr TestMySqlConnection(IntPtr connectionStringPtr)
        => TestMySqlConnectionCore(connectionStringPtr);

    // New shared private helper — no UnmanagedCallersOnly, so it's callable from C#:
    private static IntPtr TestMySqlConnectionCore(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            using var conn = new MySqlConnection(connectionString);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT VERSION()";
            var version = cmd.ExecuteScalar()?.ToString();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to MySQL {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    // MariaDB is wire-compatible with MySQL — delegate to the MySQL test.
    [UnmanagedCallersOnly(EntryPoint = "test_mariadb_connection")]
    public static IntPtr TestMariaDbConnection(IntPtr connectionStringPtr)
     => TestMySqlConnectionCore(connectionStringPtr);


    [UnmanagedCallersOnly(EntryPoint = "test_postgres_connection")]
    public static IntPtr TestPostgresConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            using var conn = new NpgsqlConnection(connectionString);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT VERSION()";
            var version = cmd.ExecuteScalar()?.ToString();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to PostgreSQL {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    // CockroachDB uses Npgsql but requires SSL to be set programmatically —
    // see OpenCockroachDbConnection for the reason.
    [UnmanagedCallersOnly(EntryPoint = "test_cockroachdb_connection")]
    public static IntPtr TestCockroachDbConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            using var conn = OpenCockroachDbConnection(connectionString);
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT version()";
            var version = cmd.ExecuteScalar()?.ToString();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to CockroachDB {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
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

            var engineLower = engine.ToLowerInvariant();
            bool useBatchPath =
                engineLower is "sqlserver" or "postgres" or "cockroachdb" or "mysql" or "mariadb";

            if (useBatchPath)
            {
                List<string> batches = engineLower == "sqlserver"
                    ? SplitSqlServerBatches(sql)
                    : new List<string> { sql };

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

            var statements = SplitStatements(sql);

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
                foreach (var stmt in SplitStatements(batch))
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
            var statementCount = SplitStatements(batch).Count;
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

            // Engine dispatch. Stage 2a: only sqlserver is routed here (others
            // still use the legacy path in ExecuteMultiStatement). ExecuteInternal
            // already sends the whole batch as one SQLExecDirectW and harvests
            // every result set via its SQLMoreResults loop — including the
            // "(N rows affected)" message for non-row statements.
            List<QueryResult> dispatchResults = engine.ToLowerInvariant() switch
            {
                "sqlserver" => SqlServerExecutor.ExecuteInternal(connectionString, sqlToRun),
                "postgres" => ExecutePostgresMulti(connectionString, sqlToRun),
                "cockroachdb" => ExecuteCockroachDbMulti(connectionString, sqlToRun),
                "mysql" => ExecuteMySqlMulti(connectionString, sqlToRun),
                "mariadb" => ExecuteMySqlMulti(connectionString, sqlToRun),
                _ => throw new InvalidOperationException(
                        $"ExecuteBatch reached for engine '{engine}' before its stage-2 migration."),
            };

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
    private static List<QueryResult> ExecutePostgresMulti(string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return HarvestReader(reader);
    }

    private static List<QueryResult> ExecuteMySqlMulti(string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return HarvestReader(reader);
    }

    private static List<QueryResult> ExecuteCockroachDbMulti(string connectionString, string sql)
    {
        using var conn = OpenCockroachDbConnection(connectionString); // already open
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return HarvestReader(reader);
    }
    private static List<QueryResult> HarvestReader(System.Data.IDataReader reader)
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
        return engine.ToLowerInvariant() switch
        {
            "postgres" => ExecuteNonQueryPostgres(connectionString, sql),
            "cockroachdb" => ExecuteNonQueryCockroachDb(connectionString, sql),
            "sqlite" => ExecuteNonQuerySqlite(connectionString, sql),
            "sqlserver" => SqlServerExecutor.ExecuteNonQuery(connectionString, sql),
            _ => ExecuteNonQueryMySql(connectionString, sql), // mysql + mariadb
        };
    }

    private static int ExecuteNonQueryMySql(string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        return cmd.ExecuteNonQuery();
    }

    private static int ExecuteNonQueryPostgres(string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        return cmd.ExecuteNonQuery();
    }

    private static int ExecuteNonQuerySqlite(string connectionString, string sql)
    {
        // SQLite via P/Invoke — execute and discard the result set
        ExecuteSqliteCore(connectionString, sql);
        return -1; // P/Invoke path does not expose affected-row count
    }

    // ── SQLite via direct P/Invoke to winsqlite3.dll ────────────────────────
    // winsqlite3.dll ships with Windows 10/11 — zero external dependencies.

    private const string SqliteDll = "winsqlite3.dll";

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string filename,
        out IntPtr db);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr db);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl,
             EntryPoint = "sqlite3_prepare_v2")]
    private static extern int sqlite3_prepare_v2_ptr(
      IntPtr db,
      IntPtr sqlUtf8,        // pointer INTO our persistent UTF-8 buffer
      int nByte,             // -1 = read up to the NUL terminator
      out IntPtr stmt,
      out IntPtr pzTail);    // receives pointer to the unconsumed remainder

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_changes(IntPtr db);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr db);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr stmt);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr stmt);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_count(IntPtr stmt);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_column_type(IntPtr stmt, int col);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_name(IntPtr stmt, int col);

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_column_text(IntPtr stmt, int col);

    private const int SQLITE_OK = 0;
    private const int SQLITE_DONE = 101;
    private const int SQLITE_ROW = 100;
    private const int SQLITE_NULL = 5;

    [UnmanagedCallersOnly(EntryPoint = "test_sqlite_connection")]
    public static IntPtr TestSqliteConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            string path = ExtractSqlitePath(connectionString);

            int rc = sqlite3_open(path, out IntPtr db);
            if (rc != 0)
                return Marshal.StringToCoTaskMemUTF8(
                    $"ERROR: could not open database (code {rc})");

            try
            {
                IntPtr sqlBuf = Marshal.StringToCoTaskMemUTF8("SELECT sqlite_version()");
                IntPtr stmt;
                try
                {
                    sqlite3_prepare_v2_ptr(db, sqlBuf, -1, out stmt, out IntPtr _tail);
                }
                finally
                {
                    Marshal.FreeCoTaskMem(sqlBuf);
                }
                string version = "unknown";
                if (sqlite3_step(stmt) == SQLITE_ROW)
                {
                    IntPtr textPtr = sqlite3_column_text(stmt, 0);
                    if (textPtr != IntPtr.Zero)
                        version = Marshal.PtrToStringUTF8(textPtr) ?? "unknown";
                }
                sqlite3_finalize(stmt);
                return Marshal.StringToCoTaskMemUTF8($"OK: Connected to SQLite {version}");
            }
            finally
            {
                sqlite3_close(db);
            }
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    // Core SQLite execution — returns a typed QueryResult directly.
    // All internal callers use this. The old ExecuteSqlite(IntPtr) path that
    // serialised to JSON, marshalled to unmanaged memory, and immediately
    // deserialised again has been removed — it leaked the unmanaged pointer
    // and wasted allocations on every query.
    private static QueryResult ExecuteSqliteCore(string connectionString, string sql)
    {
        string path = ExtractSqlitePath(connectionString);

        int rc = sqlite3_open(path, out IntPtr db);
        if (rc != 0)
            return new QueryResult
            {
                Error = $"Cannot open SQLite database (code {rc}): {path}"
            };

        try
        {
            var columns = new List<string>();
            var rows = new List<List<string?>>();
            int rowCount = 0;
            int rowLimit = ActiveRowLimit;
            bool truncated = false;

            IntPtr sqlBuf = Marshal.StringToCoTaskMemUTF8(sql);
            IntPtr stmt;
            try
            {
                sqlite3_prepare_v2_ptr(db, sqlBuf, -1, out stmt, out IntPtr _tail);
            }
            finally
            {
                Marshal.FreeCoTaskMem(sqlBuf);
            }

            try
            {
                bool firstRow = true;
                while (sqlite3_step(stmt) == SQLITE_ROW && (rowLimit == 0 || rowCount < rowLimit))
                {
                    int colCount = sqlite3_column_count(stmt);

                    if (firstRow)
                    {
                        for (int i = 0; i < colCount; i++)
                        {
                            IntPtr namePtr = sqlite3_column_name(stmt, i);
                            columns.Add(namePtr != IntPtr.Zero
                                ? Marshal.PtrToStringUTF8(namePtr) ?? $"col{i}"
                                : $"col{i}");
                        }
                        firstRow = false;
                    }

                    var row = new List<string?>();
                    for (int i = 0; i < colCount; i++)
                    {
                        if (sqlite3_column_type(stmt, i) == SQLITE_NULL)
                            row.Add(null);
                        else
                        {
                            IntPtr textPtr = sqlite3_column_text(stmt, i);
                            row.Add(textPtr != IntPtr.Zero
                                ? Marshal.PtrToStringUTF8(textPtr)
                                : null);
                        }
                    }
                    rows.Add(row);
                    rowCount++;
                }
                // If we stopped exactly at a positive cap, peek one more row to
                // distinguish "exactly N rows" from "truncated at N".
                if (rowLimit > 0 && rowCount >= rowLimit
                    && sqlite3_step(stmt) == SQLITE_ROW)
                {
                    truncated = true;
                }
            }
            finally
            {
                sqlite3_finalize(stmt);
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
        finally
        {
            sqlite3_close(db);
        }
    }
    private static List<QueryResult> ExecuteSqliteMulti(string connectionString, string sql)
    {
        string path = ExtractSqlitePath(connectionString);

        int rc = sqlite3_open(path, out IntPtr db);
        if (rc != 0)
            return new List<QueryResult> {
                new QueryResult { Error = $"Cannot open SQLite database (code {rc}): {path}" }
            };

        var results = new List<QueryResult>();
        bool anyResultSet = false;
        int totalChanges = 0;
        int rowLimit = ActiveRowLimit;

        // Persistent UTF-8 buffer so the tail pointer stays valid across the walk.
        IntPtr sqlBuf = Marshal.StringToCoTaskMemUTF8(sql);
        try
        {
            IntPtr cursor = sqlBuf;

            while (true)
            {
                // Stop at the terminating NUL (no more statements).
                if (Marshal.ReadByte(cursor) == 0) break;

                rc = sqlite3_prepare_v2_ptr(db, cursor, -1, out IntPtr stmt, out IntPtr tail);
                if (rc != SQLITE_OK)
                {
                    results.Add(new QueryResult { Error = SqliteErrMsg(db) });
                    break;
                }

                // A null stmt with no error means this chunk was only whitespace
                // or a comment (e.g. a trailing comment after the last ;). Skip
                // it by advancing to the tail.
                if (stmt == IntPtr.Zero)
                {
                    if (tail == cursor) break;   // no forward progress — safety
                    cursor = tail;
                    continue;
                }

                try
                {
                    var columns = new List<string>();
                    var rows = new List<List<string?>>();
                    int rowCount = 0;
                    bool truncated = false;
                    bool firstRow = true;
                    int colCount = sqlite3_column_count(stmt);

                    int stepRc;
                    while ((stepRc = sqlite3_step(stmt)) == SQLITE_ROW)
                    {
                        if (rowLimit > 0 && rowCount >= rowLimit) { truncated = true; break; }

                        if (firstRow)
                        {
                            for (int i = 0; i < colCount; i++)
                            {
                                IntPtr namePtr = sqlite3_column_name(stmt, i);
                                columns.Add(namePtr != IntPtr.Zero
                                    ? Marshal.PtrToStringUTF8(namePtr) ?? $"col{i}"
                                    : $"col{i}");
                            }
                            firstRow = false;
                        }

                        var row = new List<string?>();
                        for (int i = 0; i < colCount; i++)
                        {
                            if (sqlite3_column_type(stmt, i) == SQLITE_NULL)
                                row.Add(null);
                            else
                            {
                                IntPtr textPtr = sqlite3_column_text(stmt, i);
                                row.Add(textPtr != IntPtr.Zero
                                    ? Marshal.PtrToStringUTF8(textPtr) : null);
                            }
                        }
                        rows.Add(row);
                        rowCount++;
                    }

                    // colCount > 0 → a row-returning statement (SELECT, PRAGMA
                    // that returns rows, etc.) → its own result tab. Even if it
                    // returned zero rows, the column header is meaningful.
                    if (colCount > 0)
                    {
                        anyResultSet = true;
                        results.Add(new QueryResult
                        {
                            Columns = columns,
                            Rows = rows,
                            RowCount = rowCount,
                            Truncated = truncated,
                            LargeResult = rowCount >= LargeResultThreshold && (rowLimit == 0 || rowLimit > LargeResultThreshold),
                        });
                    }
                    else
                    {
                        // Non-row statement (INSERT/UPDATE/DELETE/CREATE). Tally
                        // changes; only surfaced if NO result sets at all (D1).
                        totalChanges += sqlite3_changes(db);
                    }
                }
                finally
                {
                    sqlite3_finalize(stmt);
                }

                if (tail == cursor) break;   // safety: guarantee forward progress
                cursor = tail;
            }

            if (!anyResultSet && results.All(r => r.Error == null))
            {
                results.Add(new QueryResult
                {
                    Columns = new List<string> { "Message" },
                    Rows = new List<List<string?>> {
                        new() { $"({totalChanges} row{(totalChanges == 1 ? "" : "s")} affected)" }
                    },
                    RowCount = 0,
                    IsMessage = true,
                });
            }

            return results;
        }
        finally
        {
            Marshal.FreeCoTaskMem(sqlBuf);
            sqlite3_close(db);
        }
    }

    private static string SqliteErrMsg(IntPtr db)
    {
        IntPtr p = sqlite3_errmsg(db);
        return p != IntPtr.Zero
            ? (Marshal.PtrToStringUTF8(p) ?? "SQLite error")
            : "SQLite error";
    }

    private static string ExtractSqlitePath(string connectionString)
    {
        if (connectionString.StartsWith("Data Source=", StringComparison.OrdinalIgnoreCase))
            return connectionString["Data Source=".Length..].Trim();
        return connectionString.Trim();
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

            // Engine dispatch. Only SQL Server can naturally return multiple
            // result sets per statement (STATISTICS XML); every other engine
            // wraps its single QueryResult in a one-element list.
            List<QueryResult> dispatchResults = engine.ToLowerInvariant() switch
            {
                "postgres" => new List<QueryResult> { ExecutePostgresInternal(connectionString, rewrittenSql) },
                "cockroachdb" => new List<QueryResult> { ExecuteCockroachDbInternal(connectionString, rewrittenSql) },
                "sqlite" => new List<QueryResult> { ExecuteSqliteCore(connectionString, rewrittenSql) },
                "sqlserver" => SqlServerExecutor.ExecuteInternal(connectionString, rewrittenSql),
                _ => new List<QueryResult> { ExecuteMySqlInternal(connectionString, rewrittenSql) },
            };

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

    private static QueryResult ExecuteMySqlInternal(string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return ReaderToQueryResult(reader);
    }

    private static QueryResult ExecutePostgresInternal(string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return ReaderToQueryResult(reader);
    }

    private static QueryResult ExecuteCockroachDbInternal(string connectionString, string sql)
    {
        using var conn = OpenCockroachDbConnection(connectionString);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return ReaderToQueryResult(reader);
    }

    private static int ExecuteNonQueryCockroachDb(string connectionString, string sql)
    {
        using var conn = OpenCockroachDbConnection(connectionString);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        return cmd.ExecuteNonQuery();
    }

    private static NpgsqlConnection OpenCockroachDbConnection(string connectionString)
    {
        var parsed = new NpgsqlConnectionStringBuilder(connectionString);
        var dsBuilder = new NpgsqlDataSourceBuilder();
        var csb = dsBuilder.ConnectionStringBuilder;
        csb.Host = parsed.Host;
        csb.Port = parsed.Port;
        csb.Database = parsed.Database;
        csb.Username = parsed.Username;
        csb.Password = parsed.Password;
        csb.SslMode = SslMode.Disable; // enum still present in Npgsql 8
        csb.Pooling = false;           // prevent stale pool entries
        using var dataSource = dsBuilder.Build();
        return dataSource.OpenConnection();
    }

    // ── Shared reader helper ────────────────────────────────────────────────

    private static QueryResult ReaderToQueryResult(System.Data.IDataReader reader)
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

    // ── Statement splitter ──────────────────────────────────────────────────

    private static List<string> SplitStatements(string sql)
    {
        var statements = new List<string>();
        var current = new StringBuilder();
        int depth = 0;
        bool inString = false;
        bool inDollarQuote = false;
        bool inLineComment = false;
        bool inBlockComment = false;
        char stringChar = '\0';
        string dollarTag = "";   // e.g. "$$" or "$body$" or "$function$"
        int i = 0;

        while (i < sql.Length)
        {
            char c = sql[i];

            // ── Single-line comment ──────────────────────────────────────────
            // Handled before string/dollar-quote checks so apostrophes inside
            // comments (e.g. "don't") are never treated as SQL string delimiters
            // — which would swallow subsequent semicolons into one giant statement.
            if (inLineComment)
            {
                current.Append(c);
                if (c == '\n') inLineComment = false;
                i++;
                continue;
            }

            // ── Block comment ────────────────────────────────────────────────
            if (inBlockComment)
            {
                current.Append(c);
                if (c == '*' && i + 1 < sql.Length && sql[i + 1] == '/')
                {
                    current.Append('/');
                    i += 2;
                    inBlockComment = false;
                }
                else i++;
                continue;
            }

            // Detect start of -- comment
            if (!inString && !inDollarQuote
                && c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                inLineComment = true;
                current.Append("--");
                i += 2;
                continue;
            }

            // Detect start of /* comment
            if (!inString && !inDollarQuote
                && c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                inBlockComment = true;
                current.Append("/*");
                i += 2;
                continue;
            }

            // ── Dollar-quoted strings: $$...$$ and $tag$...$tag$ ─────────────
            // Postgres supports both anonymous ($$) and named ($body$, $function$,
            // etc.) dollar-quoting. Semicolons inside either form must not split.
            if (!inString && !inDollarQuote && c == '$')
            {
                // Scan ahead to find the closing $ of the tag
                int tagEnd = i + 1;
                while (tagEnd < sql.Length && sql[tagEnd] != '$'
                    && (char.IsLetterOrDigit(sql[tagEnd]) || sql[tagEnd] == '_'))
                    tagEnd++;

                if (tagEnd < sql.Length && sql[tagEnd] == '$')
                {
                    dollarTag = sql.Substring(i, tagEnd - i + 1); // "$$" or "$body$" etc.
                    inDollarQuote = true;
                    current.Append(dollarTag);
                    i = tagEnd + 1;
                    continue;
                }
            }

            // Check for matching closing dollar-quote tag
            if (inDollarQuote && c == '$'
                && i + dollarTag.Length <= sql.Length
                && sql.Substring(i, dollarTag.Length) == dollarTag)
            {
                inDollarQuote = false;
                current.Append(dollarTag);
                i += dollarTag.Length;
                continue;
            }

            // Inside dollar-quote — append everything verbatim
            if (inDollarQuote)
            {
                current.Append(c);
                i++;
                continue;
            }

            // ── Regular string literals ──────────────────────────────────────
            if (inString)
            {
                current.Append(c);
                if (c == stringChar && (i == 0 || sql[i - 1] != '\\'))
                    inString = false;
                i++;
                continue;
            }

            if (c == '\'' || c == '"' || c == '`')
            {
                inString = true;
                stringChar = c;
                current.Append(c);
                i++;
                continue;
            }

            // ── BEGIN / END depth tracking ───────────────────────────────────
            if (i + 5 <= sql.Length
                && sql.Substring(i, 5).ToUpperInvariant() == "BEGIN"
                && (i == 0 || !char.IsLetterOrDigit(sql[i - 1]))
                && (i + 5 >= sql.Length || !char.IsLetterOrDigit(sql[i + 5])))
            {
                depth++;
                current.Append(sql.Substring(i, 5));
                i += 5;
                continue;
            }

            if (depth > 0 && i + 3 <= sql.Length
                && sql.Substring(i, 3).ToUpperInvariant() == "END"
                && (i == 0 || !char.IsLetterOrDigit(sql[i - 1]))
                && (i + 3 >= sql.Length || !char.IsLetterOrDigit(sql[i + 3])))
            {
                depth--;
                current.Append(sql.Substring(i, 3));
                i += 3;
                continue;
            }

            // ── Semicolon — split only at depth 0, outside all quoted contexts ─
            if (c == ';' && depth == 0)
            {
                var stmt = current.ToString().Trim();
                if (!string.IsNullOrWhiteSpace(stmt))
                    statements.Add(stmt);
                current.Clear();
                i++;
                continue;
            }

            current.Append(c);
            i++;
        }

        var last = current.ToString().Trim();
        if (!string.IsNullOrWhiteSpace(last))
            statements.Add(last);

        return statements;
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


    internal static System.Collections.Generic.List<string> SplitSqlServerBatches(string sql)
    {
        var batches = new System.Collections.Generic.List<string>();
        var current = new System.Text.StringBuilder();

        bool inString = false;
        bool inDollarQuote = false;
        bool inLineComment = false;
        bool inBlockComment = false;
        char stringChar = '\0';
        string dollarTag = "";
        int i = 0;

        bool atLineStart = true;   // for GO (must occupy its own line)
        bool atStmtStart = true;   // for implicit DDL (line start OR just after a ';')

        while (i < sql.Length)
        {
            char c = sql[i];

            // ── Single-line comment ─────────────────────────────────────────────
            if (inLineComment)
            {
                current.Append(c);
                if (c == '\n') { inLineComment = false; atLineStart = true; atStmtStart = true; }
                i++;
                continue;
            }

            // ── Block comment ───────────────────────────────────────────────────
            if (inBlockComment)
            {
                current.Append(c);
                if (c == '*' && i + 1 < sql.Length && sql[i + 1] == '/')
                {
                    current.Append('/');
                    i += 2;
                    inBlockComment = false;
                }
                else i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // Detect start of -- comment
            if (!inString && !inDollarQuote
                && c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                inLineComment = true;
                current.Append("--");
                i += 2;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // Detect start of /* comment
            if (!inString && !inDollarQuote
                && c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                inBlockComment = true;
                current.Append("/*");
                i += 2;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // ── Dollar-quoted strings (parity with the ; splitter) ───────────────
            if (!inString && !inDollarQuote && c == '$')
            {
                int tagEnd = i + 1;
                while (tagEnd < sql.Length && sql[tagEnd] != '$'
                    && (char.IsLetterOrDigit(sql[tagEnd]) || sql[tagEnd] == '_'))
                    tagEnd++;

                if (tagEnd < sql.Length && sql[tagEnd] == '$')
                {
                    dollarTag = sql.Substring(i, tagEnd - i + 1);
                    inDollarQuote = true;
                    current.Append(dollarTag);
                    i = tagEnd + 1;
                    atLineStart = false;
                    atStmtStart = false;
                    continue;
                }
            }

            if (inDollarQuote && c == '$'
                && i + dollarTag.Length <= sql.Length
                && sql.Substring(i, dollarTag.Length) == dollarTag)
            {
                inDollarQuote = false;
                current.Append(dollarTag);
                i += dollarTag.Length;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            if (inDollarQuote)
            {
                current.Append(c);
                i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // ── Regular string literals ─────────────────────────────────────────
            if (inString)
            {
                current.Append(c);
                if (c == stringChar && (i == 0 || sql[i - 1] != '\\'))
                    inString = false;
                i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            if (c == '\'' || c == '"' || c == '`')
            {
                inString = true;
                stringChar = c;
                current.Append(c);
                i++;
                atLineStart = false;
                atStmtStart = false;
                continue;
            }

            // ── Whitespace handling: leading whitespace keeps line/stmt-start ────
            if (c == '\n')
            {
                current.Append(c);
                atLineStart = true;
                atStmtStart = true;
                i++;
                continue;
            }
            if (c == '\r' || c == ' ' || c == '\t')
            {
                current.Append(c);
                // whitespace does NOT clear atLineStart/atStmtStart
                i++;
                continue;
            }

            // ── GO batch separator ───────────────────────────────────────────────
            if (atLineStart
                && (c == 'G' || c == 'g')
                && i + 1 < sql.Length && (sql[i + 1] == 'O' || sql[i + 1] == 'o')
                && (i + 2 >= sql.Length || !IsIdentChar(sql[i + 2])))
            {
                // Confirm the REST of the line is only whitespace or an optional
                // integer repeat count, then a newline / EOF / comment.
                int j = i + 2;
                while (j < sql.Length && (sql[j] == ' ' || sql[j] == '\t')) j++;
                while (j < sql.Length && char.IsDigit(sql[j])) j++;
                while (j < sql.Length && (sql[j] == ' ' || sql[j] == '\t')) j++;
                bool lineEnds =
                    j >= sql.Length
                    || sql[j] == '\n' || sql[j] == '\r'
                    || (sql[j] == '-' && j + 1 < sql.Length && sql[j + 1] == '-');

                if (lineEnds)
                {
                    var batch = current.ToString().Trim();
                    if (!string.IsNullOrWhiteSpace(batch))
                        batches.Add(batch);
                    current.Clear();

                    while (i < sql.Length && sql[i] != '\n') i++;
                    if (i < sql.Length) i++; // consume the newline
                    atLineStart = true;
                    atStmtStart = true;
                    continue;
                }
                // Not a real GO separator — fall through and treat as ordinary text.
            }

            // ── Implicit DDL batch boundary ──────────────────────────────────────
            // CREATE/ALTER [OR ALTER|OR REPLACE] PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER
            if (atStmtStart
                && (c == 'C' || c == 'c' || c == 'A' || c == 'a')
                && StartsBatchScopedDdl(sql, i))
            {
                var prior = current.ToString().Trim();
                if (!string.IsNullOrEmpty(prior))
                {
                    batches.Add(prior);
                    current.Clear();
                    // Do NOT advance i: reprocess the keyword into the fresh batch.
                    // Next pass `current` is empty, so the prior-content guard below
                    // fails and the keyword is appended normally — no infinite loop.
                    continue;
                }
                // current empty → nothing to close; fall through and append normally.
            }

            // ── Ordinary character ──────────────────────────────────────────────
            current.Append(c);
            atLineStart = false;
            atStmtStart = (c == ';');   // a top-level ';' starts a new statement
            i++;
        }

        var lastBatch = current.ToString().Trim();
        if (!string.IsNullOrWhiteSpace(lastBatch))
            batches.Add(lastBatch);

        return batches;
    }

    // Reads a run of identifier chars from `i`, advances `i` past it, and returns
    // the UPPER-cased word (empty string if `i` is not on an identifier char).
    private static string ReadWord(string sql, ref int i)
    {
        int start = i;
        while (i < sql.Length && IsIdentChar(sql[i])) i++;
        return sql.Substring(start, i - start).ToUpperInvariant();
    }

    private static void SkipWs(string sql, ref int i)
    {
        while (i < sql.Length
            && (sql[i] == ' ' || sql[i] == '\t' || sql[i] == '\r' || sql[i] == '\n'))
            i++;
    }

    // True iff text at `start` (the first non-whitespace char of a statement) begins
    // a batch-scoped DDL: CREATE/ALTER [OR ALTER|OR REPLACE] of
    // PROCEDURE/PROC/FUNCTION/VIEW/TRIGGER. Word-boundary aware (so VIEWS, a column
    // named `procedure`, etc. do not match). Whitespace between tokens is skipped;
    // comments between tokens are not (rare — conservatively yields no split).
    private static bool StartsBatchScopedDdl(string sql, int start)
    {
        if (start >= sql.Length) return false;
        char c0 = sql[start];
        if (c0 != 'C' && c0 != 'c' && c0 != 'A' && c0 != 'a') return false;

        int i = start;
        string w1 = ReadWord(sql, ref i);
        if (w1 != "CREATE" && w1 != "ALTER") return false;

        SkipWs(sql, ref i);
        string w2 = ReadWord(sql, ref i);

        if (w2 == "OR")
        {
            SkipWs(sql, ref i);
            string w3 = ReadWord(sql, ref i);
            if (w3 != "ALTER" && w3 != "REPLACE") return false;
            SkipWs(sql, ref i);
            string obj = ReadWord(sql, ref i);
            return BatchScopedDdlObjects.Contains(obj);
        }

        return BatchScopedDdlObjects.Contains(w2);
    }

    private static bool IsIdentChar(char c) =>
        char.IsLetterOrDigit(c) || c == '_';
}

// ── Result types ────────────────────────────────────────────────────────────

public class QueryResult
{
    [JsonPropertyName("columns")] public List<string> Columns { get; set; } = new();
    [JsonPropertyName("rows")] public List<List<string?>> Rows { get; set; } = new();
    [JsonPropertyName("rowCount")] public int RowCount { get; set; }
    [JsonPropertyName("truncated")] public bool Truncated { get; set; }
    [JsonPropertyName("largeResult")] public bool LargeResult { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("isMessage")] public bool IsMessage { get; set; }
    [JsonPropertyName("sql")] public string? Sql { get; set; }
    [JsonPropertyName("wasRewritten")] public bool WasRewritten { get; set; }
}

public class MultiResult
{
    [JsonPropertyName("results")] public List<QueryResult> Results { get; set; } = new();
}

public class ErrorResult
{
    [JsonPropertyName("error")] public string Error { get; set; } = "";
}

[JsonSerializable(typeof(QueryResult))]
[JsonSerializable(typeof(MultiResult))]
[JsonSerializable(typeof(ErrorResult))]
[JsonSerializable(typeof(List<QueryResult>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AppJsonContext : JsonSerializerContext { }