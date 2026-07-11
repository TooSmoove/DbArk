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
/// Schema exploration for SQLite, via the winsqlite3 P/Invoke bridge below.
/// Implementation bodies moved verbatim from the old SchemaExplorerLib god class
/// (audit A-2); dispatch happens through SchemaEngines.Resolve.
/// </summary>
internal sealed class SqliteSchemaEngine : ISchemaEngine
{
    public SchemaResult GetFullSchema(string connectionString) =>
        GetSqliteFullSchema(connectionString);

    // One SQLite file == one database; the sidebar has no database layer to fill.
    public List<string> ListDatabases(string connectionString) => new();

    // SQLite definitions are read straight from sqlite_master by the Rust host
    // (avoids P/Invoke conflicts with this DLL) — this path must never be hit.
    public string GetObjectDefinition(
        string connectionString, string objectName, string objectType, string schemaName) =>
        throw new NotSupportedException(
            "SQLite object definitions are resolved by the host, not the SchemaExplorer DLL.");

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
            ForeignKeys = GetSqliteForeignKeys(connectionString),
        };
    }

    private static List<ForeignKeyInfo> GetSqliteForeignKeys(string connectionString)
    {
        string path = SqliteConnectionString.ExtractPath(connectionString);

        var fks = new List<ForeignKeyInfo>();

        IntPtr db = IntPtr.Zero;
        SqliteOpen(path, ref db);

        try
        {
            // Get all tables first
            var tableNames = new List<string>();
            IntPtr listStmt = IntPtr.Zero;
            SqlitePrepareV2(db,
                "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
                -1, ref listStmt, IntPtr.Zero);
            try
            {
                while (SqliteStep(listStmt) == 100)
                    tableNames.Add(
                        Marshal.PtrToStringUTF8(SqliteColumnText(listStmt, 0)) ?? "");
            }
            finally { SqliteFinalize(listStmt); }

            // PRAGMA foreign_key_list returns columns:
            //   0=id, 1=seq, 2=table (target), 3=from (source col), 4=to (target col),
            //   5=on_update, 6=on_delete, 7=match
            foreach (var tableName in tableNames)
            {
                IntPtr fkStmt = IntPtr.Zero;
                // PRAGMA arguments can't be bound parameters, so quote the identifier
                // (doubling any embedded ") rather than interpolating it raw (audit H-1).
                SqlitePrepareV2(db, $"PRAGMA foreign_key_list({SqlIdentifier.Quote("sqlite", tableName)})",
                    -1, ref fkStmt, IntPtr.Zero);
                try
                {
                    while (SqliteStep(fkStmt) == 100)
                    {
                        var id = SqliteColumnInt(fkStmt, 0);
                        fks.Add(new ForeignKeyInfo
                        {
                            ConstraintName = $"fk_{tableName}_{id}",
                            SourceSchema = "main",
                            SourceTable = tableName,
                            SourceColumn = Marshal.PtrToStringUTF8(SqliteColumnText(fkStmt, 3)) ?? "",
                            TargetSchema = "main",
                            TargetTable = Marshal.PtrToStringUTF8(SqliteColumnText(fkStmt, 2)) ?? "",
                            TargetColumn = Marshal.PtrToStringUTF8(SqliteColumnText(fkStmt, 4)) ?? ""
                        });
                    }
                }
                finally { SqliteFinalize(fkStmt); }
            }
        }
        finally { SqliteClose(db); }

        return fks;
    }

    private static List<TableInfo> GetSqliteSchema(string connectionString)
    {
        string path = SqliteConnectionString.ExtractPath(connectionString);

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
                // PRAGMA arguments can't be bound parameters, so quote the identifier
                // (doubling any embedded ") rather than interpolating it raw (audit H-1).
                SqlitePrepareV2(db, $"PRAGMA table_info({SqlIdentifier.Quote("sqlite", tableName)})",
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
