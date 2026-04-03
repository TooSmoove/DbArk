#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

public class HistoryEntry
{
    public long Id { get; set; }
    public string ConnectionId { get; set; } = "";
    public string ConnectionName { get; set; } = "";
    public string Sql { get; set; } = "";
    public long ExecutedAt { get; set; } // Unix timestamp ms
    public int DurationMs { get; set; }
    public int RowCount { get; set; }
    public bool Success { get; set; }
}

public class HistoryResult
{
    public List<HistoryEntry> Entries { get; set; } = new();
    public string? Error { get; set; }
}

[JsonSerializable(typeof(HistoryEntry))]
[JsonSerializable(typeof(HistoryResult))]
[JsonSerializable(typeof(List<HistoryEntry>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class HistoryJsonContext : JsonSerializerContext { }

public static class QueryHistoryLib
{
    private static string GetDbPath()
    {
        string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        string dir = Path.Combine(home, ".devsql");
        if (!Directory.Exists(dir)) Directory.CreateDirectory(dir);
        return Path.Combine(dir, "state.db");
    }

    private static void EnsureTable(IntPtr db)
    {
        string sql = """
            CREATE TABLE IF NOT EXISTS query_history (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                connection_id   TEXT NOT NULL,
                connection_name TEXT NOT NULL,
                sql             TEXT NOT NULL,
                executed_at     INTEGER NOT NULL,
                duration_ms     INTEGER NOT NULL DEFAULT 0,
                row_count       INTEGER NOT NULL DEFAULT 0,
                success         INTEGER NOT NULL DEFAULT 1
            )
            """;
        IntPtr stmt = IntPtr.Zero;
        SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero);
        SqliteStep(stmt);
        SqliteFinalize(stmt);
    }

    [UnmanagedCallersOnly(EntryPoint = "add_history_entry")]
    public static int AddHistoryEntry(IntPtr jsonPtr)
    {
        try
        {
            var json = Marshal.PtrToStringUTF8(jsonPtr) ?? "";
            var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            var connectionId = root.GetProperty("connectionId").GetString() ?? "";
            var connectionName = root.GetProperty("connectionName").GetString() ?? "";
            var sql = root.GetProperty("sql").GetString() ?? "";
            var executedAt = root.GetProperty("executedAt").GetInt64();
            var durationMs = root.GetProperty("durationMs").GetInt32();
            var rowCount = root.GetProperty("rowCount").GetInt32();
            var success = root.GetProperty("success").GetBoolean() ? 1 : 0;

            string Escape(string s) => s.Replace("'", "''");

            string dbPath = GetDbPath();
            IntPtr db = IntPtr.Zero;
            SqliteOpen(dbPath, ref db);

            try
            {
                IntPtr createStmt = IntPtr.Zero;
                SqlitePrepareV2(db, @"
                CREATE TABLE IF NOT EXISTS query_history (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    connection_id   TEXT NOT NULL DEFAULT '',
                    connection_name TEXT NOT NULL DEFAULT '',
                    sql             TEXT NOT NULL DEFAULT '',
                    executed_at     INTEGER NOT NULL DEFAULT 0,
                    duration_ms     INTEGER NOT NULL DEFAULT 0,
                    row_count       INTEGER NOT NULL DEFAULT 0,
                    success         INTEGER NOT NULL DEFAULT 1
                )", -1, ref createStmt, IntPtr.Zero);
                SqliteStep(createStmt);
                SqliteFinalize(createStmt);

                string insertSql = $@"
                INSERT INTO query_history
                    (connection_id, connection_name, sql, executed_at, duration_ms, row_count, success)
                VALUES (
                    '{Escape(connectionId)}',
                    '{Escape(connectionName)}',
                    '{Escape(sql)}',
                    {executedAt},
                    {durationMs},
                    {rowCount},
                    {success}
                )";

                IntPtr insertStmt = IntPtr.Zero;
                SqlitePrepareV2(db, insertSql, -1, ref insertStmt, IntPtr.Zero);
                int rc = SqliteStep(insertStmt);
                SqliteFinalize(insertStmt);
                return rc == 101 ? 1 : 0;
            }
            finally { SqliteClose(db); }
        }
        catch { return 0; }
    }

    [UnmanagedCallersOnly(EntryPoint = "get_history")]
    public static IntPtr GetHistory(IntPtr connectionIdPtr, int limit)
    {
        try
        {
            var connectionId = Marshal.PtrToStringUTF8(connectionIdPtr) ?? "";

            File.AppendAllText(
          Path.Combine(Environment.GetFolderPath(
              Environment.SpecialFolder.UserProfile), ".devsql", "debug.log"),
          $"GetHistory called: connectionId='{connectionId}', limit={limit}\n");

            string dbPath = GetDbPath();

            IntPtr db = IntPtr.Zero;
            SqliteOpen(dbPath, ref db);

            try
            {
                EnsureTable(db);

                string sql = string.IsNullOrEmpty(connectionId)
                    ? $"SELECT id, connection_id, connection_name, sql, executed_at, duration_ms, row_count, success FROM query_history ORDER BY executed_at DESC LIMIT {limit}"
                    : $"SELECT id, connection_id, connection_name, sql, executed_at, duration_ms, row_count, success FROM query_history WHERE connection_id = ? ORDER BY executed_at DESC LIMIT {limit}";

                IntPtr stmt = IntPtr.Zero;
                SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero);

                if (!string.IsNullOrEmpty(connectionId))
                    SqliteBindText(stmt, 1, connectionId, -1, IntPtr.Zero);

                var entries = new List<HistoryEntry>();
                while (SqliteStep(stmt) == 100) // SQLITE_ROW
                {
                    entries.Add(new HistoryEntry
                    {
                        Id = SqliteColumnInt64(stmt, 0),
                        ConnectionId = Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 1)) ?? "",
                        ConnectionName = Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 2)) ?? "",
                        Sql = Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 3)) ?? "",
                        ExecutedAt = SqliteColumnInt64(stmt, 4),
                        DurationMs = SqliteColumnInt(stmt, 5),
                        RowCount = SqliteColumnInt(stmt, 6),
                        Success = SqliteColumnInt(stmt, 7) == 1
                    });
                }
                SqliteFinalize(stmt);

                var result = new HistoryResult { Entries = entries };
                return Marshal.StringToCoTaskMemUTF8(
                    JsonSerializer.Serialize(result, HistoryJsonContext.Default.HistoryResult));
            }
            finally { SqliteClose(db); }
        }
        catch (Exception ex)
        {
            var error = new HistoryResult { Error = ex.Message };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(error, HistoryJsonContext.Default.HistoryResult));
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "clear_history")]
    public static int ClearHistory(IntPtr connectionIdPtr)
    {
        try
        {
            var connectionId = Marshal.PtrToStringUTF8(connectionIdPtr) ?? "";
            string dbPath = GetDbPath();

            IntPtr db = IntPtr.Zero;
            SqliteOpen(dbPath, ref db);

            try
            {
                EnsureTable(db);

                string sql = string.IsNullOrEmpty(connectionId)
                    ? "DELETE FROM query_history"
                    : "DELETE FROM query_history WHERE connection_id = ?";

                IntPtr stmt = IntPtr.Zero;
                SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero);

                if (!string.IsNullOrEmpty(connectionId))
                    SqliteBindText(stmt, 1, connectionId, -1, IntPtr.Zero);

                SqliteStep(stmt);
                SqliteFinalize(stmt);
                return 1;
            }
            finally { SqliteClose(db); }
        }
        catch { return 0; }
    }
    [UnmanagedCallersOnly(EntryPoint = "test_history_db")]
    public static IntPtr TestHistoryDb()
    {
        try
        {
            string dbPath = GetDbPath();
            IntPtr db = IntPtr.Zero;
            SqliteOpen(dbPath, ref db);
            try
            {
                EnsureTable(db);

                // Try a test insert
                string sql = "INSERT INTO query_history (connection_id, connection_name, sql, executed_at, duration_ms, row_count, success) VALUES (?, ?, ?, ?, ?, ?, ?)";
                IntPtr stmt = IntPtr.Zero;
                SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero);
                SqliteBindText(stmt, 1, "test-conn", -1, IntPtr.Zero);
                SqliteBindText(stmt, 2, "Test Connection", -1, IntPtr.Zero);
                SqliteBindText(stmt, 3, "SELECT 1", -1, IntPtr.Zero);
                SqliteBindInt64(stmt, 4, 1234567890);
                SqliteBindInt(stmt, 5, 100);
                SqliteBindInt(stmt, 6, 1);
                SqliteBindInt(stmt, 7, 1);
                int rc = SqliteStep(stmt);
                SqliteFinalize(stmt);

                // Count rows
                IntPtr countStmt = IntPtr.Zero;
                SqlitePrepareV2(db, "SELECT COUNT(*) FROM query_history", -1, ref countStmt, IntPtr.Zero);
                SqliteStep(countStmt);
                int count = SqliteColumnInt(countStmt, 0);
                SqliteFinalize(countStmt);

                return Marshal.StringToCoTaskMemUTF8($"OK: dbPath={dbPath}, insertRc={rc}, rowCount={count}");
            }
            finally { SqliteClose(db); }
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "debug_add_entry")]
    public static IntPtr DebugAddEntry(IntPtr jsonPtr)
    {
        try
        {
            var json = Marshal.PtrToStringUTF8(jsonPtr) ?? "NULL";
            return Marshal.StringToCoTaskMemUTF8($"Received: {json}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"Exception: {ex.Message}");
        }
    }

    // ---- winsqlite3 P/Invoke ----------------------------------
    private const string SqliteDll = "winsqlite3.dll";

    [DllImport(SqliteDll, EntryPoint = "sqlite3_open")]
    private static extern int SqliteOpen(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string filename, ref IntPtr db);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_close")]
    private static extern int SqliteClose(IntPtr db);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_prepare_v2")]
    private static extern int SqlitePrepareV2(
        IntPtr db,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        int nByte, ref IntPtr stmt, IntPtr pzTail);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_step")]
    private static extern int SqliteStep(IntPtr stmt);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_finalize")]
    private static extern int SqliteFinalize(IntPtr stmt);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_bind_text")]
    private static extern int SqliteBindText(
        IntPtr stmt, int index,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string value,
        int length, IntPtr destructor);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_bind_int")]
    private static extern int SqliteBindInt(IntPtr stmt, int index, int value);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_bind_int64")]
    private static extern int SqliteBindInt64(IntPtr stmt, int index, long value);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_int")]
    private static extern int SqliteColumnInt(IntPtr stmt, int col);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_int64")]
    private static extern long SqliteColumnInt64(IntPtr stmt, int col);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_text")]
    private static extern IntPtr SqliteColumnText(IntPtr stmt, int col);
}