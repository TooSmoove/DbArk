#nullable enable
using System;
using System.Runtime.InteropServices;

namespace DbArk.Integration;

/// <summary>
/// Minimal test-only SQLite seeder: opens a database file and executes setup
/// statements (CREATE TABLE, INSERT) so an integration test can hand a populated
/// database to the code under test. Uses the same <c>winsqlite3.dll</c> import
/// name the app uses, so the <see cref="SchemaNativeShim"/> resolver serves it on
/// every OS. Deliberately tiny — this is a harness, not a driver.
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

    /// <summary>Execute each statement in order against the file at <paramref name="path"/>.</summary>
    public static void Seed(string path, params string[] statements)
    {
        int rc = sqlite3_open(path, out IntPtr db);
        if (rc != SqliteOk)
            throw new InvalidOperationException($"sqlite3_open failed (code {rc}) for {path}");
        try
        {
            foreach (var sql in statements)
                RunOne(db, sql);
        }
        finally
        {
            sqlite3_close(db);
        }
    }

    private static void RunOne(IntPtr db, string sql)
    {
        int rc = sqlite3_prepare_v2(db, sql, -1, out IntPtr stmt, out _);
        if (rc != SqliteOk || stmt == IntPtr.Zero)
            throw new InvalidOperationException($"prepare failed: {ErrMsg(db)} — {sql}");
        try
        {
            int step = sqlite3_step(stmt);
            if (step != SqliteDone && step != SqliteRow)
                throw new InvalidOperationException($"step failed (code {step}): {ErrMsg(db)} — {sql}");
        }
        finally
        {
            sqlite3_finalize(stmt);
        }
    }

    private static string ErrMsg(IntPtr db)
    {
        IntPtr p = sqlite3_errmsg(db);
        return p != IntPtr.Zero ? Marshal.PtrToStringUTF8(p) ?? "unknown" : "unknown";
    }
}
