#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
root=$(cd "${SUPERSET_ROOT_PATH:?Superset must provide SUPERSET_ROOT_PATH}" && pwd -P)

if [[ "$root" != "$(pwd -P)" ]]; then
  shopt -s nullglob
  for source in "$root"/.env* "$root"/apps/*/.env* "$root"/packages/*/.env*; do
    relative=${source#"$root"/}
    [[ -f "$source" && ! -e "$relative" && ! -L "$relative" ]] || continue
    git -C "$root" ls-files --error-unmatch -- "$relative" >/dev/null 2>&1 && continue
    # Do not recreate packages that only exist on the main checkout's branch.
    [[ -d "$(dirname "$relative")" ]] || continue
    cp -p "$source" "$relative"
  done

  # Planning docs are gitignored but needed by agents in each workspace.
  if [[ -d "$root/docs" && ! -e docs && ! -L docs ]]; then
    cp -R "$root/docs" docs
  fi
fi

pnpm install --frozen-lockfile
