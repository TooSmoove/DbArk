import { describe, it, expect } from "vitest";
import {
  buildDropSql,
  buildDropIfExists,
  generateUpdateSql,
  scriptTable,
  scriptExecute,
} from "./scripting";
import type { ColumnInfo, TableInfo, ProcedureInfo, PendingEdit } from "../types";

// ---- buildDropSql -----------------------------------------
describe("buildDropSql", () => {
  it("quotes SQL Server objects with schema and brackets", () => {
    expect(buildDropSql("sqlserver", "table", "Users", "dbo", "")).toBe("DROP TABLE [dbo].[Users]");
    expect(buildDropSql("sqlserver", "procedure", "sp_Get", "app", "")).toBe("DROP PROCEDURE [app].[sp_Get]");
    expect(buildDropSql("sqlserver", "index", "IX_Name", "dbo", "Users")).toBe("DROP INDEX [IX_Name] ON [dbo].[Users]");
    expect(buildDropSql("sqlserver", "trigger", "trg_Ins", "dbo", "")).toBe("DROP TRIGGER [trg_Ins]");
  });

  it("quotes MySQL objects with backticks and no schema", () => {
    expect(buildDropSql("mysql", "table", "users", "", "")).toBe("DROP TABLE \`users\`");
    expect(buildDropSql("mysql", "index", "ix_name", "", "users")).toBe("DROP INDEX \`ix_name\` ON \`users\`");
  });

  it("qualifies Postgres objects with schema, no quoting", () => {
    expect(buildDropSql("postgres", "table", "users", "public", "")).toBe("DROP TABLE public.users");
    expect(buildDropSql("postgres", "trigger", "trg", "public", "users")).toBe("DROP TRIGGER trg ON public.users");
    expect(buildDropSql("postgres", "index", "ix", "public", "")).toBe("DROP INDEX public.ix");
  });

  it("falls back to bare SQLite drops for the default engine", () => {
    expect(buildDropSql("sqlite", "table", "users", "", "")).toBe("DROP TABLE users");
    expect(buildDropSql("unknown-engine", "view", "v", "", "")).toBe("DROP VIEW v");
  });

  it("uses the generic default branch for unknown object types", () => {
    expect(buildDropSql("sqlserver", "sequence", "seq", "dbo", "")).toBe("DROP sequence [seq]");
    expect(buildDropSql("mysql", "event", "e", "", "")).toBe("DROP event \`e\`");
  });
});

// ---- buildDropIfExists ------------------------------------
describe("buildDropIfExists", () => {
  it("emits IF EXISTS for each engine", () => {
    expect(buildDropIfExists("sqlserver", "table", "Users", "dbo", "")).toBe("DROP TABLE IF EXISTS [dbo].[Users]");
    expect(buildDropIfExists("mysql", "view", "v", "", "")).toBe("DROP VIEW IF EXISTS \`v\`");
    expect(buildDropIfExists("postgres", "function", "f", "public", "")).toBe("DROP FUNCTION IF EXISTS public.f");
    expect(buildDropIfExists("sqlite", "trigger", "t", "", "")).toBe("DROP TRIGGER IF EXISTS t");
  });

  it("includes the parent table for index drops", () => {
    expect(buildDropIfExists("sqlserver", "index", "IX", "dbo", "Users")).toBe("DROP INDEX IF EXISTS [IX] ON [dbo].[Users]");
    expect(buildDropIfExists("mysql", "index", "ix", "", "users")).toBe("DROP INDEX IF EXISTS \`ix\` ON \`users\`");
  });
});

// ---- generateUpdateSql ------------------------------------
describe("generateUpdateSql", () => {
  const edits: PendingEdit[] = [
    { rowIndex: 0, colIndex: 1, colName: "name", oldValue: "old", newValue: "O'Brien" },
    { rowIndex: 0, colIndex: 2, colName: "age", oldValue: "1", newValue: "42" },
  ];
  const pk: ColumnInfo[] = [{ name: "id", dataType: "int", isNullable: false, isPrimaryKey: true }];

  it("escapes strings, leaves numbers unquoted, and renders NULL", () => {
    const sql = generateUpdateSql("users", "public", edits, pk, ["7"], "postgres");
    expect(sql).toContain("UPDATE public.users");
    expect(sql).toContain("name = 'O''Brien'");
    expect(sql).toContain("age = 42");
    expect(sql).toContain("WHERE id = 7");
  });

  it("renders NULL for null primary-key values", () => {
    const sql = generateUpdateSql("users", "public", edits, pk, [null], "postgres");
    expect(sql).toContain("WHERE id = NULL");
  });

  it("bracket-quotes for SQL Server and backtick-quotes for MySQL", () => {
    expect(generateUpdateSql("Users", "dbo", edits, pk, ["7"], "sqlserver")).toContain("UPDATE [dbo].[Users]");
    expect(generateUpdateSql("users", "", edits, pk, ["7"], "mysql")).toContain("UPDATE \`users\`");
  });

  it("joins multiple primary-key columns with AND", () => {
    const compositePk: ColumnInfo[] = [
      { name: "tenant", dataType: "int", isNullable: false, isPrimaryKey: true },
      { name: "id", dataType: "int", isNullable: false, isPrimaryKey: true },
    ];
    const sql = generateUpdateSql("users", "public", edits, compositePk, ["1", "2"], "postgres");
    expect(sql).toContain("WHERE tenant = 1 AND id = 2");
  });
});

// ---- scriptTable ------------------------------------------
describe("scriptTable", () => {
  const table: TableInfo = {
    name: "Users",
    schema: "dbo",
    columns: [
      { name: "id", dataType: "int", isNullable: false, isPrimaryKey: true },
      { name: "email", dataType: "varchar", isNullable: false, isPrimaryKey: false },
    ],
  };

  it("builds a SELECT over all columns", () => {
    expect(scriptTable(table, "select", "sqlserver")).toBe("SELECT [id], [email]\nFROM [dbo].[Users]");
  });

  it("builds an INSERT over non-PK columns", () => {
    const sql = scriptTable(table, "insert", "sqlserver");
    expect(sql).toContain("INSERT INTO [dbo].[Users]");
    expect(sql).toContain("([email])");
    expect(sql).toContain("(<email, varchar>)");
  });

  it("builds an UPDATE with PK columns in the WHERE clause", () => {
    const sql = scriptTable(table, "update", "postgres");
    expect(sql).toContain("UPDATE dbo.Users");
    expect(sql).toContain("email = <email, varchar>");
    expect(sql).toContain("WHERE id = <id, int>");
  });

  it("builds a DELETE keyed on the primary key", () => {
    expect(scriptTable(table, "delete", "mysql")).toBe("DELETE FROM \`Users\`\nWHERE \`id\` = <id, int>");
  });

  it("falls back to a placeholder WHERE when there is no primary key", () => {
    const noPk: TableInfo = { name: "logs", schema: "public", columns: [{ name: "msg", dataType: "text", isNullable: true, isPrimaryKey: false }] };
    expect(scriptTable(noPk, "delete", "postgres")).toContain("WHERE <primary_key> = <value>");
  });
});

// ---- scriptExecute ----------------------------------------
describe("scriptExecute", () => {
  const proc = (parameterCount: number): ProcedureInfo => ({ name: "GetUser", schema: "dbo", parameterCount });

  it("emits named-parameter EXECUTE for SQL Server", () => {
    const sql = scriptExecute(proc(2), "sqlserver");
    expect(sql).toContain("EXECUTE [dbo].[GetUser]");
    expect(sql).toContain("@param1 = <param1>");
    expect(sql).toContain("@param2 = <param2>");
  });

  it("emits parameterless EXECUTE when the proc takes no params", () => {
    expect(scriptExecute(proc(0), "sqlserver")).toBe("EXECUTE [dbo].[GetUser]");
  });

  it("emits CALL syntax for MySQL/MariaDB, Postgres and CockroachDB", () => {
    expect(scriptExecute(proc(1), "mysql")).toBe("CALL \`GetUser\`(<param1>)");
    expect(scriptExecute(proc(1), "mariadb")).toBe("CALL \`GetUser\`(<param1>)");
    expect(scriptExecute(proc(1), "postgres")).toBe("CALL dbo.GetUser(<param1>)");
    expect(scriptExecute(proc(1), "cockroachdb")).toBe("CALL dbo.GetUser(<param1>)");
  });

  it("returns an explanatory comment for engines without stored procedures", () => {
    expect(scriptExecute(proc(0), "sqlite")).toBe("-- sqlite does not support stored procedures");
  });
});
