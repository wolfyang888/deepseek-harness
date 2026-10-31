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

  it('probes one provider by id for a status view', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'alpha', ready: true }))

    expect(await registry.health('alpha')).toEqual(expect.objectContaining({
      providerId: 'alpha',
      ready: true,
      status: 'ready',
    }))
    await expect(registry.health('missing')).rejects.toMatchObject({ code: 'provider-not-registered' })
  })

  it('reopens a provider and reports its post-login health', async () => {
    let signedIn = false
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'alpha',
      healthStatus: async () => signedIn ? 'ready' : 'needs-auth',
      reauthenticate: async () => { signedIn = true },
    }))

    expect(await registry.health('alpha')).toEqual(expect.objectContaining({
      ready: false,
      status: 'needs-auth',
    }))
    expect(await registry.reauthenticate('alpha')).toEqual(expect.objectContaining({
      ready: true,
      status: 'ready',
    }))
  })

  it('renews an expired provider session through re-login', async () => {
    let refreshed = false
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'alpha',
      healthStatus: async () => refreshed ? 'ready' : 'expired',
      reauthenticate: async () => { refreshed = true },
    }))

    expect(await registry.health('alpha')).toEqual(expect.objectContaining({
      ready: false,
      status: 'expired',
    }))
    expect(await registry.reauthenticate('alpha')).toEqual(expect.objectContaining({
      ready: true,
      status: 'ready',
    }))
  })

  it('reports a rejected re-login as failed health', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({
      id: 'alpha',
      reauthenticate: async () => { throw new Error('login failed') },
      normalizeError: 'auth-required',
    }))

    expect(await registry.reauthenticate('alpha')).toEqual(expect.objectContaining({
      providerId: 'alpha',
      ready: false,
      status: 'failed',
      failureReason: 'auth-required',
    }))
  })

  it('rejects re-login for unknown providers and providers without the capability', async () => {
    const registry = new ProviderRegistry()
    registry.register(fakeProvider({ id: 'alpha' }))

    await expect(registry.reauthenticate('missing'))
      .rejects.toMatchObject({ code: 'provider-not-registered' })
    await expect(registry.reauthenticate('alpha'))
      .rejects.toMatchObject({ code: 'reauth-not-supported' })
  })
})
