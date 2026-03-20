using System;
using System.Runtime.InteropServices;

namespace QueryExecutor;

public static class QueryExecutor
{
    [UnmanagedCallersOnly(EntryPoint = "test_connection")]
    public static int TestConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return 0;

            // For now just return true — we'll add real SQL Server logic in Week 2
            return 1;
        }
        catch
        {
            return 0;
        }
    }
}