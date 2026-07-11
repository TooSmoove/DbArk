#!/usr/bin/env bash
# check-ipc-contract.sh — audit H-3 guard.
#
# Fallible Tauri commands must return the canonical `Result<T, IpcError>`
# envelope so the frontend has exactly one error path. A command that returns a
# bare `String` (JSON *or* a "ERROR:" string) or a `bool` success flag is the
# ambiguity H-3 set out to remove.
#
# This guard fails if a `#[tauri::command]` returns bare `String`/`bool` and is
# not in scripts/ipc-contract-allowlist.txt. The allowlist is the documented
# migration baseline; adding a NEW bare String/bool command fails CI, migrating
# one off the list (deleting its line) is always fine.
#
# Mirrors the existing C-3 (hardcoded-hash) and devsql grep gates in build.yml.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_RS="$ROOT/src-tauri/src/main.rs"
ALLOWLIST="$ROOT/scripts/ipc-contract-allowlist.txt"

# Allowed command names (strip comments / blanks).
allowed="$(grep -vE '^\s*(#|$)' "$ALLOWLIST" | tr -d ' ' || true)"

# Find every `#[tauri::command]` whose fn signature returns bare String or bool,
# and capture the fn name. The signature is accumulated from the attribute to
# the body's opening `{` so MULTILINE signatures are seen too — a fixed grep
# window (-A2) let `migrate_credential (-> bool)` hide for months until
# rustfmt collapsed its signature onto one line.
offenders="$(
  awk '
    /#\[tauri::command\]/ { collecting = 1; sig = ""; next }
    collecting {
      sig = sig " " $0
      if (index($0, "{")) {
        if (sig ~ /-> *(String|bool) *\{/ && match(sig, /fn [a-z_]+/)) {
          name  = substr(sig, RSTART + 3, RLENGTH - 3)
          rtype = (sig ~ /-> *String *\{/) ? "String" : "bool"
          print name, rtype
        }
        collecting = 0
      }
    }
  ' "$MAIN_RS" || true
)"

fail=0
while read -r name rtype; do
  [ -z "${name:-}" ] && continue
  if ! grep -qx "$name" <<<"$allowed"; then
    if [ "$fail" -eq 0 ]; then
      echo "::error::New bare '$rtype'-returning Tauri command(s) found — return Result<T, IpcError> instead (audit H-3):"
    fi
    echo "  - $name (-> $rtype)"
    fail=1
  fi
done <<<"$offenders"

if [ "$fail" -ne 0 ]; then
  echo "If a bare bool is a genuine value (not a success flag), add it to scripts/ipc-contract-allowlist.txt with a comment."
  exit 1
fi

echo "OK: every fallible IPC command returns Result<_, IpcError> (allowlisted legacy commands excepted)."
