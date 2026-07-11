#nullable enable
using System.Collections.Generic;

/// <summary>CockroachDB: Postgres wire protocol via Npgsql, with
/// Cockroach-specific connection/retry handling.</summary>
internal sealed class CockroachDbQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        QueryExecutor.ExecuteCockroachDbMulti(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { QueryExecutor.ExecuteCockroachDbInternal(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        QueryExecutor.ExecuteNonQueryCockroachDb(connectionString, sql);
}
