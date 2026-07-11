#nullable enable
using System;
using Xunit;

namespace FileQueryEngine.Tests;

// Regression guards for the A-2 file-join bridge registry and the per-engine
// catalog queries the flat-file join depends on. No live database required.
public class DbBridgesTests
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
        Assert.NotNull(DbBridges.Resolve(engine));
    }

    [Fact]
    public void Resolution_is_case_insensitive()
    {
        Assert.Same(DbBridges.Resolve("SQLite"), DbBridges.Resolve("sqlite"));
    }

    [Fact]
    public void Wire_compatible_engines_share_implementations()
    {
        Assert.Same(DbBridges.Resolve("mysql"), DbBridges.Resolve("mariadb"));
        Assert.Same(DbBridges.Resolve("postgres"), DbBridges.Resolve("cockroachdb"));
    }

    [Fact]
    public void Unknown_engine_fails_loudly()
    {
        var ex = Assert.Throws<Exception>(() => DbBridges.Resolve("duckdb"));
        Assert.Contains("Unsupported engine: duckdb", ex.Message);
    }

    [Fact]
    public void Catalog_queries_target_each_engines_own_metadata()
    {
        // Pin the table-listing catalog queries: these fed an inline switch
        // before A-2, and a mixed-up query would silently list nothing.
        Assert.Equal("SHOW TABLES", DbBridges.Resolve("mysql").ListTablesSql);
        Assert.Contains("pg_tables", DbBridges.Resolve("postgres").ListTablesSql);
        Assert.Contains("sqlite_master", DbBridges.Resolve("sqlite").ListTablesSql);
        Assert.Contains("INFORMATION_SCHEMA.TABLES", DbBridges.Resolve("sqlserver").ListTablesSql);
    }
}
