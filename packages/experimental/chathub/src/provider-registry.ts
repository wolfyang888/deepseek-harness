/** Provider registration, readiness probing, and re-login recovery for ChatHub. */

import { ChatHubError } from './errors.ts'
import type {
  IModelProvider,
  IProviderRegistry,
  ModelKind,
  ProviderHealth,
  ProviderStatus,
} from './types.ts'

/**
 * Probe one provider without letting a broken readiness check stop the caller.
 * @param provider - Provider to probe.
 * @returns Its health, including a connection status consumers branch on.
 */
export async function probeProvider(provider: IModelProvider): Promise<ProviderHealth> {
  const lastCheckedAt = Date.now()
  try {
    const status: ProviderStatus = provider.healthStatus !== undefined
      ? await provider.healthStatus()
      : (await provider.isReady() ? 'ready' : 'needs-auth')
    if (status === 'ready') {
      return { providerId: provider.id, ready: true, status, lastCheckedAt }
    }
    // Non-ready statuses are self-explanatory; only failed probes carry a separate reason.
    return { providerId: provider.id, ready: false, status, lastCheckedAt }
  } catch (error) {
    // A rejected probe means the provider cannot serve; keep the reason for diagnostics.
    return failedHealth(provider, error, lastCheckedAt)
  }
}

/**
 * Build a failed health record for a rejected probe.
 * @param provider - Provider whose probe rejected.
 * @param error - Rejected value.
 * @param lastCheckedAt - Epoch millis when the probe finished.
 * @returns The failed health record.
 */
function failedHealth(provider: IModelProvider, error: unknown, lastCheckedAt: number): ProviderHealth {
  const failureReason = provider.normalizeError?.(error) ?? 'unknown'
  return { providerId: provider.id, ready: false, status: 'failed', lastCheckedAt, failureReason }
}

/** In-memory provider registry supporting replacement and identity-safe removal. */
export class ProviderRegistry implements IProviderRegistry {
  private readonly providers = new Map<string, IModelProvider>()

  /**
   * Add or replace a provider under its id.
   * @param provider - Provider to register.
   * @returns A disposer that removes the provider only while this registration is current.
   */
  register(provider: IModelProvider): () => void {
    this.providers.set(provider.id, provider)
    return () => {
      if (this.providers.get(provider.id) === provider) this.providers.delete(provider.id)
    }
  }

  /**
   * @param providerId - Provider id to look up.
   * @returns The registered provider, or undefined.
   */
  get(providerId: string): IModelProvider | undefined {
    return this.providers.get(providerId)
  }

  /** @returns Registered provider ids in registration order. */
  list(): string[] {
    return [...this.providers.keys()]
  }

  /**
   * @param kind - Transport kind to filter by.
   * @returns Registered providers of that kind, in registration order.
   */
  getByKind(kind: ModelKind): IModelProvider[] {
    return [...this.providers.values()].filter(provider => provider.kind === kind)
  }

  /**
   * Probe every registered provider.
   * @returns One health record per provider, in registration order.
   */
  async healthCheck(): Promise<ProviderHealth[]> {
    const health: ProviderHealth[] = []
    for (const provider of this.providers.values()) {
      health.push(await probeProvider(provider))
    }
    return health
  }

  /**
   * Probe one registered provider for a status view.
   * @param providerId - Provider id to probe.
   * @returns Its health record.
   * @throws ChatHubError with `provider-not-registered` when the id is unknown.
   */
  async health(providerId: string): Promise<ProviderHealth> {
    return probeProvider(this.require(providerId))
  }

  /**
   * Ask a signed-out or expired provider to reopen after the user signs in again.
   * @param providerId - Provider id to recover.
   * @returns The post-recovery health, or a failed record when reopening rejected.
   * @throws ChatHubError with `provider-not-registered` for an unknown id, or
   *   `reauth-not-supported` when the provider cannot reopen itself.
   */
  async reauthenticate(providerId: string): Promise<ProviderHealth> {
    const provider = this.require(providerId)
    if (provider.reauthenticate === undefined) {
      throw new ChatHubError(
        'reauth-not-supported',
        `ChatHub provider "${providerId}" cannot reopen its connection.`,
      )
    }
    try {
      await provider.reauthenticate()
    } catch (error) {
      return failedHealth(provider, error, Date.now())
    }
    return probeProvider(provider)
  }

  /**
   * @param providerId - Provider id to resolve.
   * @returns The registered provider.
   * @throws ChatHubError with `provider-not-registered` when the id is unknown.
   */
  private require(providerId: string): IModelProvider {
    const provider = this.providers.get(providerId)
    if (provider === undefined) {
      throw new ChatHubError('provider-not-registered', `ChatHub has no provider "${providerId}".`)
    }
    return provider
  }
}
