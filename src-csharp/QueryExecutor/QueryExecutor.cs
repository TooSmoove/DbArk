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
    IntPtr enginePtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            string? sql = Marshal.PtrToStringUTF8(sqlPtr);
            string? engine = Marshal.PtrToStringUTF8(enginePtr);

            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("{\"error\":\"Empty connection string\"}");
            if (string.IsNullOrEmpty(sql))
                return Marshal.StringToCoTaskMemUTF8("{\"error\":\"Empty SQL\"}");

            // Split on semicolons, filter out empty statements
            var statements = sql
                .Split(';')
                .Select(s => s.Trim())
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .ToList();

            if (statements.Count == 0)
                return Marshal.StringToCoTaskMemUTF8("{\"error\":\"No statements found\"}");

            // Execute all but the last statement — discard their results
            foreach (var stmt in statements.SkipLast(1))
            {
                try
                {
                    _ = engine?.ToLower() switch
                    {
                        "postgres" => ExecutePostgres(connectionString, stmt),
                        "sqlite" => ExecuteSqlite(connectionString, stmt),
                        _ => ExecuteMySql(connectionString, stmt),
                    };
                }
                catch
                {
                    // If a non-final statement fails, keep going
                    // (matches behaviour of most DB clients)
                }
            }

            // Execute the last statement and return its results
            var lastStatement = statements.Last();
            return engine?.ToLower() switch
            {
                "postgres" => ExecutePostgres(connectionString, lastStatement),
                "sqlite" => ExecuteSqlite(connectionString, lastStatement),
                _ => ExecuteMySql(connectionString, lastStatement),
            };
        }
        catch (Exception ex)
        {
            var errorResult = new ErrorResult { error = ex.Message };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(errorResult, AppJsonContext.Default.ErrorResult));
        }
    }

    private static IntPtr ExecuteMySql(string connectionString, string sql)
    {
        using var conn = new MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var reader = cmd.ExecuteReader();
        return SerialiseReader(reader);
    }

    private static IntPtr ExecutePostgres(string connectionString, string sql)
    {
        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var reader = cmd.ExecuteReader();
        return SerialiseReader(reader);
    }

    private static IntPtr SerialiseReader(System.Data.IDataReader reader)
    {
        var columns = new List<string>();
        for (int i = 0; i < reader.FieldCount; i++)
            columns.Add(reader.GetName(i));

        var rows = new List<List<string?>>();
        int rowLimit = 1000;
        int rowCount = 0;

        while (reader.Read() && rowCount < rowLimit)
        {
            var row = new List<string?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row.Add(reader.IsDBNull(i)
                    ? null
                    : reader.GetValue(i)?.ToString());
            rows.Add(row);
            rowCount++;
        }

        var result = new QueryResult
        {
            Columns = columns,
            Rows = rows,
            RowCount = rowCount
        };

        string json = JsonSerializer.Serialize(
            result, AppJsonContext.Default.QueryResult);
        return Marshal.StringToCoTaskMemUTF8(json);
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
            int rowLimit = 1000;

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
}

public class QueryResult
{
    public List<string> Columns { get; set; } = new();
    public List<List<string?>> Rows { get; set; } = new();
    public int RowCount { get; set; }
}

public class ErrorResult
{
    public string error { get; set; } = "";
}

[JsonSerializable(typeof(QueryResult))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(List<List<string?>>))]
[JsonSerializable(typeof(ErrorResult))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AppJsonContext : JsonSerializerContext { }