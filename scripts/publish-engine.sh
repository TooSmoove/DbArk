#!/usr/bin/env bash
# publish-engine.sh — AOT-publish one C# engine and stage its native library
# into src-tauri/natives/ (macOS/Linux sibling of publish-engine.ps1).
#
# These engines are loaded by the Rust host over native FFI, so they must come
# from `dotnet publish -p:PublishAot=true` (a managed `dotnet build` stub can't
# load). On unix the AOT output is <Name>.so / <Name>.dylib, so the extension
# alone distinguishes it from the managed .dll — no size heuristic needed.
#
#   ./scripts/publish-engine.sh FileQueryEngine            # auto-detect RID
#   ./scripts/publish-engine.sh FileQueryEngine osx-arm64  # explicit RID
set -euo pipefail

NAME="${1:?usage: publish-engine.sh <EngineName> [runtime-id]}"
RID="${2:-}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$ROOT/src-csharp/$NAME"
NATIVES="$ROOT/src-tauri/natives"
[ -d "$PROJ" ]    || { echo "project folder not found: $PROJ" >&2; exit 1; }
mkdir -p "$NATIVES"

# Detect RID + native extension from the host if not given.
case "$(uname -s)" in
    Darwin) EXT="dylib"; [ -n "$RID" ] || { [ "$(uname -m)" = "arm64" ] && RID="osx-arm64" || RID="osx-x64"; } ;;
    Linux)  EXT="so";    [ -n "$RID" ] || { [ "$(uname -m)" = "aarch64" ] && RID="linux-arm64" || RID="linux-x64"; } ;;
    *) echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
esac

echo "==> dotnet clean + publish (AOT) $NAME [$RID]"
dotnet clean "$PROJ" -c Release >/dev/null
dotnet publish "$PROJ" -c Release -r "$RID" -p:PublishAot=true

# Find the freshly produced native library: <NAME>.$EXT or lib<NAME>.$EXT,
# newest first. The .dll IL assembly is ignored because we filter on $EXT.
LIB="$(find "$PROJ/bin/Release" -type f \( -name "$NAME.$EXT" -o -name "lib$NAME.$EXT" \) \
        -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2-)"
if [ -z "$LIB" ]; then
    echo "no $NAME.$EXT / lib$NAME.$EXT found under bin/Release after publish — did AOT run?" >&2
    echo "confirm <PublishAot>true</PublishAot> is in $NAME.csproj so the -p flag isn't load-bearing." >&2
    exit 1
fi

# build.rs resolves both bare and lib-prefixed names; keep whatever AOT produced.
DEST="$NATIVES/$(basename "$LIB")"
cp -f "$LIB" "$DEST"
SIZE=$(stat -c%s "$DEST" 2>/dev/null || stat -f%z "$DEST")
echo "    published: $LIB"
echo "    staged:    $DEST ($SIZE bytes)"
[ "$SIZE" -ge 204800 ] || echo "    WARNING: only $SIZE bytes — looks like a managed stub, not an AOT native lib." >&2
