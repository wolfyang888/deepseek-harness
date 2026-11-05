// @vitest-environment jsdom
/** The assistant answer body: Markdown by default, sanitized HTML when the answer is markup. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { looksLikeHtml, MessageBody, sanitizeAnswer } from '../src/client/MessageBody.tsx'

afterEach(cleanup)

const LABELS = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }

it('recognizes markup and leaves Markdown alone', () => {
  expect(looksLikeHtml('<table><tr><td>x</td></tr></table>')).toBe(true)
  expect(looksLikeHtml('<p>done</p>')).toBe(true)
  expect(looksLikeHtml('line one<br>line two')).toBe(true)
  expect(looksLikeHtml('**bold** and `code`')).toBe(false)
  expect(looksLikeHtml('use the <T> type parameter')).toBe(false)
})

it('drops scripting, styling, and page-level elements with their content', () => {
  const clean = sanitizeAnswer(
    '<div style="position:fixed" class="overlay" id="app">keep'
    + '<script>alert(1)</script><style>body{display:none}</style>'
    + '<iframe src="https://example.com"></iframe></div>',
  )
  expect(clean).toContain('keep')
  expect(clean).not.toContain('script')
  expect(clean).not.toContain('alert')
  expect(clean).not.toContain('display:none')
  expect(clean).not.toContain('iframe')
  expect(clean).not.toContain('position:fixed')
  expect(clean).not.toContain('class=')
  expect(clean).not.toContain('id=')
})

it('drops media the panel cannot play and layout blocks that hold nothing', () => {
  const clean = sanitizeAnswer(
    '<div></div><p>   </p><video src="blob:https://x/1"></video><audio src="/a.mp3"></audio>'
    + '<p><br></p><p>正文</p>',
  )
  expect(clean).toContain('正文')
  expect(clean).not.toContain('video')
  expect(clean).not.toContain('audio')
  expect(clean).not.toContain('<div')
  expect(clean).not.toContain('<br')
})

it('renders Markdown answers through the Markdown renderer', () => {
  render(<MessageBody text={'**bold**'} labels={LABELS} />)
  expect(screen.getByText('bold').tagName).toBe('STRONG')
})

it('renders HTML answers as layout', () => {
  render(<MessageBody text={'<table><tr><th>模型</th></tr><tr><td>豆包</td></tr></table>'} labels={LABELS} />)
  expect(screen.getByText('豆包').tagName).toBe('TD')
  expect(document.body.textContent).not.toContain('<table>')
})

it('opens answer links in a new tab and leaves other clicks alone', () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null)
  try {
    render(<MessageBody text={'<p>see <a href="https://example.com/doc">docs</a> and <a href="#note">note</a></p>'} labels={LABELS} />)
    // Plain answer text is not an activation.
    fireEvent.click(screen.getByText(/see/))
    expect(open).not.toHaveBeenCalled()
    // A fragment addresses the site the answer came from, which the panel cannot resolve.
    fireEvent.click(screen.getByText('note'))
    expect(open).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('docs'))
    expect(open).toHaveBeenCalledWith('https://example.com/doc', '_blank', 'noopener,noreferrer')
  } finally {
    open.mockRestore()
  }
})
