/**
 * The ChatHub panel: the provider selector with sign-in actions, the session
 * list with its create form, and the open conversation with its checkpointed
 * model switcher. Every action goes through the injected face; the component
 * holds no Remote calls of its own.
 */

import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Input, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatHubCreateInput, ProviderStatus, SessionStatus } from '@deepseek-ai/dsh-experimental-chathub-host/types'
import type { ChatHubPanelFace } from './mount.ts'
import type { createPanelStore } from './panel-store.ts'
import type { ChatHubLocaleKey } from './locales.ts'
import css from './ChatHubPanel.module.css'

/** Full component props assembled by the main slot renderer. */
export type ChatHubPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<'chathub'>
  & InjectFace<ChatHubPanelFace>
  & PropsStore<ReturnType<typeof createPanelStore>>

/** Session and provider states as the shared state-dot semantics. */
const SESSION_STATES: Record<string, StateDotState> = {
  idle: 'idle',
  thinking: 'ongoing',
  'tool-running': 'ongoing',
  waiting: 'ongoing',
  done: 'done',
  failed: 'error',
}

/** Connection states as the shared state-dot semantics. */
const PROVIDER_STATES: Record<string, StateDotState> = {
  'not-started': 'idle',
  ready: 'done',
  'needs-auth': 'warning',
  failed: 'error',
}

/** Locale keys naming each session status. */
const SESSION_STATUS_KEYS: Record<string, ChatHubLocaleKey> = {
  idle: 'session.status.idle',
  thinking: 'session.status.thinking',
  'tool-running': 'session.status.tool-running',
  waiting: 'session.status.waiting',
  done: 'session.status.done',
  failed: 'session.status.failed',
}

/** Session status as the shared state-dot semantics. */
function sessionDot(status: SessionStatus): StateDotState {
  /* v8 ignore next -- noUncheckedIndexedAccess fallback; every session status maps */
  return SESSION_STATES[status] ?? 'idle'
}

/** Session status as its locale key. */
function sessionStatusLabel(status: SessionStatus): ChatHubLocaleKey {
  /* v8 ignore next -- noUncheckedIndexedAccess fallback; every session status maps */
  return SESSION_STATUS_KEYS[status] ?? 'session.status.idle'
}

/** Provider connection status as the shared state-dot semantics. */
function providerDot(status: ProviderStatus): StateDotState {
  /* v8 ignore next -- noUncheckedIndexedAccess fallback; every provider status maps */
  return PROVIDER_STATES[status] ?? 'idle'
}

/** The create form's local fields. */
interface Draft {
  title: string
  goal: string
  provider: string | undefined
}

/**
 * Render the ChatHub panel over the store snapshot.
 * @param props - the runtime share, the dictionaries, the face, and the store hooks.
 * @returns the panel element.
 */
export function ChatHubPanel(props: ChatHubPanelProps): ReactNode {
  const { t, refresh, open, close, create, send, switchTo, login, reauthenticate, remove } = props
  const providers = props.useStore(state => state.providers)
  const sessions = props.useStore(state => state.sessions)
  const detail = props.useStore(state => state.detail)
  const messages = props.useStore(state => state.messages)
  const busy = props.useStore(state => state.busy)
  const pendingLogin = props.useStore(state => state.pendingLogin)
  const error = props.useStore(state => state.error)
  useEffect(() => { void refresh() }, [refresh])
  const [draft, setDraft] = useState<Draft>({ title: '', goal: '', provider: undefined })
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>(undefined)
  const [switchNote, setSwitchNote] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState('')

  const providerName = (id: string): string => providers?.find(provider => provider.id === id)?.name ?? id
  const createInput = (): ChatHubCreateInput | undefined => {
    const provider = draft.provider ?? providers?.find(candidate => candidate.status === 'ready')?.id
    if (provider === undefined || draft.title.trim() === '' || draft.goal.trim() === '') return undefined
    return { title: draft.title.trim(), goal: draft.goal.trim(), provider }
  }
  const submitMessage = (): void => {
    const content = message.trim()
    if (content === '' || busy) return
    setMessage('')
    void send(content)
  }
  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submitMessage()
    }
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <h2 className={css.headerTitle}>{t('title')}</h2>
        <Button size="sm" disabled={busy} onClick={() => { void refresh() }} aria-label={t('refresh')}>
          {t('refresh')}
        </Button>
      </header>
      {error !== undefined && (
        <div className={`${css.banner} ${css.bannerError}`} role="alert">
          <span className={css.bannerRow}>
            <span className={css.bannerText}>{error}</span>
            <Button size="sm" variant="ghost" onClick={() => { props.actions.setError(undefined) }}>×</Button>
          </span>
        </div>
      )}
      {pendingLogin !== undefined && (
        <div className={css.banner}>
          {t('provider.login.pending', { provider: providerName(pendingLogin) })}
        </div>
      )}
      <div className={css.scroll}>
        {detail === undefined ? (
          <>
            <section className={css.section}>
              <h3 className={css.sectionTitle}>{t('session.create')}</h3>
              <div className={css.form}>
                <label className={css.formLabel}>
                  {t('session.title.label')}
                  <Input value={draft.title} placeholder={t('session.title.placeholder')}
                    onChange={(event) => { setDraft(state => ({ ...state, title: event.target.value })) }} />
                </label>
                <label className={css.formLabel}>
                  {t('session.goal.label')}
                  <textarea className={css.formControl} rows={3} value={draft.goal}
                    placeholder={t('session.goal.placeholder')}
                    onChange={(event) => { setDraft(state => ({ ...state, goal: event.target.value })) }} />
                </label>
                <label className={css.formLabel}>
                  {t('session.provider.field')}
                  <select className={css.formControl} value={draft.provider ?? ''}
                    onChange={(event) => { setDraft(state => ({ ...state, provider: event.target.value === '' ? undefined : event.target.value })) }}>
                    <option value="" disabled>{t('session.provider.field')}</option>
                    {providers?.map(provider => (
                      <option key={provider.id} value={provider.id}>{providerName(provider.id)}</option>
                    ))}
                  </select>
                </label>
                <div>
                  <Button variant="primary" size="sm" disabled={busy || createInput() === undefined}
                    onClick={() => {
                      const input = createInput()
                      /* v8 ignore next -- the button is disabled whenever createInput() is undefined */
                      if (input !== undefined) void create(input)
                    }}>
                    {t('session.start')}
                  </Button>
                </div>
              </div>
            </section>
            <section className={css.section}>
              <h3 className={css.sectionTitle}>{t('session.heading')}</h3>
              {sessions === undefined ? null : sessions.length === 0 ? <p className={css.messageEmpty}>{t('session.empty')}</p> : (
                <div className={css.sessions}>
                  {sessions.map(session => (
                    <div key={session.id} className={css.bannerRow}>
                      <button type="button" className={css.sessionRow} onClick={() => { void open(session.id) }}>
                        <StateDot state={sessionDot(session.status)} />
                        <span className={css.sessionTitle}>{session.title}</span>
                        <span className={css.sessionProvider}>{t(sessionStatusLabel(session.status))}</span>
                        <span className={css.sessionProvider}>{providerName(session.currentProvider)}</span>
                      </button>
                      <Button size="sm" variant="ghost" disabled={busy}
                        aria-label={confirmDelete === session.id ? t('session.delete.confirm') : t('session.delete')}
                        onClick={() => {
                          if (confirmDelete === session.id) {
                            setConfirmDelete(undefined)
                            void remove(session.id)
                          } else {
                            setConfirmDelete(session.id)
                          }
                        }}>
                        {confirmDelete === session.id ? t('session.delete.confirm') : t('session.delete')}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <section className={css.section}>
            <div className={css.bannerRow}>
              <Button size="sm" variant="ghost" onClick={() => { setSwitchNote(undefined); close() }}>{t('session.back')}</Button>
              <StateDot state={sessionDot(detail.status)} />
              <span>{t(sessionStatusLabel(detail.status))}</span>
              <Button size="sm" variant="ghost" disabled={busy}
                aria-label={confirmDelete === detail.id ? t('session.delete.confirm') : t('session.delete')}
                onClick={() => {
                  if (confirmDelete === detail.id) {
                    setConfirmDelete(undefined)
                    void remove(detail.id)
                  } else {
                    setConfirmDelete(detail.id)
                  }
                }}>
                {confirmDelete === detail.id ? t('session.delete.confirm') : t('session.delete')}
              </Button>
            </div>
            <div className={css.detail}>
              <span className={css.detailFact}>{t('session.goal.field')}: {detail.goal}</span>
              <span className={css.detailFact}>{t('session.provider.field')}: {providerName(detail.currentProvider)}</span>
              {detail.providerHistory.length > 1 && (
                <span className={css.detailFact}>
                  {t('session.history.field')}: {detail.providerHistory.map(providerName).join(' → ')}
                </span>
              )}
            </div>
            <div className={css.bannerRow}>
              <label>
                {t('switch.label')}
                <select className={css.formControl} value="" aria-label={t('switch.label')} disabled={busy}
                  onChange={(event) => {
                    const providerId = event.target.value
                    event.target.value = ''
                    if (providerId === '') return
                    void switchTo(providerId).then((switched) => {
                      if (switched !== undefined) {
                        setSwitchNote(t('switch.done', { provider: providerName(switched.to), checkpoint: switched.checkpointId }))
                      }
                    })
                  }}>
                  <option value="" disabled>{t('switch.label')}</option>
                  {providers?.filter(provider => provider.id !== detail.currentProvider).map(provider => (
                    <option key={provider.id} value={provider.id}>{providerName(provider.id)}</option>
                  ))}
                </select>
              </label>
              {switchNote !== undefined && <span className={css.bannerText}>{switchNote}</span>}
            </div>
            <div className={css.messages}>
              {messages.length === 0 ? <p className={css.messageEmpty}>{t('message.empty')}</p> : messages.map((entry, index) => (
                <div key={index} className={`${css.message} ${entry.role === 'user' ? css.messageUser : css.messageAssistant}`}>
                  {entry.content}
                </div>
              ))}
            </div>
            <div className={css.composer}>
              <textarea className={`${css.formControl} ${css.composerInput}`} rows={1} value={message}
                placeholder={t('message.placeholder')} disabled={busy}
                onChange={(event) => { setMessage(event.target.value) }}
                onKeyDown={onComposerKey} />
              <Button variant="primary" size="sm" disabled={busy || message.trim() === ''} onClick={submitMessage}>
                {t('message.send')}
              </Button>
            </div>
          </section>
        )}
        {providers !== undefined && providers.some(provider => provider.status === 'needs-auth') && (
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{t('provider.heading')}</h3>
            <div className={css.sessions}>
              {providers.filter(provider => provider.status === 'needs-auth' || provider.status === 'failed').map(provider => (
                <div key={provider.id} className={css.bannerRow}>
                  <StateDot state={providerDot(provider.status)} />
                  <span className={css.sessionTitle}>{provider.name}</span>
                  <span className={css.sessionProvider}>
                    {provider.status === 'needs-auth'
                      ? t('provider.status.needs-auth')
                      : provider.failureReason !== undefined
                        ? t('provider.failure', { code: provider.failureReason })
                        : t('provider.status.failed')}
                  </span>
                  <Button size="sm" disabled={pendingLogin !== undefined}
                    onClick={() => {
                      if (provider.status === 'needs-auth') {
                        void login(provider.id)
                      } else {
                        void reauthenticate(provider.id)
                      }
                    }}>
                    {provider.status === 'needs-auth' ? t('provider.login') : t('provider.reauthenticate')}
                  </Button>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
