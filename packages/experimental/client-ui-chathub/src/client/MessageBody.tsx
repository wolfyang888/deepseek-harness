/**
 * Assistant answer body: Markdown unless the answer is HTML markup, which goes
 * through a sanitizing HTML parse — providers whose sites render rich answers
 * (tables, lists, emphasis) hand back markup, and printing it literally is what
 * makes those bubbles unreadable. The sanitized tree renders inline with the
 * panel's own typography, never the site's, so no external stylesheet or
 * script can reach the application shell.
 */

import { useMemo, type MouseEvent, type ReactNode } from 'react'
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import DOMPurify from 'dompurify'
import css from './MessageBody.module.css'

/**
 * Block-level elements that mark an answer as markup rather than Markdown. Only
 * block-level tags count: inline `<b>` or `<span>` in prose stays Markdown text,
 * while a table, list, or paragraph means the provider answered in HTML.
 */
const BLOCK_TAGS = [
  'html', 'body', 'div', 'p', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h[1-6]', 'blockquote', 'pre',
  'section', 'article', 'aside', 'figure', 'figcaption', 'details', 'summary', 'hr', 'br',
]

/** The detector over those tags, matched case-insensitively. */
const HTML_MARKUP = new RegExp(`<(?:${BLOCK_TAGS.join('|')})\\b`, 'iu')

/**
 * Elements dropped before rendering: styling and scripting reach past the
 * bubble, and forms or frames have no meaning inside a conversation.
 */
const FORBIDDEN_TAGS = [
  'style', 'script', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'form', 'input', 'button', 'select', 'option', 'textarea',
  'noscript', 'template', 'dialog',
]

/**
 * Whether an answer is HTML markup.
 * @param text - the stored assistant message.
 * @returns true when the text opens a block-level HTML element.
 */
export function looksLikeHtml(text: string): boolean {
  return HTML_MARKUP.test(text)
}

/**
 * Sanitize one HTML answer for inline rendering.
 * @param html - untrusted provider answer.
 * @returns markup with scripts, styling, page-level elements, and inline
 * style/class/id attributes removed, so the panel's typography is the only one
 * that applies and no answer can reposition the shell around its bubble.
 */
export function sanitizeAnswer(html: string): string {
  return DOMPurify.sanitize(html, { FORBID_TAGS: FORBIDDEN_TAGS, FORBID_ATTR: ['style', 'class', 'id'] })
}

/**
 * Follow one link from a sanitized answer in a new tab, so the answer never
 * navigates the application shell away from the conversation.
 * @param event - the click on the rendered answer.
 */
function openLink(event: MouseEvent<HTMLDivElement>): void {
  const anchor = (event.target as HTMLElement).closest('a[href]')
  // A click on ordinary answer text is not a link activation.
  if (!(anchor instanceof HTMLAnchorElement)) return
  event.preventDefault()
  // The selector above matches only anchors that carry the attribute.
  const href = anchor.getAttribute('href') as string
  // Fragment-only and relative destinations address the site the answer came
  // from, which the panel cannot resolve.
  if (!/^https?:/iu.test(href)) return
  window.open(href, '_blank', 'noopener,noreferrer')
}

/**
 * Render one assistant answer with the reader's vocabulary.
 * @param props - the stored text and the Markdown chrome for code fences and footnotes.
 * @returns The rendered answer: sanitized HTML markup, or Markdown by default.
 */
export function MessageBody({ text, labels }: { text: string; labels: MarkdownLabels }): ReactNode {
  const html = useMemo(() => (looksLikeHtml(text) ? sanitizeAnswer(text) : undefined), [text])
  if (html === undefined) return <MarkdownText text={text} labels={labels} variant="compact" />
  // The HTML is the sanitized document tree above: DOMPurify parses the answer
  // and drops every element and attribute the panel refuses to render.
  return <div className={css.html} onClick={openLink} dangerouslySetInnerHTML={{ __html: html }} />
}
