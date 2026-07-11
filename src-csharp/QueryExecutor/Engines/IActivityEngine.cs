#nullable enable
using System;
using System.Collections.Generic;

/// <summary>
/// Server-activity operations for one database engine (audit A-2): read the
/// live session list and kill a session by id. SQLite has no server, so its
/// implementation refuses both — the same guard the old switches enforced.
/// </summary>
internal interface IActivityEngine
{
    List<ActivityRow> ReadActivity(string connectionString);
    void KillSession(string connectionString, string pid);
}

/// <summary>Engine-name → implementation registry for the activity panel.
/// MariaDB reuses MySQL; CockroachDB reuses Postgres (wire-compatible).</summary>
internal static class ActivityEngines
{
    private static readonly Dictionary<string, IActivityEngine> Registry = Build();

    private static Dictionary<string, IActivityEngine> Build()
    {
        var sqlServer = new SqlServerActivityEngine();
        var postgres = new PostgresActivityEngine();
        var mySql = new MySqlActivityEngine();
        return new Dictionary<string, IActivityEngine>(StringComparer.OrdinalIgnoreCase)
        {
            ["sqlserver"] = sqlServer,
            ["postgres"] = postgres,
            ["cockroachdb"] = postgres,
            ["mysql"] = mySql,
            ["mariadb"] = mySql,
            ["sqlite"] = new SqliteActivityEngine(),
        };
    }

    public static IActivityEngine Resolve(string engine) =>
        Registry.TryGetValue(engine, out var impl)
            ? impl
            : throw new InvalidOperationException($"Unknown engine: {engine}");
}

internal sealed class SqlServerActivityEngine : IActivityEngine
{
    public List<ActivityRow> ReadActivity(string connectionString) =>
        ActivityExecutor.ReadSqlServer(connectionString);
    public void KillSession(string connectionString, string pid) =>
        ActivityExecutor.KillSqlServer(connectionString, pid);
}

internal sealed class PostgresActivityEngine : IActivityEngine
{
    public List<ActivityRow> ReadActivity(string connectionString) =>
        ActivityExecutor.ReadPostgres(connectionString);
    public void KillSession(string connectionString, string pid) =>
        ActivityExecutor.KillPostgres(connectionString, pid);
}

internal sealed class MySqlActivityEngine : IActivityEngine
{
    public List<ActivityRow> ReadActivity(string connectionString) =>
        ActivityExecutor.ReadMySql(connectionString);
    public void KillSession(string connectionString, string pid) =>
        ActivityExecutor.KillMySql(connectionString, pid);
}

/// <summary>SQLite is a local file — there is no server activity to show and
/// no session to kill. The Rust host hides the panel; this is the defensive
/// backstop with the exact messages the old switches produced.</summary>
internal sealed class SqliteActivityEngine : IActivityEngine
{
    public List<ActivityRow> ReadActivity(string connectionString) =>
        throw new InvalidOperationException("Activity panel is not supported for SQLite");
    public void KillSession(string connectionString, string pid) =>
        throw new InvalidOperationException("Kill is not supported for SQLite");
}
