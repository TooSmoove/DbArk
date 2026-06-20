using System;
using System.Runtime.InteropServices;
using Xunit;

namespace QueryExecutorTests.Tests;

/// <summary>
/// Audit C-1 regression guard. The FFI contract is: every string returned to the
/// Rust host is allocated with Marshal.StringToCoTaskMemUTF8 and released by the
/// exported free_string, which forwards to NativeString.Free (Marshal.FreeCoTaskMem).
/// These tests pin that the free matches the allocator and tolerates null, without
/// needing the full app/DB harness. True "RSS stays flat over 10k queries" leak
/// verification lives in the soak test (scripts/soak_ffi.ps1), which needs a built
/// binary + live DB and so is run manually, not in CI.
/// </summary>
public class NativeStringTests
{
    [Fact]
    public void Free_NullPointer_IsSafeNoOp()
    {
        // Must not throw — the Rust null branch never reaches free_string, but a
        // defensive no-op keeps the contract total.
        var ex = Record.Exception(() => NativeString.Free(IntPtr.Zero));
        Assert.Null(ex);
    }

    [Fact]
    public void Free_ReleasesBufferAllocatedByStringToCoTaskMemUTF8()
    {
        // Arrange: allocate exactly as every FFI entry point does.
        const string payload = "{\"results\":[{\"rows\":1}]}";
        IntPtr ptr = Marshal.StringToCoTaskMemUTF8(payload);
        Assert.NotEqual(IntPtr.Zero, ptr);

        // The Rust side copies the bytes out before freeing; prove the round-trip
        // is intact, then free with the matching free. A mismatched allocator/free
        // pairing would corrupt the heap here.
        Assert.Equal(payload, Marshal.PtrToStringUTF8(ptr));

        var ex = Record.Exception(() => NativeString.Free(ptr));
        Assert.Null(ex);
    }

    [Fact]
    public void Free_ManyBuffers_DoesNotThrow()
    {
        // Allocate/free in a tight loop — the pattern a working session repeats
        // thousands of times. A broken free would surface as a crash here.
        for (int i = 0; i < 10_000; i++)
        {
            IntPtr ptr = Marshal.StringToCoTaskMemUTF8($"row-{i}");
            NativeString.Free(ptr);
        }
    }
}