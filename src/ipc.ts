// Single entry point for every Tauri command (audit H-3).
//
// Before this, command results came back in five different shapes — a JSON
// string, a bare "ERROR: ..." string, a `bool` success flag, a rejected
// `Result<_, String>`, or a JSON object with an in-band `error` field — and
// each call site invented its own way of telling success from failure
// (`startsWith("ERROR")`, `if (parsed.error)`, ignoring the bool entirely).
// That ad-hoc sniffing is exactly what produced the
// `SyntaxError: Unexpected token 'E'` crash and the silent-failure class the
// audit flagged.
//
// The contract now: fallible commands return `Result<T, IpcError>` on the Rust
// side, so Tauri rejects the promise with a structured error. Callers use one
// path — `try { await ipc(...) } catch (e) { /* e is IpcError */ }` — and never
// branch on the success payload to discover a failure.

import { invoke } from "@tauri-apps/api/core";
import type { InvokeArgs } from "@tauri-apps/api/core";

/** Stable machine-readable error codes, mirrored from the Rust `IpcErrorCode`. */
export type IpcErrorCode =
  | "validation"
  | "native"
  | "not_found"
  | "io"
  | "internal"
  | "transport"; // frontend-only: the invoke call itself failed to round-trip

/** The single shape every IPC failure is normalized to. */
export interface IpcError {
  code: IpcErrorCode;
  message: string;
}

function isIpcError(x: unknown): x is IpcError {
  return (
    typeof x === "object" &&
    x !== null &&
    "code" in x &&
    "message" in x &&
    typeof (x as { message: unknown }).message === "string"
  );
}

/**
 * Normalize anything thrown by `invoke` into one `IpcError`:
 *  - a structured `Err(IpcError)` from a migrated command — passed through;
 *  - a bare string from a legacy `Result<_, String>` command — wrapped;
 *  - a transport/`Error` — tagged `transport`.
 * This is what makes `String(e)` ("[object Object]") impossible at call sites.
 */
export function toIpcError(e: unknown): IpcError {
  if (isIpcError(e)) return e;
  if (typeof e === "string") return { code: "internal", message: e };
  if (e instanceof Error) return { code: "transport", message: e.message };
  return { code: "internal", message: String(e) };
}

/**
 * Invoke a Tauri command. Resolves with the payload, or throws a normalized
 * `IpcError`. Use this for every command instead of importing `invoke`
 * directly — it guarantees the single error path.
 */
export async function ipc<T = void>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    throw toIpcError(e);
  }
}

/**
 * For commands whose successful payload is itself a JSON string (the legacy
 * `-> String` / `Result<String, _>` shape). Parses in exactly one place; a
 * payload that fails to parse becomes a normalized error instead of an uncaught
 * `SyntaxError: Unexpected token` at the call site.
 */
export async function ipcJson<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  const raw = await ipc<string>(cmd, args);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw { code: "internal", message: `Malformed response from ${cmd}` } as IpcError;
  }
}
