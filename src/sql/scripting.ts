// Pure SQL / DDL string builders.
//
// Extracted verbatim from App.tsx so the render layer stays presentational and
// these functions can be unit-tested in isolation (no React, no IPC, no state).
// Every function here is a pure function of its arguments.
import type {
  ColumnInfo, TableInfo, ProcedureInfo, PendingEdit,
} from "../types";

/** DROP statement for a schema object, per engine. */
export function buildDropSql(
  engine: string, type: string,
  name: string, schema: string, table: string
): string {
  switch (engine) {
    case "sqlserver":
      switch (type) {
        case "procedure": return `DROP PROCEDURE [${schema}].[${name}]`;
        case "function":  return `DROP FUNCTION [${schema}].[${name}]`;
        case "view":      return `DROP VIEW [${schema}].[${name}]`;
        case "trigger":   return `DROP TRIGGER [${name}]`;
        case "index":     return `DROP INDEX [${name}] ON [${schema}].[${table}]`;
        case "table":     return `DROP TABLE [${schema}].[${name}]`;
        default:          return `DROP ${type} [${name}]`;
      }
    case "mysql":
      switch (type) {
        case "procedure": return `DROP PROCEDURE \`${name}\``;
        case "function":  return `DROP FUNCTION \`${name}\``;
        case "view":      return `DROP VIEW \`${name}\``;
        case "trigger":   return `DROP TRIGGER \`${name}\``;
        case "index":     return `DROP INDEX \`${name}\` ON \`${table}\``;
        case "table":     return `DROP TABLE \`${name}\``;
        default:          return `DROP ${type} \`${name}\``;
      }
    case "postgres":
      switch (type) {
        case "procedure": return `DROP PROCEDURE ${schema}.${name}`;
        case "function":  return `DROP FUNCTION ${schema}.${name}`;
        case "view":      return `DROP VIEW ${schema}.${name}`;
        case "trigger":   return `DROP TRIGGER ${name} ON ${schema}.${table}`;
        case "index":     return `DROP INDEX ${schema}.${name}`;
        case "table":     return `DROP TABLE ${schema}.${name}`;
        default:          return `DROP ${type} ${name}`;
      }
    default: // sqlite
      switch (type) {
        case "view":    return `DROP VIEW ${name}`;
        case "trigger": return `DROP TRIGGER ${name}`;
        case "index":   return `DROP INDEX ${name}`;
        case "table":   return `DROP TABLE ${name}`;
        default:        return `DROP ${type} ${name}`;
      }
  }
}

/** DROP ... IF EXISTS statement for a schema object, per engine. */
export function buildDropIfExists(
  engine: string, type: string,
  name: string, schema: string, table: string
): string {
  switch (engine) {
    case "sqlserver":
      switch (type) {
        case "procedure": return `DROP PROCEDURE IF EXISTS [${schema}].[${name}]`;
        case "function":  return `DROP FUNCTION IF EXISTS [${schema}].[${name}]`;
        case "view":      return `DROP VIEW IF EXISTS [${schema}].[${name}]`;
        case "trigger":   return `DROP TRIGGER IF EXISTS [${name}]`;
        case "table":     return `DROP TABLE IF EXISTS [${schema}].[${name}]`;
        case "index":     return `DROP INDEX IF EXISTS [${name}] ON [${schema}].[${table}]`;
        default:          return `DROP ${type} IF EXISTS [${name}]`;
      }
    case "mysql":
      switch (type) {
        case "procedure": return `DROP PROCEDURE IF EXISTS \`${name}\``;
        case "function":  return `DROP FUNCTION IF EXISTS \`${name}\``;
        case "view":      return `DROP VIEW IF EXISTS \`${name}\``;
        case "trigger":   return `DROP TRIGGER IF EXISTS \`${name}\``;
        case "table":     return `DROP TABLE IF EXISTS \`${name}\``;
        case "index":     return `DROP INDEX IF EXISTS \`${name}\` ON \`${table}\``;
        default:          return `DROP ${type} IF EXISTS \`${name}\``;
      }
    case "postgres":
      switch (type) {
        case "procedure": return `DROP PROCEDURE IF EXISTS ${schema}.${name}`;
        case "function":  return `DROP FUNCTION IF EXISTS ${schema}.${name}`;
        case "view":      return `DROP VIEW IF EXISTS ${schema}.${name}`;
        case "trigger":   return `DROP TRIGGER IF EXISTS ${name} ON ${schema}.${table}`;
        case "table":     return `DROP TABLE IF EXISTS ${schema}.${name}`;
        case "index":     return `DROP INDEX IF EXISTS ${schema}.${name}`;
        default:          return `DROP ${type} IF EXISTS ${name}`;
      }
    default: // SQLite
      switch (type) {
        case "view":    return `DROP VIEW IF EXISTS ${name}`;
        case "trigger": return `DROP TRIGGER IF EXISTS ${name}`;
        case "index":   return `DROP INDEX IF EXISTS ${name}`;
        case "table":   return `DROP TABLE IF EXISTS ${name}`;
        default:        return `DROP ${type} IF EXISTS ${name}`;
      }
  }
}

/** UPDATE statement generated from pending inline-edit cells. */
export function generateUpdateSql(
  tableName:    string,
  schemaName:   string,
  edits:        PendingEdit[],
  pkColumns:    ColumnInfo[],
  pkValues:     (string | null)[],
  engine:       string,
): string {
  const quote = (n: string) =>
    engine === "sqlserver" ? `[${n}]`
    : engine === "mysql"   ? `\`${n}\``
    : n;

  const quoteTable = () =>
    engine === "sqlserver"
      ? `[${schemaName || "dbo"}].[${tableName}]`
      : engine === "mysql"
      ? `\`${tableName}\``
      : `${schemaName || "public"}.${tableName}`;

  const quoteValue = (v: string | null) => {
    if (v === null) return "NULL";
    // Numeric — no quotes
    if (/^-?\d+(\.\d+)?$/.test(v)) return v;
    // Escape single quotes
    return `'${v.replace(/'/g, "''")}'`;
  };

  const setClause = edits
    .map(e => `    ${quote(e.colName)} = ${quoteValue(e.newValue)}`)
    .join(",\n");

  const whereClause = pkColumns
    .map((pk, i) => `${quote(pk.name)} = ${quoteValue(pkValues[i])}`)
    .join(" AND ");

  return `UPDATE ${quoteTable()}\nSET\n${setClause}\nWHERE ${whereClause}`;
}

/** CRUD skeleton scripts (SELECT/INSERT/UPDATE/DELETE) for a table. */
export function scriptTable(
  table: TableInfo,
  scriptType: "select" | "insert" | "update" | "delete",
  engine: string
): string {
  const cols     = table.columns ?? [];
  const pkCols   = cols.filter(c => c.isPrimaryKey);
  const dataCols = cols.filter(c => !c.isPrimaryKey);

  const quoteName = (n: string) =>
    engine === "sqlserver" ? `[${n}]`
    : engine === "mysql"   ? `\`${n}\``
    : n;

  const quoteTable = () =>
    engine === "sqlserver"
      ? `[${table.schema || "dbo"}].[${table.name}]`
      : engine === "mysql"
      ? `\`${table.name}\``
      : `${table.schema || "public"}.${table.name}`;

  const colList = (columns: ColumnInfo[]) =>
    columns.map(c => quoteName(c.name)).join(", ");

  const valueList = (columns: ColumnInfo[]) =>
    columns.map(c => `<${c.name}, ${c.dataType}>`).join(", ");

  const setList = (columns: ColumnInfo[]) =>
    columns.map(c =>
      `    ${quoteName(c.name)} = <${c.name}, ${c.dataType}>`
    ).join(",\n");

  const whereClause = (columns: ColumnInfo[]) =>
    columns.length > 0
      ? columns.map(c =>
          `${quoteName(c.name)} = <${c.name}, ${c.dataType}>`
        ).join(" AND ")
      : `<primary_key> = <value>`;

  const tbl = quoteTable();

  switch (scriptType) {
    case "select":
      return `SELECT ${colList(cols)}\nFROM ${tbl}`;

    case "insert":
      return `INSERT INTO ${tbl}\n    (${colList(dataCols.length > 0 ? dataCols : cols)})\nVALUES\n    (${valueList(dataCols.length > 0 ? dataCols : cols)})`;

    case "update":
      return `UPDATE ${tbl}\nSET\n${setList(dataCols.length > 0 ? dataCols : cols)}\nWHERE ${whereClause(pkCols)}`;

    case "delete":
      return `DELETE FROM ${tbl}\nWHERE ${whereClause(pkCols)}`;

    default:
      return "";
  }
}

/** EXECUTE / CALL skeleton for a stored procedure, per engine. */
export function scriptExecute(proc: ProcedureInfo, engine: string): string {
  const paramList = proc.parameterCount > 0
    ? Array.from({ length: proc.parameterCount },
        (_, i) => `<param${i + 1}>`)
    : [];

  switch (engine) {
    case "sqlserver":
      return `EXECUTE [${proc.schema}].[${proc.name}]${
        paramList.length > 0
          ? "\n    " + paramList.map((p, i) =>
              `@param${i + 1} = ${p}`).join(",\n    ")
          : ""
      }`;
    case "mysql":
    case "mariadb":
      return `CALL \`${proc.name}\`(${paramList.join(", ")})`;
    case "postgres":
      return `CALL ${proc.schema}.${proc.name}(${paramList.join(", ")})`;
    case "cockroachdb":
      // CockroachDB v23.1+ supports CREATE PROCEDURE with CALL syntax.
      // SQL-language procedures (SELECT-only) work on the free tier.
      // DML procedures require LANGUAGE plpgsql (enterprise-only).
      return `CALL ${proc.schema}.${proc.name}(${paramList.join(", ")})`;
    default:
      return `-- ${engine} does not support stored procedures`;
  }
}
