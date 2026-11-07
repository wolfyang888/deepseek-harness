/**
 * Locate an installed Chrome/Chromium for a managed launch.
 *
 * `playwright-core` ships no browser binaries and this package declares it as
 * an optional peer, so a managed launch has to name a real executable. A
 * configured `executablePath` always wins; otherwise the well-known install
 * locations of the host platform are searched in order, which keeps one
 * configuration working on Windows and Linux.
 * @module @deepseek-ai/dsh-experimental-chathub-host/executable
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'

/** Inputs for one discovery pass; every field defaults to the live host. */
export interface ChromeDiscovery {
  /** Host platform; defaults to `process.platform`. */
  platform?: NodeJS.Platform
  /** Environment holding the Windows install roots; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Home directory holding per-user macOS installs; defaults to the current user's. */
  home?: string
  /** Existence probe; defaults to `fs.existsSync`. */
  exists?: (path: string) => boolean
}

/**
 * Well-known Chrome/Chromium paths for one platform, most preferred first.
 * @param platform - Host platform.
 * @param env - Environment holding the Windows install roots.
 * @param home - Home directory holding per-user macOS installs.
 * @returns Absolute candidate paths; empty for an unhandled platform.
 */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
): string[] {
  if (platform === 'linux') {
    return [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/opt/google/chrome/chrome',
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${home}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  if (platform === 'win32') {
    const defined = (values: (string | undefined)[]): string[] =>
      values.filter((value): value is string => value !== undefined && value !== '')
    const chrome = defined([env['LOCALAPPDATA'], env['PROGRAMFILES'], env['PROGRAMFILES(X86)']])
      .map(root => `${root}\\Google\\Chrome\\Application\\chrome.exe`)
    const edge = defined([env['PROGRAMFILES'], env['PROGRAMFILES(X86)']])
      .map(root => `${root}\\Microsoft\\Edge\\Application\\msedge.exe`)
    return [...chrome, ...edge]
  }
  return []
}

/**
 * @param options - Discovery inputs; every field defaults to the live host.
 * @returns The first installed Chrome/Chromium binary, or `undefined` when none is present.
 */
export function discoverChromeExecutable(options: ChromeDiscovery = {}): string | undefined {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const exists = options.exists ?? existsSync
  return chromeCandidates(platform, env, home).find(path => exists(path))
}
