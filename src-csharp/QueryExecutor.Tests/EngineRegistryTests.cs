#nullable enable
using System;
using System.Collections.Generic;
using Xunit;

namespace QueryExecutorTests.Tests;

// Regression guards for the A-2 engine registries: the mapping from wire
// engine names to implementations is now data, so these tests pin it down —
// aliases resolve to the same instance, lookups are case-insensitive, unknown
// engines fail loudly, and per-engine capabilities stay what the pipeline
// expects. No live database is required.
public class QueryEnginesTests
{
    [Theory]
    [InlineData("sqlserver")]
    [InlineData("postgres")]
    [InlineData("cockroachdb")]
    [InlineData("mysql")]
    [InlineData("mariadb")]
    [InlineData("sqlite")]
    public void Resolves_every_supported_engine(string engine)
    {
        Assert.NotNull(QueryEngines.Resolve(engine));
    }

    [Fact]
    public void Resolution_is_case_insensitive()
    {
        Assert.Same(QueryEngines.Resolve("SQLServer"), QueryEngines.Resolve("sqlserver"));
        Assert.Same(QueryEngines.Resolve("MariaDB"), QueryEngines.Resolve("mariadb"));
    }

    [Fact]
    public void MariaDb_shares_the_MySql_implementation()
    {
        // MariaDB is wire-compatible with MySQL — one implementation serves both.
        Assert.Same(QueryEngines.Resolve("mysql"), QueryEngines.Resolve("mariadb"));
    }

    [Fact]
    public void CockroachDb_has_its_own_query_implementation()
    {
        // Unlike the schema/activity layers, the query layer gives CockroachDB
        // its own implementation (retry/connection handling differs from Npgsql
        // vanilla) — pin that so a "simplification" doesn't merge them silently.
        Assert.NotSame(QueryEngines.Resolve("postgres"), QueryEngines.Resolve("cockroachdb"));
    }

    [Fact]
    public void Unknown_engine_fails_loudly()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => QueryEngines.Resolve("oracle"));
        Assert.Contains("Unsupported engine: oracle", ex.Message);
    }

    [Fact]
    public void Only_sqlite_stays_on_the_legacy_statement_path()
    {
        Assert.False(QueryEngines.Resolve("sqlite").UsesBatchPath);
        foreach (var engine in new[] { "sqlserver", "postgres", "cockroachdb", "mysql", "mariadb" })
            Assert.True(QueryEngines.Resolve(engine).UsesBatchPath, engine);
    }

    [Fact]
    public void Only_sqlserver_splits_batches()
    {
        const string sql = "SELECT 1\nGO\nSELECT 2";
        Assert.Equal(2, QueryEngines.Resolve("sqlserver").SplitBatches(sql).Count);
        Assert.Single(QueryEngines.Resolve("postgres").SplitBatches(sql));
        Assert.Single(QueryEngines.Resolve("mysql").SplitBatches(sql));
    }

    [Fact]
    public void Sqlite_batch_execution_is_a_hard_error()
    {
        // The stage-2 migration guard must survive the registry refactor.
        var ex = Assert.Throws<InvalidOperationException>(
            () => QueryEngines.Resolve("sqlite").ExecuteBatch("Data Source=:memory:", "SELECT 1"));
        Assert.Contains("stage-2", ex.Message);
    }
}

public class ActivityEnginesTests
{
    [Fact]
    public void Wire_compatible_engines_share_implementations()
    {
        Assert.Same(ActivityEngines.Resolve("postgres"), ActivityEngines.Resolve("cockroachdb"));
        Assert.Same(ActivityEngines.Resolve("mysql"), ActivityEngines.Resolve("mariadb"));
    }

    [Fact]
    public void Sqlite_activity_is_rejected_with_the_documented_messages()
    {
        var sqlite = ActivityEngines.Resolve("sqlite");
        var read = Assert.Throws<InvalidOperationException>(() => sqlite.ReadActivity("x"));
        Assert.Equal("Activity panel is not supported for SQLite", read.Message);
        var kill = Assert.Throws<InvalidOperationException>(() => sqlite.KillSession("x", "1"));
        Assert.Equal("Kill is not supported for SQLite", kill.Message);
    }

    [Fact]
    public void Unknown_engine_fails_loudly()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => ActivityEngines.Resolve("db2"));
        Assert.Contains("Unknown engine: db2", ex.Message);
    }
}
