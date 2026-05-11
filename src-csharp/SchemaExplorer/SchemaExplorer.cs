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

[JsonSerializable(typeof(SchemaResult))]
[JsonSerializable(typeof(List<TableInfo>))]
[JsonSerializable(typeof(List<ProcedureInfo>))]
[JsonSerializable(typeof(List<FunctionInfo>))]
[JsonSerializable(typeof(List<ViewInfo>))]
[JsonSerializable(typeof(List<TriggerInfo>))]
[JsonSerializable(typeof(List<IndexInfo>))]
[JsonSerializable(typeof(DefinitionResult))]
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

            var result = engine.ToLower() switch
            {
                "mysql" => GetMySqlFullSchema(connectionString),
                "mariadb" => GetMySqlFullSchema(connectionString),      // MariaDB is wire-compatible with MySQL
                "postgres" => GetPostgresFullSchema(connectionString),
                "cockroachdb" => GetPostgresFullSchema(connectionString),   // CockroachDB speaks the Postgres wire protocol
                "sqlite" => GetSqliteFullSchema(connectionString),
                "sqlserver" => GetSqlServerFullSchema(connectionString),
                _ => throw new Exception($"Unsupported engine: {engine}")
            };

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

    private static SchemaResult GetSqlServerFullSchema(string connectionString)
    {
        return new SchemaResult
        {
            Tables = GetSqlServerSchema(connectionString),
            Procedures = GetSqlServerProcedures(connectionString),
            Functions = GetSqlServerFunctions(connectionString),
            Views = GetSqlServerViews(connectionString),
            Triggers = GetSqlServerTriggers(connectionString),
            Indexes = GetSqlServerIndexes(connectionString),
        };
    }

    private static SchemaResult GetMySqlFullSchema(string connectionString)
    {
        return new SchemaResult
        {
            Tables = GetMySqlSchema(connectionString),
            Procedures = GetMySqlProcedures(connectionString),
            Functions = GetMySqlFunctions(connectionString),
            Views = GetMySqlViews(connectionString),
            Triggers = GetMySqlTriggers(connectionString),
            Indexes = GetMySqlIndexes(connectionString),
        };
    }

    private static SchemaResult GetPostgresFullSchema(string connectionString)
    {
        return new SchemaResult
        {
            Tables = GetPostgresSchema(connectionString),
            Procedures = GetPostgresProcedures(connectionString),
            Functions = GetPostgresFunctions(connectionString),
            Views = GetPostgresViews(connectionString),
            Triggers = GetPostgresTriggers(connectionString),
            Indexes = GetPostgresIndexes(connectionString),
        };
    }

    private static SchemaResult GetSqliteFullSchema(string connectionString)
    {
        return new SchemaResult
        {
            Tables = GetSqliteSchema(connectionString),
            Views = new List<ViewInfo>(),      // ← fetched via Rust
            Triggers = new List<TriggerInfo>(),   // ← fetched via Rust
            Procedures = new List<ProcedureInfo>(),
            Functions = new List<FunctionInfo>(),
            Indexes = new List<IndexInfo>(),     // ← fetched via Rust
        };
    }

    // ---- MySQL ------------------------------------------------

    private static List<TableInfo> GetMySqlSchema(string connectionString)
    {
        var tables = new Dictionary<string, TableInfo>();

        using var conn = new MySqlConnection(connectionString);
        conn.Open();

        // Get tables
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT TABLE_NAME, TABLE_SCHEMA
                FROM information_schema.TABLES
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_TYPE = 'BASE TABLE'
                ORDER BY TABLE_NAME";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var name = reader.GetString(0);
                tables[name] = new TableInfo
                {
                    Name = name,
                    Schema = reader.GetString(1)
                };
            }
        }

        // Get columns
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT
                    c.TABLE_NAME,
                    c.COLUMN_NAME,
                    c.DATA_TYPE,
                    c.IS_NULLABLE,
                    CASE WHEN k.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
                FROM information_schema.COLUMNS c
                LEFT JOIN information_schema.KEY_COLUMN_USAGE k
                    ON  k.TABLE_SCHEMA    = c.TABLE_SCHEMA
                    AND k.TABLE_NAME      = c.TABLE_NAME
                    AND k.COLUMN_NAME     = c.COLUMN_NAME
                    AND k.CONSTRAINT_NAME = 'PRIMARY'
                WHERE c.TABLE_SCHEMA = DATABASE()
                ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var tableName = reader.GetString(0);
                if (!tables.ContainsKey(tableName)) continue;

                tables[tableName].Columns.Add(new ColumnInfo
                {
                    Name = reader.GetString(1),
                    DataType = reader.GetString(2),
                    IsNullable = reader.GetString(3) == "YES",
                    IsPrimaryKey = reader.GetInt32(4) == 1
                });
            }
        }

        return new List<TableInfo>(tables.Values);
    }

    // ---- PostgreSQL -------------------------------------------

    private static List<TableInfo> GetPostgresSchema(string connectionString)
    {
        var tables = new Dictionary<string, TableInfo>();

        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();

        // Get tables — all user schemas, not just 'public'
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
            SELECT table_name, table_schema
            FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'crdb_internal')
              AND table_type = 'BASE TABLE'
            ORDER BY table_schema, table_name";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var schema = reader.GetString(1);
                var name = reader.GetString(0);
                // Key by schema.table to avoid collisions across schemas
                var key = $"{schema}.{name}";
                tables[key] = new TableInfo
                {
                    Name = name,
                    Schema = schema
                };
            }
        }

        // Get columns — same scope
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
            SELECT
                c.table_schema,
                c.table_name,
                c.column_name,
                c.data_type,
                c.is_nullable,
                CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT ku.table_schema, ku.table_name, ku.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage ku
                    ON tc.constraint_name = ku.constraint_name
                    AND tc.table_schema = ku.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk ON pk.table_schema = c.table_schema
                AND pk.table_name = c.table_name
                AND pk.column_name = c.column_name
            WHERE c.table_schema NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'crdb_internal')
            ORDER BY c.table_schema, c.table_name, c.ordinal_position";

            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var schema = reader.GetString(0);
                var tableName = reader.GetString(1);
                var key = $"{schema}.{tableName}";
                if (!tables.ContainsKey(key)) continue;

                tables[key].Columns.Add(new ColumnInfo
                {
                    Name = reader.GetString(2),
                    DataType = reader.GetString(3),
                    IsNullable = reader.GetString(4) == "YES",
                    IsPrimaryKey = reader.GetBoolean(5)
                });
            }
        }

        return new List<TableInfo>(tables.Values);
    }

    // ---- SQLite -----------------------------------------------

    private static List<TableInfo> GetSqliteSchema(string connectionString)
    {
        string path = connectionString;
        if (connectionString.StartsWith("Data Source=",
            StringComparison.OrdinalIgnoreCase))
            path = connectionString["Data Source=".Length..].Trim();

        var tables = new List<TableInfo>();

        IntPtr db = IntPtr.Zero;
        SqliteOpen(path, ref db);

        try
        {
            // Get table names
            var tableNames = new List<string>();
            IntPtr stmt = IntPtr.Zero;
            SqlitePrepareV2(db,
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                -1, ref stmt, IntPtr.Zero);
            try
            {
                while (SqliteStep(stmt) == 100)
                    tableNames.Add(
                        Marshal.PtrToStringUTF8(SqliteColumnText(stmt, 0)) ?? "");
            }
            finally { SqliteFinalize(stmt); }

            // Get columns per table via PRAGMA
            foreach (var tableName in tableNames)
            {
                var table = new TableInfo { Name = tableName, Schema = "main" };

                IntPtr colStmt = IntPtr.Zero;
                SqlitePrepareV2(db, $"PRAGMA table_info(\"{tableName}\")",
                    -1, ref colStmt, IntPtr.Zero);
                try
                {
                    while (SqliteStep(colStmt) == 100)
                    {
                        table.Columns.Add(new ColumnInfo
                        {
                            Name = Marshal.PtrToStringUTF8(SqliteColumnText(colStmt, 1)) ?? "",
                            DataType = Marshal.PtrToStringUTF8(SqliteColumnText(colStmt, 2)) ?? "",
                            IsNullable = SqliteColumnInt(colStmt, 3) == 0,
                            IsPrimaryKey = SqliteColumnInt(colStmt, 5) > 0
                        });
                    }
                }
                finally { SqliteFinalize(colStmt); }

                tables.Add(table);
            }
        }
        finally { SqliteClose(db); }

        return tables;
    }

    private static List<TableInfo> GetSqlServerSchema(string connectionString)
    {
        var tables = new Dictionary<string, TableInfo>();

        // Use ODBC for SQL Server
        var tableResult = SqlServerOdbc.Query(connectionString, @"
        SELECT TABLE_NAME, TABLE_SCHEMA
        FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE'
        ORDER BY TABLE_NAME");

        foreach (var row in tableResult)
        {
            var name = row[0] ?? "";
            if (string.IsNullOrEmpty(name)) continue;
            tables[name] = new TableInfo { Name = name, Schema = row[1] ?? "" };
        }

        var colResult = SqlServerOdbc.Query(connectionString, @"
        SELECT
            c.TABLE_NAME,
            c.COLUMN_NAME,
            c.DATA_TYPE,
            c.IS_NULLABLE,
            CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK
        FROM INFORMATION_SCHEMA.COLUMNS c
        LEFT JOIN (
            SELECT ku.TABLE_NAME, ku.COLUMN_NAME
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
            WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        ) pk ON pk.TABLE_NAME = c.TABLE_NAME
            AND pk.COLUMN_NAME = c.COLUMN_NAME
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION");

        foreach (var row in colResult)
        {
            var tableName = row[0] ?? "";
            if (!tables.ContainsKey(tableName)) continue;
            tables[tableName].Columns.Add(new ColumnInfo
            {
                Name = row[1] ?? "",
                DataType = row[2] ?? "",
                IsNullable = row[3] == "YES",
                IsPrimaryKey = row[4] == "1"
            });
        }

        return new List<TableInfo>(tables.Values);
    }

    // ---- SQL SERVER -----------------------------------------------

    private static List<ProcedureInfo> GetSqlServerProcedures(string connectionString)
    {
        var result = SqlServerOdbc.Query(connectionString, @"
        SELECT
            p.name,
            s.name AS schema_name,
            COUNT(param.parameter_id) AS param_count,
            CONVERT(varchar, p.create_date, 120) AS created
        FROM sys.procedures p
        JOIN sys.schemas s ON s.schema_id = p.schema_id
        LEFT JOIN sys.parameters param ON param.object_id = p.object_id
            AND param.parameter_id > 0
        GROUP BY p.name, s.name, p.create_date
        ORDER BY s.name, p.name");

        return result.Select(r => new ProcedureInfo
        {
            Name = r[0] ?? "",
            Schema = r[1] ?? "",
            ParameterCount = int.TryParse(r[2], out int pc) ? pc : 0,
            Created = r[3] ?? "",
        }).ToList();
    }

    private static List<FunctionInfo> GetSqlServerFunctions(string connectionString)
    {
        var result = SqlServerOdbc.Query(connectionString, @"
        SELECT
            o.name,
            s.name AS schema_name,
            CASE o.type
                WHEN 'FN'  THEN 'scalar'
                WHEN 'TF'  THEN 'table'
                WHEN 'IF'  THEN 'table'
                ELSE 'scalar'
            END AS function_type,
            COUNT(p.parameter_id) AS param_count
        FROM sys.objects o
        JOIN sys.schemas s ON s.schema_id = o.schema_id
        LEFT JOIN sys.parameters p ON p.object_id = o.object_id
            AND p.parameter_id > 0
        WHERE o.type IN ('FN', 'TF', 'IF')
        GROUP BY o.name, s.name, o.type
        ORDER BY s.name, o.name");

        return result.Select(r => new FunctionInfo
        {
            Name = r[0] ?? "",
            Schema = r[1] ?? "",
            FunctionType = r[2] ?? "scalar",
            ParameterCount = int.TryParse(r[3], out int pc) ? pc : 0,
        }).ToList();
    }

    private static List<ViewInfo> GetSqlServerViews(string connectionString)
    {
        var result = SqlServerOdbc.Query(connectionString, @"
        SELECT v.name, s.name AS schema_name
        FROM sys.views v
        JOIN sys.schemas s ON s.schema_id = v.schema_id
        ORDER BY s.name, v.name");

        return result.Select(r => new ViewInfo
        {
            Name = r[0] ?? "",
            Schema = r[1] ?? "",
        }).ToList();
    }

    private static List<TriggerInfo> GetSqlServerTriggers(string connectionString)
    {
        var result = SqlServerOdbc.Query(connectionString, @"
        SELECT
            t.name,
            OBJECT_NAME(t.parent_id) AS table_name,
            CASE
                WHEN te.type_desc = 'INSERT' THEN 'INSERT'
                WHEN te.type_desc = 'UPDATE' THEN 'UPDATE'
                WHEN te.type_desc = 'DELETE' THEN 'DELETE'
                ELSE te.type_desc
            END AS event,
            CASE WHEN t.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing
        FROM sys.triggers t
        JOIN sys.trigger_events te ON te.object_id = t.object_id
        WHERE t.parent_class = 1
        ORDER BY table_name, t.name");

        return result.Select(r => new TriggerInfo
        {
            Name = r[0] ?? "",
            TableName = r[1] ?? "",
            Event = r[2] ?? "",
            Timing = r[3] ?? "",
        }).ToList();
    }

    private static List<IndexInfo> GetSqlServerIndexes(string connectionString)
    {
        var result = SqlServerOdbc.Query(connectionString, @"
        SELECT
            i.name,
            t.name AS table_name,
            STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS columns,
            CAST(i.is_unique AS varchar) AS is_unique,
            CAST(i.is_primary_key AS varchar) AS is_primary
        FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        JOIN sys.index_columns ic ON ic.object_id = i.object_id
            AND ic.index_id = i.index_id
        JOIN sys.columns c ON c.object_id = t.object_id
            AND c.column_id = ic.column_id
        WHERE i.name IS NOT NULL
            AND ic.is_included_column = 0
        GROUP BY i.name, t.name, i.is_unique, i.is_primary_key
        ORDER BY t.name, i.name");

        return result.Select(r => new IndexInfo
        {
            Name = r[0] ?? "",
            TableName = r[1] ?? "",
            Columns = r[2] ?? "",
            IsUnique = r[3] == "1",
            IsPrimary = r[4] == "1",
        }).ToList();
    }

    // ---- MYSQL ----------------------------------------------------

    private static List<ProcedureInfo> GetMySqlProcedures(string connectionString)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT r.ROUTINE_NAME, r.ROUTINE_SCHEMA,
               COUNT(p.ORDINAL_POSITION) AS param_count,
               DATE_FORMAT(r.CREATED, '%Y-%m-%d %H:%i:%s') AS created
        FROM information_schema.ROUTINES r
        LEFT JOIN information_schema.PARAMETERS p
            ON p.SPECIFIC_NAME = r.ROUTINE_NAME
            AND p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA
            AND p.PARAMETER_MODE IS NOT NULL
        WHERE r.ROUTINE_TYPE = 'PROCEDURE'
            AND r.ROUTINE_SCHEMA = DATABASE()
        GROUP BY r.ROUTINE_NAME, r.ROUTINE_SCHEMA, r.CREATED
        ORDER BY r.ROUTINE_NAME";
        using var reader = cmd.ExecuteReader();
        var list = new List<ProcedureInfo>();
        while (reader.Read())
            list.Add(new ProcedureInfo
            {
                Name = reader.GetString(0),
                Schema = reader.GetString(1),
                ParameterCount = reader.GetInt32(2),
                Created = reader.IsDBNull(3) ? "" : reader.GetString(3),
            });
        return list;
    }

    private static List<FunctionInfo> GetMySqlFunctions(string connectionString)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT r.ROUTINE_NAME, r.ROUTINE_SCHEMA,
               COUNT(p.ORDINAL_POSITION) AS param_count
        FROM information_schema.ROUTINES r
        LEFT JOIN information_schema.PARAMETERS p
            ON p.SPECIFIC_NAME = r.ROUTINE_NAME
            AND p.SPECIFIC_SCHEMA = r.ROUTINE_SCHEMA
            AND p.PARAMETER_MODE IS NOT NULL
        WHERE r.ROUTINE_TYPE = 'FUNCTION'
            AND r.ROUTINE_SCHEMA = DATABASE()
        GROUP BY r.ROUTINE_NAME, r.ROUTINE_SCHEMA
        ORDER BY r.ROUTINE_NAME";
        using var reader = cmd.ExecuteReader();
        var list = new List<FunctionInfo>();
        while (reader.Read())
            list.Add(new FunctionInfo
            {
                Name = reader.GetString(0),
                Schema = reader.GetString(1),
                FunctionType = "scalar",
                ParameterCount = reader.GetInt32(2),
            });
        return list;
    }

    private static List<ViewInfo> GetMySqlViews(string connectionString)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT TABLE_NAME, TABLE_SCHEMA
        FROM information_schema.VIEWS
        WHERE TABLE_SCHEMA = DATABASE()
        ORDER BY TABLE_NAME";
        using var reader = cmd.ExecuteReader();
        var list = new List<ViewInfo>();
        while (reader.Read())
            list.Add(new ViewInfo
            {
                Name = reader.GetString(0),
                Schema = reader.GetString(1),
            });
        return list;
    }

    private static List<TriggerInfo> GetMySqlTriggers(string connectionString)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE,
               EVENT_MANIPULATION, ACTION_TIMING
        FROM information_schema.TRIGGERS
        WHERE TRIGGER_SCHEMA = DATABASE()
        ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME";
        using var reader = cmd.ExecuteReader();
        var list = new List<TriggerInfo>();
        while (reader.Read())
            list.Add(new TriggerInfo
            {
                Name = reader.GetString(0),
                TableName = reader.GetString(1),
                Event = reader.GetString(2),
                Timing = reader.GetString(3),
            });
        return list;
    }

    private static List<IndexInfo> GetMySqlIndexes(string connectionString)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT INDEX_NAME, TABLE_NAME,
               GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ', '),
               MAX(CASE WHEN NON_UNIQUE = 0 THEN 1 ELSE 0 END),
               MAX(CASE WHEN INDEX_NAME = 'PRIMARY' THEN 1 ELSE 0 END)
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
        GROUP BY INDEX_NAME, TABLE_NAME
        ORDER BY TABLE_NAME, INDEX_NAME";
        using var reader = cmd.ExecuteReader();
        var list = new List<IndexInfo>();
        while (reader.Read())
            list.Add(new IndexInfo
            {
                Name = reader.GetString(0),
                TableName = reader.GetString(1),
                Columns = reader.IsDBNull(2) ? "" : reader.GetString(2),
                IsUnique = reader.GetInt32(3) == 1,
                IsPrimary = reader.GetInt32(4) == 1,
            });
        return list;
    }

    // ---- POSTGRES -------------------------------------------------

    private static List<ProcedureInfo> GetPostgresProcedures(string connectionString)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT p.proname, n.nspname,
               p.pronargs,
               to_char(now(), 'YYYY-MM-DD HH24:MI:SS') AS created
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind = 'p'
            AND n.nspname NOT IN ('pg_catalog','information_schema','crdb_internal')
        ORDER BY n.nspname, p.proname";
        using var reader = cmd.ExecuteReader();
        var list = new List<ProcedureInfo>();
        while (reader.Read())
            list.Add(new ProcedureInfo
            {
                Name = reader.GetString(0),
                Schema = reader.GetString(1),
                ParameterCount = reader.GetInt32(2),
            });
        return list;
    }

    private static List<FunctionInfo> GetPostgresFunctions(string connectionString)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT p.proname, n.nspname,
               CASE p.prokind
                   WHEN 'f' THEN 'scalar'
                   WHEN 'w' THEN 'window'
                   ELSE 'scalar'
               END AS function_type,
               p.pronargs
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prokind IN ('f', 'w')
            AND n.nspname NOT IN ('pg_catalog','information_schema','crdb_internal')
        ORDER BY n.nspname, p.proname";
        using var reader = cmd.ExecuteReader();
        var list = new List<FunctionInfo>();
        while (reader.Read())
            list.Add(new FunctionInfo
            {
                Name = reader.GetString(0),
                Schema = reader.GetString(1),
                FunctionType = reader.GetString(2),
                ParameterCount = reader.GetInt32(3),
            });
        return list;
    }

    private static List<ViewInfo> GetPostgresViews(string connectionString)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT table_name, table_schema
        FROM information_schema.views
        WHERE table_schema NOT IN ('pg_catalog','information_schema','crdb_internal')
        ORDER BY table_schema, table_name";
        using var reader = cmd.ExecuteReader();
        var list = new List<ViewInfo>();
        while (reader.Read())
            list.Add(new ViewInfo
            {
                Name = reader.GetString(0),
                Schema = reader.GetString(1),
            });
        return list;
    }

    private static List<TriggerInfo> GetPostgresTriggers(string connectionString)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT trigger_name, event_object_table,
               event_manipulation, action_timing
        FROM information_schema.triggers
        WHERE trigger_schema NOT IN ('pg_catalog','information_schema','crdb_internal')
        ORDER BY event_object_table, trigger_name";
        using var reader = cmd.ExecuteReader();
        var list = new List<TriggerInfo>();
        while (reader.Read())
            list.Add(new TriggerInfo
            {
                Name = reader.GetString(0),
                TableName = reader.GetString(1),
                Event = reader.GetString(2),
                Timing = reader.GetString(3),
            });
        return list;
    }

    private static List<IndexInfo> GetPostgresIndexes(string connectionString)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT i.relname, t.relname AS table_name,
               pg_get_indexdef(ix.indexrelid) AS index_def,
               ix.indisunique, ix.indisprimary
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema','crdb_internal')
        ORDER BY t.relname, i.relname";
        using var reader = cmd.ExecuteReader();
        var list = new List<IndexInfo>();
        while (reader.Read())
        {
            // Parse column names from index definition
            var def = reader.GetString(2);
            var colStart = def.IndexOf('(');
            var colEnd = def.LastIndexOf(')');
            var cols = colStart >= 0 && colEnd > colStart
                ? def.Substring(colStart + 1, colEnd - colStart - 1)
                : "";
            list.Add(new IndexInfo
            {
                Name = reader.GetString(0),
                TableName = reader.GetString(1),
                Columns = cols,
                IsUnique = reader.GetBoolean(3),
                IsPrimary = reader.GetBoolean(4),
            });
        }
        return list;
    }

    // ---- SQLITE ---------------------------------------------------

    // Minimal SQLite query helper using existing P/Invoke declarations
    private static List<List<string?>> SqliteQuery(string connectionString, string sql)
    {
        var results = new List<List<string?>>();
        IntPtr db = IntPtr.Zero;

        try
        {
            if (SqliteOpen(connectionString
                    .Replace("Data Source=", "")
                    .Replace("data source=", ""), ref db) != 0)
                return results;

            IntPtr stmt = IntPtr.Zero;
            if (SqlitePrepareV2(db, sql, -1, ref stmt, IntPtr.Zero) != 0)
                return results;

            try
            {
                while (SqliteStep(stmt) == 100) // SQLITE_ROW
                {
                    int cols = SqliteStep(stmt);
                    var row = new List<string?>();
                    for (int i = 0; i < cols; i++)
                    {
                        var ptr = SqliteColumnText(stmt, i);
                        row.Add(ptr == IntPtr.Zero ? null
                            : System.Runtime.InteropServices.Marshal.PtrToStringUTF8(ptr));
                    }
                    results.Add(row);
                }
            }
            finally
            {
                SqliteFinalize(stmt);
            }
        }
        finally
        {
            if (db != IntPtr.Zero) SqliteClose(db);
        }

        return results;
    }
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

            var definition = engine.ToLower() switch
            {
                "sqlserver" => GetSqlServerDefinition(connectionString, objectName, objectType, schemaName),
                "mysql" => GetMySqlDefinition(connectionString, objectName, objectType),
                "mariadb" => GetMySqlDefinition(connectionString, objectName, objectType),      // MariaDB wire-compatible
                "postgres" => GetPostgresDefinition(connectionString, objectName, objectType, schemaName),
                "cockroachdb" => GetPostgresDefinition(connectionString, objectName, objectType, schemaName), // CockroachDB wire-compatible
                // SQLite handled in Rust — never reaches here
                _ => throw new Exception($"Unsupported engine: {engine}")
            };

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

    // ---- SQL SERVER -----------------------------------------------
    private static string GetSqlServerDefinition(
        string connectionString, string objectName,
        string objectType, string schemaName)
    {
        if (objectType == "table")
        {
            // Generate CREATE TABLE script from schema info
            var cols = SqlServerOdbc.Query(connectionString, $@"
            SELECT
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.CHARACTER_MAXIMUM_LENGTH,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK,
                COLUMNPROPERTY(OBJECT_ID('{schemaName}.{objectName}'),
                    c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                WHERE tc.TABLE_NAME = '{objectName}'
                    AND tc.TABLE_SCHEMA = '{schemaName}'
                    AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
            WHERE c.TABLE_NAME = '{objectName}'
                AND c.TABLE_SCHEMA = '{schemaName}'
            ORDER BY c.ORDINAL_POSITION");

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"CREATE TABLE [{schemaName}].[{objectName}] (");
            var colDefs = new List<string>();
            var pkCols = new List<string>();

            foreach (var row in cols)
            {
                var colName = row[0] ?? "";
                var dataType = row[1] ?? "";
                var maxLen = row[2];
                var nullable = row[3] == "YES";
                var defaultVal = row[4];
                var isPk = row[5] == "1";
                var isIdentity = row[6] == "1";

                var typeStr = maxLen != null && maxLen != "-1"
                    ? $"{dataType}({maxLen})"
                    : dataType == "nvarchar" || dataType == "varchar"
                        ? $"{dataType}(MAX)"
                        : dataType;

                var colDef = $"    [{colName}] {typeStr.ToUpper()}";
                if (isIdentity) colDef += " IDENTITY(1,1)";
                if (!nullable) colDef += " NOT NULL";
                if (nullable) colDef += " NULL";
                if (defaultVal != null) colDef += $" DEFAULT {defaultVal}";

                colDefs.Add(colDef);
                if (isPk) pkCols.Add($"[{colName}]");
            }

            if (pkCols.Count > 0)
                colDefs.Add($"    CONSTRAINT [PK_{objectName}] PRIMARY KEY ({string.Join(", ", pkCols)})");

            sb.Append(string.Join(",\n", colDefs));
            sb.AppendLine("\n);");
            return sb.ToString();
        }

        // For SPs, functions, views, triggers — use OBJECT_DEFINITION
        var rows = SqlServerOdbc.Query(connectionString,
            $"SELECT OBJECT_DEFINITION(OBJECT_ID('{schemaName}.{objectName}'))");

        var def = rows.FirstOrDefault()?[0]
            ?? throw new Exception($"No definition found for {objectName}. " +
                "The object may be encrypted or you may not have VIEW DEFINITION permission.");

        return def;
    }

    // ---- MYSQL ----------------------------------------------------
    private static string GetMySqlDefinition(
        string connectionString, string objectName, string objectType)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();

        cmd.CommandText = objectType switch
        {
            "procedure" => $"SHOW CREATE PROCEDURE `{objectName}`",
            "function" => $"SHOW CREATE FUNCTION `{objectName}`",
            "view" => $"SHOW CREATE VIEW `{objectName}`",
            "trigger" => $"SHOW CREATE TRIGGER `{objectName}`",
            "table" => $"SHOW CREATE TABLE `{objectName}`",
            _ => throw new Exception($"Unsupported object type: {objectType}")
        };

        using var reader = cmd.ExecuteReader();
        if (!reader.Read())
            throw new Exception($"No definition found for {objectName}");

        // SHOW CREATE returns definition in different columns per type
        // Column 1 for tables, column 2 for routines/views/triggers
        return objectType == "table"
            ? reader.GetString(1)
            : reader.GetString(2);
    }

    // ---- POSTGRES -------------------------------------------------
    private static string GetPostgresDefinition(
    string connectionString, string objectName,
    string objectType, string schemaName)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();

        if (objectType == "table")
        {
            cmd.CommandText = $@"
        SELECT
            c.column_name,
            c.data_type,
            c.character_maximum_length,
            c.is_nullable,
            c.column_default,
            CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
        FROM information_schema.columns c
        LEFT JOIN (
            SELECT ku.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage ku
                ON tc.constraint_name = ku.constraint_name
            WHERE tc.table_name = '{objectName}'
                AND tc.table_schema = '{schemaName}'
                AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON pk.column_name = c.column_name
        WHERE c.table_name = '{objectName}'
            AND c.table_schema = '{schemaName}'
        ORDER BY c.ordinal_position";

            using var reader = cmd.ExecuteReader();
            var sb = new System.Text.StringBuilder();
            var colDefs = new List<string>();
            var pkCols = new List<string>();

            sb.AppendLine($"CREATE TABLE {schemaName}.{objectName} (");

            while (reader.Read())
            {
                var colName = reader.GetString(0);
                var dataType = reader.GetString(1);
                var maxLen = reader.IsDBNull(2) ? null : reader.GetInt32(2).ToString();
                var nullable = reader.GetString(3) == "YES";
                var defaultVal = reader.IsDBNull(4) ? null : reader.GetString(4);
                var isPk = reader.GetBoolean(5);

                var typeStr = maxLen != null ? $"{dataType}({maxLen})" : dataType;
                var colDef = $"    {colName} {typeStr}";
                if (!nullable) colDef += " NOT NULL";
                if (defaultVal != null) colDef += $" DEFAULT {defaultVal}";

                colDefs.Add(colDef);
                if (isPk) pkCols.Add(colName);
            }

            if (pkCols.Count > 0)
                colDefs.Add($"    PRIMARY KEY ({string.Join(", ", pkCols)})");

            sb.Append(string.Join(",\n", colDefs));
            sb.AppendLine("\n);");
            return sb.ToString();
        }

        if (objectType == "view")
        {
            cmd.CommandText = $@"
        SELECT view_definition
        FROM information_schema.views
        WHERE table_name = '{objectName}'
            AND table_schema = '{schemaName}'";

            var def = cmd.ExecuteScalar()?.ToString()
                ?? throw new Exception($"No definition found for view '{objectName}'");

            return $"CREATE OR REPLACE VIEW {schemaName}.{objectName} AS\n{def}";
        }

        if (objectType == "trigger")
        {
            cmd.CommandText = $@"
                    SELECT
                        t.tgname,
                        c.relname,
                        n.nspname,
                        p.proname,
                        CASE t.tgtype & 2
                            WHEN 2 THEN 'BEFORE'
                            ELSE 'AFTER'
                        END AS timing,
                        CASE
                            WHEN t.tgtype & 4  > 0 THEN 'INSERT'
                            WHEN t.tgtype & 8  > 0 THEN 'DELETE'
                            WHEN t.tgtype & 16 > 0 THEN 'UPDATE'
                            ELSE 'UNKNOWN'
                        END AS event,
                        CASE t.tgtype & 1
                            WHEN 1 THEN 'FOR EACH ROW'
                            ELSE 'FOR EACH STATEMENT'
                        END AS orientation
                    FROM pg_trigger t
                    JOIN pg_class     c ON c.oid = t.tgrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_proc      p ON p.oid = t.tgfoid
                    WHERE t.tgname = '{objectName}'
                        AND NOT t.tgisinternal";

            string triggerName, tableName, schemaN, functionName, timing, evt, orientation;

            using (var reader = cmd.ExecuteReader())
            {
                if (!reader.Read())
                    throw new Exception(
                        $"No definition found for trigger '{objectName}'.");

                triggerName = reader.GetString(0);
                tableName = reader.GetString(1);
                schemaN = reader.GetString(2);
                functionName = reader.GetString(3);
                timing = reader.GetString(4);
                evt = reader.GetString(5);
                orientation = reader.GetString(6);
            } // ← reader fully disposed here before opening second command

            // Use a separate command for the function definition
            using var cmd2 = conn.CreateCommand();
            cmd2.CommandText = $@"
                    SELECT pg_get_functiondef(p.oid)
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE p.proname = '{functionName}'
                        AND n.nspname = '{schemaN}'
                    LIMIT 1";

            var funcDef = cmd2.ExecuteScalar()?.ToString() ?? "";

            return $@"{funcDef}

            -- Trigger definition
            CREATE OR REPLACE TRIGGER {triggerName}
            {timing} {evt} ON {schemaN}.{tableName}
            {orientation} EXECUTE FUNCTION {functionName}();";
        }

        // Procedures and functions — existing code unchanged
        cmd.CommandText = $@"
        SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = '{objectName}'
            AND n.nspname = '{schemaName}'
        LIMIT 1";

        var result = cmd.ExecuteScalar()?.ToString()
            ?? throw new Exception($"No definition found for {objectName}");
        return result;
    }

    // ---- winsqlite3 P/Invoke ----------------------------------

    private const string SqliteDll = "winsqlite3.dll";

    [DllImport(SqliteDll, EntryPoint = "sqlite3_open")]
    private static extern int SqliteOpen(
        [MarshalAs(UnmanagedType.LPUTF8Str)] string filename, ref IntPtr db);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_close")]
    private static extern int SqliteClose(IntPtr db);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_prepare_v2")]
    private static extern int SqlitePrepareV2(
        IntPtr db,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string sql,
        int nByte, ref IntPtr stmt, IntPtr pzTail);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_step")]
    private static extern int SqliteStep(IntPtr stmt);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_finalize")]
    private static extern int SqliteFinalize(IntPtr stmt);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_text")]
    private static extern IntPtr SqliteColumnText(IntPtr stmt, int col);

    [DllImport(SqliteDll, EntryPoint = "sqlite3_column_int")]
    private static extern int SqliteColumnInt(IntPtr stmt, int col);
}
internal static class SqlServerOdbc
{
    private const short SQL_SUCCESS = 0;
    private const short SQL_SUCCESS_WITH_INFO = 1;
    private const short SQL_HANDLE_ENV = 1;
    private const short SQL_HANDLE_DBC = 2;
    private const short SQL_HANDLE_STMT = 3;
    private const int SQL_ATTR_ODBC_VERSION = 200;
    private const int SQL_OV_ODBC3 = 3;
    private const short SQL_NTS = -3;
    private const short SQL_C_WCHAR = -8;
    private const int SQL_NULL_DATA = -1;
    private const string OdbcDll = "odbc32.dll";

    [DllImport(OdbcDll)] static extern short SQLAllocHandle(short t, IntPtr i, out IntPtr o);
    [DllImport(OdbcDll)] static extern short SQLSetEnvAttr(IntPtr h, int a, IntPtr v, int l);
    [DllImport(OdbcDll)] static extern short SQLDriverConnectW(IntPtr c, IntPtr w, [MarshalAs(UnmanagedType.LPWStr)] string s, short sl, IntPtr o, short ol, out short al, short d);
    [DllImport(OdbcDll)] static extern short SQLAllocStmt(IntPtr c, out IntPtr s);
    [DllImport(OdbcDll)] static extern short SQLExecDirectW(IntPtr s, [MarshalAs(UnmanagedType.LPWStr)] string q, int l);
    [DllImport(OdbcDll)] static extern short SQLNumResultCols(IntPtr s, out short n);
    [DllImport(OdbcDll)] static extern short SQLFetch(IntPtr s);
    [DllImport(OdbcDll)] static extern short SQLGetData(IntPtr s, short c, short t, IntPtr v, int b, out int ind);
    [DllImport(OdbcDll)] static extern short SQLFreeHandle(short t, IntPtr h);
    [DllImport(OdbcDll)] static extern short SQLDisconnect(IntPtr h);

    public static List<string?[]> Query(string connectionString, string sql)
    {
        IntPtr hEnv = IntPtr.Zero, hDbc = IntPtr.Zero, hStmt = IntPtr.Zero;
        var results = new List<string?[]>();

        try
        {
            SQLAllocHandle(SQL_HANDLE_ENV, IntPtr.Zero, out hEnv);
            SQLSetEnvAttr(hEnv, SQL_ATTR_ODBC_VERSION, new IntPtr(SQL_OV_ODBC3), 0);
            SQLAllocHandle(SQL_HANDLE_DBC, hEnv, out hDbc);

            short outLen;
            short rc = SQLDriverConnectW(hDbc, IntPtr.Zero, connectionString,
                SQL_NTS, IntPtr.Zero, 0, out outLen, 0);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return results;

            SQLAllocStmt(hDbc, out hStmt);
            rc = SQLExecDirectW(hStmt, sql, SQL_NTS);
            if (rc != SQL_SUCCESS && rc != SQL_SUCCESS_WITH_INFO)
                return results;

            SQLNumResultCols(hStmt, out short colCount);

            IntPtr buf = Marshal.AllocHGlobal(4096);
            try
            {
                while (SQLFetch(hStmt) == SQL_SUCCESS)
                {
                    var row = new string?[colCount];
                    for (short i = 1; i <= colCount; i++)
                    {
                        SQLGetData(hStmt, i, SQL_C_WCHAR, buf, 4096, out int ind);
                        row[i - 1] = ind == SQL_NULL_DATA ? null
                            : Marshal.PtrToStringUni(buf, ind / 2);
                    }
                    results.Add(row);
                }
            }
            finally { Marshal.FreeHGlobal(buf); }
        }
        finally
        {
            if (hStmt != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_STMT, hStmt);
            if (hDbc != IntPtr.Zero) { SQLDisconnect(hDbc); SQLFreeHandle(SQL_HANDLE_DBC, hDbc); }
            if (hEnv != IntPtr.Zero) SQLFreeHandle(SQL_HANDLE_ENV, hEnv);
        }

        return results;
    }
}