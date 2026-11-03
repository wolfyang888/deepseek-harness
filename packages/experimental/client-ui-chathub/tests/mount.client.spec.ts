/** The ChatHub panel mount: localized slots, Remote-backed face actions, and optional withdrawal. */
import { Context, Service } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { StoreHandle } from '@deepseek-ai/dsh-client-store'
import { RemoteError, type RemoteResult, type TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import type { ChatMessage, ProviderHealth } from '@deepseek-ai/dsh-experimental-chathub'
import type {
  ChatHubPanelState,
  ChatHubSessionView,
  ChatHubSwitchResult,
  ChatHubTurnResult,
} from '@deepseek-ai/dsh-experimental-chathub-host/types'
import { expect, it, vi } from 'vitest'
import { ChatHubPanel } from '../src/client/ChatHubPanel.tsx'
import { ChatHubPanelIcon } from '../src/client/PanelIcon.tsx'
import { mountChatHubPanel, PANEL_ID, inject, type ChatHubPanelFace } from '../src/client/mount.ts'
import { apply } from '../src/index.ts'
import type { ChatHubActions, ChatHubState } from '../src/client/panel-store.ts'

usePinnedBrowserLanguages('zh-CN')

const REMOTE: TypertRemoteContribution = {
  package: '@deepseek-ai/dsh-experimental-chathub-host',
  descriptors: [],
}

const CAPS = { reasoning: false, coding: false, vision: false, webAccess: true, streaming: true }
const PROVIDERS = [
  { id: 'deepseek-web', name: 'DeepSeek Web', kind: 'web' as const, capabilities: CAPS, status: 'ready' as const },
  { id: 'gemini-web', name: 'Gemini Web', kind: 'web' as const, capabilities: CAPS, status: 'needs-auth' as const },
]
const SUMMARY = { id: 'sess_1', title: 'T', createdAt: 1, updatedAt: 2, currentProvider: 'deepseek-web', status: 'done' as const }
const DETAIL: ChatHubSessionView = { ...SUMMARY, goal: 'G', providerHistory: ['deepseek-web'] }
const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hello', timestamp: 1 }]
const SWITCHED: ChatHubSwitchResult = {
  sessionId: 'sess_1', from: 'deepseek-web', to: 'gemini-web', checkpointId: 'cp_1', status: 'idle',
}
const HEALTH: ProviderHealth = { providerId: 'gemini-web', ready: false, status: 'needs-auth', lastCheckedAt: 1 }

/** One failing Remote result whose message the panel surfaces verbatim. */
function failure(message: string): RemoteResult<never> {
  return { ok: false, error: new RemoteError('gateway/internal', message, {}) }
}

function fixture() {
  const ctx = new Context()
  const unmount = vi.fn(async () => {})
  class Remote extends Service {
    constructor() { super(ctx, 'remote') }
    async $mount(contribution: TypertRemoteContribution) {
      expect(contribution).toBe(REMOTE)
      return unmount
    }
  }
  new Remote()
  const chatHub = {
    state: vi.fn<() => Promise<RemoteResult<ChatHubPanelState>>>(
      async () => ({ ok: true, value: { providers: PROVIDERS, sessions: [SUMMARY] } }),
    ),
    read: vi.fn<() => Promise<RemoteResult<ChatHubSessionView>>>(async () => ({ ok: true, value: DETAIL })),
    history: vi.fn<() => Promise<RemoteResult<ChatMessage[]>>>(async () => ({ ok: true, value: MESSAGES })),
    create: vi.fn<() => Promise<RemoteResult<ChatHubSessionView>>>(async () => ({ ok: true, value: DETAIL })),
    send: vi.fn<() => Promise<RemoteResult<ChatHubTurnResult>>>(async () => ({
      ok: true,
      value: { sessionId: 'sess_1', status: 'done', assistant: { role: 'assistant', content: 'answer', timestamp: 2 } },
    })),
    switch: vi.fn<() => Promise<RemoteResult<ChatHubSwitchResult>>>(async () => ({ ok: true, value: SWITCHED })),
    delete: vi.fn<() => Promise<RemoteResult<void>>>(async () => ({ ok: true, value: undefined })),
  }
  const webChat = {
    login: vi.fn<() => Promise<RemoteResult<ProviderHealth>>>(async () => ({ ok: true, value: HEALTH })),
    reauthenticate: vi.fn<() => Promise<RemoteResult<ProviderHealth>>>(async () => ({ ok: true, value: HEALTH })),
  }
  ctx.provide('remote.chatHub', chatHub)
  ctx.provide('remote.webChat', webChat)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, unmount, chatHub, webChat }
}

async function prepare(b: ReturnType<typeof fixture>) {
  await b.ctx.plugin(SlotRegistry)
  b.ctx.slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

/** Mount the panel and expose the registered face and the live store instance. */
async function mounted(b: ReturnType<typeof fixture>) {
  await prepare(b)
  const dispose = await mountChatHubPanel(b.ctx, REMOTE)
  const entry = b.ctx.slots.entries('main')[0]!
  const face = entry.inject!() as ChatHubPanelFace & Record<string, unknown>
  const instance = (entry.store as StoreHandle<ChatHubState, ChatHubActions>).create()
  return { dispose, face, instance }
}

it('declares its Client injections', () => {
  expect(inject).toEqual(['remote', 'slots', 'locale'])
})

it('provides no host-side behavior from its loader entry', () => {
  // oxlint-disable-next-line typescript/no-confusing-void-expression -- the entry's undefined return is the behavior under test
  expect(apply()).toBeUndefined()
})

it('closes the open session, forgets a deleted selected session, and swallows quiet refresh failures', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.refresh()
    await face.open('sess_1')
    face.close()
    expect(instance.getSnapshot().selectedId).toBeUndefined()
    expect(instance.getSnapshot().detail).toBeUndefined()
    expect(instance.getSnapshot().messages).toEqual([])
    await face.open('sess_1')
    // The post-delete list reload fails; the panel keeps its state without surfacing an error.
    b.chatHub.state.mockRejectedValueOnce(new Error('offline'))
    await face.remove('sess_1')
    expect(instance.getSnapshot().sessions).toEqual([])
    expect(instance.getSnapshot().selectedId).toBeUndefined()
    expect(instance.getSnapshot().error).toBeUndefined()
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('registers the localized main panel and sidebar entry and withdraws both on disposal', async () => {
  const b = fixture()
  try {
    const { dispose } = await mounted(b)
    const main = b.ctx.slots.entries('main')
    expect(main).toHaveLength(1)
    expect(main[0]).toMatchObject({ options: { key: PANEL_ID }, locale: 'chathub' })
    expect(main[0]?.component).toBe(ChatHubPanel)
    const side = b.ctx.slots.entries('sidebar.panellist')
    expect(side).toHaveLength(1)
    expect(side[0]).toMatchObject({ options: { id: PANEL_ID, order: 30 }, locale: 'chathub' })
    expect(side[0]?.component).toBe(ChatHubPanelIcon)
    expect(resolveSlotLabel(side[0]!.options.label)).toBe('ChatHub')
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
    expect(b.ctx.slots.entries('main')).toHaveLength(0)
    expect(b.ctx.slots.entries('sidebar.panellist')).toHaveLength(0)
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('refreshes the lists and opens a session through the Remotes', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.refresh()
    expect(b.chatHub.state).toHaveBeenCalledOnce()
    expect(instance.getSnapshot()).toMatchObject({ providers: PROVIDERS, sessions: [SUMMARY] })
    await face.open('sess_1')
    expect(b.chatHub.read).toHaveBeenCalledWith('sess_1')
    expect(b.chatHub.history).toHaveBeenCalledWith('sess_1')
    expect(instance.getSnapshot()).toMatchObject({ selectedId: 'sess_1', detail: DETAIL, messages: MESSAGES })
    b.chatHub.read.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) })
    // A failed open leaves the already-open conversation in place; the component owns the error line.
    await expect(face.open('sess_1')).rejects.toThrow('offline')
    expect(instance.getSnapshot().selectedId).toBe('sess_1')
    expect(instance.getSnapshot().error).toBeUndefined()
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('creates a session, opens it, and reports failures without losing the list', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.create({ title: 'New', goal: 'Do it', provider: 'deepseek-web' })
    expect(b.chatHub.create).toHaveBeenCalledWith({ title: 'New', goal: 'Do it', provider: 'deepseek-web' })
    expect(instance.getSnapshot()).toMatchObject({ selectedId: 'sess_1', messages: [], busy: false })
    b.chatHub.create.mockResolvedValueOnce(failure('provider gone'))
    await face.create({ title: 'New', goal: 'Do it', provider: 'deepseek-web' })
    expect(instance.getSnapshot().error).toBe('provider gone')
    expect(instance.getSnapshot().busy).toBe(false)
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('sends turns optimistically and lands assistant answers, failures, and Remote errors', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.send('alone')
    expect(b.chatHub.send).not.toHaveBeenCalled()
    await face.open('sess_1')
    b.chatHub.send.mockResolvedValueOnce({
      ok: true,
      value: { sessionId: 'sess_1', status: 'done', assistant: { role: 'assistant', content: 'answer', timestamp: 3 } },
    })
    await face.send('hello')
    expect(b.chatHub.send).toHaveBeenCalledWith('sess_1', 'hello')
    expect(instance.getSnapshot().messages.map(entry => entry.content)).toEqual(['hello', 'hello', 'answer'])
    b.chatHub.send.mockResolvedValueOnce({
      ok: true,
      value: { sessionId: 'sess_1', status: 'failed', lastError: 'deepseek-web: rate-limited' },
    })
    await face.send('again')
    expect(instance.getSnapshot().messages).toHaveLength(4)
    expect(instance.getSnapshot().error).toBe('deepseek-web: rate-limited')
    expect(instance.getSnapshot().busy).toBe(false)
    b.chatHub.send.mockRejectedValueOnce('raw rejection')
    await face.send('third')
    expect(instance.getSnapshot().error).toContain('raw rejection')
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('switches the open session when the turn names another model, then sends', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.send('alone', 'gemini-web')
    expect(b.chatHub.switch).not.toHaveBeenCalled()
    await face.open('sess_1')
    // The stored model answers as-is: no checkpoint, no second read.
    await face.send('hello', 'deepseek-web')
    expect(b.chatHub.switch).not.toHaveBeenCalled()
    expect(b.chatHub.send).toHaveBeenCalledWith('sess_1', 'hello')
    // A different model checkpoints and hands the session over before the turn.
    await face.send('hello', 'gemini-web')
    expect(b.chatHub.switch).toHaveBeenCalledWith('sess_1', 'gemini-web', expect.any(String))
    expect(b.chatHub.send).toHaveBeenLastCalledWith('sess_1', 'hello')
    expect(instance.getSnapshot().switchNote).toBe('Switched to Gemini Web; checkpoint cp_1')
    // The panel names the target from the provider list, and falls back to its
    // id when the refreshed list no longer carries it.
    b.chatHub.state.mockResolvedValueOnce({ ok: true, value: { providers: [], sessions: [SUMMARY] } })
    await face.refresh()
    await face.send('hello', 'gemini-web')
    expect(instance.getSnapshot().switchNote).toBe('Switched to gemini-web; checkpoint cp_1')
    await face.send('hello')
    expect(b.chatHub.switch).toHaveBeenCalledTimes(2)
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('reports a failed switch instead of sending the turn', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.open('sess_1')
    b.chatHub.switch.mockResolvedValueOnce(failure('not ready'))
    await face.send('hello', 'gemini-web')
    expect(b.chatHub.send).not.toHaveBeenCalled()
    expect(instance.getSnapshot().error).toBe('Send failed: not ready')
    expect(instance.getSnapshot().busy).toBe(false)
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('tracks the pending sign-in window through login and reports its failure', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    const opened = Promise.withResolvers<undefined>()
    b.webChat.login.mockImplementationOnce(async () => {
      await opened.promise
      return { ok: true, value: HEALTH }
    })
    const flight = face.login('gemini-web')
    await vi.waitFor(() => { expect(instance.getSnapshot().pendingLogin).toBe('gemini-web') })
    opened.resolve(undefined)
    await flight
    expect(b.webChat.login).toHaveBeenCalledWith('gemini-web', expect.any(AbortSignal))
    expect(instance.getSnapshot().pendingLogin).toBeUndefined()
    b.webChat.login.mockResolvedValueOnce(failure('window closed'))
    await face.login('gemini-web')
    expect(instance.getSnapshot().error).toBe('window closed')
    expect(instance.getSnapshot().pendingLogin).toBeUndefined()
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('reauthenticates a provider and deletes sessions with their projections', async () => {
  const b = fixture()
  try {
    const { dispose, face, instance } = await mounted(b)
    await face.reauthenticate('gemini-web')
    expect(b.webChat.reauthenticate).toHaveBeenCalledWith('gemini-web')
    expect(instance.getSnapshot().busy).toBe(false)
    b.webChat.reauthenticate.mockResolvedValueOnce(failure('still signed out'))
    await face.reauthenticate('gemini-web')
    expect(instance.getSnapshot().error).toBe('still signed out')
    await face.remove('sess_1')
    expect(b.chatHub.delete).toHaveBeenCalledWith('sess_1')
    await vi.waitFor(() => { expect(instance.getSnapshot().sessions).toEqual([]) })
    b.chatHub.delete.mockResolvedValueOnce(failure('locked'))
    await face.remove('sess_1')
    expect(instance.getSnapshot().error).toBe('locked')
    await dispose()
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})

it('rolls back the Remote contribution when the slot registration fails', async () => {
  const b = fixture()
  try {
    await prepare(b)
    vi.spyOn(b.ctx.slots, 'inject').mockImplementationOnce(() => { throw new Error('slot failed') })
    await expect(mountChatHubPanel(b.ctx, REMOTE)).rejects.toThrow('slot failed')
    expect(b.unmount).toHaveBeenCalledOnce()
  } finally {
    await b.ctx.fiber.dispose()
  }
})
