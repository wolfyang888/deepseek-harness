/** Panel store: one snapshot of providers, sessions, and the open conversation. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ChatMessage } from '@deepseek-ai/dsh-experimental-chathub'
import type { ChatHubPanelState, ChatHubProviderView, ChatHubSessionSummary, ChatHubSessionView } from '@deepseek-ai/dsh-experimental-chathub-host/types'

/** Panel state; absent reads stay `undefined` until the first refresh lands. */
export interface ChatHubState {
  providers: readonly ChatHubProviderView[] | undefined
  sessions: readonly ChatHubSessionSummary[] | undefined
  /** Open session; absent shows the session list. */
  selectedId: string | undefined
  /** Full view of the open session, including the goal and provider history. */
  detail: ChatHubSessionView | undefined
  /** Conversation of the open session, oldest first. */
  messages: readonly ChatMessage[]
  /**
   * Model the open conversation will use for its next turn; absent means its
   * current provider. Selecting one switches nothing yet — the send applies it.
   */
  pendingProvider: string | undefined
  /** Report of the checkpointed switch the last send applied. */
  switchNote: string | undefined
  /** A create, send, switch, or delete is in flight. */
  busy: boolean
  /** Provider whose interactive sign-in window is open. */
  pendingLogin: string | undefined
  /** Last failed action's message; never a raw site text. */
  error: string | undefined
}

/** Pure draft mutators; the mount layer owns every Remote call. */
export type ChatHubActions = {
  applyState: (draft: ChatHubState, state: ChatHubPanelState) => void
  openSession: (draft: ChatHubState, detail: ChatHubSessionView, messages: readonly ChatMessage[]) => void
  closeSession: (draft: ChatHubState) => void
  appendMessage: (draft: ChatHubState, message: ChatMessage) => void
  selectProvider: (draft: ChatHubState, providerId: string | undefined) => void
  setSwitchNote: (draft: ChatHubState, note: string | undefined) => void
  setBusy: (draft: ChatHubState, busy: boolean) => void
  setPendingLogin: (draft: ChatHubState, providerId: string | undefined) => void
  setError: (draft: ChatHubState, error: string | undefined) => void
  forgetSession: (draft: ChatHubState, sessionId: string) => void
}

/**
 * Create the registration-owned panel store. One instance lives for the
 * panel's registration; the store seat shares it across renders.
 * @returns the store handle wired into the `main` slot registration.
 */
export function createPanelStore(): EngineStoreHandle<ChatHubState, ChatHubActions> {
  return defineStore({
    init: (): ChatHubState => ({
      providers: undefined,
      sessions: undefined,
      selectedId: undefined,
      detail: undefined,
      messages: [],
      pendingProvider: undefined,
      switchNote: undefined,
      busy: false,
      pendingLogin: undefined,
      error: undefined,
    }),
    actions: {
      applyState: (draft, state) => {
        draft.providers = state.providers
        draft.sessions = state.sessions
      },
      openSession: (draft, detail, messages) => {
        draft.selectedId = detail.id
        draft.detail = detail
        draft.messages = messages
        draft.error = undefined
        // The stored provider is the selection from here on; an empty
        // conversation carries no switch report.
        draft.pendingProvider = undefined
        draft.switchNote = undefined
      },
      closeSession: (draft) => {
        draft.selectedId = undefined
        draft.detail = undefined
        draft.messages = []
        draft.error = undefined
        draft.pendingProvider = undefined
        draft.switchNote = undefined
      },
      appendMessage: (draft, message) => { draft.messages = [...draft.messages, message] },
      selectProvider: (draft, providerId) => {
        draft.pendingProvider = providerId
        // The report describes the switch the last send performed, not this pick.
        draft.switchNote = undefined
        // A failure banner describes the previous model's turn; picking another
        // model means the next send answers on it, so the stale banner leaves.
        draft.error = undefined
      },
      setSwitchNote: (draft, note) => { draft.switchNote = note },
      setBusy: (draft, busy) => { draft.busy = busy },
      setPendingLogin: (draft, providerId) => { draft.pendingLogin = providerId },
      setError: (draft, error) => { draft.error = error },
      forgetSession: (draft, sessionId) => {
        draft.sessions = draft.sessions?.filter(session => session.id !== sessionId)
        if (draft.selectedId === sessionId) {
          draft.selectedId = undefined
          draft.detail = undefined
          draft.messages = []
          draft.pendingProvider = undefined
          draft.switchNote = undefined
        }
      },
    },
  })
}
