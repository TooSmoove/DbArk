#nullable enable
using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Xunit;

namespace DbArk.Integration;

/// <summary>
/// Integration test for the live-table SQLite reader the flat-file join stages
/// from (<c>FileQueryEngineLib.ExecuteSqliteDb</c>). It reads a real SQLite table
/// and emits the intermediate JSON — crucially carrying a DuckDB TYPE per column
/// (audit C-5) so the staged table is built typed rather than all-TEXT.
///
/// Windows-only: this path P/Invokes <c>winsqlite3.dll</c> and the FileQueryEngine
/// assembly already owns its single DllImport resolver (for duckdb), so no
/// cross-platform SQLite shim can be installed here. The CI integration job runs
/// on Windows, where winsqlite3 is present.
/// </summary>
public sealed class SqliteStagingIntegrationTests : IDisposable
{
    private readonly string _dbPath;
    private readonly string _conn;

    public SqliteStagingIntegrationTests()
    {
        _dbPath = Path.Combine(Path.GetTempPath(), $"dbark_stage_it_{Guid.NewGuid():N}.sqlite");
        _conn = $"Data Source={_dbPath}";
    }

    public void Dispose()
    {
        try { File.Delete(_dbPath); } catch { /* best-effort */ }
    }

    [Fact]
    public void Reader_infers_a_duckdb_type_per_column_and_returns_rows()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(),
            "ExecuteSqliteDb P/Invokes winsqlite3.dll; the FileQueryEngine assembly owns the only DllImport resolver so no SQLite shim can be added off-Windows.");

        SqliteTestDb.Seed(
            _dbPath,
            "CREATE TABLE t (id INTEGER, amount REAL, name TEXT)",
            "INSERT INTO t (id, amount, name) VALUES (1, 9.5, 'ada')");

        var json = FileQueryEngineLib.ExecuteSqliteDb(_conn, "SELECT id, amount, name FROM t");

        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        var columns = root.GetProperty("columns").EnumerateArray().Select(e => e.GetString()).ToArray();
        var types = root.GetProperty("types").EnumerateArray().Select(e => e.GetString()).ToArray();
        var firstRow = root.GetProperty("rows").EnumerateArray().First()
            .EnumerateArray().Select(e => e.ValueKind == JsonValueKind.Null ? null : e.GetString()).ToArray();

        Assert.Equal(new[] { "id", "amount", "name" }, columns);
        // The heart of C-5: numeric columns are typed, not staged as text.
        Assert.Equal(new[] { "BIGINT", "DOUBLE", "VARCHAR" }, types);
        Assert.Equal(new[] { "1", "9.5", "ada" }, firstRow);
    }

    [Fact]
    public void Null_cells_round_trip_as_json_null()
    {
        Assert.SkipUnless(OperatingSystem.IsWindows(), "winsqlite3.dll path — Windows only (see class remarks).");

        SqliteTestDb.Seed(
            _dbPath,
            "CREATE TABLE t (id INTEGER, note TEXT)",
            "INSERT INTO t (id, note) VALUES (1, NULL)");

        var json = FileQueryEngineLib.ExecuteSqliteDb(_conn, "SELECT id, note FROM t");

        using var doc = JsonDocument.Parse(json);
        var firstRow = doc.RootElement.GetProperty("rows").EnumerateArray().First().EnumerateArray().ToArray();

        Assert.Equal("1", firstRow[0].GetString());
        Assert.Equal(JsonValueKind.Null, firstRow[1].ValueKind);
    }
}
