//! Query execution, flat-file queries, and result export.

use std::ffi::c_char;

use zeroize::Zeroizing;

use crate::engine::{self, ConnOptions, ConnectionParams};
use crate::ipc::IpcError;
use crate::natives::{
    get_file_query_engine, get_query_executor, missing_export, read_and_free, to_cstring,
};

/// The single FFI gateway to QueryExecutor's `execute_query` export (audit A-3).
///
/// The export takes FIVE pointer args — conn, sql, engine, read_only, row_limit.
/// Declaring or calling it with any other arity makes the C# side read a garbage
/// stack slot and dereference it, which is an instant AccessViolation fail-fast
/// (the "Test Connection" crash-to-desktop). Exactly that happened when the
/// row_limit arg was added: the main query path was updated, and four hand-copied
/// call sites silently kept the old four-arg shape. Every call MUST go through
/// this helper so the signature lives in one place; never re-declare the symbol
/// at a call site (enforced by `scripts/check-ffi-arity.sh`).
pub(crate) fn call_execute_query(
    conn_str: &str,
    sql: &str,
    engine: &str,
    read_only: bool,
    row_limit: u32,
) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
            ) -> *const c_char,
        > = get_query_executor()
            .get(b"execute_query")
            .map_err(|e| missing_export("execute_query", e))?;
        let c_conn = to_cstring(conn_str)?;
        let c_sql = to_cstring(sql)?;
        let c_engine = to_cstring(engine)?;
        let c_ro = to_cstring(if read_only { "true" } else { "false" })?;
        let c_limit = to_cstring(row_limit.to_string())?;
        let ptr = func(
            c_conn.as_ptr(),
            c_sql.as_ptr(),
            c_engine.as_ptr(),
            c_ro.as_ptr(),
            c_limit.as_ptr(),
        );
        // A null pointer is a native-layer failure (the command could not run at
        // all); per-statement errors travel inside the JSON payload as data.
        if ptr.is_null() {
            return Err(IpcError::native("Query executor returned no response"));
        }
        Ok(read_and_free(get_query_executor(), ptr))
    }
}

#[tauri::command]
pub async fn execute_query(
    connection_string: String,
    sql: String,
    engine: String,
    read_only: Option<bool>,
    row_limit: Option<u32>,
) -> Result<String, IpcError> {
    let connection_string = Zeroizing::new(connection_string);
    // Row cap from the user's resultRowLimit setting; the C# side clamps a
    // zero/garbage value to its own default.
    call_execute_query(
        connection_string.as_str(),
        &sql,
        &engine,
        read_only.unwrap_or(false),
        row_limit.unwrap_or(10_000),
    )
}

#[tauri::command]
pub async fn query_file(file_path: String, sql: String) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(*const c_char, *const c_char) -> *const c_char,
        > = get_file_query_engine()
            .get(b"query_file")
            .map_err(|e| missing_export("query_file", e))?;
        let c_path = to_cstring(file_path)?;
        let c_sql = to_cstring(sql)?;
        let ptr = func(c_path.as_ptr(), c_sql.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("File query engine returned no response"))
        } else {
            Ok(read_and_free(get_file_query_engine(), ptr))
        }
    }
}

#[tauri::command]
pub async fn get_file_schema(file_path: String) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_file_query_engine()
                .get(b"get_file_schema")
                .map_err(|e| missing_export("get_file_schema", e))?;
        let c_path = to_cstring(file_path)?;
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("File query engine returned no response"))
        } else {
            Ok(read_and_free(get_file_query_engine(), ptr))
        }
    }
}

#[tauri::command]
pub async fn list_db_tables(params: ConnectionParams) -> Result<String, IpcError> {
    let (engine, connection_string) = engine::resolve(&params, ConnOptions::default())?;
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(*const c_char, *const c_char) -> *const c_char,
        > = get_file_query_engine()
            .get(b"ListTables")
            .map_err(|e| missing_export("ListTables", e))?;
        let cs = to_cstring(connection_string.as_str())?;
        let eng = to_cstring(engine.name())?;
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_file_query_engine(), ptr))
    }
}

#[tauri::command]
pub async fn query_file_with_db(
    params: ConnectionParams,
    file_path: String,
    sql: String,
    table_names: String,
) -> Result<String, IpcError> {
    let (engine, connection_string) = engine::resolve(&params, ConnOptions::default())?;
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
            ) -> *const c_char,
        > = get_file_query_engine()
            .get(b"QueryFileWithDb")
            .map_err(|e| missing_export("QueryFileWithDb", e))?;
        let strings = (
            to_cstring(file_path)?,
            to_cstring(sql)?,
            to_cstring(connection_string.as_str())?,
            to_cstring(engine.name())?,
            to_cstring(table_names)?,
        );
        let ptr = func(
            strings.0.as_ptr(),
            strings.1.as_ptr(),
            strings.2.as_ptr(),
            strings.3.as_ptr(),
            strings.4.as_ptr(),
        );
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_file_query_engine(), ptr))
    }
}

// ── Result export ────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn export_results(
    path: String,
    format: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<(), IpcError> {
    match format.as_str() {
        "csv" => export_csv(&path, &columns, &rows).map_err(IpcError::io),
        "json" => export_json(&path, &columns, &rows).map_err(IpcError::io),
        _ => Err(IpcError::validation(format!(
            "Unsupported format: {}",
            format
        ))),
    }
}

fn export_csv(path: &str, columns: &[String], rows: &[Vec<Option<String>>]) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::File::create(path).map_err(|e| e.to_string())?;

    // Write BOM for Excel compatibility
    file.write_all(&[0xEF, 0xBB, 0xBF])
        .map_err(|e| e.to_string())?;

    // Header row
    let header = columns
        .iter()
        .map(|c| csv_escape(c))
        .collect::<Vec<_>>()
        .join(",");
    writeln!(file, "{}", header).map_err(|e| e.to_string())?;

    // Data rows
    for row in rows {
        let line = row
            .iter()
            .map(|cell| match cell {
                Some(v) => csv_escape(v),
                None => String::new(),
            })
            .collect::<Vec<_>>()
            .join(",");
        writeln!(file, "{}", line).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn csv_escape(value: &str) -> String {
    // Wrap in quotes if value contains comma, quote, newline, or leading/trailing space
    if value.contains(',')
        || value.contains('"')
        || value.contains('\n')
        || value.contains('\r')
        || value.starts_with(' ')
        || value.ends_with(' ')
    {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn export_json(path: &str, columns: &[String], rows: &[Vec<Option<String>>]) -> Result<(), String> {
    let records: Vec<serde_json::Map<String, serde_json::Value>> = rows
        .iter()
        .map(|row| {
            let mut map = serde_json::Map::new();
            for (i, col) in columns.iter().enumerate() {
                let val = row
                    .get(i)
                    .and_then(|v| v.as_deref())
                    .map(|v| serde_json::Value::String(v.to_string()))
                    .unwrap_or(serde_json::Value::Null);
                map.insert(col.clone(), val);
            }
            map
        })
        .collect();

    let json = serde_json::to_string_pretty(&records).map_err(|e| e.to_string())?;

    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod export_tests {
    use super::csv_escape;

    // csv_escape moved here from main.rs with no prior coverage; these pin the
    // quoting rules Excel round-trips depend on (AGENTS.md: moved pure logic
    // gets a focused regression test in the same change).

    #[test]
    fn plain_values_pass_through() {
        assert_eq!(csv_escape("hello"), "hello");
        assert_eq!(csv_escape("123"), "123");
        assert_eq!(csv_escape(""), "");
    }

    #[test]
    fn delimiters_and_quotes_force_quoting() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_escape("line1\nline2"), "\"line1\nline2\"");
        assert_eq!(csv_escape("cr\rhere"), "\"cr\rhere\"");
    }

    #[test]
    fn significant_whitespace_is_preserved_by_quoting() {
        assert_eq!(csv_escape(" leading"), "\" leading\"");
        assert_eq!(csv_escape("trailing "), "\"trailing \"");
    }
}
