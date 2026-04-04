#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;

public static class SqlServerExecutor
{
    // ---- ODBC Constants -----------------------------------
    private const short SQL_SUCCESS = 0;
    private const short SQL_SUCCESS_WITH_INFO = 1;
    private const short SQL_NO_DATA = 100;
    private const short SQL_NULL_DATA = -1;

    private const short SQL_HANDLE_ENV = 1;
    private const short SQL_HANDLE_DBC = 2;
    private const short SQL_HANDLE_STMT = 3;

    private const int SQL_ATTR_ODBC_VERSION = 200;
    private const int SQL_OV_ODBC3 = 3;
    private const int SQL_ATTR_LOGIN_TIMEOUT = 103;
    private const int SQL_ATTR_QUERY_TIMEOUT = 0;
    private const short SQL_NTS = -3;
    private const short SQL_C_WCHAR = -8;
    private const short SQL_WCHAR = -9;
    private const short SQL_WVARCHAR = -9;
    private const int SQL_COLUMN_BUFFER_SIZE = 8192;

    // ---- ODBC P/Invoke ------------------------------------
    private const string OdbcDll = "odbc32.dll";

    [DllImport(OdbcDll)] private static extern short SQLAllocHandle(short handleType, IntPtr inputHandle, out IntPtr outputHandle);
    [DllImport(OdbcDll)] private static extern short SQLSetEnvAttr(IntPtr envHandle, int attribute, IntPtr valuePtr, int stringLength);
    [DllImport(OdbcDll)] private static extern short SQLDriverConnectW(IntPtr connHandle, IntPtr windowHandle, [MarshalAs(UnmanagedType.LPWStr)] string inConnStr, short inConnStrLen, IntPtr outConnStr, short outConnStrLen, out short outConnStrLenActual, short driverCompletion);
    [DllImport(OdbcDll)] private static extern short SQLAllocStmt(IntPtr connHandle, out IntPtr stmtHandle);
    [DllImport(OdbcDll)] private static extern short SQLExecDirectW(IntPtr stmtHandle, [MarshalAs(UnmanagedType.LPWStr)] string sql, int sqlLength);
    [DllImport(OdbcDll)] private static extern short SQLNumResultCols(IntPtr stmtHandle, out short columnCount);
    [DllImport(OdbcDll)] private static extern short SQLDescribeColW(IntPtr stmtHandle, short columnNumber, IntPtr columnName, short bufferLength, out short nameLengthPtr, out short dataTypePtr, out uint columnSizePtr, out short decimalDigitsPtr, out short nullablePtr);
    [DllImport(OdbcDll)] private static extern short SQLFetch(IntPtr stmtHandle);
    [DllImport(OdbcDll)] private static extern short SQLGetData(IntPtr stmtHandle, short columnNumber, short targetType, IntPtr targetValuePtr, int bufferLength, out int strLenOrIndPtr);
    [DllImport(OdbcDll)] private static extern short SQLFreeHandle(short handleType, IntPtr handle);
    [DllImport(OdbcDll)] private static extern short SQLDisconnect(IntPtr connHandle);
    [DllImport(OdbcDll)] private static extern short SQLSetStmtAttrW(IntPtr stmtHandle, int attribute, IntPtr valuePtr, int stringLength);

    // ---- Public entry point -------------------------------
    public static IntPtr Execute(string connectionString, string sql, bool readOnly)
    {
        IntPtr hEnv = IntPtr.Zero;
        IntPtr hDbc = IntPtr.Zero;
        IntPtr hStmt = IntPtr.Zero;

        try
        {
            // Allocate environment
            if (SQLAllocHandle(SQL_HANDLE_ENV, IntPtr.Zero, out hEnv) != SQL_SUCCESS)
                return Error("Failed to allocate ODBC environment");

            // Set ODBC version
            SQLSetEnvAttr(hEnv, SQL_ATTR_ODBC_VERSION,
                new IntPtr(SQL_OV_ODBC3), 0);

            // Allocate connection
            if (SQLAllocHandle(SQL_HANDLE_DBC, hEnv, out hDbc) != SQL_SUCCESS)
                return Error("Failed to allocate ODBC connection");

            // Set login timeout
            SQLSetEnvAttr(hDbc, SQL_ATTR_LOGIN_TIMEOUT, new IntPtr(10), 0);

            // Connect
            short outLen;
            short rc = SQLDriverConnectW(
                hDbc, IntPtr.Zero,
                connectionString, SQL_NTS,
                IntPtr.Zero, 0, out outLen, 0);

            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return Error(GetDiagnostic(SQL_HANDLE_DBC, hDbc));

            // Allocate statement
            if (SQLAllocStmt(hDbc, out hStmt) != SQL_SUCCESS)
                return Error("Failed to allocate ODBC statement");

            // Set query timeout to 30 seconds
            SQLSetStmtAttrW(hStmt, SQL_ATTR_QUERY_TIMEOUT,
                new IntPtr(30), 0);

            // Split and execute statements
            var statements = sql
                .Split(';')
                .Select(s => s.Trim())
                .Where(s => !string.IsNullOrWhiteSpace(s))
                .ToList();

            if (statements.Count == 0)
                return Error("No statements found");

            // Enforce read-only
            if (readOnly)
            {
                foreach (var stmt in statements)
                {
                    if (!IsReadOnlyStatement(stmt))
                        return Error($"Connection is read-only — statement not allowed: {stmt.Split('\n')[0].Trim()}");
                }
            }

            // Execute all but last — discard results
            foreach (var stmt in statements.SkipLast(1))
            {
                SQLExecDirectW(hStmt, stmt, SQL_NTS);
            }

            // Execute last statement and return results
            var lastSql = statements.Last();
            rc = SQLExecDirectW(hStmt, lastSql, SQL_NTS);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return Error(GetDiagnostic(SQL_HANDLE_STMT, hStmt));

            return SerialiseResults(hStmt);
        }
        catch (Exception ex)
        {
            return Error(ex.Message);
        }
        finally
        {
            if (hStmt != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_STMT, hStmt);
            if (hDbc != IntPtr.Zero) { SQLDisconnect(hDbc); SQLFreeHandle(SQL_HANDLE_DBC, hDbc); }
            if (hEnv != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_ENV, hEnv);
        }
    }

    // ---- Serialise results --------------------------------
    private static IntPtr SerialiseResults(IntPtr hStmt)
    {
        // Get column count
        SQLNumResultCols(hStmt, out short colCount);

        // Get column names
        var columns = new List<string>();
        IntPtr nameBuf = Marshal.AllocHGlobal(256 * 2);
        try
        {
            for (short i = 1; i <= colCount; i++)
            {
                SQLDescribeColW(hStmt, i, nameBuf, 256,
                    out short nameLen, out _, out _, out _, out _);
                columns.Add(Marshal.PtrToStringUni(nameBuf, nameLen) ?? $"col{i}");
            }
        }
        finally { Marshal.FreeHGlobal(nameBuf); }

        // Fetch rows
        var rows = new List<List<string?>>();
        int rowLimit = 10_000;
        int rowCount = 0;
        bool truncated = false;

        IntPtr dataBuf = Marshal.AllocHGlobal(SQL_COLUMN_BUFFER_SIZE);
        try
        {
            while (SQLFetch(hStmt) == SQL_SUCCESS)
            {
                if (rowCount >= rowLimit) { truncated = true; break; }

                var row = new List<string?>();
                for (short i = 1; i <= colCount; i++)
                {
                    short rc2 = SQLGetData(hStmt, i, SQL_C_WCHAR,
                        dataBuf, SQL_COLUMN_BUFFER_SIZE, out int indicator);

                    if (indicator == SQL_NULL_DATA)
                    {
                        row.Add(null);
                    }
                    else if (rc2 == SQL_SUCCESS || rc2 == SQL_SUCCESS_WITH_INFO)
                    {
                        int charLen = indicator / 2; // bytes → chars
                        row.Add(Marshal.PtrToStringUni(dataBuf, Math.Max(0, charLen)));
                    }
                    else
                    {
                        row.Add(null);
                    }
                }
                rows.Add(row);
                rowCount++;
            }
        }
        finally { Marshal.FreeHGlobal(dataBuf); }

        var result = new QueryResult
        {
            Columns = columns,
            Rows = rows,
            RowCount = rowCount,
            Truncated = truncated
        };

        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(result, AppJsonContext.Default.QueryResult));
    }

    // ---- Helpers ------------------------------------------
    private static IntPtr Error(string message)
    {
        var err = new ErrorResult { error = message };
        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(err, AppJsonContext.Default.ErrorResult));
    }

    private static string GetDiagnostic(short handleType, IntPtr handle)
    {
        IntPtr buf = Marshal.AllocHGlobal(1024 * 2);
        IntPtr state = Marshal.AllocHGlobal(12);
        try
        {
            int nativeError;
            short textLen;
            short rc = SQLGetDiagRecW(handleType, handle, 1,
                state, out nativeError, buf, 512, out textLen);
            if (rc == SQL_SUCCESS || rc == SQL_SUCCESS_WITH_INFO)
                return Marshal.PtrToStringUni(buf, textLen) ?? "Unknown ODBC error";
            return "Unknown ODBC error";
        }
        finally
        {
            Marshal.FreeHGlobal(buf);
            Marshal.FreeHGlobal(state);
        }
    }

    [DllImport(OdbcDll)]
    private static extern short SQLGetDiagRecW(
        short handleType, IntPtr handle, short recNumber,
        IntPtr sqlState, out int nativeError,
        IntPtr messageText, short bufferLength, out short textLength);

    private static bool IsReadOnlyStatement(string sql)
    {
        var trimmed = sql.TrimStart().ToUpperInvariant();
        return trimmed.StartsWith("SELECT")
            || trimmed.StartsWith("SHOW")
            || trimmed.StartsWith("DESCRIBE")
            || trimmed.StartsWith("EXPLAIN")
            || trimmed.StartsWith("WITH");
    }
}