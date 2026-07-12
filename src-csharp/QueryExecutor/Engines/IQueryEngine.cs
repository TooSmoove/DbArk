#nullable enable
using System;
using System.Collections.Generic;

/// <summary>
/// Everything the query pipeline can ask of one database engine (audit A-2).
/// The orchestration in QueryExecutor (read-only enforcement, DDL rewrite,
/// batch splitting policy, result bookkeeping) is engine-agnostic; every
/// engine-specific decision is answered by an implementation of this
/// interface, resolved once through <see cref="QueryEngines"/>.
/// </summary>
public interface IQueryEngine
{
    /// <summary>True when this engine runs whole batches through
    /// <see cref="ExecuteBatch"/>; false for engines still on the legacy
    /// statement-by-statement path (SQLite).</summary>
    bool UsesBatchPath { get; }

    /// <summary>Split raw editor SQL into executable batches. Only T-SQL has
    /// a batch separator (GO); other engines run the text as one batch.</summary>
    List<string> SplitBatches(string sql);

    /// <summary>Execute one batch, harvesting every result set it produces.</summary>
    List<QueryResult> ExecuteBatch(string connectionString, string sql);

    /// <summary>Execute a single (already split) statement on the legacy path.</summary>
    List<QueryResult> ExecuteStatement(string connectionString, string sql);

    /// <summary>Execute a non-query statement, returning rows affected.</summary>
    int ExecuteNonQuery(string connectionString, string sql);
}

/// <summary>
/// The engine registry — the single place an engine name from the wire maps to
/// an implementation. Wire-compatibility is expressed here once: MariaDB
/// reuses the MySQL implementation (same MySqlConnector driver) and
/// CockroachDB gets its own (Postgres driver, Cockroach-specific retries).
/// </summary>
public static class QueryEngines
{
    public static readonly Dictionary<string, IQueryEngine> Registry = Build();

    public static Dictionary<string, IQueryEngine> Build()
    {
        var mySql = new MySqlQueryEngine();
        return new Dictionary<string, IQueryEngine>(StringComparer.OrdinalIgnoreCase)
        {
            [EngineNames.SqlServer] = new SqlServerQueryEngine(),
            [EngineNames.Postgres] = new PostgresQueryEngine(),
            [EngineNames.CockroachDb] = new CockroachDbQueryEngine(),
            [EngineNames.MySql] = mySql,
            [EngineNames.MariaDb] = mySql,
            [EngineNames.Sqlite] = new SqliteQueryEngine(),
        };
    }

    public static IQueryEngine Resolve(string engine) =>
        Registry.TryGetValue(engine, out var impl)
            ? impl
            : throw new InvalidOperationException($"Unsupported engine: {engine}");
}
