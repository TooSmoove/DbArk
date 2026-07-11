//! The single home for everything engine-specific in the Rust host (audit A-2).
//!
//! Before this module existed, "which database engine is this?" was answered by
//! a `match engine.to_lowercase().as_str()` block copy-pasted into eight Tauri
//! commands. The copies drifted: four sites ignored the saved `ssl_mode`, two
//! rejected CockroachDB-insecure connections that other sites accepted, and
//! `drop_object` didn't know MariaDB or CockroachDB existed. Adding a new
//! engine meant shotgun surgery across all of them.
//!
//! Now there is exactly one [`Engine`] enum and one [`resolve`] entry point.
//! A command that needs a connection string writes:
//!
//! ```ignore
//! let (engine, conn_str) = engine::resolve(&params, ConnOptions::default())?;
//! ```
//!
//! and adding engine #7 means: add a variant, and the compiler's exhaustive
//! `match` checks walk you through every place that needs a decision — all of
//! which live in this file.
//!
//! Design notes:
//! - The enum is deliberately a closed set (not a trait-object registry):
//!   engines ship compiled into the host, and exhaustive matching is the
//!   feature — a new variant fails compilation until every policy names it.
//! - Password policy and keychain access are separated ([`apply_password_policy`]
//!   is pure) so the full policy matrix is unit-testable without an OS keychain.
//! - This module has no dependency on `main.rs`. Errors are [`EngineError`];
//!   the host maps them onto its IPC envelope.

use std::sync::OnceLock;

use zeroize::Zeroizing;

// ─────────────────────────────────────────────────────────────────────────────
// Engine enum
// ─────────────────────────────────────────────────────────────────────────────

/// Every database engine the host knows how to talk to.
///
/// Wire-compatibility (MariaDB→MySQL driver, CockroachDB→Postgres driver) is a
/// property of each *operation*, expressed inside this module — callers never
/// alias one engine to another themselves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    SqlServer,
    Postgres,
    CockroachDb,
    MySql,
    MariaDb,
    Sqlite,
}

/// Errors produced while resolving engine-specific behaviour. `main.rs` maps
/// these onto its `IpcError` envelope (`Unsupported`→validation,
/// `CredentialNotFound`/`NoPassword`→not_found, `Keychain`→internal) so the
/// wire shape seen by the frontend is unchanged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// The engine name from the frontend isn't one we support.
    Unsupported(String),
    /// The OS keychain entry could not even be opened.
    Keychain(String),
    /// The keychain has no entry for this credential reference.
    CredentialNotFound(String),
    /// The keychain entry exists but holds an empty password.
    NoPassword(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Unsupported(name) => write!(f, "Unsupported engine: {name}"),
            EngineError::Keychain(msg) => write!(f, "{msg}"),
            EngineError::CredentialNotFound(msg) => write!(f, "{msg}"),
            EngineError::NoPassword(cref) => write!(
                f,
                "No password stored for '{cref}'. Open Edit Connection, enter the password and save."
            ),
        }
    }
}

impl Engine {
    /// Case-insensitive parse of the engine name sent over IPC. This is the
    /// only place in the host where an engine string is interpreted.
    pub fn parse(name: &str) -> Result<Engine, EngineError> {
        match name.to_lowercase().as_str() {
            "sqlserver" => Ok(Engine::SqlServer),
            "postgres" => Ok(Engine::Postgres),
            "cockroachdb" => Ok(Engine::CockroachDb),
            "mysql" => Ok(Engine::MySql),
            "mariadb" => Ok(Engine::MariaDb),
            "sqlite" => Ok(Engine::Sqlite),
            _ => Err(EngineError::Unsupported(name.to_string())),
        }
    }

    /// Canonical lowercase name — the exact string the C# layer dispatches on.
    pub fn name(self) -> &'static str {
        match self {
            Engine::SqlServer => "sqlserver",
            Engine::Postgres => "postgres",
            Engine::CockroachDb => "cockroachdb",
            Engine::MySql => "mysql",
            Engine::MariaDb => "mariadb",
            Engine::Sqlite => "sqlite",
        }
    }

    /// Default TCP port, used when an imported connection doesn't specify one.
    /// SQLite is file-based and has no port (0).
    pub fn default_port(self) -> u16 {
        match self {
            Engine::SqlServer => 1433,
            Engine::Postgres => 5432,
            Engine::CockroachDb => 26257,
            Engine::MySql | Engine::MariaDb => 3306,
            Engine::Sqlite => 0,
        }
    }

    /// Whether connections to this engine store a password in the OS keychain.
    /// SQLite is a local file — no credentials exist for it.
    pub fn uses_keychain(self) -> bool {
        !matches!(self, Engine::Sqlite)
    }

    /// CockroachDB insecure dev clusters (`ssl_mode = "none"`) run without
    /// passwords — a missing/empty keychain entry is normal there, not an error.
    pub fn allows_missing_password(self, ssl_mode: &str) -> bool {
        matches!(self, Engine::CockroachDb) && ssl_mode == "none"
    }

    /// Quote a SQL identifier, doubling this engine's closing delimiter so a
    /// crafted or compromised object name can't break out of the quotes
    /// (audit H-1). SQL Server uses `[..]` (`]`→`]]`), MySQL/MariaDB use
    /// `` `..` `` (`` ` ``→`` `` ``), and Postgres/CockroachDB/SQLite use the
    /// SQL-standard `".."` (`"`→`""`). Quoting also preserves exact catalog
    /// casing instead of letting an unquoted name case-fold.
    pub fn quote_ident(self, ident: &str) -> String {
        match self {
            Engine::SqlServer => format!("[{}]", ident.replace(']', "]]")),
            Engine::MySql | Engine::MariaDb => format!("`{}`", ident.replace('`', "``")),
            Engine::Postgres | Engine::CockroachDb | Engine::Sqlite => {
                format!("\"{}\"", ident.replace('"', "\"\""))
            }
        }
    }

    /// Build a DROP statement for a schema object. Every identifier is quoted
    /// via [`Engine::quote_ident`], and `object_type` is validated against a
    /// fixed per-engine allow-list — an unrecognised type returns `Err` rather
    /// than being interpolated as a raw SQL keyword (audit H-1: the object
    /// name/schema/table all arrive from the frontend over IPC and must be
    /// treated as untrusted).
    pub fn build_drop_statement(
        self,
        object_type: &str,
        name: &str,
        schema: &str,
        table: &str,
    ) -> Result<String, String> {
        let q = |ident: &str| self.quote_ident(ident);
        let sql = match self {
            Engine::SqlServer => match object_type {
                "procedure" => format!("DROP PROCEDURE {}.{}", q(schema), q(name)),
                "function" => format!("DROP FUNCTION {}.{}", q(schema), q(name)),
                "view" => format!("DROP VIEW {}.{}", q(schema), q(name)),
                "trigger" => format!("DROP TRIGGER {}", q(name)),
                "index" => format!("DROP INDEX {} ON {}.{}", q(name), q(schema), q(table)),
                "table" => format!("DROP TABLE {}.{}", q(schema), q(name)),
                other => return Err(format!("Unsupported object type for sqlserver: {other}")),
            },
            Engine::MySql | Engine::MariaDb => match object_type {
                "procedure" => format!("DROP PROCEDURE {}", q(name)),
                "function" => format!("DROP FUNCTION {}", q(name)),
                "view" => format!("DROP VIEW {}", q(name)),
                "trigger" => format!("DROP TRIGGER {}", q(name)),
                "index" => format!("DROP INDEX {} ON {}", q(name), q(table)),
                "table" => format!("DROP TABLE {}", q(name)),
                other => {
                    return Err(format!(
                        "Unsupported object type for {}: {other}",
                        self.name()
                    ))
                }
            },
            Engine::Postgres | Engine::CockroachDb => match object_type {
                "procedure" => format!("DROP PROCEDURE {}.{}", q(schema), q(name)),
                "function" => format!("DROP FUNCTION {}.{}", q(schema), q(name)),
                "view" => format!("DROP VIEW {}.{}", q(schema), q(name)),
                "trigger" => format!("DROP TRIGGER {} ON {}.{}", q(name), q(schema), q(table)),
                "index" => format!("DROP INDEX {}.{}", q(schema), q(name)),
                "table" => format!("DROP TABLE {}.{}", q(schema), q(name)),
                other => {
                    return Err(format!(
                        "Unsupported object type for {}: {other}",
                        self.name()
                    ))
                }
            },
            Engine::Sqlite => match object_type {
                // SQLite: no schema namespace, no procedures/functions.
                "view" => format!("DROP VIEW {}", q(name)),
                "trigger" => format!("DROP TRIGGER {}", q(name)),
                "index" => format!("DROP INDEX {}", q(name)),
                "table" => format!("DROP TABLE {}", q(name)),
                other => return Err(format!("Unsupported object type for sqlite: {other}")),
            },
        };
        Ok(sql)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC parameter object
// ─────────────────────────────────────────────────────────────────────────────

/// Shared connection parameters for the database command IPC boundary.
/// Deserialised from the frontend's camelCase `invoke` payload under a
/// `params` key; omitted optionals (notably `tunnel_port`, sent only by
/// build_connection_string) deserialise to `None`.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionParams {
    pub credential_ref: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub username: String,
    pub ssl_mode: Option<String>,
    pub sql_instance: Option<String>,
    pub windows_auth: Option<bool>,
    pub tunnel_port: Option<u16>,
}

/// Per-call-site knobs for [`resolve`]. `Default` is the standard profile;
/// `test_connection` passes `connect_timeout_secs: Some(5)` so a wrong
/// host/port fails fast instead of hanging for the driver default.
#[derive(Default, Clone, Copy)]
pub struct ConnOptions {
    pub connect_timeout_secs: Option<u8>,
}

// ─────────────────────────────────────────────────────────────────────────────
// The one entry point: params → (engine, connection string)
// ─────────────────────────────────────────────────────────────────────────────

/// Parse the engine, fetch the password from the OS keychain (per the unified
/// policy), and build the engine-specific connection string. This replaces the
/// eight hand-rolled copies that previously lived in `main.rs` — every Tauri
/// command that needs a connection string goes through here.
pub fn resolve(
    params: &ConnectionParams,
    opts: ConnOptions,
) -> Result<(Engine, Zeroizing<String>), EngineError> {
    let engine = Engine::parse(&params.engine)?;
    let ssl = params.ssl_mode.as_deref().unwrap_or("prefer");
    let win_auth = params.windows_auth.unwrap_or(false);

    let password = resolve_password(
        engine,
        &params.credential_ref,
        &params.username,
        win_auth,
        ssl,
    )?;

    // If an SSH tunnel is active, connect via the local tunnel endpoint.
    let via_tunnel = params.tunnel_port.is_some();
    let host: &str = if via_tunnel {
        "127.0.0.1"
    } else {
        &params.host
    };
    let port = params.tunnel_port.unwrap_or(params.port);

    let conn_str = engine.connection_string(&ConnArgs {
        host,
        port,
        instance: params.sql_instance.as_deref().unwrap_or(""),
        database: &params.database,
        username: &params.username,
        password: password.as_str(),
        win_auth,
        ssl_mode: ssl,
        via_tunnel,
        connect_timeout_secs: opts.connect_timeout_secs,
    });

    Ok((engine, Zeroizing::new(conn_str)))
}

/// Fetch the connection password from the OS keychain, applying the unified
/// policy. Thin I/O wrapper — the policy itself is [`apply_password_policy`],
/// which is pure and fully unit-tested.
pub fn resolve_password(
    engine: Engine,
    credential_ref: &str,
    username: &str,
    win_auth: bool,
    ssl_mode: &str,
) -> Result<Zeroizing<String>, EngineError> {
    // No keychain fetch for SQLite (file path, no credentials) nor for
    // Windows-auth SQL Server (uses the OS identity).
    if !engine.uses_keychain() || win_auth {
        return Ok(Zeroizing::new(String::new()));
    }
    let entry = keyring::Entry::new(credential_ref, username)
        .map_err(|e| EngineError::Keychain(e.to_string()))?;
    let fetched = entry.get_password().map_err(|e| e.to_string());
    apply_password_policy(engine, ssl_mode, credential_ref, fetched).map(Zeroizing::new)
}

/// The unified password policy (pure — no keychain access):
/// - a missing keychain entry is fatal, **except** for CockroachDB-insecure
///   (`ssl_mode = "none"`), where the cluster runs without passwords;
/// - an entry that exists but is empty is fatal for every engine except
///   CockroachDB, with a message telling the user exactly how to fix it.
///
/// Previously each command had its own subset of this policy, so e.g. the
/// flat-file-join path rejected CockroachDB-insecure connections that
/// `get_schema` accepted.
fn apply_password_policy(
    engine: Engine,
    ssl_mode: &str,
    credential_ref: &str,
    fetched: Result<String, String>,
) -> Result<String, EngineError> {
    let pw = match fetched {
        Ok(p) => p,
        Err(_) if engine.allows_missing_password(ssl_mode) => String::new(),
        Err(e) => {
            return Err(EngineError::CredentialNotFound(format!(
                "Credential not found in keychain — store the password with the OS keychain first. ({})",
                e
            )))
        }
    };
    if pw.is_empty() && !matches!(engine, Engine::CockroachDb) {
        return Err(EngineError::NoPassword(credential_ref.to_string()));
    }
    Ok(pw)
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection-string construction
// ─────────────────────────────────────────────────────────────────────────────

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
// Per-driver string builders (single source of truth — audit A-3 / H-2)
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
mod engine_tests {
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

    // ---- Engine::parse ----

    #[test]
    fn parse_accepts_all_known_engines_case_insensitively() {
        assert_eq!(Engine::parse("sqlserver").unwrap(), Engine::SqlServer);
        assert_eq!(Engine::parse("PostgreS").unwrap(), Engine::Postgres);
        assert_eq!(Engine::parse("COCKROACHDB").unwrap(), Engine::CockroachDb);
        assert_eq!(Engine::parse("mysql").unwrap(), Engine::MySql);
        assert_eq!(Engine::parse("MariaDB").unwrap(), Engine::MariaDb);
        assert_eq!(Engine::parse("sqlite").unwrap(), Engine::Sqlite);
    }

    #[test]
    fn parse_rejects_unknown_engine() {
        let err = Engine::parse("oracle").unwrap_err();
        assert_eq!(err, EngineError::Unsupported("oracle".into()));
    }

    #[test]
    fn name_round_trips_through_parse() {
        for e in [
            Engine::SqlServer,
            Engine::Postgres,
            Engine::CockroachDb,
            Engine::MySql,
            Engine::MariaDb,
            Engine::Sqlite,
        ] {
            assert_eq!(Engine::parse(e.name()).unwrap(), e);
        }
    }

    // ---- default ports (DBeaver import) ----

    #[test]
    fn default_ports_match_engine_conventions() {
        assert_eq!(Engine::SqlServer.default_port(), 1433);
        assert_eq!(Engine::Postgres.default_port(), 5432);
        assert_eq!(Engine::CockroachDb.default_port(), 26257);
        assert_eq!(Engine::MySql.default_port(), 3306);
        assert_eq!(Engine::MariaDb.default_port(), 3306);
        assert_eq!(Engine::Sqlite.default_port(), 0);
    }

    // ---- password policy (pure, no keychain) ----

    #[test]
    fn policy_missing_credential_is_fatal_for_ordinary_engines() {
        let err = apply_password_policy(
            Engine::Postgres,
            "prefer",
            "dbark:conn:u",
            Err("no entry".into()),
        )
        .unwrap_err();
        assert!(matches!(err, EngineError::CredentialNotFound(_)));
    }

    #[test]
    fn policy_missing_credential_is_ok_for_cockroach_insecure() {
        // insecure cluster (ssl none): missing credential → empty password
        let pw = apply_password_policy(Engine::CockroachDb, "none", "r", Err("no entry".into()))
            .unwrap();
        assert_eq!(pw, "");
    }

    #[test]
    fn policy_missing_credential_is_fatal_for_cockroach_secure() {
        // secure cluster (ssl require): a missing credential is still an error
        let err =
            apply_password_policy(Engine::CockroachDb, "require", "r", Err("no entry".into()))
                .unwrap_err();
        assert!(matches!(err, EngineError::CredentialNotFound(_)));
    }

    #[test]
    fn policy_empty_stored_password_gives_actionable_error() {
        let err = apply_password_policy(Engine::MySql, "prefer", "dbark:c:u", Ok(String::new()))
            .unwrap_err();
        assert_eq!(err, EngineError::NoPassword("dbark:c:u".into()));
        assert!(err.to_string().contains("Open Edit Connection"));
    }

    #[test]
    fn policy_empty_password_allowed_for_cockroach() {
        let pw =
            apply_password_policy(Engine::CockroachDb, "prefer", "r", Ok(String::new())).unwrap();
        assert_eq!(pw, "");
    }

    #[test]
    fn policy_passes_real_password_through() {
        let pw =
            apply_password_policy(Engine::Postgres, "prefer", "r", Ok("s3cret".into())).unwrap();
        assert_eq!(pw, "s3cret");
    }

    // ---- ssl_mode mapping ----

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
mod drop_sql_tests {
    use super::Engine;

    #[test]
    fn quote_ident_doubles_sqlserver_bracket() {
        // a `]` in the name must be doubled so it can't close the [..] quote early
        assert_eq!(Engine::SqlServer.quote_ident("ev]il"), "[ev]]il]");
        assert_eq!(Engine::SqlServer.quote_ident("users"), "[users]");
    }

    #[test]
    fn quote_ident_doubles_mysql_backtick() {
        assert_eq!(Engine::MySql.quote_ident("ev`il"), "`ev``il`");
        assert_eq!(Engine::MariaDb.quote_ident("t"), "`t`");
    }

    #[test]
    fn quote_ident_doubles_standard_doublequote() {
        // postgres / cockroachdb / sqlite all use SQL-standard ".."
        assert_eq!(Engine::Postgres.quote_ident("ev\"il"), "\"ev\"\"il\"");
        assert_eq!(Engine::Sqlite.quote_ident("weird name"), "\"weird name\"");
        assert_eq!(Engine::CockroachDb.quote_ident("t"), "\"t\"");
    }

    #[test]
    fn drop_quotes_all_identifiers_sqlserver() {
        assert_eq!(
            Engine::SqlServer
                .build_drop_statement("table", "Orders", "dbo", "")
                .unwrap(),
            "DROP TABLE [dbo].[Orders]"
        );
    }

    #[test]
    fn drop_neutralises_injection_in_object_name() {
        // A name crafted to close the quote and append a second statement is
        // rendered inert: the `]` is doubled, so the whole payload stays trapped
        // inside one bracket-quoted identifier.
        let sql = Engine::SqlServer
            .build_drop_statement("table", "x]; DROP TABLE secrets;--", "dbo", "")
            .unwrap();
        assert_eq!(sql, "DROP TABLE [dbo].[x]]; DROP TABLE secrets;--]");
        assert!(sql.ends_with(']'));
    }

    #[test]
    fn drop_quotes_postgres_schema_and_name() {
        assert_eq!(
            Engine::Postgres
                .build_drop_statement("view", "v", "public", "")
                .unwrap(),
            "DROP VIEW \"public\".\"v\""
        );
    }

    #[test]
    fn drop_supports_mariadb_and_cockroachdb() {
        // Regression guard for the A-2 drift bug: the old string-matched drop
        // path knew nothing about mariadb/cockroachdb and returned
        // "Unsupported engine" for them.
        assert_eq!(
            Engine::MariaDb
                .build_drop_statement("table", "t", "", "")
                .unwrap(),
            "DROP TABLE `t`"
        );
        assert_eq!(
            Engine::CockroachDb
                .build_drop_statement("index", "ix", "public", "t")
                .unwrap(),
            "DROP INDEX \"public\".\"ix\""
        );
    }

    #[test]
    fn drop_quotes_sqlite_name() {
        assert_eq!(
            Engine::Sqlite
                .build_drop_statement("table", "my tbl", "", "")
                .unwrap(),
            "DROP TABLE \"my tbl\""
        );
    }

    #[test]
    fn drop_index_includes_table_sqlserver() {
        assert_eq!(
            Engine::SqlServer
                .build_drop_statement("index", "ix_a", "dbo", "Orders")
                .unwrap(),
            "DROP INDEX [ix_a] ON [dbo].[Orders]"
        );
    }

    #[test]
    fn drop_rejects_unknown_object_type() {
        // an object type the engine doesn't support errors out, never interpolates raw
        assert!(Engine::SqlServer
            .build_drop_statement("database", "x", "dbo", "")
            .is_err());
        assert!(Engine::Sqlite
            .build_drop_statement("procedure", "x", "", "")
            .is_err());
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
