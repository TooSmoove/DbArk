#nullable enable
using System.Collections.Generic;
using Xunit;

namespace QueryExecutorTests.Tests;

// Regression guards for SqlStatementSplitter (extracted from QueryExecutor in
// the WS2 decomposition; previously a private method with no direct coverage —
// AGENTS.md: moved pure logic gets a focused regression test in the same
// change). Pins the quote/comment/dollar-quote/BEGIN-END awareness the
// read-only guard and the legacy statement path both depend on.
public class SqlStatementSplitterTests
{
    [Fact]
    public void Splits_on_top_level_semicolons()
    {
        List<string> stmts = SqlStatementSplitter.Split("SELECT 1; SELECT 2; SELECT 3");
        Assert.Equal(3, stmts.Count);
        Assert.Equal("SELECT 1", stmts[0]);
        Assert.Equal("SELECT 3", stmts[2]);
    }

    [Fact]
    public void Trailing_statement_without_semicolon_is_kept()
    {
        var stmts = SqlStatementSplitter.Split("SELECT 1;\nSELECT 2");
        Assert.Equal(2, stmts.Count);
        Assert.Equal("SELECT 2", stmts[1]);
    }

    [Fact]
    public void Empty_and_whitespace_segments_are_dropped()
    {
        var stmts = SqlStatementSplitter.Split(";;  ;\nSELECT 1;\n;");
        Assert.Single(stmts);
        Assert.Equal("SELECT 1", stmts[0]);
    }

    [Fact]
    public void Semicolon_inside_string_literal_does_not_split()
    {
        var stmts = SqlStatementSplitter.Split("SELECT 'a;b'; SELECT 2");
        Assert.Equal(2, stmts.Count);
        Assert.Equal("SELECT 'a;b'", stmts[0]);
    }

    [Fact]
    public void Apostrophe_inside_line_comment_does_not_open_a_string()
    {
        // "don't" in a comment must not swallow the following semicolon —
        // the exact bug the comment-before-string ordering exists to prevent.
        var sql = "SELECT 1 -- don't trip here\n; SELECT 2";
        var stmts = SqlStatementSplitter.Split(sql);
        Assert.Equal(2, stmts.Count);
    }

    [Fact]
    public void Semicolon_inside_block_comment_does_not_split()
    {
        var stmts = SqlStatementSplitter.Split("SELECT 1 /* a;b */; SELECT 2");
        Assert.Equal(2, stmts.Count);
        Assert.Equal("SELECT 1 /* a;b */", stmts[0]);
    }

    [Theory]
    [InlineData("$$")]
    [InlineData("$body$")]
    [InlineData("$function$")]
    public void Semicolons_inside_dollar_quotes_do_not_split(string tag)
    {
        var sql = $"CREATE FUNCTION f() RETURNS int AS {tag} BEGIN RETURN 1; END; {tag} LANGUAGE plpgsql; SELECT 1";
        var stmts = SqlStatementSplitter.Split(sql);
        Assert.Equal(2, stmts.Count);
        Assert.Contains(tag, stmts[0]);
        Assert.Equal("SELECT 1", stmts[1]);
    }

    [Fact]
    public void Begin_end_block_is_one_statement()
    {
        var sql = "BEGIN\n  UPDATE t SET x = 1;\n  UPDATE t SET y = 2;\nEND; SELECT 1";
        var stmts = SqlStatementSplitter.Split(sql);
        Assert.Equal(2, stmts.Count);
        Assert.StartsWith("BEGIN", stmts[0]);
        Assert.EndsWith("END", stmts[0]);
    }

    [Fact]
    public void Identifier_containing_begin_does_not_change_depth()
    {
        // BEGINNING must not count as BEGIN (word-boundary check) — otherwise
        // depth never returns to 0 and the ';' would not split.
        var stmts = SqlStatementSplitter.Split("SELECT BEGINNING FROM t; SELECT 2");
        Assert.Equal(2, stmts.Count);
    }

    [Fact]
    public void Double_quoted_and_backtick_identifiers_protect_semicolons()
    {
        Assert.Single(SqlStatementSplitter.Split("SELECT \"a;b\" FROM t"));
        Assert.Single(SqlStatementSplitter.Split("SELECT `a;b` FROM t"));
    }
}
