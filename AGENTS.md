# AGENTS.md — contributor & agent rules for DbArk

> If you already keep a local AGENTS.md, merge the sections below into it rather
> than overwriting. This copy was committed alongside the audit follow-up work.

## Regression tests are required

When a bug is fixed or a non-trivial behaviour is added, add a regression test in
the same change — **whenever a complicated harness is not needed**. The bar is
"can this be pinned with a focused unit test that needs no live DB / built binary
/ network?" If yes, the test is mandatory. If a fix genuinely can only be proven
with a heavy harness (live database, published binary, packet capture), add the
lightweight unit test for whatever logic *is* isolable, and document the manual
harness (script + pass criterion) instead of skipping coverage entirely.

- C# logic: xunit tests in `src-csharp/QueryExecutor.Tests` (the engine projects
  expose internals to it via `InternalsVisibleTo`). Keep the testable core in a
  plain static method and the untestable shell (e.g. `[UnmanagedCallersOnly]`
  exports) trivial, so the core can be unit-tested.
- Rust logic: `#[cfg(test)]` modules / `cargo test`.
- Heavy/manual verification: a script under `scripts/` with an explicit pass
  criterion (see `scripts/soak_ffi.ps1`).

## CI gates (audit §6 — closed)

Every push/PR to `main` must pass, in `.github/workflows/build.yml`:

- `frontend-checks` — `npm run lint` (eslint, 0 errors), `npm test`
  (tsc + vitest), `npm run build` (production type-check + bundle).
- `dotnet-tests` — `dotnet test` on `src-csharp/QueryExecutor.Tests`
  (runs on windows-latest to match the pinned win-x64 RID).
- `rust-fmt` — `cargo fmt --check` (parses only; needs no staged natives).
- `cargo clippy -- -D warnings` and `cargo test` — inside the platform build
  jobs, *after* natives are staged, because `build.rs` intentionally fails
  when `natives/` is incomplete. macOS runs `cargo test` too, to cover the
  OS-conditional paths.
- The platform builds `needs:` all of the above — a build cannot go green
  while tests or linters fail. Do not remove a gate to get a red build
  passing; fix the code, or discuss the rule change in a PR that touches
  only the workflow.

New logic ships with tests per the section above; the gates exist so those
tests actually run.

## Keep code modular and professional

- One responsibility per type/function; no god classes or god components.
- Engine-specific behaviour belongs behind an abstraction, not a `match`/`switch`
  on an engine string copy-pasted across files. Adding an engine should touch one
  place, not seven.
- No duplicated logic — share a single source of truth (a helper, or a
  `<Compile Include>`-linked file like `src-csharp/Shared/NativeString.cs`).
- Don't commit build artifacts, binaries, or IDE caches.

### Decomposing large components (frontend)

`App.tsx` is being reduced from a god component to a thin orchestration shell.
When you touch it, extract rather than extend:

- **Pure logic moves into tested modules.** SQL/DDL string building lives in
  `src/sql/`, query-response and execution-plan reshaping in `src/query/` — each
  a set of pure functions with a sibling `.test.ts`. Any logic that is a pure
  function of its inputs (no refs, no IPC, no DOM) must move out of the component
  and ship with unit tests. These never need a complicated harness, so per
  "Regression tests are required" above the tests are mandatory, not optional.
- **Presentational JSX becomes its own component** under `src/modals/`,
  `src/editor/`, `src/ui/`, etc. No 200-line inline JSX blocks in `App.tsx`.
- **Stateful concerns become custom hooks**, not more inline closures in the
  component body.
- Net direction: `App.tsx` only wires state, hooks, and a lean render tree. Do
  not add new business logic directly to it — put it in a module or hook that
  can be tested on its own.

## DLL integrity hashes (audit C-3 — do not regress)

The startup integrity check (`verify_dll` in `src-tauri/src/main.rs`) compares each
native library in `natives/` against an expected SHA-256. Those expected hashes are
**generated at build time** by `src-tauri/build.rs` into `$OUT_DIR/dll_hashes.rs`
(`DLL_HASHES: &[(&str, &str)]`), computed from the exact bytes that will ship.

- Never hand-edit hashes as `const HASH_*` in source. A frozen constant silently
  diverges from CI-rebuilt NativeAOT libraries (whose output isn't bit-reproducible),
  and the shipped app then fails its own integrity check on launch. CI has a guard
  that fails the build if a `const HASH_*: &str` reappears.
- To enforce a new native library, add its base name to `NATIVE_COMPONENTS` in
  `build.rs` — one place. build.rs resolves the per-platform filename
  (`Foo.dll` / `Foo.dylib` / `libFoo.so`) and fails the build if it's missing.
- build.rs emits `cargo:rerun-if-changed` for every native, so a rebuilt DLL
  re-triggers hash generation automatically. Don't reintroduce a manual hash step.

## FFI string ownership (audit C-1 — do not regress)

Every `[UnmanagedCallersOnly]` entry point returns a buffer allocated with
`Marshal.StringToCoTaskMemUTF8`. That buffer is owned by the Rust host once it
crosses the boundary and **must** be freed by the **same DLL's** exported
`free_string` (the per-runtime allocator means a buffer has to be freed by the
runtime that allocated it).

- C# side: never add a returning entry point without relying on the shared
  `NativeString` / `free_string` export. Don't hand back a buffer with no defined
  free.
- Rust side: read returned pointers through `read_and_free(get_<that_dll>(), ptr)`
  (or `free_cstr` if you handle the copy yourself). Never `into_owned()` a returned
  pointer and drop it un-freed — that is the exact C-1 leak.
- The `free_string` passed to Rust must come from the library that produced the
  pointer. Don't free a `FileQueryEngine` pointer through `QueryExecutor`, etc.

## IPC return contract (audit H-3 — do not regress)

Fallible Tauri commands return the canonical envelope `Result<T, IpcError>`
(`IpcError { code, message }`, defined in `src-tauri/src/main.rs`). Tauri puts
`Err(IpcError)` on the promise-rejection channel, so the frontend has **exactly
one** error path. Do not reintroduce the old ambiguity:

- **Never** return a bare `String` that is JSON on success and a `"ERROR: ..."`
  string on failure, and **never** return a `bool` as a success/failure flag.
  Both hide the failure reason and force call sites to sniff the payload (the
  `startsWith("ERROR")` / `SyntaxError: Unexpected token` class of bug). A `bool`
  is allowed only when it is a genuine value (e.g. `is_tunnel_open`), not a
  status. `scripts/check-ipc-contract.sh` (wired into CI) fails the build on a
  new bare `String`/`bool` command; the permitted-legacy baseline lives in
  `scripts/ipc-contract-allowlist.txt` and shrinks as commands migrate.
- A successful payload carries **no** error channel of its own. The one
  exception is a multi-statement *result set*, where a per-statement error is
  **data** (one statement failed, the batch did not) — that stays inside the
  payload and is not a command failure.
- Legacy `Result<_, String>` bodies migrate mechanically: change the signature
  to `Result<_, IpcError>` and let `?` / `.into()` bridge bare-string errors via
  `From<String> for IpcError` (becomes an `internal` code).
- Frontend: call commands through `ipc()` / `ipcJson()` in `src/ipc.ts`, never
  `invoke` directly. `try { await ipc(...) } catch (e) { /* e is IpcError */ }`
  is the only pattern; surface `toIpcError(e).message`, never `String(e)`.
- The `IpcErrorCode` wire values (`validation`/`native`/`not_found`/`io`/
  `internal`) are pinned by `ipc_error_tests` in `main.rs` and mirrored in the
  `IpcErrorCode` type in `src/ipc.ts`. Change both together, or the single parse
  path breaks silently.

## State management pattern (audit item A-1 — closed)

Frontend state lives in **pure, tested reducers** under `src/state/` — one per
domain: tabs, schemaTree, schemaData, connections (incl. SSH tunnels),
activity, settings, savedQueries, palette, history. Rules for new work:

- **Multi-field transitions are reducer actions, not setter sequences.** If a
  user action changes two or more pieces of state together (open-and-reset,
  save-and-clear, error-and-clear-rows), it must be ONE dispatched action with
  a unit test — never consecutive `setState` calls.
- **Reducers stay pure.** No DOM, no IPC, no `localStorage` inside a reducer.
  Side effects (invokes, persistence) live at the dispatch site; if the
  persisted value must match the next state, compute it with an exported pure
  helper (see `toggledGroup` in `connectionsReducer`).
- **Every action must have a live dispatch site** — no speculative actions.
  Every reducer file has a sibling `.test.ts`; `npm test` type-checks tests
  via `tsconfig.vitest.json` before running them.
- **Plain `useState` is still correct** for independent scalars with no
  combined transitions (e.g. `sidebarWidth`, `locked`, `showDiagram`,
  `showExportMenu`, `recentFiles`, and the theme pair, which is deliberately
  effect-driven — see the comment in `src/types.ts`). Do not reducer-ify a
  lone boolean for its own sake.
