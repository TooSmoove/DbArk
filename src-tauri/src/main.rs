// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use libloading::{Library, Symbol};
use std::ffi::{c_char, CStr, CString};

#[tauri::command]
fn test_connection(connection_string: String) -> bool {
    unsafe {
        // Load the C# native library
        let lib = Library::new("natives/QueryExecutor.dll")
            .expect("Failed to load QueryExecutor.dll");

        // Get the exported function
        let func: Symbol<unsafe extern "C" fn(*const i8) -> i32> = lib
            .get(b"test_connection")
            .expect("Failed to find test_connection export");

        // Convert the Rust String to a C string
        let c_string = CString::new(connection_string)
            .expect("CString conversion failed");

        // Call the C# function
        let result = func(c_string.as_ptr());
        result == 1
    }
}

#[tauri::command]
fn load_connection(path: String) -> String {
    unsafe {
        let lib = Library::new("natives/QueryExecutor.dll")
            .expect("Failed to load QueryExecutor.dll");

        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = lib
            .get(b"load_connection")
            .expect("Failed to find load_connection export");

        let c_path = CString::new(path).expect("CString failed");
        let result_ptr = func(c_path.as_ptr());

        if result_ptr.is_null() {
            return "ERROR: null response".to_string();
        }

        std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned()
    }
}

#[tauri::command]
fn test_mysql_connection(connection_string: String) -> String {
    unsafe {
        let lib = Library::new("natives/QueryExecutor.dll")
            .expect("Failed to load QueryExecutor.dll");

        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = lib
            .get(b"test_mysql_connection")
            .expect("Failed to find test_mysql_connection export");

        let c_string = CString::new(connection_string)
            .expect("CString failed");

        let result_ptr = func(c_string.as_ptr());

        if result_ptr.is_null() {
            return "ERROR: null response".to_string();
        }

        std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned()
    }
}

#[tauri::command]
fn execute_query(connection_string: String, sql: String, engine: String) -> String {
    unsafe {
        let lib = match Library::new("natives/QueryExecutor.dll") {
            Ok(l) => l,
            Err(e) => return format!("{{\"error\":\"Failed to load QueryExecutor: {}\"}}", e),
        };

        let func: Symbol<unsafe extern "C" fn(
            *const i8, *const i8, *const i8) -> *const i8> = match lib
            .get(b"execute_query") {
            Ok(f) => f,
            Err(e) => return format!("{{\"error\":\"Failed to find execute_query: {}\"}}", e),
        };

        let c_conn   = CString::new(connection_string).unwrap_or_default();
        let c_sql    = CString::new(sql).unwrap_or_default();
        let c_engine = CString::new(engine).unwrap_or_default();

        let result_ptr = func(
            c_conn.as_ptr(),
            c_sql.as_ptr(),
            c_engine.as_ptr());

        if result_ptr.is_null() {
            return "{\"error\":\"null response\"}".to_string();
        }

        std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned()
    }
}

#[tauri::command]
fn list_connections(folder_path: String) -> String {
    unsafe {
        let lib = Library::new("natives/ConnectionManager.dll")
            .expect("Failed to load ConnectionManager.dll");

        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = lib
            .get(b"list_connections")
            .expect("Failed to find list_connections");

        let c_path = CString::new(folder_path).expect("CString failed");
        let result_ptr = func(c_path.as_ptr());

        if result_ptr.is_null() {
            return "{\"connections\":[]}".to_string();
        }

        std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned()
    }
}

#[tauri::command]
fn save_connection(request_json: String) -> String {
    unsafe {
        let lib = Library::new("natives/ConnectionManager.dll")
            .expect("Failed to load ConnectionManager.dll");

        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = lib
            .get(b"save_connection")
            .expect("Failed to find save_connection");

        let c_req = CString::new(request_json).expect("CString failed");
        let result_ptr = func(c_req.as_ptr());

        if result_ptr.is_null() {
            return "ERROR: null response".to_string();
        }

        std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned()
    }
}

#[tauri::command]
fn delete_connection(file_path: String) -> bool {
    unsafe {
        let lib = Library::new("natives/ConnectionManager.dll")
            .expect("Failed to load ConnectionManager.dll");

        let func: Symbol<unsafe extern "C" fn(*const i8) -> i32> = lib
            .get(b"delete_connection")
            .expect("Failed to find delete_connection");

        let c_path = CString::new(file_path).expect("CString failed");
        func(c_path.as_ptr()) == 1
    }
}

#[tauri::command]
fn store_credential(target: String, username: String, password: String) -> bool {
    let entry = match keyring::Entry::new(&target, &username) {
        Ok(e) => e,
        Err(_) => return false,
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
                _             => "SslMode=Preferred;", // prefer is default
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
fn test_postgres_connection(connection_string: String) -> String {
    unsafe {
        let lib = match Library::new("natives/QueryExecutor.dll") {
            Ok(l) => l,
            Err(e) => return format!("ERROR: {}", e),
        };
        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = match lib
            .get(b"test_postgres_connection") {
            Ok(f) => f,
            Err(e) => return format!("ERROR: {}", e),
        };
        let c_conn = CString::new(connection_string).unwrap_or_default();
        let result_ptr = func(c_conn.as_ptr());
        if result_ptr.is_null() { return "ERROR: null".to_string(); }
        std::ffi::CStr::from_ptr(result_ptr).to_string_lossy().into_owned()
    }
}

#[tauri::command]
fn test_sqlite_connection(connection_string: String) -> String {
    unsafe {
        let lib = match Library::new("natives/QueryExecutor.dll") {
            Ok(l) => l,
            Err(e) => return format!("ERROR: {}", e),
        };
        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = match lib
            .get(b"test_sqlite_connection") {
            Ok(f) => f,
            Err(e) => return format!("ERROR: {}", e),
        };
        let c_conn = CString::new(connection_string).unwrap_or_default();
        let result_ptr = func(c_conn.as_ptr());
        if result_ptr.is_null() { return "ERROR: null".to_string(); }
        std::ffi::CStr::from_ptr(result_ptr).to_string_lossy().into_owned()
    }
}

#[tauri::command]
fn query_file(file_path: String, sql: String) -> String {
    unsafe {
        let lib = match Library::new("natives/FileQueryEngine.dll") {
            Ok(l) => l,
            Err(e) => return format!("{{\"error\":\"FileQueryEngine load failed: {}\"}}", e),
        };
        let func: Symbol<unsafe extern "C" fn(
            *const i8, *const i8) -> *const i8> = match lib
            .get(b"query_file") {
            Ok(f) => f,
            Err(e) => return format!("{{\"error\":\"query_file not found: {}\"}}", e),
        };
        let c_path = CString::new(file_path).unwrap_or_default();
        let c_sql  = CString::new(sql).unwrap_or_default();
        let ptr = func(c_path.as_ptr(), c_sql.as_ptr());
        if ptr.is_null() { return "{\"error\":\"null\"}".to_string(); }
        std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

#[tauri::command]
fn get_file_schema(file_path: String) -> String {
    unsafe {
        let lib = match Library::new("natives/FileQueryEngine.dll") {
            Ok(l) => l,
            Err(e) => return format!("{{\"error\":\"FileQueryEngine load failed: {}\"}}", e),
        };
        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = match lib
            .get(b"get_file_schema") {
            Ok(f) => f,
            Err(e) => return format!("{{\"error\":\"get_file_schema not found: {}\"}}", e),
        };
        let c_path = CString::new(file_path).unwrap_or_default();
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() { return "{\"error\":\"null\"}".to_string(); }
        std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

#[tauri::command]
fn list_db_tables(
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
) -> Result<String, String> {
    // Build connection string via keyring — password never touches JS
    let entry = keyring::Entry::new(&credential_ref, &username).map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();

    let connection_string = match engine.to_lowercase().as_str() {
        "mysql"     => format!("Server={};Port={};Database={};Uid={};Pwd={};", host, port, database, username, password),
        "postgres"  => format!("Host={};Port={};Database={};Username={};Password={};", host, port, database, username, password),
        "sqlite"    => format!("Data Source={};", database),
        _           => return Err(format!("Unsupported engine: {}", engine)),
    };

    unsafe {
        let lib = Library::new("natives/FileQueryEngine.dll").map_err(|e| e.to_string())?;

        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char
        ) -> *const c_char> = lib.get(b"ListTables").map_err(|e| e.to_string())?;

        let cs  = CString::new(connection_string).unwrap();
        let eng = CString::new(engine).unwrap();

        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

#[tauri::command]
fn query_file_with_db(
    file_path: String,
    sql: String,
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    table_names: String,
) -> Result<String, String> {
    // Build connection string via keyring — password never touches JS
    let entry = keyring::Entry::new(&credential_ref, &username).map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();

    let connection_string = match engine.to_lowercase().as_str() {
        "mysql"     => format!("Server={};Port={};Database={};Uid={};Pwd={};", host, port, database, username, password),
        "postgres"  => format!("Host={};Port={};Database={};Username={};Password={};", host, port, database, username, password),
        "sqlite"    => format!("Data Source={};", database),
        _           => return Err(format!("Unsupported engine: {}", engine)),
    };

    unsafe {
        let lib = Library::new("natives/FileQueryEngine.dll").map_err(|e| e.to_string())?;

        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
            *const c_char, *const c_char,
            *const c_char,
        ) -> *const c_char> = lib.get(b"QueryFileWithDb").map_err(|e| e.to_string())?;

        let fp  = CString::new(file_path).unwrap();
        let s   = CString::new(sql).unwrap();
        let cs  = CString::new(connection_string).unwrap();
        let eng = CString::new(engine).unwrap();
        let tbl = CString::new(table_names).unwrap();

        let ptr = func(fp.as_ptr(), s.as_ptr(), cs.as_ptr(), eng.as_ptr(), tbl.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

#[tauri::command]
fn get_schema(
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
) -> Result<String, String> {
    let entry = keyring::Entry::new(&credential_ref, &username)
        .map_err(|e| e.to_string())?;
    let password = entry.get_password().unwrap_or_default();

    let connection_string = match engine.to_lowercase().as_str() {
        "mysql"    => format!("Server={};Port={};Database={};Uid={};Pwd={};",
                        host, port, database, username, password),
        "postgres" => format!("Host={};Port={};Database={};Username={};Password={};",
                        host, port, database, username, password),
        "sqlite"   => format!("Data Source={}", database),
        _          => return Err(format!("Unsupported engine: {}", engine)),
    };

    unsafe {
        let lib = Library::new("natives/SchemaExplorer.dll")
            .map_err(|e| e.to_string())?;

        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char
        ) -> *const c_char> = lib.get(b"get_schema")
            .map_err(|e| e.to_string())?;

        let cs  = CString::new(connection_string).unwrap();
        let eng = CString::new(engine).unwrap();

        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(CStr::from_ptr(ptr).to_string_lossy().into_owned())
    }
}

fn main() {
    tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            test_connection, 
            load_connection, 
            test_mysql_connection, 
            execute_query, 
            list_connections, 
            save_connection,
            delete_connection, 
            store_credential, 
            delete_credential,
            build_connection_string,
            test_postgres_connection,
            test_sqlite_connection,
            query_file,
            get_file_schema,
            list_db_tables,
            query_file_with_db,
            get_schema])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}