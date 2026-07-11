#nullable enable
using System;
using System.Collections.Generic;

/// <summary>
/// The live-database side of the flat-file join (audit A-2): how to list a
/// database's tables and how to run the extraction query whose rows get
/// registered into DuckDB. One implementation per engine; wire-compatible
/// engines share one via <see cref="DbBridges"/>.
/// </summary>
internal interface IDbBridge
{
    /// <summary>Catalog query returning one row per user table, first column
    /// = table name.</summary>
    string ListTablesSql { get; }

    /// <summary>Run <paramref name="sql"/> and serialise the result to the
    /// bridge's JSON envelope ({"columns":[...],"rows":[...]} or {"error":...}).</summary>
    string Execute(string connectionString, string sql);
}

/// <summary>Engine-name → implementation registry for the file-join bridge.
/// MariaDB reuses MySQL; CockroachDB reuses Postgres (wire-compatible).</summary>
internal static class DbBridges
{
    private static readonly Dictionary<string, IDbBridge> Registry = Build();

    private static Dictionary<string, IDbBridge> Build()
    {
        var mySql = new MySqlDbBridge();
        var postgres = new PostgresDbBridge();
        return new Dictionary<string, IDbBridge>(StringComparer.OrdinalIgnoreCase)
        {
            [EngineNames.MySql] = mySql,
            [EngineNames.MariaDb] = mySql,
            [EngineNames.Postgres] = postgres,
            [EngineNames.CockroachDb] = postgres,
            [EngineNames.Sqlite] = new SqliteDbBridge(),
            [EngineNames.SqlServer] = new SqlServerDbBridge(),
        };
    }

    public static IDbBridge Resolve(string engine) =>
        Registry.TryGetValue(engine, out var impl)
            ? impl
            : throw new Exception($"Unsupported engine: {engine}");
}

internal sealed class MySqlDbBridge : IDbBridge
{
    public string ListTablesSql => "SHOW TABLES";
    public string Execute(string connectionString, string sql) =>
        FileQueryEngineLib.ExecuteMySql(connectionString, sql);
}

internal sealed class PostgresDbBridge : IDbBridge
{
    public string ListTablesSql =>
        "SELECT tablename AS table_name FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename";
    public string Execute(string connectionString, string sql) =>
        FileQueryEngineLib.ExecutePostgres(connectionString, sql);
}

internal sealed class SqliteDbBridge : IDbBridge
{
    public string ListTablesSql =>
        "SELECT name AS table_name FROM sqlite_master WHERE type='table' ORDER BY name";
    public string Execute(string connectionString, string sql) =>
        FileQueryEngineLib.ExecuteSqliteDb(connectionString, sql);
}

internal sealed class SqlServerDbBridge : IDbBridge
{
    public string ListTablesSql =>
        "SELECT TABLE_NAME AS table_name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME";
    public string Execute(string connectionString, string sql) =>
        FileQueryEngineLib.ExecuteSqlServer(connectionString, sql);
}
