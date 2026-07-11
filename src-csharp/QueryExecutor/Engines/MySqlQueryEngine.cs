#nullable enable
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>MySQL via MySqlConnector — also serves MariaDB, which is
/// wire-compatible (see the QueryEngines registry).</summary>
internal sealed class MySqlQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        ExecuteMySqlMulti(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { ExecuteMySqlInternal(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        ExecuteNonQueryMySql(connectionString, sql);

    // And change TestMySqlConnection to also delegate to the core helper:
    [UnmanagedCallersOnly(EntryPoint = "test_mysql_connection")]
    public static IntPtr TestMySqlConnection(IntPtr connectionStringPtr)
        => TestMySqlConnectionCore(connectionStringPtr);

    // New shared private helper — no UnmanagedCallersOnly, so it's callable from C#:
    private static IntPtr TestMySqlConnectionCore(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            using var conn = new MySqlConnection(connectionString);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT VERSION()";
            var version = cmd.ExecuteScalar()?.ToString();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to MySQL {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    // MariaDB is wire-compatible with MySQL — delegate to the MySQL test.
    [UnmanagedCallersOnly(EntryPoint = "test_mariadb_connection")]
    public static IntPtr TestMariaDbConnection(IntPtr connectionStringPtr)
     => TestMySqlConnectionCore(connectionStringPtr);

    private static List<QueryResult> ExecuteMySqlMulti(string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return QueryExecutor.HarvestReader(reader);
    }

    private static int ExecuteNonQueryMySql(string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        return cmd.ExecuteNonQuery();
    }

    private static QueryResult ExecuteMySqlInternal(string connectionString, string sql)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return QueryExecutor.ReaderToQueryResult(reader);
    }
}
