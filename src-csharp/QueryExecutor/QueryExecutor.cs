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

public static class QueryExecutor
{
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
        IntPtr readOnlyPtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var sql = Marshal.PtrToStringUTF8(sqlPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";
            var readOnly = Marshal.PtrToStringUTF8(readOnlyPtr) == "true";

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

    [DllImport(SqliteDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(
        IntPtr db,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        int nByte,
        out IntPtr stmt,
        IntPtr pzTail);

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
                sqlite3_prepare_v2(db, "SELECT sqlite_version()", -1, out IntPtr stmt, IntPtr.Zero);
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
            const int rowLimit = 10_000;

            sqlite3_prepare_v2(db, sql, -1, out IntPtr stmt, IntPtr.Zero);

            try
            {
                bool firstRow = true;
                while (sqlite3_step(stmt) == SQLITE_ROW && rowCount < rowLimit)
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
            };
        }
        finally
        {
            sqlite3_close(db);
        }
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

    // ── CockroachDB (Npgsql 8 with programmatic SSL) ────────────────────────
    // Npgsql 8 removed SslMode=Disable from the connection string parser.
    // SslMode.Prefer (default) sends an SSLRequest that CockroachDB insecure
    // ignores, causing a 30-second connection timeout. Setting SslMode.Disable
    // via NpgsqlDataSourceBuilder bypasses the string parser entirely.

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
        const int rowLimit = 10_000;
        bool truncated = false;

        for (int i = 0; i < reader.FieldCount; i++)
            columns.Add(reader.GetName(i));

        int rowCount = 0;
        while (reader.Read())
        {
            if (rowCount >= rowLimit) { truncated = true; break; }
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
}

// ── Result types ────────────────────────────────────────────────────────────

public class QueryResult
{
    [JsonPropertyName("columns")] public List<string> Columns { get; set; } = new();
    [JsonPropertyName("rows")] public List<List<string?>> Rows { get; set; } = new();
    [JsonPropertyName("rowCount")] public int RowCount { get; set; }
    [JsonPropertyName("truncated")] public bool Truncated { get; set; }
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
    // Fixed: was lowercase `error` with no attribute — inconsistent with every
    // other type in this file. PascalCase property + explicit JsonPropertyName
    // produces identical JSON output ("error") while matching C# conventions.
    [JsonPropertyName("error")] public string Error { get; set; } = "";
}

[JsonSerializable(typeof(QueryResult))]
[JsonSerializable(typeof(MultiResult))]
[JsonSerializable(typeof(ErrorResult))]
[JsonSerializable(typeof(List<QueryResult>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AppJsonContext : JsonSerializerContext { }