#!/usr/bin/env bash
# Prepare a source checkout for dev mode: `dsh web --patch packages/experimental/...`.
#
# What dev mode actually needs (verified by booting with the libs removed):
#   - workspace links and dependencies           → `pnpm install` (once)
#   - the panel client bundle `lib/client.js`    → the ONLY required build product;
#     without it boot fails with `client-hmr` waiting for `clientModules`
#   - everything else (chathub, chathub-host, llm-chathub, chathub-gateway)
#     runs straight from `src/` through the tsx loader — no tsc, no tsdown,
#     and edits to `src/` take effect on the next start with no rebuild.
#
# Usage:
#   scripts/build-chathub-dev.sh            # install if needed + panel bundle
#   scripts/build-chathub-dev.sh --skip-install
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PANEL=@deepseek-ai/dsh-experimental-client-ui-chathub

command -v pnpm >/dev/null 2>&1 || { echo "build-chathub-dev: pnpm not on PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "build-chathub-dev: node not on PATH" >&2; exit 1; }
# A host NODE_OPTIONS can inject loaders the build does not expect.
unset NODE_OPTIONS

cd "$ROOT"

if [ "${1:-}" != "--skip-install" ]; then
  if [ -d node_modules ]; then
    echo "build-chathub-dev: node_modules present, skipping pnpm install (--skip-install to make this explicit)"
  else
    echo "build-chathub-dev: pnpm install (workspace links + dependencies)"
    pnpm install
  fi
fi

echo "build-chathub-dev: bundling the panel client ($PANEL)"
pnpm --filter "$PANEL" run bundle

fail=0
for file in \
  packages/experimental/client-ui-chathub/lib/client.js \
  packages/experimental/chathub-host/cordis.patch.yml \
  packages/experimental/llm-chathub/cordis.patch.yml \
  packages/experimental/chathub-gateway/cordis.patch.yml
do
  if [ -f "$ROOT/$file" ]; then
    echo "  ok  $file"
  else
    echo "  MISSING  $file" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || exit 1

cat <<'EOF'
build-chathub-dev: ready. Start with:

  scripts/run-chathub-gateway.sh
  # or directly:
  pnpm dsh web \
    --patch packages/experimental/chathub-host/cordis.patch.yml \
    --patch packages/experimental/llm-chathub/cordis.patch.yml \
    --patch packages/experimental/chathub-gateway/cordis.patch.yml \
    --port 8899 --no-open

Edits under packages/experimental/*/src take effect on the next start.
Re-run this script only when the panel client (client-ui-chathub) changes,
or when pnpm warns about a missing lib/client.js.
EOF
