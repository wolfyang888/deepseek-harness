// @vitest-environment jsdom
/** The ChatHub panel component: banners, the create form, the session list, and the open conversation. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import assert from 'node:assert/strict'
import { allowAllAccess, bindSnapshotSelector, contextMenuHook, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatMessage } from '@deepseek-ai/dsh-experimental-chathub'
import type { ChatHubProviderView, ChatHubSessionView } from '@deepseek-ai/dsh-experimental-chathub-host/types'
import { afterEach, expect, it, vi } from 'vitest'
import { ChatHubPanel, type ChatHubPanelProps } from '../src/client/ChatHubPanel.tsx'
import { ChatHubPanelIcon } from '../src/client/PanelIcon.tsx'
import type { ChatHubPanelFace } from '../src/client/mount.ts'
import { createPanelStore } from '../src/client/panel-store.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

/** Selector hook over one fixed snapshot: how the renderer binds a standard source. */
function hook<T>(snapshot: T) {
  return function select<S>(selector: (state: T) => S): S { return selector(snapshot) }
}

const noSessions: SessionListState = { ids: [], byId: {}, phase: 'ready', projectionsBySession: {} }
const noStatus: SessionStatusSnapshot = new Map()
const noWorkspaces: WorkspaceSnapshot = {
  items: [], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
}
// Every fixture carries the resource hook the resources plugin merges into GlobalStandardProps.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

/** The global standard seat every root-scope entry receives. */
const standard: GlobalStandardProps = {
  useSessions: hook(noSessions),
  useSessionStatus: hook(noStatus),
  useSessionRetainInfo: () => undefined,
  usePanelInfo,
  useContextMenu: contextMenuHook(),
  useResource,
  useWorkspaces: hook(noWorkspaces),
  ...allowAllAccess,
}

const CAPS = { reasoning: false, coding: false, vision: false, webAccess: true, streaming: true }
const PROVIDERS: ChatHubProviderView[] = [
  { id: 'deepseek-web', name: 'DeepSeek Web', kind: 'web', capabilities: CAPS, status: 'ready' },
  { id: 'gemini-web', name: 'Gemini Web', kind: 'web', capabilities: CAPS, status: 'needs-auth' },
]
// A second ready provider: the only model the open conversation can switch to.
const READY_TARGET: ChatHubProviderView = {
  id: 'qwen-web', name: 'Qwen Web', kind: 'web', capabilities: CAPS, status: 'ready',
}
const SUMMARY = { id: 'sess_1', title: 'T', createdAt: 1, updatedAt: 2, currentProvider: 'deepseek-web', status: 'done' as const }
const DETAIL: ChatHubSessionView = { ...SUMMARY, goal: 'G', providerHistory: ['deepseek-web'] }
const MESSAGES: ChatMessage[] = [
  { role: 'user', content: 'hello', timestamp: 1 },
  { role: 'assistant', content: 'answer', timestamp: 2 },
]

type Instance = ReturnType<ReturnType<typeof createPanelStore>['create']>

/** Render the panel over a live store instance seeded through `patch`; face methods are mocks. */
function fixture(patch: (actions: Instance['actions']) => void = () => {}) {
  const instance = createPanelStore().create()
  patch(instance.actions)
  const face = {
    refresh: vi.fn<ChatHubPanelFace['refresh']>(async () => {}),
    open: vi.fn<ChatHubPanelFace['open']>(async () => {}),
    close: vi.fn<ChatHubPanelFace['close']>(),
    create: vi.fn<ChatHubPanelFace['create']>(async () => {}),
    send: vi.fn<ChatHubPanelFace['send']>(async () => {}),
    login: vi.fn<ChatHubPanelFace['login']>(async () => {}),
    reauthenticate: vi.fn<ChatHubPanelFace['reauthenticate']>(async () => {}),
    remove: vi.fn<ChatHubPanelFace['remove']>(async () => {}),
  } satisfies ChatHubPanelFace
  const props: ChatHubPanelProps = {
    ...standard,
    t: makeTranslate(zh),
    useStore: bindSnapshotSelector(instance),
    actions: instance.actions,
    ...face,
  }
  render(<ChatHubPanel {...props} />)
  return { face, instance }
}

function applyLists(actions: Instance['actions'], providers: ChatHubProviderView[] = PROVIDERS): void {
  actions.applyState({ providers, sessions: [SUMMARY] })
}

/** The view's only combobox: the create form's provider select, or the detail switch select. */
function combobox(): HTMLSelectElement {
  return screen.getByRole('combobox') as HTMLSelectElement
}

/** One option of a select by its value. */
function optionOf(select: HTMLSelectElement, value: string): HTMLOptionElement {
  const option = [...select.options].find(candidate => candidate.value === value)
  assert(option)
  return option
}

it('renders the sidebar icon at the requested size', () => {
  render(<ChatHubPanelIcon size={20} active={false} {...standard} />)
  expect(document.querySelector('svg')).toBeTruthy()
})

it('reloads the lists from the header refresh button', () => {
  const { face } = fixture((actions) => { applyLists(actions) })
  expect(face.refresh).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: zh['refresh'] }))
  expect(face.refresh).toHaveBeenCalledTimes(2)
})

it('refreshes on mount and dismisses the error banner through the store actions', () => {
  const { face, instance } = fixture((actions) => { actions.setError('boom') })
  expect(face.refresh).toHaveBeenCalledOnce()
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByText('boom')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '×' }))
  expect(instance.getSnapshot().error).toBeUndefined()
})

it('shows the pending sign-in banner and holds the provider sign-in buttons', () => {
  fixture((actions) => { applyLists(actions); actions.setPendingLogin('gemini-web') })
  expect(screen.getByText('等待 Gemini Web 登录完成…')).toBeTruthy()
  const login = screen.getByRole('button', { name: zh['provider.login'] }) as HTMLButtonElement
  expect(login.disabled).toBe(true)
})

it('creates a session from the form, defaulting to the first ready provider and trimming inputs', () => {
  const { face } = fixture((actions) => { applyLists(actions) })
  const title = screen.getByPlaceholderText(zh['session.title.placeholder']) as HTMLInputElement
  const goal = screen.getByPlaceholderText(zh['session.goal.placeholder']) as HTMLTextAreaElement
  const start = screen.getByRole('button', { name: zh['session.start'] }) as HTMLButtonElement
  expect(start.disabled).toBe(true)
  fireEvent.change(title, { target: { value: '   ' } })
  fireEvent.change(goal, { target: { value: 'Do it' } })
  expect(start.disabled).toBe(true)
  fireEvent.change(title, { target: { value: ' T ' } })
  expect(start.disabled).toBe(false)
  fireEvent.click(start)
  expect(face.create).toHaveBeenCalledWith({ title: 'T', goal: 'Do it', provider: 'deepseek-web' })
  fireEvent.change(combobox(), { target: { value: 'gemini-web' } })
  fireEvent.click(start)
  expect(face.create).toHaveBeenLastCalledWith({ title: 'T', goal: 'Do it', provider: 'gemini-web' })
  fireEvent.change(combobox(), { target: { value: '' } })
  fireEvent.click(start)
  expect(face.create).toHaveBeenLastCalledWith({ title: 'T', goal: 'Do it', provider: 'deepseek-web' })
})

it('lists every provider on the create form and lets only ready or needs-auth ones be picked', () => {
  fixture((actions) => {
    applyLists(actions, [
      ...PROVIDERS,
      { id: 'plain-api', name: 'Plain', kind: 'api', capabilities: CAPS, status: 'not-started' },
      { id: 'ollama-local', name: 'Ollama', kind: 'local', capabilities: CAPS, status: 'failed', failureReason: 'network-error' },
    ])
  })
  const select = combobox()
  expect([...select.options].map(option => option.value))
    .toEqual(['', 'deepseek-web', 'gemini-web', 'plain-api', 'ollama-local'])
  expect(optionOf(select, '').disabled).toBe(true)
  expect(optionOf(select, 'deepseek-web').disabled).toBe(false)
  expect(optionOf(select, 'gemini-web').disabled).toBe(false)
  expect(optionOf(select, 'plain-api').disabled).toBe(true)
  expect(optionOf(select, 'ollama-local').disabled).toBe(true)
  // A selectable provider shows its name alone; a blocked one names its state.
  expect(optionOf(select, 'deepseek-web').textContent).toBe('DeepSeek Web')
  expect(optionOf(select, 'gemini-web').textContent).toBe(`Gemini Web · ${zh['provider.status.needs-auth']}`)
  expect(optionOf(select, 'plain-api').textContent).toBe(`Plain · ${zh['provider.status.not-started']}`)
  expect(optionOf(select, 'ollama-local').textContent).toBe(`Ollama · ${zh['provider.status.failed']}`)
})

it('opens a session from its row and deletes it after the confirm click', () => {
  const { face } = fixture((actions) => { applyLists(actions) })
  fireEvent.click(screen.getByText('T'))
  expect(face.open).toHaveBeenCalledWith('sess_1')
  expect(face.remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['session.delete'] }))
  expect(screen.getByRole('button', { name: zh['session.delete.confirm'] })).toBeTruthy()
  expect(face.remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['session.delete.confirm'] }))
  expect(face.remove).toHaveBeenCalledWith('sess_1')
})

it('shows the empty hint for a loaded empty list and keeps everything pending before the first refresh', () => {
  fixture((actions) => { actions.applyState({ providers: PROVIDERS, sessions: [] }) })
  expect(screen.getByText(zh['session.empty'])).toBeTruthy()
})

it('stays pending while the lists are unloaded', () => {
  fixture()
  expect(screen.queryByText(zh['session.empty'])).toBeNull()
  expect(screen.queryByRole('button', { name: zh['provider.login'] })).toBeNull()
})

it('renders the conversation with facts, history, messages, and a back button', () => {
  const { face } = fixture((actions) => {
    applyLists(actions)
    actions.openSession({ ...DETAIL, currentProvider: 'ghost-web', providerHistory: ['deepseek-web', 'gemini-web'] }, MESSAGES)
  })
  expect(screen.getByText('任务目标: G')).toBeTruthy()
  expect(screen.getByText('当前模型: ghost-web')).toBeTruthy()
  expect(screen.getByText('切换记录: DeepSeek Web → Gemini Web')).toBeTruthy()
  expect(screen.getByText('hello')).toBeTruthy()
  expect(screen.getByText('answer')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['session.back'] }))
  expect(face.close).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: zh['session.delete'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['session.delete.confirm'] }))
  expect(face.remove).toHaveBeenCalledWith('sess_1')
})

it('renders an HTML answer as layout rather than literal markup', () => {
  fixture((actions) => {
    applyLists(actions)
    actions.openSession(DETAIL, [
      { role: 'assistant', content: '<table><tr><th>模型</th><th>延迟</th></tr><tr><td>豆包</td><td>1.2s</td></tr></table>' },
    ])
  })
  const cell = screen.getByText('豆包')
  expect(cell.tagName).toBe('TD')
  expect(document.body.textContent).not.toContain('<table>')
})

it('sends the trimmed composer draft with Enter and keeps Shift+Enter for a newline', () => {
  const { face } = fixture((actions) => {
    applyLists(actions)
    actions.openSession(DETAIL, [])
  })
  expect(screen.getByText(zh['message.empty'])).toBeTruthy()
  const composer = screen.getByPlaceholderText(zh['message.placeholder']) as HTMLTextAreaElement
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['message.send'] }).disabled).toBe(true)
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(face.send).not.toHaveBeenCalled()
  fireEvent.change(composer, { target: { value: ' hi ' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(face.send).toHaveBeenCalledWith('hi', 'deepseek-web')
  expect(composer.value).toBe('')
  fireEvent.change(composer, { target: { value: 'next' } })
  fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
  expect(face.send).toHaveBeenCalledOnce()
  expect(composer.value).toBe('next')
})

it('shows the local HH:mm time on every message and names the answering model', () => {
  fixture((actions) => {
    applyLists(actions)
    actions.openSession(DETAIL, [
      { role: 'user', content: 'question', timestamp: new Date(2026, 10, 3, 9, 5).getTime() },
      // The host stamps the speaker's provider id, so an answer signs itself.
      { role: 'assistant', content: 'answer', timestamp: new Date(2026, 10, 3, 10, 30).getTime(), name: 'deepseek-web' },
      { role: 'user', content: 'legacy row without a time' },
    ])
  })
  expect(screen.getByText('09:05')).toBeTruthy()
  // The signature resolves the id to the provider's display name.
  expect(screen.getByText('DeepSeek Web · 10:30')).toBeTruthy()
  expect(screen.getByText('legacy row without a time')).toBeTruthy()
  expect(screen.getAllByText(/·/)).toHaveLength(1)
})

it('renders the switch select inside the composer bar', () => {
  fixture((actions) => {
    applyLists(actions, [...PROVIDERS, READY_TARGET])
    actions.openSession(DETAIL, [])
  })
  const composer = screen.getByPlaceholderText(zh['message.placeholder'])
  const bar = composer.nextElementSibling
  assert(bar)
  expect(screen.getByRole('combobox')).toBe(bar.querySelector('select'))
})

it('disables the composer and the actions while a turn is in flight', () => {
  const { face } = fixture((actions) => {
    applyLists(actions)
    actions.openSession(DETAIL, MESSAGES)
    actions.setBusy(true)
  })
  const composer = screen.getByPlaceholderText(zh['message.placeholder']) as HTMLTextAreaElement
  expect(composer.disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['message.send'] }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['session.back'] }).disabled).toBe(false)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['session.delete'] }).disabled).toBe(true)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: zh['refresh'] }).disabled).toBe(true)
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(face.send).not.toHaveBeenCalled()
})

it('shows the conversation model in the select and sends the picked one with the turn', () => {
  const { face } = fixture((actions) => {
    applyLists(actions, [...PROVIDERS, READY_TARGET])
    actions.openSession(DETAIL, [])
  })
  const select = combobox()
  // Every ready provider is a choice, the current model included: the select
  // states which model answers instead of offering a separate command.
  expect([...select.options].map(option => option.value)).toEqual(['deepseek-web', 'qwen-web'])
  expect(select.value).toBe('deepseek-web')
  const composer = screen.getByPlaceholderText(zh['message.placeholder']) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'hi' } })
  // Picking a model switches nothing and asks nothing: it becomes the selection.
  fireEvent.change(select, { target: { value: 'qwen-web' } })
  expect(select.value).toBe('qwen-web')
  expect(face.send).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh['message.send'] }))
  expect(face.send).toHaveBeenCalledWith('hi', 'qwen-web')
  // Picking the model that already answers drops the change: the select states
  // the conversation's own model again.
  fireEvent.change(select, { target: { value: 'deepseek-web' } })
  expect(select.value).toBe('deepseek-web')
  fireEvent.change(composer, { target: { value: 'again' } })
  fireEvent.click(screen.getByRole('button', { name: zh['message.send'] }))
  expect(face.send).toHaveBeenLastCalledWith('again', 'deepseek-web')
})

it('sends the current model while no other one is ready', () => {
  const { face } = fixture((actions) => {
    applyLists(actions, [
      { id: 'deepseek-web', name: 'DeepSeek Web', kind: 'web', capabilities: CAPS, status: 'ready' },
      { id: 'gemini-web', name: 'Gemini Web', kind: 'web', capabilities: CAPS, status: 'failed' },
    ])
    actions.openSession(DETAIL, [])
  })
  const select = combobox()
  expect([...select.options].map(option => option.value)).toEqual(['deepseek-web'])
  expect(select.disabled).toBe(true)
  const composer = screen.getByPlaceholderText(zh['message.placeholder']) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'hi' } })
  fireEvent.keyDown(composer, { key: 'Enter' })
  expect(face.send).toHaveBeenCalledWith('hi', 'deepseek-web')
})

it('lists the signed-out conversation model so the select states what would run', () => {
  const { face, instance } = fixture((actions) => {
    applyLists(actions)
    actions.setError('gemini-web: auth-required')
    actions.openSession({ ...DETAIL, currentProvider: 'gemini-web', providerHistory: ['gemini-web'] }, [])
  })
  const select = combobox()
  // The conversation's own model is listed even when it cannot answer: the
  // select states which model would run, and the label explains why it cannot.
  expect([...select.options].map(option => option.value)).toEqual(['gemini-web', 'deepseek-web'])
  expect(select.value).toBe('gemini-web')
  expect(optionOf(select, 'gemini-web').textContent).toBe('Gemini Web · 需要登录')
  expect(select.disabled).toBe(false)
  // Picking a ready model also drops the stale failure banner of the old turn.
  fireEvent.change(select, { target: { value: 'deepseek-web' } })
  expect(instance.getSnapshot().pendingProvider).toBe('deepseek-web')
  expect(instance.getSnapshot().error).toBeUndefined()
  const composer = screen.getByPlaceholderText(zh['message.placeholder']) as HTMLTextAreaElement
  fireEvent.change(composer, { target: { value: 'hi' } })
  fireEvent.click(screen.getByRole('button', { name: zh['message.send'] }))
  expect(face.send).toHaveBeenCalledWith('hi', 'deepseek-web')
})

it('holds the model select while a turn is in flight', () => {
  const { instance } = fixture((actions) => {
    applyLists(actions, [...PROVIDERS, READY_TARGET])
    actions.openSession(DETAIL, [])
  })
  expect(combobox().disabled).toBe(false)
  act(() => { instance.actions.setBusy(true) })
  expect(combobox().disabled).toBe(true)
  act(() => { instance.actions.setBusy(false) })
  expect(combobox().disabled).toBe(false)
})

it('clears the picked model and the switch report when the conversation closes', () => {
  const { instance } = fixture((actions) => {
    applyLists(actions, [...PROVIDERS, READY_TARGET])
    actions.openSession(DETAIL, [])
  })
  fireEvent.change(combobox(), { target: { value: 'qwen-web' } })
  act(() => { instance.actions.setSwitchNote('已切换到 Qwen Web，检查点 cp_1') })
  expect(screen.getByText('已切换到 Qwen Web，检查点 cp_1')).toBeTruthy()
  act(() => { instance.actions.closeSession() })
  expect(instance.getSnapshot().pendingProvider).toBeUndefined()
  expect(instance.getSnapshot().switchNote).toBeUndefined()
  // Reopening the conversation starts from its stored model again.
  act(() => { instance.actions.openSession(DETAIL, []) })
  expect(combobox().value).toBe('deepseek-web')
  expect(screen.queryByText(/已切换到/)).toBeNull()
})

it('drops the picked model when the open conversation is deleted', () => {
  const { face, instance } = fixture((actions) => {
    applyLists(actions, [...PROVIDERS, READY_TARGET])
    actions.openSession(DETAIL, [])
  })
  fireEvent.change(combobox(), { target: { value: 'qwen-web' } })
  fireEvent.click(screen.getByRole('button', { name: zh['session.delete'] }))
  fireEvent.click(screen.getByRole('button', { name: zh['session.delete.confirm'] }))
  expect(face.remove).toHaveBeenCalledWith('sess_1')
  // The pick belonged to the conversation it was made on, so it goes with it.
  act(() => { instance.actions.forgetSession('sess_1') })
  expect(instance.getSnapshot().pendingProvider).toBeUndefined()
})

it('offers sign-in for needs-auth providers and re-authentication for failures', () => {
  const { face } = fixture((actions) => {
    applyLists(actions, [
      ...PROVIDERS,
      { id: 'ollama-local', name: 'Ollama', kind: 'local', capabilities: CAPS, status: 'failed', failureReason: 'network-error' },
      { id: 'plain-api', name: 'Plain', kind: 'api', capabilities: CAPS, status: 'failed' },
    ])
  })
  expect(screen.getByText('探测失败：network-error')).toBeTruthy()
  expect(screen.getByText(zh['provider.status.failed'])).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh['provider.login'] }))
  expect(face.login).toHaveBeenCalledWith('gemini-web')
  const failedRow = screen.getByText('探测失败：network-error').closest('div')
  assert(failedRow)
  fireEvent.click(within(failedRow).getByRole('button', { name: zh['provider.reauthenticate'] }))
  expect(face.reauthenticate).toHaveBeenCalledWith('ollama-local')
})

it('offers first-time sign-in for providers that have not started', () => {
  // Health probing never opens a browser, so a fresh host reports every provider
  // as not-started; the sign-in action is the only way out of that state.
  const { face } = fixture((actions) => {
    applyLists(actions, [
      { id: 'deepseek-web', name: 'DeepSeek Chat', kind: 'web', capabilities: CAPS, status: 'not-started' },
      { id: 'chatgpt-web', name: 'ChatGPT', kind: 'web', capabilities: CAPS, status: 'not-started' },
    ])
  })
  expect(screen.getAllByText(zh['provider.status.not-started'])).toHaveLength(2)
  const rows = screen.getAllByText(zh['provider.status.not-started']).map((node) => {
    const row = node.closest('div')
    assert(row)
    return row
  })
  fireEvent.click(within(rows[0]!).getByRole('button', { name: zh['provider.login'] }))
  expect(face.login).toHaveBeenCalledWith('deepseek-web')
  fireEvent.click(within(rows[1]!).getByRole('button', { name: zh['provider.login'] }))
  expect(face.login).toHaveBeenCalledWith('chatgpt-web')
  expect(face.reauthenticate).not.toHaveBeenCalled()
})

it('lists ready providers in the model section without a sign-in button', () => {
  fixture((actions) => { applyLists(actions) })
  expect(screen.getByText(zh['provider.status.ready'])).toBeTruthy()
  const readyRow = screen.getByText(zh['provider.status.ready']).closest('div')
  assert(readyRow)
  expect(readyRow.querySelector('button')).toBeNull()
})
