#nullable enable
using System.Linq;
using Xunit;

namespace QueryExecutorTests.Tests;

// Shared/EngineNames.cs is the C# layer's canonical engine list (audit A-2).
// These pin the contract: exactly six engines, canonical lowercase, and the
// config validator's exact-match semantics.
public class EngineNamesTests
{
    [Fact]
    public void The_canonical_list_is_exactly_the_six_supported_engines()
    {
        Assert.Equal(
            new[] { "sqlserver", "postgres", "cockroachdb", "mysql", "mariadb", "sqlite" },
            EngineNames.All);
    }

    [Fact]
    public void IsKnown_is_exact_match_on_canonical_lowercase()
    {
        Assert.All(EngineNames.All, e => Assert.True(EngineNames.IsKnown(e)));
        // The wire contract is lowercase — the validator must not loosen it.
        Assert.False(EngineNames.IsKnown("MySQL"));
        Assert.False(EngineNames.IsKnown("oracle"));
        Assert.False(EngineNames.IsKnown(""));
    }

    [Fact]
    public void Config_validation_delegates_to_the_canonical_list()
    {
        Assert.All(EngineNames.All, e => Assert.True(InputValidation.IsValidEngine(e)));
        Assert.False(InputValidation.IsValidEngine("MariaDB")); // exact match, as before A-2
    }
}
