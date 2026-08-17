import { describe, it, expect } from 'vitest'
import { findTextRange } from '../chat/streamHandlers'

// A reload destroys the selection range (it lived in a ref), so a selection
// rewrite that finished afterwards had nowhere to go and was dropped in
// silence. Text survives where positions cannot — the same principle <edit>
// blocks have always relied on.
describe('findTextRange', () => {
  it('locates a passage inside HTML', () => {
    const doc = '<p>前面的内容。</p><p>要改写的这一段。</p><p>后面的内容。</p>'
    const r = findTextRange(doc, '要改写的这一段。')
    expect(r).not.toBeNull()
    expect(r!.to - r!.from).toBe('要改写的这一段。'.length)
  })

  it('refuses when the passage appears more than once', () => {
    // Two candidates means a coin flip, and rewriting the wrong paragraph is
    // worse than reporting that the selection is gone.
    const doc = '<p>重复的句子。</p><p>别的内容。</p><p>重复的句子。</p>'
    expect(findTextRange(doc, '重复的句子。')).toBeNull()
  })

  it('refuses when the passage is gone', () => {
    expect(findTextRange('<p>完全不同的内容。</p>', '原来选中的文字')).toBeNull()
  })

  it('ignores markup that wraps the passage', () => {
    // The selection is plain text; the document has since gained emphasis.
    const doc = '<p>他<strong>拧开</strong>了接头。</p>'
    expect(findTextRange(doc, '拧开')).not.toBeNull()
  })

  it('handles empty input without throwing', () => {
    expect(findTextRange('', 'x')).toBeNull()
    expect(findTextRange('<p>x</p>', '')).toBeNull()
    expect(findTextRange('<p>x</p>', '   ')).toBeNull()
  })
})
