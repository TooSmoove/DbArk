#nullable enable
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Data.SqlClient;
using MySqlConnector;
using Npgsql;

public class TableInfo
{
    public string Name { get; set; } = "";
    public string Schema { get; set; } = "";
    public List<ColumnInfo> Columns { get; set; } = new();
}

public class ColumnInfo
{
    public string Name { get; set; } = "";
    public string DataType { get; set; } = "";
    public bool IsNullable { get; set; }
    public bool IsPrimaryKey { get; set; }
}

public class SchemaResult
{
    public List<TableInfo> Tables { get; set; } = new();
    public string? Error { get; set; }
}

[JsonSerializable(typeof(SchemaResult))]
[JsonSerializable(typeof(List<TableInfo>))]
[JsonSerializable(typeof(TableInfo))]
[JsonSerializable(typeof(ColumnInfo))]
[JsonSerializable(typeof(List<ColumnInfo>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class SchemaJsonContext : JsonSerializerContext { }

public static class SchemaExplorerLib
{
    [UnmanagedCallersOnly(EntryPoint = "get_schema")]
    public static IntPtr GetSchema(
        IntPtr connectionStringPtr,
        IntPtr enginePtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";

            var tables = engine.ToLower() switch
            {
                "mysql" => GetMySqlSchema(connectionString),
                "postgres" => GetPostgresSchema(connectionString),
                "sqlite" => GetSqliteSchema(connectionString),
                "sqlserver" => GetSqlServerSchema(connectionString),
                _ => throw new Exception($"Unsupported engine: {engine}")
            };

            var result = new SchemaResult { Tables = tables };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(result, SchemaJsonContext.Default.SchemaResult));
        }
        catch (Exception ex)
        {
            var error = new SchemaResult { Error = ex.Message };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(error, SchemaJsonContext.Default.SchemaResult));
        }
    }

    // ---- MySQL ------------------------------------------------

    private static List<TableInfo> GetMySqlSchema(string connectionString)
    {
        var tables = new Dictionary<string, TableInfo>();

        using var conn = new MySqlConnection(connectionString);
        conn.Open();

        // Get tables
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT TABLE_NAME, TABLE_SCHEMA
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_TYPE = 'BASE TABLE'
                ORDER BY TABLE_NAME";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0);
                tables[name] = new TableInfo
                {
                    Name = name,
                    Schema = reader.GetString(1)
                };
            }
        }

        // Get columns
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT
                    c.TABLE_NAME,
                    c.COLUMN_NAME,
                    c.DATA_TYPE,
                    c.IS_NULLABLE,
                    CASE WHEN k.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
                FROM information_schema.COLUMNS c
                LEFT JOIN information_schema.KEY_COLUMN_USAGE k
                    ON  k.TABLE_SCHEMA    = c.TABLE_SCHEMA
                    AND k.TABLE_NAME      = c.TABLE_NAME
                    AND k.COLUMN_NAME     = c.COLUMN_NAME
                    AND k.CONSTRAINT_NAME = 'PRIMARY'
                WHERE c.TABLE_SCHEMA = DATABASE()
                ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var tableName = reader.GetString(0);
                if (!tables.ContainsKey(tableName)) continue;

                tables[tableName].Columns.Add(new ColumnInfo
                {
                    Name = reader.GetString(1),
                    DataType = reader.GetString(2),
                    IsNullable = reader.GetString(3) == "YES",
                    IsPrimaryKey = reader.GetInt32(4) == 1
                });
            }
        }

        return new List<TableInfo>(tables.Values);
    }

    // ---- PostgreSQL -------------------------------------------

    private static List<TableInfo> GetPostgresSchema(string connectionString)
    {
        var tables = new Dictionary<string, TableInfo>();

        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();

        // Get tables
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT table_name, table_schema
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_type = 'BASE TABLE'
                ORDER BY table_name";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0);
                tables[name] = new TableInfo
                {
                    Name = name,
                    Schema = reader.GetString(1)
                };
            }
        }

        // Get columns
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT
                    c.table_name,
                    c.column_name,
                    c.data_type,
                    c.is_nullable,
                    CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
                FROM information_schema.columns c
                LEFT JOIN (
                    SELECT ku.table_name, ku.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage ku
                        ON tc.constraint_name = ku.constraint_name
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND tc.table_schema = 'public'
                ) pk ON pk.table_name = c.table_name
                    AND pk.column_name = c.column_name
                WHERE c.table_schema = 'public'
                ORDER BY c.table_name, c.ordinal_position";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var tableName = reader.GetString(0);
                if (!tables.ContainsKey(tableName)) continue;

                tables[tableName].Columns.Add(new ColumnInfo
                {
                    Name = reader.GetString(1),
                    DataType = reader.GetString(2),
                    IsNullable = reader.GetString(3) == "YES",
                    IsPrimaryKey = reader.GetBoolean(4)
                });
            }
        }

        return new List<TableInfo>(tables.Values);
    }

    // ---- SQLite -----------------------------------------------

    private static List<TableInfo> GetSqliteSchema(string connectionString)
    {
        string path = connectionString;
        if (connectionString.StartsWith("Data Source=",
            StringComparison.OrdinalIgnoreCase))
            path = connectionString["Data Source=".Length..].Trim();

        var tables = new List<TableInfo>();

        IntPtr db = IntPtr.Zero;
        SqliteOpen(path, ref db);

        try
        {
            // Get table names
            var tableNames = new List<string>();
            IntPtr stmt = IntPtr.Zero;
            SqlitePrepareV2(db,
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                -1, ref stmt, IntPtr.Zero);
            try
            {
                while (SqliteStep(stmt) == 100)
                    tableNames.Add(
                        Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 0)) ?? "");
            }
            finally { SqliteFinalize(stmt); }

            // Get columns per table via PRAGMA
            foreach (var tableName in tableNames)
            {
                var table = new TableInfo { Name = tableName, Schema = "main" };

                IntPtr colStmt = IntPtr.Zero;
                SqlitePrepareV2(db, $"PRAGMA table_info(\"{tableName}\")",
                    -1, ref colStmt, IntPtr.Zero);
                try
                {
                    while (SqliteStep(colStmt) == 100)
                    {
                        table.Columns.Add(new ColumnInfo
                        {
                            Name = Marshal.PtrToStringUTF8(SqliteColumnText(colStmt, 1)) ?? "",
                            DataType = Marshal.PtrToStringUTF8(SqliteColumnText(colStmt, 2)) ?? "",
                            IsNullable = SqliteColumnInt(colStmt, 3) == 0,
                            IsPrimaryKey = SqliteColumnInt(colStmt, 5) > 0
                        });
                    }
                }
                finally { SqliteFinalize(colStmt); }

                tables.Add(table);
            }
        }
        finally { SqliteClose(db); }

        return tables;
    }

    private static List<TableInfo> GetSqlServerSchema(string connectionString)
    {
        var tables = new Dictionary<string, TableInfo>();

        // Use ODBC for SQL Server
        var tableResult = SqlServerOdbc.Query(connectionString, @"
        SELECT TABLE_NAME, TABLE_SCHEMA
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME");

        foreach (var row in tableResult)
        {
            var name = row[0] ?? "";
            if (string.IsNullOrEmpty(name)) continue;
            tables[name] = new TableInfo { Name = name, Schema = row[1] ?? "" };
        }

        var colResult = SqlServerOdbc.Query(connectionString, @"
        SELECT
            c.TABLE_NAME,
            c.COLUMN_NAME,
            c.DATA_TYPE,
            c.IS_NULLABLE,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
            SELECT ku.TABLE_NAME, ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk ON pk.TABLE_NAME = c.TABLE_NAME
            AND pk.COLUMN_NAME = c.COLUMN_NAME
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION");

        foreach (var row in colResult)
        {
            var tableName = row[0] ?? "";
            if (!tables.ContainsKey(tableName)) continue;
            tables[tableName].Columns.Add(new ColumnInfo
            {
                Name = row[1] ?? "",
                DataType = row[2] ?? "",
                IsNullable = row[3] == "YES",
                IsPrimaryKey = row[4] == "1"
            });
        }

        return new List<TableInfo>(tables.Values);
    }

    // ---- winsqlite3 P/Invoke ----------------------------------

    private const string SqliteDll = "winsqlite3.dll";

    [DllImport(SqliteDll, EntryPoint = "sqlite3_open")]
    private static extern int SqliteOpen(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string filename, ref IntPtr db);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_close")]
    private static extern int SqliteClose(IntPtr db);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_prepare_v2")]
    private static extern int SqlitePrepareV2(
        IntPtr db,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        int nByte, ref IntPtr stmt, IntPtr pzTail);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_step")]
    private static extern int SqliteStep(IntPtr stmt);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_finalize")]
    private static extern int SqliteFinalize(IntPtr stmt);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_text")]
    private static extern IntPtr SqliteColumnText(IntPtr stmt, int col);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_int")]
    private static extern int SqliteColumnInt(IntPtr stmt, int col);
}
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
    [DllImport(OdbcDll)] static extern short SQLGetData(IntPtr s, short c, short t, IntPtr v, int b, out int ind);
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
                        SQLGetData(hStmt, i, SQL_C_WCHAR, buf, 4096, out int ind);
                        row[i - 1] = ind == SQL_NULL_DATA ? null
                            : Marshal.PtrToStringUni(buf, ind / 2);
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