#!/usr/bin/env bash
set -euo pipefail

# Build, pack, and optionally publish the four ChatHub packages as one unit.
#
# The repository has no single-package build entry: `pnpm run build:artifacts`
# always compiles every workspace member, and `release:pack` / `release:publish`
# pack the whole `dsh` family under one shared version from CI. That is the right
# default for the product, but too much when only these four packages changed.
#
# The steps below reproduce what those pipelines do for these packages alone:
# Typert declarations, TypeScript project builds, the Host bundle, the Client
# bundle with the package-local config, then `pnpm pack` with explicit filters.
# Publication is a dry run unless --publish is passed, so a review of the
# printed commands is the default outcome.

readonly PACKAGE_DIRS=(chathub client-ui-chathub chathub-host llm-chathub)
readonly HOST_DIRS=(chathub chathub-host llm-chathub)
readonly PANEL_DIR=client-ui-chathub

# Dependents come after what they depend on, so a partial publish never leaves a
# version whose peers are still missing from the registry.
readonly PUBLISH_ORDER=(chathub client-ui-chathub chathub-host llm-chathub)

usage() {
  cat <<'TXT'
Usage: scripts/ship-chathub.sh [options]

Build the four ChatHub packages in isolation, pack them into tarballs, and
print (or with --publish, run) the npm publish commands in dependency order.

Options:
  --bump <patch|minor|major|prerelease>
                          bump all four versions from their current value
  --version <x.y.z>       set an explicit shared version instead of --bump
  --out <dir>             tarball destination (default: dist/chathub)
  --skip-build            pack the existing lib/ output without rebuilding
  --skip-typert           skip Typert regeneration (declarations already current)
  --publish               run npm publish; default prints the commands only
  --tag <dist-tag>        npm dist-tag (default: alpha)
  --registry <url>        npm registry override
  -h, --help              show this text

Build steps run from the repository root and use the same tools as
build:artifacts: scripts/generate-typert.ts, `tsc -b`, the Host tsdown pass with
explicit package filters, and the panel's own tsdown config.

Platforms: the tarballs are pure JavaScript, JSON, YAML, and .d.ts, with no
os/cpu restriction, so one publish serves Windows, Linux, and macOS. Only the
build step needs a host: bash 3.2+, tar, find, Node >= 24.9, and pnpm all work
on Linux and macOS; on Windows run this from Git Bash or WSL (bash.exe is not
part of Windows itself). Paths handed to Node tools are converted with
cygpath when MSYS is present, so both --out dist/chathub and --out /d/... work.
TXT
}

die() {
  printf 'ship-chathub: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '==> %s\n' "$*"
}

bump=''
version=''
out='dist/chathub'
skip_build=0
skip_typert=0
publish=0
tag='alpha'
registry=''

while (( $# > 0 )); do
  case "$1" in
    --bump)
      [[ $# -ge 2 ]] || die '--bump needs a value'
      bump=$2
      shift 2
      ;;
    --version)
      [[ $# -ge 2 ]] || die '--version needs a value'
      version=$2
      shift 2
      ;;
    --out)
      [[ $# -ge 2 ]] || die '--out needs a value'
      out=$2
      shift 2
      ;;
    --tag)
      [[ $# -ge 2 ]] || die '--tag needs a value'
      tag=$2
      shift 2
      ;;
    --registry)
      [[ $# -ge 2 ]] || die '--registry needs a value'
      registry=$2
      shift 2
      ;;
    --skip-build) skip_build=1; shift ;;
    --skip-typert) skip_typert=1; shift ;;
    --publish) publish=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[[ -z "$bump" || -z "$version" ]] || die '--bump and --version are mutually exclusive'
case "$bump" in
  ''|patch|minor|major|prerelease) ;;
  *) die "--bump must be patch, minor, major, or prerelease, got '$bump'" ;;
esac

root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'run this inside the repository checkout'
cd "$root"

# A Windows checkout can start a shell without the Node directory on PATH, and an
# inherited NODE_OPTIONS breaks the toolchain. Both are local environment facts,
# not project configuration.
if ! command -v node >/dev/null 2>&1; then
  for candidate in '/d/Program Files/nodejs' '/c/Program Files/nodejs'; do
    if [[ -x "$candidate/node.exe" || -x "$candidate/node" ]]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi
unset NODE_OPTIONS
command -v node >/dev/null 2>&1 || die 'node is not on PATH (install Node >= 24.9)'
command -v pnpm >/dev/null 2>&1 || die 'pnpm is not on PATH (corepack enable)'

package_field() {
  node -p "require('./packages/experimental/$1/package.json').$2"
}

apply_version() {
  local target=$1
  node - "$target" <<'JS'
const fs = require('node:fs')
const path = require('node:path')
const target = process.argv[2]
for (const dir of ['chathub', 'client-ui-chathub', 'chathub-host', 'llm-chathub']) {
  const file = path.join('packages', 'experimental', dir, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (manifest.version === target) continue
  manifest.version = target
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`  ${manifest.name}: ${target}`)
}
JS
}

current_version=$(package_field chathub version)

if [[ -n "$version" ]]; then
  semver_ok=$(node -e "const s=require('semver');process.stdout.write(s.valid(process.argv[1]) ?? '')" "$version")
  [[ -n "$semver_ok" ]] || die "'$version' is not a valid semver version"
  note "setting version $version (was $current_version)"
  apply_version "$version"
elif [[ -n "$bump" ]]; then
  next=$(node - "$bump" <<'JS'
const semver = require('semver')
const kind = process.argv[2]
const current = JSON.parse(require('node:fs').readFileSync('packages/experimental/chathub/package.json', 'utf8')).version
const next = semver.inc(current, kind)
if (next === null) {
  console.error(`cannot bump ${current} as ${kind}`)
  process.exit(1)
}
process.stdout.write(next)
JS
) || die "semver could not bump $current_version as $bump"
  note "bumping version $current_version -> $next"
  apply_version "$next"
fi

versions=()
for dir in "${PACKAGE_DIRS[@]}"; do
  versions+=("$(package_field "$dir" version)")
done
unique_versions=$(printf '%s\n' "${versions[@]}" | sort -u | wc -l | tr -d ' ')
[[ "$unique_versions" == '1' ]] || die "packages disagree on version: ${versions[*]}"
shared_version=${versions[0]}
note "shared version: $shared_version"

if [[ "$skip_build" -eq 0 ]]; then
  if [[ "$skip_typert" -eq 0 ]]; then
    note 'generating Typert declarations'
    pnpm exec tsx scripts/generate-typert.ts
  fi

  projects=()
  for dir in "${PACKAGE_DIRS[@]}"; do
    projects+=("packages/experimental/$dir/tsconfig.json")
  done
  note 'compiling declarations and intermediate JavaScript (tsc -b)'
  pnpm exec tsc -b "${projects[@]}"

  host_filters=()
  for dir in "${HOST_DIRS[@]}"; do
    host_filters+=('-F' "@deepseek-ai/dsh-experimental-$dir")
  done
  note 'bundling the Host entry points (tsdown)'
  pnpm exec tsdown --config-loader native --env.DSH_BUILD_FACE host "${host_filters[@]}"

  note 'bundling the panel client entry with its package-local config'
  pnpm --filter "@deepseek-ai/dsh-experimental-$PANEL_DIR" run bundle
fi

require_output() {
  [[ -f "$1" ]] || die "missing build output: $1 (drop --skip-build to rebuild)"
}

require_output packages/experimental/chathub/lib/index.js
require_output packages/experimental/chathub-host/lib/index.js
require_output packages/experimental/chathub-host/lib/typert.host.js
require_output packages/experimental/chathub-host/lib/typert.remote-client.js
require_output packages/experimental/llm-chathub/lib/index.js
require_output "packages/experimental/$PANEL_DIR/lib/client.js"

mkdir -p "$out"
# bash tools (find, tar) want the POSIX form; Node tools (pnpm, npm) want a
# native one. MSYS otherwise hands `/d/x` to Node, which resolves it to
# `D:\d\x`. cygpath is only present on Windows shells, so this is a no-op
# elsewhere. Indexed arrays instead of `declare -A` keep macOS bash 3.2 happy.
abs_out=$(cd "$out" && pwd -P)
native_path() {
  if [[ -n "${MSYSTEM:-}" ]] && command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}
pack_out=$(native_path "$abs_out")
rm -f "$abs_out"/*.tgz

pack_filters=()
for dir in "${PACKAGE_DIRS[@]}"; do
  pack_filters+=("--filter=$(package_field "$dir" name)")
done
note "packing ${#PACKAGE_DIRS[@]} packages into $abs_out"
pnpm pack --recursive "${pack_filters[@]}" --pack-destination "$pack_out"

# A tarball that lacks its runtime entry installs but cannot be loaded. This
# happens silently when `files` lists lib/index.js and the build did not emit
# it, so check the archive itself, not just the working tree.
tarball_names=()
tarball_paths=()
while IFS= read -r tgz; do
  packed_name=$(tar -xzOf "$tgz" package/package.json \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).name))")
  tarball_names+=("$packed_name")
  tarball_paths+=("$tgz")
  case "$packed_name" in
    *"$PANEL_DIR") needed='package/lib/client.js' ;;
    *) needed='package/lib/index.js' ;;
  esac
  found=$(tar -tzf "$tgz" | grep -Fxc "$needed" || true)
  [[ "$found" == '1' ]] || die "tarball $tgz is missing $needed: rebuild before packing"
done < <(find "$abs_out" -maxdepth 1 -name '*.tgz' -print)

tarball_for() {
  local wanted=$1 i=0
  for (( i = 0; i < ${#tarball_names[@]}; i++ )); do
    if [[ "${tarball_names[$i]}" == "$wanted" ]]; then
      printf '%s\n' "${tarball_paths[$i]}"
      return 0
    fi
  done
  return 1
}

for dir in "${PACKAGE_DIRS[@]}"; do
  name=$(package_field "$dir" name)
  tarball_for "$name" >/dev/null || die "pnpm pack produced no tarball for $name"
done

if [[ "$publish" -eq 1 ]]; then
  npm whoami >/dev/null 2>&1 || die 'not signed in to npm: run npm login or export NPM_TOKEN'
fi

printf '\nTarballs in %s:\n' "$abs_out"
for dir in "${PUBLISH_ORDER[@]}"; do
  name=$(package_field "$dir" name)
  printf '  %s\n' "$(tarball_for "$name")"
done

printf '\nPublish order (%s):\n' "$([[ "$publish" -eq 1 ]] && printf 'executing' || printf 'dry run; pass --publish to execute')"
for dir in "${PUBLISH_ORDER[@]}"; do
  name=$(package_field "$dir" name)
  tarball=$(tarball_for "$name")
  if npm view "$name@$shared_version" version >/dev/null 2>&1; then
    printf '  %s@%s already on the registry, skipping\n' "$name" "$shared_version"
    continue
  fi
  cmd=(npm publish "$(native_path "$tarball")" --access public --tag "$tag")
  if [[ -n "$registry" ]]; then
    cmd+=(--registry "$registry")
  fi
  if [[ "$publish" -eq 1 ]]; then
    note "publishing $name@$shared_version"
    "${cmd[@]}"
    # The registry needs a moment to commit a packument before the next write.
    sleep 2
  else
    printf '  %s\n' "${cmd[*]}"
  fi
done

cat <<TXT

Install without a registry (only chathub-host and llm-chathub carry dsh.bundle.patch):
  dsh plugin add <tarball> --profile <name>
Or mount the layers from a source checkout:
  pnpm dsh web --patch packages/experimental/chathub-host/cordis.patch.yml \\
               --patch packages/experimental/llm-chathub/cordis.patch.yml
TXT
