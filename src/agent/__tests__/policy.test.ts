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

  it('takes the closing reply of a run that already wrote at its word, but not its broken markup', () => {
    // "Done — both chapters are written." refers to the earlier steps' writes.
    const closing = (text: string) => detectStepFailure({ text, writeProtocol: 'markup', hadNativeCalls: false, markupKind: 'chat', wroteThisRun: true })
    expect(closing('两章都写完了。')).toBeNull()
    expect(closing('写完了。\n<doc_status>updated</doc_status>')).toBeNull()
    expect(closing('<edit>\n<<<<<<< SEARCH\nx')).toBe('malformed')
  })
})

describe('decideAfterStep (spec D3)', () => {
  it('ends when nothing was executed: the text is the answer', () => {
    expect(decide([])).toEqual({ action: 'end', reason: 'answered' })
  })

  it('ends after writes that all succeeded', () => {
    expect(decide([call('write'), call('write')])).toEqual({ action: 'end', reason: 'writes_done' })
  })

  it('continues after writes when the policy hands write results back (the default)', () => {
    expect(decide([call('write')], { policy: { ...policy, continueAfterWrites: true } })).toEqual({ action: 'continue', corrective: false, final: false })
  })

  it('calls writes that landed on the last allowed step done, not cut off', () => {
    const p = { ...policy, continueAfterWrites: true }
    expect(decide([call('write')], { policy: p, stepsTaken: 6 })).toEqual({ action: 'end', reason: 'writes_done' })
    expect(decide([call('write'), call('read')], { policy: p, stepsTaken: 6 })).toEqual({ action: 'end', reason: 'step_limit' })
  })

  it('continues after a read — the model asked for information', () => {
    expect(decide([call('read')])).toEqual({ action: 'continue', corrective: false, final: false })
  })

  it('continues after a write PLUS a read: how the model says there is more to do', () => {
    expect(decide([call('write'), call('read')])).toEqual({ action: 'continue', corrective: false, final: false })
  })

  it('reports a failed write without continuing unless feed-back is on', () => {
    expect(decide([call('write', failed)])).toEqual({ action: 'end', reason: 'writes_done' })
  })

  it('feeds a failed write back as a corrective step', () => {
    const p = { ...policy, feedBackFailedWrites: true }
    expect(decide([call('write', failed)], { policy: p })).toEqual({ action: 'continue', corrective: true, final: false })
    expect(decide([call('write', failed)], { policy: p, correctiveUsed: 3 })).toEqual({ action: 'end', reason: 'corrective_exhausted' })
  })

  it('ends at the step limit even when the model wanted more', () => {
    expect(decide([call('read')], { stepsTaken: 6 })).toEqual({ action: 'end', reason: 'step_limit' })
  })

  it('treats a step limit of 0 as no limit', () => {
    expect(decide([call('read')], { stepsTaken: 500, budgets: { ...budgets, maxSteps: 0 } })).toEqual({ action: 'continue', corrective: false, final: false })
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

  it('turns a canvas that creates its chapter into update_document with new_chapter', () => {
    const step = collectStep('写第二章。\n<canvas new_chapter="第二章 进城"><p>x</p></canvas>\n<doc_status>updated</doc_status>', [], registry, 0)
    expect(step.invocations).toEqual([
      { id: 'markup_0_0', name: 'update_document', args: { html: '<p>x</p>', new_chapter: '第二章 进城' }, source: 'markup', unclosed: false }
    ])
    expect(step.chatText).toBe('写第二章。')
  })

  it('keeps a new chapter written beside a selection rewrite: it cannot collide with it', () => {
    const text = '<selection_replace><p>new</p></selection_replace>\n<canvas new_chapter="第二章"><p>x</p></canvas>\n<doc_status>updated</doc_status>'
    const step = collectStep(text, [], registry, 0)
    const { run, dropped } = planWrites(step.invocations)
    expect(run.map(i => [i.name, i.args?.new_chapter])).toEqual([['replace_selection', undefined], ['update_document', '第二章']])
    expect(dropped).toBe(0)
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

  it('applies tag writes beside a native write that has no tag form (delete, polish)', () => {
    const del = defineTool<Record<string, unknown>>({
      name: 'delete_chapter', description: '', parameters: { type: 'object' }, kind: 'write',
      isAvailable: () => true, parse: raw => raw ?? {}, execute: () => ok
    })
    const reg = new ToolRegistry([...DOCUMENT_WRITE_TOOLS, del])
    const step = collectStep('<canvas chapter="3"><p>x</p></canvas>', [native('delete_chapter', '{"chapter":"2"}')], reg, 0)
    expect(step.invocations.map(i => [i.name, i.source])).toEqual([
      ['delete_chapter', 'native'],
      ['update_document', 'markup']
    ])
    expect(step.strayMarkup).toBe(0)
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

describe('resolveRunSettings', () => {
  it('defaults: agent tools on, provider step limits, and writes hand their result back (every provider)', async () => {
    const { resolveRunSettings } = await import('../policy')
    expect(resolveRunSettings('grok', {})).toMatchObject({
      agentTools: true,
      budgets: { maxSteps: 6 },
      policy: { continueAfterWrites: true, feedBackFailedWrites: true }
    })
    expect(resolveRunSettings('ollama', undefined).policy.continueAfterWrites).toBe(true)
    expect(resolveRunSettings('grok', { continueAfterWrites: false }).policy.continueAfterWrites).toBe(false)
    // A rejoined stream cannot continue at all.
    expect(resolveRunSettings('grok', {}, false).policy.continueAfterWrites).toBe(false)
  })

  it('honours the settings, with 0 meaning no step limit', async () => {
    const { resolveRunSettings } = await import('../policy')
    expect(resolveRunSettings('grok', { agentMaxSteps: 0, continueAfterWrites: true })).toMatchObject({
      budgets: { maxSteps: 0 },
      policy: { continueAfterWrites: true }
    })
    expect(resolveRunSettings('grok', { agentMaxSteps: -3 }).budgets.maxSteps).toBe(6)
  })

  it('turning the agent tools off restores the pre-loop turn', async () => {
    const { resolveRunSettings } = await import('../policy')
    expect(resolveRunSettings('grok', { agentTools: false, continueAfterWrites: true }).policy).toEqual({
      continueAfterWrites: false,
      feedBackFailedWrites: false
    })
  })

  it('pins a rejoined stream to its one step', async () => {
    const { resolveRunSettings } = await import('../policy')
    expect(resolveRunSettings('grok', { agentMaxSteps: 0 }, false).budgets.maxSteps).toBe(1)
  })
})

describe('markup invocations with a chapter attribute', () => {
  const registry = new ToolRegistry([...DOCUMENT_WRITE_TOOLS])
  it('groups edits by the chapter their <edit> names', () => {
    const block = (s: string) => `<<<<<<< SEARCH\n<p>${s}</p>\n=======\n<p>${s}!</p>\n>>>>>>> REPLACE`
    const text = `<edit chapter="3">\n${block('a')}\n${block('b')}\n</edit>\n<edit>\n${block('c')}\n</edit>\n<doc_status>updated</doc_status>`
    const step = collectStep(text, [], registry, 0)
    expect(step.invocations.map(i => i.args)).toEqual([
      { chapter: '3', edits: [{ search: '<p>a</p>', replace: '<p>a!</p>' }, { search: '<p>b</p>', replace: '<p>b!</p>' }] },
      { edits: [{ search: '<p>c</p>', replace: '<p>c!</p>' }] }
    ])
  })

  it('applies further canvases that name a chapter; an unnamed second one stays stray', () => {
    const text = 'Two.\n<canvas><p>active</p></canvas>\n<canvas chapter="4"><p>new</p></canvas>\n<canvas><p>?</p></canvas>\n<doc_status>updated</doc_status>'
    const step = collectStep(text, [], registry, 0)
    expect(step.invocations.map(i => [i.name, i.args?.chapter])).toEqual([
      ['update_document', undefined],
      ['update_document', '4']
    ])
    expect(step.strayMarkup).toBe(1)
    expect(step.chatText).toBe('Two.')
  })

  it('keeps a rewrite of another chapter beside a selection rewrite', () => {
    const inv = (name: string, args: Record<string, unknown>): ToolInvocation => ({ id: name, name, args, source: 'markup' })
    const plan = planWrites([inv('replace_selection', { html: 'x' }), inv('update_document', { html: 'y', chapter: '2' }), inv('update_document', { html: 'z' })])
    expect(plan.run.map(w => w.args?.chapter)).toEqual([undefined, '2'])
    expect(plan.dropped).toBe(1)
  })
})
