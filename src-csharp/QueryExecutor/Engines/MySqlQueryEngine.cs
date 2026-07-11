#nullable enable
using System.Collections.Generic;

/// <summary>MySQL via MySqlConnector — also serves MariaDB, which is
/// wire-compatible (see the QueryEngines registry).</summary>
internal sealed class MySqlQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        QueryExecutor.ExecuteMySqlMulti(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { QueryExecutor.ExecuteMySqlInternal(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        QueryExecutor.ExecuteNonQueryMySql(connectionString, sql);
}
