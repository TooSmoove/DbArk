// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use libloading::{Symbol};
use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

static QUERY_EXECUTOR:     OnceLock<libloading::Library> = OnceLock::new();
static CONNECTION_MANAGER: OnceLock<libloading::Library> = OnceLock::new();
static FILE_QUERY_ENGINE:  OnceLock<libloading::Library> = OnceLock::new();
static SCHEMA_EXPLORER:    OnceLock<libloading::Library> = OnceLock::new();
static QUERY_HISTORY:      OnceLock<libloading::Library> = OnceLock::new();

fn get_query_executor() -> &'static libloading::Library {
    QUERY_EXECUTOR.get_or_init(|| unsafe {
        libloading::Library::new("natives/QueryExecutor.dll")
            .expect("Failed to load QueryExecutor.dll")
    })
}

fn get_connection_manager() -> &'static libloading::Library {
    CONNECTION_MANAGER.get_or_init(|| unsafe {
        libloading::Library::new("natives/ConnectionManager.dll")
            .expect("Failed to load ConnectionManager.dll")
    })
}

fn get_file_query_engine() -> &'static libloading::Library {
    FILE_QUERY_ENGINE.get_or_init(|| unsafe {
        libloading::Library::new("natives/FileQueryEngine.dll")
            .expect("Failed to load FileQueryEngine.dll")
    })
}

fn get_schema_explorer() -> &'static libloading::Library {
    SCHEMA_EXPLORER.get_or_init(|| unsafe {
        libloading::Library::new("natives/SchemaExplorer.dll")
            .expect("Failed to load SchemaExplorer.dll")
    })
}

fn get_query_history() -> &'static libloading::Library {
    QUERY_HISTORY.get_or_init(|| unsafe {
        libloading::Library::new("natives/QueryHistory.dll")
            .expect("Failed to load QueryHistory.dll")
    })
}

#[tauri::command]
fn execute_query(mut connection_string: String, sql: String, engine: String, read_only: Option<bool>) -> String {
    let read_only_str = if read_only.unwrap_or(false) { "true" } else { "false" };
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor().get(b"execute_query").expect("execute_query");
        let c_conn   = CString::new(connection_string.as_str()).unwrap_or_default();
        let c_sql    = CString::new(sql).unwrap_or_default();
        let c_engine = CString::new(engine).unwrap_or_default();
        let c_ro     = CString::new(read_only_str).unwrap_or_default();
        let ptr = func(c_conn.as_ptr(), c_sql.as_ptr(), c_engine.as_ptr(), c_ro.as_ptr());
        if ptr.is_null() { "{\"error\":\"null response\"}".to_string() }
        else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
fn list_connections(folder_path: String) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_connection_manager().get(b"list_connections").expect("list_connections");
        let c_path = CString::new(folder_path).unwrap_or_default();
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() { "{\"connections\":[]}".to_string() }
        else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

#[tauri::command]
fn save_connection(request_json: String) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_connection_manager().get(b"save_connection").expect("save_connection");
        let c_req = CString::new(request_json).unwrap_or_default();
        let ptr = func(c_req.as_ptr());
        if ptr.is_null() { "ERROR: null response".to_string() }
        else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

#[tauri::command]
fn delete_connection(file_path: String) -> bool {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_connection_manager().get(b"delete_connection").expect("delete_connection");
        let c_path = CString::new(file_path).unwrap_or_default();
        func(c_path.as_ptr()) == 1
    }
}

#[tauri::command]
fn store_credential(target: String, username: String, password: String) -> bool {
    let entry = match keyring::Entry::new(&target, &username) {
        Ok(e) => e, Err(_) => return false,
    };
    entry.set_password(&password).is_ok()
}

#[tauri::command]
fn delete_credential(target: String) -> bool {
    let username = target.split(':').nth(2).unwrap_or("").to_string();
    let entry = match keyring::Entry::new(&target, &username) {
        Ok(e) => e,
        Err(_) => return false,
    };
    entry.delete_password().is_ok()
}

#[tauri::command]
fn build_connection_string(
    credential_ref: String, engine: String, host: String,
    port: u16, database: String, username: String,
    ssl_mode: Option<String>,
) -> Result<String, String> {
    let entry = keyring::Entry::new(&credential_ref, &username)
        .map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();
    let ssl = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let conn_str = match engine.to_lowercase().as_str() {
        "mysql" => {
            let ssl_param = match ssl.as_str() {
                "none"        => "SslMode=None;",
                "require"     => "SslMode=Required;",
                "verify-full" => "SslMode=VerifyFull;",
                _             => "SslMode=Preferred;",
            };
            format!("Server={};Port={};Database={};Uid={};Pwd={};{}",
                host, port, database, username, password, ssl_param)
        },
        "postgres" => {
            let ssl_param = match ssl.as_str() {
                "none"        => "SSL Mode=Disable;",
                "require"     => "SSL Mode=Require;",
                "verify-full" => "SSL Mode=VerifyFull;",
                _             => "SSL Mode=Prefer;",
            };
            format!("Host={};Port={};Database={};Username={};Password={};{}",
                host, port, database, username, password, ssl_param)
        },
        "sqlite" => format!("Data Source={}", database),
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };
    Ok(conn_str)
}

#[tauri::command]
fn query_file(file_path: String, sql: String) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"query_file").expect("query_file");
        let c_path = CString::new(file_path).unwrap_or_default();
        let c_sql  = CString::new(sql).unwrap_or_default();
        let ptr = func(c_path.as_ptr(), c_sql.as_ptr());
        if ptr.is_null() { "{\"error\":\"null\"}".to_string() }
        else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

#[tauri::command]
fn get_file_schema(file_path: String) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_file_query_engine().get(b"get_file_schema").expect("get_file_schema");
        let c_path = CString::new(file_path).unwrap_or_default();
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() { "{\"error\":\"null\"}".to_string() }
        else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

#[tauri::command]
fn list_db_tables(
    credential_ref: String, engine: String, host: String,
    port: u16, database: String, username: String,
) -> Result<String, String> {
    let entry = keyring::Entry::new(&credential_ref, &username)
        .map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();
    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql"    => format!("Server={};Port={};Database={};Uid={};Pwd={};SslMode=Preferred;", host, port, database, username, password),
        "postgres" => format!("Host={};Port={};Database={};Username={};Password={};SSL Mode=Prefer;", host, port, database, username, password),
        "sqlite"   => format!("Data Source={}", database),
        _          => return Err(format!("Unsupported engine: {}", engine)),
    };
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"ListTables").expect("ListTables");
        let cs  = CString::new(connection_string.as_str()).unwrap();
        let eng = CString::new(engine).unwrap();
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
fn query_file_with_db(
    file_path: String, sql: String, credential_ref: String,
    engine: String, host: String, port: u16,
    database: String, username: String, table_names: String,
) -> Result<String, String> {
    let entry = keyring::Entry::new(&credential_ref, &username)
        .map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();
    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql"    => format!("Server={};Port={};Database={};Uid={};Pwd={};SslMode=Preferred;", host, port, database, username, password),
        "postgres" => format!("Host={};Port={};Database={};Username={};Password={};SSL Mode=Prefer;", host, port, database, username, password),
        "sqlite"   => format!("Data Source={}", database),
        _          => return Err(format!("Unsupported engine: {}", engine)),
    };
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, *const c_char,
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"QueryFileWithDb").expect("QueryFileWithDb");
        let strings = (
            CString::new(file_path).unwrap(),
            CString::new(sql).unwrap(),
            CString::new(connection_string.as_str()).unwrap(),
            CString::new(engine).unwrap(),
            CString::new(table_names).unwrap(),
        );
        let ptr = func(
            strings.0.as_ptr(), strings.1.as_ptr(),
            strings.2.as_ptr(), strings.3.as_ptr(),
            strings.4.as_ptr(),
        );
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
fn get_schema(
    credential_ref: String, engine: String, host: String,
    port: u16, database: String, username: String,
) -> Result<String, String> {
    let entry = keyring::Entry::new(&credential_ref, &username)
        .map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();
    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql"    => format!("Server={};Port={};Database={};Uid={};Pwd={};", host, port, database, username, password),
        "postgres" => format!("Host={};Port={};Database={};Username={};Password={};", host, port, database, username, password),
        "sqlite"   => format!("Data Source={}", database),
        _          => return Err(format!("Unsupported engine: {}", engine)),
    };
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_schema_explorer().get(b"get_schema").expect("get_schema");
        let cs  = CString::new(connection_string.as_str()).unwrap();
        let eng = CString::new(engine).unwrap();
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
fn add_history_entry(
    connection_id: String, connection_name: String, sql: String,
    executed_at: i64, duration_ms: i32, row_count: i32, success: bool,
) -> bool {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_query_history().get(b"add_history_entry").expect("add_history_entry");
        let json = format!(
            r#"{{"connectionId":"{}","connectionName":"{}","sql":"{}","executedAt":{},"durationMs":{},"rowCount":{},"success":{}}}"#,
            connection_id.replace('"', "\\\""),
            connection_name.replace('"', "\\\""),
            sql.replace('"', "\\\"").replace('\n', "\\n").replace('\r', ""),
            executed_at, duration_ms, row_count, success
        );
        let c_json = CString::new(json).unwrap();
        func(c_json.as_ptr()) == 1
    }
}

#[tauri::command]
fn get_history(connection_id: String, limit: i32) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char, i32) -> *const c_char> =
            get_query_history().get(b"get_history").expect("get_history");
        let c_id = CString::new(connection_id).unwrap();
        let ptr  = func(c_id.as_ptr(), limit);
        if ptr.is_null() { "{\"entries\":[]}".to_string() }
        else { CStr::from_ptr(ptr).to_string_lossy().into_owned() }
    }
}

#[tauri::command]
fn clear_history(connection_id: String) -> bool {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_query_history().get(b"clear_history").expect("clear_history");
        let c_id = CString::new(connection_id).unwrap();
        func(c_id.as_ptr()) == 1
    }
}

fn main() {

    get_query_executor();
    get_connection_manager();
    get_file_query_engine();
    get_schema_explorer();
    get_query_history();

    tauri::Builder::default()
    .plugin(tauri_plugin_clipboard_manager::init())
    .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![  
            execute_query, 
            list_connections, 
            save_connection,
            delete_connection, 
            store_credential, 
            delete_credential,
            build_connection_string,
            query_file,
            get_file_schema,
            list_db_tables,
            query_file_with_db,
            get_schema,
            add_history_entry,
            get_history,
            clear_history])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}