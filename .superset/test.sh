#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
export SUPERSET_ROOT_PATH="$fixture/main checkout"
workspace="$fixture/new workspace"
mkdir -p "$SUPERSET_ROOT_PATH/apps/web" "$SUPERSET_ROOT_PATH/apps/other" \
  "$SUPERSET_ROOT_PATH/packages/ui" "$SUPERSET_ROOT_PATH/docs" \
  "$workspace/.superset" "$workspace/apps/web" "$workspace/packages/ui" "$fixture/bin"
cp .superset/{setup,run}.sh "$workspace/.superset/"
git init -q "$SUPERSET_ROOT_PATH"
printf 'root env' > "$SUPERSET_ROOT_PATH/.env"
printf 'tracked template' > "$SUPERSET_ROOT_PATH/.env.example"
git -C "$SUPERSET_ROOT_PATH" add .env.example
printf 'web env' > "$SUPERSET_ROOT_PATH/apps/web/.env.local"
printf 'other env' > "$SUPERSET_ROOT_PATH/apps/other/.env"
printf 'ui env' > "$SUPERSET_ROOT_PATH/packages/ui/.env"
printf 'planning docs' > "$SUPERSET_ROOT_PATH/docs/concept.md"
printf 'local env' > "$workspace/packages/ui/.env"
chmod 600 "$SUPERSET_ROOT_PATH/.env"

cat > "$fixture/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'install --frozen-lockfile') exit "${INSTALL_STATUS:-0}" ;;
  'dev --filter=web -- --hostname 127.0.0.1 --port 0') exit 0 ;;
  *) echo "Unexpected pnpm arguments: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$fixture/bin/pnpm"
export PATH="$fixture/bin:$PATH"

bash "$workspace/.superset/setup.sh"
cmp "$SUPERSET_ROOT_PATH/.env" "$workspace/.env"
cmp "$SUPERSET_ROOT_PATH/apps/web/.env.local" "$workspace/apps/web/.env.local"
cmp "$SUPERSET_ROOT_PATH/docs/concept.md" "$workspace/docs/concept.md"
[[ "$(cat "$workspace/packages/ui/.env")" == 'local env' ]]
[[ ! -e "$workspace/.env.example" && ! -e "$workspace/apps/other" ]]

printf 'workspace edit' > "$workspace/.env"
printf 'local docs' > "$workspace/docs/concept.md"
bash "$workspace/.superset/setup.sh"
[[ "$(cat "$workspace/.env")" == 'workspace edit' ]]
[[ "$(cat "$workspace/docs/concept.md")" == 'local docs' ]]

rm "$workspace/apps/web/.env.local"
ln -s "$fixture/missing" "$workspace/apps/web/.env.local"
bash "$workspace/.superset/setup.sh"
[[ -L "$workspace/apps/web/.env.local" && ! -e "$fixture/missing" ]]

if INSTALL_STATUS=7 bash "$workspace/.superset/setup.sh"; then exit 1; fi
if SUPERSET_ROOT_PATH='' bash "$workspace/.superset/setup.sh" 2>/dev/null; then exit 1; fi
if bash "$workspace/.superset/run.sh" 2>/dev/null; then exit 1; fi
printf '{}' > "$workspace/apps/web/package.json"
bash "$workspace/.superset/run.sh"

mkdir "$fixture/empty root"
git init -q "$fixture/empty root"
SUPERSET_ROOT_PATH="$fixture/empty root" bash "$workspace/.superset/setup.sh"
SUPERSET_ROOT_PATH="$workspace" bash "$workspace/.superset/setup.sh"
echo 'Superset lifecycle checks passed.'
