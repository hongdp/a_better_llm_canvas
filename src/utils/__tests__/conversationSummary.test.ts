/**
 * The conversation past the window (agentic_chat_loop.md §0.9): when a
 * summary is made, reused or refreshed, and what the summarizer is asked.
 */
import { describe, it, expect } from 'vitest'
import {
  planConversationSummary, buildSummaryRequest, parseSummaryReply, summaryMessages,
  SUMMARY_RESERVE_CHARS, KEEP_FRACTION, SUMMARY_MESSAGE_CHARS, SUMMARY_INPUT_CHARS, type SummarizableMessage
} from '../conversationSummary'

const msg = (id: string, role: 'user' | 'assistant', chars: number): SummarizableMessage => ({ id, role, content: `${id}:` + 'x'.repeat(Math.max(0, chars - id.length - 1)) })
/** Ten turns of 1,000 chars each: u0 a0 u1 a1 … */
const turns = (n: number, chars = 1000): SummarizableMessage[] =>
  Array.from({ length: n * 2 }, (_, i) => msg(`${i % 2 === 0 ? 'u' : 'a'}${Math.floor(i / 2)}`, i % 2 === 0 ? 'user' : 'assistant', chars))

describe('planConversationSummary', () => {
  it('does nothing while the history fits', () => {
    expect(planConversationSummary(turns(5), 20_000, null)).toEqual({ cutIndex: 0, summary: null, needs: null, upToId: null })
  })

  it('cuts to a fraction of the budget and asks for a note covering the dropped prefix', () => {
    const messages = turns(10)
    const budget = 10_000 + SUMMARY_RESERVE_CHARS
    const plan = planConversationSummary(messages, budget, null)
    expect(plan.summary).toBeNull()
    expect(plan.needs?.previousSummary).toBeNull()
    // The kept tail is at most KEEP_FRACTION of the usable budget, starts at a user turn, and the note covers the rest.
    const kept = messages.slice(plan.cutIndex).reduce((s, m) => s + m.content.length, 0)
    expect(kept).toBeLessThanOrEqual(10_000 * KEEP_FRACTION)
    expect(messages[plan.cutIndex].role).toBe('user')
    expect(plan.needs?.messages.map(m => m.id)).toEqual(messages.slice(0, plan.cutIndex).map(m => m.id))
    expect(plan.upToId).toBe(messages[plan.cutIndex].id)
  })

  it('reuses the stored note while the tail past its cut still fits', () => {
    const messages = turns(10)
    const budget = 10_000 + SUMMARY_RESERVE_CHARS
    const stored = { upToId: 'u6', text: 'NOTE' }
    expect(planConversationSummary(messages, budget, stored)).toEqual({ cutIndex: 12, summary: 'NOTE', needs: null, upToId: 'u6' })
  })

  it('refreshes from the stored note when the tail past it no longer fits', () => {
    const messages = turns(12)
    const budget = 4_000 + SUMMARY_RESERVE_CHARS
    const stored = { upToId: 'u2', text: 'OLD' }
    const plan = planConversationSummary(messages, budget, stored)
    expect(plan.summary).toBeNull()
    expect(plan.needs?.previousSummary).toBe('OLD')
    // From the old cut to the new one: nothing before u2 is summarized twice.
    expect(plan.needs?.messages[0].id).toBe('u2')
    expect(plan.cutIndex).toBeGreaterThan(4)
  })

  it('rebuilds from the start when the stored cut is gone (the chat was edited)', () => {
    const messages = turns(10)
    const plan = planConversationSummary(messages, 4_000 + SUMMARY_RESERVE_CHARS, { upToId: 'gone', text: 'OLD' })
    expect(plan.needs?.previousSummary).toBeNull()
    expect(plan.needs?.messages[0].id).toBe('u0')
  })

  it('keeps the last two messages whatever the budget', () => {
    const messages = turns(3, 5_000)
    const plan = planConversationSummary(messages, 100, null)
    expect(plan.cutIndex).toBe(4)
    expect(plan.upToId).toBe('u2')
  })
})

describe('buildSummaryRequest', () => {
  it('tags each message by role and asks for the note', () => {
    const { system, user, omitted } = buildSummaryRequest(null, [msg('u0', 'user', 20), msg('a0', 'assistant', 20)])
    expect(system).toContain('<summary>')
    expect(user).toMatch(/^TRANSCRIPT \(2 messages, oldest first\):\n\n\[user\]\nu0:/)
    expect(user).toContain('\n\n[assistant]\na0:')
    expect(user.endsWith('\n\nWrite the summary now.')).toBe(true)
    expect(omitted).toBe(0)
  })

  it('carries the prior note first and caps the input, dropping the oldest', () => {
    const many = Array.from({ length: 40 }, (_, i) => msg(`m${i}`, i % 2 ? 'assistant' : 'user', SUMMARY_MESSAGE_CHARS + 500))
    const { user, omitted } = buildSummaryRequest('PRIOR', many)
    expect(user.startsWith('PRIOR SUMMARY (authoritative for the history before this transcript):\n<conversation_summary>\nPRIOR\n</conversation_summary>\n\n')).toBe(true)
    expect(omitted).toBeGreaterThan(0)
    expect(user).toContain(`; ${omitted} earlier messages omitted for length`)
    expect(user).toContain('… [truncated]')
    expect(user.length).toBeLessThan(SUMMARY_INPUT_CHARS + 2_000)
    expect(user).not.toContain('[user]\nm0:')
    expect(user).toContain('m39:')
  })
})

describe('parseSummaryReply and summaryMessages', () => {
  it('takes the block\'s inside, or the whole text, and nothing from an empty reply', () => {
    expect(parseSummaryReply('Here you go.\n<summary>\n1. Requests: x\n</summary>\ndone')).toBe('1. Requests: x')
    expect(parseSummaryReply('1. Requests: y')).toBe('1. Requests: y')
    expect(parseSummaryReply('<summary>  </summary>')).toBeNull()
    expect(parseSummaryReply('')).toBeNull()
  })

  it('carries the note as a cached user turn with an acknowledgement', () => {
    const pair = summaryMessages('NOTE')
    expect(pair).toHaveLength(2)
    expect(pair[0]).toMatchObject({ role: 'user', cacheHint: true })
    expect(pair[0].content).toContain('<conversation_summary>\nNOTE\n</conversation_summary>')
    expect(pair[1]).toEqual({ role: 'assistant', content: 'Understood. I will continue from this summary.' })
  })
})
