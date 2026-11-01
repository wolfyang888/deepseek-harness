/** Shipped site drivers, host overrides, and load-time validation. */

import { expect, it } from 'vitest'
import {
  DEFAULT_SITE_DRIVERS,
  assertEveryAdapterHasDriver,
  resolveSiteDrivers,
  validateSiteDriver,
} from '../src/drivers.ts'
import { webProviderAdapters } from '@deepseek-ai/dsh-experimental-chathub'

it('ships a complete driver for every adapter', () => {
  expect(Object.keys(DEFAULT_SITE_DRIVERS).sort()).toEqual(Object.keys(webProviderAdapters).sort())
  for (const driver of Object.values(DEFAULT_SITE_DRIVERS)) {
    expect(driver.url).toMatch(/^https:/)
    expect(driver.submitKey).toBe('Enter')
    expect(driver.signedOutPath).toBeTruthy()
    expect(() => resolveSiteDrivers({})).not.toThrow()
  }
})

it('merges host overrides without dropping shipped fields', () => {
  const drivers = resolveSiteDrivers({ 'deepseek-web': { answer: '.answer', pollMs: 1 } })
  expect(drivers['deepseek-web']).toMatchObject({
    url: DEFAULT_SITE_DRIVERS['deepseek-web']?.url,
    input: DEFAULT_SITE_DRIVERS['deepseek-web']?.input,
    answer: '.answer',
    pollMs: 1,
  })
  expect(drivers['chatgpt-web']).toEqual(DEFAULT_SITE_DRIVERS['chatgpt-web'])
})

it('rejects an override for a provider that is not shipped', () => {
  expect(() => resolveSiteDrivers({ unknown: { url: 'https://example.test/' } }))
    .toThrow('no shipped provider "unknown"')
})

it.each(['url', 'input', 'answer', 'submitKey'] as const)('rejects an empty %s', (field) => {
  expect(() => resolveSiteDrivers({ 'deepseek-web': { [field]: '   ' } }))
    .toThrow(`driver "deepseek-web" has an empty ${field}`)
})

it('rejects poll bounds below one', () => {
  expect(() => resolveSiteDrivers({ 'gemini-web': { pollMs: 0 } })).toThrow('pollMs below 1')
  expect(() => resolveSiteDrivers({ 'gemini-web': { stablePolls: 0 } })).toThrow('stablePolls below 1')
})

it('rejects an uncompilable signed-out path', () => {
  expect(() => resolveSiteDrivers({ 'doubao-web': { signedOutPath: '(' } }))
    .toThrow('driver "doubao-web" has invalid signedOutPath')
})

it('accepts a driver without a signed-out path', () => {
  const driver = { url: 'https://fake.test/', input: '#prompt', answer: '.answer', submitKey: 'Enter' }
  expect(() => { validateSiteDriver('deepseek-web', driver) }).not.toThrow()
})

it('requires a driver for every shipped adapter', () => {
  expect(() => { assertEveryAdapterHasDriver({}) }).toThrow('no site driver for shipped provider')
  expect(() => { assertEveryAdapterHasDriver(resolveSiteDrivers({})) }).not.toThrow()
})
