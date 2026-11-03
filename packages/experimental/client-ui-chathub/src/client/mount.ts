/** Source-safe lifecycle for the optional chatHub Remote and the browser panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-experimental-chathub-host/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { RemoteResult, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ChatHubCreateInput } from '@deepseek-ai/dsh-experimental-chathub-host/types'
import { ChatHubPanel } from './ChatHubPanel.tsx'
import { ChatHubPanelIcon } from './PanelIcon.tsx'
import { createPanelStore } from './panel-store.ts'
import { en, ja, es, fr, de, ru, pt, zh, NS } from './locales.ts'

export const inject = ['remote', 'slots', 'locale']

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'chathub' as MainPanelId

/** Namespace-bound translator threaded through the ChatHub panel. */
export type ChatHubTranslate = TranslateNS<typeof NS>

/** Panel actions; every one routes through the `chatHub` or `webChat` Remote and lands in the store. */
export interface ChatHubPanelFace {
  /** Reload providers and the session list, keeping the open conversation. */
  refresh: () => Promise<void>
  /** Open a session: its full view plus its messages. */
  open: (sessionId: string) => Promise<void>
  /** Leave the open conversation and show the session list. */
  close: () => void
  /** Create a session and open it. */
  create: (input: ChatHubCreateInput) => Promise<void>
  /**
   * Send one turn in the open session.
   * @param content - the user's message.
   * @param providerId - model the conversation should answer with; the host
   * checkpoints and switches the session first when it differs from the current
   * one, so selecting a model applies at send time.
   */
  send: (content: string, providerId?: string) => Promise<void>
  /** Open the provider's interactive sign-in window. */
  login: (providerId: string) => Promise<void>
  /** Redo a provider's expired sign-in through the registry. */
  reauthenticate: (providerId: string) => Promise<void>
  /** Delete a session with its messages, timeline, and checkpoints. */
  remove: (sessionId: string) => Promise<void>
}

/** Store instance the face mutates; actions are the engine-baked draft mutators. */
type PanelInstance = ReturnType<ReturnType<typeof createPanelStore>['create']>

/** Unwrap one Remote result; the error branch becomes the thrown failure. */
async function expect<T>(call: Promise<RemoteResult<T>>): Promise<T> {
  const result = await call
  if (!result.ok) throw result.error
  return result.value
}

/** Human text of one thrown failure for the panel's error line. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build the panel face over the mounted `chatHub` and `webChat` Remotes.
 * @param ctx - browser plugin context owning the Remotes.
 * @param instance - the live panel store the face writes through.
 * @param t - namespace translator for the switch reason and error copy.
 * @returns the face injected into the panel component.
 */
function createFace(ctx: Context, instance: PanelInstance, t: ChatHubTranslate): ChatHubPanelFace {
  const actions: BoundActions<ReturnType<typeof createPanelStore>> = instance.actions
  const selectedId = (): string | undefined => instance.getSnapshot().selectedId
  const fail = (error: unknown, key?: 'message.error'): void => {
    actions.setError(key === undefined ? messageOf(error) : t(key, { error: messageOf(error) }))
  }
  const refresh = async (): Promise<void> => {
    actions.applyState(await expect(ctx.remote.chatHub.state()))
  }
  const refreshQuietly = (): void => { void refresh().catch(() => { /* the panel keeps its last known lists */ }) }
  const open = async (sessionId: string): Promise<void> => {
    const [detail, messages] = await Promise.all([
      expect(ctx.remote.chatHub.read(sessionId)),
      expect(ctx.remote.chatHub.history(sessionId)),
    ])
    actions.openSession(detail, messages)
  }
  return {
    refresh,
    open,
    close: () => { actions.closeSession() },
    create: async (input) => {
      actions.setBusy(true)
      actions.setError(undefined)
      try {
        const view = await expect(ctx.remote.chatHub.create(input))
        actions.openSession(view, [])
        refreshQuietly()
      } catch (error) {
        fail(error)
      } finally {
        actions.setBusy(false)
      }
    },
    send: async (content, providerId) => {
      const sessionId = selectedId()
      if (sessionId === undefined) return
      actions.setBusy(true)
      actions.setError(undefined)
      try {
        // The selection applies here, not when it was picked: the host writes
        // the checkpoint and hands the session over before the turn runs.
        if (providerId !== undefined && providerId !== instance.getSnapshot().detail?.currentProvider) {
          const switched = await expect(ctx.remote.chatHub.switch(sessionId, providerId, t('switch.reason')))
          const name = instance.getSnapshot().providers?.find(provider => provider.id === switched.to)?.name ?? switched.to
          await open(sessionId)
          actions.setSwitchNote(t('switch.done', { provider: name, checkpoint: switched.checkpointId }))
        }
        actions.appendMessage({ role: 'user', content, timestamp: Date.now() })
        const turn = await expect(ctx.remote.chatHub.send(sessionId, content))
        if (turn.assistant !== undefined) actions.appendMessage(turn.assistant)
        if (turn.lastError !== undefined) actions.setError(turn.lastError)
        refreshQuietly()
      } catch (error) {
        fail(error, 'message.error')
      } finally {
        actions.setBusy(false)
      }
    },
    login: async (providerId) => {
      actions.setPendingLogin(providerId)
      actions.setError(undefined)
      try {
        await expect(ctx.remote.webChat.login(providerId, new AbortController().signal))
        refreshQuietly()
      } catch (error) {
        fail(error)
      } finally {
        actions.setPendingLogin(undefined)
      }
    },
    reauthenticate: async (providerId) => {
      actions.setBusy(true)
      actions.setError(undefined)
      try {
        await expect(ctx.remote.webChat.reauthenticate(providerId))
        refreshQuietly()
      } catch (error) {
        fail(error)
      } finally {
        actions.setBusy(false)
      }
    },
    remove: async (sessionId) => {
      actions.setBusy(true)
      actions.setError(undefined)
      try {
        await expect(ctx.remote.chatHub.delete(sessionId))
        actions.forgetSession(sessionId)
        refreshQuietly()
      } catch (error) {
        fail(error)
      } finally {
        actions.setBusy(false)
      }
    },
  }
}

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-chathub: dictionaries')
  const t = ctx.locale.bind(NS)
  const handle = createPanelStore()
  const instance = handle.create()
  const face = createFace(ctx, instance, t)
  const store: typeof handle = { ...handle, create: () => instance }
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    store,
    inject: () => face,
  }, ChatHubPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => t('panel'),
    locale: NS,
  }, ChatHubPanelIcon))
}

/**
 * Mount the experimental ChatHub namespace without adding it to stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated chatHub Remote definitions.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountChatHubPanel(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.chatHub', 'remote.webChat', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeRemote(); throw error }
  return async () => { await ui.dispose(); await disposeRemote() }
}
