#nullable enable
using System;
using System.Linq;
using System.Threading.Tasks;
using Testcontainers.CockroachDb;
using Testcontainers.MariaDb;
using Testcontainers.MsSql;
using Testcontainers.MySql;
using Testcontainers.PostgreSql;
using Xunit;

namespace DbArk.Integration;

/// <summary>
/// Base container fixture. Starts the server in <see cref="InitializeAsync"/>,
/// captures the connection string, and (optionally) probes usability. Any
/// failure — Docker absent, image pull blocked, driver missing — is turned into
/// <see cref="Available"/> = false with a reason, so the contract tests SKIP
/// instead of erroring on a machine without the infrastructure.
/// </summary>
public abstract class DbContainerFixture : IDbContainerFixture, IAsyncLifetime
{
    public bool Available { get; private set; }
    public string? SkipReason { get; private set; }
    public string ConnString { get; private set; } = "";

    /// <summary>Start the container and return the DbArk-dialect connection string.</summary>
    protected abstract Task<string> StartAsync();

    /// <summary>Stop/dispose the container.</summary>
    protected abstract ValueTask StopAsync();

    /// <summary>Optional usability probe; return a skip reason, or null if usable.</summary>
    protected virtual string? Probe(string connString) => null;

    public async ValueTask InitializeAsync()
    {
        try
        {
            ConnString = await StartAsync();
            var reason = Probe(ConnString);
            if (reason != null) { SkipReason = reason; Available = false; }
            else Available = true;
        }
        catch (Exception e)
        {
            SkipReason = $"container unavailable: {e.Message}";
            Available = false;
        }
    }

    public async ValueTask DisposeAsync()
    {
        try { await StopAsync(); } catch { /* best-effort teardown */ }
    }
}

public sealed class PostgresFixture : DbContainerFixture
{
    private readonly PostgreSqlContainer _c = new PostgreSqlBuilder()
        .WithImage("postgres:16-alpine")
        .WithDatabase("dbark").WithUsername("dbark").WithPassword("dbark_pw")
        .Build();

    protected override async Task<string> StartAsync()
    {
        await _c.StartAsync();
        // Mirrors build_pg_conn + ssl_mode "none" (SSL Mode=Disable) from conn_string.rs.
        return $"Host={_c.Hostname};Port={_c.GetMappedPublicPort(5432)};" +
               "Database=dbark;Username=dbark;Password=dbark_pw;SSL Mode=Disable;";
    }

    protected override ValueTask StopAsync() => _c.DisposeAsync();
}

public sealed class MySqlFixture : DbContainerFixture
{
    private readonly MySqlContainer _c = new MySqlBuilder()
        .WithImage("mysql:8.0")
        .WithDatabase("dbark").WithUsername("dbark").WithPassword("dbark_pw")
        .Build();

    protected override async Task<string> StartAsync()
    {
        await _c.StartAsync();
        // Mirrors build_mysql_conn + ssl_mode "none" from conn_string.rs.
        return $"Server={_c.Hostname};Port={_c.GetMappedPublicPort(3306)};" +
               "Database=dbark;Uid=dbark;Pwd=dbark_pw;SslMode=None;AllowUserVariables=true;";
    }

    protected override ValueTask StopAsync() => _c.DisposeAsync();
}

public sealed class MariaDbFixture : DbContainerFixture
{
    private readonly MariaDbContainer _c = new MariaDbBuilder()
        .WithImage("mariadb:11")
        .WithDatabase("dbark").WithUsername("dbark").WithPassword("dbark_pw")
        .Build();

    protected override async Task<string> StartAsync()
    {
        await _c.StartAsync();
        // MariaDB is wire-compatible with MySQL — same MySqlConnector dialect.
        return $"Server={_c.Hostname};Port={_c.GetMappedPublicPort(3306)};" +
               "Database=dbark;Uid=dbark;Pwd=dbark_pw;SslMode=None;AllowUserVariables=true;";
    }

    protected override ValueTask StopAsync() => _c.DisposeAsync();
}

public sealed class SqlServerFixture : DbContainerFixture
{
    private const string SaPassword = "yourStrong(!)Passw0rd";

    private readonly MsSqlContainer _c = new MsSqlBuilder()
        .WithImage("mcr.microsoft.com/mssql/server:2022-latest")
        .WithPassword(SaPassword)
        .Build();

    protected override async Task<string> StartAsync()
    {
        await _c.StartAsync();
        // Mirrors build_sqlserver_odbc (ODBC Driver 18, comma host,port form,
        // Encrypt=no for the local container) from conn_string.rs.
        return $"Driver={{ODBC Driver 18 for SQL Server}};" +
               $"Server={_c.Hostname},{_c.GetMappedPublicPort(1433)};" +
               $"Database=master;UID=sa;PWD={SaPassword};Encrypt=no;TrustServerCertificate=yes;";
    }

    // The SQL Server engine uses odbc32.dll (bridged to libodbc on Linux by
    // OdbcNativeShim). If unixODBC / msodbcsql18 isn't present the ODBC path
    // can't connect — probe once and skip the tier cleanly rather than fail.
    protected override string? Probe(string connString)
    {
        try
        {
            var rs = QueryEngines.Resolve("sqlserver").ExecuteBatch(connString, "SELECT 1 AS x");
            var data = rs.FirstOrDefault(r => r.Error == null && !r.IsMessage);
            if (data is { Rows.Count: > 0 }) return null; // usable
            var err = rs.FirstOrDefault(r => r.Error != null)?.Error ?? "probe returned no rows";
            return $"SQL Server ODBC path unusable (need unixODBC + msodbcsql18): {err}";
        }
        catch (Exception e)
        {
            return $"SQL Server ODBC path unusable (need unixODBC + msodbcsql18): {e.Message}";
        }
    }

    protected override ValueTask StopAsync() => _c.DisposeAsync();
}

public sealed class CockroachDbFixture : DbContainerFixture
{
    // No WithImage: use the module's pinned default tag (a bad tag would only
    // make the fixture skip, hiding the tier). CockroachDB runs insecure
    // single-node, so credentials are nominal.
    private readonly CockroachDbContainer _c = new CockroachDbBuilder().Build();

    protected override async Task<string> StartAsync()
    {
        await _c.StartAsync();
        // CockroachDB speaks the Postgres wire protocol. The engine re-parses
        // this string and forces SslMode.Disable + Pooling off
        // (OpenCockroachDbConnection) — the insecure-cluster path DbArk needs,
        // so this fixture exercises that override against a real cluster.
        return _c.GetConnectionString();
    }

    protected override ValueTask StopAsync() => _c.DisposeAsync();
}
