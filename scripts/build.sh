#!/usr/bin/env bash
# build.sh — the one locked, atomic build for DbArk (macOS/Linux).
#
# Mirror of build.ps1. Makes src-tauri/natives/ correct, then hands off to cargo;
# build.rs re-hashes natives/ from the exact shipping bytes on its own. No manual
# hash step. Sequence: AOT-publish each engine -> stage duckdb+sqlcipher -> build.
#
#   ./scripts/build.sh                  # full release build
#   ./scripts/build.sh --dev            # full prep, then `cargo tauri dev`
#   ./scripts/build.sh --skip-natives   # engines + build only
#   ./scripts/build.sh --engines FileQueryEngine --skip-natives --dev   # fast loop
#   ./scripts/build.sh --no-build       # stage natives only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NATIVES="$ROOT/src-tauri/natives"

ENGINES=(ConnectionManager FileQueryEngine QueryExecutor QueryHistory SchemaExplorer SshTunnel)
RID=""; DEV=0; SKIP_ENGINES=0; SKIP_NATIVES=0; CLEAN_TARGET=0; NO_BUILD=0

while [ $# -gt 0 ]; do
    case "$1" in
        --runtime)      RID="$2"; shift 2 ;;
        --engines)      IFS=',' read -ra ENGINES <<< "$2"; shift 2 ;;
        --dev)          DEV=1; shift ;;
        --skip-engines) SKIP_ENGINES=1; shift ;;
        --skip-natives) SKIP_NATIVES=1; shift ;;
        --clean-target) CLEAN_TARGET=1; shift ;;
        --no-build)     NO_BUILD=1; shift ;;
        *) echo "unknown arg: $1" >&2; exit 1 ;;
    esac
done

case "$(uname -s)" in
    Darwin) EXT="dylib" ;;
    Linux)  EXT="so" ;;
    *) echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
esac

START=$(date +%s)

# --- 1. AOT-publish the engines into natives/ --------------------------------
if [ "$SKIP_ENGINES" -eq 0 ]; then
    for e in "${ENGINES[@]}"; do
        echo; echo "==== [1/3] publish engine: $e ===="
        if [ -n "$RID" ]; then "$SCRIPT_DIR/publish-engine.sh" "$e" "$RID"
        else                   "$SCRIPT_DIR/publish-engine.sh" "$e"; fi
    done
else
    echo "==== [1/3] engines: SKIPPED ===="
fi

# --- 2. Stage third-party natives --------------------------------------------
if [ "$SKIP_NATIVES" -eq 0 ]; then
    echo; echo "==== [2/3] stage third-party natives ===="
    [ -x "$SCRIPT_DIR/stage-natives.sh" ] || { echo "missing/exec: $SCRIPT_DIR/stage-natives.sh" >&2; exit 1; }
    "$SCRIPT_DIR/stage-natives.sh"
else
    echo "==== [2/3] third-party natives: SKIPPED ===="
fi

# --- completeness + freshness guard ------------------------------------------
# Each component resolves as <name>.$EXT or lib<name>.$EXT (build.rs accepts both).
resolve() { [ -f "$NATIVES/$1.$EXT" ] && echo "$NATIVES/$1.$EXT" || { [ -f "$NATIVES/lib$1.$EXT" ] && echo "$NATIVES/lib$1.$EXT"; }; }
PROBLEMS=()
for r in "${ENGINES[@]}" duckdb sqlcipher; do
    f="$(resolve "$r" || true)"
    if [ -z "$f" ]; then PROBLEMS+=("missing: $r.$EXT in natives/"); continue; fi
    if [ "$SKIP_ENGINES" -eq 0 ] && printf '%s\n' "${ENGINES[@]}" | grep -qx "$r"; then
        mt=$(stat -c%Y "$f" 2>/dev/null || stat -f%m "$f")
        [ "$mt" -ge "$START" ] || PROBLEMS+=("STALE: $(basename "$f") not refreshed this run — AOT publish likely failed silently")
    fi
done
if [ "${#PROBLEMS[@]}" -gt 0 ]; then
    printf '  %s\n' "${PROBLEMS[@]}" >&2
    echo "natives/ is not in a shippable state (see above)." >&2; exit 1
fi
echo "natives/ complete and fresh."

if [ "$NO_BUILD" -eq 1 ]; then echo "Done (no build)."; exit 0; fi

# --- 3. cargo tauri build|dev — build.rs re-hashes natives/ automatically -----
cd "$ROOT"
[ "$CLEAN_TARGET" -eq 1 ] && { echo "==> cargo clean"; cargo clean; }
echo; echo "==== [3/3] cargo tauri $([ "$DEV" -eq 1 ] && echo dev || echo build) ===="
if [ "$DEV" -eq 1 ]; then cargo tauri dev; else cargo tauri build; fi
echo "Build complete in $(( $(date +%s) - START ))s."
