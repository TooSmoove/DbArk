#nullable enable
using System.Text.RegularExpressions;

/// <summary>
/// Pure input-validation core for connection parameters (audit: the injection
/// defense at the config layer). Kept as a plain static class with no I/O so it
/// can be compiled directly into the test project and unit-tested without a
/// live keychain, filesystem, or built native library (see AGENTS.md).
/// </summary>
internal static class InputValidation
{
    internal static bool IsValidHost(string host)
    {
        if (string.IsNullOrWhiteSpace(host)) return false;
        // Allow hostnames, IP addresses, and localhost
        // Reject semicolons, equals signs, and other connection string injection characters
        return Regex.IsMatch(host, @"^[a-zA-Z0-9._\-]{1,253}$");
    }

    internal static bool IsValidPort(int port) => port >= 0 && port <= 65535;

    internal static bool IsValidIdentifier(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        // Allow alphanumeric, underscores, hyphens, and dots
        // Reject semicolons, equals, quotes — anything that could break a connection string
        return Regex.IsMatch(value, @"^[a-zA-Z0-9_\-\.]{1,128}$");
    }

    // The allow-list lives in Shared/EngineNames.cs (audit A-2) — exact match,
    // canonical lowercase, same contract as before.
    internal static bool IsValidEngine(string engine) => EngineNames.IsKnown(engine);

    internal static bool IsValidSslMode(string sslMode) =>
        sslMode is "none" or "prefer" or "require" or "verify-full";

    internal static int GetDefaultPort(string engine) => engine.ToLower() switch
    {
        "sqlserver" => 1433,
        "mysql" => 3306,
        "mariadb" => 3306,
        "postgres" => 5432,
        "cockroachdb" => 26257,
        "sqlite" => 0,
        _ => 3306
    };
}
