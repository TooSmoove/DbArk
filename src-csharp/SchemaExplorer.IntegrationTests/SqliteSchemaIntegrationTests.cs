#nullable enable
using System;
using System.IO;
using System.Linq;
using Xunit;

namespace DbArk.Integration;

/// <summary>
/// Real-database integration tests for SQLite schema introspection. A temp
/// database is seeded with two related tables, then the production schema reader
/// (<c>SchemaEngines.Resolve("sqlite").GetFullSchema</c>) walks it and we assert
/// on the returned <see cref="SchemaResult"/> — the exact object the schema
/// sidebar renders.
/// </summary>
public sealed class SqliteSchemaIntegrationTests : IDisposable
{
    private readonly string _dbPath;
    private readonly string _conn;

    private static ISchemaEngine Sqlite => SchemaEngines.Resolve("sqlite");

    public SqliteSchemaIntegrationTests()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"dbark_schema_it_{Guid.NewGuid():N}.sqlite");
        _conn = $"Data Source={_dbPath}";
        SqliteTestDb.Seed(
            _dbPath,
            "CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL)",
            "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER, note TEXT, " +
                "FOREIGN KEY (parent_id) REFERENCES parent(id))");
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* best-effort */ }
    }

    [Fact]
    public void Lists_every_table_ordered_by_name()
    {
        var schema = Sqlite.GetFullSchema(_conn);

        Assert.Null(schema.Error);
        Assert.Equal(new[] { "child", "parent" }, schema.Tables.Select(t => t.Name).ToArray());
        Assert.All(schema.Tables, t => Assert.Equal("main", t.Schema));
    }

    [Fact]
    public void Reads_columns_types_and_primary_key_flags()
    {
        var schema = Sqlite.GetFullSchema(_conn);

        var child = schema.Tables.Single(t => t.Name == "child");
        Assert.Equal(new[] { "id", "parent_id", "note" }, child.Columns.Select(c => c.Name).ToArray());

        var id = child.Columns.Single(c => c.Name == "id");
        Assert.True(id.IsPrimaryKey);
        Assert.Equal("INTEGER", id.DataType, ignoreCase: true);

        var parentId = child.Columns.Single(c => c.Name == "parent_id");
        Assert.False(parentId.IsPrimaryKey);
    }

    [Fact]
    public void Reports_not_null_constraint_from_pragma()
    {
        var schema = Sqlite.GetFullSchema(_conn);
        var parentName = schema.Tables.Single(t => t.Name == "parent").Columns.Single(c => c.Name == "name");
        Assert.False(parentName.IsNullable); // declared NOT NULL
    }

    [Fact]
    public void Resolves_the_foreign_key_source_and_target()
    {
        var schema = Sqlite.GetFullSchema(_conn);

        var fk = Assert.Single(schema.ForeignKeys);
        Assert.Equal("child", fk.SourceTable);
        Assert.Equal("parent_id", fk.SourceColumn);
        Assert.Equal("parent", fk.TargetTable);
        Assert.Equal("id", fk.TargetColumn);
    }

    [Fact]
    public void Sqlite_leaves_host_resolved_object_kinds_empty()
    {
        // Views/triggers/indexes/procedures/functions are fetched by the Rust
        // host for SQLite, not this DLL — the reader must return them empty, not
        // fabricate entries. Pins that contract.
        var schema = Sqlite.GetFullSchema(_conn);
        Assert.Empty(schema.Views);
        Assert.Empty(schema.Triggers);
        Assert.Empty(schema.Indexes);
        Assert.Empty(schema.Procedures);
        Assert.Empty(schema.Functions);
    }

    [Fact]
    public void Sqlite_has_no_database_layer()
    {
        // One file == one database; the sidebar's database dropdown is empty.
        Assert.Empty(Sqlite.ListDatabases(_conn));
    }
}
