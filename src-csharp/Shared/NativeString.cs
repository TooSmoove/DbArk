using System;
using System.Runtime.InteropServices;

/// <summary>
/// The ownership boundary for UTF-8 strings handed across the C# → Rust FFI.
///
/// Every <c>[UnmanagedCallersOnly]</c> entry point in this assembly returns a
/// buffer allocated with <see cref="Marshal.StringToCoTaskMemUTF8(string?)"/>.
/// Once that pointer crosses the boundary the Rust host owns it and MUST release
/// it with the matching free (<see cref="Marshal.FreeCoTaskMem(IntPtr)"/>) by
/// calling this assembly's exported <c>free_string</c>. Before this type existed
/// nothing freed those buffers and every query, schema fetch and history read
/// leaked one — an unbounded leak that undercut the ~80 MB RAM claim (audit C-1).
///
/// Why each DLL ships its OWN <c>free_string</c> instead of one global free:
/// on Windows CoTaskMem routes to the process-global OLE allocator, but on
/// macOS/Linux NativeAOT supplies a per-runtime allocator. A buffer must be
/// freed by the same runtime that allocated it, so the Rust side always frees a
/// pointer through the very library that produced it. This source file is
/// <c>&lt;Compile Include&gt;</c>-linked into every engine project so each gets its
/// own copy/export — single source of truth, zero duplication.
/// </summary>
public static class NativeString
{
    /// <summary>
    /// Frees a CoTaskMem buffer previously returned across the FFI boundary.
    /// A null pointer is a safe no-op. This is the testable core; the exported
    /// shim below merely forwards to it (UnmanagedCallersOnly methods cannot be
    /// invoked from managed code, so the logic lives here to keep it unit-testable).
    /// </summary>
    internal static void Free(IntPtr ptr)
    {
        if (ptr != IntPtr.Zero)
        {
            Marshal.FreeCoTaskMem(ptr);
        }
    }

    /// <summary>
    /// FFI export. The Rust host calls this to release a string THIS DLL returned.
    /// Deliberately trivial — all behaviour is in <see cref="Free"/>.
    /// </summary>
    [UnmanagedCallersOnly(EntryPoint = "free_string")]
    public static void FreeString(IntPtr ptr) => Free(ptr);
}
