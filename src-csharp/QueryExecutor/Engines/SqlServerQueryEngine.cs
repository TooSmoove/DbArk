#nullable enable
using System.Collections.Generic;

/// <summary>SQL Server: ODBC-based executor with GO batch splitting and
/// multi-result-set harvesting (STATISTICS XML plans).</summary>
internal sealed class SqlServerQueryEngine : IQueryEngine
{
    public bool UsesBatchPath => true;

    public List<string> SplitBatches(string sql) =>
        SqlServerBatchSplitter.Split(sql);

    public List<QueryResult> ExecuteBatch(string connectionString, string sql) =>
        SqlServerExecutor.ExecuteInternal(connectionString, sql);

    public List<QueryResult> ExecuteStatement(string connectionString, string sql) =>
        SqlServerExecutor.ExecuteInternal(connectionString, sql);

    public int ExecuteNonQuery(string connectionString, string sql) =>
        SqlServerExecutor.ExecuteNonQuery(connectionString, sql);
}
