#nullable enable
using System;
using System.Runtime.InteropServices;

namespace DbArk.Integration;

/// <summary>
/// Minimal SQLite seeder for the live-table-staging test. Uses the same
/// <c>winsqlite3.dll</c> import the app uses; that test only runs on Windows
/// (see the skip guard), where winsqlite3 resolves natively — so no DllImport
/// resolver is needed or registered here (the FileQueryEngine assembly already
/// owns the only resolver, for duckdb).
/// </summary>
internal static class SqliteTestDb
{
    private const string Dll = "winsqlite3.dll";
    private const int SqliteOk = 0;
    private const int SqliteRow = 100;
    private const int SqliteDone = 101;

    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_open([MarshalAs(UnmanagedType.LPUTF8Str)] string filename, out IntPtr db);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_close(IntPtr db);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_prepare_v2(
        IntPtr db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, int nByte, out IntPtr stmt, out IntPtr tail);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_step(IntPtr stmt);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern int sqlite3_finalize(IntPtr stmt);
    [DllImport(Dll, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr sqlite3_errmsg(IntPtr db);

    public static void Seed(string path, params string[] statements)
    {
        if (sqlite3_open(path, out IntPtr db) != SqliteOk)
            throw new InvalidOperationException($"sqlite3_open failed for {path}");
        try
        {
            foreach (var sql in statements)
            {
                if (sqlite3_prepare_v2(db, sql, -1, out IntPtr stmt, out _) != SqliteOk || stmt == IntPtr.Zero)
                    throw new InvalidOperationException($"prepare failed: {Err(db)} — {sql}");
                try
                {
                    int step = sqlite3_step(stmt);
                    if (step != SqliteDone && step != SqliteRow)
                        throw new InvalidOperationException($"step failed ({step}): {Err(db)} — {sql}");
                }
                finally { sqlite3_finalize(stmt); }
            }
        }
        finally { sqlite3_close(db); }
    }

    private static string Err(IntPtr db)
    {
        IntPtr p = sqlite3_errmsg(db);
        return p != IntPtr.Zero ? Marshal.PtrToStringUTF8(p) ?? "unknown" : "unknown";
    }
}
