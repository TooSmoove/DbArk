#nullable enable
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;

/// <summary>PostgreSQL via Npgsql.</summary>
internal sealed class PostgresQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        ExecutePostgresMulti(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { ExecutePostgresInternal(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        ExecuteNonQueryPostgres(connectionString, sql);

    [UnmanagedCallersOnly(EntryPoint = "test_postgres_connection")]
    public static IntPtr TestPostgresConnection(IntPtr connectionStringPtr)
    {
        try
        {
            string? connectionString = Marshal.PtrToStringUTF8(connectionStringPtr);
            if (string.IsNullOrEmpty(connectionString))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty connection string");

            using var conn = new NpgsqlConnection(connectionString);
            conn.Open();
            using var cmd = conn.CreateCommand();
            cmd.CommandText = "SELECT VERSION()";
            var version = cmd.ExecuteScalar()?.ToString();
            return Marshal.StringToCoTaskMemUTF8($"OK: Connected to PostgreSQL {version}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    private static List<QueryResult> ExecutePostgresMulti(string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return QueryExecutor.HarvestReader(reader);
    }

    private static int ExecuteNonQueryPostgres(string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        return cmd.ExecuteNonQuery();
    }

    private static QueryResult ExecutePostgresInternal(string connectionString, string sql)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.CommandTimeout = 30;
        using var reader = cmd.ExecuteReader();
        return QueryExecutor.ReaderToQueryResult(reader);
    }
}
