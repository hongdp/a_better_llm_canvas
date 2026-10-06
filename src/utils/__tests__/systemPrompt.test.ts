import { describe, it, expect } from 'vitest'
import { buildChatSystemPrompt, FORMAT_PROTOCOL_REMINDER, MARKUP_FORMAT_PROTOCOL_REMINDER } from '../systemPrompt'

// Most of these assertions are about layering, which is protocol-independent;
// they run on the tool protocol and the markup-specific cases say so.
const build = (o: Omit<Parameters<typeof buildChatSystemPrompt>[0], 'protocol'> & { protocol?: 'tools' | 'markup' }) =>
  buildChatSystemPrompt({ protocol: 'tools', ...o })

describe('buildChatSystemPrompt', () => {
  it('states only what the tool schemas cannot say for themselves', () => {
    // The tools carry their own names, arguments and usage notes. Repeating
    // them here would give the model two sources to reconcile; what is left is
    // the channel rule and the document invariants a JSON schema has no place
    // to state.
    const prompt = build({})
    expect(prompt).toContain('{{IMAGE_PLACEHOLDER_0}}')
    expect(prompt).toContain('CURRENT ACTIVE DOCUMENT CONTENT')
    // The private tag language is gone.
    expect(prompt).not.toContain('<canvas>')
    expect(prompt).not.toContain('<<<<<<< SEARCH')
    expect(prompt).not.toContain('<doc_status>')
  })


  it('includes the custom instructions when a preset has content', () => {
    const prompt = build({
      customInstructions: 'Write in a hard-boiled noir voice.'
    })
    expect(prompt).toContain("USER'S CUSTOM WRITING INSTRUCTIONS")
    expect(prompt).toContain('Write in a hard-boiled noir voice.')
  })

  it('omits the custom-instructions section for an empty or blank preset', () => {
    for (const customInstructions of [undefined, '', '   \n  ']) {
      const prompt = build({ customInstructions })
      expect(prompt).not.toContain("USER'S CUSTOM WRITING INSTRUCTIONS")
    }
  })

  // The regression this file exists for: a preset saying "output the prose
  // directly / avoid non-Chinese text" used to be the LAST thing the model
  // read, so it dropped the tags and nothing reached the document.
  it('puts the format-protocol reminder after the custom instructions, always last', () => {
    const prompt = build({
      customInstructions: '直接输出小说正文，不添加任何解释。你避免非中文文本。'
    })
    expect(prompt.endsWith(FORMAT_PROTOCOL_REMINDER)).toBe(true)
    expect(prompt.indexOf(FORMAT_PROTOCOL_REMINDER)).toBeGreaterThan(prompt.indexOf('直接输出小说正文'))
    expect(prompt.indexOf(FORMAT_PROTOCOL_REMINDER)).toBeGreaterThan(prompt.indexOf('CHAPTER LOOKUP:'))
  })

  it('keeps the reminder last even with no preset selected', () => {
    expect(build({}).endsWith(FORMAT_PROTOCOL_REMINDER)).toBe(true)
  })

  it('scopes presets to style and reasserts that document text needs a tool call', () => {
    expect(FORMAT_PROTOCOL_REMINDER).toContain('STYLE, VOICE, LANGUAGE, and CONTENT only')
    expect(FORMAT_PROTOCOL_REMINDER).toContain('tool argument')
    expect(FORMAT_PROTOCOL_REMINDER).toContain('without calling a tool')
  })

  // The system prompt is the wire protocol; writing guidance belongs to the
  // user's preset and their message. Persona or style rules here compete with
  // the user's own instructions, and the user always loses (theirs sit in the
  // middle of the prompt, ours sit at both ends).
  it('carries no persona, task, or style guidance', () => {
    const prompt = build({})
    for (const forbidden of [
      /elite/i,
      /creative writing assistant/i,
      /you help authors/i,
      /beautifully/i,
      /helpful assistant/i
    ]) expect(prompt, String(forbidden)).not.toMatch(forbidden)
  })

  it('keeps writing guidance out of the prompt', () => {
    const prompt = build({})
    expect(prompt).toContain('the task, the subject, the voice, the language and the standards all come from the user')
  })

  it('needs no status declaration, because calling a tool IS one', () => {
    // The <doc_status> line existed to tell "changed" from "did not change"
    // in a stream of prose. A tool call carries that structurally, so the
    // line — and its three failure modes — retire with it.
    const prompt = build({})
    expect(prompt).not.toContain('doc_status')
    expect(prompt).toContain('The document is changed ONLY by calling a tool')
    expect(prompt).toContain('Deciding whether the document needs changing is yours')
  })

  // The whole point of the setting: one protocol per model, taught in full,
  // never both at once. A prompt describing tools to a request that sends none
  // silently disables document editing.
  describe('markup protocol', () => {
    it('teaches the tag language and the status line', () => {
      const prompt = build({ protocol: 'markup' })
      expect(prompt).toContain('<canvas>')
      expect(prompt).toContain('<<<<<<< SEARCH')
      expect(prompt).toContain('<doc_status>updated</doc_status>')
      expect(prompt).toContain('<selection_replace>')
    })

    it('says nothing about tools, which that request does not send', () => {
      const prompt = build({ protocol: 'markup' })
      expect(prompt).not.toContain('calling a tool')
      expect(prompt).not.toContain('tool argument')
    })

    it('ends with the markup reminder, which defends the tags', () => {
      const prompt = build({
        customInstructions: '直接输出小说正文，不添加任何解释。',
        protocol: 'markup'
      })
      expect(prompt.endsWith(MARKUP_FORMAT_PROTOCOL_REMINDER)).toBe(true)
      expect(MARKUP_FORMAT_PROTOCOL_REMINDER).toContain('never authorize you to drop the tags')
    })

    it('still carries no writing guidance', () => {
      const prompt = build({ protocol: 'markup' })
      expect(prompt).toContain('the task, the subject, the voice, the language and the standards all come from the user')
      expect(prompt).not.toMatch(/creative writing assistant/i)
    })
  })

  it('is deterministic — the prefix is stable for provider prompt caching', () => {
    const a = build({ customInstructions: 'Voice: terse.' })
    const b = build({ customInstructions: 'Voice: terse.' })
    expect(a).toBe(b)
  })
})

describe('agent rules: writing several chapters', () => {
  it('teaches one chapter per reply, asking for the next one\'s needs alongside, on both protocols', async () => {
    const { buildChatSystemPrompt } = await import('../systemPrompt')
    for (const protocol of ['markup', 'tools'] as const) {
      const prompt = buildChatSystemPrompt({ protocol, agentTools: true })
      expect(prompt).toContain('ONE chapter per reply')
      expect(prompt).toContain('also ask for what the next one needs')
      expect(prompt).toContain('Never put two or more chapters into one reply')
    }
    // Off: not a byte of it.
    expect(buildChatSystemPrompt({ protocol: 'markup' })).not.toContain('ONE chapter per reply')
  })
  it('with writes continuing the turn (the default): one chapter per reply, no workaround', async () => {
    const { buildChatSystemPrompt } = await import('../systemPrompt')
    const prompt = buildChatSystemPrompt({ protocol: 'markup', agentTools: true, continueAfterWrites: true })
    expect(prompt).toContain('ONE chapter per reply — you continue after each')
    expect(prompt).not.toContain('also ask for what the next one needs')
    // A tip that saves a step, not a rule (user decision 2026-10-06).
    expect(prompt).toContain('You can save a step by asking for what the next chapter needs (e.g. reading its source passages) in the same reply that writes this one')
    expect(prompt).toContain('A reply that does neither ends your turn')
  })

  it('creates a chapter only by writing it, on both protocols', async () => {
    // A lone create_chapter step cost a full planning pass that the writing
    // step then repeated (105–158 s measured, 2026-10-06).
    const { buildChatSystemPrompt } = await import('../systemPrompt')
    const markup = buildChatSystemPrompt({ protocol: 'markup', agentTools: true, continueAfterWrites: true })
    expect(markup).toContain('<canvas new_chapter="its title">…its full text…</canvas> creates it at the end of the book and fills it in one go')
    const tools = buildChatSystemPrompt({ protocol: 'tools', agentTools: true, continueAfterWrites: true })
    expect(tools).toContain('call update_document with `new_chapter` set to its title')
    for (const prompt of [markup, tools]) {
      expect(prompt).toContain('There is no separate step for creating a chapter')
      expect(prompt).not.toContain('create_chapter')
    }
  })

  it('puts the work in the reply that announces it, and never sells a tool call as the way to keep going', async () => {
    // A model told "a reply that calls a tool is not your final reply" and
    // "a reply with no action ends your turn" announced a rewrite, called
    // create_chapter("skip") to get another reply, and wrote it there.
    const { buildChatSystemPrompt } = await import('../systemPrompt')
    const markup = buildChatSystemPrompt({ protocol: 'markup', agentTools: true, continueAfterWrites: true })
    expect(markup).toContain('Do each piece of work in the reply that says you are doing it: "Now I\'ll rewrite chapter 3" goes in the same reply as its <canvas chapter="3">')
    expect(markup).not.toContain('is not your final reply')
    expect(markup).toContain('The <doc_status> line is required only on a reply that calls no tool')
    const tools = buildChatSystemPrompt({ protocol: 'tools', agentTools: true, continueAfterWrites: true })
    expect(tools).toContain('goes in the same reply as its update_document call')
    expect(tools).not.toContain('doc_status')
  })

  it('leaves re-reading and revising the outline to the model\'s judgment, on both protocols', async () => {
    const { buildChatSystemPrompt } = await import('../systemPrompt')
    for (const protocol of ['markup', 'tools'] as const) {
      const prompt = buildChatSystemPrompt({ protocol, agentTools: true, continueAfterWrites: true })
      expect(prompt).toContain('decide whether you need to look again at what it depends on')
      expect(prompt).toContain('you may update the outline chapter before going on')
      expect(prompt).toContain('Ask the user before restructuring the plan')
    }
    expect(buildChatSystemPrompt({ protocol: 'markup' })).not.toContain('look again')
  })
})
