//! fatal.rs — single entry point for unrecoverable startup failures.
//!
//! Turns an unrecoverable error into (1) a persisted log line and (2) a
//! user-visible native dialog, then (for hard-fatal cases) exits the process.
//! This is the ONLY place that should turn a startup failure into a process
//! exit, so the user always gets a window instead of a silent no-window exit in
//! a `windows_subsystem = "windows"` release build (where stderr is dead).
//!
//! `rfd` is used rather than the Windows-only `windows` crate MessageBoxW so the
//! same path serves Windows, macOS and Linux (all launch targets). On Windows
//! rfd calls user32!MessageBoxW — a system DLL that is NOT one of the
//! integrity-checked app DLLs, so it is safe to call from inside the
//! integrity-failure path itself.

use std::fmt::Display;
use std::path::PathBuf;

/// Where fatal startup diagnostics are written. `temp_dir()` is always writable;
/// the exe dir (e.g. Program Files) frequently is not. Matches the existing
/// dbark_fatal.log / dbark_panic.log convention already used in main().
fn fatal_log_path() -> PathBuf {
    std::env::temp_dir().join("dbark_fatal.log")
}

fn panic_log_path() -> PathBuf {
    std::env::temp_dir().join("dbark_panic.log")
}

/// Pure, side-effect-free message builder — the regression-tested core. Given
/// the stage, the technical detail, and the resolved log path, produces the
/// exact text the user sees. No I/O, no dialog, no exit, so it is trivially
/// testable with no harness.
pub fn format_fatal_message(stage: &str, detail: &str, log_path: &str) -> String {
    format!(
        "DbArk could not start.\n\n\
         {stage} failed:\n{detail}\n\n\
         A diagnostic log was written to:\n{log_path}\n\n\
         If this keeps happening, attach that log to a GitHub issue."
    )
}

/// Blocking native error dialog. `let _ =` discards the return so this compiles
/// across rfd versions (older `show()` returns `bool`; newer returns
/// `MessageDialogResult`, which is `#[must_use]`).
pub(crate) fn show_error_dialog(title: &str, body: &str) {
    let _ = rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title(title)
        .set_description(body)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// Report an unrecoverable startup failure and terminate the process.
/// Order matters: log first (detail is persisted even if the dialog backend
/// itself dies), then show the dialog, then exit non-zero.
pub fn report_fatal(stage: &str, detail: impl Display) -> ! {
    let detail = detail.to_string();
    let _ = std::fs::write(
        fatal_log_path(),
        format!("FATAL during {stage}: {detail}\n"),
    );
    let body = format_fatal_message(stage, &detail, &fatal_log_path().to_string_lossy());
    show_error_dialog("DbArk \u{2014} startup failed", &body);
    std::process::exit(1);
}

/// Route a panic through both the log file and a visible dialog. Does NOT exit —
/// the runtime's default panic behaviour proceeds after the hook returns. This
/// is what catches the "missing dependency" case: a hash-valid DLL that fails to
/// *load* (e.g. duckdb.dll missing its VC++ runtime) panics out of the `.expect`
/// on `libloading::Library::new`, and without this the user saw nothing.
///
/// Reliable for startup-time panics (main thread, before the Tauri event loop).
/// Panics on worker threads after launch may not display a dialog on every
/// platform — but startup failures, the target of this task, are covered.
pub fn report_panic(message: &str) {
    let _ = std::fs::write(panic_log_path(), format!("PANIC: {message}\n"));
    let body = format!(
        "DbArk hit an unexpected error and must close.\n\n{message}\n\n\
         A diagnostic log was written to:\n{}",
        panic_log_path().to_string_lossy()
    );
    show_error_dialog("DbArk \u{2014} unexpected error", &body);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_names_the_failing_stage() {
        let m = format_fatal_message(
            "DLL integrity check",
            "Hash mismatch for ConnectionManager.dll",
            "/tmp/dbark_fatal.log",
        );
        assert!(m.contains("DLL integrity check failed"));
    }

    #[test]
    fn message_includes_the_detail() {
        let m = format_fatal_message(
            "DLL integrity check",
            "Hash mismatch for ConnectionManager.dll",
            "/tmp/dbark_fatal.log",
        );
        assert!(m.contains("Hash mismatch for ConnectionManager.dll"));
    }

    #[test]
    fn message_includes_the_log_path() {
        let m = format_fatal_message("startup", "boom", "/tmp/dbark_fatal.log");
        assert!(m.contains("/tmp/dbark_fatal.log"));
    }

    #[test]
    fn message_is_multiline() {
        let m = format_fatal_message("startup", "boom", "/tmp/x.log");
        assert!(m.lines().count() > 3);
    }
}
