// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

use sha2::{Sha256, Digest};

use std::time::Instant;

use std::path::PathBuf;

fn natives_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    exe.parent().expect("exe parent").join("natives")
}

fn native_path(dll: &str) -> String {
    natives_dir().join(dll).to_string_lossy().into_owned()
}

/// Release a CoTaskMem buffer a C# DLL handed back across the FFI boundary by
/// calling that DLL's exported `free_string` (Marshal.FreeCoTaskMem on the C#
/// side). Audit C-1: before this, every returned string was copied with
/// `into_owned()` and the raw pointer dropped un-freed, leaking one buffer per
/// query/schema/history call.
///
/// `lib` MUST be the library that produced `ptr`. The buffer has to be released
/// by the runtime that allocated it — on Windows CoTaskMem is process-global, but
/// on macOS/Linux NativeAOT uses a per-runtime allocator, so freeing through the
/// wrong DLL would be undefined behaviour. If the `free_string` export is missing
/// we skip the free (a tiny leak is strictly safer than a bad free).
///
/// # Safety
/// `ptr` must be a pointer returned by a `free_string`-exporting C# DLL, or null.
unsafe fn free_cstr(lib: &libloading::Library, ptr: *const c_char) {
    if ptr.is_null() {
        return;
    }
    if let Ok(free) =
        lib.get::<unsafe extern "C" fn(*const c_char)>(b"free_string")
    {
        free(ptr);
    }
}

/// Copy a non-null UTF-8 C string returned by a C# DLL into an owned Rust
/// `String`, then free the C#-allocated buffer via `free_cstr`. Call sites guard
/// `ptr.is_null()` before reaching here (the null branch supplies the fallback),
/// so this assumes `ptr` is non-null.
///
/// # Safety
/// `ptr` must be a non-null, NUL-terminated UTF-8 buffer produced by `lib`.
unsafe fn read_and_free(lib: &libloading::Library, ptr: *const c_char) -> String {
    let owned = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    free_cstr(lib, ptr);
    owned
}

/// Canonical error envelope for fallible IPC commands (audit H-3).
///
/// Every fallible `#[tauri::command]` returns `Result<T, IpcError>`. Tauri
/// serializes `Err(IpcError)` onto the promise-rejection channel, so the
/// frontend has exactly one error path (`catch`) and never has to sniff a
/// success payload for a bare `"ERROR:"` string or an in-band `{"error": ...}`
/// field. Successful payloads carry no error channel of their own.
///
/// `code` is a stable, machine-readable tag the UI can branch on without
/// parsing `message`; `message` is human-readable and safe to surface directly.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct IpcError {
    pub code: IpcErrorCode,
    pub message: String,
}

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IpcErrorCode {
    /// Caller-supplied input failed a validation rule.
    Validation,
    /// A native (C#/FFI) call failed or returned no/non-ok response.
    Native,
    /// A requested entity (file, connection, saved query) does not exist.
    NotFound,
    /// Filesystem / IO failure.
    Io,
    /// Anything not covered above.
    Internal,
}

impl IpcError {
    pub fn validation(msg: impl Into<String>) -> Self {
        Self { code: IpcErrorCode::Validation, message: msg.into() }
    }
    pub fn native(msg: impl Into<String>) -> Self {
        Self { code: IpcErrorCode::Native, message: msg.into() }
    }
    #[allow(dead_code)]
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { code: IpcErrorCode::NotFound, message: msg.into() }
    }
    #[allow(dead_code)]
    pub fn io(msg: impl Into<String>) -> Self {
        Self { code: IpcErrorCode::Io, message: msg.into() }
    }
    #[allow(dead_code)]
    pub fn internal(msg: impl Into<String>) -> Self {
        Self { code: IpcErrorCode::Internal, message: msg.into() }
    }
}

/// Bridges legacy `Result<_, String>` bodies into the envelope with a plain `?`
/// or `.into()`: a bare error string becomes a structured `internal` error
/// rather than silently changing the wire shape. This lets the remaining
/// `Result<String, String>` commands migrate mechanically (see the H-3
/// migration checklist) without rewriting their error sites by hand.
impl From<String> for IpcError {
    fn from(message: String) -> Self {
        Self { code: IpcErrorCode::Internal, message }
    }
}
impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

#[cfg(test)]
mod ipc_error_tests {
    use super::{IpcError, IpcErrorCode};

    // The frontend `ipc()` wrapper branches on `code` and surfaces `message`
    // verbatim. These tests pin the exact wire shape so a rename or a serde
    // attribute change can't silently break that single parse path (audit H-3).

    #[test]
    fn serializes_to_stable_code_and_message() {
        let json = serde_json::to_string(&IpcError::validation("bad color")).unwrap();
        assert_eq!(json, r#"{"code":"validation","message":"bad color"}"#);
    }

    #[test]
    fn every_code_serializes_snake_case() {
        let cases = [
            (IpcErrorCode::Validation, "validation"),
            (IpcErrorCode::Native, "native"),
            (IpcErrorCode::NotFound, "not_found"),
            (IpcErrorCode::Io, "io"),
            (IpcErrorCode::Internal, "internal"),
        ];
        for (code, wire) in cases {
            let err = IpcError { code, message: String::new() };
            let json = serde_json::to_string(&err).unwrap();
            assert!(
                json.contains(&format!(r#""code":"{wire}""#)),
                "code {code:?} should serialize as {wire:?}, got {json}"
            );
        }
    }

    #[test]
    fn bare_string_bridges_to_internal() {
        // legacy `Result<_, String>` error sites become structured `internal`
        let err: IpcError = "something went wrong".to_string().into();
        assert_eq!(err.code, IpcErrorCode::Internal);
        assert_eq!(err.message, "something went wrong");
    }
}

/// The SQL Server ODBC driver name to use in connection strings, detected once
/// from what is actually installed. Avoids hardcoding a single version (a clean
/// machine may have Driver 18 but not 17, which throws ODBC IM002).
static SQLSERVER_ODBC_DRIVER: OnceLock<String> = OnceLock::new();

mod fatal;

fn sqlserver_odbc_driver() -> &'static str {
    SQLSERVER_ODBC_DRIVER.get_or_init(|| {
        #[cfg(windows)]
        {
            const CANDIDATES: &[&str] = &[
                "ODBC Driver 18 for SQL Server",
                "ODBC Driver 17 for SQL Server",
                "SQL Server", // legacy, always present on Windows
            ];
            for name in CANDIDATES {
                if odbc_driver_installed(name) {
                    return name.to_string();
                }
            }
            "SQL Server".to_string()
        }
        #[cfg(not(windows))]
        {
            // macOS/Linux use unixODBC, not the registry. Microsoft's driver
            // registers under this name in odbcinst.ini. Static default for now.
            "ODBC Driver 18 for SQL Server".to_string()
        }
    })
    .as_str()
}

/// Shared connection parameters for the database command IPC boundary.
/// Replaces the long flat argument lists that tripped clippy::too_many_arguments
/// (audit A-2). Deserialised from the frontend's camelCase `invoke` payload under
/// a `params` key; omitted optionals (notably `tunnel_port`, sent only by
/// build_connection_string) deserialise to `None`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionParams {
    credential_ref: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    ssl_mode: Option<String>,
    sql_instance: Option<String>,
    windows_auth: Option<bool>,
    tunnel_port: Option<u16>,
}

/// SSH tunnel parameters for `open_tunnel` (a different shape from a DB
/// connection, so it gets its own parameter object — audit A-2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TunnelParams {
    tunnel_id: String,
    ssh_host: String,
    ssh_port: i32,
    ssh_user: String,
    ssh_key_path: String,
    ssh_password: String,
    db_host: String,
    db_port: i32,
}

/// Resolved inputs for `build_sqlserver_odbc`, grouped to keep the builder under
/// the argument-count limit and to keep the IPC `ConnectionParams` type out of
/// the internal ODBC layer. All fields are `Copy`, so the builder destructures
/// by value and its body is unchanged.
struct SqlServerOdbcArgs<'a> {
    host: &'a str,
    port: u16,
    instance: &'a str,
    database: &'a str,
    username: &'a str,
    password: &'a str,
    win_auth: bool,
    ssl_mode: &'a str,
}

/// Builds the ODBC connection string for a SQL Server connection.
/// SINGLE SOURCE OF TRUTH — every SQL Server call site must use this so the
/// driver name, instance/port form, auth mode, and Encrypt/SSL handling can
/// never drift between code paths again.
fn build_sqlserver_odbc(args: &SqlServerOdbcArgs) -> String {
    let &SqlServerOdbcArgs {
        host, port, instance, database, username, password, win_auth, ssl_mode,
    } = args;
    // Named instance => host\instance; otherwise host,port (ODBC comma form).
    let server = if !instance.is_empty() {
        format!("{}\\{}", host, instance)
    } else {
        format!("{},{}", host, port)
    };
    let encrypt = match ssl_mode {
        "require"     => "yes",
        "verify-full" => "strict",
        _             => "no",
    };
    let driver = sqlserver_odbc_driver();
    // Server is composed from allow-list-validated host/port/instance, so it is
    // brace-safe as-is. Database/UID/PWD can carry special characters (the
    // password is free-form in the keychain) and MUST be ODBC-escaped, or a
    // value containing `;`, `}`, `=`, etc. corrupts the connection string
    // (audit H-2).
    if win_auth {
        format!(
            "Driver={{{}}};Server={};Database={};Trusted_Connection=yes;Encrypt={};TrustServerCertificate=yes;",
            driver, server, escape_odbc_value(database), encrypt
        )
    } else {
        format!(
            "Driver={{{}}};Server={};Database={};UID={};PWD={};Encrypt={};TrustServerCertificate=yes;",
            driver, server, escape_odbc_value(database), escape_odbc_value(username), escape_odbc_value(password), encrypt
        )
    }
}

/// Escapes a value for an ODBC connection string (SQL Server via SQLDriverConnect).
/// ODBC rule: if the value contains a delimiter from `[]{}(),;?*=!@`, whitespace,
/// or is empty-significant, enclose it in braces; any `}` inside the braced value
/// is escaped by doubling it (`}}`). A `{` needs no escaping inside the braces.
/// Empty values are returned unchanged (`PWD=;` is harmless and unambiguous).
fn escape_odbc_value(v: &str) -> String {
    if v.is_empty() {
        return String::new();
    }
    let needs_brace = v.starts_with(char::is_whitespace)
        || v.ends_with(char::is_whitespace)
        || v.contains([
            '[', ']', '{', '}', '(', ')', ',', ';', '?', '*', '=', '!', '@', ' ',
        ]);
    if !needs_brace {
        return v.to_string();
    }
    format!("{{{}}}", v.replace('}', "}}"))
}

/// Escapes a value for an ADO.NET keyword/value connection string
/// (Npgsql, MySqlConnector — both follow DbConnectionStringBuilder semantics).
/// A value containing `;`, `'`, `"`, `=`, or with significant leading/trailing
/// whitespace must be quoted. Prefer double-quote enclosure; fall back to single
/// quotes when the value contains a double quote; if it contains both quote
/// kinds, enclose in double quotes and double each embedded double quote.
/// Empty values are returned unchanged so the existing `Password=;` form (used
/// by insecure CockroachDB) is preserved exactly.
fn escape_kv_value(v: &str) -> String {
    if v.is_empty() {
        return String::new();
    }
    let needs_quote = v.starts_with(char::is_whitespace)
        || v.ends_with(char::is_whitespace)
        || v.contains([';', '\'', '"', '=']);
    if !needs_quote {
        return v.to_string();
    }
    if !v.contains('"') {
        format!("\"{v}\"")
    } else if !v.contains('\'') {
        format!("'{v}'")
    } else {
        format!("\"{}\"", v.replace('"', "\"\""))
    }
}

/// Builds a MySQL/MariaDB (MySqlConnector) keyword/value connection string with
/// every free-text field ODBC/ADO.NET-escaped. `suffix` carries the call site's
/// own SSL/timeout/AllowUserVariables tail verbatim, so per-site behaviour is
/// unchanged — only the escaping is centralised here (audit H-2 / A-3).
fn build_mysql_conn(host: &str, port: u16, database: &str, username: &str, password: &str, suffix: &str) -> String {
    format!(
        "Server={};Port={};Database={};Uid={};Pwd={};{}",
        host, port,
        escape_kv_value(database), escape_kv_value(username), escape_kv_value(password),
        suffix
    )
}

/// Builds a PostgreSQL/CockroachDB (Npgsql) keyword/value connection string with
/// every free-text field escaped. `suffix` carries the call site's SSL/timeout
/// tail verbatim (audit H-2 / A-3).
fn build_pg_conn(host: &str, port: u16, database: &str, username: &str, password: &str, suffix: &str) -> String {
    format!(
        "Host={};Port={};Database={};Username={};Password={};{}",
        host, port,
        escape_kv_value(database), escape_kv_value(username), escape_kv_value(password),
        suffix
    )
}

#[cfg(windows)]
fn odbc_driver_installed(name: &str) -> bool {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    hklm.open_subkey(r"SOFTWARE\ODBC\ODBCINST.INI\ODBC Drivers")
        .and_then(|k| k.get_value::<String, _>(name))
        .map(|v| v == "Installed")
        .unwrap_or(false)
}

#[inline]
fn timing_enabled() -> bool {
    std::env::var("DBARK_TIMING").as_deref() == Ok("1")
}

#[inline]
fn mark(t0: Instant, label: &str) {
    if timing_enabled() {
        // eprintln goes to stderr; the harness captures it.
        eprintln!("[timing] {:>28}  +{:>7.1} ms", label, t0.elapsed().as_secs_f64() * 1000.0);
    }
}

fn verify_dll(path: &str, expected_hex: &str) -> Result<(), String> {
    let bytes = std::fs::read(path)
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    let hash = hex::encode(Sha256::digest(&bytes));
    if hash != expected_hex {
        return Err(format!(
            "Hash mismatch for {path}\n  expected: {expected_hex}\n  got:      {hash}"
        ));
    }
    Ok(())
}

// DLL integrity hashes are generated at build time by build.rs into
// $OUT_DIR/dll_hashes.rs as `DLL_HASHES: &[(&str, &str)]`, derived from the exact
// libraries staged in natives/ when the app is compiled. A rebuilt native can
// therefore never silently diverge from a frozen, hand-edited constant — which was
// the failure mode in code audit C-3 (CI rebuilds the NativeAOT DLLs, whose output
// is not bit-reproducible, so they no longer matched the committed hashes and the
// app fatally failed its own integrity check on launch).
include!(concat!(env!("OUT_DIR"), "/dll_hashes.rs"));

static SSH_TUNNEL: OnceLock<libloading::Library> = OnceLock::new();
static QUERY_EXECUTOR:     OnceLock<libloading::Library> = OnceLock::new();
static CONNECTION_MANAGER: OnceLock<libloading::Library> = OnceLock::new();
static FILE_QUERY_ENGINE:  OnceLock<libloading::Library> = OnceLock::new();
static SCHEMA_EXPLORER:    OnceLock<libloading::Library> = OnceLock::new();
static QUERY_HISTORY:      OnceLock<libloading::Library> = OnceLock::new();

fn get_query_executor() -> &'static libloading::Library {
    QUERY_EXECUTOR.get_or_init(|| unsafe {
        libloading::Library::new(native_path("QueryExecutor.dll"))
            .expect("Failed to load QueryExecutor.dll")
    })
}

fn get_connection_manager() -> &'static libloading::Library {
    CONNECTION_MANAGER.get_or_init(|| unsafe {
        libloading::Library::new(native_path("ConnectionManager.dll"))
            .expect("Failed to load ConnectionManager.dll")
    })
}

fn get_file_query_engine() -> &'static libloading::Library {
    FILE_QUERY_ENGINE.get_or_init(|| unsafe {
        libloading::Library::new(native_path("FileQueryEngine.dll"))
            .expect("Failed to load FileQueryEngine.dll")
    })
}

fn get_schema_explorer() -> &'static libloading::Library {
    SCHEMA_EXPLORER.get_or_init(|| unsafe {
        libloading::Library::new(native_path("SchemaExplorer.dll"))
            .expect("Failed to load SchemaExplorer.dll")
    })
}

fn get_query_history() -> &'static libloading::Library {
    QUERY_HISTORY.get_or_init(|| unsafe {
        libloading::Library::new(native_path("QueryHistory.dll"))
            .expect("Failed to load QueryHistory.dll")
    })
}

fn get_ssh_tunnel() -> &'static libloading::Library {
    SSH_TUNNEL.get_or_init(|| unsafe {
        libloading::Library::new(native_path("SshTunnel.dll"))
            .expect("Failed to load SshTunnel.dll")
    })
}

static SQLCIPHER: OnceLock<libloading::Library> = OnceLock::new();

// Add this function:
fn get_sqlcipher() -> &'static libloading::Library {
    SQLCIPHER.get_or_init(|| unsafe {
        libloading::Library::new(native_path("sqlcipher.dll"))
            .expect("Failed to load sqlcipher.dll")
    })
}

#[tauri::command]
async fn execute_query(mut connection_string: String, sql: String, engine: String, read_only: Option<bool>, row_limit: Option<u32>) -> String {
    let read_only_str = if read_only.unwrap_or(false) { "true" } else { "false" };
    // Row cap from the user's resultRowLimit setting; passed as a string over FFI
    // (like read_only). C# clamps a zero/garbage value to its default.
    let row_limit_str = row_limit.unwrap_or(10_000).to_string();
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, *const c_char, *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor().get(b"execute_query").expect("execute_query");
        let c_conn   = CString::new(connection_string.as_str()).unwrap_or_default();
        let c_sql    = CString::new(sql).unwrap_or_default();
        let c_engine = CString::new(engine).unwrap_or_default();
        let c_ro     = CString::new(read_only_str).unwrap_or_default();
        let c_limit  = CString::new(row_limit_str).unwrap_or_default();
        let ptr = func(c_conn.as_ptr(), c_sql.as_ptr(), c_engine.as_ptr(), c_ro.as_ptr(), c_limit.as_ptr());
        if ptr.is_null() { "{\"error\":\"null response\"}".to_string() }
        else { read_and_free(get_query_executor(), ptr) }
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
        else { read_and_free(get_connection_manager(), ptr) }
    }
}

#[tauri::command]
fn save_connection(request_json: String) -> Result<(), IpcError> {
    // ── Validate group and color before passing to C# ────────────────────────
    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&request_json) {
        // group: alphanumeric, spaces, hyphens only, max 50 chars
        if let Some(group) = val.get("group").and_then(|v| v.as_str()) {
            if !group.is_empty() {
                if group.len() > 50 {
                    return Err(IpcError::validation("Group name must be 50 characters or fewer"));
                }
                if !group.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '-') {
                    return Err(IpcError::validation(
                        "Group name may only contain letters, numbers, spaces, and hyphens",
                    ));
                }
            }
        }

        // color: must be exactly #RRGGBB
        if let Some(color) = val.get("color").and_then(|v| v.as_str()) {
            if !color.is_empty() {
                let valid = color.len() == 7
                    && color.starts_with('#')
                    && color[1..].chars().all(|c| c.is_ascii_hexdigit());
                if !valid {
                    return Err(IpcError::validation(
                        "Color must be a valid hex color in #RRGGBB format",
                    ));
                }
            }
        }
    }
    // ── End validation ───────────────────────────────────────────────────────

    let response = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_connection_manager().get(b"save_connection").expect("save_connection");
        let c_req = CString::new(request_json).unwrap_or_default();
        let ptr = func(c_req.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("Connection manager returned no response"));
        }
        read_and_free(get_connection_manager(), ptr)
    };

    // The C# side reports failure as an "ERROR: <reason>" string; translate that
    // into the structured error channel so the frontend never has to sniff the
    // success payload (audit H-3).
    match response.strip_prefix("ERROR:") {
        Some(reason) => Err(IpcError::native(reason.trim())),
        None => Ok(()),
    }
}

#[tauri::command]
fn delete_connection(file_path: String) -> Result<(), IpcError> {
    let rc = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_connection_manager().get(b"delete_connection").expect("delete_connection");
        let c_path = CString::new(file_path).unwrap_or_default();
        func(c_path.as_ptr())
    };
    if rc == 1 {
        Ok(())
    } else {
        Err(IpcError::native("Failed to delete connection file"))
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
fn build_connection_string(params: ConnectionParams) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, tunnel_port,
    } = params;
    let ssl      = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    // If tunnel is active, connect via localhost tunnel port
    let effective_host = if tunnel_port.is_some() { "127.0.0.1".to_string() } else { host };
    let effective_port = tunnel_port.unwrap_or(port);

    // SQLite is a file path with no password — skip the keychain fetch (it would
    // fail with "credential not found" since SQLite connections store none).
    let is_sqlite = engine.to_lowercase() == "sqlite";

    let password = if !win_auth && !is_sqlite {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        // For CockroachDB insecure clusters (ssl_mode = "none") the dbark user
        // has no password — allow an empty or missing credential instead of
        // erroring, which would cause the error string to be used as the
        // connection string and produce a 30-second timeout.
        let pw = match entry.get_password() {
            Ok(p)  => p,
            Err(_) if engine.to_lowercase() == "cockroachdb" && ssl == "none" => String::new(),
            Err(e) => return Err(format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e)),
        };
        if pw.is_empty() && engine.to_lowercase() != "cockroachdb" {
            return Err(format!("No password stored for '{}'. Open Edit Connection, enter the password and save.", credential_ref));
        }
        pw
    } else {
        String::new()
    };

    let conn_str = match engine.to_lowercase().as_str() {
        // MariaDB is wire-protocol compatible with MySQL — uses the same MySqlConnector driver
        "mysql" | "mariadb" => {
            let ssl_param = match ssl.as_str() {
                "none"        => "SslMode=None;",
                "require"     => "SslMode=Required;",       
                "verify-full" => "SslMode=VerifyFull;",
                _             => if tunnel_port.is_some() { "SslMode=None;" } else { "SslMode=Preferred;" },
            };
            build_mysql_conn(&effective_host, effective_port, &database, &username, &password,
                &format!("{};AllowUserVariables=true;", ssl_param))
        },
        "postgres" => {
            let ssl_param = match ssl.as_str() {
                "none"        => "SSL Mode=Disable;",
                "require"     => "SSL Mode=Require;",
                "verify-full" => "SSL Mode=VerifyFull;",
                _             => "SSL Mode=Prefer;",
            };
            build_pg_conn(&effective_host, effective_port, &database, &username, &password, ssl_param)
        },
        // CockroachDB speaks the Postgres wire protocol — uses Npgsql.
        // ssl_mode="none" means insecure single-node dev cluster: omit the SSL
        // parameter entirely. Passing SSL Mode=Disable causes Npgsql to send a
        // different handshake that CockroachDB's insecure listener rejects.
        // For secure clusters use ssl_mode="require" or "verify-full".
        "cockroachdb" => {
            // ssl_mode="none" (insecure): use SSL Mode=Allow so Npgsql connects
            // plain without sending an SSLRequest. Omitting SSL Mode entirely
            // defaults Npgsql to Prefer which DOES send an SSLRequest —
            // CockroachDB insecure may not respond, causing a 30-second timeout.
            let ssl_param = match ssl.as_str() {
                "none"        => "SSL Mode=Allow;",
                "require"     => "SSL Mode=Require;Trust Server Certificate=true;",
                "verify-full" => "SSL Mode=VerifyFull;",
                _             => "SSL Mode=Prefer;Trust Server Certificate=true;",
            };
            build_pg_conn(&effective_host, effective_port, &database, &username, &password, ssl_param)
        },
        "sqlserver" => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &effective_host, port: effective_port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
        "sqlite" => format!("Data Source={}", database),
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    Ok(conn_str)
}

#[tauri::command]
async fn query_file(file_path: String, sql: String) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"query_file").expect("query_file");
        let c_path = CString::new(file_path).unwrap_or_default();
        let c_sql  = CString::new(sql).unwrap_or_default();
        let ptr = func(c_path.as_ptr(), c_sql.as_ptr());
        if ptr.is_null() { "{\"error\":\"null\"}".to_string() }
        else { read_and_free(get_file_query_engine(), ptr) }
    }
}

#[tauri::command]
async fn get_file_schema(file_path: String) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_file_query_engine().get(b"get_file_schema").expect("get_file_schema");
        let c_path = CString::new(file_path).unwrap_or_default();
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() { "{\"error\":\"null\"}".to_string() }
        else { read_and_free(get_file_query_engine(), ptr) }
    }
}

#[tauri::command]
async fn list_db_tables(params: ConnectionParams) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let ssl      = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);
    // No keychain password for SQLite, nor for Windows-auth (uses the OS identity).
    let password = if engine.to_lowercase() == "sqlite" || win_auth {
        String::new()
    } else {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().map_err(|e| format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e))?
    };
    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql" | "mariadb"        => build_mysql_conn(&host, port, &database, &username, &password, "SslMode=Preferred;"),
        "postgres" | "cockroachdb" => build_pg_conn(&host, port, &database, &username, &password, "SSL Mode=Prefer;"),
        "sqlite"                   => format!("Data Source={}", database),
        "sqlserver"                => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
        _                          => return Err(format!("Unsupported engine: {}", engine)),
    };
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"ListTables").expect("ListTables");
        let cs  = CString::new(connection_string.as_str()).unwrap();
        let eng = CString::new(engine).unwrap();
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(read_and_free(get_file_query_engine(), ptr))
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
async fn query_file_with_db(
    params: ConnectionParams, file_path: String, sql: String, table_names: String,
) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let ssl      = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);
    // No keychain password for SQLite, nor for Windows-auth (uses the OS identity).
    // This path powers the flat-file-join: joining a CSV against a live SQLite DB
    // (or a Windows-auth SQL Server) must not require a (nonexistent) password.
    let password = if engine.to_lowercase() == "sqlite" || win_auth {
        String::new()
    } else {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().map_err(|e| format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e))?
    };
    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql" | "mariadb"        => build_mysql_conn(&host, port, &database, &username, &password, "SslMode=Preferred;"),
        "postgres" | "cockroachdb" => build_pg_conn(&host, port, &database, &username, &password, "SSL Mode=Prefer;"),
        "sqlite"                   => format!("Data Source={}", database),
        "sqlserver"                => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
        _                          => return Err(format!("Unsupported engine: {}", engine)),
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
        Ok(read_and_free(get_file_query_engine(), ptr))
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
async fn get_schema(params: ConnectionParams) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let ssl      = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    // SQLite is a file path with no password — skip the keychain fetch (it would
    // fail with "credential not found" since SQLite connections store none).
    let is_sqlite = engine.to_lowercase() == "sqlite";

    let password = if !win_auth && !is_sqlite {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        // For CockroachDB insecure clusters (ssl_mode = "none") the dbark user
        // has no password — allow an empty or missing credential instead of
        // erroring, which would cause the error string to be used as the
        // connection string and produce a 30-second timeout.
        let pw = match entry.get_password() {
            Ok(p)  => p,
            Err(_) if engine.to_lowercase() == "cockroachdb" && ssl == "none" => String::new(),
            Err(e) => return Err(format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e)),
        };
        if pw.is_empty() && engine.to_lowercase() != "cockroachdb" {
            return Err(format!("No password stored for '{}'. Open Edit Connection, enter the password and save.", credential_ref));
        }
        pw
    } else {
        String::new()
    };

    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql" | "mariadb"        => build_mysql_conn(&host, port, &database, &username, &password, ""),
        "postgres"    => build_pg_conn(&host, port, &database, &username, &password, ""),
        // CockroachDB insecure: add SSL Mode=Allow so Npgsql connects plain
        // without sending an SSLRequest (avoids 30-second connection timeout).
        "cockroachdb"  => build_pg_conn(&host, port, &database, &username, &password, "SSL Mode=Allow;"),
        "sqlite"   => format!("Data Source={}", database),
        "sqlserver" => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
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
        Ok(read_and_free(get_schema_explorer(), ptr))
    };

    // Zero out connection string
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }

    result
}

// Enumerate the databases hosted on a server/cluster for one saved connection.
// Mirrors get_schema's connection-string construction exactly (same credential
// fetch, same SSH-tunnel handling, same per-engine string) and then calls the
// schema-explorer DLL's `list_databases` export instead of `get_schema`. The
// frontend calls this once when a connection is selected to populate the
// database list, then calls get_schema(database = <chosen db>) on expand.
#[tauri::command]
async fn list_databases(params: ConnectionParams) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let ssl      = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    let is_sqlite = engine.to_lowercase() == "sqlite";

    // SQLite has no databases-on-a-server concept — short-circuit with an empty
    // list so the frontend renders tables directly with no database layer.
    if is_sqlite {
        return Ok("{\"databases\":[]}".to_string());
    }

    let password = if !win_auth {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        let pw = match entry.get_password() {
            Ok(p)  => p,
            Err(_) if engine.to_lowercase() == "cockroachdb" && ssl == "none" => String::new(),
            Err(e) => return Err(format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e)),
        };
        if pw.is_empty() && engine.to_lowercase() != "cockroachdb" {
            return Err(format!("No password stored for '{}'. Open Edit Connection, enter the password and save.", credential_ref));
        }
        pw
    } else {
        String::new()
    };

    let mut connection_string = match engine.to_lowercase().as_str() {
        "mysql" | "mariadb"        => build_mysql_conn(&host, port, &database, &username, &password, ""),
        "postgres"    => build_pg_conn(&host, port, &database, &username, &password, ""),
        "cockroachdb"  => build_pg_conn(&host, port, &database, &username, &password, "SSL Mode=Allow;"),
        "sqlserver" => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_schema_explorer()
            .get(b"list_databases")
            .expect("list_databases");
        let cs  = CString::new(connection_string.as_str()).unwrap();
        let eng = CString::new(engine).unwrap();
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() { return Err("null response".to_string()); }
        Ok(read_and_free(get_schema_explorer(), ptr))
    };

    // Zero out connection string
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }

    result
}

#[tauri::command]
async fn add_history_entry(
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
async fn get_history(connection_id: String, limit: i32) -> String {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char, i32) -> *const c_char> =
            get_query_history().get(b"get_history").expect("get_history");
        let c_id = CString::new(connection_id).unwrap();
        let ptr  = func(c_id.as_ptr(), limit);
        if ptr.is_null() { "{\"entries\":[]}".to_string() }
        else { read_and_free(get_query_history(), ptr) }
    }
}

#[tauri::command]
async fn clear_history(connection_id: String) -> Result<(), IpcError> {
    let rc = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_query_history().get(b"clear_history").expect("clear_history");
        let c_id = CString::new(connection_id).unwrap_or_default();
        func(c_id.as_ptr())
    };
    if rc == 1 {
        Ok(())
    } else {
        Err(IpcError::native("Failed to clear query history"))
    }
}

#[tauri::command]
async fn test_connection(params: ConnectionParams) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let ssl  = ssl_mode.unwrap_or_else(|| "prefer".to_string());
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);

    let password = if !win_auth && engine.to_lowercase() != "sqlite" {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(p)  => p,
            Err(_) if engine.to_lowercase() == "cockroachdb" && ssl == "none" => String::new(),
            Err(e) => return Err(format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e)),
        }
    } else {
        String::new()
    };

    let conn_str = match engine.to_lowercase().as_str() {
        "mysql" | "mariadb" => build_mysql_conn(&host, port, &database, &username, &password,
            "SslMode=Preferred;ConnectionTimeout=5;"),
        "postgres" => build_pg_conn(&host, port, &database, &username, &password,
            "SSL Mode=Prefer;Timeout=5;"),
        "cockroachdb" => {
            let ssl_param = if ssl == "none" {
                "SSL Mode=Allow;"
            } else {
                "SSL Mode=Prefer;Trust Server Certificate=true;"
            };
            build_pg_conn(&host, port, &database, &username, &password,
                &format!("{}Timeout=5;", ssl_param))
        },
        "sqlite" => format!("Data Source={}", database),
        "sqlserver" => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
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
        read_and_free(get_query_executor(), ptr)
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

/// The application's per-user data directory: `~/.dbark`.
/// Single source of truth — every settings/queries/audit/history path derives
/// from here so the workspace location can never drift between call sites again.
pub(crate) fn dbark_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".dbark")
}

#[tauri::command]
async fn open_tunnel(params: TunnelParams) -> Result<i32, String> {
    let TunnelParams {
        tunnel_id, ssh_host, ssh_port, ssh_user, ssh_key_path, ssh_password, db_host, db_port,
    } = params;

    // ── SSH key path validation ──────────────────────────────────────────────
    // Only validate if a key path was actually provided (password-only auth
    // is valid too)
    if !ssh_key_path.is_empty() {
        let key_path = std::path::Path::new(&ssh_key_path);

        // 1. Must exist
        if !key_path.exists() {
            return Err(format!(
                "SSH key file not found: {}",
                ssh_key_path
            ));
        }

        // 2. Must be a file, not a directory
        if !key_path.is_file() {
            return Err("SSH key path must point to a file, not a directory".to_string());
        }

        // 3. Extension must be .pem, .key, or .ppk
        let valid_extensions = ["pem", "key", "ppk"];
        let ext = key_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !valid_extensions.contains(&ext.as_str()) {
            return Err(format!(
                "Invalid SSH key file type '.{}' — must be .pem, .key, or .ppk",
                ext
            ));
        }

        // 4. Must be within the user's home directory or a standard SSH location
        // This prevents a crafted TOML from pointing the key path at an
        // arbitrary sensitive file (e.g. /etc/passwd) that SSH.NET would
        // read and potentially expose in error messages
        let home = dirs::home_dir().unwrap_or_default();
        let canonical_key = key_path.canonicalize()
            .map_err(|e| format!("Cannot resolve SSH key path: {}", e))?;
        let canonical_home = home.canonicalize().unwrap_or(home.clone());

        let in_home    = canonical_key.starts_with(&canonical_home);
        let in_ssh_dir = canonical_key.starts_with("/etc/ssh")   // Linux system keys
                      || canonical_key.starts_with("C:\\ProgramData\\ssh"); // Windows

        if !in_home && !in_ssh_dir {
            return Err(format!(
                "SSH key must be within your home directory or a standard SSH location. Got: {}",
                ssh_key_path
            ));
        }
    }
    // ── End validation ───────────────────────────────────────────────────────

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
        let json = read_and_free(get_ssh_tunnel(), ptr);

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
async fn export_results(
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

    let log_path = home.join(".dbark").join("audit.log");

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
async fn get_object_definition(
    params: ConnectionParams, object_name: String, object_type: String, schema_name: Option<String>,
) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let instance = sql_instance.unwrap_or_default();
    let win_auth = windows_auth.unwrap_or(false);
    let schema   = schema_name.unwrap_or_else(|| "dbo".to_string());
    let ssl     = ssl_mode.unwrap_or_else(|| "prefer".to_string());

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
            read_and_free(get_query_executor(), ptr)
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
        entry.get_password().map_err(|e| format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e))?
    } else {
        String::new()
    };

    let mut conn_str = match engine.to_lowercase().as_str() {
        "mysql" | "mariadb"       => build_mysql_conn(&host, port, &database, &username, &password, ""),
        "postgres" | "cockroachdb" => build_pg_conn(&host, port, &database, &username, &password, ""),
        "sqlserver" => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
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
        Ok(read_and_free(get_schema_explorer(), ptr))
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
            if let Some(after_eq_raw) = trimmed.strip_prefix('=') {
                let after_eq = after_eq_raw.trim_start();
                if let Some(after_quote) = after_eq.strip_prefix('\'') {
                    if let Some(end_quote) = after_quote.find('\'') {
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
async fn get_sqlite_objects(database: String) -> Result<String, String> {
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
        read_and_free(get_query_executor(), ptr)
    };

    Ok(raw)
}

#[tauri::command]
async fn drop_object(
    params: ConnectionParams, object_name: String, object_type: String,
    schema_name: Option<String>, table_name: Option<String>,
) -> Result<String, String> {
    let ConnectionParams {
        credential_ref, engine, host, port, database, username,
        ssl_mode, sql_instance, windows_auth, ..
    } = params;
    let instance   = sql_instance.unwrap_or_default();
    let win_auth   = windows_auth.unwrap_or(false);
    let schema     = schema_name.unwrap_or_else(|| "dbo".to_string());
    let table      = table_name.unwrap_or_default();
    let ssl       = ssl_mode.unwrap_or_else(|| "prefer".to_string());

    // SQLite has no stored credential — skip the keychain fetch for it.
    let password = if !win_auth && engine.to_lowercase() != "sqlite" {
        let entry = keyring::Entry::new(&credential_ref, &username)
            .map_err(|e| e.to_string())?;
        entry.get_password().map_err(|e| format!("Credential not found in keychain — store the password with the OS keychain first. ({})", e))?
    } else {
        String::new()
    };

    let mut conn_str = match engine.to_lowercase().as_str() {
        "mysql"    => build_mysql_conn(&host, port, &database, &username, &password, ""),
        "postgres" => build_pg_conn(&host, port, &database, &username, &password, ""),
        "sqlite"   => format!("Data Source={}", database),
        "sqlserver" => build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: &host, port, instance: &instance, database: &database,
            username: &username, password: &password, win_auth, ssl_mode: ssl.as_str(),
        }),
        _ => return Err(format!("Unsupported engine: {}", engine)),
    };

    // Build DROP statement per engine and type. Identifiers are quoted per engine
    // and the object type is validated against an allow-list (audit H-1), so a
    // crafted object name or type can't break out into injected SQL.
    let drop_sql = build_drop_statement(
        &engine, &object_type, &object_name, &schema, &table)?;

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
        Ok(read_and_free(get_query_executor(), ptr))
    };

    unsafe {
        let bytes = conn_str.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }

    result
}

/// Quote a SQL identifier for `engine`, doubling that engine's closing delimiter so a
/// crafted or compromised object name can't break out of the quotes (audit H-1).
/// SQL Server uses `[..]` (`]`→`]]`), MySQL/MariaDB use `` `..` `` (`` ` ``→`` `` ``),
/// and everything else (Postgres, CockroachDB, SQLite) uses the SQL-standard `".."`
/// (`"`→`""`). Quoting Postgres/SQLite identifiers is also a correctness win: it
/// preserves the exact catalog casing instead of letting an unquoted name case-fold.
fn quote_ident(engine: &str, ident: &str) -> String {
    match engine.to_lowercase().as_str() {
        "sqlserver"          => format!("[{}]", ident.replace(']', "]]")),
        "mysql" | "mariadb"  => format!("`{}`", ident.replace('`', "``")),
        _                    => format!("\"{}\"", ident.replace('"', "\"\"")),
    }
}

/// Build a DROP statement for a schema object. Every identifier is quoted per engine
/// via [`quote_ident`], and `object_type` is validated against a fixed per-engine
/// allow-list — an unrecognised type returns `Err` rather than being interpolated as a
/// raw SQL keyword. Together these close the H-1 identifier-injection surface: the
/// object name/schema/table all arrive from the frontend over IPC and must be treated
/// as untrusted.
fn build_drop_statement(
    engine: &str, object_type: &str,
    name: &str, schema: &str, table: &str,
) -> Result<String, String> {
    let eng = engine.to_lowercase();
    let q = |ident: &str| quote_ident(&eng, ident);
    let sql = match eng.as_str() {
        "sqlserver" => match object_type {
            "procedure" => format!("DROP PROCEDURE {}.{}", q(schema), q(name)),
            "function"  => format!("DROP FUNCTION {}.{}", q(schema), q(name)),
            "view"      => format!("DROP VIEW {}.{}", q(schema), q(name)),
            "trigger"   => format!("DROP TRIGGER {}", q(name)),
            "index"     => format!("DROP INDEX {} ON {}.{}", q(name), q(schema), q(table)),
            "table"     => format!("DROP TABLE {}.{}", q(schema), q(name)),
            other       => return Err(format!("Unsupported object type for sqlserver: {other}")),
        },
        "mysql" | "mariadb" => match object_type {
            "procedure" => format!("DROP PROCEDURE {}", q(name)),
            "function"  => format!("DROP FUNCTION {}", q(name)),
            "view"      => format!("DROP VIEW {}", q(name)),
            "trigger"   => format!("DROP TRIGGER {}", q(name)),
            "index"     => format!("DROP INDEX {} ON {}", q(name), q(table)),
            "table"     => format!("DROP TABLE {}", q(name)),
            other       => return Err(format!("Unsupported object type for {eng}: {other}")),
        },
        "postgres" | "cockroachdb" => match object_type {
            "procedure" => format!("DROP PROCEDURE {}.{}", q(schema), q(name)),
            "function"  => format!("DROP FUNCTION {}.{}", q(schema), q(name)),
            "view"      => format!("DROP VIEW {}.{}", q(schema), q(name)),
            "trigger"   => format!("DROP TRIGGER {} ON {}.{}", q(name), q(schema), q(table)),
            "index"     => format!("DROP INDEX {}.{}", q(schema), q(name)),
            "table"     => format!("DROP TABLE {}.{}", q(schema), q(name)),
            other       => return Err(format!("Unsupported object type for {eng}: {other}")),
        },
        _ => match object_type { // SQLite (no schema namespace, no procedures/functions)
            "view"    => format!("DROP VIEW {}", q(name)),
            "trigger" => format!("DROP TRIGGER {}", q(name)),
            "index"   => format!("DROP INDEX {}", q(name)),
            "table"   => format!("DROP TABLE {}", q(name)),
            other     => return Err(format!("Unsupported object type for {eng}: {other}")),
        },
    };
    Ok(sql)
}

#[cfg(test)]
mod drop_sql_tests {
    use super::{build_drop_statement, quote_ident};

    #[test]
    fn quote_ident_doubles_sqlserver_bracket() {
        // a `]` in the name must be doubled so it can't close the [..] quote early
        assert_eq!(quote_ident("sqlserver", "ev]il"), "[ev]]il]");
        assert_eq!(quote_ident("sqlserver", "users"), "[users]");
    }

    #[test]
    fn quote_ident_doubles_mysql_backtick() {
        assert_eq!(quote_ident("mysql", "ev`il"), "`ev``il`");
        assert_eq!(quote_ident("mariadb", "t"), "`t`");
    }

    #[test]
    fn quote_ident_doubles_standard_doublequote() {
        // postgres / cockroachdb / sqlite / unknown all use SQL-standard ".."
        assert_eq!(quote_ident("postgres", "ev\"il"), "\"ev\"\"il\"");
        assert_eq!(quote_ident("sqlite", "weird name"), "\"weird name\"");
        assert_eq!(quote_ident("cockroachdb", "t"), "\"t\"");
    }

    #[test]
    fn drop_quotes_all_identifiers_sqlserver() {
        assert_eq!(
            build_drop_statement("sqlserver", "table", "Orders", "dbo", "").unwrap(),
            "DROP TABLE [dbo].[Orders]");
    }

    #[test]
    fn drop_neutralises_injection_in_object_name() {
        // A name crafted to close the quote and append a second statement is rendered
        // inert: the `]` is doubled, so the whole payload stays trapped inside one
        // bracket-quoted identifier and the statement closes only at the very end.
        let sql = build_drop_statement(
            "sqlserver", "table", "x]; DROP TABLE secrets;--", "dbo", "").unwrap();
        assert_eq!(sql, "DROP TABLE [dbo].[x]]; DROP TABLE secrets;--]");
        assert!(sql.ends_with(']'));
    }

    #[test]
    fn drop_quotes_postgres_schema_and_name() {
        assert_eq!(
            build_drop_statement("postgres", "view", "v", "public", "").unwrap(),
            "DROP VIEW \"public\".\"v\"");
    }

    #[test]
    fn drop_quotes_sqlite_name() {
        assert_eq!(
            build_drop_statement("sqlite", "table", "my tbl", "", "").unwrap(),
            "DROP TABLE \"my tbl\"");
    }

    #[test]
    fn drop_index_includes_table_sqlserver() {
        assert_eq!(
            build_drop_statement("sqlserver", "index", "ix_a", "dbo", "Orders").unwrap(),
            "DROP INDEX [ix_a] ON [dbo].[Orders]");
    }

    #[test]
    fn drop_rejects_unknown_object_type() {
        // an object type the engine doesn't support errors out, never interpolates raw
        assert!(build_drop_statement("sqlserver", "database", "x", "dbo", "").is_err());
        assert!(build_drop_statement("sqlite", "procedure", "x", "", "").is_err());
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
    dbark_dir().join("settings.toml")
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

// ── Saved Query Library ─────────────────────────────────────────────────────

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SavedQueryMeta {
    name:        String,
    description: Option<String>,
    tags:        Option<Vec<String>>,
    engine_hint: Option<String>, // e.g. "postgres" — just a hint, not enforced
    created_at:  String,         // ISO 8601
    updated_at:  String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SavedQuery {
    id:          String,   // stem of the filename, e.g. "my-query"
    sql:         String,
    meta:        SavedQueryMeta,
}

fn queries_dir() -> std::path::PathBuf {
    dbark_dir().join("queries")
}

#[tauri::command]
async fn save_query(id: String, sql: String, meta_json: String) -> Result<(), String> {
    let dir = queries_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Sanitise id — alphanumeric, hyphens, underscores only
    let safe_id: String = id.chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    if safe_id.is_empty() {
        return Err("Query name cannot be empty".to_string());
    }

    let mut meta: SavedQueryMeta = serde_json::from_str(&meta_json)
        .map_err(|e| e.to_string())?;
    meta.updated_at = chrono::Utc::now().to_rfc3339();

    // Write .sql file
    let sql_path = dir.join(format!("{}.sql", safe_id));
    std::fs::write(&sql_path, &sql).map_err(|e| e.to_string())?;

    // Write .meta.toml sidecar
    let meta_path = dir.join(format!("{}.meta.toml", safe_id));
    let toml_str = toml::to_string(&meta).map_err(|e| e.to_string())?;
    std::fs::write(&meta_path, toml_str).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn list_queries() -> Result<String, String> {
    let dir = queries_dir();
    if !dir.exists() {
        return Ok("[]".to_string());
    }

    let mut queries: Vec<SavedQuery> = Vec::new();

    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        // Only process .sql files; skip .meta.toml files
        if path.extension().and_then(|e| e.to_str()) != Some("sql") {
            continue;
        }

        let id = path.file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let sql = std::fs::read_to_string(&path).unwrap_or_default();

        let meta_path = dir.join(format!("{}.meta.toml", id));
        let meta: SavedQueryMeta = if meta_path.exists() {
            let raw = std::fs::read_to_string(&meta_path).unwrap_or_default();
            toml::from_str(&raw).unwrap_or_else(|_| SavedQueryMeta {
                name:        id.clone(),
                description: None,
                tags:        None,
                engine_hint: None,
                created_at:  String::new(),
                updated_at:  String::new(),
            })
        } else {
            SavedQueryMeta {
                name:        id.clone(),
                description: None,
                tags:        None,
                engine_hint: None,
                created_at:  String::new(),
                updated_at:  String::new(),
            }
        };

        queries.push(SavedQuery { id, sql, meta });
    }

    // Sort by updated_at descending (most recently saved first)
    queries.sort_by(|a, b| b.meta.updated_at.cmp(&a.meta.updated_at));

    serde_json::to_string(&queries).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_query(id: String) -> Result<(), String> {
    let dir = queries_dir();
    let sql_path  = dir.join(format!("{}.sql", id));
    let meta_path = dir.join(format!("{}.meta.toml", id));

    if sql_path.exists() {
        std::fs::remove_file(&sql_path).map_err(|e| e.to_string())?;
    }
    if meta_path.exists() {
        std::fs::remove_file(&meta_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn load_query(id: String) -> Result<String, String> {
    let path = queries_dir().join(format!("{}.sql", id));
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// ── DBeaver Import ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct DbeaverImportResult {
    imported: Vec<DbeaverImportedConnection>,
    skipped:  Vec<String>,
    error:    Option<String>,
}

#[derive(serde::Serialize)]
struct DbeaverImportedConnection {
    name:        String,
    engine:      String,
    host:        String,
    port:        u16,
    database:    String,
    username:    String,
    password:    String,   // returned to frontend to store in keychain; blank if not stored
    ssl_mode:    String,   // "none" | "prefer" | "require" | "verify-full"
    read_only:   bool,
    ssh_enabled: bool,
    ssh_host:    String,
    ssh_port:    u16,
    ssh_user:    String,
    ssh_key_path: String,
}

/// DBeaver stores passwords wrapped in ##, e.g. "##mypassword##".
/// Strip the markers and return the inner value. If the value is just "##"
/// or has no closing marker treat it as no password stored.
fn strip_dbeaver_password(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("##") && trimmed.ends_with("##") && trimmed.len() > 4 {
        trimmed[2..trimmed.len() - 2].to_string()
    } else if trimmed == "##" || trimmed.is_empty() {
        String::new()
    } else {
        // No markers — plain text password (older DBeaver versions)
        trimmed.to_string()
    }
}

/// Map DBeaver sslmode string (from properties block) to DbArk ssl_mode value.
fn map_ssl_mode(dbeaver_ssl: &str) -> &'static str {
    match dbeaver_ssl.to_lowercase().as_str() {
        "disable" | "disabled" | "false" | "none" => "none",
        "require" | "required"                     => "require",
        "verify-full" | "verify_full"              => "verify-full",
        _                                          => "prefer",
    }
}

#[tauri::command]
fn import_dbeaver_connections() -> String {
    let path = match dirs::home_dir() {
        Some(h) => h.join(".dbeaver").join("data-sources.json"),
        None => return serde_json::to_string(&DbeaverImportResult {
            imported: vec![],
            skipped:  vec![],
            error:    Some("Could not determine home directory".to_string()),
        }).unwrap(),
    };

    if !path.exists() {
        return serde_json::to_string(&DbeaverImportResult {
            imported: vec![],
            skipped:  vec![],
            error:    Some(format!(
                "DBeaver config not found at {}. Is DBeaver installed?",
                path.display()
            )),
        }).unwrap();
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => return serde_json::to_string(&DbeaverImportResult {
            imported: vec![],
            skipped:  vec![],
            error:    Some(format!("Failed to read DBeaver config: {}", e)),
        }).unwrap(),
    };

    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return serde_json::to_string(&DbeaverImportResult {
            imported: vec![],
            skipped:  vec![],
            error:    Some(format!("Failed to parse DBeaver config: {}", e)),
        }).unwrap(),
    };

    let mut imported = Vec::new();
    let mut skipped  = Vec::new();

    let connections = match json.get("connections").and_then(|c| c.as_object()) {
        Some(c) => c,
        None    => return serde_json::to_string(&DbeaverImportResult {
            imported: vec![],
            skipped:  vec![],
            error:    Some("No connections found in DBeaver config".to_string()),
        }).unwrap(),
    };

    for (_id, conn) in connections {
        let name = conn.get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unnamed")
            .to_string();

        // DBeaver uses `provider` + `driver` together to identify the engine.
        // `provider` alone is not enough — both MySQL and MariaDB share
        // provider=mysql, and both Postgres and CockroachDB share
        // provider=postgresql. Always check `driver` first.
        let provider = conn.get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let driver = conn.get("driver")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();

        let engine = if driver.contains("cockroach") {
            "cockroachdb"
        } else if driver.contains("mariadb") {
            "mariadb"
        } else if driver.contains("mysql") {
            "mysql"
        } else if driver.contains("postgresql") || driver.contains("postgres") {
            "postgres"
        } else if driver.contains("sqlite") {
            "sqlite"
        } else if driver.contains("sqlserver") || driver.contains("mssql") {
            "sqlserver"
        } else {
            // Fall back to provider when driver gives no useful signal
            match provider.as_str() {
                p if p.contains("mysql")                            => "mysql",
                p if p.contains("postgresql")                       => "postgres",
                p if p.contains("sqlite")                           => "sqlite",
                p if p.contains("sqlserver") || p.contains("mssql") => "sqlserver",
                _ => {
                    skipped.push(format!(
                        "{} (unsupported provider: {}, driver: {})", name, provider, driver
                    ));
                    continue;
                }
            }
        };

        let config = match conn.get("configuration") {
            Some(c) => c,
            None    => { skipped.push(format!("{} (no configuration)", name)); continue; }
        };

        let host = config.get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("localhost")
            .to_string();

        // Treat empty database as absent rather than passing "" to the driver
        let database = config.get("database")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let default_port: u16 = match engine {
            "postgres"    => 5432,
            "cockroachdb" => 26257,
            "mysql"       => 3306,
            "mariadb"     => 3306,
            "sqlserver"   => 1433,
            _             => 0,
        };
        let port: u16 = config.get("port")
            .and_then(|v| v.as_str()).and_then(|s| s.parse().ok())
            .or_else(|| config.get("port").and_then(|v| v.as_u64()).map(|n| n as u16))
            .unwrap_or(default_port);

        // Credentials: DBeaver stores user/password directly under `configuration`,
        // not under a nested `credentials` block.
        let username = config.get("user")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let raw_password = config.get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let password = strip_dbeaver_password(raw_password);

        // SSL mode — read from configuration.properties.sslmode (Postgres/CockroachDB)
        // or configuration.properties.useSSL (MySQL/MariaDB dialect).
        let props = config.get("properties");
        let ssl_mode = props
            .and_then(|p| p.get("sslmode")).and_then(|v| v.as_str())
            .or_else(|| props.and_then(|p| p.get("useSSL")).and_then(|v| v.as_str()))
            .map(map_ssl_mode)
            .unwrap_or("prefer")
            .to_string();

        // read-only flag
        let read_only = config.get("read-only")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // SSH tunnel
        let (ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_key_path) =
            if let Some(tunnel) = config.get("tunnel-configuration") {
                let t_type = tunnel.get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if t_type == "SSH_TUNNEL" {
                    let t_host = tunnel.get("host")
                        .and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let t_port = tunnel.get("port")
                        .and_then(|v| v.as_str()).and_then(|s| s.parse().ok())
                        .or_else(|| tunnel.get("port").and_then(|v| v.as_u64()).map(|n| n as u16))
                        .unwrap_or(22);
                    let t_user = tunnel.get("user")
                        .and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let t_key = tunnel
                        .get("impl-properties")
                        .and_then(|p| p.get("privKeyPath"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    (!t_host.is_empty(), t_host, t_port, t_user, t_key)
                } else {
                    (false, String::new(), 22, String::new(), String::new())
                }
            } else {
                (false, String::new(), 22, String::new(), String::new())
            };

        imported.push(DbeaverImportedConnection {
            name,
            engine: engine.to_string(),
            host,
            port,
            database,
            username,
            password,
            ssl_mode,
            read_only,
            ssh_enabled,
            ssh_host,
            ssh_port,
            ssh_user,
            ssh_key_path,
        });
    }

    serde_json::to_string(&DbeaverImportResult { imported, skipped, error: None }).unwrap()
}

// Two new Tauri commands for the Activity panel.
// Both follow the existing execute_query pattern:
//   - mut connection_string so we can zero it after use
//   - libloading::Symbol resolves the C# entry point
//   - C-string round-trip across the FFI boundary
//   - Null-pointer guard returns a JSON error envelope
//   - Zero the connection string in memory immediately after the call

// ── get_activity ─────────────────────────────────────────────────────────────
#[tauri::command]
async fn get_activity(mut connection_string: String, engine: String) -> String {
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"get_activity")
            .expect("get_activity");
        let c_conn   = CString::new(connection_string.as_str()).unwrap_or_default();
        let c_engine = CString::new(engine).unwrap_or_default();
        let ptr = func(c_conn.as_ptr(), c_engine.as_ptr());
        if ptr.is_null() {
            "{\"error\":\"null response\"}".to_string()
        } else {
            read_and_free(get_query_executor(), ptr)
        }
    };
    // Zero the connection string in memory after use — same pattern as
    // execute_query. Prevents passwords lingering in process memory.
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}


// ── kill_session ─────────────────────────────────────────────────────────────
#[tauri::command]
async fn kill_session(mut connection_string: String, engine: String, pid: String) -> String {
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"kill_session")
            .expect("kill_session");
        let c_conn   = CString::new(connection_string.as_str()).unwrap_or_default();
        let c_engine = CString::new(engine).unwrap_or_default();
        let c_pid    = CString::new(pid).unwrap_or_default();
        let ptr = func(c_conn.as_ptr(), c_engine.as_ptr(), c_pid.as_ptr());
        if ptr.is_null() {
            "{\"error\":\"null response\"}".to_string()
        } else {
            read_and_free(get_query_executor(), ptr)
        }
    };
    unsafe {
        let bytes = connection_string.as_bytes_mut();
        for b in bytes.iter_mut() { *b = 0; }
    }
    result
}

#[tauri::command]
fn log_ready_time(ms: u32) {
    if std::env::var("DBARK_TIMING").as_deref() == Ok("1") {
        eprintln!("[timing] {:>28}  ready at +{} ms (webview clock)", "FRONTEND READY", ms);
    }
}

fn main() {

    // Catch-all: write any panic to a file, since stderr is dead in a
    // windows-subsystem release build.
    std::panic::set_hook(Box::new(|info| {
        fatal::report_panic(&info.to_string());
    }));

    let t0 = Instant::now();                        
    mark(t0, "main() entered");                     

     // Verify all native library integrity before loading. DLL_HASHES is generated
     // by build.rs from the libraries actually staged in natives/ at build time, so
     // the filenames already carry the correct per-platform extension and there is a
     // single source of truth for both the file list and the expected hash.
   for (lib, expected) in DLL_HASHES {
        let path = native_path(lib);
        if let Err(reason) = verify_dll(&path, expected) {
            fatal::report_fatal("DLL integrity check", reason);
        }
    }

    mark(t0, "DLL hash verify done");

    // Generate or retrieve the state.db encryption key from keychain
    let history_key = {
        let target = "dbark:statedb:encryption";
        let username = "dbark";
        match keyring::Entry::new(target, username) {
            Ok(entry) => match entry.get_password() {
                Ok(k) => k,
                Err(_) => {
                    // First run — generate a new key and store it
                    let new_key: String = (0..32)
                        .map(|_| format!("{:02x}", rand::random::<u8>()))
                        .collect();
                    let _ = entry.set_password(&new_key);
                    new_key
                }
            },
            Err(_) => String::new(),
        }
    };


    mark(t0, "keychain read done");  

    // Pass key to QueryHistory DLL
    unsafe {
        if let Ok(func) = get_query_history()
            .get::<unsafe extern "C" fn(*const c_char)>(b"init_history_key")
        {
            let c_key = CString::new(history_key).unwrap_or_default();
            func(c_key.as_ptr());
        }
    }

    mark(t0, "history key init done");

    get_sqlcipher();
    get_query_executor();
    get_connection_manager();
    get_file_query_engine();
    get_schema_explorer();
    get_query_history();
    get_ssh_tunnel();
    mark(t0, "DLL preload done");   

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
            list_databases,
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
            save_settings,
            save_query,
            list_queries,
            delete_query,
            load_query,
            import_dbeaver_connections,
            get_activity,
            kill_session,
            log_ready_time])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
#[cfg(test)]
mod conn_string_tests {
    use super::{
        build_mysql_conn, build_pg_conn, build_sqlserver_odbc, escape_kv_value, escape_odbc_value,
        SqlServerOdbcArgs,
    };

    // ---- escape_kv_value (Npgsql / MySqlConnector) ----

    #[test]
    fn kv_passes_plain_values_through_unquoted() {
        assert_eq!(escape_kv_value("plainpw"), "plainpw");
        assert_eq!(escape_kv_value("p@ssw0rd"), "p@ssw0rd"); // @ is not special in ADO.NET
    }

    #[test]
    fn kv_quotes_semicolon_so_password_cannot_break_out() {
        // Without quoting, `;` ends the Password field early and the rest of the
        // password is parsed as bogus keywords — the core audit H-2 bug.
        assert_eq!(escape_kv_value("pa;ss"), "\"pa;ss\"");
        assert_eq!(escape_kv_value("a;b=c"), "\"a;b=c\"");
    }

    #[test]
    fn kv_quotes_equals_and_trailing_whitespace() {
        assert_eq!(escape_kv_value("base64=="), "\"base64==\"");
        assert_eq!(escape_kv_value("trailing "), "\"trailing \"");
        assert_eq!(escape_kv_value(" leading"), "\" leading\"");
    }

    #[test]
    fn kv_picks_safe_enclosure_for_quote_chars() {
        // double quote present, no single quote -> enclose in single quotes
        assert_eq!(escape_kv_value("pw\"x"), "'pw\"x'");
        // single quote present, no double quote -> enclose in double quotes
        assert_eq!(escape_kv_value("pw'x"), "\"pw'x\"");
        // both present -> double-quote enclosure with embedded " doubled
        assert_eq!(escape_kv_value("a'b\"c"), "\"a'b\"\"c\"");
    }

    #[test]
    fn kv_empty_value_is_unchanged() {
        // preserves the `Password=;` form that insecure CockroachDB relies on
        assert_eq!(escape_kv_value(""), "");
    }

    // ---- escape_odbc_value (SQL Server via SQLDriverConnect) ----

    #[test]
    fn odbc_braces_special_chars_and_doubles_close_brace() {
        assert_eq!(escape_odbc_value("pa;ss"), "{pa;ss}");
        assert_eq!(escape_odbc_value("p@ss"), "{p@ss}"); // @ IS an ODBC delimiter
        assert_eq!(escape_odbc_value("brace}here"), "{brace}}here}");
        // a `{` inside needs no escaping; only `}` is doubled
        assert_eq!(escape_odbc_value("a{b}c"), "{a{b}}c}");
    }

    #[test]
    fn odbc_passes_plain_values_through() {
        assert_eq!(escape_odbc_value("plainpw"), "plainpw");
        assert_eq!(escape_odbc_value(""), "");
    }

    // ---- builders embed escaping at the only place a string is assembled ----

    #[test]
    fn mysql_builder_escapes_password_in_full_string() {
        let s = build_mysql_conn("h", 3306, "db", "user", "p;w", "SslMode=Preferred;");
        assert_eq!(
            s,
            "Server=h;Port=3306;Database=db;Uid=user;Pwd=\"p;w\";SslMode=Preferred;"
        );
        // the injected `;` is now inside quotes, so it can't terminate the field
        assert!(s.contains("Pwd=\"p;w\";"));
    }

    #[test]
    fn pg_builder_escapes_password_in_full_string() {
        let s = build_pg_conn("h", 5432, "db", "user", "p;w", "");
        assert_eq!(
            s,
            "Host=h;Port=5432;Database=db;Username=user;Password=\"p;w\";"
        );
    }

    #[test]
    fn pg_builder_preserves_empty_password_form() {
        let s = build_pg_conn("h", 26257, "db", "root", "", "SSL Mode=Allow;");
        assert_eq!(
            s,
            "Host=h;Port=26257;Database=db;Username=root;Password=;SSL Mode=Allow;"
        );
    }

    #[test]
    fn sqlserver_odbc_escapes_password() {
        let s = build_sqlserver_odbc(&SqlServerOdbcArgs {
            host: "h", port: 1433, instance: "", database: "db",
            username: "sa", password: "p;w}x", win_auth: false, ssl_mode: "require",
        });
        // password ends up brace-quoted with the `}` doubled
        assert!(s.contains("PWD={p;w}}x};"), "got: {}", s);
        assert!(s.contains("Database=db;"));
    }
}
