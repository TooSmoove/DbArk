#nullable enable
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>CockroachDB: Postgres wire protocol via Npgsql, with
/// Cockroach-specific connection/retry handling.</summary>
internal sealed class CockroachDbQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        ExecuteCockroachDbMulti(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { ExecuteCockroachDbInternal(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        ExecuteNonQueryCockroachDb(connectionString, sql);

    // CockroachDB uses Npgsql but requires SSL to be set programmatically —
    // see OpenCockroachDbConnection for the reason.
    [UnmanagedCallersOnly(EntryPoint = "test_cockroachdb_connection")]
    public static IntPtr TestCockroachDbConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            using var conn = OpenCockroachDbConnection(connectionString);
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT version()";
            var version = cmd.ExecuteScalar()?.ToString();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to CockroachDB {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    private static List<QueryResult> ExecuteCockroachDbMulti(string connectionString, string sql)
    {
        using var conn = OpenCockroachDbConnection(connectionString); // already open
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return QueryExecutor.HarvestReader(reader);
    }

    private static QueryResult ExecuteCockroachDbInternal(string connectionString, string sql)
    {
        using var conn = OpenCockroachDbConnection(connectionString);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return QueryExecutor.ReaderToQueryResult(reader);
    }

    private static int ExecuteNonQueryCockroachDb(string connectionString, string sql)
    {
        using var conn = OpenCockroachDbConnection(connectionString);
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        return cmd.ExecuteNonQuery();
    }

    private static NpgsqlConnection OpenCockroachDbConnection(string connectionString)
    {
        var parsed = new NpgsqlConnectionStringBuilder(connectionString);
        var dsBuilder = new NpgsqlDataSourceBuilder();
        var csb = dsBuilder.ConnectionStringBuilder;
        csb.Host = parsed.Host;
        csb.Port = parsed.Port;
        csb.Database = parsed.Database;
        csb.Username = parsed.Username;
        csb.Password = parsed.Password;
        csb.SslMode = SslMode.Disable; // enum still present in Npgsql 8
        csb.Pooling = false;           // prevent stale pool entries
        using var dataSource = dsBuilder.Build();
        return dataSource.OpenConnection();
    }
}
