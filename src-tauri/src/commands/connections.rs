//! Saved-connection CRUD, connection testing, and DBeaver import.

use std::ffi::c_char;

use crate::commands::query::call_execute_query;
use crate::engine::{self, ConnOptions, ConnectionParams, Engine};
use crate::ipc::IpcError;
use crate::natives::{get_connection_manager, missing_export, read_and_free, to_cstring};

#[tauri::command]
pub fn list_connections(folder_path: String) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> *const c_char> =
            get_connection_manager()
                .get(b"list_connections")
                .map_err(|e| missing_export("list_connections", e))?;
        let c_path = to_cstring(folder_path)?;
        let ptr = func(c_path.as_ptr());
        if ptr.is_null() {
            Err(IpcError::native("Connection manager returned no response"))
        } else {
            Ok(read_and_free(get_connection_manager(), ptr))
        }
    }
}

#[tauri::command]
pub fn save_connection(request_json: String) -> Result<(), IpcError> {
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
            get_connection_manager()
                .get(b"save_connection")
                .map_err(|e| missing_export("save_connection", e))?;
        let c_req = to_cstring(request_json)?;
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
pub fn delete_connection(file_path: String) -> Result<(), IpcError> {
    let rc = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_connection_manager()
                .get(b"delete_connection")
                .map_err(|e| missing_export("delete_connection", e))?;
        let c_path = to_cstring(file_path)?;
        func(c_path.as_ptr())
    };
    if rc == 1 {
        Ok(())
    } else {
        Err(IpcError::native("Failed to delete connection file"))
    }
}

#[tauri::command]
pub fn build_connection_string(params: ConnectionParams) -> Result<String, IpcError> {
    let (_, conn_str) = engine::resolve(&params, ConnOptions::default())?;
    Ok(conn_str.to_string())
}

#[tauri::command]
pub async fn test_connection(params: ConnectionParams) -> Result<String, IpcError> {
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
pub fn import_dbeaver_connections() -> Result<String, IpcError> {
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

#[cfg(test)]
mod dbeaver_import_tests {
    use super::{map_ssl_mode, strip_dbeaver_password};

    // Both helpers moved here from main.rs with no prior coverage; these pin
    // the DBeaver-format quirks (AGENTS.md: moved pure logic gets a focused
    // regression test in the same change).

    #[test]
    fn password_markers_are_stripped() {
        assert_eq!(strip_dbeaver_password("##secret##"), "secret");
        assert_eq!(strip_dbeaver_password("  ##secret##  "), "secret");
    }

    #[test]
    fn bare_or_empty_marker_means_no_password() {
        assert_eq!(strip_dbeaver_password("##"), "");
        assert_eq!(strip_dbeaver_password(""), "");
        assert_eq!(strip_dbeaver_password("   "), "");
    }

    #[test]
    fn unmarked_value_is_a_plaintext_password() {
        // older DBeaver versions store the password without ## markers
        assert_eq!(strip_dbeaver_password("plaintext"), "plaintext");
        // an unbalanced marker is treated as plain text, not stripped
        assert_eq!(strip_dbeaver_password("##half"), "##half");
    }

    #[test]
    fn hash_only_password_is_preserved() {
        // "####" is a 2-char password of "##"? No — len must exceed 4 to strip,
        // so "####" (len 4) falls through to the plain-text branch.
        assert_eq!(strip_dbeaver_password("####"), "####");
        assert_eq!(strip_dbeaver_password("##x##"), "x");
    }

    #[test]
    fn ssl_modes_map_onto_dbark_vocabulary() {
        for (input, expect) in [
            ("disable", "none"),
            ("DISABLED", "none"),
            ("false", "none"),
            ("none", "none"),
            ("require", "require"),
            ("Required", "require"),
            ("verify-full", "verify-full"),
            ("VERIFY_FULL", "verify-full"),
            ("prefer", "prefer"),
            ("anything-else", "prefer"),
            ("", "prefer"),
        ] {
            assert_eq!(map_ssl_mode(input), expect, "input {input:?}");
        }
    }
}
