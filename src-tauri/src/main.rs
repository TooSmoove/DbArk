// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

use sha2::{Sha256, Digest};

fn verify_dll(path: &str, expected_hex: &str) -> bool {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("FATAL: Could not read {}: {}", path, e);
            return false;
        }
    };
    let hash = hex::encode(Sha256::digest(&bytes));
    if hash != expected_hex {
        eprintln!("FATAL: Hash mismatch for {}", path);
        eprintln!("  Expected: {}", expected_hex);
        eprintln!("  Got:      {}", hash);
        return false;
    }
    true
}

// DLL integrity hashes — regenerate after every DLL rebuild
const HASH_CONNECTIONMANAGER: &str = "fb94e251058153f1282fffc32c9dda371efbffd07bea7bc099e303386d47b79f";
const HASH_FILEQUERYENGINE: &str = "f312d982afd8581eaa681132d999ebe4ae000bafebfc12de63cae46456a364aa";
const HASH_QUERYEXECUTOR: &str = "c7b90b63eb1916ea36ddd7b8017e2ab24330550512df95e8c5fe496ec0c28680";
const HASH_QUERYHISTORY: &str = "de46e055d88caf5dbd9f082809035662de69346052b65138cdc7b3a9886c42a0";
const HASH_SCHEMAEXPLORER: &str = "cae8c9eb870ceeadfc956f0f05262f09883b184a701ab69f34e2e553838a5106";
const HASH_SSHTUNNEL: &str = "4927f3bae0f0a3d2845e03932ba215c8784b7829f5872c58d71a7877f70ea4af";
const HASH_DUCKDB: &str = "b0625a29327c7c3dbd74b69a746deb60abaeaea698c48b73ebc3232a91f54150";

static SSH_TUNNEL: OnceLock<libloading::Library> = OnceLock::new();
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

fn get_ssh_tunnel() -> &'static libloading::Library {
    SSH_TUNNEL.get_or_init(|| unsafe {
        libloading::Library::new("natives/SshTunnel.dll")
            .expect("Failed to load SshTunnel.dll")
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
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    ssl_mode: Option<String>,
    sql_instance: Option<String>,
    windows_auth: Option<bool>,
    tunnel_port: Option<u16>, // ← add this
) -> Result<String, String> {
    let ssl      = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    // If tunnel is active, connect via localhost tunnel port
    let effective_host = if tunnel_port.is_some() { "127.0.0.1".to_string() } else { host };
    let effective_port = tunnel_port.unwrap_or(port);

    let password = if !win_auth {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().unwrap_or_default()
    } else {
        String::new()
    };

    let conn_str = match engine.to_lowercase().as_str() {
        "mysql" => {
            let ssl_param = match ssl.as_str() {
                "none"        => "SslMode=None;",
                "require"     => "SslMode=Required;",
                "verify-full" => "SslMode=VerifyFull;",
                _             => "SslMode=Preferred;",
            };
            format!("Server={};Port={};Database={};Uid={};Pwd={};{}",
                effective_host, effective_port, database, username, password, ssl_param)
        },
        "postgres" => {
            let ssl_param = match ssl.as_str() {
                "none"        => "SSL Mode=Disable;",
                "require"     => "SSL Mode=Require;",
                "verify-full" => "SSL Mode=VerifyFull;",
                _             => "SSL Mode=Prefer;",
            };
            format!("Host={};Port={};Database={};Username={};Password={};{}",
                effective_host, effective_port, database, username, password, ssl_param)
        },
        "sqlserver" => {
            let server = if !instance.is_empty() {
                format!("{}\\{}", effective_host, instance)
            } else {
                format!("{},{}", effective_host, effective_port)
            };
            let encrypt = match ssl.as_str() {
                "require"     => "yes",
                "verify-full" => "strict",
                _             => "no",
            };
            if win_auth {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};Trusted_Connection=yes;Encrypt={};TrustServerCertificate=yes;",
                    server, database, encrypt)
            } else {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};UID={};PWD={};Encrypt={};TrustServerCertificate=yes;",
                    server, database, username, password, encrypt)
            }
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

#[tauri::command]
fn test_connection(
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    ssl_mode: Option<String>,
    sql_instance: Option<String>,
    windows_auth: Option<bool>,
) -> Result<String, String> {
    // Build the connection string the same way as build_connection_string
    let _ = ssl_mode; 
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    let password = if !win_auth {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().unwrap_or_default()
    } else {
        String::new()
    };

    let conn_str = match engine.to_lowercase().as_str() {
        "mysql" => format!(
            "Server={};Port={};Database={};Uid={};Pwd={};SslMode=Preferred;ConnectionTimeout=5;",
            host, port, database, username, password),
        "postgres" => format!(
            "Host={};Port={};Database={};Username={};Password={};SSL Mode=Prefer;Timeout=5;",
            host, port, database, username, password),
        "sqlite" => format!("Data Source={}", database),
        "sqlserver" => {
            let server = if !instance.is_empty() {
                format!("{}\\{}", host, instance)
            } else {
                format!("{},{}", host, port)
            };
            if win_auth {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};Trusted_Connection=yes;Encrypt=no;TrustServerCertificate=yes;", server, database)
            } else {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};UID={};PWD={};Encrypt=no;TrustServerCertificate=yes;", server, database, username, password)
            }
        },
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    // Run a minimal test query
    let test_sql = match engine.to_lowercase().as_str() {
        "sqlserver" => "SELECT 1",
        "postgres"  => "SELECT 1",
        "sqlite"    => "SELECT 1",
        _           => "SELECT 1",
    };

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
            *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"execute_query")
            .map_err(|e| e.to_string())?;

        let c_conn   = CString::new(conn_str).unwrap();
        let c_sql    = CString::new(test_sql).unwrap();
        let c_engine = CString::new(engine).unwrap();
        let c_ro     = CString::new("false").unwrap();

        let ptr = func(c_conn.as_ptr(), c_sql.as_ptr(),
                       c_engine.as_ptr(), c_ro.as_ptr());
        if ptr.is_null() { return Err("No response".to_string()); }
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    };

    let parsed: serde_json::Value = serde_json::from_str(&result)
        .unwrap_or(serde_json::Value::Null);

    if let Some(err) = parsed.get("error").and_then(|e| e.as_str()) {
        Err(err.to_string())
    } else {
        Ok("Connected successfully".to_string())
    }
}

#[tauri::command]
fn migrate_credential(
    old_target: String,
    new_target: String,
    username: String,
) -> bool {
    // Read password from old entry
    let old_entry = match keyring::Entry::new(&old_target, &username) {
        Ok(e) => e,
        Err(_) => return false,
    };
    let password = match old_entry.get_password() {
        Ok(p) => p,
        Err(_) => return false, // no old credential — nothing to migrate
    };

    // Write to new entry
    let new_entry = match keyring::Entry::new(&new_target, &username) {
        Ok(e) => e,
        Err(_) => return false,
    };
    if new_entry.set_password(&password).is_err() {
        return false;
    }

    // Delete old entry
    let _ = old_entry.delete_password();
    true
}

#[tauri::command]
fn open_tunnel(
    tunnel_id: String,
    ssh_host: String,
    ssh_port: i32,
    ssh_user: String,
    ssh_key_path: String,
    ssh_password: String,
    db_host: String,
    db_port: i32,
) -> Result<i32, String> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, i32,
            *const c_char, *const c_char, *const c_char,
            *const c_char, i32,
        ) -> *const c_char> = get_ssh_tunnel()
            .get(b"open_tunnel")
            .map_err(|e| e.to_string())?;

        let strings = (
            CString::new(tunnel_id).unwrap(),
            CString::new(ssh_host).unwrap(),
            CString::new(ssh_user).unwrap(),
            CString::new(ssh_key_path).unwrap(),
            CString::new(ssh_password).unwrap(),
            CString::new(db_host).unwrap(),
        );

        let ptr = func(
            strings.0.as_ptr(), strings.1.as_ptr(), ssh_port,
            strings.2.as_ptr(), strings.3.as_ptr(), strings.4.as_ptr(),
            strings.5.as_ptr(), db_port,
        );

        if ptr.is_null() { return Err("null response".to_string()); }
        let json = CStr::from_ptr(ptr).to_string_lossy().into_owned();

        // Parse the local port from the response
        let val: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| e.to_string())?;

        if let Some(err) = val.get("error").and_then(|e| e.as_str()) {
            if !err.is_empty() && err != "null" {
                return Err(err.to_string());
            }
        }

        val.get("localPort")
            .and_then(|p| p.as_i64())
            .map(|p| p as i32)
            .ok_or_else(|| "No local port in response".to_string())
    }
}

#[tauri::command]
fn close_tunnel(tunnel_id: String) {
    unsafe {
        if let Ok(func) = get_ssh_tunnel()
            .get::<unsafe extern "C" fn(*const c_char)>(b"close_tunnel")
        {
            let c_id = CString::new(tunnel_id).unwrap();
            func(c_id.as_ptr());
        }
    }
}

#[tauri::command]
fn is_tunnel_open(tunnel_id: String) -> bool {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            match get_ssh_tunnel().get(b"is_tunnel_open") {
                Ok(f) => f,
                Err(_) => return false,
            };
        let c_id = CString::new(tunnel_id).unwrap();
        func(c_id.as_ptr()) == 1
    }
}

#[tauri::command]
fn get_ssh_password(target: String, username: String) -> Result<String, String> {
    let entry = keyring::Entry::new(&target, &username)
        .map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| e.to_string())
}

#[tauri::command]
fn export_results(
    path: String,
    format: String,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
) -> Result<(), String> {
    match format.as_str() {
        "csv"  => export_csv(&path, &columns, &rows),
        "json" => export_json(&path, &columns, &rows),
        _      => Err(format!("Unsupported format: {}", format)),
    }
}

fn export_csv(
    path: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    use std::io::Write;
    let mut file = std::fs::File::create(path)
        .map_err(|e| e.to_string())?;

    // Write BOM for Excel compatibility
    file.write_all(&[0xEF, 0xBB, 0xBF])
        .map_err(|e| e.to_string())?;

    // Header row
    let header = columns.iter()
        .map(|c| csv_escape(c))
        .collect::<Vec<_>>()
        .join(",");
    writeln!(file, "{}", header).map_err(|e| e.to_string())?;

    // Data rows
    for row in rows {
        let line = row.iter()
            .map(|cell| match cell {
                Some(v) => csv_escape(v),
                None    => String::new(),
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

fn export_json(
    path: &str,
    columns: &[String],
    rows: &[Vec<Option<String>>],
) -> Result<(), String> {
    let records: Vec<serde_json::Map<String, serde_json::Value>> = rows.iter()
        .map(|row| {
            let mut map = serde_json::Map::new();
            for (i, col) in columns.iter().enumerate() {
                let val = row.get(i)
                    .and_then(|v| v.as_deref())
                    .map(|v| serde_json::Value::String(v.to_string()))
                    .unwrap_or(serde_json::Value::Null);
                map.insert(col.clone(), val);
            }
            map
        })
        .collect();

    let json = serde_json::to_string_pretty(&records)
        .map_err(|e| e.to_string())?;

    std::fs::write(path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {

     // Verify all native DLL integrity before loading
    let dlls = [
        ("natives/ConnectionManager.dll", HASH_CONNECTIONMANAGER),
        ("natives/FileQueryEngine.dll",   HASH_FILEQUERYENGINE),
        ("natives/QueryExecutor.dll",     HASH_QUERYEXECUTOR),
        ("natives/QueryHistory.dll",      HASH_QUERYHISTORY),
        ("natives/SchemaExplorer.dll",    HASH_SCHEMAEXPLORER),
        ("natives/duckdb.dll",            HASH_DUCKDB),
        ("natives/SshTunnel.dll", HASH_SSHTUNNEL),
    ];

    for (path, expected) in &dlls {
        if !verify_dll(path, expected) {
            eprintln!("FATAL: DLL integrity check failed for {} — aborting", path);
            std::process::exit(1);
        }
    }

    get_query_executor();
    get_connection_manager();
    get_file_query_engine();
    get_schema_explorer();
    get_query_history();
    get_ssh_tunnel();

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
            clear_history,
            test_connection,
            migrate_credential,
            export_results,
            open_tunnel,
            close_tunnel,
            is_tunnel_open,
            get_ssh_password])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}