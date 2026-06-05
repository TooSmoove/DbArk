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

public static class FileQueryEngineLib
{
    // ---- DuckDB P/Invoke (v1.5.0 — IntPtr-based API) ----------
    private const string DuckDbDll = "duckdb.dll";
    private const int DUCKDB_RESULT_SIZE = 64;
    private const int DUCKDB_SUCCESS = 0;

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int duckdb_open(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? path,
        out IntPtr db);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_close(ref IntPtr db);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int duckdb_connect(IntPtr db, out IntPtr conn);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_disconnect(ref IntPtr conn);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int duckdb_query(
        IntPtr conn,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        IntPtr result);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_destroy_result(IntPtr result);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern long duckdb_column_count(IntPtr result);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern long duckdb_row_count(IntPtr result);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr duckdb_column_name(IntPtr result, long col);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr duckdb_value_varchar(IntPtr result, long col, long row);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern byte duckdb_value_is_null(IntPtr result, long col, long row);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr duckdb_result_error(IntPtr result);

    [DllImport(DuckDbDll, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_free(IntPtr ptr);

    // ---- DuckDB query helpers ---------------------------------

    /// <summary>Run a setup query (CREATE VIEW etc). Returns null on success or an error message.</summary>
    private static string? RunSetupQuery(IntPtr conn, string sql)
    {
        IntPtr resultBuf = Marshal.AllocHGlobal(DUCKDB_RESULT_SIZE);
        try
        {
            for (int i = 0; i < DUCKDB_RESULT_SIZE; i++)
                Marshal.WriteByte(resultBuf, i, 0);

            int rc = duckdb_query(conn, sql, resultBuf);
            if (rc != DUCKDB_SUCCESS)
            {
                IntPtr errPtr = duckdb_result_error(resultBuf);
                string err = errPtr != IntPtr.Zero
                    ? Marshal.PtrToStringUTF8(errPtr) ?? "Setup query failed"
                    : "Setup query failed";
                duckdb_destroy_result(resultBuf);
                return err;
            }
            duckdb_destroy_result(resultBuf);
            return null;
        }
        finally
        {
            Marshal.FreeHGlobal(resultBuf);
        }
    }

    /// <summary>Run a data query, serialise results, return JSON IntPtr.</summary>
    private static IntPtr RunDataQuery(IntPtr conn, string sql)
    {
        IntPtr resultBuf = Marshal.AllocHGlobal(DUCKDB_RESULT_SIZE);
        try
        {
            for (int i = 0; i < DUCKDB_RESULT_SIZE; i++)
                Marshal.WriteByte(resultBuf, i, 0);

            int rc = duckdb_query(conn, sql, resultBuf);
            if (rc != DUCKDB_SUCCESS)
            {
                IntPtr errPtr = duckdb_result_error(resultBuf);
                string errMsg = errPtr != IntPtr.Zero
                    ? Marshal.PtrToStringUTF8(errPtr) ?? "Query failed"
                    : "Query failed";
                duckdb_destroy_result(resultBuf);
                return Error(errMsg);
            }

            IntPtr serialised = SerialiseResult(resultBuf);
            duckdb_destroy_result(resultBuf);
            return serialised;
        }
        finally
        {
            Marshal.FreeHGlobal(resultBuf);
        }
    }

    // ---- Exported: query a flat file -------------------------

    [UnmanagedCallersOnly(EntryPoint = "query_file")]
    public static IntPtr QueryFile(IntPtr filePathPtr, IntPtr sqlPtr)
    {
        try
        {
            string? filePath = Marshal.PtrToStringUTF8(filePathPtr);
            string? sql = Marshal.PtrToStringUTF8(sqlPtr);

            if (string.IsNullOrEmpty(filePath)) return Error("No file path provided");
            if (string.IsNullOrEmpty(sql)) return Error("No SQL provided");
            if (!File.Exists(filePath)) return Error($"File not found: {filePath}");

            int rc = duckdb_open(null, out IntPtr db);
            if (rc != DUCKDB_SUCCESS) return Error("Failed to open DuckDB");

            try
            {
                rc = duckdb_connect(db, out IntPtr conn);
                if (rc != DUCKDB_SUCCESS) return Error("Failed to connect to DuckDB");

                try
                {
                    string normPath = filePath.Replace("\\", "/");
                    string ext = Path.GetExtension(filePath).ToLowerInvariant();

                    string viewSql = ext switch
                    {
                        ".csv" => $"CREATE OR REPLACE VIEW data AS SELECT * FROM read_csv_auto('{normPath}')",
                        ".json" => $"CREATE OR REPLACE VIEW data AS SELECT * FROM read_json_auto('{normPath}')",
                        _ => $"CREATE OR REPLACE VIEW data AS SELECT * FROM '{normPath}'"
                    };

                    string? setupErr = RunSetupQuery(conn, viewSql);
                    if (setupErr != null) return Error($"Failed to register file: {setupErr}");

                    return RunDataQuery(conn, sql);
                }
                finally { duckdb_disconnect(ref conn); }
            }
            finally { duckdb_close(ref db); }
        }
        catch (Exception ex) { return Error($"Exception: {ex.Message}"); }
    }

    // ---- Exported: get schema of a flat file -----------------

    [UnmanagedCallersOnly(EntryPoint = "get_file_schema")]
    public static IntPtr GetFileSchema(IntPtr filePathPtr)
    {
        try
        {
            string? filePath = Marshal.PtrToStringUTF8(filePathPtr);
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
                return Error("File not found");

            string normPath = filePath.Replace("\\", "/");
            string ext = Path.GetExtension(filePath).ToLowerInvariant();

            string sql = ext switch
            {
                ".csv" => $"DESCRIBE SELECT * FROM read_csv_auto('{normPath}')",
                ".json" => $"DESCRIBE SELECT * FROM read_json_auto('{normPath}')",
                _ => $"DESCRIBE SELECT * FROM '{normPath}'"
            };

            int rc = duckdb_open(null, out IntPtr db);
            if (rc != DUCKDB_SUCCESS) return Error("Failed to open DuckDB");

            try
            {
                rc = duckdb_connect(db, out IntPtr conn);
                if (rc != DUCKDB_SUCCESS) return Error("Failed to connect");
                try { return RunDataQuery(conn, sql); }
                finally { duckdb_disconnect(ref conn); }
            }
            finally { duckdb_close(ref db); }
        }
        catch (Exception ex) { return Error(ex.Message); }
    }

    // ---- Exported: list tables from a live DB connection -----

    [UnmanagedCallersOnly(EntryPoint = "ListTables")]
    public static IntPtr ListTables(IntPtr connectionStringPtr, IntPtr enginePtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";

            var sql = engine.ToLower() switch
            {
                "mysql" or "mariadb" => "SHOW TABLES",
                "postgres" or "cockroachdb" => "SELECT tablename AS table_name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
                "sqlite" => "SELECT name AS table_name FROM sqlite_master WHERE type='table' ORDER BY name",
                "sqlserver" => "SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
                _ => throw new Exception($"Unsupported engine: {engine}")
            };

            var jsonResult = ExecuteDbQuery(connectionString, engine, sql);
            var doc = JsonDocument.Parse(jsonResult);
            if (doc.RootElement.TryGetProperty("error", out var err))
                return Marshal.StringToCoTaskMemUTF8($"{{\"error\":{JsonEscapeString(err.GetString() ?? "")}}}");

            var tables = new List<string>();
            foreach (var row in doc.RootElement.GetProperty("rows").EnumerateArray())
            {
                var first = row.EnumerateArray().FirstOrDefault();
                if (first.ValueKind == JsonValueKind.String)
                    tables.Add(first.GetString()!);
            }

            var json = JsonSerializer.Serialize(
                new TableListResult { Tables = tables },
                FileQueryJsonContext.Default.TableListResult);
            return Marshal.StringToCoTaskMemUTF8(json);
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"{{\"error\":{JsonEscapeString(ex.Message)}}}");
        }
    }

    // ---- Exported: query file joined with live DB tables -----

    [UnmanagedCallersOnly(EntryPoint = "QueryFileWithDb")]
    public static IntPtr QueryFileWithDb(
        IntPtr filePathPtr,
        IntPtr sqlPtr,
        IntPtr connectionStringPtr,
        IntPtr enginePtr,
        IntPtr tableNamesPtr)   // comma-separated: "customers,orders"
    {
        try
        {
            var filePath = Marshal.PtrToStringUTF8(filePathPtr) ?? "";
            var sql = Marshal.PtrToStringUTF8(sqlPtr) ?? "";
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";
            var tableNamesRaw = Marshal.PtrToStringUTF8(tableNamesPtr) ?? "";

            var tableNames = tableNamesRaw
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(t => System.Text.RegularExpressions.Regex.IsMatch(t, @"^[a-zA-Z_][a-zA-Z0-9_]*$"))
                .ToList();

            if (!File.Exists(filePath)) return Error($"File not found: {filePath}");

            int rc = duckdb_open(null, out IntPtr db);
            if (rc != DUCKDB_SUCCESS) return Error("Failed to open DuckDB");

            try
            {
                rc = duckdb_connect(db, out IntPtr conn);
                if (rc != DUCKDB_SUCCESS) return Error("Failed to connect to DuckDB");

                try
                {
                    // Register file as "data" view
                    string normPath = filePath.Replace("\\", "/");
                    string ext = Path.GetExtension(filePath).ToLowerInvariant();
                    string viewSql = ext switch
                    {
                        ".csv" => $"CREATE OR REPLACE VIEW data AS SELECT * FROM read_csv_auto('{normPath}')",
                        ".json" => $"CREATE OR REPLACE VIEW data AS SELECT * FROM read_json_auto('{normPath}')",
                        _ => $"CREATE OR REPLACE VIEW data AS SELECT * FROM '{normPath}'"
                    };

                    string? setupErr = RunSetupQuery(conn, viewSql);
                    if (setupErr != null) return Error($"Failed to register file: {setupErr}");

                    // Pull each checked table from the live DB and register in DuckDB
                    foreach (var tableName in tableNames)
                    {
                        var fetchSql = $"SELECT * FROM {tableName}";
                        var jsonResult = ExecuteDbQuery(connectionString, engine, fetchSql);
                        var rows = ParseJsonRows(jsonResult);
                        if (rows != null && rows.Count > 0)
                            RegisterTableInDuckDb(conn, $"db_{tableName}", rows);
                    }

                    return RunDataQuery(conn, sql);
                }
                finally { duckdb_disconnect(ref conn); }
            }
            finally { duckdb_close(ref db); }
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"{{\"error\":{JsonEscapeString(ex.Message)}}}");
        }
    }

    // ---- DB execution helpers --------------------------------

    private static string ExecuteDbQuery(string connectionString, string engine, string sql)
    {
        return engine.ToLower() switch
        {
            "mysql" or "mariadb" => ExecuteMySql(connectionString, sql),
            "postgres" or "cockroachdb" => ExecutePostgres(connectionString, sql),
            "sqlite" => ExecuteSqliteDb(connectionString, sql),
            "sqlserver" => ExecuteSqlServer(connectionString, sql),
            _ => throw new Exception($"Unsupported engine: {engine}")
        };
    }

    private static string ExecuteMySql(string connectionString, string sql)
    {
        using var conn = new MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var reader = cmd.ExecuteReader();
        return ReaderToJson(reader);
    }

    private static string ExecutePostgres(string connectionString, string sql)
    {
        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var reader = cmd.ExecuteReader();
        return ReaderToJson(reader);
    }

    // SQL Server goes through ODBC: the connection string DevSql builds for the
    // sqlserver engine is an ODBC string (Driver={ODBC Driver 18 for SQL Server};...),
    // which SqlConnection cannot parse — OdbcConnection accepts it directly and
    // matches the rest of the app's SQL Server path. Requires the System.Data.Odbc
    // package reference in this project's .csproj.
    private static string ExecuteSqlServer(string connectionString, string sql)
    {
        using var conn = new System.Data.Odbc.OdbcConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        using var reader = cmd.ExecuteReader();
        return ReaderToJson(reader);
    }

    private static string ExecuteSqliteDb(string connectionString, string sql)
    {
        string path = connectionString;
        if (connectionString.StartsWith("Data Source=", StringComparison.OrdinalIgnoreCase))
            path = connectionString["Data Source=".Length..].Trim();

        IntPtr db = IntPtr.Zero;
        SqliteOpen(path, ref db);
        try
        {
            IntPtr stmt = IntPtr.Zero;
            SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero);
            try
            {
                int colCount = SqliteColumnCount(stmt);
                var columns = new List<string>();
                for (int i = 0; i < colCount; i++)
                    columns.Add(Marshal.PtrToStringUTF8(SqliteColumnName(stmt, i)) ?? $"col{i}");

                var rows = new List<List<string?>>();
                while (SqliteStep(stmt) == 100) // SQLITE_ROW
                {
                    var row = new List<string?>();
                    for (int i = 0; i < colCount; i++)
                    {
                        int colType = SqliteColumnType(stmt, i);
                        row.Add(colType == 5 ? null
                            : Marshal.PtrToStringUTF8(SqliteColumnText(stmt, i)));
                    }
                    rows.Add(row);
                    if (rows.Count >= 1000) break;
                }

                var result = new DbQueryResult { columns = columns, rows = rows };
                return JsonSerializer.Serialize(result, FileQueryJsonContext.Default.DbQueryResult);
            }
            finally { SqliteFinalize(stmt); }
        }
        finally { SqliteClose(db); }
    }

    private static string ReaderToJson(System.Data.IDataReader reader)
    {
        var columns = new List<string>();
        for (int i = 0; i < reader.FieldCount; i++)
            columns.Add(reader.GetName(i));

        var rows = new List<List<string?>>();
        int rowCount = 0;
        while (reader.Read() && rowCount < 1000)
        {
            var row = new List<string?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row.Add(reader.IsDBNull(i) ? null : reader.GetValue(i)?.ToString());
            rows.Add(row);
            rowCount++;
        }

        var result = new DbQueryResult { columns = columns, rows = rows };
        return JsonSerializer.Serialize(result, FileQueryJsonContext.Default.DbQueryResult);
    }

    // ---- DuckDB in-memory table registration -----------------

    private static List<Dictionary<string, string?>>? ParseJsonRows(string jsonResult)
    {
        var doc = JsonDocument.Parse(jsonResult);
        if (doc.RootElement.TryGetProperty("error", out _)) return null;

        var columns = doc.RootElement.GetProperty("columns")
            .EnumerateArray().Select(c => c.GetString()!).ToList();

        var rows = new List<Dictionary<string, string?>>();
        foreach (var row in doc.RootElement.GetProperty("rows").EnumerateArray())
        {
            var dict = new Dictionary<string, string?>();
            var vals = row.EnumerateArray().ToList();
            for (int i = 0; i < columns.Count && i < vals.Count; i++)
                dict[columns[i]] = vals[i].ValueKind == JsonValueKind.Null
                    ? null
                    : vals[i].GetString() ?? vals[i].ToString();
            rows.Add(dict);
        }
        return rows;
    }

    private static void RegisterTableInDuckDb(
        IntPtr conn, string duckTableName, List<Dictionary<string, string?>> rows)
    {
        if (rows.Count == 0) return;
        var columns = rows[0].Keys.ToList();
        var colDefs = string.Join(", ", columns.Select(c => $"\"{c}\" TEXT"));
        RunSetupQuery(conn, $"CREATE TABLE \"{duckTableName}\" ({colDefs})");

        const int batchSize = 500;
        for (int i = 0; i < rows.Count; i += batchSize)
        {
            var batch = rows.Skip(i).Take(batchSize);
            var values = batch.Select(row =>
            {
                var vals = columns.Select(c =>
                {
                    var v = row.TryGetValue(c, out var val) ? val : null;
                    return v == null ? "NULL" : $"'{v.Replace("'", "''")}'";
                });
                return $"({string.Join(", ", vals)})";
            });
            RunSetupQuery(conn, $"INSERT INTO \"{duckTableName}\" VALUES {string.Join(",\n", values)}");
        }
    }

    // ---- DuckDB result serialiser ----------------------------

    private static IntPtr SerialiseResult(IntPtr resultBuf)
    {
        long colCount = duckdb_column_count(resultBuf);
        long rowCount = duckdb_row_count(resultBuf);
        int rowLimit = 1000;

        var columns = new List<string>();
        for (long c = 0; c < colCount; c++)
        {
            IntPtr namePtr = duckdb_column_name(resultBuf, c);
            columns.Add(namePtr != IntPtr.Zero
                ? Marshal.PtrToStringUTF8(namePtr) ?? $"col{c}"
                : $"col{c}");
        }

        var rows = new List<List<string?>>();
        long limit = Math.Min(rowCount, rowLimit);

        for (long r = 0; r < limit; r++)
        {
            var row = new List<string?>();
            for (long c = 0; c < colCount; c++)
            {
                byte isNull = duckdb_value_is_null(resultBuf, c, r);
                if (isNull != 0)
                {
                    row.Add(null);
                }
                else
                {
                    IntPtr valPtr = duckdb_value_varchar(resultBuf, c, r);
                    if (valPtr == IntPtr.Zero)
                    {
                        row.Add(null);
                    }
                    else
                    {
                        string? val = Marshal.PtrToStringUTF8(valPtr);
                        duckdb_free(valPtr);
                        row.Add(val);
                    }
                }
            }
            rows.Add(row);
        }

        var queryResult = new FileQueryResult
        {
            Columns = columns,
            Rows = rows,
            RowCount = (int)limit,
            TotalRows = (int)rowCount
        };

        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(queryResult,
                FileQueryJsonContext.Default.FileQueryResult));
    }

    private static IntPtr Error(string message)
    {
        var err = new FileQueryError { error = message };
        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(err, FileQueryJsonContext.Default.FileQueryError));
    }

    // ---- JSON string helper (avoids reflection-based JsonSerializer for plain strings) --

    /// <summary>
    /// Returns a JSON-encoded quoted string without using reflection-based JsonSerializer.
    /// Safe to call from NativeAOT — no type metadata required.
    /// </summary>
    private static string JsonEscapeString(string s) =>
        "\"" + s
            .Replace("\\", "\\\\")
            .Replace("\"", "\\\"")
            .Replace("\n", "\\n")
            .Replace("\r", "\\r")
            .Replace("\t", "\\t")
        + "\"";

    // ---- winsqlite3.dll P/Invoke (ships with Windows 10/11) --
    private const string SqliteDll = "winsqlite3.dll";
    [DllImport(SqliteDll, EntryPoint = "sqlite3_open")]
    private static extern int SqliteOpen([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, ref IntPtr db);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_close")]
    private static extern int SqliteClose(IntPtr db);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_prepare_v2")]
    private static extern int SqlitePrepareV2(IntPtr db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int nByte, ref IntPtr stmt, IntPtr pzTail);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_step")]
    private static extern int SqliteStep(IntPtr stmt);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_finalize")]
    private static extern int SqliteFinalize(IntPtr stmt);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_count")]
    private static extern int SqliteColumnCount(IntPtr stmt);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_name")]
    private static extern IntPtr SqliteColumnName(IntPtr stmt, int col);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_text")]
    private static extern IntPtr SqliteColumnText(IntPtr stmt, int col);
    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_type")]
    private static extern int SqliteColumnType(IntPtr stmt, int col);
}

// ---- Model classes ----------------------------------------

public class FileQueryResult
{
    public List<string> Columns { get; set; } = new();
    public List<List<string?>> Rows { get; set; } = new();
    public int RowCount { get; set; }
    public int TotalRows { get; set; }
}

public class FileQueryError
{
    public string error { get; set; } = "";
}

public class DbQueryResult
{
    public List<string> columns { get; set; } = new();
    public List<List<string?>> rows { get; set; } = new();
}

public class TableListResult
{
    public List<string> Tables { get; set; } = new();
}

[JsonSerializable(typeof(FileQueryResult))]
[JsonSerializable(typeof(FileQueryError))]
[JsonSerializable(typeof(DbQueryResult))]
[JsonSerializable(typeof(TableListResult))]
[JsonSerializable(typeof(List<string>))]
[JsonSerializable(typeof(List<List<string?>>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class FileQueryJsonContext : JsonSerializerContext { }