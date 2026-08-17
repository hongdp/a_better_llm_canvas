import { describe, it, expect } from 'vitest'
import { findTextRangeInSpans, collectTextSpans, type TextNodeSpan } from '../chat/streamHandlers'

// A reload destroys the selection range (it lived in a ref), so a selection
// rewrite that finishes afterwards has to find its passage again. The first
// version of this did string arithmetic on HTML and was wrong: a plain-text
// index is NOT a ProseMirror position — every block boundary adds one — so the
// error grew with each preceding paragraph and the rewrite landed off-target.
describe('findTextRangeInSpans', () => {
  // Positions as ProseMirror assigns them: <p>keep</p><p>选中的原文</p>
  const spans: TextNodeSpan[] = [
    { text: 'keep', from: 1 },
    { text: '选中的原文', from: 7 }
  ]

  it('returns real document positions, not string offsets', () => {
    const r = findTextRangeInSpans(spans, '选中的原文')
    // Off-by-block arithmetic would have said 6; the node tree says 7.
    expect(r).toEqual({ from: 7, to: 12 })
  })

  it('finds a passage that spans two text nodes', () => {
    // Marks split text: <p>拧开<strong>生锈</strong>的接头</p>
    const split: TextNodeSpan[] = [
      { text: '拧开', from: 1 },
      { text: '生锈', from: 3 },
      { text: '的接头', from: 5 }
    ]
    expect(findTextRangeInSpans(split, '生锈的接头')).toEqual({ from: 3, to: 8 })
  })

  it('refuses an ambiguous passage', () => {
    const twice: TextNodeSpan[] = [
      { text: '重复的句子', from: 1 },
      { text: '别的', from: 7 },
      { text: '重复的句子', from: 11 }
    ]
    expect(findTextRangeInSpans(twice, '重复的句子')).toBeNull()
  })

  it('refuses a passage that is gone', () => {
    expect(findTextRangeInSpans(spans, '早已删除的文字')).toBeNull()
  })

  it('handles empty input', () => {
    expect(findTextRangeInSpans([], 'x')).toBeNull()
    expect(findTextRangeInSpans(spans, '')).toBeNull()
    expect(findTextRangeInSpans(spans, '   ')).toBeNull()
  })
})

describe('collectTextSpans', () => {
  it('keeps only text nodes, with their positions', () => {
    const doc = {
      descendants(fn: (node: { isText?: boolean; text?: string }, pos: number) => void) {
        fn({ isText: false }, 0)
        fn({ isText: true, text: 'hello' }, 1)
        fn({ isText: false }, 6)
        fn({ isText: true, text: 'world' }, 8)
      }
    }
    expect(collectTextSpans(doc)).toEqual([
      { text: 'hello', from: 1 },
      { text: 'world', from: 8 }
    ])
  })
})
