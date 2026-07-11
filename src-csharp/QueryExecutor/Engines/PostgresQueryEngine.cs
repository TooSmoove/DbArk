#nullable enable
using System.Collections.Generic;

/// <summary>PostgreSQL via Npgsql.</summary>
internal sealed class PostgresQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        QueryExecutor.ExecutePostgresMulti(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { QueryExecutor.ExecutePostgresInternal(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        QueryExecutor.ExecuteNonQueryPostgres(connectionString, sql);
}
