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
- **Query history** — 90-day local history, credential-scrubbed, encrypted at rest, never leaves your machine
- **Smart DDL rewrite** — auto rewrites `CREATE` → `CREATE OR ALTER/REPLACE` on deploy
- **Git-native** — connection configs are plain TOML files, committable to any repo

### Security

- **DLL integrity checking** — SHA-256 verification of all native libraries at startup
- **Credentials in OS keychain only** — never written to disk, never cross the IPC boundary to JavaScript
- **Encrypted query history** — `state.db` encrypted with SQLCipher, key derived from the OS keychain
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

The six C# projects publish as NativeAOT binaries. AOT only triggers when the flag
is passed explicitly **and** a runtime identifier (RID) is supplied — a plain
`dotnet publish -c Release` silently produces a managed build instead. Each `.csproj`
also sets `<PublishAot>true</PublishAot>` so the flag is not load-bearing, but pass
it anyway and pick the RID for your platform (`win-x64`, `osx-arm64`, `linux-x64`):

```bash
git clone https://github.com/TooSmoove/DbArk.git
cd DbArk

# Build C# NativeAOT projects (example uses win-x64 — substitute your RID)
RID=win-x64
for proj in QueryExecutor ConnectionManager FileQueryEngine QueryHistory SshTunnel SchemaExplorer; do
  dotnet publish "src-csharp/$proj" -c Release -r "$RID" -p:PublishAot=true
done

# Install frontend deps
npm install

# Run in development
cargo tauri dev
```

> A one-command build script (`build.ps1` / `build.sh`) that publishes all engines,
> copies native libraries beside the executable, regenerates integrity hashes, and
> bundles the installer is the recommended path — see the build checklist.

---

## Privacy & Security

- **Zero telemetry** — no analytics, no crash reporting unless you opt in, no accounts, ever
- **Credentials in OS keychain only** — never written to disk, never sent across the IPC boundary to JavaScript
- **TOML configs are safe to commit** — they contain connection metadata only, never passwords
- **Encrypted history** — `state.db` is encrypted with SQLCipher
- **DLL integrity checking** — SHA-256 hash verification before any native library loads
- **Full details** — see [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md)

---

## Why MIT, Why Free

DbArk is built on verifiable trust. The MIT license and open codebase make every privacy claim provable rather than asserted — you can read the code, run Wireshark against the binary, and verify that what's promised is what ships. Closed source with privacy claims is marketing copy; open source with privacy claims is a verifiable promise.

The project is free forever — no paid tier added later, no rug-pull, no "we got acquired" pivot. Future monetisation, if any, will take forms that complement the free model (enterprise support, adjacent products, services) rather than contradicting it.

---

## Roadmap

See the [build checklist](dbark-build-checklist.html) for the full plan. Currently in the polish and beta phase — full public launch coming soon.

**Shipping with v1.0:**

- Live server activity panel (active queries, locks, kill button)
- Auto-generated ER diagrams
- Cross-platform — Windows, macOS, and Linux

**Planned after launch (v1.1+):** each ships as its own release, built on real user feedback.

- Schema & data compare — a free, cross-platform Red Gate alternative
- Stored procedure debugger with breakpoints and step-through
- Graphical execution plans
- SQL Server Agent job browser
- Cross-database querying across multiple live connections

---

## Contributing

Beta testers and bug reports are very welcome. Open an [issue](https://github.com/TooSmoove/DbArk/issues) or start a [discussion](https://github.com/TooSmoove/DbArk/discussions). Full contributing guide coming with v1.0.

---

## License

[MIT](LICENSE) — free forever, no catches.
