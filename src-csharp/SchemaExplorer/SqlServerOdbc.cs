#nullable enable
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

// Minimal raw-ODBC bridge for SQL Server catalog queries. Moved verbatim out of
// SchemaExplorer.cs so the entry-point file carries no engine-specific plumbing.
internal static class SqlServerOdbc
{
    private const short SQL_SUCCESS = 0;
    private const short SQL_SUCCESS_WITH_INFO = 1;
    private const short SQL_HANDLE_ENV = 1;
    private const short SQL_HANDLE_DBC = 2;
    private const short SQL_HANDLE_STMT = 3;
    private const int SQL_ATTR_ODBC_VERSION = 200;
    private const int SQL_OV_ODBC3 = 3;
    private const short SQL_NTS = -3;
    private const short SQL_C_WCHAR = -8;
    private const int SQL_NULL_DATA = -1;
    private const string OdbcDll = "odbc32.dll";

    [DllImport(OdbcDll)] static extern short SQLAllocHandle(short t, IntPtr i, out IntPtr o);
    [DllImport(OdbcDll)] static extern short SQLSetEnvAttr(IntPtr h, int a, IntPtr v, int l);
    [DllImport(OdbcDll)] static extern short SQLDriverConnectW(IntPtr c, IntPtr w, [MarshalAs(UnmanagedType.LPWStr)] string s, short sl, IntPtr o, short ol, out short al, short d);
    [DllImport(OdbcDll)] static extern short SQLAllocStmt(IntPtr c, out IntPtr s);
    [DllImport(OdbcDll)] static extern short SQLExecDirectW(IntPtr s, [MarshalAs(UnmanagedType.LPWStr)] string q, int l);
    [DllImport(OdbcDll)] static extern short SQLNumResultCols(IntPtr s, out short n);
    [DllImport(OdbcDll)] static extern short SQLFetch(IntPtr s);
    [DllImport(OdbcDll)] static extern short SQLGetData(IntPtr s, short c, short t, IntPtr v, IntPtr b, out IntPtr ind);
    [DllImport(OdbcDll)] static extern short SQLFreeHandle(short t, IntPtr h);
    [DllImport(OdbcDll)] static extern short SQLDisconnect(IntPtr h);

    public static List<string?[]> Query(string connectionString, string sql)
    {
        IntPtr hEnv = IntPtr.Zero, hDbc = IntPtr.Zero, hStmt = IntPtr.Zero;
        var results = new List<string?[]>();

        try
        {
            SQLAllocHandle(SQL_HANDLE_ENV, IntPtr.Zero, out hEnv);
            SQLSetEnvAttr(hEnv, SQL_ATTR_ODBC_VERSION, new IntPtr(SQL_OV_ODBC3), 0);
            SQLAllocHandle(SQL_HANDLE_DBC, hEnv, out hDbc);

            short outLen;
            short rc = SQLDriverConnectW(hDbc, IntPtr.Zero, connectionString,
                SQL_NTS, IntPtr.Zero, 0, out outLen, 0);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return results;

            SQLAllocStmt(hDbc, out hStmt);
            rc = SQLExecDirectW(hStmt, sql, SQL_NTS);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return results;

            SQLNumResultCols(hStmt, out short colCount);

            IntPtr buf = Marshal.AllocHGlobal(4096);
            try
            {
                while (SQLFetch(hStmt) == SQL_SUCCESS)
                {
                    var row = new string?[colCount];
                    for (short i = 1; i <= colCount; i++)
                    {
                        SQLGetData(hStmt, i, SQL_C_WCHAR, buf, (IntPtr)4096, out IntPtr indPtr);
                        long ind = indPtr.ToInt64();
                        row[i - 1] = ind == SQL_NULL_DATA ? null
                            : Marshal.PtrToStringUni(buf, (int)(ind / 2));
                    }
                    results.Add(row);
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally
        {
            if (hStmt != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_STMT, hStmt);
            if (hDbc != IntPtr.Zero) { SQLDisconnect(hDbc); SQLFreeHandle(SQL_HANDLE_DBC, hDbc); }
            if (hEnv != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_ENV, hEnv);
        }

        return results;
    }
}

