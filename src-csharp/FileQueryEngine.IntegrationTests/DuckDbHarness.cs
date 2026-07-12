#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace DbArk.Integration;

/// <summary>
/// A minimal test harness over DuckDB's C API. It exists so the integration
/// tests can execute the scan / staging SQL that DbArk's production
/// <c>DuckDbFileScan</c> and <c>DuckDbTableBuilder</c> helpers GENERATE, against a
/// real libduckdb — proving the generated SQL is valid and that the H-1
/// path-escaping and C-5 typed-staging behaviours hold against the actual engine.
///
/// The P/Invoke signatures mirror those in FileQueryEngine.cs exactly (DuckDB
/// v1.5.0, IntPtr-based result API). A resolver on THIS test assembly locates the
/// staged native — the product's own resolver lives on the FileQueryEngine
/// assembly and only handles the <c>duckdb.dll</c> import name, so there is no
/// overlap.
/// </summary>
internal static class DuckDb
{
    private const string Lib = "duckdb";
    private const int ResultSize = 64;   // sizeof(duckdb_result) in the v1.5 C API
    private const int Success = 0;

    [ModuleInitializer]
    internal static void Init() =>
        NativeLibrary.SetDllImportResolver(typeof(DuckDb).Assembly, Resolve);

    // ── native discovery ─────────────────────────────────────────────────────

    private static IntPtr Resolve(string name, Assembly assembly, DllImportSearchPath? path)
    {
        if (!name.Equals(Lib, StringComparison.OrdinalIgnoreCase))
            return IntPtr.Zero;

        foreach (var candidate in CandidateFiles())
            if (File.Exists(candidate) && NativeLibrary.TryLoad(candidate, out var h))
                return h;

        // Last resort: let the OS loader try the usual names (dev machine with
        // libduckdb on the default search path).
        foreach (var n in new[] { "duckdb", "libduckdb", "libduckdb.so", "libduckdb.dylib", "duckdb.dll" })
            if (NativeLibrary.TryLoad(n, out var h))
                return h;

        return IntPtr.Zero;
    }

    private static IEnumerable<string> CandidateFiles()
    {
        // 1) explicit full path
        var explicitLib = Environment.GetEnvironmentVariable("DBARK_DUCKDB_LIB");
        if (!string.IsNullOrEmpty(explicitLib))
            yield return explicitLib;

        // 2) a natives directory (CI export) or the repo's src-tauri/natives
        var dir = Environment.GetEnvironmentVariable("DBARK_NATIVES_DIR") ?? FindNativesDir();
        if (dir != null)
            foreach (var file in new[] { "libduckdb.so", "libduckdb.dylib", "duckdb.dll" })
                yield return Path.Combine(dir, file);
    }

    /// <summary>Walk up from the test binary looking for <c>src-tauri/natives</c>.</summary>
    private static string? FindNativesDir()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir != null)
        {
            var candidate = Path.Combine(dir.FullName, "src-tauri", "natives");
            if (Directory.Exists(candidate))
                return candidate;
            dir = dir.Parent;
        }
        return null;
    }

    private static bool? _available;

    /// <summary>True when a libduckdb could be loaded and opened. Cached.</summary>
    public static bool Available
    {
        get
        {
            if (_available is bool cached) return cached;
            try
            {
                int rc = duckdb_open(null, out IntPtr db);
                if (rc == Success) { duckdb_close(ref db); _available = true; }
                else _available = false;
            }
            catch (Exception e) when (e is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
            {
                _available = false;
            }
            return _available!.Value;
        }
    }

    // ── managed session ──────────────────────────────────────────────────────

    public sealed class Session : IDisposable
    {
        private IntPtr _db;
        private IntPtr _conn;

        public Session()
        {
            if (duckdb_open(null, out _db) != Success)
                throw new InvalidOperationException("duckdb_open (in-memory) failed");
            if (duckdb_connect(_db, out _conn) != Success)
                throw new InvalidOperationException("duckdb_connect failed");
        }

        /// <summary>Run a statement for its side effect. Returns the DuckDB error, or null on success.</summary>
        public string? Exec(string sql)
        {
            IntPtr buf = AllocResult();
            try
            {
                int rc = duckdb_query(_conn, sql, buf);
                string? err = rc == Success ? null : ReadError(buf);
                duckdb_destroy_result(buf);
                return err;
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        /// <summary>Run a query and materialise columns + rows. Throws on a DuckDB error.</summary>
        public DuckResult Query(string sql)
        {
            IntPtr buf = AllocResult();
            try
            {
                int rc = duckdb_query(_conn, sql, buf);
                if (rc != Success)
                {
                    string err = ReadError(buf);
                    duckdb_destroy_result(buf);
                    throw new InvalidOperationException($"DuckDB query failed: {err}");
                }

                long cols = duckdb_column_count(buf);
                long rows = duckdb_row_count(buf);

                var columns = new List<string>();
                for (long c = 0; c < cols; c++)
                {
                    IntPtr namePtr = duckdb_column_name(buf, c);
                    columns.Add(namePtr != IntPtr.Zero ? Marshal.PtrToStringUTF8(namePtr) ?? $"col{c}" : $"col{c}");
                }

                var data = new List<List<string?>>();
                for (long r = 0; r < rows; r++)
                {
                    var row = new List<string?>();
                    for (long c = 0; c < cols; c++)
                    {
                        if (duckdb_value_is_null(buf, c, r) != 0) { row.Add(null); continue; }
                        IntPtr valPtr = duckdb_value_varchar(buf, c, r);
                        if (valPtr == IntPtr.Zero) { row.Add(null); continue; }
                        row.Add(Marshal.PtrToStringUTF8(valPtr));
                        duckdb_free(valPtr);
                    }
                    data.Add(row);
                }

                duckdb_destroy_result(buf);
                return new DuckResult(columns, data);
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        public void Dispose()
        {
            if (_conn != IntPtr.Zero) duckdb_disconnect(ref _conn);
            if (_db != IntPtr.Zero) duckdb_close(ref _db);
        }
    }

    private static IntPtr AllocResult()
    {
        IntPtr buf = Marshal.AllocHGlobal(ResultSize);
        for (int i = 0; i < ResultSize; i++) Marshal.WriteByte(buf, i, 0);
        return buf;
    }

    private static string ReadError(IntPtr buf)
    {
        IntPtr p = duckdb_result_error(buf);
        return p != IntPtr.Zero ? Marshal.PtrToStringUTF8(p) ?? "DuckDB error" : "DuckDB error";
    }

    // ── P/Invoke (mirrors FileQueryEngine.cs — DuckDB v1.5.0 IntPtr API) ──────

    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int duckdb_open([MarshalAs(UnmanagedType.LPUTF8Str)] string? path, out IntPtr db);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_close(ref IntPtr db);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int duckdb_connect(IntPtr db, out IntPtr conn);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_disconnect(ref IntPtr conn);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern int duckdb_query(IntPtr conn, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, IntPtr result);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_destroy_result(IntPtr result);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern long duckdb_column_count(IntPtr result);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern long duckdb_row_count(IntPtr result);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr duckdb_column_name(IntPtr result, long col);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr duckdb_value_varchar(IntPtr result, long col, long row);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern byte duckdb_value_is_null(IntPtr result, long col, long row);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern IntPtr duckdb_result_error(IntPtr result);
    [DllImport(Lib, CallingConvention = CallingConvention.Cdecl)]
    private static extern void duckdb_free(IntPtr ptr);
}

/// <summary>Materialised DuckDB result — columns and stringified cell values.</summary>
internal sealed record DuckResult(List<string> Columns, List<List<string?>> Rows);
