# Publish ONE C# NativeAOT engine and deploy its native DLL into src-tauri\natives\.
#
# Why this exists: these engines are loaded by the Rust host over native FFI, so
# they only exist as loadable export DLLs when produced by
#   dotnet publish -c Release -r <rid> -p:PublishAot=true
# A plain `dotnet build` makes a managed IL stub the host cannot load, so the app
# silently keeps running the LAST published native DLL. That is how a pre-C-5
# engine kept executing after the fix compiled green. This script closes that gap
# for a single engine; build.ps1 will do all six atomically.
#
#   .\scripts\publish-engine.ps1 FileQueryEngine
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Runtime = "win-x64"
)
$ErrorActionPreference = "Stop"

$root    = Split-Path -Parent $PSScriptRoot
$proj    = Join-Path $root "src-csharp\$Name"
$natives = Join-Path $root "src-tauri\natives"
if (-not (Test-Path $proj))    { throw "Project folder not found: $proj" }
if (-not (Test-Path $natives)) { throw "natives folder not found: $natives" }

Write-Host "==> dotnet clean (force fresh AOT; a cached publish stamps a new timestamp on stale code)"
dotnet clean $proj -c Release | Out-Null

Write-Host "==> dotnet publish (AOT) $Name [$Runtime]"
dotnet publish $proj -c Release -r $Runtime -p:PublishAot=true

if ($LASTEXITCODE -ne 0) { throw "publish failed for $Name" }

# The AOT native DLL is the freshly-written, LARGE FileQueryEngine.dll under
# bin\Release (a managed stub is tiny). Newest first, then largest.
$dll = Get-ChildItem (Join-Path $proj "bin\Release") -Recurse -Filter "$Name.dll" -ErrorAction Stop |
       Sort-Object LastWriteTime, Length -Descending |
       Select-Object -First 1
if (-not $dll) { throw "No $Name.dll found under bin\Release after publish - did AOT actually run?" }

Write-Host ("    published: {0}" -f $dll.FullName)
Write-Host ("    size:      {0:N0} bytes   written: {1}" -f $dll.Length, $dll.LastWriteTime)
if ($dll.Length -lt 200kb) {
    Write-Warning "That DLL is only $($dll.Length) bytes - that looks like a MANAGED stub, not an AOT native DLL. AOT did not trigger. Confirm <PublishAot>true</PublishAot> is in $Name.csproj (so the -p flag isn't load-bearing) and that -p:PublishAot=true took effect."
}

Copy-Item $dll.FullName (Join-Path $natives "$Name.dll") -Force
Write-Host "==> Deployed -> $natives\$Name.dll"
Write-Host ""
Write-Host "Next:"
Write-Host "  .\scripts\regen-hashes.ps1     # rehash the new DLL into main.rs"
Write-Host "  cargo tauri dev               # integrity check should pass with the new bytes"
