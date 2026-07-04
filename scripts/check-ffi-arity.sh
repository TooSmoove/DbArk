#!/usr/bin/env bash
# check-ffi-arity.sh — FFI signature-drift guard.
#
# The C# `execute_query` export takes FIVE pointer args. Declaring the symbol
# with any other arity at a call site makes NativeAOT read a garbage stack slot
# and fail-fast with an AccessViolation — a crash-to-desktop, not an error
# dialog. Exactly that shipped once: row_limit was added as the fifth arg, the
# main query path was updated, and four hand-copied call sites kept the stale
# four-arg declaration (the "Test Connection" CTD).
#
# The fix was one shared `call_execute_query` helper in main.rs owning the
# declaration. This guard keeps it that way: the raw symbol lookup must appear
# EXACTLY once. A second lookup means someone re-declared the signature at a
# call site — route it through the helper instead.
#
# Mirrors the H-3 check-ipc-contract.sh grep-gate pattern.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_RS="$ROOT/src-tauri/src/main.rs"

count="$(grep -c 'b"execute_query"' "$MAIN_RS" || true)"

if [ "$count" -ne 1 ]; then
  echo "::error::Found $count lookups of b\"execute_query\" in main.rs (expected exactly 1, inside call_execute_query). Do not re-declare the FFI signature at call sites — call call_execute_query() instead."
  exit 1
fi

echo "FFI arity guard OK: execute_query symbol is looked up only inside call_execute_query()."
