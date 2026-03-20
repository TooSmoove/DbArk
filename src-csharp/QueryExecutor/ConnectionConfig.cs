#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public class ConnectionConfig
{
    public string Name { get; set; } = "";
    public string Engine { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string Database { get; set; } = "";
    public string Username { get; set; } = "";
    public string CredentialRef { get; set; } = "";
    public string Color { get; set; } = "";
    public string Group { get; set; } = "";
}

public static class ConnectionLoader
{
    [UnmanagedCallersOnly(EntryPoint = "load_connection")]
    public static IntPtr LoadConnection(IntPtr pathPtr)
    {
        try
        {
            string? path = Marshal.PtrToStringUTF8(pathPtr);
            if (string.IsNullOrEmpty(path) || !File.Exists(path))
                return Marshal.StringToCoTaskMemUTF8("ERROR: file not found");

            string toml = File.ReadAllText(path);
            var values = ParseToml(toml);

            var conn = new ConnectionConfig
            {
                Name = values.GetValueOrDefault("connection.name", ""),
                Engine = values.GetValueOrDefault("connection.engine", ""),
                Host = values.GetValueOrDefault("connection.host", ""),
                Port = int.TryParse(values.GetValueOrDefault("connection.port", "1433"), out int p) ? p : 1433,
                Database = values.GetValueOrDefault("connection.database", ""),
                Username = values.GetValueOrDefault("connection.username", ""),
                CredentialRef = values.GetValueOrDefault("connection.credential_ref", ""),
                Color = values.GetValueOrDefault("display.color", ""),
                Group = values.GetValueOrDefault("display.group", "")
            };

            return Marshal.StringToCoTaskMemUTF8(
                $"OK: {conn.Name} | {conn.Engine} | {conn.Host}:{conn.Port}/{conn.Database}"
            );
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    // Simple TOML parser — handles [sections] and key = "value" pairs
    // Good enough for connection files, no external dependencies
    private static Dictionary<string, string> ParseToml(string toml)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string currentSection = "";

        foreach (string rawLine in toml.Split('\n'))
        {
            string line = rawLine.Trim();

            // Skip empty lines and comments
            if (string.IsNullOrEmpty(line) || line.StartsWith('#'))
                continue;

            // Section header e.g. [connection]
            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                currentSection = line[1..^1].Trim();
                continue;
            }

            // Key = value pair
            int eq = line.IndexOf('=');
            if (eq < 0) continue;

            string key = line[..eq].Trim();
            string value = line[(eq + 1)..].Trim();

            // Strip surrounding quotes from string values
            if (value.StartsWith('"') && value.EndsWith('"'))
                value = value[1..^1];

            string fullKey = string.IsNullOrEmpty(currentSection)
                ? key
                : $"{currentSection}.{key}";

            result[fullKey] = value;
        }

        return result;
    }
}