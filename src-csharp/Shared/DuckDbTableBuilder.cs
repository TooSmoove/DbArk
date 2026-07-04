#nullable enable
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

/// <summary>
/// Pure, side-effect-free helpers that build the in-memory DuckDB table used to
/// stage a live-database table for a flat-file ↔ live-DB join (audit C-5).
///
/// THE BUG THIS FIXES: the join used to register every live-DB column as TEXT and
/// insert every value as a quoted string. DuckDB then compared a type-inferred file
/// column (read_csv_auto gives BIGINT/DATE/DOUBLE/…) against an all-TEXT live column,
/// so an integer/date join key — or any WHERE range on the live side — silently fell
/// back to lexicographic string semantics ('9' &gt; '10' is TRUE as text). The flagship
/// "spreadsheet meets live DB" demo could therefore return WRONG rows on any
/// non-string key. This class carries the source column's type across the boundary and
/// emits a correctly-typed DuckDB column + literal, so comparisons and joins use real
/// type semantics on both sides.
///
/// It contains NO DuckDB / native P/Invoke on purpose, so it unit-tests with no harness
/// (same pattern as <see cref="NativeString"/>). The file is &lt;Compile Include&gt;-linked
/// into FileQueryEngine (which uses it) and into the test project (which tests it).
///
/// Trade-off note: floating-point and decimal source columns both fold to DOUBLE.
/// That preserves ordering for joins/comparisons and loses
/// decimal exactness — acceptable for a cross-engine query tool, and integer keys stay exact.
/// </summary>
public static class DuckDbTableBuilder
{
    /// <summary>The DuckDB column type a source value maps to. VARCHAR is the safe default.</summary>
    public enum DuckType { Varchar, Bigint, Double, Boolean, Date, Timestamp, Time, Blob }

    /// <summary>DuckDB type keyword for a DuckType — used verbatim in CREATE TABLE.</summary>
    public static string TypeName(DuckType t) => t switch
    {
        DuckType.Bigint => "BIGINT",
        DuckType.Double => "DOUBLE",
        DuckType.Boolean => "BOOLEAN",
        DuckType.Date => "DATE",
        DuckType.Timestamp => "TIMESTAMP",
        DuckType.Time => "TIME",
        DuckType.Blob => "BLOB",
        _ => "VARCHAR",
    };

    /// <summary>Inverse of <see cref="TypeName"/>: parse a DuckDB type keyword back to a DuckType.</summary>
    public static DuckType TypeFromName(string? name) => (name ?? "").Trim().ToUpperInvariant() switch
    {
        "BIGINT" => DuckType.Bigint,
        "DOUBLE" => DuckType.Double,
        "BOOLEAN" => DuckType.Boolean,
        "DATE" => DuckType.Date,
        "TIMESTAMP" => DuckType.Timestamp,
        "TIME" => DuckType.Time,
        "BLOB" => DuckType.Blob,
        _ => DuckType.Varchar,
    };

    /// <summary>
    /// Maps a CLR type (from <c>IDataReader.GetFieldType</c>) to a DuckDB column type.
    /// Integer widths fold to BIGINT; floating/decimal fold to DOUBLE (see class note);
    /// anything text-shaped (string, Guid, char, ulong-that-could-overflow-BIGINT) stays
    /// VARCHAR, where text semantics are actually correct.
    /// </summary>
    public static DuckType MapClrType(Type? type)
    {
        if (type == null) return DuckType.Varchar;
        type = Nullable.GetUnderlyingType(type) ?? type;

        if (type == typeof(bool)) return DuckType.Boolean;

        if (type == typeof(byte) || type == typeof(sbyte) ||
            type == typeof(short) || type == typeof(ushort) ||
            type == typeof(int) || type == typeof(uint) ||
            type == typeof(long))
            return DuckType.Bigint;

        // ulong can exceed BIGINT's range — keep as text rather than risk overflow.
        if (type == typeof(ulong)) return DuckType.Varchar;

        if (type == typeof(float) || type == typeof(double) || type == typeof(decimal))
            return DuckType.Double;

        if (type == typeof(DateTime) || type == typeof(DateTimeOffset)) return DuckType.Timestamp;
        if (type == typeof(DateOnly)) return DuckType.Date;
        if (type == typeof(TimeOnly) || type == typeof(TimeSpan)) return DuckType.Time;
        if (type == typeof(byte[])) return DuckType.Blob;

        return DuckType.Varchar;
    }

    /// <summary>
    /// Formats a CLR value (from <c>IDataReader.GetValue</c>) to the invariant string we
    /// stage in the intermediate JSON. Invariant formatting is mandatory: a DateTime or
    /// double rendered with the host's local culture would not round-trip into a typed
    /// DuckDB column (e.g. "1/2/2024" or a comma decimal separator). Returns null for
    /// null/DBNull.
    /// </summary>
    public static string? FormatClrValue(object? value)
    {
        switch (value)
        {
            case null:
            case DBNull: return null;
            case bool b: return b ? "true" : "false";
            case byte[] bytes: return Convert.ToHexString(bytes);                 // uppercase hex → BLOB literal
            case DateTime dt: return dt.ToString("yyyy-MM-dd HH:mm:ss.ffffff", CultureInfo.InvariantCulture);
            case DateTimeOffset dto: return dto.UtcDateTime.ToString("yyyy-MM-dd HH:mm:ss.ffffff", CultureInfo.InvariantCulture);
            case DateOnly d: return d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            case TimeOnly t: return t.ToString("HH:mm:ss.ffffff", CultureInfo.InvariantCulture);
            case TimeSpan ts: return ts.ToString(@"hh\:mm\:ss\.ffffff", CultureInfo.InvariantCulture);
            case float f: return f.ToString("G9", CultureInfo.InvariantCulture);
            case double db: return db.ToString("G17", CultureInfo.InvariantCulture);
            case decimal m: return m.ToString(CultureInfo.InvariantCulture);
            case IFormattable fmt: return fmt.ToString(null, CultureInfo.InvariantCulture);
            default: return value.ToString();
        }
    }

    /// <summary>Quotes a SQL identifier for DuckDB, doubling embedded double-quotes (audit H-1).</summary>
    public static string QuoteIdent(string ident) => "\"" + (ident ?? "").Replace("\"", "\"\"") + "\"";

    /// <summary>Quotes a string literal for DuckDB, doubling embedded single-quotes.</summary>
    public static string QuoteLiteral(string value) => "'" + value.Replace("'", "''") + "'";

    /// <summary>
    /// Renders one staged value as a DuckDB SQL literal for INSERT, given its target
    /// column type. Numerics/booleans are emitted UNQUOTED (so DuckDB stores and later
    /// compares them as numbers, not text — this is the heart of the C-5 fix); temporal
    /// values are emitted as a quoted ISO string that DuckDB casts into the typed column;
    /// text is quoted and escaped. A value that fails to parse as its declared
    /// numeric/boolean type falls back to a quoted literal so one dirty cell never aborts
    /// the whole INSERT batch.
    /// </summary>
    public static string RenderLiteral(DuckType type, string? value)
    {
        if (value == null) return "NULL";

        switch (type)
        {
            case DuckType.Bigint:
                return long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out _)
                    ? value
                    : QuoteLiteral(value);

            case DuckType.Double:
                if (double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                    return double.IsFinite(d) ? value : "NULL";   // NaN/Infinity can't be a bare literal
                return QuoteLiteral(value);

            case DuckType.Boolean:
                return value.ToLowerInvariant() switch
                {
                    "true" or "1" => "TRUE",
                    "false" or "0" => "FALSE",
                    _ => QuoteLiteral(value),
                };

            case DuckType.Blob:
                // value is uppercase hex from FormatClrValue → DuckDB blob literal.
                return $"'\\x{value}'::BLOB";

            // Date / Timestamp / Time / Varchar: a quoted, escaped string. DuckDB casts the
            // ISO-formatted literal into the typed column on insert.
            default:
                return QuoteLiteral(value);
        }
    }

    /// <summary>Builds the typed CREATE TABLE for a staged live table.</summary>
    public static string BuildCreateTable(
        string duckTableName,
        IReadOnlyList<string> columns,
        IReadOnlyList<DuckType> types)
    {
        var defs = new List<string>(columns.Count);
        for (int i = 0; i < columns.Count; i++)
        {
            var t = i < types.Count ? types[i] : DuckType.Varchar;
            defs.Add($"{QuoteIdent(columns[i])} {TypeName(t)}");
        }
        return $"CREATE TABLE {QuoteIdent(duckTableName)} ({string.Join(", ", defs)})";
    }

    /// <summary>
    /// Builds one INSERT for a batch of rows. Each row is a list of already-invariant
    /// string values positionally aligned to <paramref name="columns"/>.
    /// </summary>
    public static string BuildInsert(
        string duckTableName,
        IReadOnlyList<string> columns,
        IReadOnlyList<DuckType> types,
        IEnumerable<IReadOnlyList<string?>> rows)
    {
        var tuples = rows.Select(r =>
        {
            var vals = new List<string>(columns.Count);
            for (int i = 0; i < columns.Count; i++)
            {
                var t = i < types.Count ? types[i] : DuckType.Varchar;
                var v = i < r.Count ? r[i] : null;
                vals.Add(RenderLiteral(t, v));
            }
            return "(" + string.Join(", ", vals) + ")";
        });
        return $"INSERT INTO {QuoteIdent(duckTableName)} VALUES {string.Join(",\n", tuples)}";
    }
}