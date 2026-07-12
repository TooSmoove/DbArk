#nullable enable
using System;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace DbArk.Integration;

/// <summary>
/// Test-only native-library shim so the SQLite integration tests run on every
/// OS, not just Windows.
///
/// The engine hard-codes <c>[DllImport("winsqlite3.dll")]</c> — the SQLite build
/// that ships with Windows 10/11. On Linux/macOS that library does not exist, so
/// this module initializer registers a <see cref="NativeLibrary"/> resolver on
/// the QueryExecutor assembly that maps the <c>winsqlite3.dll</c> import name onto
/// the platform's system SQLite (<c>libsqlite3.so.0</c> / <c>libsqlite3.dylib</c>),
/// which exports the same standard <c>sqlite3_*</c> C API the P/Invokes call.
///
/// On Windows it is a no-op: the resolver returns <see cref="IntPtr.Zero"/> and the
/// default loader finds the real <c>winsqlite3.dll</c>. Production registers no
/// resolver on this assembly, so there is no conflict (a second
/// <c>SetDllImportResolver</c> would throw). This shim changes nothing about the
/// code under test — it only satisfies the same import from a differently named file.
/// </summary>
internal static class SqliteNativeShim
{
    [ModuleInitializer]
    internal static void Init()
    {
        if (OperatingSystem.IsWindows())
            return; // real winsqlite3.dll resolves natively

        // typeof(global::QueryExecutor) anchors the assembly that owns the
        // SqliteQueryEngine P/Invokes (the class lives in the global namespace).
        NativeLibrary.SetDllImportResolver(typeof(global::QueryExecutor).Assembly, Resolve);
    }

    private static IntPtr Resolve(string libraryName, System.Reflection.Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!libraryName.Equals("winsqlite3.dll", StringComparison.OrdinalIgnoreCase))
            return IntPtr.Zero; // not ours — let the default resolver handle it

        foreach (var candidate in Candidates())
            if (NativeLibrary.TryLoad(candidate, out var handle))
                return handle;

        return IntPtr.Zero; // fall through to default (surfaces a clear load error)
    }

    private static string[] Candidates() =>
        OperatingSystem.IsMacOS()
            ? new[] { "libsqlite3.dylib", "/usr/lib/libsqlite3.dylib" }
            : new[] { "libsqlite3.so.0", "libsqlite3.so", "sqlite3" };
}
