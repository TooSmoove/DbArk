//! Cross-module integration tests for the Rust host.
//!
//! The per-module `#[cfg(test)]` suites (in `engine.rs`, `conn_string.rs`,
//! `ipc.rs`, `natives.rs`) each pin one unit in isolation. This module instead
//! wires the modules together along the exact path a database command travels
//! *before* it reaches the native layer:
//!
//! ```text
//!   wire engine string ──▶ engine::Engine::parse
//!                     ──▶ Engine::connection_string (conn_string builders + escaping)
//!                     ──▶ natives::to_cstring        (FFI boundary)
//!   engine/parse errors ─▶ ipc::IpcError            (the envelope the frontend sees)
//! ```
//!
//! A regression in any one module that only shows up in combination — an engine
//! that stops escaping its password, an error that maps to the wrong IPC code,
//! an identifier that breaks out of its quotes — fails here even when the
//! isolated unit tests still pass. The crate is a `cdylib`, so these live as an
//! in-crate `#[cfg(test)]` module (the project's established pattern) rather than
//! as a `tests/` integration crate, which a cdylib cannot link against.

#![cfg(test)]

use crate::conn_string::ConnArgs;
use crate::engine::{Engine, EngineError};
use crate::ipc::{IpcError, IpcErrorCode};

/// Every engine the host speaks, paired with its canonical wire name.
const WIRE_NAMES: &[&str] = &["sqlserver", "postgres", "cockroachdb", "mysql", "mariadb", "sqlite"];

fn conn_args<'a>(database: &'a str, username: &'a str, password: &'a str) -> ConnArgs<'a> {
    ConnArgs {
        host: "db.internal",
        port: 5432,
        instance: "",
        database,
        username,
        password,
        win_auth: false,
        ssl_mode: "prefer",
        via_tunnel: false,
        connect_timeout_secs: None,
    }
}

// ── parse ──▶ connection_string, for every engine ────────────────────────────

#[test]
fn every_wire_name_parses_and_builds_a_connection_string() {
    for name in WIRE_NAMES {
        let engine = Engine::parse(name).unwrap_or_else(|_| panic!("{name} should parse"));
        // The name must round-trip back to the canonical wire string the C#
        // layer dispatches on.
        assert_eq!(engine.name(), *name);

        let conn = engine.connection_string(&conn_args("appdb", "svc", "pw"));
        assert!(!conn.is_empty(), "{name}: empty connection string");

        // Each dialect has a recognisable shape — pin the driver-specific prefix.
        match engine {
            Engine::SqlServer => assert!(conn.contains("Driver={") && conn.contains("Database=appdb")),
            Engine::Postgres | Engine::CockroachDb => assert!(conn.starts_with("Host=db.internal;")),
            Engine::MySql | Engine::MariaDb => assert!(conn.starts_with("Server=db.internal;")),
            Engine::Sqlite => assert_eq!(conn, "Data Source=appdb"),
        }
    }
}

// ── security: password escaping survives the whole pipeline ───────────────────

#[test]
fn injected_password_is_escaped_for_every_credentialed_engine() {
    // A password with `;` `'` `"` `=` must never terminate a field or break the
    // string apart. This is the audit H-2 seam, verified through the public
    // Engine::connection_string entry point rather than the private builders.
    let nasty = r#"p;w'x"y=z"#;

    // Postgres/MySQL (ADO.NET key-value): the value is quote-enclosed.
    for name in ["postgres", "cockroachdb", "mysql", "mariadb"] {
        let conn = Engine::parse(name).unwrap().connection_string(&conn_args("db", "u", nasty));
        assert!(
            !conn.contains(&format!("={nasty};")),
            "{name}: raw injected password leaked unescaped into {conn}"
        );
        assert!(conn.contains('"'), "{name}: expected a quote-enclosed value in {conn}");
    }

    // SQL Server (ODBC): the value is brace-enclosed.
    let conn = Engine::SqlServer.connection_string(&conn_args("db", "u", nasty));
    assert!(conn.contains("PWD={"), "sqlserver: expected brace-enclosed PWD in {conn}");
}

// ── engine errors ──▶ the IPC envelope the frontend parses ───────────────────

#[test]
fn engine_errors_map_onto_the_expected_ipc_codes() {
    let cases = [
        (EngineError::Unsupported("oracle".into()), IpcErrorCode::Validation),
        (EngineError::CredentialNotFound("missing".into()), IpcErrorCode::NotFound),
        (EngineError::NoPassword("cred:1".into()), IpcErrorCode::NotFound),
        (EngineError::Keychain("locked".into()), IpcErrorCode::Internal),
    ];
    for (err, expected_code) in cases {
        let ipc: IpcError = err.into();
        assert_eq!(ipc.code, expected_code);
        assert!(!ipc.message.is_empty());
    }
}

#[test]
fn an_unknown_wire_engine_surfaces_as_a_validation_error_end_to_end() {
    // The exact path a command takes for a bad engine string: parse fails, and
    // the `?`/`.into()` bridge turns it into the wire error the UI branches on.
    let ipc: IpcError = Engine::parse("nosuchdb").unwrap_err().into();
    assert_eq!(ipc.code, IpcErrorCode::Validation);
    assert!(ipc.message.contains("Unsupported engine: nosuchdb"));

    // And it serialises to the stable shape the frontend's single parse expects.
    let json = serde_json::to_string(&ipc).unwrap();
    assert!(json.contains(r#""code":"validation""#), "got {json}");
}

// ── DROP identifier quoting is injection-safe on every dialect ────────────────

#[test]
fn drop_statement_quotes_a_hostile_object_name_on_every_engine() {
    // The object name arrives from the frontend over IPC and is untrusted
    // (audit H-1). Each engine must quote it with its own delimiter doubled so a
    // crafted name can't break out and append SQL.
    let hostile_sqlserver = "evil]; DROP TABLE users;--";
    let stmt = Engine::SqlServer
        .build_drop_statement("table", hostile_sqlserver, "dbo", "")
        .unwrap();
    assert!(stmt.contains("[evil]]; DROP TABLE users;--]"), "got {stmt}");

    let hostile_ansi = r#"evil"; DROP TABLE users;--"#;
    for name in ["postgres", "cockroachdb", "sqlite"] {
        let engine = Engine::parse(name).unwrap();
        let stmt = engine.build_drop_statement("table", hostile_ansi, "public", "").unwrap();
        // the embedded double-quote is doubled inside the quoted identifier
        assert!(stmt.contains(r#""evil""; DROP TABLE users;--""#), "{name}: got {stmt}");
    }

    let hostile_mysql = "evil`; DROP TABLE users;--";
    let stmt = Engine::MySql.build_drop_statement("table", hostile_mysql, "", "").unwrap();
    assert!(stmt.contains("`evil``; DROP TABLE users;--`"), "got {stmt}");
}

#[test]
fn drop_statement_rejects_an_unknown_object_type_instead_of_interpolating_it() {
    // An unrecognised object_type must be an error, never spliced in as a raw
    // SQL keyword.
    let err = Engine::Postgres
        .build_drop_statement("'; DROP DATABASE x;--", "t", "public", "")
        .unwrap_err();
    assert!(err.contains("Unsupported object type"), "got {err}");
}

// ── the FFI boundary rejects NUL and accepts clean strings ───────────────────

#[test]
fn connection_string_crosses_the_ffi_boundary_or_is_rejected_for_nul() {
    // A clean connection string converts to a CString for the native call.
    let good = Engine::Sqlite.connection_string(&conn_args("/data/app.db", "", ""));
    assert!(crate::natives::to_cstring(good).is_ok());

    // An interior NUL can't cross into C; it becomes the one canonical
    // validation IpcError rather than a panic or a truncated string.
    let err = crate::natives::to_cstring("Data Source=/tmp/a\0b.db").unwrap_err();
    assert_eq!(err.code, IpcErrorCode::Validation);
    assert!(err.message.contains("NUL"));
}
