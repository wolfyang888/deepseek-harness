/** Provider registration, lookup, removal, and readiness probing. */

import { describe, expect, it } from 'vitest'
import { ProviderRegistry, probeProvider } from '@deepseek-ai/dsh-experimental-chathub'
import { fakeProvider } from './fixtures.ts'

describe('ProviderRegistry', () => {
  it('registers, lists, looks up, and filters by kind', () => {
    const registry = new ProviderRegistry()
    const web = fakeProvider({ id: 'deepseek-web', kind: 'web' })
    const api = fakeProvider({ id: 'deepseek-api', kind: 'api' })

    registry.register(web)
    registry.register(api)

    expect(registry.list()).toEqual(['deepseek-web', 'deepseek-api'])
    expect(registry.get('deepseek-web')).toBe(web)
    expect(registry.get('missing')).toBeUndefined()
    expect(registry.getByKind('web')).toEqual([web])
    expect(registry.getByKind('local')).toEqual([])
  })

  it('removes a provider only while its registration is current', () => {
    const registry = new ProviderRegistry()
    const first = fakeProvider({ id: 'deepseek-web' })
    const disposeFirst = registry.register(first)
    const second = fakeProvider({ id: 'deepseek-web' })
    registry.register(second)

    disposeFirst()
    expect(registry.get('deepseek-web')).toBe(second)

    const disposeSecond = registry.register(second)
    disposeSecond()
    expect(registry.get('deepseek-web')).toBeUndefined()
  })

  it('reports readiness and probe failures per provider', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'alpha', ready: true }))
    registry.register(fakeProvider({ id: 'beta', ready: false }))
    registry.register(fakeProvider({ id: 'gamma', ready: new Error('session expired') }))

    expect(await registry.healthCheck()).toEqual([
      { providerId: 'alpha', ready: true, status: 'ready' },
      { providerId: 'beta', ready: false, status: 'needs-auth' },
      { providerId: 'gamma', ready: false, status: 'failed', error: 'session expired' },
    ])
  })

  it('probes a provider without throwing on rejection', async () => {
    expect(await probeProvider(fakeProvider({ id: 'alpha', ready: true }))).toEqual({
      providerId: 'alpha',
      ready: true,
      status: 'ready',
    })
    expect(await probeProvider(fakeProvider({ id: 'alpha', ready: new Error('offline') }))).toEqual({
      providerId: 'alpha',
      ready: false,
      status: 'failed',
      error: 'offline',
    })
  })

  it('uses the provider-reported health status when an adapter exposes one', async () => {
    expect(await probeProvider(fakeProvider({ id: 'delta', healthStatus: 'expired' }))).toEqual({
      providerId: 'delta',
      ready: false,
      status: 'expired',
    })
    expect(await probeProvider(fakeProvider({ id: 'delta', healthStatus: 'ready' }))).toEqual({
      providerId: 'delta',
      ready: true,
      status: 'ready',
    })
  })

  it('maps a rejected health status probe to failed', async () => {
    expect(await probeProvider(fakeProvider({ id: 'delta', healthStatus: new Error('tab crashed') }))).toEqual({
      providerId: 'delta',
      ready: false,
      status: 'failed',
      error: 'tab crashed',
    })
  })
})
