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

/// <summary>
/// Schema exploration for MySQL — also serves MariaDB, which is wire-compatible (same MySqlConnector driver).
/// Implementation bodies moved verbatim from the old SchemaExplorerLib god class
/// (audit A-2); dispatch happens through SchemaEngines.Resolve.
/// </summary>
internal sealed class MySqlSchemaEngine : ISchemaEngine
{
    public SchemaResult GetFullSchema(string connectionString) =>
        GetMySqlFullSchema(connectionString);

    public List<string> ListDatabases(string connectionString) =>
        ListMySqlDatabases(connectionString);

    public string GetObjectDefinition(
        string connectionString, string objectName, string objectType, string schemaName) =>
        GetMySqlDefinition(connectionString, objectName, objectType); // MySQL has no schema layer

    private static List<string> ListMySqlDatabases(string connectionString)
    {
        // In MySQL/MariaDB a "database" and a "schema" are the same object, so
        // there is no separate schema layer below the database — the sidebar
        // shows database -> tables directly. Exclude the four engine-internal
        // schemas so only user databases appear.
        var databases = new List<string>();

        using var conn = new MySqlConnection(connectionString);
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name NOT IN
            ('information_schema', 'performance_schema', 'mysql', 'sys')
        ORDER BY schema_name";

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            databases.Add(reader.GetString(0));

        return databases;
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
            ForeignKeys = GetMySqlForeignKeys(connectionString),
        };
    }

    private static List<ForeignKeyInfo> GetMySqlForeignKeys(string connectionString)
    {
        var fks = new List<ForeignKeyInfo>();

        using var conn = new MySqlConnection(connectionString);
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT
            CONSTRAINT_NAME,
            TABLE_SCHEMA,
            TABLE_NAME,
            COLUMN_NAME,
            REFERENCED_TABLE_SCHEMA,
            REFERENCED_TABLE_NAME,
            REFERENCED_COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME, ORDINAL_POSITION";

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            fks.Add(new ForeignKeyInfo
            {
                ConstraintName = reader.GetString(0),
                SourceSchema = reader.GetString(1),
                SourceTable = reader.GetString(2),
                SourceColumn = reader.GetString(3),
                TargetSchema = reader.GetString(4),
                TargetTable = reader.GetString(5),
                TargetColumn = reader.GetString(6)
            });
        }

        return fks;
    }

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

    // ---- MYSQL ----------------------------------------------------
    private static string GetMySqlDefinition(
        string connectionString, string objectName, string objectType)
    {
        using var conn = new MySqlConnector.MySqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();

        // Audit H-1: objectName is an untrusted identifier from the schema tree.
        var q = SqlIdentifier.Quote("mysql", objectName);
        cmd.CommandText = objectType switch
        {
            "procedure" => $"SHOW CREATE PROCEDURE {q}",
            "function" => $"SHOW CREATE FUNCTION {q}",
            "view" => $"SHOW CREATE VIEW {q}",
            "trigger" => $"SHOW CREATE TRIGGER {q}",
            "table" => $"SHOW CREATE TABLE {q}",
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
}
