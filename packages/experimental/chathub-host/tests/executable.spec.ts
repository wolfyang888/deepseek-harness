/** Chrome discovery for managed launches: platform candidate lists and the existence probe. */

import { expect, it } from 'vitest'
import { chromeCandidates, discoverChromeExecutable } from '../src/executable.ts'

it('lists Linux browser locations in preference order', () => {
  expect(chromeCandidates('linux', {}, '/home/x')).toEqual([
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
  ])
})

it('lists macOS application bundles, including a per-user install', () => {
  expect(chromeCandidates('darwin', {}, '/Users/x')).toEqual([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Users/x/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ])
})

it('lists Windows Chrome and Edge under the configured install roots', () => {
  const env = {
    LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  }
  expect(chromeCandidates('win32', env, 'C:\\Users\\x')).toEqual([
    'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ])
})

it('skips Windows install roots the environment leaves out', () => {
  expect(chromeCandidates('win32', { PROGRAMFILES: 'C:\\Program Files' }, 'C:\\Users\\x')).toEqual([
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ])
})

it('returns no candidates for an unhandled platform', () => {
  expect(chromeCandidates('freebsd', {}, '/home/x')).toEqual([])
})

it('returns the first candidate that exists', () => {
  const installed = new Set(['/usr/bin/chromium'])
  expect(discoverChromeExecutable({ platform: 'linux', exists: path => installed.has(path) }))
    .toBe('/usr/bin/chromium')
})

it('returns undefined when no candidate exists', () => {
  expect(discoverChromeExecutable({ platform: 'linux', exists: () => false })).toBeUndefined()
})

it('defaults every discovery input to the live host', () => {
  expect(discoverChromeExecutable({ exists: () => false })).toBeUndefined()
})
