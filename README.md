# DbArk

**A local-first, Git-native database GUI — zero login, zero telemetry, ~80MB RAM.**

[![Build](https://github.com/TooSmoove/DbArk/actions/workflows/build.yml/badge.svg)](https://github.com/TooSmoove/DbArk/actions/workflows/build.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-6c63ff.svg)](LICENSE)
[![Status: Beta](https://img.shields.io/badge/Status-Beta-f59e0b.svg)](#roadmap)

DbArk is a developer-first database GUI built to compete with DBeaver, TablePlus, SSMS, and MySQL Workbench — without the bloat, the subscriptions, or the telemetry. Connection configs are plain TOML files that live comfortably in a Git repository. Passwords never leave the OS keychain.

**Free forever. MIT licensed. Fully open source.** No paid tier, no connection limits, no feature gates — and no plans to ever add them. The free-vs-paid trick that gets played on developers by every major database client doesn't happen here.

> Verify the zero-telemetry claim yourself with Wireshark — DbArk makes zero outbound connections except to your configured database hosts.

---

## Features

### Database Engines

Six supported engines via four driver implementations:

- **PostgreSQL** — via Npgsql
- **CockroachDB** — wire-protocol compatible with Postgres (uses Npgsql)
- **MySQL** — via MySqlConnector
- **MariaDB** — wire-protocol compatible with MySQL (uses MySqlConnector)
- **SQLite** — via direct P/Invoke to `winsqlite3.dll` / `libsqlite3.so`
- **SQL Server** — via Microsoft.Data.SqlClient

### Core

- **Flat file querying** — query CSV, JSON, and Excel files with standard SQL via DuckDB
- **File + DB joins** — JOIN a CSV against a live database table in a single query. No competitor at any price point does this.
- **SSH tunneling** — connect to databases behind bastion hosts via key or password auth
- **Schema explorer** — browse tables, columns, stored procedures, functions, views, triggers, and indexes
- **Inline table editing** — double-click any cell to edit, UPDATE generated automatically
- **Multi-tab editor** — each tab has its own connection, SQL, and results
- **Multi-statement results** — each `;`-separated statement gets its own result tab
- **Query history** — 90-day local history, credential-scrubbed, never leaves your machine
- **Smart DDL rewrite** — auto rewrites `CREATE` → `CREATE OR ALTER/REPLACE` on deploy
- **Git-native** — connection configs are plain TOML files, committable to any repo

### Security

- **DLL integrity checking** — SHA-256 verification of all native libraries at startup
- **Credentials in OS keychain only** — never written to disk, never cross the IPC boundary to JavaScript
- **Read-only connection mode** — enforced at the driver level, not just the UI
- **Session lock** — auto-locks after 15 minutes of inactivity
- **TOML input validation** — rejects injection attempts at the parser layer
- **Zero telemetry** — verifiable with Wireshark

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
git clone https://github.com/TooSmoove/DbArk.git
cd DbArk

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

- **Zero telemetry** — no analytics, no crash reporting unless you opt in, no accounts, ever
- **Credentials in OS keychain only** — never written to disk, never sent across the IPC boundary to JavaScript
- **TOML configs are safe to commit** — they contain connection metadata only, never passwords
- **DLL integrity checking** — SHA-256 hash verification before any native library loads
- **Full details** — see [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md)

---

## Why MIT, Why Free

DbArk is built on verifiable trust. The MIT license and open codebase make every privacy claim provable rather than asserted — you can read the code, run Wireshark against the binary, and verify that what's promised is what ships. Closed source with privacy claims is marketing copy; open source with privacy claims is a verifiable promise.

The project is free forever — no paid tier added later, no rug-pull, no "we got acquired" pivot. Future monetisation, if any, will take forms that complement the free model (enterprise support, adjacent products, services) rather than contradicting it.

---

## Roadmap

See the [build checklist](dbark-build-checklist.html) for the full plan. Currently in the polish and beta phase — full public launch coming soon. Notable items shipping with v1.0:

- AI query explainer (opt-in, bring-your-own API key)
- Auto-generated ER diagrams
- Stored procedure debugger with breakpoints and step-through
- Live server activity panel
- Linux support

---

## Contributing

Beta testers and bug reports are very welcome. Open an [issue](https://github.com/TooSmoove/DbArk/issues) or start a [discussion](https://github.com/TooSmoove/DbArk/discussions). Full contributing guide coming with v1.0.

---

## License

[MIT](LICENSE) — free forever, no catches.
