using System;
using System.Collections.Generic;
using Xunit;

namespace QueryExecutorTests.Tests;

public class SplitSqlServerBatchesTests
{
    [Fact]
    public void Splits_TwoBatches_OnStandaloneGo()
    {
        // Arrange — note the \n line endings; GO must be alone on its line
        var sql = "SELECT 1\nGO\nSELECT 2";

        // Act
        List<string> batches = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, batches.Count);
        Assert.Equal("SELECT 1", batches[0]);
        Assert.Equal("SELECT 2", batches[1]);
    }
    [Fact]
    public void Splits_TwoBatches_OnStandaloneGo_WindowsLineEndings()
    {
        // Arrange — note the \n line endings; GO must be alone on its line
        var sql = "SELECT 1\r\nGO\r\nSELECT 2";

        // Act
        List<string> batches = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, batches.Count);
        Assert.Equal("SELECT 1", batches[0]);
        Assert.Equal("SELECT 2", batches[1]);
    }
    [Fact]
    public void KeepsDeclareAndUse_InSameBatch_WhenNoGo()
    {
        // Arrange
        string sql = "DECLARE @x INT = 5;\r\nSELECT @x;";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("DECLARE @x INT = 5;\r\nSELECT @x;", result[0]);
    }

    [Fact]
    public void GoWithRepeatCount()
    {
        // Arrange
        string sql = "SELECT 1\nGO 3\n SELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1", result[0]);
        Assert.Equal("SELECT 2", result[1]);
    }

    [Fact]
    public void GoWithLeadingWhitespace_TreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1\r\n  GO\r\nSELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1", result[0]);
        Assert.Equal("SELECT 2", result[1]);
    }

    [Fact]
    public void GoLowercase_TreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1\r\ngo\r\nSELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1", result[0]);
        Assert.Equal("SELECT 2", result[1]);
    }

    [Fact]
    public void GoWithTrailingComment_TreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1\nGO -- This is a comment on the GO line\nSELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1", result[0]);
        Assert.Equal("SELECT 2", result[1]);
    }

    [Fact]
    public void GoInsideAnIdentifier_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT * FROM GOods";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT * FROM GOods", result[0]);
    }

    [Fact]
    public void GoMidLine_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1 GO SELECT 2\r\n";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1 GO SELECT 2", result[0]);
    }

    [Fact]
    public void GoInsideLiteralString_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 'GO'\r\nGO\r\nSELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 'GO'", result[0]);
        Assert.Equal("SELECT 2", result[1]);
    }

    [Fact]
    public void GoInsideLineComment_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1\r\n-- GO\r\nSELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1\r\n-- GO\r\nSELECT 2", result[0]);
    }

    [Fact]
    public void GoInsideBlockComment_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1 /* GO */ SELECT 2";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1 /* GO */ SELECT 2", result[0]);
    }

    [Fact]
    public void WordStartingWithGoFollowedByMore_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "GOTO label";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("GOTO label", result[0]);
    }

    [Fact]
    public void TrailingGoWithNothingAfter_IgnoresTrailingGo()
    {
        // Arrange
        string sql = "\r\nSELECT 1\r\nGO";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1", result[0]);
    }

    [Fact]
    public void LeadingGo_IgnoresLeadingGo()
    {
        // Arrange
        string sql = "GO\r\nSELECT 1";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT 1", result[0]);
    }

    [Fact]
    public void EmptyString_ReturnsEmptyList()
    {
        // Arrange
        string sql = "";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Empty(result);
    }

    [Fact]
    public void OnlyWhitespace_ReturnsEmptyList()
    {
        // Arrange
        string sql = "   \n\t\n  ";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Empty(result);
    }

    [Fact]
    public void NoGoatAll_ReturnsBatch()
    {
        // Arrange
        string sql = "\r\nDECLARE @x INT = 1;\r\nSELECT @x;\r\nSELECT @x + 1;";

        // Act
        var result = SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("DECLARE @x INT = 1;\r\nSELECT @x;\r\nSELECT @x + 1;", result[0]);
    }

    [Fact]
    public void GoOnlyInMiddleOfLine_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "x GO y";

        // Act
        var result = global::SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("x GO y", result[0]);
    }

    [Fact]
    public void ComplexBatch_WithComments_AndStrings()
    {
        // Arrange
        string sql = @"-- This is a comment
                    CREATE TABLE Users (
                        Id INT PRIMARY KEY,
                        Name NVARCHAR(100)
                    )
                    GO

                    INSERT INTO Users VALUES (1, 'John')
                    -- GO this is not a separator
                    /* GO this is also not a separator */
                    GO

                    SELECT * FROM Users";

        // Act
        var result = global::SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(3, result.Count);
        Assert.Contains("CREATE TABLE Users", result[0]);
        Assert.Contains("INSERT INTO Users", result[1]);
        Assert.Contains("SELECT * FROM Users", result[2]);
    }

    [Fact]
    public void DoubleQuotedString_GoInside_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT \"GO\" AS text";

        // Act
        var result = global::SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT \"GO\" AS text", result[0]);
    }

    [Fact]
    public void BacktickQuotedString_GoInside_NotTreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT `GO` AS text";

        // Act
        var result = global::SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Single(result);
        Assert.Equal("SELECT `GO` AS text", result[0]);
    }

    [Fact]
    public void GoWithTrailingWhitespace_TreatedAsSeparator()
    {
        // Arrange
        string sql = "SELECT 1\nGO   \t  \nSELECT 2";

        // Act
        var result = global::SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Equal("SELECT 1", result[0]);
        Assert.Equal("SELECT 2", result[1]);
    }

    [Fact]
    public void MultilineStatement_WithinBatch_PreservedCorrectly()
    {
        // Arrange
        string sql = @"SELECT
    Column1,
    Column2
FROM Table1
GO
SELECT * FROM Table2";

        // Act
        var result = global::SqlServerBatchSplitter.Split(sql);

        // Assert
        Assert.Equal(2, result.Count);
        Assert.Contains("Column1", result[0]);
        Assert.Contains("Column2", result[0]);
        Assert.Contains("Table1", result[0]);
    }
}
