//! OS-keychain credential management. Passwords never sit in TOML files and
//! never cross the IPC boundary to JavaScript — connections reference a
//! `credential_ref`, and the string is fetched only at point of use.
//!
//! `migrate_credential` lives here so
//! deleting the migration path post-v1.0 is a one-file change.

use crate::ipc::IpcError;

#[tauri::command]
pub fn store_credential(
    target: String,
    username: String,
    password: String,
) -> Result<(), IpcError> {
    let entry = keyring::Entry::new(&target, &username)
        .map_err(|e| IpcError::native(format!("Keychain unavailable: {e}")))?;
    entry
        .set_password(&password)
        .map_err(|e| IpcError::native(format!("Failed to store credential: {e}")))
}

#[tauri::command]
pub fn delete_credential(target: String) -> Result<(), IpcError> {
    let username = target.split(':').nth(2).unwrap_or("").to_string();
    let entry = keyring::Entry::new(&target, &username)
        .map_err(|e| IpcError::native(format!("Keychain unavailable: {e}")))?;
    match entry.delete_password() {
        Ok(()) => Ok(()),
        // Deleting a credential that isn't there is a no-op success, not a
        // failure. Many connections legitimately have no stored secret (SQLite,
        // Windows-auth, password-less, or DBeaver-imported without a password),
        // so treating NoEntry as an error stranded their deletion in the UI.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(IpcError::native(format!(
            "Failed to delete credential: {e}"
        ))),
    }
}

#[tauri::command]
pub fn get_ssh_password(target: String, username: String) -> Result<String, IpcError> {
    let entry = keyring::Entry::new(&target, &username).map_err(|e| e.to_string())?;
    entry
        .get_password()
        .map_err(|e| IpcError::native(e.to_string()))
}

#[tauri::command]
pub fn migrate_credential(
    old_target: String,
    new_target: String,
    username: String,
) -> Result<bool, IpcError> {
    // A missing OLD credential is not an error — there is simply nothing to
    // migrate (Ok(false)). Only a failed write to the NEW entry is a real
    // failure, because it would strand the user's password under the old ref.
    let old_entry = match keyring::Entry::new(&old_target, &username) {
        Ok(e) => e,
        Err(_) => return Ok(false),
    };
    let password = match old_entry.get_password() {
        Ok(p) => p,
        Err(_) => return Ok(false), // no old credential — nothing to migrate
    };

    // Write to new entry
    let new_entry = keyring::Entry::new(&new_target, &username)
        .map_err(|e| IpcError::native(format!("Keychain error: {e}")))?;
    new_entry.set_password(&password).map_err(|e| {
        IpcError::native(format!(
            "Could not write credential '{new_target}' to the OS keychain: {e}"
        ))
    })?;

    // Delete old entry (best-effort — a leftover old entry is harmless)
    let _ = old_entry.delete_password();
    Ok(true)
}
