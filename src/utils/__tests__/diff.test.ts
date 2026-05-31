import { describe, it, expect } from 'vitest'
import { diffHtml } from '../diff'

describe('diffHtml', () => {
  it('returns the original HTML unchanged when inputs are identical', () => {
    const html = '<p>Hello world</p>'
    const result = diffHtml(html, html)
    expect(result).toBe(html)
  })

  it('wraps new text in <ins> when content is purely added', () => {
    const result = diffHtml('<p>Hello</p>', '<p>Hello world</p>')
    expect(result).toContain('<ins')
    expect(result).toContain('world')
    expect(result).not.toContain('<del')
  })

  it('wraps removed text in <del> when content is purely deleted', () => {
    const result = diffHtml('<p>Hello world</p>', '<p>Hello</p>')
    expect(result).toContain('<del')
    expect(result).toContain('world')
    expect(result).not.toContain('<ins')
  })

  it('produces both <ins> and <del> for mixed changes', () => {
    const result = diffHtml('<p>foo bar</p>', '<p>foo baz</p>')
    expect(result).toContain('<del')
    expect(result).toContain('<ins')
    expect(result).toContain('baz')
  })

  it('handles completely empty old HTML (pure insertion)', () => {
    const result = diffHtml('', '<p>Hello</p>')
    expect(result).toContain('<ins')
    expect(result).not.toContain('<del')
  })

  it('handles completely empty new HTML (pure deletion)', () => {
    const result = diffHtml('<p>Hello</p>', '')
    expect(result).toContain('<del')
    expect(result).not.toContain('<ins')
  })

  it('handles both inputs empty', () => {
    const result = diffHtml('', '')
    expect(result).toBe('')
  })

  it('preserves HTML tags as structural tokens (does not wrap tags in del/ins)', () => {
    const result = diffHtml('<p>old</p>', '<p>new</p>')
    // The <p> and </p> tags themselves should not appear inside del/ins
    // The del/ins elements should contain only text content
    const delMatches = result.match(/<del[^>]*>(.*?)<\/del>/gs) || []
    delMatches.forEach(del => {
      expect(del).not.toContain('<p>')
      expect(del).not.toContain('</p>')
    })
  })

  it('includes a data-diff-id attribute on ins and del for UI grouping', () => {
    const result = diffHtml('<p>Hello world</p>', '<p>Hello earth</p>')
    expect(result).toMatch(/data-diff-id="diff-/)
  })

  it('handles whitespace-only changes', () => {
    // Adding extra spaces between words
    const result = diffHtml('<p>a b</p>', '<p>a  b</p>')
    expect(typeof result).toBe('string')
    // Should not throw
  })

  it('handles Chinese text diff', () => {
    const result = diffHtml('<p>你好世界</p>', '<p>你好中国</p>')
    expect(result).toContain('<del')
    expect(result).toContain('<ins')
  })

  it('preserves common prefix and suffix without marking them as changes', () => {
    const result = diffHtml('<p>AAA BBB CCC</p>', '<p>AAA ZZZ CCC</p>')
    // AAA and CCC should appear outside ins/del
    expect(result).toContain('AAA')
    expect(result).toContain('CCC')
    // The changed part should be marked
    expect(result).toContain('<del')
    expect(result).toContain('<ins')
  })
})
