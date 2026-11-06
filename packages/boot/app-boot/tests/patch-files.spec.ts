/**
 * Every shipped `cordis.patch.yml` must parse with the exact loader dialect
 * (`js-yaml` + `entryListSchema`), because these files are only read at
 * `dsh web` boot — no unit test exercises them unless this one does. A YAML
 * syntax error (e.g. a bare `!!js` scalar containing `{`, which plain scalars
 * cannot hold) or a JS expression that cannot even compile must fail the
 * suite, not the next user launch.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** Collect every `cordis.patch.yml` under the repo, node_modules excluded. */
function* patchFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) yield* patchFiles(path)
    else if (entry.isFile() && entry.name === 'cordis.patch.yml') yield path
  }
}

/** `!!js` scalars become `__jsExpr` nodes; check each compiles (no execution). */
function expressionNodes(value: unknown): string[] {
  if (typeof value === 'string') return []
  if (Array.isArray(value)) return value.flatMap(expressionNodes)
  if (value === null || typeof value !== 'object') return []
  const node = value as Record<string, unknown>
  const own = node['__jsExpr']
  const ownExpressions = typeof own === 'string' ? [own] : []
  return [...ownExpressions, ...Object.values(node).flatMap(expressionNodes)]
}

const files = [...patchFiles(repoRoot)]

describe('shipped cordis.patch.yml files parse with the boot loader dialect', () => {
  it('finds the shipped patch files (a broken glob must not pass vacuously)', () => {
    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.some(file => file.includes('chathub-host'))).toBe(true)
    expect(files.some(file => file.includes('llm-chathub'))).toBe(true)
  })

  for (const file of files) {
    const label = file.slice(repoRoot.length)
    it(`${label} parses into a top-level patch array`, () => {
      const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
      expect(Array.isArray(parsed)).toBe(true)
    })

    it(`${label} holds only compilable !!js expressions`, () => {
      const parsed = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema })
      for (const expression of expressionNodes(parsed)) {
        // Compile only: `new Function` rejects a syntax error without running
        // the body, so no environment and no site is ever touched here.
        // eslint-disable-next-line @typescript-eslint/no-implied-eval -- compiling is exactly what the Loader does with these nodes
        expect(() => new Function(`return ${expression}`), expression.slice(0, 120)).not.toThrow()
      }
    })
  }
})
