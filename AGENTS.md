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

## Keep code modular and professional

- One responsibility per type/function; no god classes or god components.
- Engine-specific behaviour belongs behind an abstraction, not a `match`/`switch`
  on an engine string copy-pasted across files. Adding an engine should touch one
  place, not seven.
- No duplicated logic — share a single source of truth (a helper, or a
  `<Compile Include>`-linked file like `src-csharp/Shared/NativeString.cs`).
- Don't commit build artifacts, binaries, or IDE caches.

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
