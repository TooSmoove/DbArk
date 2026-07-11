//! Tauri IPC command handlers, grouped by domain (audit A-2 residual).
//!
//! Each submodule owns one slice of the IPC surface; `main.rs` only registers
//! them. Command names, argument shapes, and JSON payloads are wire-frozen —
//! see `scripts/check-ipc-contract.sh`.

pub mod activity;
pub mod connections;
pub mod credentials;
pub mod history;
pub mod query;
pub mod schema;
pub mod tunnel;
