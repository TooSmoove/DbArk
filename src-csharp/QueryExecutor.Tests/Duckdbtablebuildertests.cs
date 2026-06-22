using System;
using System.Collections.Generic;
using Xunit;
using static DuckDbTableBuilder;

namespace QueryExecutorTests.Tests;

/// <summary>
/// Audit C-5 regression guard. The flat-file ↔ live-DB join used to stage every live
/// column as TEXT and every value as a quoted string, so an integer/date join key — or a
/// WHERE range on the live side — compared lexicographically ('9' &gt; '10' is TRUE as
/// text) and could return WRONG rows. The fix carries the real column type across the
/// boundary and renders typed literals. These tests pin that contract on the pure builder
/// with no DuckDB/native harness; the end-to-end "join on an integer key returns the right
/// rows" assertion needs DuckDB + a live DB and lives in an integration test run manually.
/// </summary>
public class DuckDbTableBuilderTests
{
    // ---- Type mapping ----------------------------------------------------

    [Theory]
    [InlineData(typeof(byte), DuckType.Bigint)]
    [InlineData(typeof(short), DuckType.Bigint)]
    [InlineData(typeof(int), DuckType.Bigint)]
    [InlineData(typeof(long), DuckType.Bigint)]
    [InlineData(typeof(uint), DuckType.Bigint)]
    [InlineData(typeof(float), DuckType.Double)]
    [InlineData(typeof(double), DuckType.Double)]
    [InlineData(typeof(decimal), DuckType.Double)]
    [InlineData(typeof(bool), DuckType.Boolean)]
    [InlineData(typeof(DateTime), DuckType.Timestamp)]
    [InlineData(typeof(DateOnly), DuckType.Date)]
    [InlineData(typeof(TimeOnly), DuckType.Time)]
    [InlineData(typeof(TimeSpan), DuckType.Time)]
    [InlineData(typeof(byte[]), DuckType.Blob)]
    [InlineData(typeof(string), DuckType.Varchar)]
    [InlineData(typeof(Guid), DuckType.Varchar)]
    [InlineData(typeof(ulong), DuckType.Varchar)] // can exceed BIGINT range → text, no overflow
    public void MapClrType_MapsToExpectedDuckType(Type clr, DuckType expected)
        => Assert.Equal(expected, MapClrType(clr));

    [Fact]
    public void MapClrType_UnwrapsNullable()
        => Assert.Equal(DuckType.Bigint, MapClrType(typeof(int?)));

    [Fact]
    public void MapClrType_NullType_DefaultsToVarchar()
        => Assert.Equal(DuckType.Varchar, MapClrType(null));

    // ---- THE C-5 REGRESSION: integer column is BIGINT, not TEXT ----------

    [Fact]
    public void BuildCreateTable_IntegerColumn_IsBigintNotText()
    {
        var ddl = BuildCreateTable(
            "db_products",
            new[] { "sku", "name" },
            new[] { DuckType.Bigint, DuckType.Varchar });

        Assert.Contains("\"sku\" BIGINT", ddl);
        Assert.Contains("\"name\" VARCHAR", ddl);
        // The exact regression: the integer key must NOT be declared TEXT.
        Assert.DoesNotContain("\"sku\" TEXT", ddl);
    }

    [Fact]
    public void BuildCreateTable_QuotesAndEscapesIdentifiers()
    {
        var ddl = BuildCreateTable("db_t", new[] { "weird\"col" }, new[] { DuckType.Varchar });
        Assert.Contains("\"weird\"\"col\" VARCHAR", ddl);
    }

    // ---- Literal rendering: numerics stay numeric ------------------------

    [Fact]
    public void RenderLiteral_IntegerKey_IsBareNumber_NotQuoted()
    {
        // This is what makes DuckDB compare numerically rather than as text:
        // 9 and 10 render as bare numbers, so 9 < 10 holds (vs '9' > '10' for text).
        Assert.Equal("9", RenderLiteral(DuckType.Bigint, "9"));
        Assert.Equal("10", RenderLiteral(DuckType.Bigint, "10"));
    }

    [Fact]
    public void RenderLiteral_NonNumericInBigintColumn_FallsBackToQuoted()
        => Assert.Equal("'abc'", RenderLiteral(DuckType.Bigint, "abc"));

    [Fact]
    public void RenderLiteral_Double_IsBareNumber()
        => Assert.Equal("1.5", RenderLiteral(DuckType.Double, "1.5"));

    [Fact]
    public void RenderLiteral_NonFiniteDouble_BecomesNull()
        => Assert.Equal("NULL", RenderLiteral(DuckType.Double, "NaN"));

    [Theory]
    [InlineData("true", "TRUE")]
    [InlineData("1", "TRUE")]
    [InlineData("false", "FALSE")]
    [InlineData("0", "FALSE")]
    public void RenderLiteral_Boolean(string value, string expected)
        => Assert.Equal(expected, RenderLiteral(DuckType.Boolean, value));

    [Fact]
    public void RenderLiteral_Null_IsSqlNull()
        => Assert.Equal("NULL", RenderLiteral(DuckType.Bigint, null));

    [Fact]
    public void RenderLiteral_Text_EscapesSingleQuotes()
        => Assert.Equal("'O''Brien'", RenderLiteral(DuckType.Varchar, "O'Brien"));

    [Fact]
    public void RenderLiteral_Timestamp_IsQuoted()
        => Assert.Equal("'2024-01-02 03:04:05.000000'",
            RenderLiteral(DuckType.Timestamp, "2024-01-02 03:04:05.000000"));

    [Fact]
    public void RenderLiteral_Blob_IsBlobLiteral()
        => Assert.Equal("'\\xDEAD'::BLOB", RenderLiteral(DuckType.Blob, "DEAD"));

    // ---- Invariant value formatting --------------------------------------

    [Fact]
    public void FormatClrValue_DateTime_IsInvariantIso()
        => Assert.Equal("2024-01-02 03:04:05.000000",
            FormatClrValue(new DateTime(2024, 1, 2, 3, 4, 5)));

    [Fact]
    public void FormatClrValue_Decimal_IsInvariant()
        => Assert.Equal("1234.5", FormatClrValue(1234.5m));

    [Fact]
    public void FormatClrValue_Bool_IsLowercaseToken()
    {
        Assert.Equal("true", FormatClrValue(true));
        Assert.Equal("false", FormatClrValue(false));
    }

    [Fact]
    public void FormatClrValue_Bytes_IsUppercaseHex()
        => Assert.Equal("DEAD", FormatClrValue(new byte[] { 0xDE, 0xAD }));

    [Fact]
    public void FormatClrValue_NullAndDbNull_AreNull()
    {
        Assert.Null(FormatClrValue(null));
        Assert.Null(FormatClrValue(DBNull.Value));
    }

    // ---- INSERT assembly -------------------------------------------------

    [Fact]
    public void BuildInsert_MixedTypes_RendersTypedTuple()
    {
        var sql = BuildInsert(
            "db_products",
            new[] { "sku", "name", "price", "active" },
            new[] { DuckType.Bigint, DuckType.Varchar, DuckType.Double, DuckType.Boolean },
            new List<IReadOnlyList<string?>>
            {
                new List<string?> { "9", "Widget", "1.5", "true" },
                new List<string?> { "10", "O'Brien", null, "0" },
            });

        Assert.Contains("INSERT INTO \"db_products\" VALUES", sql);
        Assert.Contains("(9, 'Widget', 1.5, TRUE)", sql);
        Assert.Contains("(10, 'O''Brien', NULL, FALSE)", sql);
    }

    [Fact]
    public void BuildInsert_ShortRow_PadsMissingTrailingColumnsWithNull()
    {
        var sql = BuildInsert(
            "db_t",
            new[] { "a", "b" },
            new[] { DuckType.Bigint, DuckType.Varchar },
            new List<IReadOnlyList<string?>> { new List<string?> { "1" } }); // only one value

        Assert.Contains("(1, NULL)", sql);
    }
}