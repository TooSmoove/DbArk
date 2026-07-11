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
/// Schema exploration for PostgreSQL — also serves CockroachDB, which speaks the Postgres wire protocol.
/// Implementation bodies moved verbatim from the old SchemaExplorerLib god class
/// (audit A-2); dispatch happens through SchemaEngines.Resolve.
/// </summary>
internal sealed class PostgresSchemaEngine : ISchemaEngine
{
    public SchemaResult GetFullSchema(string connectionString) =>
        GetPostgresFullSchema(connectionString);

    public List<string> ListDatabases(string connectionString) =>
        ListPostgresDatabases(connectionString);

    public string GetObjectDefinition(
        string connectionString, string objectName, string objectType, string schemaName) =>
        GetPostgresDefinition(connectionString, objectName, objectType, schemaName);

    private static List<string> ListPostgresDatabases(string connectionString)
    {
        // pg_database is cluster-wide and readable from any database the login
        // can connect to. datistemplate = false drops template0/template1;
        // datallowconn = true drops databases that reject connections (so the
        // user never sees a database they cannot expand). Works unchanged for
        // CockroachDB, which exposes the same catalog over the Postgres wire.
        var databases = new List<string>();

        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT datname
        FROM pg_database
        WHERE datistemplate = false
          AND datallowconn = true
        ORDER BY datname";

        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            databases.Add(reader.GetString(0));

        return databases;
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
            ForeignKeys = GetPostgresForeignKeys(connectionString),
        };
    }

    private static List<ForeignKeyInfo> GetPostgresForeignKeys(string connectionString)
    {
        var fks = new List<ForeignKeyInfo>();

        using var conn = new NpgsqlConnection(connectionString);
        conn.Open();

        using var cmd = conn.CreateCommand();
        cmd.CommandText = @"
        SELECT
            c.conname AS constraint_name,
            ns_src.nspname AS source_schema,
            t_src.relname AS source_table,
            a_src.attname AS source_column,
            ns_tgt.nspname AS target_schema,
            t_tgt.relname AS target_table,
            a_tgt.attname AS target_column
        FROM pg_constraint c
        JOIN pg_class t_src ON t_src.oid = c.conrelid
        JOIN pg_namespace ns_src ON ns_src.oid = t_src.relnamespace
        JOIN pg_class t_tgt ON t_tgt.oid = c.confrelid
        JOIN pg_namespace ns_tgt ON ns_tgt.oid = t_tgt.relnamespace
        JOIN unnest(c.conkey, c.confkey) WITH ORDINALITY AS cols(src_attnum, tgt_attnum, ord) ON true
        JOIN pg_attribute a_src ON a_src.attrelid = t_src.oid AND a_src.attnum = cols.src_attnum
        JOIN pg_attribute a_tgt ON a_tgt.attrelid = t_tgt.oid AND a_tgt.attnum = cols.tgt_attnum
        WHERE c.contype = 'f'
          AND ns_src.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast', 'crdb_internal')
        ORDER BY c.conname, cols.ord";

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

    // ---- POSTGRES -------------------------------------------------
    private static string GetPostgresDefinition(
    string connectionString, string objectName,
    string objectType, string schemaName)
    {
        using var conn = new Npgsql.NpgsqlConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();

        // Audit H-1: objectName/schemaName arrive from the frontend and are untrusted.
        // The catalog queries below bind them as @parameters (never concatenated into
        // SQL); SqlIdentifier.Quote("postgres", …) quotes them as identifiers in the
        // generated DDL, where a parameter cannot stand in for an identifier.

        if (objectType == "table")
        {
            cmd.CommandText = @"
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
            WHERE tc.table_name = @objectName
                AND tc.table_schema = @schemaName
                AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON pk.column_name = c.column_name
        WHERE c.table_name = @objectName
            AND c.table_schema = @schemaName
        ORDER BY c.ordinal_position";
            cmd.Parameters.AddWithValue("objectName", objectName);
            cmd.Parameters.AddWithValue("schemaName", schemaName);

            using var reader = cmd.ExecuteReader();
            var sb = new System.Text.StringBuilder();
            var colDefs = new List<string>();
            var pkCols = new List<string>();

            sb.AppendLine($"CREATE TABLE {SqlIdentifier.Quote("postgres", schemaName)}.{SqlIdentifier.Quote("postgres", objectName)} (");

            while (reader.Read())
            {
                var colName = reader.GetString(0);
                var dataType = reader.GetString(1);
                var maxLen = reader.IsDBNull(2) ? null : reader.GetInt32(2).ToString();
                var nullable = reader.GetString(3) == "YES";
                var defaultVal = reader.IsDBNull(4) ? null : reader.GetString(4);
                var isPk = reader.GetBoolean(5);

                var typeStr = maxLen != null ? $"{dataType}({maxLen})" : dataType;
                var colDef = $"    {SqlIdentifier.Quote("postgres", colName)} {typeStr}";
                if (!nullable) colDef += " NOT NULL";
                if (defaultVal != null) colDef += $" DEFAULT {defaultVal}";

                colDefs.Add(colDef);
                if (isPk) pkCols.Add(SqlIdentifier.Quote("postgres", colName));
            }

            if (pkCols.Count > 0)
                colDefs.Add($"    PRIMARY KEY ({string.Join(", ", pkCols)})");

            sb.Append(string.Join(",\n", colDefs));
            sb.AppendLine("\n);");
            return sb.ToString();
        }

        if (objectType == "view")
        {
            cmd.CommandText = @"
        SELECT view_definition
        FROM information_schema.views
        WHERE table_name = @objectName
            AND table_schema = @schemaName";
            cmd.Parameters.AddWithValue("objectName", objectName);
            cmd.Parameters.AddWithValue("schemaName", schemaName);

            var def = cmd.ExecuteScalar()?.ToString()
                ?? throw new Exception($"No definition found for view '{objectName}'");

            return $"CREATE OR REPLACE VIEW {SqlIdentifier.Quote("postgres", schemaName)}.{SqlIdentifier.Quote("postgres", objectName)} AS\n{def}";
        }

        if (objectType == "trigger")
        {
            cmd.CommandText = @"
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
                    WHERE t.tgname = @objectName
                        AND NOT t.tgisinternal";
            cmd.Parameters.AddWithValue("objectName", objectName);

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
            cmd2.CommandText = @"
                    SELECT pg_get_functiondef(p.oid)
                    FROM pg_proc p
                    JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE p.proname = @functionName
                        AND n.nspname = @schemaN
                    LIMIT 1";
            cmd2.Parameters.AddWithValue("functionName", functionName);
            cmd2.Parameters.AddWithValue("schemaN", schemaN);

            var funcDef = cmd2.ExecuteScalar()?.ToString() ?? "";

            // Quote into locals first: nested " inside an interpolation hole of a
            // verbatim ($@) string is version-sensitive, so keep the holes simple.
            var qTrig   = SqlIdentifier.Quote("postgres", triggerName);
            var qSchema = SqlIdentifier.Quote("postgres", schemaN);
            var qTable  = SqlIdentifier.Quote("postgres", tableName);
            var qFunc   = SqlIdentifier.Quote("postgres", functionName);
            return $@"{funcDef}

            -- Trigger definition
            CREATE OR REPLACE TRIGGER {qTrig}
            {timing} {evt} ON {qSchema}.{qTable}
            {orientation} EXECUTE FUNCTION {qFunc}();";
        }

        // Procedures and functions — existing code unchanged
        cmd.CommandText = @"
        SELECT pg_get_functiondef(p.oid)
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = @objectName
            AND n.nspname = @schemaName
        LIMIT 1";
        cmd.Parameters.AddWithValue("objectName", objectName);
        cmd.Parameters.AddWithValue("schemaName", schemaName);

        var result = cmd.ExecuteScalar()?.ToString()
            ?? throw new Exception($"No definition found for {objectName}");
        return result;
    }
}
