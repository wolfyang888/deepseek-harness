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
  'video', 'audio', 'source', 'track',
]

/** The detector over those tags, matched case-insensitively. */
const HTML_MARKUP = new RegExp(`<(?:${BLOCK_TAGS.join('|')})\\b`, 'iu')

/**
 * Elements dropped before rendering: styling and scripting reach past the
 * bubble, forms or frames have no meaning inside a conversation.
 * Media tags (video, audio, source, track) are ALLOWED but their sources
 * are rewritten to absolute URLs where possible, and a fallback link is
 * added for blob: or unplayable sources.
 */
const FORBIDDEN_TAGS = [
  'style', 'script', 'link', 'meta', 'base', 'iframe', 'frame', 'frameset',
  'object', 'embed', 'form', 'input', 'button', 'select', 'option', 'textarea',
  'noscript', 'template', 'dialog', 'svg',
]

/** Video file extensions for detecting video URLs in markdown/text. */
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'm3u8']

/** Check if a URL looks like a video file. */
function isVideoUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const ext = u.pathname.split('.').pop()?.toLowerCase()
    return ext !== undefined && VIDEO_EXTENSIONS.includes(ext)
  } catch {
    // Relative URL - check extension
    const ext = url.split('.').pop()?.toLowerCase()
    return ext !== undefined && VIDEO_EXTENSIONS.includes(ext)
  }
}

/** Check if a URL looks like an image file. */
function isImageUrl(url: string): boolean {
  try {
    const u = new URL(url)
    const ext = u.pathname.split('.').pop()?.toLowerCase()
    return ext !== undefined && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)
  } catch {
    const ext = url.split('.').pop()?.toLowerCase()
    return ext !== undefined && ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'avif'].includes(ext)
  }
}

/** Convert markdown-style media links to HTML elements. */
function convertMarkdownMedia(text: string, baseUrl?: string): string {
  const base = baseUrl ?? ''
  let result = text
  // Convert ![alt](url) with video extension to <video>
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = imageRegex.exec(text)) !== null) {
    const [fullMatch, alt, url] = match
    const absoluteUrl = base !== '' && (url.startsWith('/') || url.startsWith('./'))
      ? new URL(url, base).href
      : url
    let replacement = fullMatch
    if (isVideoUrl(url)) {
      replacement = `<video src="${absoluteUrl}" controls preload="metadata" poster="${absoluteUrl}">${alt || 'Video'}</video>`
    } else if (isImageUrl(url)) {
      replacement = `<img src="${absoluteUrl}" alt="${alt}" loading="lazy">`
    }
    if (replacement !== fullMatch) {
      result = result.replace(fullMatch, replacement)
    }
  }
  // Convert [text](url) with video extension to video with fallback link
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  while ((match = linkRegex.exec(text)) !== null) {
    const [fullMatch, linkText, url] = match
    const absoluteUrl = base !== '' && (url.startsWith('/') || url.startsWith('./'))
      ? new URL(url, base).href
      : url
    let replacement = fullMatch
    if (isVideoUrl(url)) {
      replacement = `<video src="${absoluteUrl}" controls preload="metadata"><a href="${absoluteUrl}" target="_blank" rel="noopener">${linkText}</a></video>`
    }
    if (replacement !== fullMatch) {
      result = result.replace(fullMatch, replacement)
    }
  }
  return result
}

/** Site base URLs for rewriting relative media sources. */
const SITE_BASE_URLS: Record<string, string> = {
  'doubao-web': 'https://www.doubao.com',
  'deepseek-web': 'https://chat.deepseek.com',
  'chatgpt-web': 'https://chatgpt.com',
  'gemini-web': 'https://gemini.google.com',
  'qianwen-web': 'https://www.qianwen.com',
  'glm-web': 'https://chatglm.cn',
}

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
 * @param provider - provider id (e.g., 'doubao-web') for rewriting relative media URLs.
 * @returns markup with scripts, styling, page-level elements removed; media sources
 * rewritten to absolute URLs; fallback links added for blob: sources; empty layout
 * spacers removed.
 */
export function sanitizeAnswer(html: string, provider?: string): string {
  const baseUrl = provider ? SITE_BASE_URLS[provider] : undefined
  // First convert markdown media links to HTML
  const htmlWithMedia = convertMarkdownMedia(html, baseUrl)
  const clean = new DOMParser().parseFromString(
    DOMPurify.sanitize(htmlWithMedia, { FORBID_TAGS: FORBIDDEN_TAGS, FORBID_ATTR: ['style', 'class', 'id'] }),
    'text/html',
  )

  // Rewrite media sources to absolute URLs and add fallback links for blob: sources
  for (const media of clean.body.querySelectorAll('video, audio')) {
    // Handle poster attribute
    if (media.hasAttribute('poster') && baseUrl) {
      const poster = media.getAttribute('poster')
      if (poster !== null && (poster.startsWith('/') || poster.startsWith('./'))) {
        media.setAttribute('poster', new URL(poster, baseUrl).href)
      }
    }
    // Handle src attribute on media element
    if (media.hasAttribute('src')) {
      const src = media.getAttribute('src')
      if (src !== null && src.startsWith('blob:')) {
        // Blob URL - add fallback link after the media element
        const fallback = document.createElement('a')
        fallback.href = baseUrl ?? '#'
        fallback.target = '_blank'
        fallback.rel = 'noopener,noreferrer'
        fallback.textContent = `[Open video on ${provider?.replace('-web', '') ?? 'source site'}]`
        fallback.style.cssText = 'display:block;margin-top:4px;font-size:0.85em;color:var(--color-link);'
        media.insertAdjacentElement('afterend', fallback)
      } else if (src !== null && (src.startsWith('/') || src.startsWith('./')) && baseUrl) {
        media.setAttribute('src', new URL(src, baseUrl).href)
      }
    }
    // Handle <source> children
    for (const source of media.querySelectorAll('source')) {
      if (source.hasAttribute('src')) {
        const src = source.getAttribute('src')
        if (src !== null && (src.startsWith('/') || src.startsWith('./')) && baseUrl) {
          source.setAttribute('src', new URL(src, baseUrl).href)
        }
      }
    }
    // Add controls if not present
    if (!media.hasAttribute('controls')) {
      media.setAttribute('controls', '')
    }
    // Add preload metadata
    if (!media.hasAttribute('preload')) {
      media.setAttribute('preload', 'metadata')
    }
  }

  for (const element of clean.body.querySelectorAll('p, div, section, span, figure')) {
    const keeps = element.querySelector('img, table, a[href], ul, ol, pre, blockquote, video, audio') !== null
    if (!keeps && element.textContent.trim().length === 0) element.remove()
  }
  return clean.body.innerHTML
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
 * Check if text contains video URLs in markdown or plain form.
 */
function hasVideoContent(text: string): boolean {
  // Check markdown image/link with video extension
  if (/!\[[^\]]*\]\([^)]+\.(?:mp4|webm|ogg|mov|avi|mkv|flv|m3u8)\)/i.test(text)) return true
  if (/\[[^\]]+\]\([^)]+\.(?:mp4|webm|ogg|mov|avi|mkv|flv|m3u8)\)/i.test(text)) return true
  // Check bare video URLs
  if (/(?:^|\s)(https?:\/\/[^\s]+\.(?:mp4|webm|ogg|mov|avi|mkv|flv|m3u8)(?:\?[^\s]*)?)/i.test(text)) return true
  return false
}

/**
 * Render one assistant answer with the reader's vocabulary.
 * @param props - the stored text, the provider id for media URL rewriting, and the Markdown chrome.
 * @returns The rendered answer: sanitized HTML markup, or Markdown by default.
 */
export function MessageBody({
  text,
  labels,
  provider,
}: { text: string; labels: MarkdownLabels; provider?: string | undefined }): ReactNode {
  const html = useMemo(() => {
    if (looksLikeHtml(text)) {
      return sanitizeAnswer(text, provider)
    }
    // For markdown/text, check if it contains video URLs that need HTML rendering
    if (hasVideoContent(text)) {
      return sanitizeAnswer(text, provider)
    }
    return undefined
  }, [text, provider])
  if (html === undefined) return <MarkdownText text={text} labels={labels} variant="compact" />
  // The HTML is the sanitized document tree above: DOMPurify parses the answer
  // and drops every element and attribute the panel refuses to render.
  return <div className={css.html} onClick={openLink} dangerouslySetInnerHTML={{ __html: html }} />
}
