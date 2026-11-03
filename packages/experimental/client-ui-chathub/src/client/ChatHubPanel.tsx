/**
 * The ChatHub panel: the provider selector with sign-in actions, the session
 * list with its create form, and the open conversation whose model switcher
 * summarizes the checkpoint handoff before switching. Every action goes
 * through the injected face; the component holds no Remote calls of its own.
 */

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, Input, MarkdownText, StateDot, type MarkdownLabels, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatHubCreateInput, ChatHubProviderView, ProviderStatus, SessionStatus } from '@deepseek-ai/dsh-experimental-chathub-host/types'
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

/** Locale keys naming each provider connection status. */
const PROVIDER_STATUS_KEYS: Record<string, ChatHubLocaleKey> = {
  'not-started': 'provider.status.not-started',
  ready: 'provider.status.ready',
  'needs-auth': 'provider.status.needs-auth',
  failed: 'provider.status.failed',
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

/** Provider connection status as its locale key. */
function providerStatusLabel(status: ProviderStatus): ChatHubLocaleKey {
  /* v8 ignore next -- noUncheckedIndexedAccess fallback; every provider status maps */
  return PROVIDER_STATUS_KEYS[status] ?? 'provider.status.not-started'
}

/**
 * Whether a new session may start on this provider.
 * @param status - the provider's probed connection status.
 * @returns true for `ready` and `needs-auth`; an unstarted or failed provider is
 * listed but never selectable, per the provider-selector rule of the UI plan.
 */
function providerSelectable(status: ProviderStatus): boolean {
  return status === 'ready' || status === 'needs-auth'
}

/** Statuses whose row belongs to the sign-in section. */
const SIGNIN_STATUSES: ReadonlySet<string> = new Set(['not-started', 'needs-auth', 'failed'])

/**
 * Whether the provider needs a sign-in action before it can serve a turn.
 * @param status - the provider's probed connection status.
 * @returns true for `not-started` (first sign-in), `needs-auth`, and `failed`;
 * health probing never opens a browser, so an unstarted provider can only move
 * to a signed-in state through the explicit sign-in action.
 */
function providerNeedsSignin(status: ProviderStatus): boolean {
  return SIGNIN_STATUSES.has(status)
}

/**
 * Format one message timestamp as the panel's local clock time.
 * @param timestamp - epoch millis the host recorded; absent on legacy rows.
 * @returns The `HH:mm` label, or an empty string when the row has no time.
 */
function messageTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return ''
  const at = new Date(timestamp)
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
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
  // Target of the switch select, held until the user confirms the checkpoint.
  // Invariant: a pending target only means something inside the open conversation,
  // so every path that leaves it (back, delete) clears this state as well.
  const [pendingSwitch, setPendingSwitch] = useState<string | undefined>(undefined)
  const [message, setMessage] = useState('')
  // Markdown chrome for assistant bubbles; stable across renders so the
  // streaming memo does not rebuild its parser on every state change.
  const markdownLabels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('message.code.copy'), copiedLabel: t('message.code.copied') },
    footnotes: t('message.footnotes'),
  }), [t])

  const providerName = (id: string): string => providers?.find(provider => provider.id === id)?.name ?? id
  // Options name their connection status so a greyed-out provider explains itself.
  const providerOptionText = (provider: ChatHubProviderView): string => provider.status === 'ready'
    ? provider.name
    : `${provider.name} · ${t(providerStatusLabel(provider.status))}`
  // Only a ready provider can take a session over; the current one has nothing to switch to.
  const switchTargets: readonly ChatHubProviderView[] = providers === undefined
    ? []
    : providers.filter(provider => provider.status === 'ready' && provider.id !== detail?.currentProvider)
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
  const cancelSwitch = (): void => { setPendingSwitch(undefined) }
  // The switch itself stays behind this confirmation: the host checkpoints the
  // session before the target provider continues.
  const confirmSwitch = (): void => {
    const providerId = pendingSwitch
    /* v8 ignore next -- the confirmation only renders while a target is pending */
    if (providerId === undefined) return
    setPendingSwitch(undefined)
    void switchTo(providerId).then((switched) => {
      if (switched !== undefined) {
        setSwitchNote(t('switch.done', { provider: providerName(switched.to), checkpoint: switched.checkpointId }))
      }
    })
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
                      <option key={provider.id} value={provider.id} disabled={!providerSelectable(provider.status)}>
                        {providerOptionText(provider)}
                      </option>
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
              <Button size="sm" variant="ghost" onClick={() => { setSwitchNote(undefined); setPendingSwitch(undefined); close() }}>{t('session.back')}</Button>
              <StateDot state={sessionDot(detail.status)} />
              <span>{t(sessionStatusLabel(detail.status))}</span>
              <Button size="sm" variant="ghost" disabled={busy}
                aria-label={confirmDelete === detail.id ? t('session.delete.confirm') : t('session.delete')}
                onClick={() => {
                  if (confirmDelete === detail.id) {
                    setConfirmDelete(undefined)
                    // The open conversation closes with it, so a pending switch must not outlive it.
                    setPendingSwitch(undefined)
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
            {pendingSwitch !== undefined && (
              <div className={css.confirm}>
                <p className={css.confirmTitle}>{t('switch.confirm.title')}</p>
                <span className={css.detailFact}>
                  {t('switch.confirm.route', { from: providerName(detail.currentProvider), to: providerName(pendingSwitch) })}
                </span>
                <span className={css.detailFact}>{t('switch.confirm.goal', { goal: detail.goal })}</span>
                <span className={css.detailFact}>
                  {t('switch.confirm.state', {
                    status: t(sessionStatusLabel(detail.status)),
                    // The chain starts with the session's first provider, so only its tail are switches.
                    history: String(Math.max(0, detail.providerHistory.length - 1)),
                  })}
                </span>
                <p className={css.confirmNote}>{t('switch.confirm.note')}</p>
                <div className={css.bannerRow}>
                  <Button variant="primary" size="sm" disabled={busy} onClick={confirmSwitch}>
                    {t('switch.confirm.ok')}
                  </Button>
                  <Button size="sm" onClick={cancelSwitch}>{t('switch.confirm.cancel')}</Button>
                </div>
              </div>
            )}
            <div className={css.messages}>
              {messages.length === 0 ? <p className={css.messageEmpty}>{t('message.empty')}</p> : messages.map((entry, index) => (
                <div key={index} className={`${css.message} ${entry.role === 'user' ? css.messageUser : css.messageAssistant}`}>
                  {entry.role === 'assistant'
                    ? <MarkdownText text={entry.content} labels={markdownLabels} variant="compact" />
                    : entry.content}
                  {messageTime(entry.timestamp) !== '' && (
                    <span className={entry.role === 'user' ? css.messageTimeUser : css.messageTimeAssistant}>
                      {messageTime(entry.timestamp)}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div className={css.composer}>
              <textarea className={`${css.formControl} ${css.composerInput}`} rows={1} value={message}
                placeholder={t('message.placeholder')} disabled={busy}
                onChange={(event) => { setMessage(event.target.value) }}
                onKeyDown={onComposerKey} />
              <div className={css.composerBar}>
                <select className={css.composerSwitch} value="" aria-label={t('switch.label')}
                  disabled={busy || switchTargets.length === 0}
                  onChange={(event) => {
                    const providerId = event.target.value
                    event.target.value = ''
                    if (providerId === '') return
                    setSwitchNote(undefined)
                    setPendingSwitch(providerId)
                  }}>
                  <option value="" disabled>{t('switch.label')}</option>
                  {switchTargets.map(provider => (
                    <option key={provider.id} value={provider.id}>{providerOptionText(provider)}</option>
                  ))}
                </select>
                {switchNote !== undefined && <span className={css.composerNote}>{switchNote}</span>}
                <Button variant="primary" size="md" className={css.composerSend} disabled={busy || message.trim() === ''} onClick={submitMessage}>
                  {t('message.send')}
                </Button>
              </div>
            </div>
          </section>
        )}
        {providers !== undefined && providers.length > 0 && (
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{t('provider.heading')}</h3>
            <div className={css.sessions}>
              {providers.map(provider => (
                <div key={provider.id} className={css.bannerRow}>
                  <StateDot state={providerDot(provider.status)} />
                  <span className={css.sessionTitle}>{provider.name}</span>
                  <span className={css.sessionProvider}>
                    {provider.status === 'failed' && provider.failureReason !== undefined
                      ? t('provider.failure', { code: provider.failureReason })
                      : t(providerStatusLabel(provider.status))}
                  </span>
                  {providerNeedsSignin(provider.status) && (
                    <Button size="sm" disabled={pendingLogin !== undefined}
                      onClick={() => {
                        if (provider.status === 'failed') {
                          void reauthenticate(provider.id)
                        } else {
                          void login(provider.id)
                        }
                      }}>
                      {provider.status === 'failed' ? t('provider.reauthenticate') : t('provider.login')}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
