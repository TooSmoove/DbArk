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
    // 256 KB buffer. Covers ShowPlanXML for typical queries (usually under
    // 50-100 KB), large NVARCHAR(MAX), JSON, and most "big" columns in a
    // single call. Values larger than this are handled by the chunked
    // fallback path in SerialiseResultsInternal.
    private const int SQL_COLUMN_BUFFER_SIZE = 262_144;

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
    [DllImport(OdbcDll)] private static extern short SQLRowCount(IntPtr stmtHandle, out int rowCount);
    [DllImport(OdbcDll, CharSet = CharSet.Unicode)] private static extern short SQLMoreResults(IntPtr hStmt);

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
        var err = new ErrorResult { Error = message };
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
    public static int ExecuteNonQuery(string connectionString, string sql)
    {
        IntPtr hEnv = IntPtr.Zero;
        IntPtr hDbc = IntPtr.Zero;
        IntPtr hStmt = IntPtr.Zero;

        try
        {
            SQLAllocHandle(SQL_HANDLE_ENV, IntPtr.Zero, out hEnv);
            SQLSetEnvAttr(hEnv, SQL_ATTR_ODBC_VERSION, new IntPtr(SQL_OV_ODBC3), 0);
            SQLAllocHandle(SQL_HANDLE_DBC, hEnv, out hDbc);

            short outLen;
            short rc = SQLDriverConnectW(hDbc, IntPtr.Zero,
                connectionString, SQL_NTS,
                IntPtr.Zero, 0, out outLen, 0);

            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return -1;

            SQLAllocStmt(hDbc, out hStmt);
            SQLSetStmtAttrW(hStmt, SQL_ATTR_QUERY_TIMEOUT, new IntPtr(30), 0);

            rc = SQLExecDirectW(hStmt, sql, SQL_NTS);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return -1;

            // Get row count
            int rowCount;
            SQLRowCount(hStmt, out rowCount);
            return rowCount;
        }
        catch { return -1; }
        finally
        {
            if (hStmt != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_STMT, hStmt);
            if (hDbc != IntPtr.Zero) { SQLDisconnect(hDbc); SQLFreeHandle(SQL_HANDLE_DBC, hDbc); }
            if (hEnv != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_ENV, hEnv);
        }
    }
    public static QueryResult ExecuteInternal(
    string connectionString, string sql)
    {
        IntPtr hEnv = IntPtr.Zero;
        IntPtr hDbc = IntPtr.Zero;
        IntPtr hStmt = IntPtr.Zero;

        try
        {
            SQLAllocHandle(SQL_HANDLE_ENV, IntPtr.Zero, out hEnv);
            SQLSetEnvAttr(hEnv, SQL_ATTR_ODBC_VERSION,
                new IntPtr(SQL_OV_ODBC3), 0);
            SQLAllocHandle(SQL_HANDLE_DBC, hEnv, out hDbc);

            short outLen;
            short rc = SQLDriverConnectW(
                hDbc, IntPtr.Zero,
                connectionString, SQL_NTS,
                IntPtr.Zero, 0, out outLen, 0);

            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return new QueryResult
                {
                    Error = GetDiagnostic(SQL_HANDLE_DBC, hDbc)
                };

            SQLAllocStmt(hDbc, out hStmt);
            SQLSetStmtAttrW(hStmt, SQL_ATTR_QUERY_TIMEOUT,
                new IntPtr(30), 0);

            rc = SQLExecDirectW(hStmt, sql, SQL_NTS);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return new QueryResult
                {
                    Error = GetDiagnostic(SQL_HANDLE_STMT, hStmt)
                };

            QueryResult? firstNonEmpty = null;
            QueryResult? planResult = null;

            while (true)
            {
                short numCols;
                SQLNumResultCols(hStmt, out numCols);

                // numCols == 0 means this was a non-rowset statement (SET, etc).
                // Skip to the next result set if any.
                if (numCols > 0)
                {
                    var result = SerialiseResultsInternal(hStmt);
                    if (result.Rows.Count > 0)
                    {
                        firstNonEmpty ??= result;
                        // Detect a plan rowset: single column whose first
                        // cell starts with `<`. SQL Server's plan column
                        // is named "Microsoft SQL Server N XML Showplan"
                        // but the exact version number varies, so we use
                        // content detection rather than column name match.
                        if (result.Columns.Count == 1
                            && result.Rows.Count > 0
                            && result.Rows[0].Count > 0
                            && result.Rows[0][0] is string s
                            && s.TrimStart().StartsWith("<"))
                        {
                            planResult = result;
                        }
                    }
                }

                short mrc = SQLMoreResults(hStmt);
                if (mrc != SQL_SUCCESS && mrc != SQL_SUCCESS_WITH_INFO) break;
            }

            // Prefer the plan rowset (if STATISTICS XML was used), otherwise
            // the first non-empty rowset (normal query path), otherwise an
            // empty result so React doesn't get null.
            return planResult
                ?? firstNonEmpty
                ?? new QueryResult { Columns = new List<string>(), Rows = new List<List<string?>>() };
        }
        catch (Exception ex)
        {
            return new QueryResult { Error = ex.Message };
        }
        finally
        {
            if (hStmt != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_STMT, hStmt);
            if (hDbc != IntPtr.Zero)
            {
                SQLDisconnect(hDbc);
                SQLFreeHandle(SQL_HANDLE_DBC, hDbc);
            }
            if (hEnv != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_ENV, hEnv);
        }
    }

    private static QueryResult SerialiseResultsInternal(IntPtr hStmt)
    {
        SQLNumResultCols(hStmt, out short colCount);

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
                        continue;
                    }
                    if (rc2 != SQL_SUCCESS && rc2 != SQL_SUCCESS_WITH_INFO)
                    {
                        row.Add(null);
                        continue;
                    }

                    if (rc2 == SQL_SUCCESS)
                    {
                        // Value fit in the buffer. indicator is bytes
                        // copied, excluding null terminator.
                        int safeBytes = Math.Min(
                            Math.Max(0, indicator),
                            SQL_COLUMN_BUFFER_SIZE);
                        row.Add(Marshal.PtrToStringUni(dataBuf, safeBytes / 2));
                        continue;
                    }

                    // rc == SQL_SUCCESS_WITH_INFO: value was larger than
                    // our buffer. We have the first chunk in dataBuf.
                    // If indicator is a real positive length, allocate a
                    // larger buffer sized to exactly fit and re-read the
                    // remainder. If indicator is SQL_NO_TOTAL (driver
                    // doesn't know the total), fall back to keeping just
                    // the buffer-sized prefix to avoid the heap-corruption
                    // path; the value will be truncated but we don't crash.
                    if (indicator > 0 && indicator > SQL_COLUMN_BUFFER_SIZE)
                    {
                        // Indicator gives total bytes needed (excluding
                        // terminator). Allocate that plus 2 bytes for
                        // safety.
                        int totalBytes = indicator + 2;
                        IntPtr bigBuf = Marshal.AllocHGlobal(totalBytes);
                        try
                        {
                            // Copy the partial data we already read into
                            // the start of the new buffer. We received
                            // (SQL_COLUMN_BUFFER_SIZE - 2) usable bytes
                            // before the null terminator.
                            int alreadyRead = SQL_COLUMN_BUFFER_SIZE - 2;
                            for (int b = 0; b < alreadyRead; b++)
                            {
                                Marshal.WriteByte(bigBuf, b,
                                    Marshal.ReadByte(dataBuf, b));
                            }

                            // Read the remainder into the larger buffer
                            // starting at the offset after what we copied.
                            IntPtr remainderStart = IntPtr.Add(bigBuf, alreadyRead);
                            int remainderCapacity = totalBytes - alreadyRead;
                            short rc3 = SQLGetData(hStmt, i, SQL_C_WCHAR,
                                remainderStart, remainderCapacity, out int ind2);

                            if (rc3 == SQL_SUCCESS || rc3 == SQL_SUCCESS_WITH_INFO)
                            {
                                // Total chars in the assembled buffer.
                                int validBytes = alreadyRead +
                                    (ind2 > 0 ? Math.Min(ind2, remainderCapacity) : 0);
                                row.Add(Marshal.PtrToStringUni(bigBuf, validBytes / 2));
                            }
                            else
                            {
                                // Couldn't finish reading — return what we
                                // had from the first chunk only.
                                row.Add(Marshal.PtrToStringUni(dataBuf, alreadyRead / 2));
                            }
                        }
                        finally
                        {
                            Marshal.FreeHGlobal(bigBuf);
                        }
                    }
                    else
                    {
                        // SQL_NO_TOTAL or unexpected value — driver can't
                        // tell us the size. Keep the chunk we have and
                        // mark as truncated. Better than risking corruption.
                        int safePrefix = SQL_COLUMN_BUFFER_SIZE - 2;
                        row.Add(Marshal.PtrToStringUni(dataBuf, safePrefix / 2));
                        truncated = true;
                    }
                }
                rows.Add(row);
                rowCount++;
            }
        }
        finally { Marshal.FreeHGlobal(dataBuf); }

        return new QueryResult
        {
            Columns = columns,
            Rows = rows,
            RowCount = rowCount,
            Truncated = truncated,
        };
    }
}