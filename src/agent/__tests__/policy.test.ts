import { describe, it, expect } from 'vitest'
import { decideAfterStep, detectStepFailure, stepsLeft, defaultMaxSteps, type ExecutedCall, type RunBudgets, type StepPolicy } from '../policy'
import { collectStep, planWrites } from '../invocations'
import { ToolRegistry, defineTool } from '../registry'
import { DOCUMENT_WRITE_TOOLS } from '../tools/documentWrites'
import type { ToolInvocation } from '../types'

const budgets: RunBudgets = { maxSteps: 6, maxCorrective: 3 }
const policy: StepPolicy = { continueAfterWrites: false, feedBackFailedWrites: false }
const ok = { ok: true, content: '', trace: '' }
const failed = { ok: false, content: '', trace: '' }
const call = (kind: ExecutedCall['kind'], result = ok): ExecutedCall => ({ kind, result })
const decide = (executed: ExecutedCall[], over: Partial<{ stepsTaken: number; correctiveUsed: number; budgets: RunBudgets; policy: StepPolicy }> = {}) =>
  decideAfterStep({ executed, stepsTaken: 1, correctiveUsed: 0, budgets, policy, ...over })

describe('detectStepFailure', () => {
  const judge = (text: string, writeProtocol: 'tools' | 'markup', hadNativeCalls = false, markupKind: string | null = 'chat') =>
    detectStepFailure({ text, writeProtocol, hadNativeCalls, markupKind })

  it('requires the declaration on the markup protocol', () => {
    expect(judge('About 1,200 words.', 'markup')).toBe('undeclared')
  })

  it('never calls a plain answer undeclared on the tool protocol, which never taught the line', () => {
    // Before the loop this retried every question three times on Qwen, with an
    // instruction about <canvas> tags the model had never been shown.
    expect(judge('About 1,200 words.', 'tools')).toBeNull()
  })

  it('still catches broken markup on the tool protocol', () => {
    expect(judge('<edit>\n<<<<<<< SEARCH\nx', 'tools')).toBe('malformed')
  })

  it('does not judge a step that made a native call (it is not the final reply)', () => {
    expect(judge('Let me read it.', 'markup', true)).toBeNull()
  })

  it('does not judge a step whose markup parsed into an action', () => {
    expect(judge('<canvas><p>x</p></canvas>', 'markup', false, 'canvas')).toBeNull()
  })
})

describe('decideAfterStep (spec D3)', () => {
  it('ends when nothing was executed: the text is the answer', () => {
    expect(decide([])).toEqual({ action: 'end', reason: 'answered' })
  })

  it('ends after writes that all succeeded', () => {
    expect(decide([call('write'), call('write')])).toEqual({ action: 'end', reason: 'writes_done' })
  })

  it('continues after writes when the policy asks for a confirmation round', () => {
    expect(decide([call('write')], { policy: { ...policy, continueAfterWrites: true } })).toEqual({ action: 'continue', corrective: false })
  })

  it('continues after a read — the model asked for information', () => {
    expect(decide([call('read')])).toEqual({ action: 'continue', corrective: false })
  })

  it('continues after a write PLUS a read: how the model says there is more to do', () => {
    expect(decide([call('write'), call('read')])).toEqual({ action: 'continue', corrective: false })
  })

  it('reports a failed write without continuing unless feed-back is on', () => {
    expect(decide([call('write', failed)])).toEqual({ action: 'end', reason: 'writes_done' })
  })

  it('feeds a failed write back as a corrective step', () => {
    const p = { ...policy, feedBackFailedWrites: true }
    expect(decide([call('write', failed)], { policy: p })).toEqual({ action: 'continue', corrective: true })
    expect(decide([call('write', failed)], { policy: p, correctiveUsed: 3 })).toEqual({ action: 'end', reason: 'corrective_exhausted' })
  })

  it('ends at the step limit even when the model wanted more', () => {
    expect(decide([call('read')], { stepsTaken: 6 })).toEqual({ action: 'end', reason: 'step_limit' })
  })

  it('treats a step limit of 0 as no limit', () => {
    expect(decide([call('read')], { stepsTaken: 500, budgets: { ...budgets, maxSteps: 0 } })).toEqual({ action: 'continue', corrective: false })
    expect(stepsLeft({ ...budgets, maxSteps: 0 }, 10_000)).toBe(Infinity)
  })

  it('gives local models more steps than grok', () => {
    expect(defaultMaxSteps('grok')).toBe(6)
    expect(defaultMaxSteps('ollama')).toBe(10)
  })
})

describe('collectStep', () => {
  const read = defineTool<Record<string, unknown>>({
    name: 'read_chapter', description: '', parameters: { type: 'object' }, kind: 'read',
    isAvailable: () => true, parse: raw => raw ?? {}, execute: () => ok
  })
  const registry = new ToolRegistry([...DOCUMENT_WRITE_TOOLS, read])
  const native = (name: string, argumentsText = '{}') => ({ id: `id-${name}`, name, args: JSON.parse(argumentsText), argumentsText })

  it('turns markup into the same invocations a native call would make', () => {
    const step = collectStep('Done.\n<canvas><p>x</p></canvas>\n<doc_status>updated</doc_status>', [], registry, 0)
    expect(step.invocations).toEqual([
      { id: 'markup_0_0', name: 'update_document', args: { html: '<p>x</p>' }, source: 'markup', unclosed: false }
    ])
    expect(step.chatText).toBe('Done.')
  })

  it('splits a selection rewrite and the edits beside it into two invocations', () => {
    const text = '<selection_replace><p>new</p></selection_replace>\n<edit>\n<<<<<<< SEARCH\n<p>a</p>\n=======\n<p>b</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'
    expect(collectStep(text, [], registry, 2).invocations.map(i => [i.id, i.name])).toEqual([
      ['markup_2_0', 'replace_selection'],
      ['markup_2_1', 'edit_document']
    ])
  })

  it('keeps tag markup beside a native WRITE out of the document and the bubble', () => {
    const step = collectStep('ok <canvas><p>stray</p></canvas>', [native('update_document', '{"html":"<p>x</p>"}')], registry, 0)
    expect(step.invocations.map(i => i.name)).toEqual(['update_document'])
    expect(step.strayMarkup).toBe(1)
    expect(step.chatText).not.toContain('stray')
  })

  it('applies tag writes beside native READS: the hybrid grok runs on', () => {
    const step = collectStep('<canvas><p>x</p></canvas>', [native('read_chapter', '{"chapter":"3"}')], registry, 0)
    expect(step.invocations.map(i => [i.name, i.source])).toEqual([
      ['read_chapter', 'native'],
      ['update_document', 'markup']
    ])
  })

  it('keeps a call to an unknown tool, so it can be answered', () => {
    const step = collectStep('', [native('delete_everything')], registry, 0)
    expect(step.invocations.map(i => i.name)).toEqual(['delete_everything'])
    expect(step.unknownCalls).toBe(1)
  })
})

describe('planWrites', () => {
  const inv = (name: string, id = name): ToolInvocation => ({ id, name, args: {}, source: 'native' })

  it('runs every write, in order, when there is no selection', () => {
    const writes = [inv('edit_document', 'e1'), inv('update_document'), inv('edit_document', 'e2')]
    expect(planWrites(writes)).toEqual({ run: writes, dropped: 0 })
  })

  it('puts the selection first, keeps edits beside it, and drops a rewrite', () => {
    const plan = planWrites([inv('update_document'), inv('edit_document'), inv('replace_selection')])
    expect(plan.run.map(w => w.name)).toEqual(['replace_selection', 'edit_document'])
    expect(plan.dropped).toBe(1)
  })
})
