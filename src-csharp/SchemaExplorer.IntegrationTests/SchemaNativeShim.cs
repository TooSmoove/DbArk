#nullable enable
using System;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace DbArk.Integration;

/// <summary>
/// Test-only native shim (see the QueryExecutor integration project for the full
/// rationale). Maps the <c>winsqlite3.dll</c> import name onto the platform's
/// system SQLite on non-Windows, so both the SchemaExplorer engine under test AND
/// this project's own <see cref="SqliteTestDb"/> seeder resolve everywhere.
///
/// A resolver is registered once per assembly: one on the SchemaExplorer assembly
/// (the SqliteSchemaEngine P/Invokes) and one on this test assembly (the seeder's
/// P/Invokes). Neither assembly registers its own resolver in production for
/// winsqlite3, so there is no double-registration conflict. No-op on Windows.
/// </summary>
internal static class SchemaNativeShim
{
    [ModuleInitializer]
    internal static void Init()
    {
        if (OperatingSystem.IsWindows())
            return;

        // Engine assembly (SchemaExplorerLib lives in the global namespace).
        NativeLibrary.SetDllImportResolver(typeof(global::SchemaExplorerLib).Assembly, Resolve);
        // This test assembly (the SqliteTestDb seeder's imports).
        NativeLibrary.SetDllImportResolver(typeof(SchemaNativeShim).Assembly, Resolve);
    }

    private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (!libraryName.Equals("winsqlite3.dll", StringComparison.OrdinalIgnoreCase))
            return IntPtr.Zero;

        foreach (var candidate in Candidates())
            if (NativeLibrary.TryLoad(candidate, out var handle))
                return handle;

        return IntPtr.Zero;
    }

    private static string[] Candidates() =>
        OperatingSystem.IsMacOS()
            ? new[] { "libsqlite3.dylib", "/usr/lib/libsqlite3.dylib" }
            : new[] { "libsqlite3.so.0", "libsqlite3.so", "sqlite3" };
}
