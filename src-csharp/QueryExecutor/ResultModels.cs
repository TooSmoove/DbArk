#nullable enable
using System.Collections.Generic;
using System.Text.Json.Serialization;

// ── Result types ────────────────────────────────────────────────────────────
// The wire shapes serialized back across the FFI boundary. Property names are
// contract-frozen (camelCase over the wire) — the Rust host and the frontend
// both parse these exact fields.

public class QueryResult
{
    [JsonPropertyName("columns")] public List<string> Columns { get; set; } = new();
    [JsonPropertyName("rows")] public List<List<string?>> Rows { get; set; } = new();
    [JsonPropertyName("rowCount")] public int RowCount { get; set; }
    [JsonPropertyName("truncated")] public bool Truncated { get; set; }
    [JsonPropertyName("largeResult")] public bool LargeResult { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
    [JsonPropertyName("isMessage")] public bool IsMessage { get; set; }
    [JsonPropertyName("sql")] public string? Sql { get; set; }
    [JsonPropertyName("wasRewritten")] public bool WasRewritten { get; set; }
}

public class MultiResult
{
    [JsonPropertyName("results")] public List<QueryResult> Results { get; set; } = new();
}

public class ErrorResult
{
    [JsonPropertyName("error")] public string Error { get; set; } = "";
}

[JsonSerializable(typeof(QueryResult))]
[JsonSerializable(typeof(MultiResult))]
[JsonSerializable(typeof(ErrorResult))]
[JsonSerializable(typeof(List<QueryResult>))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
internal partial class AppJsonContext : JsonSerializerContext { }
