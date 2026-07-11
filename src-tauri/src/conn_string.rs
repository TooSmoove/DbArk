//! Per-driver connection-string construction (single source of truth — audit
//! A-3 / H-2), split out of `engine.rs` so identity/policy and string assembly
//! each stay one screenful.
//!
//! [`Engine::connection_string`] is the only public entry point commands use
//! (via `engine::resolve`); the `build_*` functions and escapes are the
//! per-dialect building blocks, each with its own pinned tests.

use std::sync::OnceLock;

use crate::engine::Engine;

/// Resolved inputs for [`Engine::connection_string`]. All fields are borrowed
/// or `Copy`; the password is only ever handled behind `Zeroizing` upstream.
pub struct ConnArgs<'a> {
    pub host: &'a str,
    pub port: u16,
    pub instance: &'a str,
    pub database: &'a str,
    pub username: &'a str,
    pub password: &'a str,
    pub win_auth: bool,
    pub ssl_mode: &'a str,
    pub via_tunnel: bool,
    pub connect_timeout_secs: Option<u8>,
}

impl Engine {
    /// Build the full connection string for this engine. One canonical
    /// `ssl_mode` mapping per engine — every call site now honours the saved
    /// SSL mode (previously four sites silently used driver defaults).
    pub fn connection_string(self, a: &ConnArgs) -> String {
        match self {
            // MariaDB is wire-protocol compatible with MySQL — same
            // MySqlConnector driver, same connection-string dialect.
            Engine::MySql | Engine::MariaDb => {
                let ssl_param = match a.ssl_mode {
                    "none" => "SslMode=None;",
                    "require" => "SslMode=Required;",
                    "verify-full" => "SslMode=VerifyFull;",
                    // Over an SSH tunnel the hop is already encrypted and the
                    // endpoint is localhost — TLS inside the tunnel usually
                    // fails hostname checks, so default it off.
                    _ if a.via_tunnel => "SslMode=None;",
                    _ => "SslMode=Preferred;",
                };
                // AllowUserVariables lets queries use @vars; harmless for
                // catalog queries, required for the interactive editor.
                let mut suffix = format!("{ssl_param}AllowUserVariables=true;");
                if let Some(t) = a.connect_timeout_secs {
                    suffix.push_str(&format!("ConnectionTimeout={t};"));
                }
                build_mysql_conn(a.host, a.port, a.database, a.username, a.password, &suffix)
            }
            Engine::Postgres => {
                let ssl_param = match a.ssl_mode {
                    "none" => "SSL Mode=Disable;",
                    "require" => "SSL Mode=Require;",
                    "verify-full" => "SSL Mode=VerifyFull;",
                    _ => "SSL Mode=Prefer;",
                };
                let mut suffix = ssl_param.to_string();
                if let Some(t) = a.connect_timeout_secs {
                    suffix.push_str(&format!("Timeout={t};"));
                }
                build_pg_conn(a.host, a.port, a.database, a.username, a.password, &suffix)
            }
            // CockroachDB speaks the Postgres wire protocol — uses Npgsql.
            // ssl_mode="none" (insecure dev cluster): use SSL Mode=Allow so
            // Npgsql connects plain without sending an SSLRequest — omitting
            // SSL Mode defaults Npgsql to Prefer, which DOES send an
            // SSLRequest that an insecure listener may never answer (30-second
            // timeout). Secure clusters usually run self-signed certs, hence
            // Trust Server Certificate on require/prefer.
            Engine::CockroachDb => {
                let ssl_param = match a.ssl_mode {
                    "none" => "SSL Mode=Allow;",
                    "require" => "SSL Mode=Require;Trust Server Certificate=true;",
                    "verify-full" => "SSL Mode=VerifyFull;",
                    _ => "SSL Mode=Prefer;Trust Server Certificate=true;",
                };
                let mut suffix = ssl_param.to_string();
                if let Some(t) = a.connect_timeout_secs {
                    suffix.push_str(&format!("Timeout={t};"));
                }
                build_pg_conn(a.host, a.port, a.database, a.username, a.password, &suffix)
            }
            Engine::SqlServer => build_sqlserver_odbc(&SqlServerOdbcArgs {
                host: a.host,
                port: a.port,
                instance: a.instance,
                database: a.database,
                username: a.username,
                password: a.password,
                win_auth: a.win_auth,
                ssl_mode: a.ssl_mode,
            }),
            Engine::Sqlite => build_sqlite_conn(a.database),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-driver string builders
// ─────────────────────────────────────────────────────────────────────────────

static SQLSERVER_ODBC_DRIVER: OnceLock<String> = OnceLock::new();

/// Pick the best installed SQL Server ODBC driver, once.
fn sqlserver_odbc_driver() -> &'static str {
    SQLSERVER_ODBC_DRIVER
        .get_or_init(|| {
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

/// Resolved inputs for `build_sqlserver_odbc`, grouped to keep the builder
/// under the argument-count limit.
pub struct SqlServerOdbcArgs<'a> {
    pub host: &'a str,
    pub port: u16,
    pub instance: &'a str,
    pub database: &'a str,
    pub username: &'a str,
    pub password: &'a str,
    pub win_auth: bool,
    pub ssl_mode: &'a str,
}

/// Builds the ODBC connection string for a SQL Server connection.
/// SINGLE SOURCE OF TRUTH — every SQL Server call site must use this so the
/// driver name, instance/port form, auth mode, and Encrypt/SSL handling can
/// never drift between code paths again.
pub fn build_sqlserver_odbc(args: &SqlServerOdbcArgs) -> String {
    let &SqlServerOdbcArgs {
        host,
        port,
        instance,
        database,
        username,
        password,
        win_auth,
        ssl_mode,
    } = args;
    // Named instance => host\instance; otherwise host,port (ODBC comma form).
    let server = if !instance.is_empty() {
        format!("{}\\{}", host, instance)
    } else {
        format!("{},{}", host, port)
    };
    let encrypt = match ssl_mode {
        "require" => "yes",
        "verify-full" => "strict",
        _ => "no",
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
pub fn escape_odbc_value(v: &str) -> String {
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
pub fn escape_kv_value(v: &str) -> String {
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
/// every free-text field escaped. `suffix` carries the SSL/timeout/
/// AllowUserVariables tail (audit H-2 / A-3).
pub fn build_mysql_conn(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
    password: &str,
    suffix: &str,
) -> String {
    format!(
        "Server={};Port={};Database={};Uid={};Pwd={};{}",
        host,
        port,
        escape_kv_value(database),
        escape_kv_value(username),
        escape_kv_value(password),
        suffix
    )
}

/// Builds a PostgreSQL/CockroachDB (Npgsql) keyword/value connection string with
/// every free-text field escaped. `suffix` carries the SSL/timeout tail
/// (audit H-2 / A-3).
pub fn build_pg_conn(
    host: &str,
    port: u16,
    database: &str,
    username: &str,
    password: &str,
    suffix: &str,
) -> String {
    format!(
        "Host={};Port={};Database={};Username={};Password={};{}",
        host,
        port,
        escape_kv_value(database),
        escape_kv_value(username),
        escape_kv_value(password),
        suffix
    )
}

/// The single builder for DbArk's SQLite connection string (audit A-3). The C#
/// side parses this back out with `SqliteConnectionString.ExtractPath` in
/// `src-csharp/Shared/SqliteConnectionString.cs` — keep the two in sync.
/// SQLite has no host/credentials: `database` is the file path, used verbatim.
pub fn build_sqlite_conn(database: &str) -> String {
    format!("Data Source={}", database)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod ssl_mapping_tests {
    use super::*;

    fn args<'a>(engine_ssl: &'a str) -> ConnArgs<'a> {
        ConnArgs {
            host: "h",
            port: 5432,
            instance: "",
            database: "db",
            username: "u",
            password: "pw",
            win_auth: false,
            ssl_mode: engine_ssl,
            via_tunnel: false,
            connect_timeout_secs: None,
        }
    }

    #[test]
    fn mysql_maps_every_ssl_mode() {
        for (mode, expect) in [
            ("none", "SslMode=None;"),
            ("require", "SslMode=Required;"),
            ("verify-full", "SslMode=VerifyFull;"),
            ("prefer", "SslMode=Preferred;"),
        ] {
            let s = Engine::MySql.connection_string(&args(mode));
            assert!(s.contains(expect), "ssl_mode={mode}: got {s}");
            assert!(s.contains("AllowUserVariables=true;"));
        }
    }

    #[test]
    fn mysql_defaults_ssl_off_over_tunnel() {
        let mut a = args("prefer");
        a.via_tunnel = true;
        let s = Engine::MySql.connection_string(&a);
        assert!(s.contains("SslMode=None;"), "got {s}");
    }

    #[test]
    fn postgres_maps_every_ssl_mode() {
        for (mode, expect) in [
            ("none", "SSL Mode=Disable;"),
            ("require", "SSL Mode=Require;"),
            ("verify-full", "SSL Mode=VerifyFull;"),
            ("prefer", "SSL Mode=Prefer;"),
        ] {
            let s = Engine::Postgres.connection_string(&args(mode));
            assert!(s.contains(expect), "ssl_mode={mode}: got {s}");
        }
    }

    #[test]
    fn cockroach_insecure_uses_allow_never_disable() {
        // Allow (not Disable) is what keeps Npgsql from sending an SSLRequest
        // an insecure listener never answers — the 30s-timeout regression.
        let s = Engine::CockroachDb.connection_string(&args("none"));
        assert!(s.contains("SSL Mode=Allow;"), "got {s}");
        assert!(!s.contains("Disable"));
    }

    #[test]
    fn cockroach_secure_trusts_self_signed() {
        let s = Engine::CockroachDb.connection_string(&args("require"));
        assert!(
            s.contains("SSL Mode=Require;Trust Server Certificate=true;"),
            "got {s}"
        );
    }

    #[test]
    fn connect_timeout_reaches_each_driver_dialect() {
        let mut a = args("prefer");
        a.connect_timeout_secs = Some(5);
        assert!(Engine::MySql
            .connection_string(&a)
            .contains("ConnectionTimeout=5;"));
        assert!(Engine::Postgres
            .connection_string(&a)
            .contains("Timeout=5;"));
        assert!(Engine::CockroachDb
            .connection_string(&a)
            .contains("Timeout=5;"));
    }

    #[test]
    fn mariadb_uses_the_mysql_dialect() {
        let a = args("prefer");
        assert_eq!(
            Engine::MariaDb.connection_string(&a),
            Engine::MySql.connection_string(&a)
        );
    }

    #[test]
    fn sqlite_ignores_everything_but_the_path() {
        let mut a = args("prefer");
        a.database = "/data/x.db";
        assert_eq!(
            Engine::Sqlite.connection_string(&a),
            "Data Source=/data/x.db"
        );
    }
}

#[cfg(test)]
mod conn_string_tests {
    use super::{
        build_mysql_conn, build_pg_conn, build_sqlite_conn, build_sqlserver_odbc, escape_kv_value,
        escape_odbc_value, SqlServerOdbcArgs,
    };

    // ---- build_sqlite_conn (audit A-3) ----

    #[test]
    fn sqlite_conn_is_the_shared_data_source_contract() {
        // The C# side (SqliteConnectionString.ExtractPath) parses this exact
        // shape back out — this test pins the producing half of the contract.
        assert_eq!(
            build_sqlite_conn(r"C:\data\app.db"),
            r"Data Source=C:\data\app.db"
        );
    }

    #[test]
    fn sqlite_conn_passes_paths_with_spaces_and_quotes_verbatim() {
        // Paths like /Users/O'Brien/my data.db must survive untouched; the
        // consumer trims but never unquotes (regression guard for audit H-1).
        assert_eq!(
            build_sqlite_conn("/Users/O'Brien/my data.db"),
            "Data Source=/Users/O'Brien/my data.db"
        );
    }

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
            host: "h",
            port: 1433,
            instance: "",
            database: "db",
            username: "sa",
            password: "p;w}x",
            win_auth: false,
            ssl_mode: "require",
        });
        // password ends up brace-quoted with the `}` doubled
        assert!(s.contains("PWD={p;w}}x};"), "got: {}", s);
        assert!(s.contains("Database=db;"));
    }
}
