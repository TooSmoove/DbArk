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

#[tauri::command]
fn load_connection(path: String) -> String {
    unsafe {
        let lib = Library::new("natives/QueryExecutor.dll")
            .expect("Failed to load QueryExecutor.dll");

        let func: Symbol<unsafe extern "C" fn(*const i8) -> *const i8> = lib
            .get(b"load_connection")
            .expect("Failed to find load_connection export");

        let c_path = CString::new(path).expect("CString failed");
        let result_ptr = func(c_path.as_ptr());

        if result_ptr.is_null() {
            return "ERROR: null response".to_string();
        }

        std::ffi::CStr::from_ptr(result_ptr)
            .to_string_lossy()
            .into_owned()
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![test_connection, load_connection])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}