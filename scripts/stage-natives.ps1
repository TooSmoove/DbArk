# Stage prebuilt third-party native libraries (DuckDB + SQLCipher) into
# src-tauri\natives\ so build.rs's completeness check passes and the app can
# load them at runtime.
#
# These libraries are NOT committed to git (see .gitignore). CI and local
# builds fetch them fresh and version-pinned. This is the third-party half of
# the build; the six C# NativeAOT engines come from `dotnet publish`.
#
# Keep the version pins below in sync with scripts/stage-natives.sh.
$ErrorActionPreference = "Stop"

# --- version pins -----------------------------------------------------------
$DuckDbVersion       = "1.5.0"     # must match the DuckDB C API the app builds against
$SqlcipherPkgVersion = "2.1.11"    # SQLitePCLRaw.lib.e_sqlcipher
# ---------------------------------------------------------------------------

$root    = Split-Path -Parent $PSScriptRoot
$natives = Join-Path $root "src-tauri\natives"
New-Item -ItemType Directory -Force -Path $natives | Out-Null

$work = Join-Path $env:TEMP "dbark-natives"
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force -Path $work | Out-Null

Write-Host "==> DuckDB $DuckDbVersion (windows-amd64)"
$duckZip = Join-Path $work "duckdb.zip"
Invoke-WebRequest -Uri "https://github.com/duckdb/duckdb/releases/download/v$DuckDbVersion/libduckdb-windows-amd64.zip" -OutFile $duckZip
Expand-Archive -Path $duckZip -DestinationPath (Join-Path $work "duckdb") -Force
Copy-Item (Join-Path $work "duckdb\duckdb.dll") (Join-Path $natives "duckdb.dll") -Force

Write-Host "==> SQLCipher (SQLitePCLRaw.lib.e_sqlcipher $SqlcipherPkgVersion, win-x64)"
$pkg   = "sqlitepclraw.lib.e_sqlcipher"   # NuGet ids are lower-cased in the flat container
$nupkg = Join-Path $work "sqlcipher.nupkg"
Invoke-WebRequest -Uri "https://api.nuget.org/v3-flatcontainer/$pkg/$SqlcipherPkgVersion/$pkg.$SqlcipherPkgVersion.nupkg" -OutFile $nupkg
# Expand-Archive requires a .zip extension; a .nupkg is a zip.
$nupkgZip = Join-Path $work "sqlcipher.zip"
Copy-Item $nupkg $nupkgZip -Force
Expand-Archive -Path $nupkgZip -DestinationPath (Join-Path $work "sqlcipher") -Force
Copy-Item (Join-Path $work "sqlcipher\runtimes\win-x64\native\e_sqlcipher.dll") (Join-Path $natives "sqlcipher.dll") -Force

Write-Host "==> Staged:"
Get-ChildItem $natives | Where-Object { $_.Name -match "duckdb|sqlcipher" } | Select-Object Name, Length | Format-Table -AutoSize
