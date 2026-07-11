//! The `~/.dbark` workspace: query history, saved-query library, settings, and
//! the audit log. Everything that touches the per-user data directory lives
//! here, deriving its path from [`dbark_dir`].

use std::ffi::c_char;

use crate::ipc::IpcError;
use crate::natives::{get_query_history, missing_export, read_and_free, to_cstring};

/// The application's per-user data directory: `~/.dbark`.
/// Single source of truth — every settings/queries/audit/history path derives
/// from here so the workspace location can never drift between call sites again.
pub(crate) fn dbark_dir() -> std::path::PathBuf {
    dirs::home_dir().unwrap_or_default().join(".dbark")
}

// ── Query history (SQLCipher state.db via the QueryHistory DLL) ─────────────

#[tauri::command]
pub async fn add_history_entry(
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
            get_query_history()
                .get(b"add_history_entry")
                .map_err(|e| missing_export("add_history_entry", e))?;
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
        let c_json = to_cstring(json)?;
        if func(c_json.as_ptr()) == 1 {
            Ok(())
        } else {
            Err(IpcError::native("Query history write failed"))
        }
    }
}

#[tauri::command]
pub async fn get_history(connection_id: String, limit: i32) -> Result<String, IpcError> {
    unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char, i32) -> *const c_char> =
            get_query_history()
                .get(b"get_history")
                .map_err(|e| missing_export("get_history", e))?;
        let c_id = to_cstring(connection_id)?;
        let ptr = func(c_id.as_ptr(), limit);
        if ptr.is_null() {
            Err(IpcError::native("Query history returned no response"))
        } else {
            Ok(read_and_free(get_query_history(), ptr))
        }
    }
}

#[tauri::command]
pub async fn clear_history(connection_id: String) -> Result<(), IpcError> {
    let rc = unsafe {
        let func: libloading::Symbol<unsafe extern "C" fn(*const c_char) -> i32> =
            get_query_history()
                .get(b"clear_history")
                .map_err(|e| missing_export("clear_history", e))?;
        let c_id = to_cstring(connection_id)?;
        func(c_id.as_ptr())
    };
    if rc == 1 {
        Ok(())
    } else {
        Err(IpcError::native("Failed to clear query history"))
    }
}

// ── Settings ─────────────────────────────────────────────────────────────────

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
pub fn load_settings() -> Result<String, IpcError> {
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
pub fn save_settings(settings_json: String) -> Result<(), IpcError> {
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
pub async fn save_query(id: String, sql: String, meta_json: String) -> Result<(), IpcError> {
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
pub async fn list_queries() -> Result<String, IpcError> {
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
pub async fn delete_query(id: String) -> Result<(), IpcError> {
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
pub async fn load_query(id: String) -> Result<String, IpcError> {
    let path = queries_dir().join(format!("{}.sql", id));
    std::fs::read_to_string(&path).map_err(|e| IpcError::io(e.to_string()))
}

// ── Audit log ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn append_audit_log(
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

fn scrub_sql_for_log(sql: &str) -> String {
    // Simple manual scrub without regex crate
    let mut result = sql.to_string();
    for keyword in &["password", "pwd", "secret", "token", "key"] {
        let mut search_from = 0;
        // Recompute the lowercase view every iteration: a replacement mutates
        // `result`, so offsets from a stale copy would index the wrong bytes
        // when the same keyword appears twice (panic or silent corruption).
        loop {
            let lower = result.to_lowercase();
            let Some(idx) = lower[search_from..].find(keyword) else {
                break;
            };
            let abs_idx = search_from + idx;
            let after_keyword = &lower[abs_idx + keyword.len()..];
            // Look for = 'value' pattern
            let trimmed = after_keyword.trim_start();
            if let Some(after_eq_raw) = trimmed.strip_prefix('=') {
                let after_eq = after_eq_raw.trim_start();
                if let Some(after_quote) = after_eq.strip_prefix('\'') {
                    if let Some(end_quote) = after_quote.find('\'') {
                        // keyword + ws-before-'=' + ('=' + ws-after-'=')
                        // + opening quote + value + closing quote.
                        // The '=' is inside (trimmed - after_eq) — counting it
                        // again overran the slice by one byte: a panic when the
                        // assignment ended the SQL, one swallowed char otherwise.
                        let full_match_len = keyword.len()
                            + (after_keyword.len() - trimmed.len())
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

#[cfg(test)]
mod audit_scrub_tests {
    use super::scrub_sql_for_log;

    // scrub_sql_for_log moved here from main.rs with no prior coverage; these
    // pin the secret-redaction behaviour the audit log depends on (AGENTS.md:
    // moved pure logic gets a focused regression test in the same change).

    #[test]
    fn quoted_secret_assignments_are_redacted() {
        assert_eq!(
            scrub_sql_for_log("SET password='hunter2'"),
            "SET password='***'"
        );
        assert_eq!(
            scrub_sql_for_log("UPDATE t SET token = 'abc123' WHERE id=1"),
            "UPDATE t SET token='***' WHERE id=1"
        );
    }

    #[test]
    fn all_sensitive_keywords_are_covered() {
        for kw in ["password", "pwd", "secret", "token", "key"] {
            let sql = format!("SET {kw}='s3cret'");
            let scrubbed = scrub_sql_for_log(&sql);
            assert!(!scrubbed.contains("s3cret"), "{kw}: got {scrubbed}");
            assert!(scrubbed.contains("'***'"), "{kw}: got {scrubbed}");
        }
    }

    #[test]
    fn non_secret_sql_passes_through() {
        let sql = "SELECT id, name FROM users WHERE active = 1";
        assert_eq!(scrub_sql_for_log(sql), sql);
    }

    #[test]
    fn unquoted_or_unassigned_keywords_are_left_alone() {
        // a column merely NAMED password, with no ='...' assignment, is not touched
        let sql = "SELECT password FROM users";
        assert_eq!(scrub_sql_for_log(sql), sql);
    }

    #[test]
    fn multiple_secrets_of_the_same_keyword_are_all_redacted() {
        // Regression: the scrubber used to index the mutated string with
        // offsets from a stale lowercase copy on the second occurrence.
        assert_eq!(
            scrub_sql_for_log("SET password='a'; SET password='b'"),
            "SET password='***'; SET password='***'"
        );
    }

    #[test]
    fn long_sql_is_truncated_with_ellipsis() {
        let long = "SELECT ".to_string() + &"x,".repeat(200);
        let scrubbed = scrub_sql_for_log(&long);
        assert!(scrubbed.chars().count() <= 201); // 200 chars + '…'
        assert!(scrubbed.ends_with('…'));
    }
}
