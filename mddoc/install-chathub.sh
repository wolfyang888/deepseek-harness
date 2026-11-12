#!/usr/bin/env bash
# Install the four packed ChatHub tarballs into a standalone project directory.
#
# Usage: ./install-chathub.sh [target-dir]
#   target-dir defaults to ./dist/npm-chathub/install-target
#
# npm resolves the inter-package dependencies to the tarballs passed in the same
# command, so no registry copy of the experimental packages is needed. It must
# not run inside the repository tree: npm would walk up to the workspace root
# manifest and fail on the pnpm `workspace:` protocol (EUNSUPPORTEDPROTOCOL).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
staging="$script_dir/../dist/npm-chathub"
target="${1:-$staging/install-target}"

[[ -d "$staging" ]] || { echo "missing $staging; run pack-chathub.mjs first" >&2; exit 1; }
mkdir -p "$target"
target="$(cd "$target" && pwd)"

if [[ ! -f "$target/package.json" ]]; then
  cat > "$target/package.json" <<'JSON'
{
  "name": "chathub-install-target",
  "private": true,
  "type": "module"
}
JSON
fi

tarballs=()
if [[ -f "$staging/publish-order.txt" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && tarballs+=("$staging/$line")
  done < "$staging/publish-order.txt"
else
  for file in "$staging"/*.tgz; do tarballs+=("$file"); done
fi

echo "installing ${#tarballs[@]} tarball(s) into $target"
cd "$target"
npm install --no-audit --no-fund "${tarballs[@]}"

for name in \
  @deepseek-ai/dsh-experimental-chathub \
  @deepseek-ai/dsh-experimental-client-ui-chathub \
  @deepseek-ai/dsh-experimental-chathub-host \
  @deepseek-ai/dsh-experimental-llm-chathub; do
  node -e "console.log(process.argv[1], '->', require.resolve(process.argv[1]))" "$name"
done
echo "done"
