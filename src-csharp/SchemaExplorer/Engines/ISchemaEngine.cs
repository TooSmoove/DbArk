#nullable enable
using System;
using System.Collections.Generic;

/// <summary>
/// Everything the host can ask of one database engine's schema explorer
/// (audit A-2). One implementation per engine; wire-compatible engines share
/// an implementation via <see cref="SchemaEngines"/>. Adding an engine is one
/// new implementation class plus one registry entry — there are no
/// engine-name switches left to hunt down.
/// </summary>
internal interface ISchemaEngine
{
    /// <summary>Tables, columns, procedures, functions, views, triggers,
    /// indexes and foreign keys for the connected database.</summary>
    SchemaResult GetFullSchema(string connectionString);

    /// <summary>Databases/schemata visible to this login, server- or
    /// cluster-wide. Empty for single-file engines (SQLite).</summary>
    List<string> ListDatabases(string connectionString);

    /// <summary>CREATE/definition text for one named object.</summary>
    string GetObjectDefinition(
        string connectionString, string objectName, string objectType, string schemaName);
}

/// <summary>
/// The engine registry — the single place where an engine name from the wire
/// is mapped to an implementation. Wire-compatibility is expressed here once:
/// MariaDB reuses the MySQL implementation (same MySqlConnector driver) and
/// CockroachDB reuses the Postgres implementation (Postgres wire protocol).
/// </summary>
internal static class SchemaEngines
{
    private static readonly Dictionary<string, ISchemaEngine> Registry = Build();

    private static Dictionary<string, ISchemaEngine> Build()
    {
        var sqlServer = new SqlServerSchemaEngine();
        var mySql = new MySqlSchemaEngine();
        var postgres = new PostgresSchemaEngine();
        var sqlite = new SqliteSchemaEngine();
        return new Dictionary<string, ISchemaEngine>(StringComparer.OrdinalIgnoreCase)
        {
            ["sqlserver"] = sqlServer,
            ["mysql"] = mySql,
            ["mariadb"] = mySql,
            ["postgres"] = postgres,
            ["cockroachdb"] = postgres,
            ["sqlite"] = sqlite,
        };
    }

    /// <summary>Resolve an engine name (case-insensitive) or throw the same
    /// "Unsupported engine" error the old switches produced.</summary>
    public static ISchemaEngine Resolve(string engine) =>
        Registry.TryGetValue(engine, out var impl)
            ? impl
            : throw new Exception($"Unsupported engine: {engine}");
}
