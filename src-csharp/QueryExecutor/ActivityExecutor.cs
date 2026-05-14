#nullable enable
using MySqlConnector;
using Microsoft.Data.SqlClient;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

// ─── Activity executor ────────────────────────────────────────────────────────
// Lists active server queries and provides session-kill for non-SQLite engines.
// Mirrors QueryExecutor's NativeAOT pattern:
//   - IntPtr in, IntPtr out
//   - Each entry point catches all exceptions and returns a JSON envelope
//   - Source-generated JsonContext for AOT compatibility
//
// SQLite has no concept of activity — Rust must hide the panel for SQLite
// connections and never invoke these methods with engine="sqlite".
// ─────────────────────────────────────────────────────────────────────────────

public static class ActivityExecutor
{
    // ── Per-engine SQL for listing active queries ───────────────────────────
    //
    // Each query is chosen to expose the same set of columns so the C# side
    // can iterate rows without engine-specific branching downstream:
    //   pid, user, database, state, duration_ms, query, host
    //
    // Filters:
    //   - Excludes the connection's own session — preventing the user from
    //     killing the very connection that's polling for activity.
    //   - SQL Server: excludes system processes (is_user_process = 1).
    //   - MySQL: excludes 'Sleep' state — those are idle pooled connections.
    //   - Postgres: excludes 'idle' state for the same reason.

    private const string SQL_SQLSERVER = @"
        SELECT
            CAST(r.session_id AS NVARCHAR(50))     AS pid,
            ISNULL(s.login_name, '')               AS [user],
            ISNULL(DB_NAME(r.database_id), '')     AS [database],
            ISNULL(r.status, '')                   AS state,
            DATEDIFF(MILLISECOND, r.start_time, GETDATE()) AS duration_ms,
            ISNULL(SUBSTRING(t.text,
                (r.statement_start_offset / 2) + 1,
                ((CASE r.statement_end_offset
                    WHEN -1 THEN DATALENGTH(t.text)
                    ELSE r.statement_end_offset
                  END - r.statement_start_offset) / 2) + 1), '') AS query,
            ISNULL(s.host_name, '')                AS host
        FROM sys.dm_exec_requests r
        JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
        CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) t
        WHERE s.is_user_process = 1
          AND r.session_id <> @@SPID
        ORDER BY r.start_time";

    // Note: pg_stat_activity columns vary slightly between Postgres versions
    // and CockroachDB. The columns used here (pid, usename, datname, state,
    // query_start, query, client_addr) are stable across PG 10+ and present
    // in CockroachDB — though CockroachDB may populate some as NULL.
    // COALESCE handles the NULL cases gracefully.
    private const string SQL_POSTGRES = @"
        SELECT
            pid::text                                              AS pid,
            COALESCE(usename, '')                                  AS ""user"",
            COALESCE(datname, '')                                  AS ""database"",
            COALESCE(state, '')                                    AS state,
            (EXTRACT(EPOCH FROM (NOW() - query_start)) * 1000)::int AS duration_ms,
            COALESCE(query, '')                                    AS query,
            COALESCE(client_addr::text, '')                        AS host
        FROM pg_stat_activity
        WHERE state IS NOT NULL
          AND state <> 'idle'
          AND pid <> pg_backend_pid()
        ORDER BY query_start NULLS LAST";

    // MySQL/MariaDB: INFO is the query text and is NULL for connections that
    // have nothing executing. The COMMAND='Sleep' filter removes idle pooled
    // connections that would otherwise dominate the list.
    private const string SQL_MYSQL = @"
        SELECT
            CAST(ID AS CHAR(20))    AS pid,
            COALESCE(USER, '')      AS user,
            COALESCE(DB, '')        AS `database`,
            COALESCE(COMMAND, '')   AS state,
            COALESCE(TIME, 0) * 1000 AS duration_ms,
            COALESCE(INFO, '')      AS query,
            COALESCE(HOST, '')      AS host
        FROM information_schema.PROCESSLIST
        WHERE COMMAND <> 'Sleep'
          AND ID <> CONNECTION_ID()
        ORDER BY TIME DESC";

    // ── NativeAOT entry: get_activity ───────────────────────────────────────
    [UnmanagedCallersOnly(EntryPoint = "get_activity")]
    public static IntPtr GetActivity(IntPtr connectionStringPtr, IntPtr enginePtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = (Marshal.PtrToStringUTF8(enginePtr) ?? "").ToLowerInvariant();

            if (string.IsNullOrEmpty(connectionString))
                return ReturnError("empty connection string");

            // Route to engine-specific reader. SQLite is rejected here as a
            // defensive guard — Rust should already be hiding the panel.
            List<ActivityRow> rows = engine switch
            {
                "sqlserver" => ReadSqlServer(connectionString),
                "postgres" => ReadPostgres(connectionString),
                "cockroachdb" => ReadPostgres(connectionString),
                "mysql" => ReadMySql(connectionString),
                "mariadb" => ReadMySql(connectionString),
                "sqlite" => throw new InvalidOperationException(
                                    "Activity panel is not supported for SQLite"),
                _ => throw new InvalidOperationException(
                                    $"Unknown engine: {engine}"),
            };

            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(
                    new ActivityResult { Rows = rows },
                    ActivityJsonContext.Default.ActivityResult));
        }
        catch (Exception ex)
        {
            return ReturnError(ex.Message);
        }
    }

    // ── NativeAOT entry: kill_session ───────────────────────────────────────
    // The kill statement is engine-specific. The DB itself enforces that the
    // calling user can only kill their own sessions unless they have elevated
    // privileges — we rely on that rather than implementing ownership checks.
    [UnmanagedCallersOnly(EntryPoint = "kill_session")]
    public static IntPtr KillSession(
        IntPtr connectionStringPtr,
        IntPtr enginePtr,
        IntPtr pidPtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = (Marshal.PtrToStringUTF8(enginePtr) ?? "").ToLowerInvariant();
            var pid = Marshal.PtrToStringUTF8(pidPtr) ?? "";

            if (string.IsNullOrEmpty(connectionString))
                return ReturnError("empty connection string");
            if (string.IsNullOrEmpty(pid))
                return ReturnError("empty pid");

            // Defensive: ensure pid is purely numeric. Prevents SQL injection
            // via crafted JSON values from any layer that bypasses Rust's
            // string-typed argument. The kill statements interpolate pid
            // directly because parameterised statements don't work for KILL
            // syntax in SQL Server or MySQL.
            if (!long.TryParse(pid, out _))
                return ReturnError($"invalid pid: {pid}");

            switch (engine)
            {
                case "sqlserver":
                    KillSqlServer(connectionString, pid);
                    break;
                case "postgres":
                case "cockroachdb":
                    KillPostgres(connectionString, pid);
                    break;
                case "mysql":
                case "mariadb":
                    KillMySql(connectionString, pid);
                    break;
                case "sqlite":
                    return ReturnError("Kill is not supported for SQLite");
                default:
                    return ReturnError($"Unknown engine: {engine}");
            }

            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(
                    new KillResult { Ok = true },
                    ActivityJsonContext.Default.KillResult));
        }
        catch (Exception ex)
        {
            return ReturnError(ex.Message);
        }
    }

    // ── Per-engine row readers ──────────────────────────────────────────────

    private static List<ActivityRow> ReadSqlServer(string connectionString)
    {
        using var conn = new SqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = SQL_SQLSERVER;
        cmd.CommandTimeout = 10;
        using var reader = cmd.ExecuteReader();
        return ReadRows(reader);
    }

    private static List<ActivityRow> ReadPostgres(string connectionString)
    {
        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = SQL_POSTGRES;
        cmd.CommandTimeout = 10;
        using var reader = cmd.ExecuteReader();
        return ReadRows(reader);
    }

    private static List<ActivityRow> ReadMySql(string connectionString)
    {
        using var conn = new MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = SQL_MYSQL;
        cmd.CommandTimeout = 10;
        using var reader = cmd.ExecuteReader();
        return ReadRows(reader);
    }

    // Shared reader → row mapper. The SQL above ensures all engines produce
    // the same column order, so positional access is safe.
    private static List<ActivityRow> ReadRows(System.Data.IDataReader reader)
    {
        var rows = new List<ActivityRow>();
        const int rowLimit = 500; // sanity cap — busy servers can have thousands

        while (reader.Read() && rows.Count < rowLimit)
        {
            rows.Add(new ActivityRow
            {
                Pid = reader.IsDBNull(0) ? "" : reader.GetValue(0)?.ToString() ?? "",
                User = reader.IsDBNull(1) ? "" : reader.GetValue(1)?.ToString() ?? "",
                Database = reader.IsDBNull(2) ? "" : reader.GetValue(2)?.ToString() ?? "",
                State = reader.IsDBNull(3) ? "" : reader.GetValue(3)?.ToString() ?? "",
                DurationMs = reader.IsDBNull(4) ? 0 : Convert.ToInt64(reader.GetValue(4)),
                Query = reader.IsDBNull(5) ? "" : reader.GetValue(5)?.ToString() ?? "",
                Host = reader.IsDBNull(6) ? "" : reader.GetValue(6)?.ToString() ?? "",
            });
        }
        return rows;
    }

    // ── Per-engine kill statements ──────────────────────────────────────────

    private static void KillSqlServer(string connectionString, string pid)
    {
        using var conn = new SqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"KILL {pid}";
        cmd.CommandTimeout = 10;
        cmd.ExecuteNonQuery();
    }

    // Postgres: pg_cancel_backend is a *cooperative* cancel — preferred over
    // pg_terminate_backend which forcibly drops the connection. Cancel sends
    // an interrupt the query can clean up after. We surface cancel-failures
    // (returned as false) to the caller as an error.
    private static void KillPostgres(string connectionString, string pid)
    {
        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"SELECT pg_cancel_backend({pid})";
        cmd.CommandTimeout = 10;
        var result = cmd.ExecuteScalar();
        // pg_cancel_backend returns true on success, false if pid wasn't found
        // or signal couldn't be sent (e.g. permission denied).
        if (result is bool b && !b)
            throw new Exception($"Could not cancel backend {pid} (permission denied or no such pid)");
    }

    private static void KillMySql(string connectionString, string pid)
    {
        using var conn = new MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"KILL {pid}";
        cmd.CommandTimeout = 10;
        cmd.ExecuteNonQuery();
    }

    // ── Error envelope helper ───────────────────────────────────────────────
    // Returns the same JSON shape as QueryExecutor's error path:
    // { "error": "..." }
    private static IntPtr ReturnError(string message)
    {
        return Marshal.StringToCoTaskMemUTF8(
            JsonSerializer.Serialize(
                new ActivityErrorResult { Error = message },
                ActivityJsonContext.Default.ActivityErrorResult));
    }
}

// ── DTOs ────────────────────────────────────────────────────────────────────

public class ActivityRow
{
    [JsonPropertyName("pid")] public string Pid { get; set; } = "";
    [JsonPropertyName("user")] public string User { get; set; } = "";
    [JsonPropertyName("database")] public string Database { get; set; } = "";
    [JsonPropertyName("state")] public string State { get; set; } = "";
    [JsonPropertyName("durationMs")] public long DurationMs { get; set; }
    [JsonPropertyName("query")] public string Query { get; set; } = "";
    [JsonPropertyName("host")] public string Host { get; set; } = "";
}

public class ActivityResult
{
    [JsonPropertyName("rows")] public List<ActivityRow> Rows { get; set; } = new();
}

public class KillResult
{
    [JsonPropertyName("ok")] public bool Ok { get; set; }
}

public class ActivityErrorResult
{
    [JsonPropertyName("error")] public string Error { get; set; } = "";
}

// Source-generated JSON context for NativeAOT.
// Mirrors AppJsonContext in QueryExecutor.cs.
[JsonSerializable(typeof(ActivityRow))]
[JsonSerializable(typeof(ActivityResult))]
[JsonSerializable(typeof(KillResult))]
[JsonSerializable(typeof(ActivityErrorResult))]
[JsonSerializable(typeof(List<ActivityRow>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class ActivityJsonContext : JsonSerializerContext { }