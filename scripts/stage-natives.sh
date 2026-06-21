#!/usr/bin/env bash
# Stage prebuilt third-party native libraries (DuckDB + SQLCipher) into
# src-tauri/natives/ so build.rs's completeness check passes and the app can
# load them at runtime.
#
# These libraries are NOT committed to git (see .gitignore). CI and local
# builds fetch them fresh and version-pinned. This is the third-party half of
# the build; the six C# NativeAOT engines come from `dotnet publish`.
#
# Keep the version pins below in sync with scripts/stage-natives.ps1.
set -euo pipefail

# --- version pins -----------------------------------------------------------
DUCKDB_VERSION="1.5.0"          # must match the DuckDB C API the app builds against
SQLCIPHER_PKG_VERSION="2.1.11"  # SQLitePCLRaw.lib.e_sqlcipher (exports sqlite3_* + sqlite3_key)
# ---------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVES="$ROOT/src-tauri/natives"
mkdir -p "$NATIVES"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$(uname -s)" in
  Darwin)
    DUCKDB_ASSET="libduckdb-osx-universal.zip"   # universal: arm64 + x86_64
    DUCKDB_LIB="libduckdb.dylib";  DUCKDB_OUT="libduckdb.dylib"
    SQLCIPHER_RID="osx-arm64"                    # switch to osx-x64 for Intel runners
    SQLCIPHER_SRC="libe_sqlcipher.dylib"; SQLCIPHER_OUT="libsqlcipher.dylib"
    ;;
  Linux)
    DUCKDB_ASSET="libduckdb-linux-amd64.zip"     # use libduckdb-linux-aarch64.zip on arm64
    DUCKDB_LIB="libduckdb.so";     DUCKDB_OUT="libduckdb.so"
    SQLCIPHER_RID="linux-x64"
    SQLCIPHER_SRC="libe_sqlcipher.so";    SQLCIPHER_OUT="libsqlcipher.so"
    ;;
  *)
    echo "stage-natives.sh: unsupported OS '$(uname -s)' — use stage-natives.ps1 on Windows" >&2
    exit 1
    ;;
esac

echo "==> DuckDB ${DUCKDB_VERSION} (${DUCKDB_ASSET})"
curl -fL --retry 3 -o "$WORK/duckdb.zip" \
  "https://github.com/duckdb/duckdb/releases/download/v${DUCKDB_VERSION}/${DUCKDB_ASSET}"
unzip -o "$WORK/duckdb.zip" "$DUCKDB_LIB" -d "$WORK/duckdb" >/dev/null
cp "$WORK/duckdb/$DUCKDB_LIB" "$NATIVES/$DUCKDB_OUT"

echo "==> SQLCipher (SQLitePCLRaw.lib.e_sqlcipher ${SQLCIPHER_PKG_VERSION}, ${SQLCIPHER_RID})"
PKG="sqlitepclraw.lib.e_sqlcipher"   # NuGet ids are lower-cased in the flat container
curl -fL --retry 3 -o "$WORK/sqlcipher.nupkg" \
  "https://api.nuget.org/v3-flatcontainer/${PKG}/${SQLCIPHER_PKG_VERSION}/${PKG}.${SQLCIPHER_PKG_VERSION}.nupkg"
unzip -o "$WORK/sqlcipher.nupkg" "runtimes/${SQLCIPHER_RID}/native/${SQLCIPHER_SRC}" -d "$WORK/sqlcipher" >/dev/null
cp "$WORK/sqlcipher/runtimes/${SQLCIPHER_RID}/native/${SQLCIPHER_SRC}" "$NATIVES/$SQLCIPHER_OUT"

echo "==> Staged into $NATIVES:"
ls -1 "$NATIVES" | grep -iE 'duckdb|sqlcipher' || true
