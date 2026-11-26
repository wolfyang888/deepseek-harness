/**
 * Side-by-side model comparison: one prompt, two models, one shared input.
 *
 * The pane owns no Remote call — the panel hands it the compare face — and it
 * opens no session: a comparison is a scratch question, so switching models
 * here must never touch a stored conversation or write a checkpoint. Files the
 * user pastes or picks travel to both models, each site receiving them through
 * its own upload input.
 */

import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type ReactNode } from 'react'
import { Button, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatAttachment } from '@deepseek-ai/dsh-experimental-chathub'
import type { ChatHubCompareEvent, ChatHubProviderView } from '@deepseek-ai/dsh-experimental-chathub-host/types'
import { MessageBody } from './MessageBody.tsx'
import type { ChatHubTranslate } from './mount.ts'
import css from './ComparePane.module.css'

/** Files one comparison may carry; every site uploads them one at a time. */
const MAX_ATTACHMENTS = 6

/** Largest single file the panel reads into memory before sending. */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Columns this pane asks for: the comparison layout is a pair. */
const COLUMNS = 2

/** A picked file, plus what its chip renders. */
interface StagedFile extends ChatAttachment {
  /** Data URL for an image chip; empty when the browser cannot render it. */
  preview: string
  /** Size in bytes, shown on the chip. */
  size: number
}

/** Live state of one comparison column, keyed by provider id. */
interface ColumnState {
  /** Answer markup the site has produced so far. */
  content: string
  /** The site's visible reasoning trace; absent until it renders one. */
  reasoning?: string
  /** `waiting` while the site is still writing, then the settled outcome. */
  status: 'waiting' | 'done' | 'failed'
  /** Stable failure code, present when `status` is `failed`. */
  lastError?: string
  /** Milliseconds this column took; present once it settled. */
  elapsedMs?: number
}

/**
 * Read one picked file into the wire shape the host decodes.
 *
 * The host receives base64 without a data-URL prefix, which is the shape the
 * site's upload input wants; the prefix stays here, where the image chip uses
 * it for its thumbnail.
 * @param file - the file the user picked or pasted.
 * @returns The staged file, with a preview when it can be shown inline.
 */
async function stageFile(file: File): Promise<StagedFile> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => { resolve(String(reader.result)) })
    reader.addEventListener('error', () => { reject(reader.error ?? new Error('the file could not be read')) })
    reader.readAsDataURL(file)
  })
  const comma = dataUrl.indexOf(',')
  const mimeType = file.type === '' ? 'application/octet-stream' : file.type
  return {
    // A pasted screenshot carries no filename; the site still needs one.
    name: file.name === '' ? `pasted-${Date.now()}.png` : file.name,
    mimeType,
    data: comma === -1 ? '' : dataUrl.slice(comma + 1),
    preview: mimeType.startsWith('image/') ? dataUrl : '',
    size: file.size,
  }
}

/**
 * Human size of one attachment chip.
 * @param bytes - file size in bytes.
 * @returns A short label such as `830 KB`.
 */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Props the panel hands the comparison pane. */
export interface ComparePaneProps {
  /** Models that can answer right now, in registry order. */
  providers: readonly ChatHubProviderView[]
  /** Markdown chrome for the answer bodies. */
  labels: MarkdownLabels
  /** The compare face; each column streams while the host drives its site. */
  compare: (
    content: string,
    providers: readonly string[],
    attachments: readonly ChatAttachment[],
    signal?: AbortSignal,
  ) => AsyncIterable<ChatHubCompareEvent>
  /** Namespace translator. */
  t: ChatHubTranslate
}

/**
 * Render the comparison view.
 * @param props - the ready models, the compare face, and the dictionaries.
 * @returns the comparison element.
 */
export function ComparePane(props: ComparePaneProps): ReactNode {
  const { providers, labels, compare, t } = props
  const [left, setLeft] = useState<string | undefined>(undefined)
  const [right, setRight] = useState<string | undefined>(undefined)
  const [prompt, setPrompt] = useState('')
  const [files, setFiles] = useState<readonly StagedFile[]>([])
  const [columns, setColumns] = useState<Record<string, ColumnState>>({})
  const [asked, setAsked] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const picker = useRef<HTMLInputElement>(null)
  const run = useRef<AbortController | undefined>(undefined)

  // Leaving the pane cancels both site turns; their columns cease to exist.
  useEffect(() => () => { run.current?.abort() }, [])

  // The first two ready models are the default pair: the pane exists to
  // compare, and making the user pick twice before the first question is
  // friction that answers nothing.
  const firstReady = providers[0]?.id
  const secondReady = providers[1]?.id
  const leftId = left ?? firstReady
  const rightId = right ?? secondReady ?? firstReady
  const canCompare = providers.length >= COLUMNS
  const nameOf = (providerId: string): string =>
    providers.find(provider => provider.id === providerId)?.name ?? providerId

  /**
   * Stage picked files, within the pane's count and size limits.
   * @param picked - files the user selected or pasted.
   * @returns Resolves when every accepted file has been read.
   */
  const stage = async (picked: readonly File[]): Promise<void> => {
    const room = MAX_ATTACHMENTS - files.length
    if (room <= 0) return
    const usable = picked.filter(file => file.size <= MAX_ATTACHMENT_BYTES).slice(0, room)
    if (usable.length === 0) return
    const staged = await Promise.all(usable.map(stageFile))
    setFiles(current => [...current, ...staged])
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const pasted = [...event.clipboardData.files]
    if (pasted.length === 0) return
    // A pasted screenshot is the file: letting the paste also insert its text
    // form would ask the model to read pixels twice.
    event.preventDefault()
    void stage(pasted)
  }

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const picked = [...(event.target.files ?? [])]
    // The same file picked twice must stage twice, so the input forgets it.
    event.target.value = ''
    void stage(picked)
  }

  const submit = (): void => {
    const content = prompt.trim()
    if (content === '' || busy) return
    if (leftId === undefined || rightId === undefined || leftId === rightId) {
      setError(t('compare.needTwo'))
      return
    }
    const asking = [leftId, rightId]
    const controller = new AbortController()
    run.current?.abort()
    run.current = controller
    setBusy(true)
    setError(undefined)
    // The composer is cleared on submit; the question stays above the columns
    // so the answers keep their prompt while they stream in.
    setAsked(content)
    setPrompt('')
    setColumns(Object.fromEntries(asking.map(id => [id, { content: '', status: 'waiting' as const }])))
    void (async () => {
      try {
        const attachments = files.map(({ name, mimeType, data }) => ({ name, mimeType, data }))
        for await (const event of compare(content, asking, attachments, controller.signal)) {
          // A superseded run must not write into the columns of the newer one.
          if (run.current !== controller) return
          if (event.kind === 'progress') {
            setColumns(current => ({
              ...current,
              [event.provider]: {
                ...current[event.provider] ?? { content: '', status: 'waiting' as const },
                content: event.content,
              },
            }))
            continue
          }
          const side = event.side
          setColumns(current => ({
            ...current,
            [side.provider]: {
              content: side.content ?? '',
              ...side.reasoning === undefined ? {} : { reasoning: side.reasoning },
              status: side.status,
              ...side.lastError === undefined ? {} : { lastError: side.lastError },
              elapsedMs: side.elapsedMs,
            },
          }))
        }
      } catch (failure: unknown) {
        // An explicit stop is not an error: the columns already read as
        // stopped, so a carrier cancellation rejection stays quiet.
        if (run.current === controller && !controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : String(failure))
        }
      } finally {
        if (run.current === controller) setBusy(false)
      }
    })()
  }

  /**
   * Stop the running comparison where it stands.
   *
   * The abort travels to the host, which stops driving the sites and closes
   * the scratch conversations; columns that never settled read as stopped
   * here instead of waiting forever, so the composer unlocks at once.
   */
  const stop = (): void => {
    const controller = run.current
    if (controller === undefined) return
    controller.abort()
    setColumns(current => Object.fromEntries(Object.entries(current).map(([providerId, column]) => [
      providerId,
      column.status === 'waiting' ? { ...column, status: 'failed' as const, lastError: t('compare.stopped') } : column,
    ])))
  }

  return (
    <section className={css.root}>
      <div className={css.picks}>
        <label className={css.pick}>
          <span className={css.pickLabel}>{t('compare.model.a')}</span>
          <select className={css.select} value={leftId ?? ''} disabled={busy}
            onChange={(event) => { setLeft(event.target.value) }}>
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
        </label>
        <label className={css.pick}>
          <span className={css.pickLabel}>{t('compare.model.b')}</span>
          <select className={css.select} value={rightId ?? ''} disabled={busy}
            onChange={(event) => { setRight(event.target.value) }}>
            {providers.map(provider => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </select>
        </label>
      </div>
      {error !== undefined && <div className={css.error} role="alert">{error}</div>}
      {asked !== '' && (
        <div className={css.question}>
          <span className={css.questionLabel}>{t('compare.question')}</span>
          <span className={css.questionText}>{asked}</span>
        </div>
      )}
      <div className={css.panes}>
        {[leftId, rightId].map((providerId, index) => {
          const column = providerId === undefined ? undefined : columns[providerId]
          /* v8 ignore next -- the two columns are rendered by position */
          const label = index === 0 ? t('compare.model.a') : t('compare.model.b')
          return (
            <article key={index} className={css.pane}>
              <header className={css.paneHead}>
                <span className={css.paneModel}>{providerId === undefined ? label : nameOf(providerId)}</span>
                <span className={css.paneMeta}>
                  {column?.elapsedMs === undefined ? '' : `${(column.elapsedMs / 1000).toFixed(1)}s`}
                </span>
              </header>
              <div className={css.paneBody}>
                {providerId === undefined || column === undefined
                  ? <p className={css.hint}>{busy ? t('compare.thinking') : t('compare.empty')}</p>
                  : column.status === 'failed'
                    ? <p className={css.failure}>{column.lastError ?? ''}</p>
                    : (
                      <>
                        {column.reasoning !== undefined && column.reasoning !== '' && (
                          // The site's search / thinking trace is context for the
                          // answer, not the answer: collapsed by default so the
                          // reply keeps the column.
                          <details className={css.reasoning}>
                            <summary className={css.reasoningLabel}>{t('compare.reasoning')}</summary>
                            <div className={css.reasoningBody}>
                              <MessageBody text={column.reasoning} labels={labels} provider={providerId} />
                            </div>
                          </details>
                        )}
                        {/* While the site is still writing, the column shows the
                            text it has produced so far; an empty column is the
                            pending hint, so each side updates on its own. */}
                        {column.content === '' && column.status === 'waiting'
                          ? <p className={css.hint}>{t('compare.thinking')}</p>
                          : <MessageBody text={column.content} labels={labels} provider={providerId} />}
                      </>
                    )}
              </div>
            </article>
          )
        })}
      </div>
      <div className={css.composer}>
        {files.length > 0 && (
          <div className={css.files}>
            {files.map((file, index) => (
              <span key={`${file.name}-${index}`} className={css.fileChip}>
                {file.preview !== '' && <img className={css.fileThumb} src={file.preview} alt={file.name} />}
                <span className={css.fileName}>{file.name}</span>
                <span className={css.fileSize}>{sizeLabel(file.size)}</span>
                <button type="button" className={css.fileRemove}
                  aria-label={`${t('compare.remove')} ${file.name}`}
                  onClick={() => { setFiles(current => current.filter((_, at) => at !== index)) }}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea className={css.input} rows={2} value={prompt} disabled={busy}
          placeholder={t('compare.placeholder')}
          onChange={(event) => { setPrompt(event.target.value) }}
          onPaste={onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }} />
        <div className={css.bar}>
          <input ref={picker} type="file" multiple className={css.picker} onChange={onPick} />
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => { picker.current?.click() }}>
            {t('compare.attach')}
          </Button>
          {!canCompare && <span className={css.note}>{t('compare.needTwo')}</span>}
          {busy && (
            <Button variant="ghost" size="md" onClick={stop}>
              {t('compare.stop')}
            </Button>
          )}
          <Button variant="primary" size="md" className={css.send}
            disabled={busy || prompt.trim() === ''} onClick={submit}>
            {t('compare.send')}
          </Button>
        </div>
      </div>
    </section>
  )
}
