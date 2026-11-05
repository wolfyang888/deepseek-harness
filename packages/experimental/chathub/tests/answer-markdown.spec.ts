/** Site answers as the panel's Markdown pipeline should receive them. */

import { describe, expect, it } from 'vitest'
import { answerMarkdownOf } from '../src/providers/answer-markdown.ts'

describe('answerMarkdownOf', () => {
  it('converts the paragraphs of a markup answer to Markdown blocks', () => {
    expect(answerMarkdownOf('<div><p>第一段</p><p>第二段</p></div>')).toBe('第一段\n\n第二段')
  })

  it('keeps a plain-text answer byte for byte', () => {
    // turndown would escape Markdown-significant characters in text the site
    // never rendered; a non-markup string is already what the reader should see.
    expect(answerMarkdownOf('2')).toBe('2')
    expect(answerMarkdownOf('a * b _ c')).toBe('a * b _ c')
  })

  it('keeps structure a table needs', () => {
    const markdown = answerMarkdownOf(
      '<table><thead><tr><th>名</th><th>值</th></tr></thead><tbody><tr><td>a</td><td>1</td></tr></tbody></table>',
    )
    expect(markdown).toContain('| 名')
    expect(markdown).toContain('| ---')
    expect(markdown).toContain('| a')
  })

  it('turns a fenced code block into a fenced code block', () => {
    const markdown = answerMarkdownOf('<pre><code>local x = 1</code></pre>')
    expect(markdown).toContain('```')
    expect(markdown).toContain('local x = 1')
  })

  it('replaces site media with a link the reader can open', () => {
    const markdown = answerMarkdownOf(
      '<div><video src="https://s.chatglm.cn/v/abc.mp4"></video><p>说明</p></div>',
    )
    expect(markdown).toContain('[video](https://s.chatglm.cn/v/abc.mp4)')
    expect(markdown).toContain('说明')
    expect(markdown).not.toContain('<video')
  })

  it('drops media the panel could never play', () => {
    // `blob:` dies with the page; a relative source resolves against the panel.
    const markdown = answerMarkdownOf(
      '<div><video><source src="blob:https://x/1"></video><audio src="/a.mp3"></audio><p>正文</p></div>',
    )
    expect(markdown).toBe('正文')
  })

  it('keeps only images an absolute URL can load', () => {
    expect(answerMarkdownOf('<p><img src="https://s.x/a.png" alt="图"></p>')).toContain('![图](https://s.x/a.png)')
    expect(answerMarkdownOf('<p><img src="/a.png"></p>')).toBe('')
    expect(answerMarkdownOf('<p><img src="blob:https://x/1"></p>')).toBe('')
  })

  it('collapses the layout noise between blocks into single breaks', () => {
    const answer = '<div></div><p></p><p>   </p><br><br><br><p>标题</p><div>  </div><p>正文</p>'
    const markdown = answerMarkdownOf(answer)
    expect(markdown).toBe('标题\n\n正文')
  })

  it('keeps emphasis and links the site rendered', () => {
    const markdown = answerMarkdownOf('<p>见 <a href="https://x.dev/doc">文档</a> 与 <strong>重点</strong></p>')
    expect(markdown).toBe('见 [文档](https://x.dev/doc) 与 **重点**')
  })
})
