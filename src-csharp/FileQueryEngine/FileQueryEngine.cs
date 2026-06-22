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

    // Row caps. Both were a silent hardcoded 1000 (audit C-5).
    //  - LiveTableRowCap bounds how many rows we pull from a live DB table to stage for
    //    a join. The old 1000 silently truncated larger tables, so the join saw a partial
    //    table and produced wrong/incomplete results with no signal. Raised here and the
    //    truncation is now surfaced as a warning on the result.
    //  - ResultRowCap bounds how many rows we serialise back to the UI grid (which
    //    virtualises ~10k). TotalRows already reports the true count; Truncated now makes
    //    the cut explicit.
    private const int LiveTableRowCap = 50_000;
    private const int ResultRowCap = 10_000;

    // Resolve duckdb.dll from the app's natives\ folder regardless of the process
    // working directory. Bare-name DllImport searches the exe dir + PATH but NOT the
    // natives\ subfolder, so an installed app (CWD = System32) failed to load it.
    // SetDllImportResolver fixes all duckdb.dll imports in one place — no per-import
    // change, and removes the copy-beside-exe workaround.
    static FileQueryEngineLib()
    {
        NativeLibrary.SetDllImportResolver(
            typeof(FileQueryEngineLib).Assembly,
            (libraryName, assembly, searchPath) =>
            {
                if (!libraryName.Equals(DuckDbDll, StringComparison.OrdinalIgnoreCase))
                    return IntPtr.Zero; // not ours — let the default resolver handle it

                // The DLLs live in <assembly dir>\natives\ in every build target.
                var asmDir = System.IO.Path.GetDirectoryName(AppContext.BaseDirectory) ?? "";
                var candidate = System.IO.Path.Combine(asmDir, "natives", DuckDbDll);
                if (System.IO.File.Exists(candidate) &&
                    NativeLibrary.TryLoad(candidate, out var handle))
                    return handle;

                // Fall back to the default search (e.g. DLL sitting beside the exe in dev).
                return NativeLibrary.TryLoad(DuckDbDll, assembly, searchPath, out var fallback)
                    ? fallback : IntPtr.Zero;
            });
    }

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
    private static IntPtr RunDataQuery(IntPtr conn, string sql, List<string>? warnings = null)
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

            IntPtr serialised = SerialiseResult(resultBuf, warnings);
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

                    // Path is single-quote-escaped via DuckDbFileScan (audit H-1).
                    string viewSql = $"CREATE OR REPLACE VIEW data AS SELECT * FROM {DuckDbFileScan.ScanExpr(ext, normPath)}";

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

            // Path is single-quote-escaped via DuckDbFileScan (audit H-1).
            string sql = $"DESCRIBE SELECT * FROM {DuckDbFileScan.ScanExpr(ext, normPath)}";

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
                    // Path is single-quote-escaped via DuckDbFileScan (audit H-1).
                    string viewSql = $"CREATE OR REPLACE VIEW data AS SELECT * FROM {DuckDbFileScan.ScanExpr(ext, normPath)}";

                    string? setupErr = RunSetupQuery(conn, viewSql);
                    if (setupErr != null) return Error($"Failed to register file: {setupErr}");

                    // Pull each checked table from the live DB and register it in DuckDB
                    // WITH ITS REAL COLUMN TYPES (audit C-5), so joins/comparisons against
                    // the file side use numeric/date semantics instead of text.
                    var warnings = new List<string>();
                    foreach (var tableName in tableNames)
                    {
                        var fetchSql = $"SELECT * FROM {tableName}";
                        var jsonResult = ExecuteDbQuery(connectionString, engine, fetchSql);
                        var live = ParseLiveTable(jsonResult);
                        if (live != null && live.Rows.Count > 0)
                        {
                            RegisterTableInDuckDb(conn, $"db_{tableName}", live);
                            if (live.Truncated)
                                warnings.Add(
                                    $"Live table '{tableName}' was truncated to {LiveTableRowCap:N0} rows; " +
                                    "join results may be incomplete.");
                        }
                    }

                    return RunDataQuery(conn, sql, warnings);
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

    // SQL Server goes through ODBC: the connection string DbArk builds for the
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

                // SQLite is dynamically typed: the storage class is per-value, not per-column.
                // Infer each column's DuckDB type from the first non-NULL value we see; default
                // VARCHAR. Storage classes: 1=INTEGER, 2=FLOAT, 3=TEXT, 4=BLOB, 5=NULL. BLOB is
                // read here via column_text, so it is staged as VARCHAR.
                var duckTypes = new DuckDbTableBuilder.DuckType?[colCount];

                var rows = new List<List<string?>>();
                bool truncated = false;
                while (SqliteStep(stmt) == 100) // SQLITE_ROW
                {
                    if (rows.Count >= LiveTableRowCap) { truncated = true; break; }
                    var row = new List<string?>();
                    for (int i = 0; i < colCount; i++)
                    {
                        int colType = SqliteColumnType(stmt, i);
                        if (colType == 5) { row.Add(null); continue; } // SQLITE_NULL
                        duckTypes[i] ??= colType switch
                        {
                            1 => DuckDbTableBuilder.DuckType.Bigint,
                            2 => DuckDbTableBuilder.DuckType.Double,
                            _ => DuckDbTableBuilder.DuckType.Varchar,
                        };
                        row.Add(Marshal.PtrToStringUTF8(SqliteColumnText(stmt, i)));
                    }
                    rows.Add(row);
                }

                var types = duckTypes
                    .Select(t => DuckDbTableBuilder.TypeName(t ?? DuckDbTableBuilder.DuckType.Varchar))
                    .ToList();

                var result = new DbQueryResult { columns = columns, types = types, rows = rows, truncated = truncated };
                return JsonSerializer.Serialize(result, FileQueryJsonContext.Default.DbQueryResult);
            }
            finally { SqliteFinalize(stmt); }
        }
        finally { SqliteClose(db); }
    }

    private static Type? SafeFieldType(System.Data.IDataReader reader, int i)
    {
        // Some providers throw GetFieldType for certain columns; VARCHAR is a safe default.
        try { return reader.GetFieldType(i); } catch { return null; }
    }

    private static string ReaderToJson(System.Data.IDataReader reader)
    {
        var columns = new List<string>();
        var types = new List<string>();
        for (int i = 0; i < reader.FieldCount; i++)
        {
            columns.Add(reader.GetName(i));
            types.Add(DuckDbTableBuilder.TypeName(
                DuckDbTableBuilder.MapClrType(SafeFieldType(reader, i))));
        }

        var rows = new List<List<string?>>();
        bool truncated = false;
        while (reader.Read())
        {
            if (rows.Count >= LiveTableRowCap) { truncated = true; break; }
            var row = new List<string?>();
            for (int i = 0; i < reader.FieldCount; i++)
                row.Add(reader.IsDBNull(i) ? null : DuckDbTableBuilder.FormatClrValue(reader.GetValue(i)));
            rows.Add(row);
        }

        var result = new DbQueryResult { columns = columns, types = types, rows = rows, truncated = truncated };
        return JsonSerializer.Serialize(result, FileQueryJsonContext.Default.DbQueryResult);
    }

    // ---- DuckDB in-memory table registration -----------------

    /// <summary>A live-DB table staged for a join, with its real per-column DuckDB types.</summary>
    private sealed class LiveTable
    {
        public List<string> Columns = new();
        public List<DuckDbTableBuilder.DuckType> Types = new();
        public List<List<string?>> Rows = new();
        public bool Truncated;
    }

    /// <summary>
    /// Parses the intermediate <see cref="DbQueryResult"/> JSON (produced by the engine
    /// readers) into a typed <see cref="LiveTable"/>. Returns null if the JSON carries an
    /// error. The "types" array carries the DuckDB column types so the staged table is built
    /// correctly typed (audit C-5) rather than all-TEXT.
    /// </summary>
    private static LiveTable? ParseLiveTable(string jsonResult)
    {
        var doc = JsonDocument.Parse(jsonResult);
        if (doc.RootElement.TryGetProperty("error", out _)) return null;

        var lt = new LiveTable
        {
            Columns = doc.RootElement.GetProperty("columns")
                .EnumerateArray().Select(c => c.GetString()!).ToList()
        };

        if (doc.RootElement.TryGetProperty("types", out var typesEl))
            lt.Types = typesEl.EnumerateArray()
                .Select(t => DuckDbTableBuilder.TypeFromName(t.GetString())).ToList();
        // Pad/guard so Types is always at least as long as Columns.
        while (lt.Types.Count < lt.Columns.Count)
            lt.Types.Add(DuckDbTableBuilder.DuckType.Varchar);

        if (doc.RootElement.TryGetProperty("truncated", out var trEl) && trEl.ValueKind == JsonValueKind.True)
            lt.Truncated = true;

        foreach (var row in doc.RootElement.GetProperty("rows").EnumerateArray())
        {
            var vals = new List<string?>();
            foreach (var v in row.EnumerateArray())
                vals.Add(v.ValueKind == JsonValueKind.Null ? null : (v.GetString() ?? v.ToString()));
            lt.Rows.Add(vals);
        }
        return lt;
    }

    private static void RegisterTableInDuckDb(IntPtr conn, string duckTableName, LiveTable table)
    {
        if (table.Rows.Count == 0) return;

        RunSetupQuery(conn,
            DuckDbTableBuilder.BuildCreateTable(duckTableName, table.Columns, table.Types));

        const int batchSize = 500;
        for (int i = 0; i < table.Rows.Count; i += batchSize)
        {
            var batch = table.Rows.Skip(i).Take(batchSize);
            RunSetupQuery(conn,
                DuckDbTableBuilder.BuildInsert(duckTableName, table.Columns, table.Types, batch));
        }
    }

    // ---- DuckDB result serialiser ----------------------------

    private static IntPtr SerialiseResult(IntPtr resultBuf, List<string>? warnings = null)
    {
        long colCount = duckdb_column_count(resultBuf);
        long rowCount = duckdb_row_count(resultBuf);
        int rowLimit = ResultRowCap;

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

        bool truncated = rowCount > rowLimit;
        var allWarnings = warnings ?? new List<string>();
        if (truncated)
            allWarnings.Add($"Result truncated to {rowLimit:N0} of {rowCount:N0} rows.");

        var queryResult = new FileQueryResult
        {
            Columns = columns,
            Rows = rows,
            RowCount = (int)limit,
            TotalRows = (int)rowCount,
            Truncated = truncated || allWarnings.Count > 0,
            Warnings = allWarnings
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
    // True when results were capped or a joined live table was truncated (audit C-5):
    // the UI can show Warnings instead of silently presenting a partial result.
    public bool Truncated { get; set; }
    public List<string> Warnings { get; set; } = new();
}

public class FileQueryError
{
    public string error { get; set; } = "";
}

public class DbQueryResult
{
    public List<string> columns { get; set; } = new();
    // DuckDB type keyword per column (BIGINT/DOUBLE/DATE/…), used to stage the live
    // table with real types so joins/comparisons don't degrade to text (audit C-5).
    public List<string> types { get; set; } = new();
    public List<List<string?>> rows { get; set; } = new();
    public bool truncated { get; set; }
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