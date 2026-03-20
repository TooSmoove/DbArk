// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use libloading::{Library, Symbol};
use std::ffi::CString;

#[tauri::command]
fn test_connection(connection_string: String) -> bool {
    unsafe {
        // Load the C# native library
        let lib = Library::new("natives/QueryExecutor.dll")
            .expect("Failed to load QueryExecutor.dll");

        // Get the exported function
        let func: Symbol<unsafe extern "C" fn(*const i8) -> i32> = lib
            .get(b"test_connection")
            .expect("Failed to find test_connection export");

        // Convert the Rust String to a C string
        let c_string = CString::new(connection_string)
            .expect("CString conversion failed");

        // Call the C# function
        let result = func(c_string.as_ptr());
        result == 1
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![test_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}