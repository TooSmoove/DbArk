//! Engine identity and policy — the single home for "which database engine is
//! this, and what are its rules?" (audit A-2).
//!
//! Before this module existed, that question was answered by a
//! `match engine.to_lowercase().as_str()` block copy-pasted into eight Tauri
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
//! which live here or in [`crate::conn_string`] (the per-driver string
//! builders, split out so identity/policy and string assembly each stay one
//! screenful).
//!
//! Design notes:
//! - The enum is deliberately a closed set (not a trait-object registry):
//!   engines ship compiled into the host, and exhaustive matching is the
//!   feature — a new variant fails compilation until every policy names it.
//! - Password policy and keychain access are separated ([`apply_password_policy`]
//!   is pure) so the full policy matrix is unit-testable without an OS keychain.
//! - This module has no dependency on the IPC layer. Errors are [`EngineError`];
//!   `ipc.rs` maps them onto the host's envelope.

use zeroize::Zeroizing;

use crate::conn_string::ConnArgs;

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

/// Errors produced while resolving engine-specific behaviour. `ipc.rs` maps
/// these onto the `IpcError` envelope (`Unsupported`→validation,
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
// Tests
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod engine_tests {
    use super::*;

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
