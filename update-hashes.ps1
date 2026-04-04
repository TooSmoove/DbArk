# update-hashes.ps1 — run after any DLL rebuild
$dlls = @(
    "ConnectionManager",
    "FileQueryEngine",
    "QueryExecutor",
    "QueryHistory",
    "SchemaExplorer"
)

foreach ($dll in $dlls) {
    $path = "src-tauri\natives\$dll.dll"
    $hash = (Get-FileHash $path -Algorithm SHA256).Hash.ToLower()
    Write-Host "const HASH_$($dll.ToUpper()): &str = `"$hash`";"
}

# duckdb separately
$duckHash = (Get-FileHash "src-tauri\natives\duckdb.dll" -Algorithm SHA256).Hash.ToLower()
Write-Host "const HASH_DUCKDB: &str = `"$duckHash`";"