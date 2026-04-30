# DevSql

**A local-first, Git-native database GUI — zero login, zero telemetry, ~80MB RAM.**

[![Build](https://github.com/TooSmoove/DevSql/actions/workflows/build.yml/badge.svg)](https://github.com/TooSmoove/DevSql/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-6c63ff.svg)](LICENSE)

DevSql is a developer-first database GUI built to compete with DBeaver, TablePlus, SSMS, and MySQL Workbench — without the bloat, the subscriptions, or the telemetry. Connection configs are plain TOML files that live comfortably in a Git repository. Passwords never leave the OS keychain.

> Verify the zero-telemetry claim yourself with Wireshark — DevSql makes zero outbound connections except to your configured database hosts.

---

## Features

- **4 database engines** — PostgreSQL, MySQL, SQLite, SQL Server
- **Flat file querying** — query CSV, JSON, and Excel files with standard SQL via DuckDB
- **File + DB joins** — JOIN a CSV against a live database table in a single query. No competitor does this.
- **SSH tunneling** — connect to databases behind bastion hosts via key or password auth
- **Schema explorer** — browse tables, columns, stored procedures, functions, views, triggers, and indexes
- **Inline table editing** — double-click any cell to edit, UPDATE generated automatically
- **Multi-tab editor** — each tab has its own connection, SQL, and results
- **Query history** — 90-day local history, credential-scrubbed, never leaves your machine
- **Smart DDL rewrite** — auto rewrites `CREATE` → `CREATE OR ALTER/REPLACE` on deploy
- **DLL integrity checking** — SHA-256 verification of all native libraries at startup
- **Read-only connection mode** — enforced at the driver level, not just the UI
- **Session lock** — auto-locks after 15 minutes of inactivity
- **Git-native** — connection configs are plain TOML files, committable to any repo

---

## Tech Stack

- [Tauri v2](https://tauri.app/) + Rust
- React + TypeScript
- C# NativeAOT — database drivers run as verified native binaries
- DuckDB (flat file queries via C API)

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) + Cargo
- [Node.js](https://nodejs.org/) 20+
- [.NET 10 SDK](https://dotnet.microsoft.com/download)
- [Tauri CLI v2](https://tauri.app/start/prerequisites/) — `cargo install tauri-cli --version "^2.0" --locked`

### Build & Run

```bash
git clone https://github.com/TooSmoove/DevSql.git
cd DevSql

# Build C# NativeAOT projects
cd src-csharp/QueryExecutor    && dotnet publish -c Release && cd ../..
cd src-csharp/ConnectionManager && dotnet publish -c Release && cd ../..
cd src-csharp/FileQueryEngine   && dotnet publish -c Release && cd ../..
cd src-csharp/QueryHistory      && dotnet publish -c Release && cd ../..
cd src-csharp/SshTunnel         && dotnet publish -c Release && cd ../..
cd src-csharp/SchemaExplorer    && dotnet publish -c Release && cd ../..

# Install frontend deps
npm install

# Run in development
cargo tauri dev
```

---

## Privacy & Security

- **Zero telemetry** — no analytics, no crash reporting unless you opt in, no accounts
- **Credentials in OS keychain only** — never written to disk, never cross the IPC boundary to JavaScript
- **TOML configs are safe to commit** — they contain connection metadata only, never passwords
- **DLL integrity checking** — SHA-256 hash verification before any native library loads
- **Full details** — see [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md)

---

## Roadmap

See the [build checklist](DevSql-build-checklist.html) for the full plan. Currently in the polish and beta phase — full public launch coming soon.

---

## Contributing

Beta testers and bug reports are very welcome. Open an issue or start a discussion. Full contributing guide coming with v1.0.

---

## License

[MIT](LICENSE) — free forever, no catches.