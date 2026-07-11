//! Native (C# NativeAOT) library loading, integrity checking, and FFI string
//! plumbing — the single home for every raw `libloading` concern.
//!
//! The startup order is enforced by `main()`: every staged library's SHA-256 is
//! verified against the build-generated manifest *before* any loader here runs,
//! so a loader reaching a load (not hash) failure means a missing transitive
//! dependency — which the fatal dialog names instead of vanishing silently in a
//! `windows_subsystem` release build.

use std::ffi::{c_char, CStr, CString};
use std::path::PathBuf;
use std::sync::OnceLock;

use sha2::{Digest, Sha256};

use crate::fatal;
use crate::ipc::IpcError;

pub(crate) fn natives_dir() -> PathBuf {
    // Load-path failure: if we cannot locate our own executable we cannot find a
    // single native library, so route through report_fatal for a named dialog +
    // log line and a clean exit rather than a bare panic (code audit H-4).
    let exe = std::env::current_exe()
        .unwrap_or_else(|e| fatal::report_fatal("Locating the executable", e));
    let parent = exe.parent().unwrap_or_else(|| {
        fatal::report_fatal(
            "Locating the executable",
            format!("{} has no parent directory", exe.display()),
        )
    });
    parent.join("natives")
}

pub(crate) fn native_path(dll: &str) -> String {
    natives_dir().join(dll).to_string_lossy().into_owned()
}

/// Convert an owned string into a `CString` for the FFI boundary, mapping an
/// interior NUL byte onto the one canonical validation error every command
/// previously built by hand at each call site.
pub(crate) fn to_cstring(s: impl Into<Vec<u8>>) -> Result<CString, IpcError> {
    CString::new(s).map_err(|_| {
        IpcError::validation("input contains a NUL byte and cannot be passed to the native layer")
    })
}

/// The one error message for a missing native export, formatted identically at
/// every command (previously copy-pasted per call site).
pub(crate) fn missing_export(name: &str, e: libloading::Error) -> IpcError {
    IpcError::native(format!(
        "Native export `{name}` is unavailable — your DbArk install may be corrupt; reinstall. ({e})"
    ))
}

/// Release a CoTaskMem buffer a C# DLL handed back across the FFI boundary by
/// calling that DLL's exported `free_string` (Marshal.FreeCoTaskMem on the C#
/// side). Audit C-1: before this, every returned string was copied with
/// `into_owned()` and the raw pointer dropped un-freed, leaking one buffer per
/// query/schema/history call.
///
/// `lib` MUST be the library that produced `ptr`. The buffer has to be released
/// by the runtime that allocated it — on Windows CoTaskMem is process-global, but
/// on macOS/Linux NativeAOT uses a per-runtime allocator, so freeing through the
/// wrong DLL would be undefined behaviour. If the `free_string` export is missing
/// we skip the free (a tiny leak is strictly safer than a bad free).
///
/// # Safety
/// `ptr` must be a pointer returned by a `free_string`-exporting C# DLL, or null.
pub(crate) unsafe fn free_cstr(lib: &libloading::Library, ptr: *const c_char) {
    if ptr.is_null() {
        return;
    }
    if let Ok(free) = lib.get::<unsafe extern "C" fn(*const c_char)>(b"free_string") {
        free(ptr);
    }
}

/// Copy a non-null UTF-8 C string returned by a C# DLL into an owned Rust
/// `String`, then free the C#-allocated buffer via `free_cstr`. Call sites guard
/// `ptr.is_null()` before reaching here (the null branch supplies the fallback),
/// so this assumes `ptr` is non-null.
///
/// # Safety
/// `ptr` must be a non-null, NUL-terminated UTF-8 buffer produced by `lib`.
pub(crate) unsafe fn read_and_free(lib: &libloading::Library, ptr: *const c_char) -> String {
    let owned = CStr::from_ptr(ptr).to_string_lossy().into_owned();
    free_cstr(lib, ptr);
    owned
}

pub(crate) fn verify_dll(path: &str, expected_hex: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Could not read {path}: {e}"))?;
    let hash = hex::encode(Sha256::digest(&bytes));
    if hash != expected_hex {
        return Err(format!(
            "Hash mismatch for {path}\n  expected: {expected_hex}\n  got:      {hash}"
        ));
    }
    Ok(())
}

// DLL integrity hashes are generated at build time by build.rs into
// $OUT_DIR/dll_hashes.rs as `DLL_HASHES: &[(&str, &str)]`, derived from the exact
// libraries staged in natives/ when the app is compiled. A rebuilt native can
// therefore never silently diverge from a frozen, hand-edited constant — which was
// the failure mode in code audit C-3 (CI rebuilds the NativeAOT DLLs, whose output
// is not bit-reproducible, so they no longer matched the committed hashes and the
// app fatally failed its own integrity check on launch).
include!(concat!(env!("OUT_DIR"), "/dll_hashes.rs"));

/// Resolve a logical native component (e.g. `QueryExecutor`) to the exact file
/// name that was staged and hashed at build time, by reading the build-generated
/// `DLL_HASHES` manifest. The loader and the startup integrity check therefore
/// share ONE source of truth for the file name — including its per-platform
/// extension (`.dll` / `.dylib` / `.so`) and any unix `lib` prefix — so the two
/// can never disagree.
///
/// Code audit H-4: the loaders previously hard-coded `QueryExecutor.dll`, which
/// could not load the `QueryExecutor.dylib` the macOS build actually stages and
/// verifies — silently breaking the cross-platform claim. Pure inner helper kept
/// separate from the global manifest so it is unit-testable with a fixture and no
/// harness (AGENTS.md: regression tests required where no complex harness is needed).
fn resolve_native_file<'a>(manifest: &[(&'a str, &str)], base: &str) -> Option<&'a str> {
    manifest.iter().map(|(file, _)| *file).find(|file| {
        let stem = std::path::Path::new(file)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        stem == base || stem.strip_prefix("lib") == Some(base)
    })
}

fn native_file_for(base: &str) -> Option<&'static str> {
    resolve_native_file(DLL_HASHES, base)
}

/// Load a native component by base name, routing every failure through
/// `report_fatal` so a load problem yields a named dialog + log line and a clean
/// exit — instead of panicking out of a lazy `OnceLock::get_or_init`, which left
/// the user with an opaque crash (code audit H-4: load-path `.expect()`s).
fn load_native(base: &str) -> libloading::Library {
    let file = native_file_for(base).unwrap_or_else(|| {
        fatal::report_fatal(
            "Native library load",
            format!(
                "No staged file for component `{base}` in the build manifest — \
                 this install is incomplete. Reinstall DbArk."
            ),
        )
    });
    let path = native_path(file);
    // SAFETY: `file` is a build-staged native whose SHA-256 was verified at startup
    // before any load is attempted.
    unsafe {
        libloading::Library::new(&path).unwrap_or_else(|e| {
            fatal::report_fatal(
                "Native library load",
                format!("Could not load {file}\n  path: {path}\n  {e}"),
            )
        })
    }
}

/// Verify every staged native library against the build-generated manifest,
/// routing the first mismatch through `report_fatal`. Called by `main()` before
/// any loader runs — the ordering (verify bytes, then load) is the point of the
/// integrity check, so keep this the first native-related call in startup.
pub(crate) fn verify_startup_integrity() {
    for (lib, expected) in DLL_HASHES {
        let path = native_path(lib);
        if let Err(reason) = verify_dll(&path, expected) {
            fatal::report_fatal("DLL integrity check", reason);
        }
    }
}

/// Eagerly load every native library (the `OnceLock`s make this idempotent).
/// Startup calls this once so first use of each command doesn't pay the load
/// cost — and so a broken install fails at launch, not mid-session.
pub(crate) fn preload_all() {
    get_sqlcipher();
    get_query_executor();
    get_connection_manager();
    get_file_query_engine();
    get_schema_explorer();
    get_query_history();
    get_ssh_tunnel();
}

static SSH_TUNNEL: OnceLock<libloading::Library> = OnceLock::new();
static QUERY_EXECUTOR: OnceLock<libloading::Library> = OnceLock::new();
static CONNECTION_MANAGER: OnceLock<libloading::Library> = OnceLock::new();
static FILE_QUERY_ENGINE: OnceLock<libloading::Library> = OnceLock::new();
static SCHEMA_EXPLORER: OnceLock<libloading::Library> = OnceLock::new();
static QUERY_HISTORY: OnceLock<libloading::Library> = OnceLock::new();
static SQLCIPHER: OnceLock<libloading::Library> = OnceLock::new();

pub(crate) fn get_query_executor() -> &'static libloading::Library {
    QUERY_EXECUTOR.get_or_init(|| load_native("QueryExecutor"))
}

pub(crate) fn get_connection_manager() -> &'static libloading::Library {
    CONNECTION_MANAGER.get_or_init(|| load_native("ConnectionManager"))
}

pub(crate) fn get_file_query_engine() -> &'static libloading::Library {
    FILE_QUERY_ENGINE.get_or_init(|| load_native("FileQueryEngine"))
}

pub(crate) fn get_schema_explorer() -> &'static libloading::Library {
    SCHEMA_EXPLORER.get_or_init(|| load_native("SchemaExplorer"))
}

pub(crate) fn get_query_history() -> &'static libloading::Library {
    QUERY_HISTORY.get_or_init(|| load_native("QueryHistory"))
}

pub(crate) fn get_ssh_tunnel() -> &'static libloading::Library {
    SSH_TUNNEL.get_or_init(|| load_native("SshTunnel"))
}

pub(crate) fn get_sqlcipher() -> &'static libloading::Library {
    SQLCIPHER.get_or_init(|| load_native("sqlcipher"))
}

#[cfg(test)]
mod native_resolve_tests {
    use super::resolve_native_file;

    // Fixtures mirror what build.rs emits into DLL_HASHES per platform; the hash
    // column is irrelevant to name resolution, so the values are placeholders.
    const WIN: &[(&str, &str)] = &[("QueryExecutor.dll", "h"), ("sqlcipher.dll", "h")];
    const MAC: &[(&str, &str)] = &[("QueryExecutor.dylib", "h"), ("sqlcipher.dylib", "h")];
    const LIN: &[(&str, &str)] = &[("libQueryExecutor.so", "h"), ("libsqlcipher.so", "h")];

    #[test]
    fn resolves_windows_dll() {
        assert_eq!(
            resolve_native_file(WIN, "QueryExecutor"),
            Some("QueryExecutor.dll")
        );
    }

    #[test]
    fn resolves_macos_dylib() {
        assert_eq!(
            resolve_native_file(MAC, "QueryExecutor"),
            Some("QueryExecutor.dylib")
        );
    }

    #[test]
    fn resolves_linux_lib_prefixed_so() {
        // The exact case the hard-coded `.dll` loader (audit H-4) could never satisfy.
        assert_eq!(
            resolve_native_file(LIN, "QueryExecutor"),
            Some("libQueryExecutor.so")
        );
    }

    #[test]
    fn unknown_component_is_none() {
        assert_eq!(resolve_native_file(WIN, "DoesNotExist"), None);
    }

    #[test]
    fn does_not_partial_match_a_longer_name() {
        // `Query` must not resolve to `QueryExecutor.dll`.
        assert_eq!(resolve_native_file(WIN, "Query"), None);
    }
}
