#!/usr/bin/env node
/**
 * Pack the four ChatHub plugins into `dist/npm-chathub`.
 *
 * Artifacts are rebuilt under the official client build profile first, because
 * the release rules reject client bundles whose recorded environment is not the
 * official one (no `DSH_CLIENT_TITLE`). Packing is targeted: exactly these four
 * packages, in dependency order.
 */
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const OUT = join(ROOT, 'dist/npm-chathub')

/** Publish order: dependencies before the packages that resolve them. */
const PACKAGES = [
  '@deepseek-ai/dsh-experimental-chathub',
  '@deepseek-ai/dsh-experimental-client-ui-chathub',
  '@deepseek-ai/dsh-experimental-chathub-host',
  '@deepseek-ai/dsh-experimental-llm-chathub',
]

/** Run a command in the repository root with an environment overlay. */
function run(command, args, environment = {}) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...environment },
  })
}

/** Read the repository version every member must carry. */
function repositoryVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

/** Read one packed tarball's manifest. */
function packedManifest(tarball) {
  return JSON.parse(execSync(`tar -xOzf ${JSON.stringify(tarball)} package/package.json`, { cwd: OUT }).toString())
}

/** Reject a tarball that publishes source, source maps, or workspace ranges. */
function validateTarball(tarball) {
  const members = execSync(`tar -tzf ${JSON.stringify(tarball)}`, { cwd: OUT }).toString().split('\n')
  const forbidden = members.filter((member) => /^package\/src(\/|$)/.test(member) || /\.(?:js|d\.ts)\.map$/.test(member))
  if (forbidden.length > 0) throw new Error(`${tarball} publishes forbidden entries:\n${forbidden.join('\n')}`)

  const manifest = packedManifest(tarball)
  const unresolved = ['dependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap((section) => Object.entries(manifest[section] ?? {}))
    .filter(([, range]) => String(range).startsWith('workspace:'))
  if (unresolved.length > 0) throw new Error(`${tarball} keeps unresolved workspace ranges: ${JSON.stringify(unresolved)}`)
  return manifest
}

const version = repositoryVersion()
const commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim()
console.log(`packing ChatHub plugins ${version} (${commit.slice(0, 7)}) into ${OUT}`)

// 1. Rebuild artifacts with the official client profile the release consumes.
run('pnpm', ['run', 'build:artifacts'], {
  DSH_BUILD_CLIENT_PROFILE: 'official',
  DSH_CLIENT_COMMIT_HASH: commit,
  DSH_CLIENT_VERSION: version,
})

// 2. Pack the four packages serially, keeping the dependency order.
mkdirSync(OUT, { recursive: true })
for (const file of readdirSync(OUT).filter((entry) => entry.endsWith('.tgz'))) {
  rmSync(join(OUT, file))
}
run('pnpm', [
  'pack', '--recursive', '--workspace-concurrency=1',
  ...PACKAGES.map((name) => `--filter=${name}`),
  '--pack-destination', OUT,
])

// 3. Validate payloads and write the publish order.
const packed = []
for (const file of readdirSync(OUT).filter((entry) => entry.endsWith('.tgz'))) {
  const manifest = validateTarball(join(OUT, file))
  if (manifest.version !== version) throw new Error(`${file}: packed version ${manifest.version} != ${version}`)
  packed.push({ file, name: manifest.name })
  console.log(`ok: ${manifest.name}@${manifest.version} (${file})`)
}
if (packed.length !== PACKAGES.length) throw new Error(`expected ${PACKAGES.length} tarballs, found ${packed.length}`)

const order = PACKAGES.map((name) => {
  const found = packed.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`missing tarball for ${name}`)
  return found.file
})
writeFileSync(join(OUT, 'publish-order.txt'), `${order.join('\n')}\n`)
console.log(`publish order written to ${join(OUT, 'publish-order.txt')}`)
