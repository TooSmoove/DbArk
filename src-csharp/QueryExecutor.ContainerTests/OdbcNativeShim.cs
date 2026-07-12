#nullable enable
using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace DbArk.Integration;

/// <summary>
/// Test-only shim that lets the SQL Server engine's ODBC path run on Linux.
///
/// <c>SqlServerExecutor</c> P/Invokes <c>odbc32.dll</c> — the Windows ODBC Driver
/// Manager. On Linux the equivalent is unixODBC's <c>libodbc.so.2</c>, which
/// exports the same ODBC symbols (<c>SQLDriverConnectW</c>, <c>SQLExecDirectW</c>,
/// …). This module initializer maps the import name onto it so the SQL Server
/// container tests can exercise the real ODBC executor on a Docker-capable Linux
/// runner (with msodbcsql18 + unixODBC installed). No-op on Windows, where
/// odbc32.dll resolves natively. Registered only in this test process, on the
/// QueryExecutor assembly that owns the imports — production registers no
/// resolver there, so there is no double-registration conflict.
/// </summary>
internal static class OdbcNativeShim
{
    [ModuleInitializer]
    internal static void Init()
    {
        if (OperatingSystem.IsWindows())
            return;

        // typeof(QueryResult) anchors the QueryExecutor assembly without naming
        // the QueryExecutor class (whose name collides with this test project's
        // default namespace segment).
        NativeLibrary.SetDllImportResolver(typeof(QueryResult).Assembly, Resolve);
    }

    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!libraryName.Equals("odbc32.dll", StringComparison.OrdinalIgnoreCase))
            return IntPtr.Zero;

        foreach (var candidate in new[] { "libodbc.so.2", "libodbc.so.1", "libodbc.so" })
            if (NativeLibrary.TryLoad(candidate, out var handle))
                return handle;

        return IntPtr.Zero; // unixODBC not installed → SQL Server tests skip
    }
}
