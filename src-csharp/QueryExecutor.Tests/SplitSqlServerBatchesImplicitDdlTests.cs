using System;
using System.Collections.Generic;
using Xunit;

namespace QueryExecutorTests.Tests;

// Covers the implicit batch boundary detection added to SplitSqlServerBatches:
// CREATE/ALTER [OR ALTER|OR REPLACE] PROCEDURE|PROC|FUNCTION|VIEW|TRIGGER at a
// statement-start position is treated as an implicit batch boundary, the same as
// a GO line. Separate class from SplitSqlServerBatchesTests so it drops into the
// project without colliding; or paste these [Fact] methods into the existing
// class if you prefer a single file.
public class SplitSqlServerBatchesImplicitDdlTests
{
    // ── Positive: implicit split happens ─────────────────────────────────────

    [Fact]
    public void ImplicitSplit_CreateProcedure_AfterTableAndAlter()
    {
        // Arrange — the May 2026 dogfooding case: 3 statements, no GO. CREATE TABLE
        // and ALTER TABLE are not batch-scoped so they share a batch; only the
        // CREATE PROCEDURE must be isolated -> 2 batches.
        string sql =
            "CREATE TABLE dbo.Products (Id INT);\n" +
            "ALTER TABLE dbo.Orders ADD ShippingAddress NVARCHAR(500) NULL;\n" +
            "CREATE PROCEDURE dbo.GetCustomerOrders @CustomerId INT\n" +
            "AS\nBEGIN\n  SELECT 1;\nEND";

        // Act
        List<string> result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Contains("CREATE TABLE", result[0]);
        Assert.Contains("ALTER TABLE", result[0]);
        Assert.StartsWith("CREATE PROCEDURE", result[1]);
    }

    [Fact]
    public void ImplicitSplit_TwoProceduresBackToBack()
    {
        // Arrange
        string sql =
            "CREATE PROCEDURE p1 AS BEGIN SELECT 1 END\n" +
            "CREATE PROCEDURE p2 AS BEGIN SELECT 2 END";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("CREATE PROCEDURE p1 AS BEGIN SELECT 1 END", result[0]);
        Assert.Equal("CREATE PROCEDURE p2 AS BEGIN SELECT 2 END", result[1]);
    }

    [Fact]
    public void ImplicitSplit_ProcWithBeginTran_ThenProc()
    {
        // Arrange — a proc using BEGIN TRAN (no matching END) followed by another
        // proc. Naive BEGIN/END depth tracking would get stuck > 0 here and fail
        // to split; this confirms the keyword-only approach splits correctly.
        string sql =
            "CREATE PROCEDURE p1 AS\nBEGIN\n  BEGIN TRAN\n  UPDATE t SET x=1\n  COMMIT\nEND\n" +
            "CREATE PROCEDURE p2 AS BEGIN SELECT 2 END";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.StartsWith("CREATE PROCEDURE p1", result[0]);
        Assert.Contains("BEGIN TRAN", result[0]);
        Assert.Equal("CREATE PROCEDURE p2 AS BEGIN SELECT 2 END", result[1]);
    }

    [Fact]
    public void ImplicitSplit_CreateOrAlterProcedure()
    {
        // Arrange — CREATE OR ALTER (the smart-DDL auto-rewrite output) must split.
        string sql = "CREATE TABLE t (id int);\nCREATE OR ALTER PROCEDURE p AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("CREATE TABLE t (id int);", result[0]);
        Assert.Equal("CREATE OR ALTER PROCEDURE p AS SELECT 1", result[1]);
    }

    [Fact]
    public void ImplicitSplit_CreateProcAbbreviation()
    {
        // Arrange — PROC is a valid abbreviation for PROCEDURE.
        string sql = "SELECT 1;\nCREATE PROC p AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1;", result[0]);
        Assert.Equal("CREATE PROC p AS SELECT 1", result[1]);
    }

    [Fact]
    public void ImplicitSplit_FunctionViewTriggerChain()
    {
        // Arrange — all four batch-scoped object types trigger a split.
        string sql =
            "CREATE FUNCTION f() RETURNS INT AS BEGIN RETURN 1 END\n" +
            "CREATE VIEW v AS SELECT 1 AS x\n" +
            "CREATE TRIGGER trg ON t AFTER INSERT AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(3, result.Count);
        Assert.Equal("CREATE FUNCTION f() RETURNS INT AS BEGIN RETURN 1 END", result[0]);
        Assert.Equal("CREATE VIEW v AS SELECT 1 AS x", result[1]);
        Assert.Equal("CREATE TRIGGER trg ON t AFTER INSERT AS SELECT 1", result[2]);
    }

    [Fact]
    public void ImplicitSplit_ExplicitGoThenImplicitDdl()
    {
        // Arrange — explicit GO and implicit DDL boundaries coexist.
        string sql = "SELECT 1\nGO\nCREATE PROCEDURE p AS SELECT 1\nCREATE VIEW v AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(3, result.Count);
        Assert.Equal("SELECT 1", result[0]);
        Assert.Equal("CREATE PROCEDURE p AS SELECT 1", result[1]);
        Assert.Equal("CREATE VIEW v AS SELECT 1", result[2]);
    }

    [Fact]
    public void ImplicitSplit_LeadingWhitespaceBeforeDdl()
    {
        // Arrange — leading whitespace before CREATE PROCEDURE still detected.
        string sql = "SELECT 1;\n    CREATE PROCEDURE p AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1;", result[0]);
        Assert.Equal("CREATE PROCEDURE p AS SELECT 1", result[1]);
    }

    [Fact]
    public void ImplicitSplit_DdlAfterSemicolonSameLine()
    {
        // Arrange — DDL right after a ';' on the same line is a statement start.
        string sql = "CREATE TABLE t (id int); CREATE PROCEDURE p AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("CREATE TABLE t (id int);", result[0]);
        Assert.Equal("CREATE PROCEDURE p AS SELECT 1", result[1]);
    }

    [Fact]
    public void ImplicitSplit_AlterProcedure()
    {
        // Arrange — ALTER (not just CREATE) triggers a split.
        string sql = "SELECT 1;\nALTER PROCEDURE p AS SELECT 2";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1;", result[0]);
        Assert.Equal("ALTER PROCEDURE p AS SELECT 2", result[1]);
    }

    // ── Negative: no split must happen ───────────────────────────────────────

    [Fact]
    public void NoSplit_DdlAsFirstStatement()
    {
        // Arrange — a DDL statement on its own must not produce a leading empty batch.
        string sql = "CREATE PROCEDURE p AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("CREATE PROCEDURE p AS SELECT 1", result[0]);
    }

    [Fact]
    public void NoSplit_ColumnNamedProcedureInDml()
    {
        // Arrange — 'procedure'/'function' as identifiers, not preceded by CREATE/ALTER.
        string sql = "SELECT procedure, x FROM mytable WHERE function > 3";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT procedure, x FROM mytable WHERE function > 3", result[0]);
    }

    [Fact]
    public void NoSplit_CreateTableWithColumnNamedProcedure()
    {
        // Arrange — CREATE is followed by TABLE, not a batch-scoped keyword; the
        // later 'procedure' is a column name.
        string sql = "CREATE TABLE t (id INT, procedure NVARCHAR(50), [view] INT)";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("CREATE TABLE t (id INT, procedure NVARCHAR(50), [view] INT)", result[0]);
    }

    [Fact]
    public void NoSplit_KeywordInsideStringLiteral()
    {
        // Arrange — CREATE PROCEDURE inside a single-quoted literal is not a boundary.
        string sql = "INSERT INTO log VALUES ('CREATE PROCEDURE p AS ...');\nSELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("INSERT INTO log VALUES ('CREATE PROCEDURE p AS ...');\nSELECT 1", result[0]);
    }

    [Fact]
    public void NoSplit_KeywordInsideLineComment()
    {
        // Arrange
        string sql = "SELECT 1;\n-- CREATE PROCEDURE p AS nope\nSELECT 2";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1;\n-- CREATE PROCEDURE p AS nope\nSELECT 2", result[0]);
    }

    [Fact]
    public void NoSplit_KeywordInsideBlockComment()
    {
        // Arrange
        string sql = "SELECT 1\n/* CREATE VIEW v AS ... */\nSELECT 2";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1\n/* CREATE VIEW v AS ... */\nSELECT 2", result[0]);
    }

    [Fact]
    public void NoSplit_CreateTableInsideProcBody()
    {
        // Arrange — CREATE TABLE #temp inside a proc body is not a trigger keyword,
        // so the only boundary is between the two procedures.
        string sql =
            "CREATE PROCEDURE p AS\nBEGIN\n  CREATE TABLE #t (id INT);\n  INSERT #t VALUES (1);\n  SELECT * FROM #t;\nEND\n" +
            "CREATE PROCEDURE q AS SELECT 1";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.StartsWith("CREATE PROCEDURE p", result[0]);
        Assert.Contains("CREATE TABLE #t", result[0]);   // inner CREATE TABLE stayed in the body
        Assert.Equal("CREATE PROCEDURE q AS SELECT 1", result[1]);
    }

    [Fact]
    public void NoSplit_WordWithKeywordPrefix()
    {
        // Arrange — an identifier that merely starts with a keyword (VIEWPOINT_THING)
        // must not be matched as VIEW (word-boundary check).
        string sql = "SELECT 1;\nCREATE VIEWPOINT_THING (id int)";

        // Act
        var result = QueryExecutor.SplitSqlServerBatches(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1;\nCREATE VIEWPOINT_THING (id int)", result[0]);
    }
}