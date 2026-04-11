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

[JsonSerializable(typeof(SchemaResult))]
[JsonSerializable(typeof(List<TableInfo>))]
[JsonSerializable(typeof(List<ProcedureInfo>))]
[JsonSerializable(typeof(List<FunctionInfo>))]
[JsonSerializable(typeof(List<ViewInfo>))]
[JsonSerializable(typeof(List<TriggerInfo>))]
[JsonSerializable(typeof(List<IndexInfo>))]
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
                "postgres" => GetPostgresFullSchema(connectionString),
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
            Views = GetSqliteViews(connectionString),
            Triggers = GetSqliteTriggers(connectionString),
            // SQLite has no stored procedures or functions
            Procedures = new List<ProcedureInfo>(),
            Functions = new List<FunctionInfo>(),
            Indexes = new List<IndexInfo>(),
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

        // Get tables
        using (var cmd = conn.CreateCommand())
        {
            cmd.CommandText = @"
                SELECT table_name, table_schema
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_type = 'BASE TABLE'
                ORDER BY table_name";

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
                    c.table_name,
                    c.column_name,
                    c.data_type,
                    c.is_nullable,
                    CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
                FROM information_schema.columns c
                LEFT JOIN (
                    SELECT ku.table_name, ku.column_name
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage ku
                        ON tc.constraint_name = ku.constraint_name
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND tc.table_schema = 'public'
                ) pk ON pk.table_name = c.table_name
                    AND pk.column_name = c.column_name
                WHERE c.table_schema = 'public'
                ORDER BY c.table_name, c.ordinal_position";

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
                    IsPrimaryKey = reader.GetBoolean(4)
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
            AND n.nspname NOT IN ('pg_catalog','information_schema')
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
            AND n.nspname NOT IN ('pg_catalog','information_schema')
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
        WHERE table_schema NOT IN ('pg_catalog','information_schema')
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
        WHERE trigger_schema NOT IN ('pg_catalog','information_schema')
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
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
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

    private static List<ViewInfo> GetSqliteViews(string connectionString)
    {
        var list = new List<ViewInfo>();
        try
        {
            var rows = SqliteQuery(connectionString,
                "SELECT name FROM sqlite_master WHERE type='view' ORDER BY name");
            foreach (var row in rows)
                if (row.Count > 0 && row[0] != null)
                    list.Add(new ViewInfo { Name = row[0]!, Schema = "" });
        }
        catch { }
        return list;
    }

    private static List<TriggerInfo> GetSqliteTriggers(string connectionString)
    {
        var list = new List<TriggerInfo>();
        try
        {
            var rows = SqliteQuery(connectionString,
                "SELECT name, tbl_name FROM sqlite_master WHERE type='trigger' ORDER BY name");
            foreach (var row in rows)
                list.Add(new TriggerInfo
                {
                    Name = row.Count > 0 ? row[0] ?? "" : "",
                    TableName = row.Count > 1 ? row[1] ?? "" : "",
                    Event = "",
                    Timing = "",
                });
        }
        catch { }
        return list;
    }

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