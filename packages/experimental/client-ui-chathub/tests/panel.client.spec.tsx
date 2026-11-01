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
import type { ChatHubProviderView, ChatHubSessionView, ChatHubSwitchResult } from '@deepseek-ai/dsh-experimental-chathub-host/types'
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
const SUMMARY = { id: 'sess_1', title: 'T', createdAt: 1, updatedAt: 2, currentProvider: 'deepseek-web', status: 'done' as const }
const DETAIL: ChatHubSessionView = { ...SUMMARY, goal: 'G', providerHistory: ['deepseek-web'] }
const SWITCHED: ChatHubSwitchResult = {
  sessionId: 'sess_1', from: 'deepseek-web', to: 'gemini-web', checkpointId: 'cp_1', status: 'idle',
}
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
    switchTo: vi.fn<ChatHubPanelFace['switchTo']>(async () => undefined),
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
  fireEvent.change(screen.getByLabelText(zh['session.provider.field']), { target: { value: 'gemini-web' } })
  fireEvent.click(start)
  expect(face.create).toHaveBeenLastCalledWith({ title: 'T', goal: 'Do it', provider: 'gemini-web' })
  fireEvent.change(screen.getByLabelText(zh['session.provider.field']), { target: { value: '' } })
  fireEvent.click(start)
  expect(face.create).toHaveBeenLastCalledWith({ title: 'T', goal: 'Do it', provider: 'deepseek-web' })
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
  expect(face.send).toHaveBeenCalledWith('hi')
  expect(composer.value).toBe('')
  fireEvent.change(composer, { target: { value: 'next' } })
  fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true })
  expect(face.send).toHaveBeenCalledOnce()
  expect(composer.value).toBe('next')
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

it('switches the model from the detail select and reports the checkpoint', async () => {
  const { face } = fixture((actions) => {
    applyLists(actions)
    actions.openSession(DETAIL, [])
  })
  const select = screen.getByRole('combobox', { name: zh['switch.label'] }) as HTMLSelectElement
  expect([...select.options].map(option => option.value)).toEqual(['', 'gemini-web'])
  // The placeholder option is a no-op.
  fireEvent.change(select, { target: { value: '' } })
  expect(face.switchTo).not.toHaveBeenCalled()
  // A switch resolving without a result leaves no note.
  fireEvent.change(select, { target: { value: 'gemini-web' } })
  expect(face.switchTo).toHaveBeenCalledWith('gemini-web')
  await act(async () => {})
  expect(screen.queryByText(/已切换到/)).toBeNull()
  // A completed switch reports the target provider and its checkpoint.
  face.switchTo.mockResolvedValueOnce(SWITCHED)
  fireEvent.change(select, { target: { value: 'gemini-web' } })
  await act(async () => {})
  expect(screen.getByText('已切换到 Gemini Web，检查点 cp_1')).toBeTruthy()
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
