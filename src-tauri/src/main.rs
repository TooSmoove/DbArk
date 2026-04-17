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
const HASH_CONNECTIONMANAGER: &str = "848bc0066bab16cc5b0789e5464c4f97955b53185853bd5e889e2a08baba77ee";
const HASH_FILEQUERYENGINE: &str = "f312d982afd8581eaa681132d999ebe4ae000bafebfc12de63cae46456a364aa";
const HASH_QUERYEXECUTOR: &str = "2b8a7514cee7c688fd1f92ed2dd5d56be00f2ca189dafd3ebf07de7119a20327";
const HASH_QUERYHISTORY: &str = "de46e055d88caf5dbd9f082809035662de69346052b65138cdc7b3a9886c42a0";
const HASH_SCHEMAEXPLORER: &str = "69537b99b44620e4d607e177fc3a28718f6471fb454502a9cab6557d93a6b19e";
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
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    _ssl_mode: Option<String>,
    sql_instance: Option<String>,
    windows_auth: Option<bool>,
) -> Result<String, String> {
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    let password = if !win_auth {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().unwrap_or_default()
    } else {
        String::new()
    };

    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql"    => format!("Server={};Port={};Database={};Uid={};Pwd={};",
            host, port, database, username, password),
        "postgres" => format!("Host={};Port={};Database={};Username={};Password={};",
            host, port, database, username, password),
        "sqlite"   => format!("Data Source={}", database),
        "sqlserver" => {
            let server = if !instance.is_empty() {
                format!("{}\\{}", host, instance)
            } else {
                format!("{},{}", host, port)
            };
            if win_auth {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};Trusted_Connection=yes;Encrypt=no;TrustServerCertificate=yes;",
                    server, database)
            } else {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};UID={};PWD={};Encrypt=no;TrustServerCertificate=yes;",
                    server, database, username, password)
            }
        },
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_schema_explorer()
            .get(b"get_schema")
            .expect("get_schema");
        let cs  = CString::new(connection_string.as_str()).unwrap();
        let eng = CString::new(engine).unwrap();
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    };

    // Zero out connection string
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

#[tauri::command]
fn append_audit_log(
    connection_name: String,
    engine: String,
    sql: String,
    row_count: i32,
    duration_ms: i32,
    success: bool,
) -> bool {
    use std::io::Write;

    let home: std::path::PathBuf = match dirs::home_dir() {
        Some(h) => h,
        None    => return false,
    };

    let log_path = home.join(".devsql").join("audit.log");

    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%SZ")
        .to_string();

    let status = if success { "SUCCESS" } else { "ERROR" };
    let scrubbed = scrub_sql_for_log(&sql);

    let entry = format!(
        "[{}] {} | {} | {} | {}ms | {} rows | {}\n",
        timestamp, status, connection_name, engine,
        duration_ms, row_count, scrubbed
    );

    let mut file = match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        Ok(f)  => f,
        Err(_) => return false,
    };

    file.write_all(entry.as_bytes()).is_ok()
}

#[tauri::command]
fn get_object_definition(
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    ssl_mode: Option<String>,
    sql_instance: Option<String>,
    windows_auth: Option<bool>,
    object_name: String,
    object_type: String,
    schema_name: Option<String>,
) -> Result<String, String> {
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);
    let schema   = schema_name.unwrap_or_else(|| "dbo".to_string());
    let _ssl     = ssl_mode.unwrap_or_else(|| "prefer".to_string());

    // SQLite — handle entirely in Rust via execute_query
    // avoids P/Invoke conflicts with the SchemaExplorer DLL
    if engine.to_lowercase() == "sqlite" {
        let sqlite_type = match object_type.to_lowercase().as_str() {
            "table"   => "table",
            "view"    => "view",
            "trigger" => "trigger",
            "index"   => "index",
            _ => return Ok(format!(
                "{{\"definition\":null,\"error\":\"SQLite does not support {}\"}}",
                object_type)),
        };

        let sql = format!(
            "SELECT sql FROM sqlite_master WHERE name = '{}' AND type = '{}'",
            object_name.replace('\'', "''"),
            sqlite_type
        );

        let conn_str = format!("Data Source={}", database);

        let raw = unsafe {
            let func: libloading::Symbol<unsafe extern "C" fn(
                *const c_char, *const c_char,
                *const c_char, *const c_char,
            ) -> *const c_char> = get_query_executor()
                .get(b"execute_query")
                .map_err(|e| e.to_string())?;

            let c_conn   = CString::new(conn_str.as_str()).unwrap();
            let c_sql    = CString::new(sql.as_str()).unwrap();
            let c_engine = CString::new("sqlite").unwrap();
            let c_ro     = CString::new("true").unwrap();

            let ptr = func(c_conn.as_ptr(), c_sql.as_ptr(),
                           c_engine.as_ptr(), c_ro.as_ptr());
            if ptr.is_null() { return Err("null response".to_string()); }
            CStr::from_ptr(ptr).to_string_lossy().into_owned()
        };

        // Parse the result — first row, first column is the definition
        let parsed: serde_json::Value = serde_json::from_str(&raw)
            .unwrap_or(serde_json::Value::Null);

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
                "index" => format!("-- System-generated index '{}' — no CREATE INDEX statement available.", object_name),
                _ => format!("-- No definition found for '{}'.", object_name),
            };
            return Ok(format!("{{\"definition\":\"{}\",\"error\":null}}",
                msg.replace('"', "\\\"")));
        }

        return Ok(format!("{{\"definition\":{},\"error\":null}}",
            serde_json::to_string(definition).unwrap_or_default()));
    }

    // All other engines — call SchemaExplorer DLL as before
    let password = if !win_auth {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().unwrap_or_default()
    } else {
        String::new()
    };

    let mut conn_str = match engine.to_lowercase().as_str() {
        "mysql"    => format!(
            "Server={};Port={};Database={};Uid={};Pwd={};",
            host, port, database, username, password),
        "postgres" => format!(
            "Host={};Port={};Database={};Username={};Password={};",
            host, port, database, username, password),
        "sqlserver" => {
            let server = if !instance.is_empty() {
                format!("{}\\{}", host, instance)
            } else {
                format!("{},{}", host, port)
            };
            if win_auth {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};Trusted_Connection=yes;Encrypt=no;TrustServerCertificate=yes;",
                    server, database)
            } else {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};UID={};PWD={};Encrypt=no;TrustServerCertificate=yes;",
                    server, database, username, password)
            }
        },
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
            *const c_char, *const c_char,
            *const c_char,
        ) -> *const c_char> = get_schema_explorer()
            .get(b"get_object_definition")
            .map_err(|e| e.to_string())?;

        let c_conn   = CString::new(conn_str.as_str()).unwrap();
        let c_engine = CString::new(engine).unwrap();
        let c_name   = CString::new(object_name).unwrap();
        let c_type   = CString::new(object_type).unwrap();
        let c_schema = CString::new(schema).unwrap();

        let ptr = func(
            c_conn.as_ptr(), c_engine.as_ptr(),
            c_name.as_ptr(), c_type.as_ptr(),
            c_schema.as_ptr(),
        );

        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    };

    unsafe {
        let bytes = conn_str.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }

    result
}

fn scrub_sql_for_log(sql: &str) -> String {
    // Simple manual scrub without regex crate
    let mut result = sql.to_string();
    for keyword in &["password", "pwd", "secret", "token", "key"] {
        let lower = result.to_lowercase();
        let mut search_from = 0;
        while let Some(idx) = lower[search_from..].find(keyword) {
            let abs_idx = search_from + idx;
            let after_keyword = &lower[abs_idx + keyword.len()..];
            // Look for = 'value' pattern
            let trimmed = after_keyword.trim_start();
            if trimmed.starts_with('=') {
                let after_eq = trimmed[1..].trim_start();
                if after_eq.starts_with('\'') {
                    if let Some(end_quote) = after_eq[1..].find('\'') {
                        let full_match_len = keyword.len()
                            + (after_keyword.len() - trimmed.len())
                            + 1
                            + (trimmed.len() - after_eq.len())
                            + 1 + end_quote + 1;
                        let replacement = format!("{}='***'", keyword);
                        result.replace_range(abs_idx..abs_idx + full_match_len, &replacement);
                        search_from = abs_idx + replacement.len();
                        continue;
                    }
                }
            }
            search_from = abs_idx + keyword.len();
        }
    }
    // Truncate long SQL for readability
    if result.len() > 200 {
        format!("{}…", &result[..200])
    } else {
        result
    }
}

#[tauri::command]
fn get_sqlite_objects(database: String) -> Result<String, String> {
    let conn_str = format!("Data Source={}", database);

    // Single query fetches all programmable objects at once
    let sql = "SELECT type, name, tbl_name \
               FROM sqlite_master \
               WHERE type IN ('view','trigger','index') \
               AND name NOT LIKE 'sqlite_%' \
               ORDER BY type, name";

    let raw = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
            *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"execute_query")
            .map_err(|e| e.to_string())?;

        let c_conn   = CString::new(conn_str.as_str()).unwrap();
        let c_sql    = CString::new(sql).unwrap();
        let c_engine = CString::new("sqlite").unwrap();
        let c_ro     = CString::new("true").unwrap();

        let ptr = func(c_conn.as_ptr(), c_sql.as_ptr(),
                       c_engine.as_ptr(), c_ro.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    };

    Ok(raw)
}

#[tauri::command]
fn drop_object(
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    ssl_mode: Option<String>,
    sql_instance: Option<String>,
    windows_auth: Option<bool>,
    object_name: String,
    object_type: String,
    schema_name: Option<String>,
    table_name: Option<String>, // for triggers and indexes
) -> Result<String, String> {
    let instance   = sql_instance.unwrap_or_default();
    let win_auth   = windows_auth.unwrap_or(false);
    let schema     = schema_name.unwrap_or_else(|| "dbo".to_string());
    let table      = table_name.unwrap_or_default();
    let _ssl       = ssl_mode.unwrap_or_else(|| "prefer".to_string());

    let password = if !win_auth {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().unwrap_or_default()
    } else {
        String::new()
    };

    let mut conn_str = match engine.to_lowercase().as_str() {
        "mysql"    => format!(
            "Server={};Port={};Database={};Uid={};Pwd={};",
            host, port, database, username, password),
        "postgres" => format!(
            "Host={};Port={};Database={};Username={};Password={};",
            host, port, database, username, password),
        "sqlite"   => format!("Data Source={}", database),
        "sqlserver" => {
            let server = if !instance.is_empty() {
                format!("{}\\{}", host, instance)
            } else {
                format!("{},{}", host, port)
            };
            if win_auth {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};Trusted_Connection=yes;Encrypt=no;TrustServerCertificate=yes;",
                    server, database)
            } else {
                format!("Driver={{ODBC Driver 17 for SQL Server}};Server={};Database={};UID={};PWD={};Encrypt=no;TrustServerCertificate=yes;",
                    server, database, username, password)
            }
        },
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    // Build DROP statement per engine and type
    let drop_sql = build_drop_statement(
        &engine, &object_type, &object_name, &schema, &table);

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
            *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"execute_query")
            .map_err(|e| e.to_string())?;

        let c_conn   = CString::new(conn_str.as_str()).unwrap();
        let c_sql    = CString::new(drop_sql.as_str()).unwrap();
        let c_engine = CString::new(engine.as_str()).unwrap();
        let c_ro     = CString::new("false").unwrap();

        let ptr = func(c_conn.as_ptr(), c_sql.as_ptr(),
                       c_engine.as_ptr(), c_ro.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    };

    unsafe {
        let bytes = conn_str.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }

    result
}

fn build_drop_statement(
    engine: &str, object_type: &str,
    name: &str, schema: &str, table: &str,
) -> String {
    match engine.to_lowercase().as_str() {
        "sqlserver" => match object_type {
            "procedure" => format!("DROP PROCEDURE [{schema}].[{name}]"),
            "function"  => format!("DROP FUNCTION [{schema}].[{name}]"),
            "view"      => format!("DROP VIEW [{schema}].[{name}]"),
            "trigger"   => format!("DROP TRIGGER [{name}]"),
            "index"     => format!("DROP INDEX [{name}] ON [{schema}].[{table}]"),
            "table"     => format!("DROP TABLE [{schema}].[{name}]"),
            _           => format!("DROP {object_type} [{name}]"),
        },
        "mysql" => match object_type {
            "procedure" => format!("DROP PROCEDURE `{name}`"),
            "function"  => format!("DROP FUNCTION `{name}`"),
            "view"      => format!("DROP VIEW `{name}`"),
            "trigger"   => format!("DROP TRIGGER `{name}`"),
            "index"     => format!("DROP INDEX `{name}` ON `{table}`"),
            "table"     => format!("DROP TABLE `{name}`"),
            _           => format!("DROP {object_type} `{name}`"),
        },
        "postgres" => match object_type {
            "procedure" => format!("DROP PROCEDURE {schema}.{name}"),
            "function"  => format!("DROP FUNCTION {schema}.{name}"),
            "view"      => format!("DROP VIEW {schema}.{name}"),
            "trigger"   => format!("DROP TRIGGER {name} ON {schema}.{table}"),
            "index"     => format!("DROP INDEX {schema}.{name}"),
            "table"     => format!("DROP TABLE {schema}.{name}"),
            _           => format!("DROP {object_type} {name}"),
        },
        _ => match object_type { // SQLite
            "view"    => format!("DROP VIEW {name}"),
            "trigger" => format!("DROP TRIGGER {name}"),
            "index"   => format!("DROP INDEX {name}"),
            "table"   => format!("DROP TABLE {name}"),
            _         => format!("DROP {object_type} {name}"),
        },
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct AppSettings {
    query_timeout_secs:       u32,
    lock_timeout_mins:        u32, // 0 = disabled
    result_row_limit:         u32,
    history_retention_days:   u32, // 0 = forever
    result_clear_mins:        u32, // 0 = never
    audit_log_enabled:        bool,
    clipboard_clear_enabled:  bool,
    clipboard_clear_secs:     u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            query_timeout_secs:      30,
            lock_timeout_mins:       15,
            result_row_limit:        10_000,
            history_retention_days:  90,
            result_clear_mins:       5,
            audit_log_enabled:       false,
            clipboard_clear_enabled: true,
            clipboard_clear_secs:    60,
        }
    }
}

fn settings_path() -> std::path::PathBuf {
    dirs::home_dir()
        .unwrap_or_default()
        .join(".devsql")
        .join("settings.toml")
}

#[tauri::command]
fn load_settings() -> Result<String, String> {
    let path = settings_path();
    if !path.exists() {
        let defaults = AppSettings::default();
        return Ok(serde_json::to_string(&defaults).unwrap_or_default());
    }
    let contents = std::fs::read_to_string(&path)
        .map_err(|e| e.to_string())?;
    let settings: AppSettings = toml::from_str(&contents)
        .unwrap_or_default();
    Ok(serde_json::to_string(&settings).unwrap_or_default())
}

#[tauri::command]
fn save_settings(settings_json: String) -> Result<(), String> {
    let settings: AppSettings = serde_json::from_str(&settings_json)
        .map_err(|e| e.to_string())?;
    let toml_str = toml::to_string(&settings)
        .map_err(|e| e.to_string())?;
    let path = settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, toml_str).map_err(|e| e.to_string())?;
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
            get_ssh_password,
            append_audit_log,
            get_object_definition, 
            get_sqlite_objects,
            drop_object,
            load_settings,
            save_settings])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}