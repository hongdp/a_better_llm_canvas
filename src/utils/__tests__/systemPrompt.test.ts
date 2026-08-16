import { describe, it, expect } from 'vitest'
import { buildChatSystemPrompt, FORMAT_PROTOCOL_REMINDER } from '../systemPrompt'

describe('buildChatSystemPrompt', () => {
  it('always states the Canvas Markup Protocol rules', () => {
    const prompt = buildChatSystemPrompt({ includeChapterLookup: false })
    expect(prompt).toContain('<canvas>...</canvas>')
    expect(prompt).toContain('<<<<<<< SEARCH')
    expect(prompt).toContain('{{IMAGE_PLACEHOLDER_0}}')
  })

  it('includes the chapter-lookup protocol only when asked', () => {
    expect(buildChatSystemPrompt({ includeChapterLookup: false })).not.toContain('CHAPTER LOOKUP:')
    expect(buildChatSystemPrompt({ includeChapterLookup: true })).toContain('CHAPTER LOOKUP:')
  })

  it('includes the custom instructions when a preset has content', () => {
    const prompt = buildChatSystemPrompt({
      customInstructions: 'Write in a hard-boiled noir voice.',
      includeChapterLookup: false
    })
    expect(prompt).toContain("USER'S CUSTOM WRITING INSTRUCTIONS")
    expect(prompt).toContain('Write in a hard-boiled noir voice.')
  })

  it('omits the custom-instructions section for an empty or blank preset', () => {
    for (const customInstructions of [undefined, '', '   \n  ']) {
      const prompt = buildChatSystemPrompt({ customInstructions, includeChapterLookup: false })
      expect(prompt).not.toContain("USER'S CUSTOM WRITING INSTRUCTIONS")
    }
  })

  // The regression this file exists for: a preset saying "output the prose
  // directly / avoid non-Chinese text" used to be the LAST thing the model
  // read, so it dropped the tags and nothing reached the document.
  it('puts the format-protocol reminder after the custom instructions, always last', () => {
    const prompt = buildChatSystemPrompt({
      customInstructions: '直接输出小说正文，不添加任何解释。你避免非中文文本。',
      includeChapterLookup: true
    })
    expect(prompt.endsWith(FORMAT_PROTOCOL_REMINDER)).toBe(true)
    expect(prompt.indexOf(FORMAT_PROTOCOL_REMINDER)).toBeGreaterThan(prompt.indexOf('直接输出小说正文'))
    expect(prompt.indexOf(FORMAT_PROTOCOL_REMINDER)).toBeGreaterThan(prompt.indexOf('CHAPTER LOOKUP:'))
  })

  it('keeps the reminder last even with no preset selected', () => {
    expect(buildChatSystemPrompt({ includeChapterLookup: false }).endsWith(FORMAT_PROTOCOL_REMINDER)).toBe(true)
  })

  it('scopes presets to style and reasserts that document text needs tags', () => {
    expect(FORMAT_PROTOCOL_REMINDER).toContain('STYLE, VOICE, LANGUAGE, and CONTENT only')
    expect(FORMAT_PROTOCOL_REMINDER).toContain('<canvas>, <edit>, or <selection_replace>')
  })

  // The system prompt is the wire protocol; writing guidance belongs to the
  // user's preset and their message. Persona or style rules here compete with
  // the user's own instructions, and the user always loses (theirs sit in the
  // middle of the prompt, ours sit at both ends).
  it('carries no persona, task, or style guidance', () => {
    const prompt = buildChatSystemPrompt({ includeChapterLookup: true })
    for (const forbidden of [
      /elite/i,
      /creative writing assistant/i,
      /you help authors/i,
      /beautifully/i,
      /helpful assistant/i
    ]) expect(prompt, String(forbidden)).not.toMatch(forbidden)
  })

  it('states the protocol-only boundary up front', () => {
    const prompt = buildChatSystemPrompt({ includeChapterLookup: false })
    expect(prompt).toContain('defines ONLY how to exchange data with it')
  })

  it('requires a status declaration on every reply', () => {
    const prompt = buildChatSystemPrompt({ includeChapterLookup: false })
    expect(prompt).toContain('<doc_status>updated</doc_status>')
    expect(prompt).toContain('<doc_status>unchanged</doc_status>')
    // The decision is the model's; the app only checks the declaration.
    expect(prompt).toContain('the choice of whether to edit is yours')
  })

  it('is deterministic — the prefix is stable for provider prompt caching', () => {
    const a = buildChatSystemPrompt({ customInstructions: 'Voice: terse.', includeChapterLookup: true })
    const b = buildChatSystemPrompt({ customInstructions: 'Voice: terse.', includeChapterLookup: true })
    expect(a).toBe(b)
  })
})
