#!/usr/bin/env bash
# pi-config sync: safely commit + push tracked pi config changes.
# Usage:  ./sync.sh ["commit message"]
# Aborts if any secret/personal/huge file is staged.
set -euo pipefail

REPO="${PI_CONFIG_REPO:-$HOME/.pi}"
cd "$REPO"

MSG="${1:-Update pi config ($(date +%Y-%m-%d\ %H:%M))}"

# Refuse to run outside the expected repo.
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "ERROR: $REPO is not a git repo"; exit 1; }

git add -A

# Nothing to do?
if git diff --cached --quiet; then
  echo "Nothing to commit — working tree clean."
  exit 0
fi

# --- Safety check: block secrets / personal / huge / regenerable paths ---
BAD="$(git ls-files --cached | grep -Ei 'auth\.json|sessions/|fleet/|agent/job-search/|node_modules|\.exe$|token|credential|secret|\.pem$|\.key$' || true)"
if [ -n "$BAD" ]; then
  echo "STOP: sensitive/ignored files are staged:"
  echo "$BAD" | sed 's/^/  - /'
  echo "Unstage them and add to .gitignore, e.g.:  git rm --cached <path>"
  exit 2
fi

echo "Staged changes:"
git status --short
echo

git commit -q -m "$MSG"
echo "✅ committed: $MSG"

git push -q origin "$(git rev-parse --abbrev-ref HEAD)"
echo "✅ pushed to $(git remote get-url origin)"
