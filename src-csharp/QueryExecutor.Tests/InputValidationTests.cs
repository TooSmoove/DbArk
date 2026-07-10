using Xunit;

/// <summary>
/// Pins the connection-input allow-lists in <c>ConnectionManager</c> (audit
/// "genuinely good — don't regress" item: injection defense at the config
/// layer). These validators are the only thing standing between user-supplied
/// connection fields and the TOML/connection-string builders, so every rule
/// here is a security contract, not a style preference.
/// </summary>
public class InputValidationTests
{
    // ---- IsValidHost -------------------------------------------------------

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    [InlineData("db.internal.example.com")]
    [InlineData("my-server_01")]
    public void Host_AcceptsHostnamesAndIps(string host) =>
        Assert.True(InputValidation.IsValidHost(host));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("host;Database=master")]   // connection-string injection
    [InlineData("host=evil")]
    [InlineData("host name")]              // embedded space
    [InlineData("host'--")]
    [InlineData("{host}")]
    public void Host_RejectsInjectionCharacters(string host) =>
        Assert.False(InputValidation.IsValidHost(host));

    [Fact]
    public void Host_RejectsOverlongNames()
    {
        Assert.True(InputValidation.IsValidHost(new string('a', 253)));
        Assert.False(InputValidation.IsValidHost(new string('a', 254)));
    }

    // ---- IsValidPort -------------------------------------------------------

    [Theory]
    [InlineData(0)]
    [InlineData(1433)]
    [InlineData(65535)]
    public void Port_AcceptsValidRange(int port) =>
        Assert.True(InputValidation.IsValidPort(port));

    [Theory]
    [InlineData(-1)]
    [InlineData(65536)]
    public void Port_RejectsOutOfRange(int port) =>
        Assert.False(InputValidation.IsValidPort(port));

    // ---- IsValidIdentifier (username / database) ---------------------------

    [Theory]
    [InlineData("sa")]
    [InlineData("dbark_demo")]
    [InlineData("app-user.readonly")]
    public void Identifier_AcceptsTypicalNames(string value) =>
        Assert.True(InputValidation.IsValidIdentifier(value));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("user;Trusted_Connection=yes")]
    [InlineData("user=admin")]
    [InlineData("user'or'1'='1")]
    [InlineData("db\"name")]
    public void Identifier_RejectsInjectionCharacters(string value) =>
        Assert.False(InputValidation.IsValidIdentifier(value));

    [Fact]
    public void Identifier_RejectsOverlongValues()
    {
        Assert.True(InputValidation.IsValidIdentifier(new string('a', 128)));
        Assert.False(InputValidation.IsValidIdentifier(new string('a', 129)));
    }

    // ---- IsValidEngine — the supported-engine allow-list is a contract ------

    [Theory]
    [InlineData("mysql")]
    [InlineData("mariadb")]
    [InlineData("postgres")]
    [InlineData("cockroachdb")]
    [InlineData("sqlite")]
    [InlineData("sqlserver")]
    public void Engine_AcceptsEverySupportedEngine(string engine) =>
        Assert.True(InputValidation.IsValidEngine(engine));

    [Theory]
    [InlineData("")]
    [InlineData("oracle")]
    [InlineData("SQLSERVER")]   // allow-list is deliberately case-sensitive
    [InlineData("sqlserver ")]
    public void Engine_RejectsUnknownOrMiscasedEngines(string engine) =>
        Assert.False(InputValidation.IsValidEngine(engine));

    // ---- IsValidSslMode ------------------------------------------------------

    [Theory]
    [InlineData("none")]
    [InlineData("prefer")]
    [InlineData("require")]
    [InlineData("verify-full")]
    public void SslMode_AcceptsEverySupportedMode(string mode) =>
        Assert.True(InputValidation.IsValidSslMode(mode));

    [Theory]
    [InlineData("")]
    [InlineData("disable")]
    [InlineData("Require")]
    public void SslMode_RejectsUnknownModes(string mode) =>
        Assert.False(InputValidation.IsValidSslMode(mode));

    // ---- GetDefaultPort — must stay aligned with the engine allow-list ------

    [Theory]
    [InlineData("sqlserver", 1433)]
    [InlineData("mysql", 3306)]
    [InlineData("mariadb", 3306)]
    [InlineData("postgres", 5432)]
    [InlineData("cockroachdb", 26257)]
    [InlineData("sqlite", 0)]
    public void DefaultPort_MatchesEngineConvention(string engine, int expected) =>
        Assert.Equal(expected, InputValidation.GetDefaultPort(engine));

    [Fact]
    public void DefaultPort_IsCaseInsensitiveUnlikeTheAllowList() =>
        Assert.Equal(1433, InputValidation.GetDefaultPort("SqlServer"));

    /// <summary>
    /// Regression guard: every engine the allow-list accepts must have a real
    /// (non-fallback) default port, so adding an engine to one place and not
    /// the other fails here instead of at a user's connection dialog.
    /// </summary>
    [Theory]
    [InlineData("mysql")]
    [InlineData("mariadb")]
    [InlineData("postgres")]
    [InlineData("cockroachdb")]
    [InlineData("sqlite")]
    [InlineData("sqlserver")]
    public void EveryAllowedEngineHasADefaultPort(string engine)
    {
        Assert.True(InputValidation.IsValidEngine(engine));
        int port = InputValidation.GetDefaultPort(engine);
        Assert.True(InputValidation.IsValidPort(port));
    }
}
