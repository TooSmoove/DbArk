<#
  scrub-history.ps1 - Audit item C-4 remediation (Windows / PowerShell native)

  Purges committed build artifacts + IDE cache from DbArk's ENTIRE git history.
  The working tree is already clean; this rewrites HISTORY so the ~170 MB of dead
  weight stops shipping to everyone who clones, and removes the leaked Visual
  Studio / Copilot index databases from past commits.

  DESTRUCTIVE: rewrites every commit SHA. It does NOT push. It works on a throwaway
  clone in your TEMP folder, so C:\Users\keith\source\repos\DbArk is never touched
  until you choose to push.

  Requires git-filter-repo (a single Python script, cross-platform):
      python -m pip install --user git-filter-repo
  Make sure 'python' and the Scripts dir are on PATH, then re-open PowerShell.

  Run from anywhere:
      powershell -ExecutionPolicy Bypass -File .\scrub-history.ps1
#>

$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/TooSmoove/DbArk.git'
$WorkDir = Join-Path $env:TEMP 'DbArk-scrub'

# --- 0. preflight: is git-filter-repo available? ----------------------------
git filter-repo --version *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: git-filter-repo not found." -ForegroundColor Red
    Write-Host "  Install:  python -m pip install --user git-filter-repo"
    Write-Host "  Then re-open PowerShell so PATH picks it up, and re-run this script."
    Write-Host "  (Fallback: BFG Repo-Cleaner, a Java jar - see notes at the end of this file.)"
    exit 1
}

# --- 1. fresh clone (filter-repo insists on a clean clone) ------------------
if (Test-Path $WorkDir) { Remove-Item -Recurse -Force $WorkDir }
git clone $RepoUrl $WorkDir
if ($LASTEXITCODE -ne 0) { throw "clone failed" }
Set-Location $WorkDir

Write-Host "`n=== Repo size BEFORE ===" -ForegroundColor Cyan
git count-objects -vH | Select-String 'size-pack|count'

# --- 2. rewrite history, removing the artifact paths everywhere -------------
# --invert-paths => listed paths are REMOVED from all history.
# natives/connections/*.toml is real config and is KEPT - we only glob *.dll there.
$filterArgs = @(
    'filter-repo', '--invert-paths',
    '--path-glob', '*.dll',
    '--path-glob', '*.pdb',
    '--path-glob', '*.db',
    '--path', 'sqlcipher.zip',
    '--path', 'src-csharp/QueryExecutor/.vs',
    '--path', 'src-csharp/QueryExecutor/bin',
    '--path', 'src-csharp/QueryExecutor/obj'
)
git @filterArgs
if ($LASTEXITCODE -ne 0) { throw "filter-repo failed" }

# --- 3. drop the now-unreferenced blobs locally -----------------------------
git reflog expire --expire=now --all
git gc --prune=now --aggressive

Write-Host "`n=== Repo size AFTER ===" -ForegroundColor Cyan
git count-objects -vH | Select-String 'size-pack|count'

Write-Host "`n=== Sanity check: any artifact still in history? (want: clean) ===" -ForegroundColor Cyan
$leftover = git rev-list --objects --all |
    Select-String -Pattern '\.(dll|pdb|db|zip)$|/\.vs/|/bin/|/obj/'
if ($leftover) { $leftover } else { Write-Host "  clean - no binaries or IDE cache left in history." -ForegroundColor Green }

Write-Host @"

------------------------------------------------------------------------------
Rewrite complete in $WorkDir - NOTHING pushed yet.

VERIFY the size dropped and the sanity check is clean, then push from THIS folder:

    git remote add origin $RepoUrl
    git push origin --force --all
    git push origin --force --tags

AFTER pushing:
  * Every commit SHA changed. Any existing clone/fork must RE-CLONE, not pull.
  * Your real working copy at C:\Users\keith\source\repos\DbArk now has stale
    history - simplest path is to delete it and re-clone once the push lands.
  * GitHub keeps old objects reachable by direct SHA until its own GC. The
    .vs/Copilot DBs were already public, so treat them as exposed; if any real
    secret ever sat in history, rotate it. GitHub Support can force-expire sooner.
------------------------------------------------------------------------------
"@
