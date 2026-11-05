/**
 * A site answer as the panel should show it.
 *
 * Sites return answers as rendered DOM, and the panel stored that markup
 * verbatim: layout nodes the site needs (empty paragraphs, spacer `<div>`s,
 * `<br>` runs) became blank stretches, and a `<video>` element carried a
 * `blob:` or site-relative source that can never play inside the panel. The
 * DeepSeek chat box renders model output as Markdown through one pipeline, so
 * the web provider now hands that pipeline Markdown too: turndown with GFM
 * tables, media replaced by a link the reader can open, and blank runs
 * collapsed.
 */

import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

/**
 * Block-level tags that mark a string as markup rather than text. Inline
 * formatting in prose stays text; a paragraph or list means the site answered
 * in HTML. Kept in sync with the panel's detector.
 */
const BLOCK_TAGS = [
  'html', 'body', 'div', 'p', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'caption', 'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'h[1-6]', 'blockquote', 'pre',
  'section', 'article', 'aside', 'figure', 'figcaption', 'details', 'summary', 'hr', 'br',
]

/** The detector over those tags, matched case-insensitively. */
const MARKUP = new RegExp(`<(?:${BLOCK_TAGS.join('|')})\\b`, 'iu')

/** Media whose source cannot resolve inside the panel, with their link labels. */
const MEDIA_LABELS: Record<string, string> = {
  VIDEO: 'video',
  AUDIO: 'audio',
}

/** Whether a media source is one the reader's browser can open directly. */
function playable(src: string | null | undefined): src is string {
  return typeof src === 'string' && /^https?:\/\//iu.test(src)
}

/** Escape the parentheses that would end a Markdown destination early. */
function markdownDestination(src: string): string {
  return src.replace(/\(/gu, '%28').replace(/\)/gu, '%29')
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)

turndown.addRule('dropNonContent', {
  filter(node) {
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM'].includes(node.nodeName)) return true
    if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true
    const declarations = node.getAttribute('style')?.split(';') ?? []
    return declarations.some((declaration) => {
      const separator = declaration.indexOf(':')
      if (separator === -1) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      const value = declaration.slice(separator + 1).trim().toLowerCase()
      return (property === 'display' && value === 'none') || (property === 'visibility' && value === 'hidden')
    })
  },
  replacement() {
    return ''
  },
})

turndown.addRule('mediaAsLink', {
  filter: ['video', 'audio', 'source', 'track'],
  replacement(_content, node) {
    // A panel cannot play site media: `blob:` sources die with the page and
    // relative ones resolve against the panel's origin. An absolute link the
    // reader can open is the honest remainder.
    const src = node.getAttribute('src') ?? node.querySelector('source')?.getAttribute('src')
    if (!playable(src)) return ''
    const label = MEDIA_LABELS[node.nodeName] ?? 'media'
    return `[${label}](${markdownDestination(src)})`
  },
})

turndown.addRule('imageOnlyWhenLoadable', {
  filter: 'img',
  replacement(_content, node) {
    const src = node.getAttribute('src')
    if (!playable(src)) return ''
    const alt = node.getAttribute('alt') ?? ''
    return `![${alt}](${markdownDestination(src)})`
  },
})

/**
 * Shape one site answer for the panel's Markdown pipeline.
 * @param html - the site's answer as the browser session read it.
 * @returns Markdown for the DeepSeek chat renderer: text answers pass through
 * untouched, media that cannot play becomes a link or nothing, and the layout
 * noise between blocks collapses so no answer opens with a blank stretch.
 */
export function answerMarkdownOf(html: string): string {
  const text = html.trim()
  // A plain-text answer (a site that failed to render, a short reply) is not
  // markup: turndown would escape its Markdown characters into noise.
  if (!MARKUP.test(text)) return text
  return turndown.turndown(text).replace(/\n{3,}/gu, '\n\n').trim()
}
