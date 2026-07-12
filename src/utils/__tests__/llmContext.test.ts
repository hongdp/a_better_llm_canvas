import { describe, it, expect } from 'vitest'
import {
  trimHistoryForContext,
  stripChatDisplayArtifacts,
  truncateWithNotice,
  htmlToPlainText,
  detectReferencedDocIds,
  buildAttachmentsLabel, resolveLookupTitles } from '../llmContext'
import type { LLMMessage } from '../../types/llm'

const msg = (role: 'user' | 'assistant', content: string, images?: string[]): LLMMessage =>
  images ? { role, content, images } : { role, content }

describe('trimHistoryForContext', () => {
  it('returns all messages when under budget, in original order', () => {
    const history = [msg('user', 'hello'), msg('assistant', 'hi'), msg('user', 'again')]
    const result = trimHistoryForContext(history, { maxChars: 1000 })
    expect(result).toEqual(history)
  })

  it('drops oldest messages first when over budget', () => {
    const history = [
      msg('user', 'a'.repeat(50)),
      msg('assistant', 'b'.repeat(50)),
      msg('user', 'c'.repeat(50)),
      msg('assistant', 'd'.repeat(50)),
      msg('user', 'e'.repeat(50)),
    ]
    const result = trimHistoryForContext(history, { maxChars: 170, minKeepMessages: 1 })
    // Budget of 170 fits the last three messages (150 chars); the fourth from
    // the end would exceed it. The window already starts with a user turn.
    expect(result.map(m => m.content[0])).toEqual(['c', 'd', 'e'])
  })

  it('always keeps minKeepMessages even when over budget', () => {
    const history = [
      msg('user', 'x'.repeat(500)),
      msg('assistant', 'y'.repeat(500)),
      msg('user', 'z'.repeat(500)),
    ]
    const result = trimHistoryForContext(history, { maxChars: 10, minKeepMessages: 2 })
    // Two most recent kept despite budget; leading assistant then dropped.
    expect(result.length).toBe(1)
    expect(result[0].role).toBe('user')
    expect(result[0].content[0]).toBe('z')
  })

  it('never starts the window with an assistant message', () => {
    const history = [
      msg('user', 'old question'),
      msg('assistant', 'long answer '.repeat(20)),
      msg('user', 'follow-up'),
      msg('assistant', 'reply'),
    ]
    const result = trimHistoryForContext(history, { maxChars: 260, minKeepMessages: 2 })
    expect(result[0].role).toBe('user')
  })

  it('strips images from messages outside the keepImagesInLast window', () => {
    const history = [
      msg('user', 'first', ['data:image/png;base64,AAA']),
      msg('assistant', 'ok'),
      msg('user', 'second', ['data:image/png;base64,BBB']),
      msg('assistant', 'done'),
    ]
    const result = trimHistoryForContext(history, { maxChars: 1000, keepImagesInLast: 2 })
    expect(result[0].images).toBeUndefined()
    expect(result[2].images).toEqual(['data:image/png;base64,BBB'])
  })

  it('does not mutate the input messages', () => {
    const history = [msg('user', 'first', ['img']), msg('assistant', 'ok'), msg('user', 'x'), msg('assistant', 'y')]
    trimHistoryForContext(history, { maxChars: 1000, keepImagesInLast: 1 })
    expect(history[0].images).toEqual(['img'])
  })

  it('handles empty history', () => {
    expect(trimHistoryForContext([], { maxChars: 100 })).toEqual([])
  })

  it('drops empty messages (no text, no images)', () => {
    const history = [
      msg('user', 'question'),
      msg('assistant', '   '),
      msg('user', 'follow-up'),
      msg('assistant', 'answer'),
    ]
    const result = trimHistoryForContext(history, { maxChars: 1000 })
    expect(result.map(m => m.content)).toEqual(['question\n\nfollow-up', 'answer'])
  })

  it('keeps an image-only message even with empty text', () => {
    const history = [
      msg('user', 'q'),
      msg('assistant', 'a'),
      msg('user', '', ['data:image/png;base64,AAA']),
      msg('assistant', 'b'),
    ]
    const result = trimHistoryForContext(history, { maxChars: 1000 })
    expect(result.length).toBe(4)
    expect(result[2].images).toEqual(['data:image/png;base64,AAA'])
  })

  it('merges consecutive same-role turns created by dropped messages', () => {
    const history = [
      msg('user', 'first ask'),
      msg('assistant', ''), // e.g. a stripped stream-error message
      msg('user', 'second ask'),
      msg('assistant', 'reply'),
    ]
    const result = trimHistoryForContext(history, { maxChars: 1000 })
    expect(result.length).toBe(2)
    expect(result[0]).toEqual({ role: 'user', content: 'first ask\n\nsecond ask' })
    expect(result[1].content).toBe('reply')
  })
})

describe('stripChatDisplayArtifacts', () => {
  it('removes a single attached-context prefix line', () => {
    expect(stripChatDisplayArtifacts('[Attached Context: Chapter 1]\n\nHere is my answer.'))
      .toBe('Here is my answer.')
  })

  it('removes multiple attached-context lines', () => {
    const input = '[Attached Context: Chapter 1]\n[Attached Context: Chapter 2]\n\nDone.'
    expect(stripChatDisplayArtifacts(input)).toBe('Done.')
  })

  it('leaves normal content untouched', () => {
    expect(stripChatDisplayArtifacts('Hello [Attached Context: X] world')).toBe('Hello [Attached Context: X] world')
    expect(stripChatDisplayArtifacts('Plain reply')).toBe('Plain reply')
  })

  it('strips a trailing canvas-truncation warning appended by the UI', () => {
    const input = 'I rewrote the intro.\n\n⚠️ The response was cut off before the document update finished, so no changes were applied (your document is unchanged). Please retry — for long documents, try editing a smaller selection at a time.'
    expect(stripChatDisplayArtifacts(input)).toBe('I rewrote the intro.')
  })

  it('strips a trailing unmatched-edit warning appended by the UI', () => {
    const input = 'Done!\n\n⚠️ 2 suggested changes could not be located in the current document and were skipped. The text to change may have moved or differ from what was matched.'
    expect(stripChatDisplayArtifacts(input)).toBe('Done!')
    const single = 'Done!\n\n⚠️ 1 suggested change could not be located in the current document and was skipped.'
    expect(stripChatDisplayArtifacts(single)).toBe('Done!')
  })

  it('reduces a pure stream-error message to empty', () => {
    expect(stripChatDisplayArtifacts('⚠️ Error during stream: Anthropic API error (500): overloaded')).toBe('')
    expect(stripChatDisplayArtifacts('⚠️ Error: network down')).toBe('')
    expect(stripChatDisplayArtifacts('[Attached Context: Ch 1]\n\n⚠️ Error during stream: boom')).toBe('')
  })

  it('strips attached-context prefix and trailing warning together', () => {
    const input = '[Attached Context: Chapter 2]\n\nUpdated the scene.\n\n⚠️ The response abbreviated unchanged parts of the document, so applying it would have deleted content. No changes were applied.'
    expect(stripChatDisplayArtifacts(input)).toBe('Updated the scene.')
  })
})

describe('htmlToPlainText', () => {
  it('keeps block boundaries as newlines instead of fusing text', () => {
    expect(htmlToPlainText('<h2>World</h2><p>Text</p>')).toBe('World\nText')
  })

  it('renders list items with bullets and line breaks', () => {
    expect(htmlToPlainText('<ul><li>One</li><li>Two</li></ul>')).toBe('- One\n- Two')
  })

  it('decodes common HTML entities without double-decoding', () => {
    expect(htmlToPlainText('<p>Tom &amp; Jerry&nbsp;say &quot;hi&quot;</p>')).toBe('Tom & Jerry say "hi"')
    expect(htmlToPlainText('<p>&amp;lt;</p>')).toBe('&lt;')
  })

  it('collapses excessive blank lines and strips inline tags', () => {
    expect(htmlToPlainText('<p>A <strong>bold</strong> move</p><p></p><p></p><p>B</p>')).toBe('A bold move\n\nB')
  })
})

describe('detectReferencedDocIds', () => {
  const docs = [
    { id: 'active', title: 'Current Draft' },
    { id: 'ch1', title: 'Chapter 1: The Beginning' },
    { id: 'notes', title: 'Worldbuilding Notes' },
    { id: 'tiny', title: 'a' },
  ]

  it('matches by full title, case-insensitively', () => {
    expect(detectReferencedDocIds('Use worldbuilding notes for this', docs, 'active')).toEqual(['notes'])
  })

  it('matches chapter docs by their cleaned title', () => {
    expect(detectReferencedDocIds('Make this consistent with the beginning', docs, 'active')).toEqual(['ch1'])
  })

  it('never matches the active document', () => {
    expect(detectReferencedDocIds('polish the current draft', docs, 'active')).toEqual([])
  })

  it('ignores single-character titles that would match everything', () => {
    expect(detectReferencedDocIds('add a paragraph', docs, 'active')).toEqual([])
  })
})

describe('buildAttachmentsLabel', () => {
  it('builds one label line per known doc and skips unknown ids', () => {
    const docs = [
      { id: 'ch1', title: 'Chapter 1' },
      { id: 'ch2', title: 'Chapter 2' },
    ]
    expect(buildAttachmentsLabel(['ch1', 'missing', 'ch2'], docs))
      .toBe('[Attached Context: Chapter 1]\n[Attached Context: Chapter 2]')
    expect(buildAttachmentsLabel([], docs)).toBe('')
  })
})

describe('truncateWithNotice', () => {
  it('returns short text unchanged', () => {
    expect(truncateWithNotice('short', 100)).toBe('short')
  })

  it('truncates long text and appends an explicit notice', () => {
    const result = truncateWithNotice('a'.repeat(200), 50)
    expect(result.startsWith('a'.repeat(50))).toBe(true)
    expect(result).toContain('[truncated: showing first 50 of 200 characters]')
  })
})

// ── resolveLookupTitles ───────────────────────────────────────────────────────
describe('resolveLookupTitles', () => {
  const docs = [
    { id: 'a', title: 'Chapter 1: Origins' },
    { id: 'b', title: 'Chapter 2: The Crossing' },
    { id: 'c', title: 'Chapter 3: Ashfall' }
  ]

  it('resolves exact titles case-insensitively', () => {
    expect(resolveLookupTitles(['chapter 3: ashfall'], docs, 'a')).toEqual(['c'])
  })

  it('resolves partial titles by containment', () => {
    expect(resolveLookupTitles(['Ashfall'], docs, 'a')).toEqual(['c'])
    expect(resolveLookupTitles(['Chapter 2: The Crossing (see index)'], docs, 'a')).toEqual(['b'])
  })

  it('excludes the active document and unknown titles, deduplicates', () => {
    expect(resolveLookupTitles(['Chapter 1: Origins', 'Nonexistent', 'Origins', 'Chapter 1: Origins'], docs, 'a')).toEqual([])
    expect(resolveLookupTitles(['Chapter 1: Origins', 'Origins'], docs, 'c')).toEqual(['a'])
  })

  it('preserves request order', () => {
    expect(resolveLookupTitles(['Ashfall', 'Origins'], docs, 'b')).toEqual(['c', 'a'])
  })
})
