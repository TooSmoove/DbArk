-- er_test_setup.sql — run with: sqlcmd -S <server> -E -i er_test_setup.sql
-- Creates the test DB, 60 tables with FK edges, and verifies. Self-contained.

IF DB_ID('DbArkErTest') IS NULL
    CREATE DATABASE DbArkErTest;
GO

USE DbArkErTest;
GO

-- 60 empty tables
DECLARE @i INT = 1;
WHILE @i <= 60
BEGIN
    DECLARE @sql NVARCHAR(MAX) =
        'CREATE TABLE dbo.er_test_' + RIGHT('00' + CAST(@i AS VARCHAR(3)), 3) +
        ' (id INT PRIMARY KEY, name NVARCHAR(50));';
    EXEC sp_executesql @sql;
    SET @i += 1;
END;
GO

-- FK edges: link each table to the one before it
DECLARE @i INT = 2;
WHILE @i <= 60
BEGIN
    DECLARE @fk NVARCHAR(MAX) =
        'ALTER TABLE dbo.er_test_' + RIGHT('00' + CAST(@i AS VARCHAR(3)), 3) +
        ' ADD parent_id INT NULL CONSTRAINT FK_ert_' + CAST(@i AS VARCHAR(3)) +
        ' FOREIGN KEY (parent_id) REFERENCES dbo.er_test_' +
        RIGHT('00' + CAST(@i-1 AS VARCHAR(3)), 3) + '(id);';
    EXEC sp_executesql @fk;
    SET @i += 1;
END;
GO

-- Verify — should report 60 tables and 59 FKs, in DbArkErTest
USE DbArkErTest;
GO
SELECT DB_NAME() AS db,
       (SELECT COUNT(*) FROM sys.tables WHERE name LIKE 'er_test_%') AS tables,
       (SELECT COUNT(*) FROM sys.foreign_keys WHERE name LIKE 'FK_ert_%') AS fks;
GO