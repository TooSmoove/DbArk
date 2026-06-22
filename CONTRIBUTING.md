# Contributing to DbArk

Thanks for considering a contribution. DbArk is a local-first database GUI client built on Tauri v2 (Rust host) + a set of C# NativeAOT engines + a React/TypeScript frontend. It's MIT-licensed, so anything you contribute ships under MIT too.

Before you write code, skim two files: [`AGENTS.md`](./AGENTS.md) for the non-negotiable engineering rules, and [`SECURITY.md`](./SECURITY.md) if your change touches credentials, the keychain, or the native loading path. The short version of the rules lives at the bottom of this doc.

## Prerequisites

You need all three toolchains, because a full build crosses all three layers:

- **.NET 10 SDK** — the six engine projects publish as NativeAOT native libraries.
- **Node 20+** — the React/Vite frontend.
- **Rust (stable) + Tauri CLI v2** — the host that loads the engines and serves the webview. `cargo install tauri-cli --version "^2"` if you don't have it.

On Windows you'll also want the things a clean machine doesn't ship with, because the app loads native code at startup:

- **WebView2 runtime** (the installer can bootstrap it; for a dev build, install it once).
- **Microsoft ODBC Driver 18 for SQL Server** — the legacy "SQL Server" driver isn't enough and produces an IM002 error.
- **Visual C++ Redistributable** — DuckDB is native C++ and links against it.

macOS and Linux contributors: the native filenames differ (`.dylib` / `.so`), and a few load paths are still being made OS-conditional. If you hit a Windows-only assumption, that's a real bug worth a PR, not a quirk to work around.

## Repository layout

```
src-tauri/          Rust host (Tauri). main.rs holds the command surface + DLL integrity hashes.
src-csharp/         Six NativeAOT engine projects + QueryExecutor.Tests:
                      ConnectionManager, FileQueryEngine, QueryExecutor,
                      QueryHistory, SchemaExplorer, SshTunnel
src/                React + TypeScript frontend (App.tsx, components/, theme.css).
scripts/            stage-natives.ps1 / stage-natives.sh — copy built engines beside the exe.
update-hashes.ps1   Regenerates the SHA-256 integrity hashes baked into main.rs.
```

## Building from source

The build has a strict order, because the Rust host verifies a SHA-256 hash of every native engine at startup before it loads anything. Build the engines, stage them, regenerate the hashes, *then* build the app. Skip the hash step after changing an engine and the app will refuse to launch (and log to `dbark_fatal.log` rather than telling you on screen).

The atomic `build.ps1` / `build.sh` wrapper that chains the whole thing is on the roadmap. Until it lands, the manual sequence is:

1. **Publish each C# engine with AOT.** The flag form matters — AOT triggering is fussy:

   ```powershell
   dotnet clean
   dotnet publish src-csharp/QueryExecutor -c Release -r win-x64 -p:PublishAot=true
   # ...repeat for the other five engine projects
   ```

   Use `-p:PublishAot=true`, not `-c PublishAot=true` (a no-op) and not `-c Release -p:PublishAot=true` alone if the csproj doesn't set it — `<PublishAot>true</PublishAot>` should be in every engine `.csproj` so the flag isn't load-bearing. Always `dotnet clean` first for a release build: a cached publish stamps a fresh timestamp on stale code, which has cost real debugging hours.

2. **Stage the natives beside the executable** for every target you intend to run (`target/debug`, `target/release`, and the bundle):

   ```powershell
   ./scripts/stage-natives.ps1     # stage-natives.sh on macOS/Linux
   ```

3. **Regenerate the integrity hashes** into `main.rs`:

   ```powershell
   ./update-hashes.ps1
   ```

4. **Build and run the app:**

   ```powershell
   cargo tauri dev      # iterate
   cargo tauri build    # produce installers
   ```

The test project (`QueryExecutor.Tests`) must not be swept into the release publish set — its xunit trim warnings are noise and it shouldn't ship.

## Running tests and lint

```powershell
dotnet test src-csharp/QueryExecutor.Tests   # C# unit tests (batch splitter, native string)
cargo test                                    # Rust host
npm run lint                                  # eslint on the frontend
```

CI runs the build on Windows and macOS. We're moving `dotnet test`, `cargo test`, `cargo clippy -- -D warnings`, and `npm run lint` into CI as required checks — get them green locally before you open a PR.

## The rules that matter (see AGENTS.md for the full text)

**Regression tests are required.** If you fix a bug and the code path can be exercised without standing up a live database or some elaborate harness, your PR adds a test that fails before your fix and passes after. The batch splitter's test suite is the bar to hold the rest of the codebase to. "It needs a real SQL Server to test" is a fair reason to skip a harness-heavy integration test; it is not a reason to skip a unit test on the parsing, string-building, or diff logic underneath it.

**Keep it modular.** Adding a fifth database engine should mean adding one file, not editing the same string `switch` in seven places. New per-engine behaviour goes behind the engine abstraction rather than another `match engine { ... }` scattered across `main.rs`, `QueryExecutor.cs`, `SchemaExplorer.cs`, and friends. If your change copies a connection-string or path-parsing block that already exists elsewhere, centralize it instead.

**No binaries or IDE cache in git, ever.** No `.dll`, `.pdb`, `.so`, `.dylib`, `.zip`, `.db`, no `.vs/`, no `bin/` or `obj/`. CI fails the build if any slip in. The natives are built by CI and attached to the GitHub Release; they don't belong in source. `Cargo.lock` *is* committed (it's an application, so we want reproducible builds) — leave it tracked.

**Credentials live in the OS keychain.** Passwords never go in a TOML file, never cross the IPC boundary into JavaScript, and never get committed. If you're adding a connection field, follow the existing `credential_ref` pattern.

**Regenerate hashes when you touch a native.** Any change to an engine DLL invalidates the integrity check. Run `update-hashes.ps1` before committing, or the next person's build won't launch.

## Pull requests

Fork, branch off `main`, and keep each PR focused on one thing. Make sure tests and lint pass and that the no-binaries check is green. Fill in the PR template — what changed, why, and whether you added tests. For anything security-sensitive, follow the disclosure process in `SECURITY.md` rather than opening a public issue.

Match the surrounding style: `cargo fmt` and `cargo clippy` for Rust, standard C# conventions, and the existing eslint/TypeScript setup for the frontend. When in doubt, make your code look like the file it lives in.
