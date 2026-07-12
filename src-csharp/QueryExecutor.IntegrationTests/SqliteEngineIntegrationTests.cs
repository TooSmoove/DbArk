#nullable enable
using System;
using System.IO;
using System.Linq;
using Xunit;
// `using static` is a type-only context, so it binds `QueryExecutor` to the
// engine class and NOT to this project's same-named default namespace — that
// name clash is why a bare `QueryExecutor.ActiveRowLimit` fails to compile.
using static global::QueryExecutor;

namespace DbArk.Integration;

/// <summary>
/// Real-database integration tests for the SQLite engine. Each test drives the
/// engine the way <c>QueryExecutor.ExecuteQuery</c> does — resolve the engine
/// from the registry, then run statements against a real temp <c>.sqlite</c>
/// file — and asserts on the concrete <see cref="QueryResult"/> the FFI layer
/// would hand back. These cover the seam the pure-logic unit tests can't:
/// column harvesting, NULL storage-class handling, and the row-cap / truncation
/// bookkeeping that only appears when a real driver returns rows.
/// </summary>
public sealed class SqliteEngineIntegrationTests : IDisposable
{
    private readonly string _dbPath;
    private readonly string _conn;

    // The registry lookup is the exact dispatch ExecuteQuery performs.
    private static IQueryEngine Sqlite => QueryEngines.Resolve("sqlite");

    public SqliteEngineIntegrationTests()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"dbark_it_{Guid.NewGuid():N}.sqlite");
        _conn = $"Data Source={_dbPath}"; // the exact shape build_sqlite_conn emits
        ActiveRowLimit = 10_000; // reset the shared cap per test
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* best-effort temp cleanup */ }
    }

    /// <summary>Run a non-row statement (DDL/DML) through the engine's non-query path.</summary>
    private void Exec(string sql) => Sqlite.ExecuteNonQuery(_conn, sql);

    /// <summary>Run one row-returning statement and return its single result set.</summary>
    private QueryResult Query(string sql)
    {
        var results = Sqlite.ExecuteStatement(_conn, sql);
        Assert.Single(results);
        return results[0];
    }

    // ── Round-trip ───────────────────────────────────────────────────────────

    [Fact]
    public void Create_insert_select_round_trips_columns_and_rows()
    {
        Exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
        Exec("INSERT INTO users (id, name) VALUES (1, 'ada'), (2, 'alan')");

        var r = Query("SELECT id, name FROM users ORDER BY id");

        Assert.Null(r.Error);
        Assert.Equal(new[] { "id", "name" }, r.Columns.ToArray());
        Assert.Equal(2, r.RowCount);
        Assert.Equal("1", r.Rows[0][0]);
        Assert.Equal("ada", r.Rows[0][1]);
        Assert.Equal("alan", r.Rows[1][1]);
        Assert.False(r.Truncated);
    }

    [Fact]
    public void Null_values_survive_as_null_not_empty_string()
    {
        Exec("CREATE TABLE t (a TEXT, b TEXT)");
        Exec("INSERT INTO t (a, b) VALUES ('x', NULL)");

        var r = Query("SELECT a, b FROM t");

        Assert.Equal("x", r.Rows[0][0]);
        Assert.Null(r.Rows[0][1]); // SQLITE_NULL → null, distinct from ""
    }

    [Fact]
    public void Aggregate_returns_a_single_computed_row()
    {
        Exec("CREATE TABLE n (v INTEGER)");
        Exec("INSERT INTO n (v) VALUES (10), (20), (12)");

        var r = Query("SELECT COUNT(*) AS c, SUM(v) AS s FROM n");

        Assert.Equal(1, r.RowCount);
        Assert.Equal("3", r.Rows[0][0]);
        Assert.Equal("42", r.Rows[0][1]);
    }

    [Fact]
    public void Empty_table_yields_column_headers_and_zero_rows()
    {
        // Regression guard: the single-statement path used to read column names
        // only inside the row loop, so a zero-row result lost its headers.
        Exec("CREATE TABLE e (id INTEGER, label TEXT)");

        var r = Query("SELECT id, label FROM e");

        Assert.Equal(new[] { "id", "label" }, r.Columns.ToArray());
        Assert.Empty(r.Rows);
        Assert.Equal(0, r.RowCount);
    }

    // ── Row cap / truncation bookkeeping ─────────────────────────────────────

    [Fact]
    public void Row_cap_truncates_and_flags_when_more_rows_remain()
    {
        Exec("CREATE TABLE big (v INTEGER)");
        Exec("INSERT INTO big (v) VALUES (1), (2), (3), (4), (5)");
        ActiveRowLimit = 2;

        var r = Query("SELECT v FROM big ORDER BY v");

        Assert.Equal(2, r.RowCount);
        Assert.True(r.Truncated, "more rows remained past the cap → Truncated must be set");
    }

    [Fact]
    public void Result_size_exactly_at_the_cap_is_not_flagged_truncated()
    {
        // Regression guard: N rows with a cap of N is NOT a truncation. The old
        // peek-one-more-row check mis-fired here because prepare_v2 auto-resets
        // a statement after SQLITE_DONE, so the peek re-ran the query.
        Exec("CREATE TABLE exact (v INTEGER)");
        Exec("INSERT INTO exact (v) VALUES (1), (2), (3)");
        ActiveRowLimit = 3;

        var r = Query("SELECT v FROM exact ORDER BY v");

        Assert.Equal(3, r.RowCount);
        Assert.False(r.Truncated);
    }

    // ── Registry / engine-contract integration ───────────────────────────────

    [Fact]
    public void Registry_rejects_an_unknown_engine_loudly()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => QueryEngines.Resolve("oracle"));
        Assert.Contains("Unsupported engine", ex.Message);
    }

    [Fact]
    public void Sqlite_is_on_the_legacy_statement_path_not_the_batch_path()
    {
        // Contract pin: SQLite must not be routed through ExecuteBatch until its
        // stage-2 migration; doing so today throws by design.
        Assert.False(Sqlite.UsesBatchPath);
        Assert.Throws<InvalidOperationException>(() => Sqlite.ExecuteBatch(_conn, "SELECT 1"));
    }

    [Fact]
    public void Syntax_error_comes_back_as_an_empty_result_not_a_throw()
    {
        // The engine swallows prepare failures into an empty result set rather
        // than throwing across the FFI boundary; pin that behaviour.
        var r = Query("SELECT FROM WHERE bogus");
        Assert.Empty(r.Rows);
    }
}