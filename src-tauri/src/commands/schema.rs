//! Schema browsing: full-schema fetch, database enumeration, object
//! definitions, and guarded DROPs.

use std::ffi::c_char;

use crate::commands::query::call_execute_query;
use crate::conn_string::build_sqlite_conn;
use crate::engine::{self, ConnOptions, ConnectionParams, Engine};
use crate::ipc::IpcError;
use crate::natives::{get_schema_explorer, missing_export, read_and_free, to_cstring};

#[tauri::command]
pub async fn get_schema(params: ConnectionParams) -> Result<String, IpcError> {
    let (engine, connection_string) = engine::resolve(&params, ConnOptions::default())?;

    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(*const c_char, *const c_char) -> *const c_char,
        > = get_schema_explorer()
            .get(b"get_schema")
            .map_err(|e| missing_export("get_schema", e))?;
        let cs = to_cstring(connection_string.as_str())?;
        let eng = to_cstring(engine.name())?;
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_schema_explorer(), ptr))
    }
}

// Enumerate the databases hosted on a server/cluster for one saved connection.
// Mirrors get_schema's connection-string construction exactly (same credential
// fetch, same SSH-tunnel handling, same per-engine string) and then calls the
// schema-explorer DLL's `list_databases` export instead of `get_schema`. The
// frontend calls this once when a connection is selected to populate the
// database list, then calls get_schema(database = <chosen db>) on expand.
#[tauri::command]
pub async fn list_databases(params: ConnectionParams) -> Result<String, IpcError> {
    let engine = Engine::parse(&params.engine)?;

    // SQLite has no databases-on-a-server concept — short-circuit with an empty
    // list so the frontend renders tables directly with no database layer.
    if engine == Engine::Sqlite {
        return Ok("{\"databases\":[]}".to_string());
    }

    let (_, connection_string) = engine::resolve(&params, ConnOptions::default())?;

    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(*const c_char, *const c_char) -> *const c_char,
        > = get_schema_explorer()
            .get(b"list_databases")
            .map_err(|e| missing_export("list_databases", e))?;
        let cs = to_cstring(connection_string.as_str())?;
        let eng = to_cstring(engine.name())?;
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_schema_explorer(), ptr))
    }
}

#[tauri::command]
pub async fn get_object_definition(
    params: ConnectionParams,
    object_name: String,
    object_type: String,
    schema_name: Option<String>,
) -> Result<String, IpcError> {
    let engine = Engine::parse(&params.engine)?;
    let schema = schema_name.unwrap_or_else(|| "dbo".to_string());

    // SQLite — handle entirely in Rust via execute_query
    // avoids P/Invoke conflicts with the SchemaExplorer DLL
    if engine == Engine::Sqlite {
        let sqlite_type = match object_type.to_lowercase().as_str() {
            "table" => "table",
            "view" => "view",
            "trigger" => "trigger",
            "index" => "index",
            _ => {
                return Ok(format!(
                    "{{\"definition\":null,\"error\":\"SQLite does not support {}\"}}",
                    object_type
                ))
            }
        };

        let sql = format!(
            "SELECT sql FROM sqlite_master WHERE name = '{}' AND type = '{}'",
            object_name.replace('\'', "''"),
            sqlite_type
        );

        let conn_str = build_sqlite_conn(&params.database);

        let raw = call_execute_query(conn_str.as_str(), sql.as_str(), "sqlite", true, 100)?;

        // Parse the result — first row, first column is the definition
        let parsed: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);

        if let Some(err) = parsed.get("error").and_then(|e| e.as_str()) {
            if !err.is_empty() {
                return Ok(format!("{{\"definition\":null,\"error\":\"{}\"}}", err));
            }
        }

        let definition = parsed
            .get("results")
            .and_then(|r| r.as_array())
            .and_then(|a| a.first())
            .and_then(|r| r.get("rows"))
            .and_then(|r| r.as_array())
            .and_then(|a| a.first())
            .and_then(|r| r.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if definition.is_empty() {
            let msg = match object_type.as_str() {
                "index" => format!(
                    "-- System-generated index '{}' — no CREATE INDEX statement available.",
                    object_name
                ),
                _ => format!("-- No definition found for '{}'.", object_name),
            };
            return Ok(format!(
                "{{\"definition\":\"{}\",\"error\":null}}",
                msg.replace('"', "\\\"")
            ));
        }

        return Ok(format!(
            "{{\"definition\":{},\"error\":null}}",
            serde_json::to_string(definition).unwrap_or_default()
        ));
    }

    // All other engines — call the SchemaExplorer DLL.
    let (_, conn_str) = engine::resolve(&params, ConnOptions::default())?;

    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
            ) -> *const c_char,
        > = get_schema_explorer()
            .get(b"get_object_definition")
            .map_err(|e| missing_export("get_object_definition", e))?;

        let c_conn = to_cstring(conn_str.as_str())?;
        let c_engine = to_cstring(engine.name())?;
        let c_name = to_cstring(object_name)?;
        let c_type = to_cstring(object_type)?;
        let c_schema = to_cstring(schema)?;

        let ptr = func(
            c_conn.as_ptr(),
            c_engine.as_ptr(),
            c_name.as_ptr(),
            c_type.as_ptr(),
            c_schema.as_ptr(),
        );

        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_schema_explorer(), ptr))
    }
}

#[tauri::command]
pub async fn get_sqlite_objects(database: String) -> Result<String, IpcError> {
    let conn_str = build_sqlite_conn(&database);

    // Single query fetches all programmable objects at once
    let sql = "SELECT type, name, tbl_name \
               FROM sqlite_master \
               WHERE type IN ('view','trigger','index') \
               AND name NOT LIKE 'sqlite_%' \
               ORDER BY type, name";

    // Row cap: sqlite_master listings are small, but leave generous headroom
    // for pathological schemas rather than silently truncating the tree.
    call_execute_query(conn_str.as_str(), sql, "sqlite", true, 100_000)
}

#[tauri::command]
pub async fn drop_object(
    params: ConnectionParams,
    object_name: String,
    object_type: String,
    schema_name: Option<String>,
    table_name: Option<String>,
) -> Result<String, IpcError> {
    let engine = Engine::parse(&params.engine)?;
    let schema = schema_name.unwrap_or_else(|| "dbo".to_string());
    let table = table_name.unwrap_or_default();

    let (_, conn_str) = engine::resolve(&params, ConnOptions::default())?;

    // Build DROP statement per engine and type. Identifiers are quoted per engine
    // and the object type is validated against an allow-list (audit H-1), so a
    // crafted object name or type can't break out into injected SQL.
    let drop_sql = engine.build_drop_statement(&object_type, &object_name, &schema, &table)?;

    call_execute_query(
        conn_str.as_str(),
        drop_sql.as_str(),
        engine.name(),
        false,
        1,
    )
}
