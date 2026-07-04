using Xunit;

/// <summary>
/// Pins the consuming half of the SQLite connection-string contract (audit A-3).
/// The producing half is <c>build_sqlite_conn</c> in <c>src-tauri/src/main.rs</c>,
/// pinned by <c>conn_string_tests</c> there. Before centralization this parse was
/// copy-pasted at five sites; the drifted variant in SchemaExplorer stripped
/// "Data Source=" anywhere in the string — the tests below guard against exactly
/// that class of regression.
/// </summary>
public class SqliteConnectionStringTests
{
    [Fact]
    public void ExtractsPathFromDataSourceForm()
    {
        Assert.Equal(@"C:\data\app.db",
            SqliteConnectionString.ExtractPath(@"Data Source=C:\data\app.db"));
    }

    [Fact]
    public void PrefixMatchIsCaseInsensitive()
    {
        Assert.Equal("/tmp/x.db", SqliteConnectionString.ExtractPath("data source=/tmp/x.db"));
        Assert.Equal("/tmp/x.db", SqliteConnectionString.ExtractPath("DATA SOURCE=/tmp/x.db"));
    }

    [Fact]
    public void BarePathPassesThroughUnchanged()
    {
        Assert.Equal(@"C:\data\app.db", SqliteConnectionString.ExtractPath(@"C:\data\app.db"));
    }

    [Fact]
    public void TrimsOuterWhitespaceButPreservesInnerSpaces()
    {
        Assert.Equal("/Users/O'Brien/my data.db",
            SqliteConnectionString.ExtractPath("  Data Source=/Users/O'Brien/my data.db  "));
    }

    [Fact]
    public void PrefixInsideThePathIsNotStripped()
    {
        // The old .Replace variant in SchemaExplorer.SqliteQuery would mangle
        // this path to @"C:\Data Source=weird\app.db" -> @"C:\weird\app.db".
        Assert.Equal(@"C:\Data Source=weird\app.db",
            SqliteConnectionString.ExtractPath(@"Data Source=C:\Data Source=weird\app.db"));
    }

    [Fact]
    public void OnlyTheFirstPrefixIsConsumed()
    {
        Assert.Equal("Data Source=x.db",
            SqliteConnectionString.ExtractPath("Data Source=Data Source=x.db"));
    }

    [Fact]
    public void NullAndEmptyReturnEmpty()
    {
        Assert.Equal(string.Empty, SqliteConnectionString.ExtractPath(null));
        Assert.Equal(string.Empty, SqliteConnectionString.ExtractPath("   "));
    }
}
