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
            MigrateIfUnencrypted(dbPath);
            SqliteOpen(dbPath, ref db);
            ApplyKey(db);

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

                insertSql = ScrubSql(insertSql);

                IntPtr insertStmt = IntPtr.Zero;
                SqlitePrepareV2(db, insertSql, -1, ref insertStmt, IntPtr.Zero);
                int rc = SqliteStep(insertStmt);
                SqliteFinalize(insertStmt);
                return rc == 101 ? 1 : 0;
            }
            finally { SqliteClose(db); }
        }
        catch (Exception ex)
        {
            return 0;
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "get_history")]
    public static IntPtr GetHistory(IntPtr connectionIdPtr, int limit)
    {
        try
        {
            var connectionId = Marshal.PtrToStringUTF8(connectionIdPtr) ?? "";

            string dbPath = GetDbPath();

            IntPtr db = IntPtr.Zero;
            MigrateIfUnencrypted(dbPath);
            SqliteOpen(dbPath, ref db);
            ApplyKey(db);

            try
            {
                EnsureTable(db);
                PurgeOldHistory(db);

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
            MigrateIfUnencrypted(dbPath);
            SqliteOpen(dbPath, ref db);
            ApplyKey(db);

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
    [UnmanagedCallersOnly(EntryPoint = "init_history_key")]
    public static void InitHistoryKey(IntPtr keyPtr)
    {
        var key = Marshal.PtrToStringUTF8(keyPtr) ?? "";
        SetKey(key);
    }
    private static void MigrateIfUnencrypted(string dbPath)
    {
        if (!File.Exists(dbPath) || string.IsNullOrEmpty(_dbKey)) return;

        // Try opening with the key — if it fails to read the schema,
        // the DB is unencrypted and needs migrating
        IntPtr db = IntPtr.Zero;
        SqliteOpen(dbPath, ref db);
        ApplyKey(db);

        IntPtr stmt = IntPtr.Zero;
        int rc = SqlitePrepareV2(db, "SELECT count(*) FROM sqlite_master", -1, ref stmt, IntPtr.Zero);
        SqliteFinalize(stmt);
        SqliteClose(db);

        if (rc == 0) return; // Already encrypted or empty — nothing to do

        // DB is unencrypted — encrypt it in place using sqlcipher_export
        string tmpPath = dbPath + ".tmp";
        IntPtr plainDb = IntPtr.Zero;
        SqliteOpen(dbPath, ref plainDb); // open without key

        IntPtr attachStmt = IntPtr.Zero;
        SqlitePrepareV2(plainDb,
            $"ATTACH DATABASE '{tmpPath}' AS encrypted KEY '{_dbKey}'",
            -1, ref attachStmt, IntPtr.Zero);
        SqliteStep(attachStmt);
        SqliteFinalize(attachStmt);

        IntPtr exportStmt = IntPtr.Zero;
        SqlitePrepareV2(plainDb, "SELECT sqlcipher_export('encrypted')",
            -1, ref exportStmt, IntPtr.Zero);
        SqliteStep(exportStmt);
        SqliteFinalize(exportStmt);

        IntPtr detachStmt = IntPtr.Zero;
        SqlitePrepareV2(plainDb, "DETACH DATABASE encrypted",
            -1, ref detachStmt, IntPtr.Zero);
        SqliteStep(detachStmt);
        SqliteFinalize(detachStmt);
        SqliteClose(plainDb);

        File.Replace(tmpPath, dbPath, null);
    }
    private static void PurgeOldHistory(IntPtr db)
    {
        // Delete entries older than 90 days
        long cutoff = DateTimeOffset.UtcNow.AddDays(-90).ToUnixTimeMilliseconds();
        string sql = $"DELETE FROM query_history WHERE executed_at < {cutoff}";
        IntPtr stmt = IntPtr.Zero;
        SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero);
        SqliteStep(stmt);
        SqliteFinalize(stmt);
    }
    private static string ScrubSql(string sql)
    {
        // Mask literal string values in WHERE clauses that look like passwords
        return System.Text.RegularExpressions.Regex.Replace(
            sql,
            @"(?i)(password|pwd|secret|token|key)\s*=\s*'[^']*'",
            "$1='***'"
        );
    }

    // ---- winsqlite3 P/Invoke ----------------------------------
    private const string SqliteDll = "sqlcipher.dll";

    private static string? _dbKey;

    public static void SetKey(string key) => _dbKey = key;

    private static void ApplyKey(IntPtr db)
    {
        if (string.IsNullOrEmpty(_dbKey)) return;
        SqliteKey(db, _dbKey, _dbKey.Length);
    }

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
    [DllImport(SqliteDll, EntryPoint = "sqlite3_key")]
    private static extern int SqliteKey(IntPtr db,
    [MarshalAs(UnmanagedType.LPUTF8Str)] string key, int keyLen);
}