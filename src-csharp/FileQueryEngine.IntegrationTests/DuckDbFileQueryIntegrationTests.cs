#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Xunit;

namespace DbArk.Integration;

/// <summary>
/// DuckDB flat-file integration tests. Each test builds its SQL with the
/// PRODUCTION helpers (<see cref="DuckDbFileScan"/>, <see cref="DuckDbTableBuilder"/>)
/// and runs it against a real libduckdb via <see cref="DuckDb"/>. That closes the
/// loop the pure string-builder unit tests can't: the generated SQL is proven to
/// actually parse and execute on the engine DbArk ships.
///
/// Skipped (not failed) when libduckdb has not been staged — the CI integration
/// job stages it via scripts/stage-natives before running.
/// </summary>
public sealed class DuckDbFileQueryIntegrationTests : IDisposable
{
    private readonly string _dir;

    public DuckDbFileQueryIntegrationTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), $"dbark_duck_it_{Guid.NewGuid():N}");
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { /* best-effort */ }
    }

    private string Write(string name, string content)
    {
        var path = Path.Combine(_dir, name);
        File.WriteAllText(path, content);
        return path.Replace("\\", "/"); // the app normalises separators before scanning
    }

    // ── CSV / JSON scans via the production scan-expression builder ───────────

    [Fact]
    public void Csv_scan_reads_typed_rows()
    {
        Assert.SkipUnless(DuckDb.Available, "libduckdb not staged (set DBARK_DUCKDB_LIB or run scripts/stage-natives)");

        var csv = Write("people.csv", "id,name\n1,ada\n2,alan\n");
        using var s = new DuckDb.Session();

        // id is inferred BIGINT by read_csv_auto → the numeric predicate proves it.
        var r = s.Query($"SELECT name FROM {DuckDbFileScan.ScanExpr(".csv", csv)} WHERE id = 2");

        Assert.Equal(new[] { "name" }, r.Columns.ToArray());
        Assert.Single(r.Rows);
        Assert.Equal("alan", r.Rows[0][0]);
    }

    [Fact]
    public void Json_scan_reads_rows()
    {
        Assert.SkipUnless(DuckDb.Available, "libduckdb not staged");

        var json = Write("cities.json", "[{\"id\":1,\"city\":\"oslo\"},{\"id\":2,\"city\":\"riga\"}]");
        using var s = new DuckDb.Session();

        var r = s.Query($"SELECT city FROM {DuckDbFileScan.ScanExpr(".json", json)} ORDER BY id");

        Assert.Equal(new[] { "oslo", "riga" }, r.Rows.Select(row => row[0]).ToArray());
    }

    [Fact]
    public void Path_with_apostrophe_is_escaped_and_still_scans()
    {
        // H-1 regression, proven END TO END against DuckDB: a raw-interpolated
        // path like /…/O'Brien.csv would break the SQL literal; ScanExpr doubles
        // the quote so the scan parses and returns rows.
        Assert.SkipUnless(DuckDb.Available, "libduckdb not staged");

        var csv = Write("O'Brien.csv", "id,name\n1,ada\n");
        using var s = new DuckDb.Session();

        var r = s.Query($"SELECT count(*) AS c FROM {DuckDbFileScan.ScanExpr(".csv", csv)}");

        Assert.Equal("1", r.Rows[0][0]);
    }

    // ── File ↔ live-DB join with a TYPED staged table (audit C-5) ─────────────

    [Fact]
    public void File_joins_a_typed_staged_table_on_a_numeric_key()
    {
        // The flagship feature. The staged "customers" table is built with the
        // production DuckDbTableBuilder, typing id as BIGINT. The join key from
        // the CSV (cust_id, inferred BIGINT) then compares numerically. Before
        // C-5 the staged column was TEXT and this join errored / mismatched.
        Assert.SkipUnless(DuckDb.Available, "libduckdb not staged");

        var orders = Write("orders.csv", "cust_id,amount\n1,100\n2,200\n");
        using var s = new DuckDb.Session();

        var columns = new List<string> { "id", "name" };
        var types = new List<DuckDbTableBuilder.DuckType>
        {
            DuckDbTableBuilder.DuckType.Bigint,
            DuckDbTableBuilder.DuckType.Varchar,
        };
        var rows = new List<IReadOnlyList<string?>>
        {
            new List<string?> { "1", "ada" },
            new List<string?> { "2", "alan" },
        };

        Assert.Null(s.Exec(DuckDbTableBuilder.BuildCreateTable("db_customers", columns, types)));
        Assert.Null(s.Exec(DuckDbTableBuilder.BuildInsert("db_customers", columns, types, rows)));

        var join = s.Query(
            $"SELECT c.name, o.amount FROM {DuckDbFileScan.ScanExpr(".csv", orders)} o " +
            "JOIN db_customers c ON o.cust_id = c.id ORDER BY o.amount");

        Assert.Equal(2, join.Rows.Count);
        Assert.Equal(new[] { "ada", "alan" }, join.Rows.Select(r => r[0]).ToArray());
        Assert.Equal("100", join.Rows[0][1]);
    }

    [Fact]
    public void Staged_string_values_with_quotes_are_escaped_in_the_insert()
    {
        // DuckDbTableBuilder.RenderLiteral must escape embedded single quotes so a
        // value like O'Brien inserts cleanly (H-1 sibling on the value side).
        Assert.SkipUnless(DuckDb.Available, "libduckdb not staged");

        using var s = new DuckDb.Session();
        var columns = new List<string> { "id", "name" };
        var types = new List<DuckDbTableBuilder.DuckType>
        {
            DuckDbTableBuilder.DuckType.Bigint,
            DuckDbTableBuilder.DuckType.Varchar,
        };
        var rows = new List<IReadOnlyList<string?>> { new List<string?> { "1", "O'Brien" } };

        Assert.Null(s.Exec(DuckDbTableBuilder.BuildCreateTable("t", columns, types)));
        Assert.Null(s.Exec(DuckDbTableBuilder.BuildInsert("t", columns, types, rows)));

        var r = s.Query("SELECT name FROM t WHERE id = 1");
        Assert.Equal("O'Brien", r.Rows[0][0]);
    }

    [Fact]
    public void A_bad_query_surfaces_a_duckdb_error_not_a_crash()
    {
        Assert.SkipUnless(DuckDb.Available, "libduckdb not staged");

        using var s = new DuckDb.Session();
        var err = s.Exec("SELECT * FROM table_that_does_not_exist");

        Assert.NotNull(err);
        Assert.NotEqual("", err);
    }
}
