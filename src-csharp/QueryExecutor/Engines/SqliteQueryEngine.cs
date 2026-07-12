#nullable enable
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>SQLite via the in-process winsqlite3 bridge. Still on the legacy
/// statement-by-statement path — its stage-2 batch migration is pending.</summary>
internal sealed class SqliteQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => false;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        throw new InvalidOperationException(
            "ExecuteBatch reached for engine 'sqlite' before its stage-2 migration.");

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { ExecuteSqliteCore(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        ExecuteNonQuerySqlite(connectionString, sql);

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

            string path = SqliteConnectionString.ExtractPath(connectionString);

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
        string path = SqliteConnectionString.ExtractPath(connectionString);

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
            int rowLimit = QueryExecutor.ActiveRowLimit;
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
                // Column count and names are fixed at prepare time, so read them
                // BEFORE the first step. This means a zero-row result still
                // reports its headers (matching the reader-based engines), and
                // the truncation check no longer depends on a first row existing.
                int colCount = sqlite3_column_count(stmt);
                for (int i = 0; i < colCount; i++)
                {
                    IntPtr namePtr = sqlite3_column_name(stmt, i);
                    columns.Add(namePtr != IntPtr.Zero
                        ? Marshal.PtrToStringUTF8(namePtr) ?? $"col{i}"
                        : $"col{i}");
                }

                // Enforce the cap AFTER a ROW step but BEFORE keeping the row —
                // the same shape as ExecuteSqliteMulti. The old "peek one more
                // row" trick was wrong: sqlite3_prepare_v2 auto-resets a
                // statement that has returned SQLITE_DONE, so a result of exactly
                // ActiveRowLimit rows re-ran on the peek and was falsely flagged
                // truncated.
                while (sqlite3_step(stmt) == SQLITE_ROW)
                {
                    if (rowLimit > 0 && rowCount >= rowLimit) { truncated = true; break; }

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
                Truncated = truncated,
                LargeResult = rowCount >= QueryExecutor.LargeResultThreshold && (rowLimit == 0 || rowLimit > QueryExecutor.LargeResultThreshold),
            };
        }
        finally
        {
            sqlite3_close(db);
        }
    }

    private static List<QueryResult> ExecuteSqliteMulti(string connectionString, string sql)
    {
        string path = SqliteConnectionString.ExtractPath(connectionString);

        int rc = sqlite3_open(path, out IntPtr db);
        if (rc != 0)
            return new List<QueryResult> {
                new QueryResult { Error = $"Cannot open SQLite database (code {rc}): {path}" }
            };

        var results = new List<QueryResult>();
        bool anyResultSet = false;
        int totalChanges = 0;
        int rowLimit = QueryExecutor.ActiveRowLimit;

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
                            LargeResult = rowCount >= QueryExecutor.LargeResultThreshold && (rowLimit == 0 || rowLimit > QueryExecutor.LargeResultThreshold),
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

    private static int ExecuteNonQuerySqlite(string connectionString, string sql)
    {
        // SQLite via P/Invoke — execute and discard the result set
        ExecuteSqliteCore(connectionString, sql);
        return -1; // P/Invoke path does not expose affected-row count
    }
}