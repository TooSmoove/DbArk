#nullable enable
using System;
using System.Collections.Generic;
using Xunit;

namespace SchemaExplorer.Tests;

// Regression guards for the A-2 schema-engine registry. The engine-name →
// implementation mapping is data now; these pin it without a live database.
public class SchemaEnginesTests
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
        Assert.NotNull(SchemaEngines.Resolve(engine));
    }

    [Fact]
    public void Resolution_is_case_insensitive()
    {
        Assert.Same(SchemaEngines.Resolve("PostgreS"), SchemaEngines.Resolve("postgres"));
    }

    [Fact]
    public void Wire_compatible_engines_share_implementations()
    {
        // MariaDB is wire-compatible with MySQL; CockroachDB speaks the
        // Postgres wire protocol — one schema implementation serves each pair.
        Assert.Same(SchemaEngines.Resolve("mysql"), SchemaEngines.Resolve("mariadb"));
        Assert.Same(SchemaEngines.Resolve("postgres"), SchemaEngines.Resolve("cockroachdb"));
    }

    [Fact]
    public void Unknown_engine_fails_loudly()
    {
        var ex = Assert.Throws<Exception>(() => SchemaEngines.Resolve("oracle"));
        Assert.Contains("Unsupported engine: oracle", ex.Message);
    }

    [Fact]
    public void Sqlite_has_no_database_list()
    {
        // One SQLite file == one database — the sidebar gets an empty list,
        // not an error. No connection is opened for this.
        Assert.Empty(SchemaEngines.Resolve("sqlite").ListDatabases("Data Source=:memory:"));
    }

    [Fact]
    public void Sqlite_object_definitions_are_a_host_concern()
    {
        // The Rust host reads sqlite_master itself; the DLL path must refuse.
        Assert.Throws<NotSupportedException>(() =>
            SchemaEngines.Resolve("sqlite").GetObjectDefinition("x", "t", "table", ""));
    }
}
