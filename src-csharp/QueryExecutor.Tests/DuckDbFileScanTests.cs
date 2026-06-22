using Xunit;

namespace QueryExecutorTests.Tests;

/// <summary>
/// Audit H-1 regression guard for the flat-file scan path. The DuckDB file path used
/// to be interpolated raw into read_csv_auto('{path}') / FROM '{path}', so a path
/// containing an apostrophe broke the statement and was an injection seam. All three
/// former call sites now route through DuckDbFileScan.ScanExpr, which single-quote-
/// escapes the path. These tests pin that escaping without a DuckDB harness.
/// </summary>
public class DuckDbFileScanTests
{
    [Fact]
    public void Csv_uses_read_csv_auto_with_quoted_path()
        => Assert.Equal("read_csv_auto('/data/x.csv')",
                        DuckDbFileScan.ScanExpr(".csv", "/data/x.csv"));

    [Fact]
    public void Json_uses_read_json_auto_with_quoted_path()
        => Assert.Equal("read_json_auto('/data/x.json')",
                        DuckDbFileScan.ScanExpr(".json", "/data/x.json"));

    [Fact]
    public void Other_extension_is_a_bare_quoted_path()
        => Assert.Equal("'/data/x.xlsx'",
                        DuckDbFileScan.ScanExpr(".xlsx", "/data/x.xlsx"));

    [Fact]
    public void Apostrophe_in_path_is_doubled_not_broken_out()
    {
        // /Users/O'Brien/data.csv used to break the literal early (audit H-1).
        var expr = DuckDbFileScan.ScanExpr(".csv", "/Users/O'Brien/data.csv");
        Assert.Equal("read_csv_auto('/Users/O''Brien/data.csv')", expr);
    }

    [Fact]
    public void Injection_attempt_in_path_stays_inside_the_literal()
    {
        // A path crafted to close the literal and append SQL is neutralised: every
        // ' is doubled, so the payload stays a single quoted-string argument.
        var expr = DuckDbFileScan.ScanExpr(".csv", "x'); DROP TABLE data;--");
        Assert.Equal("read_csv_auto('x''); DROP TABLE data;--')", expr);
    }

    [Theory]
    [InlineData(".CSV")]
    [InlineData(".Csv")]
    public void Extension_match_is_case_insensitive(string ext)
        => Assert.StartsWith("read_csv_auto(", DuckDbFileScan.ScanExpr(ext, "/x.csv"));
}
