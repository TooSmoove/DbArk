#nullable enable
using System;
using System.Globalization;
using System.Linq;
using Xunit;
// `using static` is a type-only context, so it binds `QueryExecutor` to the
// engine class rather than this project's same-named default namespace segment.
using static global::QueryExecutor;

namespace DbArk.Integration;

/// <summary>What a per-engine container fixture exposes to the shared contract.</summary>
public interface IDbContainerFixture
{
    /// <summary>True when the container started and (for SQL Server) the ODBC
    /// path is usable. When false, every contract test skips.</summary>
    bool Available { get; }

    /// <summary>Why the fixture is unavailable (Docker missing, driver missing…).</summary>
    string? SkipReason { get; }

    /// <summary>The connection string in the exact dialect the engine expects,
    /// built the way DbArk's Rust host builds it (see conn_string.rs).</summary>
    string ConnString { get; }
}

/// <summary>
/// One engine-agnostic scenario, run against every containerized engine. Every
/// statement uses portable SQL (INT / VARCHAR / COUNT / SUM) so the same test
/// body exercises Postgres, MySQL, MariaDB and SQL Server through the production
/// engine registry — the same dispatch <c>QueryExecutor.ExecuteQuery</c> performs.
/// Derived classes supply the engine name and a started container fixture.
/// </summary>
public abstract class QueryEngineContainerContract
{
    protected abstract string Engine { get; }
    protected abstract IDbContainerFixture Fixture { get; }

    private IQueryEngine Resolve() => QueryEngines.Resolve(Engine);

    private void RequireContainer() =>
        Assert.SkipUnless(Fixture.Available, Fixture.SkipReason ?? "container unavailable");

    private void Exec(string sql) => Resolve().ExecuteNonQuery(Fixture.ConnString, sql);

    private QueryResult QuerySingle(string sql)
    {
        var results = Resolve().ExecuteBatch(Fixture.ConnString, sql);
        var data = results.FirstOrDefault(r => r.Error == null && !r.IsMessage) ?? results[0];
        Assert.Null(data.Error);
        return data;
    }

    private static string Unique(string prefix) => $"{prefix}_{Guid.NewGuid():N}";

    private static double Num(string? cell) =>
        double.Parse(cell ?? "", CultureInfo.InvariantCulture);

    [Fact]
    public void Create_insert_select_round_trips()
    {
        RequireContainer();
        ActiveRowLimit = 10_000;
        var t = Unique("crud");

        Exec($"CREATE TABLE {t} (id INT, name VARCHAR(50))");
        Exec($"INSERT INTO {t} (id, name) VALUES (1, 'ada'), (2, 'alan')");

        var r = QuerySingle($"SELECT id, name FROM {t} ORDER BY id");

        Assert.Equal(2, r.RowCount);
        Assert.Equal(new[] { "id", "name" }, r.Columns.Select(c => c.ToLowerInvariant()).ToArray());
        Assert.Equal(1, (int)Num(r.Rows[0][0]));
        Assert.Equal("ada", r.Rows[0][1]);
        Assert.Equal("alan", r.Rows[1][1]);
    }

    [Fact]
    public void Null_values_survive_as_null_not_empty_string()
    {
        RequireContainer();
        ActiveRowLimit = 10_000;
        var t = Unique("nulls");

        Exec($"CREATE TABLE {t} (a VARCHAR(10), b VARCHAR(10))");
        Exec($"INSERT INTO {t} (a, b) VALUES ('x', NULL)");

        var r = QuerySingle($"SELECT a, b FROM {t}");

        Assert.Equal("x", r.Rows[0][0]);
        Assert.Null(r.Rows[0][1]);
    }

    [Fact]
    public void Aggregate_returns_a_single_computed_row()
    {
        RequireContainer();
        ActiveRowLimit = 10_000;
        var t = Unique("agg");

        Exec($"CREATE TABLE {t} (v INT)");
        Exec($"INSERT INTO {t} (v) VALUES (10), (20), (12)");

        var r = QuerySingle($"SELECT COUNT(*) AS c, SUM(v) AS s FROM {t}");

        Assert.Equal(1, r.RowCount);
        Assert.Equal(3, (int)Num(r.Rows[0][0]));   // COUNT(*)
        Assert.Equal(42, (int)Num(r.Rows[0][1]));  // SUM(v) — parse-tolerant of 42 vs 42.0000
    }

    [Fact]
    public void Row_cap_truncates_and_flags_when_more_rows_remain()
    {
        RequireContainer();
        ActiveRowLimit = 2;
        var t = Unique("cap");

        Exec($"CREATE TABLE {t} (v INT)");
        Exec($"INSERT INTO {t} (v) VALUES (1), (2), (3), (4), (5)");

        var r = QuerySingle($"SELECT v FROM {t} ORDER BY v");

        Assert.Equal(2, r.RowCount);
        Assert.True(r.Truncated, "more rows remained past ActiveRowLimit → Truncated must be set");
    }
}
