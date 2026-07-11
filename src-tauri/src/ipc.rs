//! The canonical IPC error envelope (audit H-3).
//!
//! Every fallible `#[tauri::command]` returns `Result<T, IpcError>`. Tauri
//! serializes `Err(IpcError)` onto the promise-rejection channel, so the
//! frontend has exactly one error path (`catch`) and never has to sniff a
//! success payload for a bare `"ERROR:"` string or an in-band `{"error": ...}`
//! field. Successful payloads carry no error channel of their own.

use crate::engine::EngineError;

/// Canonical error envelope for fallible IPC commands (audit H-3).
///
/// `code` is a stable, machine-readable tag the UI can branch on without
/// parsing `message`; `message` is human-readable and safe to surface directly.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct IpcError {
    pub code: IpcErrorCode,
    pub message: String,
}

#[derive(serde::Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IpcErrorCode {
    /// Caller-supplied input failed a validation rule.
    Validation,
    /// A native (C#/FFI) call failed or returned no/non-ok response.
    Native,
    /// A requested entity (file, connection, saved query) does not exist.
    NotFound,
    /// Filesystem / IO failure.
    Io,
    /// Anything not covered above.
    Internal,
}

impl IpcError {
    pub fn validation(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Validation,
            message: msg.into(),
        }
    }
    pub fn native(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Native,
            message: msg.into(),
        }
    }
    #[allow(dead_code)]
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::NotFound,
            message: msg.into(),
        }
    }
    #[allow(dead_code)]
    pub fn io(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Io,
            message: msg.into(),
        }
    }
    #[allow(dead_code)]
    pub fn internal(msg: impl Into<String>) -> Self {
        Self {
            code: IpcErrorCode::Internal,
            message: msg.into(),
        }
    }
}

/// Bridges legacy `Result<_, String>` bodies into the envelope with a plain `?`
/// or `.into()`: a bare error string becomes a structured `internal` error
/// rather than silently changing the wire shape. This lets the remaining
/// `Result<String, String>` commands migrate mechanically (see the H-3
/// migration checklist) without rewriting their error sites by hand.
impl From<String> for IpcError {
    fn from(message: String) -> Self {
        Self {
            code: IpcErrorCode::Internal,
            message,
        }
    }
}
impl From<&str> for IpcError {
    fn from(message: &str) -> Self {
        Self::from(message.to_string())
    }
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

/// Map engine-layer errors onto the IPC envelope (audit A-2): the engine
/// module knows nothing about IPC, and the wire shape the frontend sees is
/// unchanged — an unsupported engine is `validation`, missing credentials are
/// `not_found`, keychain plumbing failures are `internal`.
impl From<EngineError> for IpcError {
    fn from(e: EngineError) -> Self {
        match &e {
            EngineError::Unsupported(_) => IpcError::validation(e.to_string()),
            EngineError::CredentialNotFound(_) | EngineError::NoPassword(_) => {
                IpcError::not_found(e.to_string())
            }
            EngineError::Keychain(_) => IpcError::internal(e.to_string()),
        }
    }
}

#[cfg(test)]
mod ipc_error_tests {
    use super::{IpcError, IpcErrorCode};

    // The frontend `ipc()` wrapper branches on `code` and surfaces `message`
    // verbatim. These tests pin the exact wire shape so a rename or a serde
    // attribute change can't silently break that single parse path (audit H-3).

    #[test]
    fn serializes_to_stable_code_and_message() {
        let json = serde_json::to_string(&IpcError::validation("bad color")).unwrap();
        assert_eq!(json, r#"{"code":"validation","message":"bad color"}"#);
    }

    #[test]
    fn every_code_serializes_snake_case() {
        let cases = [
            (IpcErrorCode::Validation, "validation"),
            (IpcErrorCode::Native, "native"),
            (IpcErrorCode::NotFound, "not_found"),
            (IpcErrorCode::Io, "io"),
            (IpcErrorCode::Internal, "internal"),
        ];
        for (code, wire) in cases {
            let err = IpcError {
                code,
                message: String::new(),
            };
            let json = serde_json::to_string(&err).unwrap();
            assert!(
                json.contains(&format!(r#""code":"{wire}""#)),
                "code {code:?} should serialize as {wire:?}, got {json}"
            );
        }
    }

    #[test]
    fn bare_string_bridges_to_internal() {
        // legacy `Result<_, String>` error sites become structured `internal`
        let err: IpcError = "something went wrong".to_string().into();
        assert_eq!(err.code, IpcErrorCode::Internal);
        assert_eq!(err.message, "something went wrong");
    }
}
