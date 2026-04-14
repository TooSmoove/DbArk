#nullable enable
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

public static class QueryExecutor
{
    [UnmanagedCallersOnly(EntryPoint = "test_connection")]
    public static int TestConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return 0;
            return 1;
        }
        catch
        {
            return 0;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "test_mysql_connection")]
    public static IntPtr TestMySqlConnection(IntPtr connectionStringPtr)
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
            conn.Close();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to MySQL {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

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
            conn.Close();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to PostgreSQL {version}");
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
                        return Marshal.StringToCoTaskMemUTF8($"Connection is read-only — statement not allowed: {stmt.Split('\n')[0].Trim()}");
                }
            }

            var results = new List<QueryResult>();

            foreach (var stmt in statements)
            {
                var result = ExecuteStatement(connectionString, stmt, engine);
                results.Add(result);

                // Stop at first error
                if (result.Error != null)
                    break;
            }

            // After the foreach loop, temporarily replace the return with:
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

    private static int ExecuteNonQuery(
        string connectionString, string sql, string engine)
    {
        return engine.ToLower() switch
        {
            "postgres" => ExecuteNonQueryPostgres(connectionString, sql),
            "sqlite" => ExecuteNonQuerySqlite(connectionString, sql),
            "sqlserver" => SqlServerExecutor.ExecuteNonQuery(connectionString, sql),
            _ => ExecuteNonQueryMySql(connectionString, sql),
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
        // SQLite via P/Invoke doesn't have a direct non-query path
        // Use the existing Execute method and discard the result
        ExecuteSqlite(connectionString, sql);
        return -1; // SQLite P/Invoke doesn't return row counts easily
    }
    // ---- SQLite via direct P/Invoke to winsqlite3.dll ----------------
    // winsqlite3.dll ships with Windows 10/11 — zero external dependencies

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
                sqlite3_prepare_v2(db, "SELECT sqlite_version()",
                    -1, out IntPtr stmt, IntPtr.Zero);
                string version = "unknown";
                if (sqlite3_step(stmt) == SQLITE_ROW)
                {
                    IntPtr textPtr = sqlite3_column_text(stmt, 0);
                    if (textPtr != IntPtr.Zero)
                        version = Marshal.PtrToStringUTF8(textPtr) ?? "unknown";
                }
                sqlite3_finalize(stmt);
                return Marshal.StringToCoTaskMemUTF8(
                    $"OK: Connected to SQLite {version}");
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

    private static IntPtr ExecuteSqlite(string connectionString, string sql)
    {
        string path = ExtractSqlitePath(connectionString);

        int rc = sqlite3_open(path, out IntPtr db);
        if (rc != 0)
        {
            var err = new ErrorResult
            {
                error = $"Cannot open SQLite database (code {rc}): {path}"
            };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(err, AppJsonContext.Default.ErrorResult));
        }

        try
        {
            var columns = new List<string>();
            var rows = new List<List<string?>>();
            int rowCount = 0;
            int rowLimit = 10000;

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
                        {
                            row.Add(null);
                        }
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

            var result = new QueryResult
            {
                Columns = columns,
                Rows = rows,
                RowCount = rowCount
            };

            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(result, AppJsonContext.Default.QueryResult));
        }
        finally
        {
            sqlite3_close(db);
        }
    }

    private static string ExtractSqlitePath(string connectionString)
    {
        // Handle "Data Source=path" format
        if (connectionString.StartsWith("Data Source=",
            StringComparison.OrdinalIgnoreCase))
            return connectionString["Data Source=".Length..].Trim();

        // Handle bare file path
        return connectionString.Trim();
    }
    private static bool IsReadOnlyStatement(string sql)
    {
        // Trim and get the first word
        var trimmed = sql.TrimStart().ToUpperInvariant();
        // Allow only SELECT and read-only pragmas/commands
        return trimmed.StartsWith("SELECT")
            || trimmed.StartsWith("SHOW")
            || trimmed.StartsWith("DESCRIBE")
            || trimmed.StartsWith("EXPLAIN")
            || trimmed.StartsWith("PRAGMA")
            || trimmed.StartsWith("WITH"); // CTEs — may contain SELECT
    }
    private static QueryResult ExecuteStatement(
    string connectionString, string sql, string engine)
    {
        try
        {
            var isSelect = IsReadOnlyStatement(sql);

            // Temporary debug — return this info as a message result
            // to see what's happening
            if (isSelect)
            {
                var result1 = engine.ToLower() switch
                {
                    "postgres" => ExecutePostgresInternal(connectionString, sql),
                    "sqlite" => ExecuteSqliteInternal(connectionString, sql),
                    "sqlserver" => SqlServerExecutor.ExecuteInternal(connectionString, sql),
                    _ => ExecuteMySqlInternal(connectionString, sql),
                };
                result1.Sql = sql.Length > 80 ? sql[..80] + "…" : sql;

                return result1;
            }

            if (!isSelect)
            {
                int rowsAffected = ExecuteNonQuery(connectionString, sql, engine);
                return new QueryResult
                {
                    Columns = new List<string> { "Message" },
                    Rows = new List<List<string?>>
                {
                    new List<string?> { rowsAffected >= 0
                        ? $"({rowsAffected} row{(rowsAffected == 1 ? "" : "s")} affected)"
                        : "Command completed successfully." }
                },
                    RowCount = 0,
                    Truncated = false,
                    IsMessage = true,
                    Sql = sql.Length > 80 ? sql[..80] + "…" : sql,
                };
            }

            // SELECT — call internal methods that return QueryResult directly
            var result = engine.ToLower() switch
            {
                "postgres" => ExecutePostgresInternal(connectionString, sql),
                "sqlite" => ExecuteSqliteInternal(connectionString, sql),
                "sqlserver" => SqlServerExecutor.ExecuteInternal(connectionString, sql),
                _ => ExecuteMySqlInternal(connectionString, sql),
            };

            result.Sql = sql.Length > 80 ? sql[..80] + "…" : sql;
            return result;
        }
        catch (Exception ex)
        {
            return new QueryResult
            {
                Error = ex.Message,
                Sql = sql.Length > 80 ? sql[..80] + "…" : sql
            };
        }
    }
    private static QueryResult ExecuteMySqlInternal(
    string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return ReaderToQueryResult(reader);
    }

    private static QueryResult ExecutePostgresInternal(
        string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return ReaderToQueryResult(reader);
    }

    private static QueryResult ExecuteSqliteInternal(
        string connectionString, string sql)
    {
        // SQLite uses P/Invoke — reuse existing IntPtr path and deserialise
        var ptr = ExecuteSqlite(connectionString, sql);
        var json = Marshal.PtrToStringUTF8(ptr) ?? "{}";
        return JsonSerializer.Deserialize<QueryResult>(
            json, AppJsonContext.Default.QueryResult)
            ?? new QueryResult();
    }
    private static QueryResult ReaderToQueryResult(System.Data.IDataReader reader)
    {
        var columns = new List<string>();
        var rows = new List<List<string?>>();
        int rowLimit = 10_000;
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
    private static List<string> SplitStatements(string sql)
    {
        var statements = new List<string>();
        var current = new System.Text.StringBuilder();
        int depth = 0;
        bool inString = false;
        bool inDollarQuote = false;
        char stringChar = '\0';
        int i = 0;

        while (i < sql.Length)
        {
            char c = sql[i];

            // Handle dollar-quoted strings (Postgres $$...$$)
            if (!inString && !inDollarQuote && i + 1 < sql.Length
                && c == '$' && sql[i + 1] == '$')
            {
                inDollarQuote = true;
                current.Append("$$");
                i += 2;
                continue;
            }

            if (inDollarQuote && i + 1 < sql.Length
                && c == '$' && sql[i + 1] == '$')
            {
                inDollarQuote = false;
                current.Append("$$");
                i += 2;
                continue;
            }

            // Inside dollar quote — append everything as-is
            if (inDollarQuote)
            {
                current.Append(c);
                i++;
                continue;
            }

            // Handle regular string literals
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

            // Check for BEGIN keyword
            if (i + 5 <= sql.Length &&
                sql.Substring(i, 5).ToUpperInvariant() == "BEGIN" &&
                (i == 0 || !char.IsLetterOrDigit(sql[i - 1])) &&
                (i + 5 >= sql.Length || !char.IsLetterOrDigit(sql[i + 5])))
            {
                depth++;
                current.Append(sql.Substring(i, 5));
                i += 5;
                continue;
            }

            // Check for END keyword
            if (depth > 0 && i + 3 <= sql.Length &&
                sql.Substring(i, 3).ToUpperInvariant() == "END" &&
                (i == 0 || !char.IsLetterOrDigit(sql[i - 1])) &&
                (i + 3 >= sql.Length || !char.IsLetterOrDigit(sql[i + 3])))
            {
                depth--;
                current.Append(sql.Substring(i, 3));
                i += 3;
                continue;
            }

            // Semicolon — only split if not inside BEGIN...END or $$...$$
            if (c == ';' && depth == 0 && !inDollarQuote)
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
}

public class QueryResult
{
    [JsonPropertyName("columns")] public List<string> Columns { get; set; } = new();
    [JsonPropertyName("rows")] public List<List<string?>> Rows { get; set; } = new();
    [JsonPropertyName("rowCount")] public int RowCount { get; set; }
    [JsonPropertyName("truncated")] public bool Truncated { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("isMessage")] public bool IsMessage { get; set; }
    [JsonPropertyName("sql")] public string? Sql { get; set; }
}
public class MultiResult
{
    [JsonPropertyName("results")] public List<QueryResult> Results { get; set; } = new();
}

public class ErrorResult
{
    public string error { get; set; } = "";
}

[JsonSerializable(typeof(QueryResult))]
[JsonSerializable(typeof(MultiResult))]
[JsonSerializable(typeof(ErrorResult))]
[JsonSerializable(typeof(List<QueryResult>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AppJsonContext : JsonSerializerContext { }