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
/// Schema exploration for SQL Server, via the raw ODBC bridge in SqlServerOdbc.
/// Implementation bodies moved verbatim from the old SchemaExplorerLib god class
/// (audit A-2); dispatch happens through SchemaEngines.Resolve.
/// </summary>
internal sealed class SqlServerSchemaEngine : ISchemaEngine
{
    public SchemaResult GetFullSchema(string connectionString) =>
        GetSqlServerFullSchema(connectionString);

    public List<string> ListDatabases(string connectionString) =>
        ListSqlServerDatabases(connectionString);

    public string GetObjectDefinition(
        string connectionString, string objectName, string objectType, string schemaName) =>
        GetSqlServerDefinition(connectionString, objectName, objectType, schemaName);

    private static List<string> ListSqlServerDatabases(string connectionString)
    {
        // sys.databases is server-wide. state = 0 means ONLINE (skip RESTORING,
        // OFFLINE, etc. that would error on connect). HAS_DBACCESS filters out
        // databases this login cannot open, so the sidebar only shows databases
        // the user can actually browse. System databases are excluded by default;
        // remove the NOT IN clause if you want master/model/msdb/tempdb shown.
        var rows = SqlServerOdbc.Query(connectionString, @"
        SELECT name
        FROM sys.databases
        WHERE state = 0
          AND name NOT IN ('master', 'tempdb', 'model', 'msdb')
          AND HAS_DBACCESS(name) = 1
        ORDER BY name");

        return rows
            .Select(r => r[0] ?? "")
            .Where(s => s.Length > 0)
            .ToList();
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
            ForeignKeys = GetSqlServerForeignKeys(connectionString),
        };
    }

    private static List<ForeignKeyInfo> GetSqlServerForeignKeys(string connectionString)
    {
        var result = SqlServerOdbc.Query(connectionString, @"
    SELECT
        fk.name,
        sch_src.name,
        src.name,
        col_src.name,
        sch_tgt.name,
        tgt.name,
        col_tgt.name
    FROM sys.foreign_keys fk
    INNER JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
    INNER JOIN sys.tables src ON src.object_id = fk.parent_object_id
    INNER JOIN sys.schemas sch_src ON sch_src.schema_id = src.schema_id
    INNER JOIN sys.columns col_src ON col_src.object_id = src.object_id
                                  AND col_src.column_id = fkc.parent_column_id
    INNER JOIN sys.tables tgt ON tgt.object_id = fk.referenced_object_id
    INNER JOIN sys.schemas sch_tgt ON sch_tgt.schema_id = tgt.schema_id
    INNER JOIN sys.columns col_tgt ON col_tgt.object_id = tgt.object_id
                                  AND col_tgt.column_id = fkc.referenced_column_id
    ORDER BY fk.name, fkc.constraint_column_id");

        return result.Select(r => new ForeignKeyInfo
        {
            ConstraintName = r[0] ?? "",
            SourceSchema = r[1] ?? "",
            SourceTable = r[2] ?? "",
            SourceColumn = r[3] ?? "",
            TargetSchema = r[4] ?? "",
            TargetTable = r[5] ?? "",
            TargetColumn = r[6] ?? ""
        }).ToList();
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

    // ---- SQL SERVER -----------------------------------------------
    private static string GetSqlServerDefinition(
        string connectionString, string objectName,
        string objectType, string schemaName)
    {
        // Audit H-1: objectName/schemaName arrive from the frontend over IPC and are
        // untrusted. The catalog queries below bind them as ODBC '?' parameters via
        // SqlServerParamQuery (never concatenated into SQL); the generated DDL quotes
        // them as identifiers via SqlIdentifier.Quote. `qualified` is the schema-
        // qualified name handed to OBJECT_ID(?) as a single bound argument.
        var qualified = $"{schemaName}.{objectName}";

        if (objectType == "table")
        {
            // Generate CREATE TABLE script from schema info. '?' params bind positionally
            // in the order they appear: OBJECT_ID(qualified), then the PK subquery's
            // name/schema, then the outer name/schema.
            var cols = SqlServerParamQuery(connectionString, @"
            SELECT
                c.COLUMN_NAME,
                c.DATA_TYPE,
                c.CHARACTER_MAXIMUM_LENGTH,
                c.IS_NULLABLE,
                c.COLUMN_DEFAULT,
                CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS IS_PK,
                COLUMNPROPERTY(OBJECT_ID(?),
                    c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY
            FROM INFORMATION_SCHEMA.COLUMNS c
            LEFT JOIN (
                SELECT ku.COLUMN_NAME
                FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
                JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
                    ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME
                WHERE tc.TABLE_NAME = ?
                    AND tc.TABLE_SCHEMA = ?
                    AND tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            ) pk ON pk.COLUMN_NAME = c.COLUMN_NAME
            WHERE c.TABLE_NAME = ?
                AND c.TABLE_SCHEMA = ?
            ORDER BY c.ORDINAL_POSITION",
                qualified, objectName, schemaName, objectName, schemaName);

            var sb = new System.Text.StringBuilder();
            sb.AppendLine($"CREATE TABLE {SqlIdentifier.Quote("sqlserver", schemaName)}.{SqlIdentifier.Quote("sqlserver", objectName)} (");
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

                var colDef = $"    {SqlIdentifier.Quote("sqlserver", colName)} {typeStr.ToUpper()}";
                if (isIdentity) colDef += " IDENTITY(1,1)";
                if (!nullable) colDef += " NOT NULL";
                if (nullable) colDef += " NULL";
                if (defaultVal != null) colDef += $" DEFAULT {defaultVal}";

                colDefs.Add(colDef);
                if (isPk) pkCols.Add(SqlIdentifier.Quote("sqlserver", colName));
            }

            if (pkCols.Count > 0)
                colDefs.Add($"    CONSTRAINT {SqlIdentifier.Quote("sqlserver", "PK_" + objectName)} PRIMARY KEY ({string.Join(", ", pkCols)})");

            sb.Append(string.Join(",\n", colDefs));
            sb.AppendLine("\n);");
            return sb.ToString();
        }

        // For SPs, functions, views, triggers — use OBJECT_DEFINITION.
        // NOTE: OBJECT_DEFINITION returns NULL (not an error) in three different
        // cases — object missing, caller lacks VIEW DEFINITION, or object is
        // encrypted. Disambiguate so the message tells the user what to DO.
        var rows = SqlServerParamQuery(connectionString,
            "SELECT OBJECT_DEFINITION(OBJECT_ID(?))", qualified);

        var def = rows.FirstOrDefault()?[0];
        if (def != null)
            return def;

        // Definition came back NULL — ask the server why so the error is actionable.
        // HAS_PERMS_BY_NAME answers the permission question for the *current* login
        // against *this* object, and a least-privilege user can call it on itself.
        var diag = SqlServerParamQuery(connectionString, @"
            SELECT
                CASE WHEN OBJECT_ID(?) IS NULL THEN 0 ELSE 1 END,
                HAS_PERMS_BY_NAME(?, 'OBJECT', 'VIEW DEFINITION')", qualified, qualified)
            .FirstOrDefault();

        var objIdVisible = diag != null && diag[0] == "1";
        var hasPerm = diag != null && diag[1] == "1";

        // IMPORTANT: OBJECT_ID() returns NULL both when an object is genuinely
        // missing AND when the caller lacks any permission to see it (SQL Server
        // metadata-visibility hides objects from unprivileged logins). So a NULL
        // OBJECT_ID does NOT prove "missing". HAS_PERMS_BY_NAME is reliable
        // regardless of metadata visibility, so check permission FIRST.
        if (!hasPerm)
            throw new Exception(
                $"You don't have permission to view the definition of '{schemaName}.{objectName}'. " +
                "This needs the VIEW DEFINITION permission, which is separate from read/execute access. " +
                $"Ask your DBA to run:  GRANT VIEW DEFINITION ON OBJECT::{schemaName}.{objectName} TO [<your_login>];  " +
                "— or, for every object in the database:  GRANT VIEW DEFINITION TO [<your_login>];");

        // We DO have permission, yet OBJECT_ID is NULL → the object is really gone.
        if (!objIdVisible)
            throw new Exception(
                $"Object '{schemaName}.{objectName}' was not found. It may have been " +
                "renamed or dropped — try refreshing the schema tree.");

        // Exists and permitted, but definition still NULL → encrypted.
        throw new Exception(
            $"The definition of '{schemaName}.{objectName}' is unavailable because the object " +
            "was created WITH ENCRYPTION. Encrypted definitions cannot be retrieved by any client.");
    }

    // Managed-ODBC parameterized query for SQL Server catalog lookups that take
    // untrusted object/schema names (audit H-1). Positional '?' parameters are bound,
    // so the names are never concatenated into SQL. DbArk's SQL Server connection string
    // is an ODBC string, so OdbcConnection is the correct client here (the same managed-
    // ODBC path FileQueryEngine uses); the hand-rolled SqlServerOdbc.Query offers no
    // parameter binding, which is why it stays only on the no-user-input call sites.
    // Returns the same List<string?[]> shape as SqlServerOdbc.Query — every column is
    // read as its string form — so callers are unchanged. Args bind in the order the
    // '?' placeholders appear in `sql`.
    private static List<string?[]> SqlServerParamQuery(
        string connectionString, string sql, params string?[] args)
    {
        using var conn = new System.Data.Odbc.OdbcConnection(connectionString);
        conn.Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        foreach (var a in args)
            cmd.Parameters.Add(new System.Data.Odbc.OdbcParameter
            {
                OdbcType = System.Data.Odbc.OdbcType.NVarChar,
                Value = (object?)a ?? DBNull.Value,
            });

        using var reader = cmd.ExecuteReader();
        var results = new List<string?[]>();
        while (reader.Read())
        {
            var row = new string?[reader.FieldCount];
            for (int i = 0; i < reader.FieldCount; i++)
                row[i] = reader.IsDBNull(i) ? null : reader.GetValue(i)?.ToString();
            results.Add(row);
        }
        return results;
    }
}
