// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::{c_char, CStr, CString};
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use std::time::Instant;

use std::path::PathBuf;

use zeroize::Zeroizing;

fn natives_dir() -> PathBuf {
    // Load-path failure: if we cannot locate our own executable we cannot find a
    // single native library, so route through report_fatal for a named dialog +
    // log line and a clean exit rather than a bare panic (code audit H-4).
    let exe = std::env::current_exe()
        .unwrap_or_else(|e| fatal::report_fatal("Locating the executable", e));
    let parent = exe.parent().unwrap_or_else(|| {
        fatal::report_fatal(
            "Locating the executable",
            format!("{} has no parent directory", exe.display()),
        )
    });
    parent.join("natives")
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
    if let Ok(free) = lib.get::<unsafe extern "C" fn(*const c_char)>(b"free_string") {
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

/// The single FFI gateway to QueryExecutor's `execute_query` export (audit A-3).
///
/// The export takes FIVE pointer args — conn, sql, engine, read_only, row_limit.
/// Declaring or calling it with any other arity makes the C# side read a garbage
/// stack slot and dereference it, which is an instant AccessViolation fail-fast
/// (the "Test Connection" crash-to-desktop). Exactly that happened when the
/// row_limit arg was added: the main query path was updated, and four hand-copied
/// call sites silently kept the old four-arg shape. Every call MUST go through
/// this helper so the signature lives in one place; never re-declare the symbol
/// at a call site.
fn call_execute_query(
    conn_str: &str,
    sql: &str,
    engine: &str,
    read_only: bool,
    row_limit: u32,
) -> Result<String, IpcError> {
    let nul_err = || {
        IpcError::validation("input contains a NUL byte and cannot be passed to the native layer")
    };
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
            ) -> *const c_char,
        > = get_query_executor().get(b"execute_query").map_err(|e| {
            IpcError::native(format!(
                "Native export `execute_query` is unavailable — your DbArk install may be corrupt; reinstall. ({e})"
            ))
        })?;
        let c_conn = CString::new(conn_str).map_err(|_| nul_err())?;
        let c_sql = CString::new(sql).map_err(|_| nul_err())?;
        let c_engine = CString::new(engine).map_err(|_| nul_err())?;
        let c_ro = CString::new(if read_only { "true" } else { "false" }).map_err(|_| nul_err())?;
        let c_limit = CString::new(row_limit.to_string()).map_err(|_| nul_err())?;
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
        Self {
            code: IpcErrorCode::Validation,
            message: msg.into(),
        }
    }
    pub fn native(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Native,
            message: msg.into(),
        }
    }
    #[allow(dead_code)]
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::NotFound,
            message: msg.into(),
        }
    }
    #[allow(dead_code)]
    pub fn io(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Io,
            message: msg.into(),
        }
    }
    #[allow(dead_code)]
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Internal,
            message: msg.into(),
        }
    }
}

/// Bridges legacy `Result<_, String>` bodies into the envelope with a plain `?`
/// or `.into()`: a bare error string becomes a structured `internal` error
/// rather than silently changing the wire shape. This lets the remaining
/// `Result<String, String>` commands migrate mechanically (see the H-3
/// migration checklist) without rewriting their error sites by hand.
impl From<String> for IpcError {
    fn from(message: String) -> Self {
        Self {
            code: IpcErrorCode::Internal,
            message,
        }
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
            let err = IpcError {
                code,
                message: String::new(),
            };
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

mod engine;
mod fatal;

use engine::{ConnOptions, ConnectionParams, Engine, EngineError};

/// Map engine-layer errors onto the IPC envelope (audit A-2): the engine
/// module knows nothing about IPC, and the wire shape the frontend sees is
/// unchanged — an unsupported engine is `validation`, missing credentials are
/// `not_found`, keychain plumbing failures are `internal`.
impl From<EngineError> for IpcError {
    fn from(e: EngineError) -> Self {
        match &e {
            EngineError::Unsupported(_) => IpcError::validation(e.to_string()),
            EngineError::CredentialNotFound(_) | EngineError::NoPassword(_) => {
                IpcError::not_found(e.to_string())
            }
            EngineError::Keychain(_) => IpcError::internal(e.to_string()),
        }
    }
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

#[inline]
fn timing_enabled() -> bool {
    std::env::var("DBARK_TIMING").as_deref() == Ok("1")
}

#[inline]
fn mark(t0: Instant, label: &str) {
    if timing_enabled() {
        // eprintln goes to stderr; the harness captures it.
        eprintln!(
            "[timing] {:>28}  +{:>7.1} ms",
            label,
            t0.elapsed().as_secs_f64() * 1000.0
        );
    }
}

fn verify_dll(path: &str, expected_hex: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read {path}: {e}"))?;
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

/// Resolve a logical native component (e.g. `QueryExecutor`) to the exact file
/// name that was staged and hashed at build time, by reading the build-generated
/// `DLL_HASHES` manifest. The loader and the startup integrity check therefore
/// share ONE source of truth for the file name — including its per-platform
/// extension (`.dll` / `.dylib` / `.so`) and any unix `lib` prefix — so the two
/// can never disagree.
///
/// Code audit H-4: the loaders previously hard-coded `QueryExecutor.dll`, which
/// could not load the `QueryExecutor.dylib` the macOS build actually stages and
/// verifies — silently breaking the cross-platform claim. Pure inner helper kept
/// separate from the global manifest so it is unit-testable with a fixture and no
/// harness (AGENTS.md: regression tests required where no complex harness is needed).
fn resolve_native_file<'a>(manifest: &[(&'a str, &str)], base: &str) -> Option<&'a str> {
    manifest.iter().map(|(file, _)| *file).find(|file| {
        let stem = std::path::Path::new(file)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        stem == base || stem.strip_prefix("lib") == Some(base)
    })
}

fn native_file_for(base: &str) -> Option<&'static str> {
    resolve_native_file(DLL_HASHES, base)
}

/// Load a native component by base name, routing every failure through
/// `report_fatal` so a load problem yields a named dialog + log line and a clean
/// exit — instead of panicking out of a lazy `OnceLock::get_or_init`, which left
/// the user with an opaque crash (code audit H-4: load-path `.expect()`s).
///
/// The startup integrity check in `main` has already verified the *bytes* of every
/// component before any loader runs, so reaching here with a load (not hash)
/// failure means a missing transitive dependency — e.g. the VC++ runtime DuckDB
/// needs, or a missing ODBC driver — which the dialog now names, instead of
/// vanishing silently in a `windows_subsystem` release build.
fn load_native(base: &str) -> libloading::Library {
    let file = native_file_for(base).unwrap_or_else(|| {
        fatal::report_fatal(
            "Native library load",
            format!(
                "No staged file for component `{base}` in the build manifest — \
                 this install is incomplete. Reinstall DbArk."
            ),
        )
    });
    let path = native_path(file);
    // SAFETY: `file` is a build-staged native whose SHA-256 was verified at startup
    // before any load is attempted.
    unsafe {
        libloading::Library::new(&path).unwrap_or_else(|e| {
            fatal::report_fatal(
                "Native library load",
                format!("Could not load {file}\n  path: {path}\n  {e}"),
            )
        })
    }
}

#[cfg(test)]
mod native_resolve_tests {
    use super::resolve_native_file;

    // Fixtures mirror what build.rs emits into DLL_HASHES per platform; the hash
    // column is irrelevant to name resolution, so the values are placeholders.
    const WIN: &[(&str, &str)] = &[("QueryExecutor.dll", "h"), ("sqlcipher.dll", "h")];
    const MAC: &[(&str, &str)] = &[("QueryExecutor.dylib", "h"), ("sqlcipher.dylib", "h")];
    const LIN: &[(&str, &str)] = &[("libQueryExecutor.so", "h"), ("libsqlcipher.so", "h")];

    #[test]
    fn resolves_windows_dll() {
        assert_eq!(
            resolve_native_file(WIN, "QueryExecutor"),
            Some("QueryExecutor.dll")
        );
    }

    #[test]
    fn resolves_macos_dylib() {
        assert_eq!(
            resolve_native_file(MAC, "QueryExecutor"),
            Some("QueryExecutor.dylib")
        );
    }

    #[test]
    fn resolves_linux_lib_prefixed_so() {
        // The exact case the hard-coded `.dll` loader (audit H-4) could never satisfy.
        assert_eq!(
            resolve_native_file(LIN, "QueryExecutor"),
            Some("libQueryExecutor.so")
        );
    }

    #[test]
    fn unknown_component_is_none() {
        assert_eq!(resolve_native_file(WIN, "DoesNotExist"), None);
    }

    #[test]
    fn does_not_partial_match_a_longer_name() {
        // `Query` must not resolve to `QueryExecutor.dll`.
        assert_eq!(resolve_native_file(WIN, "Query"), None);
    }
}

static SSH_TUNNEL: OnceLock<libloading::Library> = OnceLock::new();
static QUERY_EXECUTOR: OnceLock<libloading::Library> = OnceLock::new();
static CONNECTION_MANAGER: OnceLock<libloading::Library> = OnceLock::new();
static FILE_QUERY_ENGINE: OnceLock<libloading::Library> = OnceLock::new();
static SCHEMA_EXPLORER: OnceLock<libloading::Library> = OnceLock::new();
static QUERY_HISTORY: OnceLock<libloading::Library> = OnceLock::new();

fn get_query_executor() -> &'static libloading::Library {
    QUERY_EXECUTOR.get_or_init(|| load_native("QueryExecutor"))
}

fn get_connection_manager() -> &'static libloading::Library {
    CONNECTION_MANAGER.get_or_init(|| load_native("ConnectionManager"))
}

fn get_file_query_engine() -> &'static libloading::Library {
    FILE_QUERY_ENGINE.get_or_init(|| load_native("FileQueryEngine"))
}

fn get_schema_explorer() -> &'static libloading::Library {
    SCHEMA_EXPLORER.get_or_init(|| load_native("SchemaExplorer"))
}

fn get_query_history() -> &'static libloading::Library {
    QUERY_HISTORY.get_or_init(|| load_native("QueryHistory"))
}

fn get_ssh_tunnel() -> &'static libloading::Library {
    SSH_TUNNEL.get_or_init(|| load_native("SshTunnel"))
}

static SQLCIPHER: OnceLock<libloading::Library> = OnceLock::new();

fn get_sqlcipher() -> &'static libloading::Library {
    SQLCIPHER.get_or_init(|| load_native("sqlcipher"))
}

#[tauri::command]
async fn execute_query(
    connection_string: String,
    sql: String,
    engine: String,
    read_only: Option<bool>,
    row_limit: Option<u32>,
) -> Result<String, IpcError> {
    let connection_string = Zeroizing::new(connection_string);
    // Row cap from the user's resultRowLimit setting; the C# side clamps a
    // zero/garbage value to its own default.
    let result = call_execute_query(
        connection_string.as_str(),
        &sql,
        &engine,
        read_only.unwrap_or(false),
        row_limit.unwrap_or(10_000),
    );
    result
}

#[tauri::command]
fn list_connections(folder_path: String) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_connection_manager().get(b"list_connections").map_err(|e| IpcError::native(format!("Native export `list_connections` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_path = CString::new(folder_path).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("Connection manager returned no response"))
        } else {
            Ok(read_and_free(get_connection_manager(), ptr))
        }
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
                    return Err(IpcError::validation(
                        "Group name must be 50 characters or fewer",
                    ));
                }
                if !group
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == ' ' || c == '-')
                {
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
            get_connection_manager().get(b"save_connection").map_err(|e| IpcError::native(format!("Native export `save_connection` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_req = CString::new(request_json).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
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
            get_connection_manager().get(b"delete_connection").map_err(|e| IpcError::native(format!("Native export `delete_connection` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_path = CString::new(file_path).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        func(c_path.as_ptr())
    };
    if rc == 1 {
        Ok(())
    } else {
        Err(IpcError::native("Failed to delete connection file"))
    }
}

#[tauri::command]
fn store_credential(target: String, username: String, password: String) -> Result<(), IpcError> {
    let entry = keyring::Entry::new(&target, &username)
        .map_err(|e| IpcError::native(format!("Keychain unavailable: {e}")))?;
    entry
        .set_password(&password)
        .map_err(|e| IpcError::native(format!("Failed to store credential: {e}")))
}

#[tauri::command]
fn delete_credential(target: String) -> Result<(), IpcError> {
    let username = target.split(':').nth(2).unwrap_or("").to_string();
    let entry = keyring::Entry::new(&target, &username)
        .map_err(|e| IpcError::native(format!("Keychain unavailable: {e}")))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        // Deleting a credential that isn't there is a no-op success, not a
        // failure. Many connections legitimately have no stored secret (SQLite,
        // Windows-auth, password-less, or DBeaver-imported without a password),
        // so treating NoEntry as an error stranded their deletion in the UI.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(IpcError::native(format!(
            "Failed to delete credential: {e}"
        ))),
    }
}

#[tauri::command]
fn build_connection_string(params: ConnectionParams) -> Result<String, IpcError> {
    let (_, conn_str) = engine::resolve(&params, ConnOptions::default())?;
    Ok(conn_str.to_string())
}

#[tauri::command]
async fn query_file(file_path: String, sql: String) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"query_file").map_err(|e| IpcError::native(format!("Native export `query_file` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_path = CString::new(file_path).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_sql = CString::new(sql).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(c_path.as_ptr(), c_sql.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("File query engine returned no response"))
        } else {
            Ok(read_and_free(get_file_query_engine(), ptr))
        }
    }
}

#[tauri::command]
async fn get_file_schema(file_path: String) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_file_query_engine().get(b"get_file_schema").map_err(|e| IpcError::native(format!("Native export `get_file_schema` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_path = CString::new(file_path).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("File query engine returned no response"))
        } else {
            Ok(read_and_free(get_file_query_engine(), ptr))
        }
    }
}

#[tauri::command]
async fn list_db_tables(params: ConnectionParams) -> Result<String, IpcError> {
    let (engine, connection_string) = engine::resolve(&params, ConnOptions::default())?;
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"ListTables").map_err(|e| IpcError::native(format!("Native export `ListTables` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let cs = CString::new(connection_string.as_str()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let eng = CString::new(engine.name()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_file_query_engine(), ptr))
    };
    result
}

#[tauri::command]
async fn query_file_with_db(
    params: ConnectionParams,
    file_path: String,
    sql: String,
    table_names: String,
) -> Result<String, IpcError> {
    let (engine, connection_string) = engine::resolve(&params, ConnOptions::default())?;
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, *const c_char,
            *const c_char, *const c_char,
        ) -> *const c_char> = get_file_query_engine().get(b"QueryFileWithDb").map_err(|e| IpcError::native(format!("Native export `QueryFileWithDb` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let strings = (
            CString::new(file_path).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(sql).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(connection_string.as_str()).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(engine.name()).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(table_names).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
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
    };
    result
}

#[tauri::command]
async fn get_schema(params: ConnectionParams) -> Result<String, IpcError> {
    let (engine, connection_string) = engine::resolve(&params, ConnOptions::default())?;

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_schema_explorer()
            .get(b"get_schema")
            .map_err(|e| IpcError::native(format!("Native export `get_schema` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let cs = CString::new(connection_string.as_str()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let eng = CString::new(engine.name()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_schema_explorer(), ptr))
    };

    result
}

// Enumerate the databases hosted on a server/cluster for one saved connection.
// Mirrors get_schema's connection-string construction exactly (same credential
// fetch, same SSH-tunnel handling, same per-engine string) and then calls the
// schema-explorer DLL's `list_databases` export instead of `get_schema`. The
// frontend calls this once when a connection is selected to populate the
// database list, then calls get_schema(database = <chosen db>) on expand.
#[tauri::command]
async fn list_databases(params: ConnectionParams) -> Result<String, IpcError> {
    let engine = Engine::parse(&params.engine)?;
    let is_sqlite = engine == Engine::Sqlite;

    // SQLite has no databases-on-a-server concept — short-circuit with an empty
    // list so the frontend renders tables directly with no database layer.
    if is_sqlite {
        return Ok("{\"databases\":[]}".to_string());
    }

    let (_, connection_string) = engine::resolve(&params, ConnOptions::default())?;

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_schema_explorer()
            .get(b"list_databases")
            .map_err(|e| IpcError::native(format!("Native export `list_databases` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let cs = CString::new(connection_string.as_str()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let eng = CString::new(engine.name()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(cs.as_ptr(), eng.as_ptr());
        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        Ok(read_and_free(get_schema_explorer(), ptr))
    };

    result
}

#[tauri::command]
async fn add_history_entry(
    connection_id: String,
    connection_name: String,
    sql: String,
    executed_at: i64,
    duration_ms: i32,
    row_count: i32,
    success: bool,
) -> Result<(), IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_query_history().get(b"add_history_entry").map_err(|e| IpcError::native(format!("Native export `add_history_entry` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let json = format!(
            r#"{{"connectionId":"{}","connectionName":"{}","sql":"{}","executedAt":{},"durationMs":{},"rowCount":{},"success":{}}}"#,
            connection_id.replace('"', "\\\""),
            connection_name.replace('"', "\\\""),
            sql.replace('"', "\\\"")
                .replace('\n', "\\n")
                .replace('\r', ""),
            executed_at,
            duration_ms,
            row_count,
            success
        );
        // Interior NUL in the history JSON is pathological — report it instead
        // of silently skipping the write.
        let c_json = CString::new(json).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        if func(c_json.as_ptr()) == 1 {
            Ok(())
        } else {
            Err(IpcError::native("Query history write failed"))
        }
    }
}

#[tauri::command]
async fn get_history(connection_id: String, limit: i32) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char, i32) -> *const c_char> =
            get_query_history().get(b"get_history").map_err(|e| IpcError::native(format!("Native export `get_history` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_id = CString::new(connection_id).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(c_id.as_ptr(), limit);
        if ptr.is_null() {
            Err(IpcError::native("Query history returned no response"))
        } else {
            Ok(read_and_free(get_query_history(), ptr))
        }
    }
}

#[tauri::command]
async fn clear_history(connection_id: String) -> Result<(), IpcError> {
    let rc = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_query_history().get(b"clear_history").map_err(|e| IpcError::native(format!("Native export `clear_history` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_id = CString::new(connection_id).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        func(c_id.as_ptr())
    };
    if rc == 1 {
        Ok(())
    } else {
        Err(IpcError::native("Failed to clear query history"))
    }
}

#[tauri::command]
async fn test_connection(params: ConnectionParams) -> Result<String, IpcError> {
    let (engine, conn_str) = engine::resolve(
        &params,
        ConnOptions {
            connect_timeout_secs: Some(5),
        },
    )?;

    // Run a minimal test query
    let test_sql = "SELECT 1";

    let result = call_execute_query(conn_str.as_str(), test_sql, engine.name(), false, 1)?;

    let parsed: serde_json::Value =
        serde_json::from_str(&result).unwrap_or(serde_json::Value::Null);

    if let Some(err) = parsed.get("error").and_then(|e| e.as_str()) {
        Err(IpcError::native(err.to_string()))
    } else {
        Ok("Connected successfully".to_string())
    }
}

#[tauri::command]
fn migrate_credential(
    old_target: String,
    new_target: String,
    username: String,
) -> Result<bool, IpcError> {
    // A missing OLD credential is not an error — there is simply nothing to
    // migrate (Ok(false)). Only a failed write to the NEW entry is a real
    // failure, because it would strand the user's password under the old ref.
    let old_entry = match keyring::Entry::new(&old_target, &username) {
        Ok(e) => e,
        Err(_) => return Ok(false),
    };
    let password = match old_entry.get_password() {
        Ok(p) => p,
        Err(_) => return Ok(false), // no old credential — nothing to migrate
    };

    // Write to new entry
    let new_entry = keyring::Entry::new(&new_target, &username)
        .map_err(|e| IpcError::native(format!("Keychain error: {e}")))?;
    new_entry.set_password(&password).map_err(|e| {
        IpcError::native(format!(
            "Could not write credential '{new_target}' to the OS keychain: {e}"
        ))
    })?;

    // Delete old entry (best-effort — a leftover old entry is harmless)
    let _ = old_entry.delete_password();
    Ok(true)
}

/// The application's per-user data directory: `~/.dbark`.
/// Single source of truth — every settings/queries/audit/history path derives
/// from here so the workspace location can never drift between call sites again.
pub(crate) fn dbark_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".dbark")
}

#[tauri::command]
async fn open_tunnel(params: TunnelParams) -> Result<i32, IpcError> {
    let TunnelParams {
        tunnel_id,
        ssh_host,
        ssh_port,
        ssh_user,
        ssh_key_path,
        ssh_password,
        db_host,
        db_port,
    } = params;

    // ── SSH key path validation ──────────────────────────────────────────────
    // Only validate if a key path was actually provided (password-only auth
    // is valid too)
    if !ssh_key_path.is_empty() {
        let key_path = std::path::Path::new(&ssh_key_path);

        // 1. Must exist
        if !key_path.exists() {
            return Err(IpcError::validation(format!(
                "SSH key file not found: {}",
                ssh_key_path
            )));
        }

        // 2. Must be a file, not a directory
        if !key_path.is_file() {
            return Err(IpcError::validation(
                "SSH key path must point to a file, not a directory",
            ));
        }

        // 3. Extension must be .pem, .key, or .ppk
        let valid_extensions = ["pem", "key", "ppk"];
        let ext = key_path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        if !valid_extensions.contains(&ext.as_str()) {
            return Err(IpcError::validation(format!(
                "Invalid SSH key file type '.{}' — must be .pem, .key, or .ppk",
                ext
            )));
        }

        // 4. Must be within the user's home directory or a standard SSH location
        // This prevents a crafted TOML from pointing the key path at an
        // arbitrary sensitive file (e.g. /etc/passwd) that SSH.NET would
        // read and potentially expose in error messages
        let home = dirs::home_dir().unwrap_or_default();
        let canonical_key = key_path
            .canonicalize()
            .map_err(|e| format!("Cannot resolve SSH key path: {}", e))?;
        let canonical_home = home.canonicalize().unwrap_or(home.clone());

        let in_home = canonical_key.starts_with(&canonical_home);
        let in_ssh_dir = canonical_key.starts_with("/etc/ssh")   // Linux system keys
                      || canonical_key.starts_with("C:\\ProgramData\\ssh"); // Windows

        if !in_home && !in_ssh_dir {
            return Err(IpcError::validation(format!(
                "SSH key must be within your home directory or a standard SSH location. Got: {}",
                ssh_key_path
            )));
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
            .map_err(|e| IpcError::native(format!("Native export `open_tunnel` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;

        let strings = (
            CString::new(tunnel_id).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(ssh_host).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(ssh_user).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(ssh_key_path).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(ssh_password).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
            CString::new(db_host).map_err(|_| {
                IpcError::validation(
                    "input contains a NUL byte and cannot be passed to the native layer",
                )
            })?,
        );

        let ptr = func(
            strings.0.as_ptr(),
            strings.1.as_ptr(),
            ssh_port,
            strings.2.as_ptr(),
            strings.3.as_ptr(),
            strings.4.as_ptr(),
            strings.5.as_ptr(),
            db_port,
        );

        if ptr.is_null() {
            return Err(IpcError::native("null response"));
        }
        let json = read_and_free(get_ssh_tunnel(), ptr);

        let val: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;

        if let Some(err) = val.get("error").and_then(|e| e.as_str()) {
            if !err.is_empty() && err != "null" {
                return Err(IpcError::native(err.to_string()));
            }
        }

        val.get("localPort")
            .and_then(|p| p.as_i64())
            .map(|p| p as i32)
            .ok_or_else(|| IpcError::native("No local port in response"))
    }
}

#[tauri::command]
fn close_tunnel(tunnel_id: String) {
    unsafe {
        if let Ok(func) =
            get_ssh_tunnel().get::<unsafe extern "C" fn(*const c_char)>(b"close_tunnel")
        {
            if let Ok(c_id) = CString::new(tunnel_id) {
                func(c_id.as_ptr());
            }
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
        let c_id = match CString::new(tunnel_id) {
            Ok(c) => c,
            Err(_) => return false,
        };
        func(c_id.as_ptr()) == 1
    }
}

#[tauri::command]
fn get_ssh_password(target: String, username: String) -> Result<String, IpcError> {
    let entry = keyring::Entry::new(&target, &username).map_err(|e| e.to_string())?;
    entry
        .get_password()
        .map_err(|e| IpcError::native(e.to_string()))
}

#[tauri::command]
async fn export_results(
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

#[tauri::command]
fn append_audit_log(
    connection_name: String,
    engine: String,
    sql: String,
    row_count: i32,
    duration_ms: i32,
    success: bool,
) -> Result<(), IpcError> {
    use std::io::Write;

    let home: std::path::PathBuf = dirs::home_dir()
        .ok_or_else(|| IpcError::io("Cannot resolve the home directory for the audit log"))?;

    let log_path = home.join(".dbark").join("audit.log");

    let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let status = if success { "SUCCESS" } else { "ERROR" };
    let scrubbed = scrub_sql_for_log(&sql);

    let entry = format!(
        "[{}] {} | {} | {} | {}ms | {} rows | {}\n",
        timestamp, status, connection_name, engine, duration_ms, row_count, scrubbed
    );

    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| IpcError::io(format!("Cannot open audit log: {e}")))?;

    file.write_all(entry.as_bytes())
        .map_err(|e| IpcError::io(format!("Cannot write audit log: {e}")))
}

#[tauri::command]
async fn get_object_definition(
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

        let conn_str = engine::build_sqlite_conn(&params.database);

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

    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
            *const c_char, *const c_char,
            *const c_char,
        ) -> *const c_char> = get_schema_explorer()
            .get(b"get_object_definition")
            .map_err(|e| IpcError::native(format!("Native export `get_object_definition` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;

        let c_conn = CString::new(conn_str.as_str()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_engine = CString::new(engine.name()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_name = CString::new(object_name).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_type = CString::new(object_type).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_schema = CString::new(schema).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;

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
    };

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
                            + 1
                            + end_quote
                            + 1;
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
async fn get_sqlite_objects(database: String) -> Result<String, IpcError> {
    let conn_str = engine::build_sqlite_conn(&database);

    // Single query fetches all programmable objects at once
    let sql = "SELECT type, name, tbl_name \
               FROM sqlite_master \
               WHERE type IN ('view','trigger','index') \
               AND name NOT LIKE 'sqlite_%' \
               ORDER BY type, name";

    // Row cap: sqlite_master listings are small, but leave generous headroom
    // for pathological schemas rather than silently truncating the tree.
    let raw = call_execute_query(conn_str.as_str(), sql, "sqlite", true, 100_000)?;

    Ok(raw)
}

#[tauri::command]
async fn drop_object(
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

    let result = call_execute_query(
        conn_str.as_str(),
        drop_sql.as_str(),
        engine.name(),
        false,
        1,
    );

    result
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct AppSettings {
    query_timeout_secs: u32,
    lock_timeout_mins: u32, // 0 = disabled
    result_row_limit: u32,
    history_retention_days: u32, // 0 = forever
    result_clear_mins: u32,      // 0 = never
    audit_log_enabled: bool,
    clipboard_clear_enabled: bool,
    clipboard_clear_secs: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            query_timeout_secs: 30,
            lock_timeout_mins: 15,
            result_row_limit: 10_000,
            history_retention_days: 90,
            result_clear_mins: 5,
            audit_log_enabled: false,
            clipboard_clear_enabled: true,
            clipboard_clear_secs: 60,
        }
    }
}

fn settings_path() -> std::path::PathBuf {
    dbark_dir().join("settings.toml")
}

#[tauri::command]
fn load_settings() -> Result<String, IpcError> {
    let path = settings_path();
    if !path.exists() {
        let defaults = AppSettings::default();
        return Ok(serde_json::to_string(&defaults).unwrap_or_default());
    }
    let contents = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let settings: AppSettings = toml::from_str(&contents).unwrap_or_default();
    Ok(serde_json::to_string(&settings).unwrap_or_default())
}

#[tauri::command]
fn save_settings(settings_json: String) -> Result<(), IpcError> {
    let settings: AppSettings = serde_json::from_str(&settings_json).map_err(|e| e.to_string())?;
    let toml_str = toml::to_string(&settings).map_err(|e| e.to_string())?;
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
    name: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
    engine_hint: Option<String>, // e.g. "postgres" — just a hint, not enforced
    created_at: String,          // ISO 8601
    updated_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SavedQuery {
    id: String, // stem of the filename, e.g. "my-query"
    sql: String,
    meta: SavedQueryMeta,
}

fn queries_dir() -> std::path::PathBuf {
    dbark_dir().join("queries")
}

#[tauri::command]
async fn save_query(id: String, sql: String, meta_json: String) -> Result<(), IpcError> {
    let dir = queries_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    // Sanitise id — alphanumeric, hyphens, underscores only
    let safe_id: String = id
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if safe_id.is_empty() {
        return Err(IpcError::validation("Query name cannot be empty"));
    }

    let mut meta: SavedQueryMeta = serde_json::from_str(&meta_json).map_err(|e| e.to_string())?;
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
async fn list_queries() -> Result<String, IpcError> {
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

        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();

        let sql = std::fs::read_to_string(&path).unwrap_or_default();

        let meta_path = dir.join(format!("{}.meta.toml", id));
        let meta: SavedQueryMeta = if meta_path.exists() {
            let raw = std::fs::read_to_string(&meta_path).unwrap_or_default();
            toml::from_str(&raw).unwrap_or_else(|_| SavedQueryMeta {
                name: id.clone(),
                description: None,
                tags: None,
                engine_hint: None,
                created_at: String::new(),
                updated_at: String::new(),
            })
        } else {
            SavedQueryMeta {
                name: id.clone(),
                description: None,
                tags: None,
                engine_hint: None,
                created_at: String::new(),
                updated_at: String::new(),
            }
        };

        queries.push(SavedQuery { id, sql, meta });
    }

    // Sort by updated_at descending (most recently saved first)
    queries.sort_by(|a, b| b.meta.updated_at.cmp(&a.meta.updated_at));

    serde_json::to_string(&queries).map_err(|e| IpcError::internal(e.to_string()))
}

#[tauri::command]
async fn delete_query(id: String) -> Result<(), IpcError> {
    let dir = queries_dir();
    let sql_path = dir.join(format!("{}.sql", id));
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
async fn load_query(id: String) -> Result<String, IpcError> {
    let path = queries_dir().join(format!("{}.sql", id));
    std::fs::read_to_string(&path).map_err(|e| IpcError::io(e.to_string()))
}

// ── DBeaver Import ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
struct DbeaverImportResult {
    imported: Vec<DbeaverImportedConnection>,
    skipped: Vec<String>,
    error: Option<String>,
}

#[derive(serde::Serialize)]
struct DbeaverImportedConnection {
    name: String,
    engine: String,
    host: String,
    port: u16,
    database: String,
    username: String,
    password: String, // returned to frontend to store in keychain; blank if not stored
    ssl_mode: String, // "none" | "prefer" | "require" | "verify-full"
    read_only: bool,
    ssh_enabled: bool,
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
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
        "require" | "required" => "require",
        "verify-full" | "verify_full" => "verify-full",
        _ => "prefer",
    }
}

#[tauri::command]
fn import_dbeaver_connections() -> Result<String, IpcError> {
    let path = match dirs::home_dir() {
        Some(h) => h.join(".dbeaver").join("data-sources.json"),
        None => return Err(IpcError::internal("Could not determine home directory")),
    };

    if !path.exists() {
        return Err(IpcError::not_found(format!(
            "DBeaver config not found at {}. Is DBeaver installed?",
            path.display()
        )));
    }

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            return Err(IpcError::io(format!(
                "Failed to read DBeaver config: {}",
                e
            )))
        }
    };

    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            return Err(IpcError::internal(format!(
                "Failed to parse DBeaver config: {}",
                e
            )))
        }
    };

    let mut imported = Vec::new();
    let mut skipped = Vec::new();

    let connections = match json.get("connections").and_then(|c| c.as_object()) {
        Some(c) => c,
        None => return Err(IpcError::internal("No connections found in DBeaver config")),
    };

    for (_id, conn) in connections {
        let name = conn
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Unnamed")
            .to_string();

        // DBeaver uses `provider` + `driver` together to identify the engine.
        // `provider` alone is not enough — both MySQL and MariaDB share
        // provider=mysql, and both Postgres and CockroachDB share
        // provider=postgresql. Always check `driver` first.
        let provider = conn
            .get("provider")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let driver = conn
            .get("driver")
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
                p if p.contains("mysql") => "mysql",
                p if p.contains("postgresql") => "postgres",
                p if p.contains("sqlite") => "sqlite",
                p if p.contains("sqlserver") || p.contains("mssql") => "sqlserver",
                _ => {
                    skipped.push(format!(
                        "{} (unsupported provider: {}, driver: {})",
                        name, provider, driver
                    ));
                    continue;
                }
            }
        };

        let config = match conn.get("configuration") {
            Some(c) => c,
            None => {
                skipped.push(format!("{} (no configuration)", name));
                continue;
            }
        };

        let host = config
            .get("host")
            .and_then(|v| v.as_str())
            .unwrap_or("localhost")
            .to_string();

        // Treat empty database as absent rather than passing "" to the driver
        let database = config
            .get("database")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let default_port: u16 = Engine::parse(engine).map(Engine::default_port).unwrap_or(0);
        let port: u16 = config
            .get("port")
            .and_then(|v| v.as_str())
            .and_then(|s| s.parse().ok())
            .or_else(|| {
                config
                    .get("port")
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u16)
            })
            .unwrap_or(default_port);

        // Credentials: DBeaver stores user/password directly under `configuration`,
        // not under a nested `credentials` block.
        let username = config
            .get("user")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let raw_password = config
            .get("password")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let password = strip_dbeaver_password(raw_password);

        // SSL mode — read from configuration.properties.sslmode (Postgres/CockroachDB)
        // or configuration.properties.useSSL (MySQL/MariaDB dialect).
        let props = config.get("properties");
        let ssl_mode = props
            .and_then(|p| p.get("sslmode"))
            .and_then(|v| v.as_str())
            .or_else(|| props.and_then(|p| p.get("useSSL")).and_then(|v| v.as_str()))
            .map(map_ssl_mode)
            .unwrap_or("prefer")
            .to_string();

        // read-only flag
        let read_only = config
            .get("read-only")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // SSH tunnel
        let (ssh_enabled, ssh_host, ssh_port, ssh_user, ssh_key_path) =
            if let Some(tunnel) = config.get("tunnel-configuration") {
                let t_type = tunnel.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if t_type == "SSH_TUNNEL" {
                    let t_host = tunnel
                        .get("host")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let t_port = tunnel
                        .get("port")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse().ok())
                        .or_else(|| {
                            tunnel
                                .get("port")
                                .and_then(|v| v.as_u64())
                                .map(|n| n as u16)
                        })
                        .unwrap_or(22);
                    let t_user = tunnel
                        .get("user")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
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

    Ok(serde_json::to_string(&DbeaverImportResult {
        imported,
        skipped,
        error: None,
    })
    .unwrap())
}

// Two new Tauri commands for the Activity panel.
// Both follow the existing execute_query pattern:
//   - connection_string wrapped in a Zeroizing guard (scrubbed on every exit path)
//   - libloading::Symbol resolves the C# entry point
//   - C-string round-trip across the FFI boundary
//   - Null-pointer guard returns a JSON error envelope
//   - the Zeroizing guard zeroes the connection string from memory on drop

// ── get_activity ─────────────────────────────────────────────────────────────
#[tauri::command]
async fn get_activity(connection_string: String, engine: String) -> Result<String, IpcError> {
    let connection_string = Zeroizing::new(connection_string);
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"get_activity")
            .map_err(|e| IpcError::native(format!("Native export `get_activity` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_conn = CString::new(connection_string.as_str()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_engine = CString::new(engine).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(c_conn.as_ptr(), c_engine.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("Query executor returned no response"))
        } else {
            Ok(read_and_free(get_query_executor(), ptr))
        }
    };
    result
}

// ── kill_session ─────────────────────────────────────────────────────────────
#[tauri::command]
async fn kill_session(
    connection_string: String,
    engine: String,
    pid: String,
) -> Result<String, IpcError> {
    let connection_string = Zeroizing::new(connection_string);
    let result = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(
            *const c_char, *const c_char, *const c_char,
        ) -> *const c_char> = get_query_executor()
            .get(b"kill_session")
            .map_err(|e| IpcError::native(format!("Native export `kill_session` is unavailable — your DbArk install may be corrupt; reinstall. ({e})")))?;
        let c_conn = CString::new(connection_string.as_str()).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_engine = CString::new(engine).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let c_pid = CString::new(pid).map_err(|_| {
            IpcError::validation(
                "input contains a NUL byte and cannot be passed to the native layer",
            )
        })?;
        let ptr = func(c_conn.as_ptr(), c_engine.as_ptr(), c_pid.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("Query executor returned no response"))
        } else {
            Ok(read_and_free(get_query_executor(), ptr))
        }
    };
    result
}

#[tauri::command]
fn log_ready_time(ms: u32) {
    if std::env::var("DBARK_TIMING").as_deref() == Ok("1") {
        eprintln!(
            "[timing] {:>28}  ready at +{} ms (webview clock)",
            "FRONTEND READY", ms
        );
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
        if let Ok(func) =
            get_query_history().get::<unsafe extern "C" fn(*const c_char)>(b"init_history_key")
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
            log_ready_time
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| fatal::report_fatal("Tauri runtime", e));
}
