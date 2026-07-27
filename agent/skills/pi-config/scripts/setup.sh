#!/usr/bin/env bash
# pi-config setup: prepare a freshly cloned pi config on a new machine.
# Usage:  ./setup.sh
set -euo pipefail

REPO="${PI_CONFIG_REPO:-$HOME/.pi}"
cd "$REPO"

echo "==> Pulling latest"
git pull --rebase --autostash || true

# Restore extension dependencies (node_modules are gitignored).
for ext in agent/extensions/*/; do
  if [ -f "${ext}package.json" ]; then
    echo "==> npm install in ${ext}"
    ( cd "$ext" && npm install --silent ) || echo "   (skipped ${ext}: npm install failed)"
  fi
done

cat <<'EOF'

Next steps (manual, machine-specific):
  1. Authenticate:  run `pi`, then `/login` for your provider.
     -> creates a local, untracked agent/auth.json
  2. Optional: reinstall fd/rg into agent/bin if a skill needs them.
Done.
EOF
