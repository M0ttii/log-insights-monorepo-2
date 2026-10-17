#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ ! -f apps/web/package.json ]]; then
  echo "No dev server yet: apps/web has not been implemented." >&2
  exit 1
fi

# Port zero lets the OS allocate a free port atomically for each workspace.
exec pnpm dev --filter=web -- --hostname 127.0.0.1 --port 0
