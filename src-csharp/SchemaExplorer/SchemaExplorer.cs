#nullable enable
using Microsoft.Data.SqlClient;
using MySqlConnector;
using Npgsql;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using static SqlServerOdbc;

public class TableInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("schema")] public string Schema { get; set; } = "";
    [JsonPropertyName("columns")] public List<ColumnInfo> Columns { get; set; } = new();
}

public class ColumnInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("dataType")] public string DataType { get; set; } = "";
    [JsonPropertyName("isNullable")] public bool IsNullable { get; set; }
    [JsonPropertyName("isPrimaryKey")] public bool IsPrimaryKey { get; set; }
}

public class SchemaResult
{
    [JsonPropertyName("tables")] public List<TableInfo> Tables { get; set; } = new();
    [JsonPropertyName("procedures")] public List<ProcedureInfo> Procedures { get; set; } = new();
    [JsonPropertyName("functions")] public List<FunctionInfo> Functions { get; set; } = new();
    [JsonPropertyName("views")] public List<ViewInfo> Views { get; set; } = new();
    [JsonPropertyName("triggers")] public List<TriggerInfo> Triggers { get; set; } = new();
    [JsonPropertyName("indexes")] public List<IndexInfo> Indexes { get; set; } = new();
    [JsonPropertyName("foreignKeys")] public List<ForeignKeyInfo> ForeignKeys { get; set; } = new();
    [JsonPropertyName("error")] public string? Error { get; set; }
}
public class ProcedureInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("schema")] public string Schema { get; set; } = "";
    [JsonPropertyName("parameterCount")] public int ParameterCount { get; set; }
    [JsonPropertyName("created")] public string Created { get; set; } = "";
}

public class FunctionInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("schema")] public string Schema { get; set; } = "";
    [JsonPropertyName("functionType")] public string FunctionType { get; set; } = ""; // scalar, table
    [JsonPropertyName("parameterCount")] public int ParameterCount { get; set; }
}

public class ViewInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("schema")] public string Schema { get; set; } = "";
}

public class TriggerInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("tableName")] public string TableName { get; set; } = "";
    [JsonPropertyName("event")] public string Event { get; set; } = ""; // INSERT, UPDATE, DELETE
    [JsonPropertyName("timing")] public string Timing { get; set; } = ""; // BEFORE, AFTER
}

public class IndexInfo
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("tableName")] public string TableName { get; set; } = "";
    [JsonPropertyName("columns")] public string Columns { get; set; } = "";
    [JsonPropertyName("isUnique")] public bool IsUnique { get; set; }
    [JsonPropertyName("isPrimary")] public bool IsPrimary { get; set; }
}
public class DefinitionResult
{
    [JsonPropertyName("definition")] public string? Definition { get; set; }
    [JsonPropertyName("error")] public string? Error { get; set; }
}

// Result of enumerating the databases hosted on a server/cluster for a single
// connection. Server-wide for SQL Server (sys.databases), cluster-wide for
// Postgres/CockroachDB (pg_database), and the schemata list for MySQL/MariaDB
// (where a "database" and a "schema" are the same thing). SQLite returns an
// empty list — a SQLite connection is a single file, i.e. a single database.
public class DatabaseListResult
{
    [JsonPropertyName("databases")] public List<string> Databases { get; set; } = new();
    [JsonPropertyName("error")] public string? Error { get; set; }
}

[JsonSerializable(typeof(SchemaResult))]
[JsonSerializable(typeof(List<TableInfo>))]
[JsonSerializable(typeof(List<ProcedureInfo>))]
[JsonSerializable(typeof(List<FunctionInfo>))]
[JsonSerializable(typeof(List<ViewInfo>))]
[JsonSerializable(typeof(List<TriggerInfo>))]
[JsonSerializable(typeof(List<IndexInfo>))]
[JsonSerializable(typeof(DefinitionResult))]
[JsonSerializable(typeof(List<ForeignKeyInfo>))]
[JsonSerializable(typeof(DatabaseListResult))]
internal partial class AppJsonContext : JsonSerializerContext { }

public static class SchemaExplorerLib
{
    [UnmanagedCallersOnly(EntryPoint = "get_schema")]
    public static IntPtr GetSchema(IntPtr connectionStringPtr, IntPtr enginePtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";

            var result = SchemaEngines.Resolve(engine).GetFullSchema(connectionString);

            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(result, AppJsonContext.Default.SchemaResult));
        }
        catch (Exception ex)
        {
            var err = new SchemaResult { Error = ex.Message };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(err, AppJsonContext.Default.SchemaResult));
        }
    }

    // ---- Database enumeration ---------------------------------
    // Lists every database/schema visible to this login on the connected
    // server. Called once when a connection is selected in the sidebar; the
    // result drives the database list, and expanding any one database calls
    // the existing get_schema export with that database name.
    //
    // The connection string passed in targets whatever default database the
    // connection was saved with — that's fine, because every enumeration query
    // here is server/cluster-wide and works from any database the login can
    // reach.
    [UnmanagedCallersOnly(EntryPoint = "list_databases")]
    public static IntPtr ListDatabases(IntPtr connectionStringPtr, IntPtr enginePtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";

            var databases = SchemaEngines.Resolve(engine).ListDatabases(connectionString);

            var result = new DatabaseListResult { Databases = databases };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(result, AppJsonContext.Default.DatabaseListResult));
        }
        catch (Exception ex)
        {
            var err = new DatabaseListResult { Error = ex.Message };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(err, AppJsonContext.Default.DatabaseListResult));
        }
    }

    // ---- MySQL ------------------------------------------------

    // ---- PostgreSQL -------------------------------------------

    // ---- SQLite -----------------------------------------------

    // ---- SQL SERVER -----------------------------------------------

    // ---- MYSQL ----------------------------------------------------

    // ---- POSTGRES -------------------------------------------------

    [UnmanagedCallersOnly(EntryPoint = "get_object_definition")]
    public static IntPtr GetObjectDefinition(
    IntPtr connectionStringPtr,
    IntPtr enginePtr,
    IntPtr objectNamePtr,
    IntPtr objectTypePtr,
    IntPtr schemaNamePtr)
    {
        try
        {
            var connectionString = Marshal.PtrToStringUTF8(connectionStringPtr) ?? "";
            var engine = Marshal.PtrToStringUTF8(enginePtr) ?? "";
            var objectName = Marshal.PtrToStringUTF8(objectNamePtr) ?? "";
            var objectType = Marshal.PtrToStringUTF8(objectTypePtr) ?? "";
            var schemaName = Marshal.PtrToStringUTF8(schemaNamePtr) ?? "dbo";

            var definition = SchemaEngines.Resolve(engine)
                .GetObjectDefinition(connectionString, objectName, objectType, schemaName);

            var result = new DefinitionResult { Definition = definition, Error = null };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(result, AppJsonContext.Default.DefinitionResult));
        }
        catch (Exception ex)
        {
            var result = new DefinitionResult { Definition = null, Error = ex.Message };
            return Marshal.StringToCoTaskMemUTF8(
                JsonSerializer.Serialize(result, AppJsonContext.Default.DefinitionResult));
        }
    }

    // ---- winsqlite3 P/Invoke ----------------------------------

}
public class ForeignKeyInfo
{
    [JsonPropertyName("constraintName")] public string ConstraintName { get; set; } = "";
    [JsonPropertyName("sourceSchema")] public string SourceSchema { get; set; } = "";
    [JsonPropertyName("sourceTable")] public string SourceTable { get; set; } = "";
    [JsonPropertyName("sourceColumn")] public string SourceColumn { get; set; } = "";
    [JsonPropertyName("targetSchema")] public string TargetSchema { get; set; } = "";
    [JsonPropertyName("targetTable")] public string TargetTable { get; set; } = "";
    [JsonPropertyName("targetColumn")] public string TargetColumn { get; set; } = "";
}