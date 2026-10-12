import { describe, it, expect } from 'vitest'
import { planElisions, elidedResultNote } from '../runCompaction'
import type { LLMMessage } from '../../types/llm'

const read = (n: number, chars: number): LLMMessage => ({ role: 'user', content: `READ ${n} ` + '字'.repeat(chars) })

describe('planElisions', () => {
  it('elides old reads when that brings the prompt back under the limit', () => {
    const messages: LLMMessage[] = [{ role: 'system', content: 'sys' }, read(1, 5_000), read(2, 5_000), read(3, 500)]
    const plan = planElisions(messages, [{ index: 1, trace: 'r1' }, { index: 2, trace: 'r2' }], 8_000, 3)
    expect(plan.elided.length).toBeGreaterThan(0)
    expect(plan.messages[1].content).toBe(elidedResultNote('r1'))
  })

  it('elides nothing when even every eligible result gone would leave the prompt over the limit', () => {
    // 2026-10-11: a 340k prompt against a 200k window figure elided the previous
    // read each step; the model read the same paragraphs again after each elision.
    const messages: LLMMessage[] = [{ role: 'system', content: '字'.repeat(20_000) }, read(1, 2_000), read(2, 500)]
    const plan = planElisions(messages, [{ index: 1, trace: 'r1' }], 10_000, 2)
    expect(plan.elided).toEqual([])
    expect(plan.messages).toBe(messages)
  })
})
