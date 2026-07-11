//! Activity panel commands (server session list / kill) and the frontend
//! ready-time timing hook.
//!
//! Both DB commands follow the execute_query pattern: the connection string is
//! wrapped in a `Zeroizing` guard (scrubbed on every exit path), the C# entry
//! point is resolved by symbol, strings round-trip as C strings, and a null
//! pointer maps onto the structured error channel.

use std::ffi::c_char;

use zeroize::Zeroizing;

use crate::ipc::IpcError;
use crate::natives::{get_query_executor, missing_export, read_and_free, to_cstring};

#[tauri::command]
pub async fn get_activity(connection_string: String, engine: String) -> Result<String, IpcError> {
    let connection_string = Zeroizing::new(connection_string);
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(*const c_char, *const c_char) -> *const c_char,
        > = get_query_executor()
            .get(b"get_activity")
            .map_err(|e| missing_export("get_activity", e))?;
        let c_conn = to_cstring(connection_string.as_str())?;
        let c_engine = to_cstring(engine)?;
        let ptr = func(c_conn.as_ptr(), c_engine.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("Query executor returned no response"))
        } else {
            Ok(read_and_free(get_query_executor(), ptr))
        }
    }
}

#[tauri::command]
pub async fn kill_session(
    connection_string: String,
    engine: String,
    pid: String,
) -> Result<String, IpcError> {
    let connection_string = Zeroizing::new(connection_string);
    unsafe {
        let func: libloading::Symbol<
            unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> *const c_char,
        > = get_query_executor()
            .get(b"kill_session")
            .map_err(|e| missing_export("kill_session", e))?;
        let c_conn = to_cstring(connection_string.as_str())?;
        let c_engine = to_cstring(engine)?;
        let c_pid = to_cstring(pid)?;
        let ptr = func(c_conn.as_ptr(), c_engine.as_ptr(), c_pid.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("Query executor returned no response"))
        } else {
            Ok(read_and_free(get_query_executor(), ptr))
        }
    }
}

#[tauri::command]
pub fn log_ready_time(ms: u32) {
    if std::env::var("DBARK_TIMING").as_deref() == Ok("1") {
        eprintln!(
            "[timing] {:>28}  ready at +{} ms (webview clock)",
            "FRONTEND READY", ms
        );
    }
}
