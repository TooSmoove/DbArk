// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Wiring only: module declarations, the startup sequence, and the
//! `invoke_handler` registration. Command implementations live in
//! `commands/*`; native loading in `natives.rs`; the error envelope in
//! `ipc.rs`; engine identity/policy in `engine.rs` + `conn_string.rs`.

mod commands;
mod conn_string;
mod engine;
mod fatal;
mod ipc;
mod natives;

use std::ffi::CString;
use std::time::Instant;

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
    natives::verify_startup_integrity();

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
        if let Ok(func) = natives::get_query_history()
            .get::<unsafe extern "C" fn(*const std::ffi::c_char)>(b"init_history_key")
        {
            let c_key = CString::new(history_key).unwrap_or_default();
            func(c_key.as_ptr());
        }
    }

    mark(t0, "history key init done");

    natives::preload_all();
    mark(t0, "DLL preload done");

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::query::execute_query,
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::credentials::store_credential,
            commands::credentials::delete_credential,
            commands::connections::build_connection_string,
            commands::query::query_file,
            commands::query::get_file_schema,
            commands::query::list_db_tables,
            commands::query::query_file_with_db,
            commands::schema::get_schema,
            commands::schema::list_databases,
            commands::history::add_history_entry,
            commands::history::get_history,
            commands::history::clear_history,
            commands::connections::test_connection,
            commands::credentials::migrate_credential,
            commands::query::export_results,
            commands::tunnel::open_tunnel,
            commands::tunnel::close_tunnel,
            commands::tunnel::is_tunnel_open,
            commands::credentials::get_ssh_password,
            commands::history::append_audit_log,
            commands::schema::get_object_definition,
            commands::schema::get_sqlite_objects,
            commands::schema::drop_object,
            commands::history::load_settings,
            commands::history::save_settings,
            commands::history::save_query,
            commands::history::list_queries,
            commands::history::delete_query,
            commands::history::load_query,
            commands::connections::import_dbeaver_connections,
            commands::activity::get_activity,
            commands::activity::kill_session,
            commands::activity::log_ready_time
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| fatal::report_fatal("Tauri runtime", e));
}
