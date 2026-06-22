using Xunit;

namespace QueryExecutorTests.Tests;

/// <summary>
/// Audit H-1 regression guard for SchemaExplorer's definition/DDL generators. Object and
/// schema names from the schema tree are interpolated into reconstructed DDL (as quoted
/// identifiers) and into catalog queries (as string literals). SqlIdentifier.Quote and
/// .EscapeLiteral neutralise a name that contains the engine's quote character or an
/// apostrophe. These pin both without a live-DB harness.
/// </summary>
public class SqlIdentifierTests
{
    [Fact]
    public void SqlServer_doubles_closing_bracket()
    {
        Assert.Equal("[Orders]", SqlIdentifier.Quote("sqlserver", "Orders"));
        Assert.Equal("[Or]]ders]", SqlIdentifier.Quote("sqlserver", "Or]ders"));
    }

    [Fact]
    public void MySql_and_mariadb_double_the_backtick()
    {
        Assert.Equal("`ev``il`", SqlIdentifier.Quote("mysql", "ev`il"));
        Assert.Equal("`t`", SqlIdentifier.Quote("mariadb", "t"));
    }

    [Fact]
    public void Postgres_and_cockroach_use_standard_double_quote()
    {
        Assert.Equal("\"ev\"\"il\"", SqlIdentifier.Quote("postgres", "ev\"il"));
        Assert.Equal("\"t\"", SqlIdentifier.Quote("cockroachdb", "t"));
    }

    [Fact]
    public void Quote_neutralises_identifier_breakout()
    {
        // A name crafted to close the [..] quote and append a statement is rendered inert:
        // the ] is doubled, so the whole payload stays one bracket-quoted identifier.
        Assert.Equal("[x]]; DROP TABLE secrets;--]",
                     SqlIdentifier.Quote("sqlserver", "x]; DROP TABLE secrets;--"));
    }

    [Fact]
    public void EscapeLiteral_doubles_single_quotes()
    {
        // /Users/O'Brien-style names used to break catalog-query string literals (H-1).
        Assert.Equal("O''Brien", SqlIdentifier.EscapeLiteral("O'Brien"));
    }

    [Fact]
    public void EscapeLiteral_neutralises_literal_breakout()
    {
        // The escaped value is meant to sit inside '...': WHERE name = '{EscapeLiteral(x)}'.
        var inner = SqlIdentifier.EscapeLiteral("x'; DROP TABLE t;--");
        Assert.Equal("x''; DROP TABLE t;--", inner);
        Assert.Equal("'x''; DROP TABLE t;--'", $"'{inner}'");
    }

    [Theory]
    [InlineData("SQLSERVER", "[a]")]
    [InlineData("MySQL", "`a`")]
    [InlineData("Postgres", "\"a\"")]
    public void Engine_match_is_case_insensitive(string engine, string expected)
        => Assert.Equal(expected, SqlIdentifier.Quote(engine, "a"));
}
