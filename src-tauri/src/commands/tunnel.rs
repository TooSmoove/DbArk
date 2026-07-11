//! SSH tunnel lifecycle (open / close / probe) via the SshTunnel DLL.

use std::ffi::c_char;

use crate::ipc::IpcError;
use crate::natives::{get_ssh_tunnel, missing_export, read_and_free, to_cstring};

/// SSH tunnel parameters for `open_tunnel` (a different shape from a DB
/// connection, so it gets its own parameter object — audit A-2).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelParams {
    tunnel_id: String,
    ssh_host: String,
    ssh_port: i32,
    ssh_user: String,
    ssh_key_path: String,
    ssh_password: String,
    db_host: String,
    db_port: i32,
}

#[tauri::command]
pub async fn open_tunnel(params: TunnelParams) -> Result<i32, IpcError> {
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
        let func: libloading::Symbol<
            unsafe extern "C" fn(
                *const c_char,
                *const c_char,
                i32,
                *const c_char,
                *const c_char,
                *const c_char,
                *const c_char,
                i32,
            ) -> *const c_char,
        > = get_ssh_tunnel()
            .get(b"open_tunnel")
            .map_err(|e| missing_export("open_tunnel", e))?;

        let strings = (
            to_cstring(tunnel_id)?,
            to_cstring(ssh_host)?,
            to_cstring(ssh_user)?,
            to_cstring(ssh_key_path)?,
            to_cstring(ssh_password)?,
            to_cstring(db_host)?,
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
pub fn close_tunnel(tunnel_id: String) {
    unsafe {
        if let Ok(func) =
            get_ssh_tunnel().get::<unsafe extern "C" fn(*const c_char)>(b"close_tunnel")
        {
            if let Ok(c_id) = std::ffi::CString::new(tunnel_id) {
                func(c_id.as_ptr());
            }
        }
    }
}

#[tauri::command]
pub fn is_tunnel_open(tunnel_id: String) -> bool {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            match get_ssh_tunnel().get(b"is_tunnel_open") {
                Ok(f) => f,
                Err(_) => return false,
            };
        let c_id = match std::ffi::CString::new(tunnel_id) {
            Ok(c) => c,
            Err(_) => return false,
        };
        func(c_id.as_ptr()) == 1
    }
}
