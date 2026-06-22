#!/usr/bin/env bash
#
# scrub-history.sh — Audit item C-4 remediation
# Purge committed build artifacts + IDE cache from DbArk's *entire git history*.
#
# The working tree is already clean (.gitignore covers these; nothing is tracked
# in HEAD). This rewrites HISTORY so the ~170 MB of dead weight stops shipping to
# everyone who clones, and so the leaked Visual Studio / Copilot index databases
# are removed from past commits.
#
# This is DESTRUCTIVE: it rewrites every commit SHA. It does NOT push. It runs on
# a throwaway clone so your working repo is never touched until you choose to push.
#
# Requires git-filter-repo (https://github.com/newren/git-filter-repo):
#   pipx install git-filter-repo      # or: brew install git-filter-repo
#   python3 -m pip install --user git-filter-repo
#
set -euo pipefail

REPO_URL="https://github.com/TooSmoove/DbArk.git"
WORKDIR="DbArk-scrub"

# --- 0. preflight ----------------------------------------------------------
if ! command -v git-filter-repo >/dev/null 2>&1 && ! python3 -c "import git_filter_repo" 2>/dev/null; then
  echo "ERROR: git-filter-repo not found."
  echo "  Install:  pipx install git-filter-repo   (or 'brew install git-filter-repo')"
  echo "  Fallback: use BFG Repo-Cleaner instead — see the README notes at the bottom of this file."
  exit 1
fi

# --- 1. fresh clone (filter-repo insists on a clean clone) ------------------
rm -rf "$WORKDIR"
git clone "$REPO_URL" "$WORKDIR"
cd "$WORKDIR"

echo
echo "=== Repo size BEFORE ==="
git count-objects -vH | grep -E 'size-pack|count' || true

# --- 2. rewrite history, removing the artifact paths everywhere -------------
# --invert-paths => the listed paths are REMOVED from all of history.
# We keep src-tauri/natives/connections/*.toml (real config) by only globbing *.dll there.
git filter-repo --invert-paths \
  --path-glob '*.dll' \
  --path-glob '*.pdb' \
  --path-glob '*.db' \
  --path sqlcipher.zip \
  --path src-csharp/QueryExecutor/.vs \
  --path src-csharp/QueryExecutor/bin \
  --path src-csharp/QueryExecutor/obj

# --- 3. repack / drop the now-unreferenced blobs locally -------------------
git reflog expire --expire=now --all
git gc --prune=now --aggressive

echo
echo "=== Repo size AFTER ==="
git count-objects -vH | grep -E 'size-pack|count' || true

echo
echo "=== Sanity check: any artifact still anywhere in history? (should be empty) ==="
git rev-list --objects --all \
  | grep -Ei '\.(dll|pdb|db|zip)$|/\.vs/|/bin/|/obj/' \
  || echo "  clean — no binaries or IDE cache left in history."

cat <<'NEXT'

------------------------------------------------------------------------------
Rewrite complete on the throwaway clone in ./DbArk-scrub — NOTHING pushed yet.

VERIFY, then push from inside ./DbArk-scrub:

  git remote add origin https://github.com/TooSmoove/DbArk.git
  git push origin --force --all
  git push origin --force --tags

AFTER pushing:
  * Every commit SHA changed. Any existing clone/fork must RE-CLONE, not pull.
    (Open PRs will need to be recreated against the rewritten history.)
  * GitHub keeps old objects reachable by direct SHA until its own GC. The leaked
    .vs/Copilot index DBs were already public, so treat them as exposed: if any
    real secret ever sat in history, rotate it. To expire cached views sooner you
    can open a GitHub Support request to run gc on the repo.
  * Locally on your real working copy, the simplest path is to delete it and
    re-clone fresh once the force-push lands.
------------------------------------------------------------------------------
NEXT
