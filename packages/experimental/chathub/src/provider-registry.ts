/** Provider registration and readiness probing for ChatHub. */

import { errorMessage } from './errors.ts'
import type { IModelProvider, IProviderRegistry, ModelKind, ProviderHealth } from './types.ts'

/**
 * Probe one provider without letting a broken readiness check stop the caller.
 * @param provider - Provider to probe.
 * @returns Its health; a rejected probe reports the provider as not ready.
 */
export async function probeProvider(provider: IModelProvider): Promise<ProviderHealth> {
  try {
    return { providerId: provider.id, ready: await provider.isReady() }
  } catch (error) {
    // A rejected probe means the provider cannot serve; keep the reason for diagnostics.
    return { providerId: provider.id, ready: false, error: errorMessage(error) }
  }
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
}
