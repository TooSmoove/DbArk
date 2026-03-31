#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

public class ConnectionConfig
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Engine { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string Database { get; set; } = "";
    public string Username { get; set; } = "";
    public string CredentialRef { get; set; } = "";
    public string Color { get; set; } = "#6c63ff";
    public string Group { get; set; } = "";
    public string FilePath { get; set; } = "";
}

public class ConnectionListResult
{
    public List<ConnectionConfig> Connections { get; set; } = new();
    public string? Error { get; set; }
}

public class SaveConnectionRequest
{
    public string Name { get; set; } = "";
    public string Engine { get; set; } = "";
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string Database { get; set; } = "";
    public string Username { get; set; } = "";
    public string Color { get; set; } = "#6c63ff";
    public string Group { get; set; } = "";
    public string FolderPath { get; set; } = "";
}

public static class ConnectionManagerLib
{
    [UnmanagedCallersOnly(EntryPoint = "list_connections")]
    public static IntPtr ListConnections(IntPtr folderPathPtr)
    {
        try
        {
            string? folderPath = Marshal.PtrToStringUTF8(folderPathPtr);
            if (string.IsNullOrEmpty(folderPath))
                folderPath = GetDefaultConnectionsFolder();

            if (!Directory.Exists(folderPath))
                Directory.CreateDirectory(folderPath);

            var connections = new List<ConnectionConfig>();

            foreach (string file in Directory.GetFiles(folderPath, "*.toml"))
            {
                try
                {
                    var config = ParseTomlFile(file);
                    if (config != null)
                        connections.Add(config);
                }
                catch { /* skip malformed files */ }
            }

            var result = new ConnectionListResult { Connections = connections };
            string json = JsonSerializer.Serialize(
                result, AppJsonContext.Default.ConnectionListResult);
            return Marshal.StringToCoTaskMemUTF8(json);
        }
        catch (Exception ex)
        {
            var error = new ConnectionListResult { Error = ex.Message };
            string json = JsonSerializer.Serialize(
                error, AppJsonContext.Default.ConnectionListResult);
            return Marshal.StringToCoTaskMemUTF8(json);
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "save_connection")]
    public static IntPtr SaveConnection(IntPtr requestJsonPtr)
    {
        try
        {
            string? requestJson = Marshal.PtrToStringUTF8(requestJsonPtr);
            if (string.IsNullOrEmpty(requestJson))
                return Marshal.StringToCoTaskMemUTF8("ERROR: empty request");

            var request = JsonSerializer.Deserialize(
                requestJson, AppJsonContext.Default.SaveConnectionRequest);
            if (request == null)
                return Marshal.StringToCoTaskMemUTF8("ERROR: invalid request");

            string folderPath = string.IsNullOrEmpty(request.FolderPath)
                ? GetDefaultConnectionsFolder()
                : request.FolderPath;

            if (!Directory.Exists(folderPath))
                Directory.CreateDirectory(folderPath);

            // Generate a safe filename from the connection name
            string safeName = request.Name.ToLower().Replace(" ", "-");
            string filePath = Path.Combine(folderPath, $"{safeName}.toml");

            // Generate a unique credential ref key
            string credentialRef = $"devsql:{safeName}:{request.Username}";

            // Build the default port if not set
            int port = request.Port > 0 ? request.Port : GetDefaultPort(request.Engine);

            string toml = $"""
                [connection]
                name = "{request.Name}"
                engine = "{request.Engine}"
                host = "{request.Host}"
                port = {port}
                database = "{request.Database}"
                username = "{request.Username}"
                credential_ref = "{credentialRef}"

                [display]
                color = "{request.Color}"
                group = "{request.Group}"
                """;

            File.WriteAllText(filePath, toml);

            return Marshal.StringToCoTaskMemUTF8($"OK:{filePath}|{credentialRef}");
        }
        catch (Exception ex)
        {
            return Marshal.StringToCoTaskMemUTF8($"ERROR: {ex.Message}");
        }
    }

    [UnmanagedCallersOnly(EntryPoint = "delete_connection")]
    public static int DeleteConnection(IntPtr filePathPtr)
    {
        try
        {
            string? filePath = Marshal.PtrToStringUTF8(filePathPtr);
            if (string.IsNullOrEmpty(filePath) || !File.Exists(filePath))
                return 0;

            File.Delete(filePath);
            return 1;
        }
        catch
        {
            return 0;
        }
    }

    private static string GetDefaultConnectionsFolder()
    {
        string home = Environment.GetFolderPath(
            Environment.SpecialFolder.UserProfile);
        string path = Path.Combine(home, ".devsql", "connections");

        if (!Directory.Exists(path))
        {
            Directory.CreateDirectory(path);

            // Windows: restrict folder to current user only
            if (OperatingSystem.IsWindows())
            {
                var dirInfo = new System.IO.DirectoryInfo(path);
                var security = dirInfo.GetAccessControl();
                // Remove inherited permissions
                security.SetAccessRuleProtection(true, false);
                // Add current user with full control
                var currentUser = System.Security.Principal.WindowsIdentity
                    .GetCurrent().Name;
                security.AddAccessRule(
                    new System.Security.AccessControl.FileSystemAccessRule(
                        currentUser,
                        System.Security.AccessControl.FileSystemRights.FullControl,
                        System.Security.AccessControl.AccessControlType.Allow));
                dirInfo.SetAccessControl(security);
            }
        }
        return path;
    }

    private static int GetDefaultPort(string engine) => engine.ToLower() switch
    {
        "sqlserver" => 1433,
        "mysql" => 3306,
        "postgres" => 5432,
        "sqlite" => 0,
        _ => 3306
    };

    private static ConnectionConfig? ParseTomlFile(string filePath)
    {
        string toml = File.ReadAllText(filePath);
        var values = ParseToml(toml);

        // Generate a stable ID from the filename
        string id = Path.GetFileNameWithoutExtension(filePath);

        return new ConnectionConfig
        {
            Id = id,
            Name = values.GetValueOrDefault("connection.name", id),
            Engine = values.GetValueOrDefault("connection.engine", "mysql"),
            Host = values.GetValueOrDefault("connection.host", ""),
            Port = int.TryParse(values.GetValueOrDefault("connection.port", "3306"), out int p) ? p : 3306,
            Database = values.GetValueOrDefault("connection.database", ""),
            Username = values.GetValueOrDefault("connection.username", ""),
            CredentialRef = values.GetValueOrDefault("connection.credential_ref", ""),
            Color = values.GetValueOrDefault("display.color", "#6c63ff"),
            Group = values.GetValueOrDefault("display.group", ""),
            FilePath = filePath
        };
    }

    private static Dictionary<string, string> ParseToml(string toml)
    {
        var result = new Dictionary<string, string>(
            StringComparer.OrdinalIgnoreCase);
        string currentSection = "";

        foreach (string rawLine in toml.Split('\n'))
        {
            string line = rawLine.Trim();
            if (string.IsNullOrEmpty(line) || line.StartsWith('#'))
                continue;

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                currentSection = line[1..^1].Trim();
                continue;
            }

            int eq = line.IndexOf('=');
            if (eq < 0) continue;

            string key = line[..eq].Trim();
            string value = line[(eq + 1)..].Trim();

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

[JsonSerializable(typeof(ConnectionConfig))]
[JsonSerializable(typeof(ConnectionListResult))]
[JsonSerializable(typeof(SaveConnectionRequest))]
[JsonSerializable(typeof(List<ConnectionConfig>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AppJsonContext : JsonSerializerContext { }