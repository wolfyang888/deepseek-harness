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
      expect.objectContaining({ providerId: 'alpha', ready: true, status: 'ready' }),
      expect.objectContaining({ providerId: 'beta', ready: false, status: 'needs-auth' }),
      expect.objectContaining({ providerId: 'gamma', ready: false, status: 'failed', failureReason: 'session expired' }),
    ])
    for (const health of await registry.healthCheck()) {
      expect(typeof health.lastCheckedAt).toBe('number')
    }
  })

  it('probes a provider without throwing on rejection', async () => {
    const ready = await probeProvider(fakeProvider({ id: 'alpha', ready: true }))
    expect(ready).toEqual(expect.objectContaining({
      providerId: 'alpha',
      ready: true,
      status: 'ready',
    }))
    expect(typeof ready.lastCheckedAt).toBe('number')

    const failed = await probeProvider(fakeProvider({ id: 'alpha', ready: new Error('offline') }))
    expect(failed).toEqual(expect.objectContaining({
      providerId: 'alpha',
      ready: false,
      status: 'failed',
      failureReason: 'offline',
    }))
  })

  it('uses the provider-reported health status when an adapter exposes one', async () => {
    expect(await probeProvider(fakeProvider({ id: 'delta', healthStatus: 'expired' }))).toEqual(
      expect.objectContaining({ providerId: 'delta', ready: false, status: 'expired' }),
    )
    expect(await probeProvider(fakeProvider({ id: 'delta', healthStatus: 'ready' }))).toEqual(
      expect.objectContaining({ providerId: 'delta', ready: true, status: 'ready' }),
    )
  })

  it('maps a rejected health status probe to failed', async () => {
    expect(await probeProvider(fakeProvider({ id: 'delta', healthStatus: new Error('tab crashed') }))).toEqual(
      expect.objectContaining({ providerId: 'delta', ready: false, status: 'failed', failureReason: 'tab crashed' }),
    )
  })

  it('routes a rejected probe through the provider normalizeError when present', async () => {
    const health = await probeProvider(
      fakeProvider({ id: 'delta', ready: new Error('rate limited'), normalizeError: 'rate-limited' }),
    )
    expect(health).toEqual(expect.objectContaining({
      providerId: 'delta',
      ready: false,
      status: 'failed',
      failureReason: 'rate-limited',
    }))
  })
})
