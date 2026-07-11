#nullable enable
using System;
using System.Collections.Generic;

/// <summary>SQLite via the in-process winsqlite3 bridge. Still on the legacy
/// statement-by-statement path — its stage-2 batch migration is pending.</summary>
internal sealed class SqliteQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => false;

    public List<string> SplitBatches(string sql) => new() { sql };

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        throw new InvalidOperationException(
            "ExecuteBatch reached for engine 'sqlite' before its stage-2 migration.");

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        new() { QueryExecutor.ExecuteSqliteCore(connectionString, sql) };

    public int ExecuteNonQuery(string connectionString, string sql) =>
        QueryExecutor.ExecuteNonQuerySqlite(connectionString, sql);
}
