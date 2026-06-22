# build.ps1 — the one locked, atomic build for DbArk (Windows).
#
# Closes the "works on my machine / stale binary" class for good (audit C-3 +
# session follow-up #4). Sequence:
#   1. AOT-publish every C# engine and stage its native DLL into src-tauri\natives\
#      (via publish-engine.ps1 — a plain `dotnet build` makes a managed stub the
#       Rust host can't load, which is how a pre-fix engine kept running).
#   2. Stage the two third-party natives, duckdb + sqlcipher (via stage-natives.ps1).
#   3. cargo tauri build — build.rs then re-hashes natives\ from the exact shipping
#      bytes on its own. There is NO manual hash step; do not hand-edit hashes.
#
# A freshness guard asserts every engine DLL was actually refreshed THIS run, so a
# silently-failed publish can never let a stale binary slip through to the build.
#
# Usage:
#   .\scripts\build.ps1                 # full release build
#   .\scripts\build.ps1 -Dev            # full prep, then `cargo tauri dev`
#   .\scripts\build.ps1 -SkipNatives    # engines + build only (duckdb/sqlcipher already staged)
#   .\scripts\build.ps1 -Engines FileQueryEngine -SkipNatives -Dev   # fast single-engine loop
#   .\scripts\build.ps1 -NoBuild        # stage natives only, don't invoke cargo
[CmdletBinding()]
param(
    [string]$Runtime = "win-x64",
    [string[]]$Engines = @("ConnectionManager","FileQueryEngine","QueryExecutor","QueryHistory","SchemaExplorer","SshTunnel"),
    [switch]$Dev,
    [switch]$SkipEngines,
    [switch]$SkipNatives,
    [switch]$CleanTarget,
    [switch]$NoBuild
)
$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$root      = Split-Path -Parent $scriptDir
$natives   = Join-Path $root "src-tauri\natives"
$publishEngine = Join-Path $scriptDir "publish-engine.ps1"
$stageNatives  = Join-Path $scriptDir "stage-natives.ps1"

$sw    = [System.Diagnostics.Stopwatch]::StartNew()
$start = Get-Date

# --- 1. AOT-publish the C# engines into natives\ -----------------------------
if (-not $SkipEngines) {
    if (-not (Test-Path $publishEngine)) { throw "missing $publishEngine" }
    foreach ($e in $Engines) {
        Write-Host ""
        Write-Host "==== [1/3] publish engine: $e ====" -ForegroundColor Cyan
        & $publishEngine -Name $e -Runtime $Runtime
    }
} else {
    Write-Host "==== [1/3] engines: SKIPPED ====" -ForegroundColor DarkGray
}

# --- 2. Stage third-party natives (duckdb + sqlcipher) -----------------------
if (-not $SkipNatives) {
    if (-not (Test-Path $stageNatives)) { throw "missing $stageNatives" }
    Write-Host ""
    Write-Host "==== [2/3] stage third-party natives ====" -ForegroundColor Cyan
    & $stageNatives
} else {
    Write-Host "==== [2/3] third-party natives: SKIPPED ====" -ForegroundColor DarkGray
}

# --- completeness + freshness guard (mirrors build.rs's contract, fails early) ---
# build.rs requires all 8 components in natives\. Check here too so the failure is
# a clear message, not a panic mid-cargo-build. The freshness check is the lesson
# from the stale-DLL bug: a DLL that wasn't rewritten this run means publish failed.
$required = @($Engines + @("duckdb","sqlcipher"))
$problems = @()
foreach ($r in $required) {
    $p = Join-Path $natives "$r.dll"
    if (-not (Test-Path $p)) { $problems += "missing: natives\$r.dll"; continue }
    $f = Get-Item $p
    if (-not $SkipEngines -and ($Engines -contains $r) -and $f.LastWriteTime -lt $start) {
        $problems += "STALE: natives\$r.dll was not refreshed this run (still $($f.LastWriteTime)) — its AOT publish likely failed silently"
    }
    if (($Engines -contains $r) -and $f.Length -lt 200kb) {
        Write-Warning "natives\$r.dll is only $($f.Length) bytes — looks like a managed stub, not an AOT native lib."
    }
}
if ($problems.Count) {
    $problems | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    throw "natives\ is not in a shippable state (see above). Fix the publish/stage step before building."
}
Write-Host "natives\ complete and fresh: $($required.Count) components." -ForegroundColor Green

if ($NoBuild) {
    Write-Host ("Done (no build). natives\ staged in {0:n1}s." -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
    return
}

# --- 3. cargo tauri build|dev — build.rs re-hashes natives\ automatically ------
Push-Location $root
try {
    if ($CleanTarget) { Write-Host "==> cargo clean"; cargo clean }
    Write-Host ""
    Write-Host "==== [3/3] cargo tauri $(if ($Dev) {'dev'} else {'build'}) ====" -ForegroundColor Cyan
    if ($Dev) { cargo tauri dev } else { cargo tauri build }
    if ($LASTEXITCODE -ne 0) { throw "cargo tauri exited with code $LASTEXITCODE" }
}
finally { Pop-Location }

Write-Host ("Build complete in {0:n1}s." -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
