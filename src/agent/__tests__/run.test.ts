/**
 * The run controller against a scripted driver: every step's request is
 * recorded, every reply is scripted, and the observer collects the outcome.
 * No editor, no store — the write tools run against the fake context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LLMMessage } from '../../types/llm'
import { AgentRun, type RunSummary, type StepOutput } from '../run'
import { ToolRegistry, defineTool } from '../registry'
import { DOCUMENT_WRITE_TOOLS } from '../tools/documentWrites'
import { DEFAULT_BUDGETS, DEFAULT_POLICY, type RunBudgets, type StepPolicy } from '../policy'
import { NO_ACTION_RETRY_INSTRUCTION } from '../../hooks/chat/streamHandlers'
import { stripDiffMarkup } from '../../utils/diff'
import type { ToolResult } from '../types'
import { fakeContext } from './fakeContext'

type Reply = StepOutput | ((messages: LLMMessage[]) => StepOutput)

function readTool(execute: (args: Record<string, unknown>) => ToolResult | Promise<ToolResult> = args => ({
  ok: true, content: `TEXT OF ${String(args.chapter)}`, trace: `read ${String(args.chapter)}`
})) {
  return defineTool<Record<string, unknown>>({
    name: 'read_chapter',
    description: 'Read a chapter.',
    parameters: { type: 'object', properties: { chapter: { type: 'string' } } },
    kind: 'read',
    isAvailable: () => true,
    parse: raw => raw ?? 'no arguments',
    execute
  })
}

function harness(opts: {
  replies: Reply[]
  writeProtocol?: 'tools' | 'markup'
  budgets?: Partial<RunBudgets>
  policy?: Partial<StepPolicy>
  canContinue?: boolean
  original?: string
  read?: ReturnType<typeof readTool>
}) {
  const fake = fakeContext(opts.original ?? '<p>alpha</p>')
  const registry = new ToolRegistry([...DOCUMENT_WRITE_TOOLS, opts.read ?? readTool()])
  const requests: LLMMessage[][] = []
  const corrective: Array<[string, number, number]> = []
  let summary: RunSummary | null = null
  const replies = [...opts.replies]

  const run: AgentRun = new AgentRun({
    registry,
    ctx: fake.ctx,
    writeProtocol: opts.writeProtocol ?? 'markup',
    // Synchronous like the hook's scripted transport: the reply lands inside
    // the driver call, exactly where a real onDone would run.
    driver: async messages => {
      requests.push(messages)
      const next = replies.shift()
      if (!next) throw new Error('scripted replies exhausted')
      run.stepDone(typeof next === 'function' ? next(messages) : next)
    },
    observer: {
      onCorrective: (failure, attempt, max) => { corrective.push([failure, attempt, max]) },
      onFinish: s => { summary = s }
    },
    budgets: { ...DEFAULT_BUDGETS, ...opts.budgets },
    policy: { ...DEFAULT_POLICY, ...opts.policy },
    canContinue: opts.canContinue ?? true,
    initialMessages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'request' }]
  })
  return { run, fake, requests, corrective, summary: () => summary as RunSummary | null }
}

const text = (t: string): StepOutput => ({ text: t, nativeCalls: [] })
const calls = (t: string, ...c: Array<[string, string, string]>): StepOutput => ({
  text: t,
  nativeCalls: c.map(([id, name, argumentsText]) => ({ id, name, argumentsText, args: JSON.parse(argumentsText) }))
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a markup-protocol turn (what every grok turn was before the loop)', () => {
  it('applies a rewrite and ends in one step', async () => {
    const h = harness({ replies: [text('Done.\n<canvas><p>beta</p></canvas>\n<doc_status>updated</doc_status>')] })
    await h.run.start()

    expect(h.requests).toHaveLength(1)
    expect(stripDiffMarkup(h.fake.lastCommit())).toBe('<p>beta</p>')
    expect(h.summary()).toMatchObject({ chatText: 'Done.', endReason: 'writes_done', steps: 1 })
  })

  it('retries a protocol failure by appending, never rebuilding, the request', async () => {
    const h = harness({ replies: [text('已改好。'), text('Sure.\n<doc_status>unchanged</doc_status>')] })
    await h.run.start()

    expect(h.corrective).toEqual([['undeclared', 1, 3]])
    const [first, second] = h.requests
    // Append-only (D4): the second request starts with the first one's
    // messages, byte for byte, so the provider's prefix cache still holds.
    expect(second.slice(0, first.length)).toEqual(first)
    expect(second.slice(first.length)).toEqual([
      { role: 'assistant', content: '已改好。' },
      { role: 'user', content: NO_ACTION_RETRY_INSTRUCTION }
    ])
    expect(h.summary()).toMatchObject({ endReason: 'answered', failedUpdate: null })
  })

  it('gives up after the corrective budget and says so', async () => {
    const h = harness({ replies: [text('a'), text('b'), text('c'), text('d')] })
    await h.run.start()

    expect(h.requests).toHaveLength(4)
    expect(h.summary()).toMatchObject({ failedUpdate: 'undeclared', exhaustedCorrective: true, endReason: 'protocol_failure' })
  })

  it('cannot retry a rejoined stream, and says so only when content was lost', async () => {
    const h = harness({ canContinue: false, replies: [text('I rewrote it.\n<doc_status>updated</doc_status>')] })
    await h.run.start()

    expect(h.corrective).toEqual([])
    expect(h.summary()).toMatchObject({ failedUpdate: 'claimed', exhaustedCorrective: false, unretriableFailedUpdate: true })
  })
})

describe('a multi-step turn', () => {
  it('answers a read with a tool message under the call id, replaying the argument bytes exactly', async () => {
    const args = '{"chapter":  "第三章"}'
    const h = harness({
      writeProtocol: 'tools',
      replies: [calls('Let me look.', ['call_a', 'read_chapter', args]), text('It is about a cat.')]
    })
    await h.run.start()

    const second = h.requests[1]
    expect(second.slice(0, h.requests[0].length)).toEqual(h.requests[0])
    expect(second.slice(h.requests[0].length)).toEqual([
      { role: 'assistant', content: 'Let me look.', toolCalls: [{ id: 'call_a', name: 'read_chapter', argumentsText: args }] },
      { role: 'tool', toolCallId: 'call_a', name: 'read_chapter', content: 'TEXT OF 第三章' }
    ])
    expect(h.summary()).toMatchObject({ endReason: 'answered', steps: 2, chatText: 'Let me look.\n\nIt is about a cat.', trace: ['read 第三章'] })
    expect(h.summary()?.timeline).toEqual([
      { type: 'text', text: 'Let me look.' },
      { type: 'tool', line: 'read 第三章', ok: true },
      { type: 'text', text: 'It is about a cat.' }
    ])
  })

  it('lets grok write with tags and read natively in the same step, then continue (D1 + D3)', async () => {
    const h = harness({
      replies: [
        calls('<canvas><p>chapter 3 done</p></canvas>', ['c1', 'read_chapter', '{"chapter":"4"}']),
        text('Both done.\n<doc_status>unchanged</doc_status>')
      ]
    })
    await h.run.start()

    expect(stripDiffMarkup(h.fake.lastCommit())).toBe('<p>chapter 3 done</p>')
    const tail = h.requests[1].slice(h.requests[0].length)
    expect(tail.map(m => m.role)).toEqual(['assistant', 'tool', 'user'])
    // The tag write has no call id to answer; its outcome goes in a user note.
    expect(tail[2].content).toContain('update_document: #1 "Chapter 1" was rewritten.')
  })

  it('answers a call to an unknown tool instead of leaving its id unanswered', async () => {
    const h = harness({ writeProtocol: 'tools', replies: [calls('', ['x1', 'delete_book', '{}']), text('Sorry.')] })
    await h.run.start()

    expect(h.requests[1].at(-1)).toEqual({ role: 'tool', toolCallId: 'x1', name: 'delete_book', content: 'There is no tool named "delete_book".' })
  })

  it('stops at the step limit', async () => {
    const reading = () => calls('', ['r', 'read_chapter', '{"chapter":"1"}'])
    const h = harness({ writeProtocol: 'tools', budgets: { maxSteps: 2 }, replies: [reading, reading, reading] })
    await h.run.start()

    expect(h.requests).toHaveLength(2)
    expect(h.summary()).toMatchObject({ endReason: 'step_limit', steps: 2 })
  })

  it('runs past the default limit when the limit is 0', async () => {
    const reading = () => calls('', ['r', 'read_chapter', '{"chapter":"1"}'])
    const replies: Reply[] = [...Array(9).fill(reading), text('done')]
    const h = harness({ writeProtocol: 'tools', budgets: { maxSteps: 0 }, replies })
    await h.run.start()

    expect(h.requests).toHaveLength(10)
    expect(h.summary()).toMatchObject({ endReason: 'answered', steps: 10 })
  })

  it('feeds a failed edit back and lets the model fix it, when the policy says so', async () => {
    const editMarkup = (search: string) =>
      `<edit>\n<<<<<<< SEARCH\n${search}\n=======\n<p>ALPHA</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>`
    const h = harness({
      policy: { feedBackFailedWrites: true },
      replies: [text(editMarkup('<p>alfa</p>')), text(editMarkup('<p>alpha</p>'))]
    })
    await h.run.start()

    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].at(-1)?.content).toContain('<p>alfa</p>')
    expect(stripDiffMarkup(h.fake.lastCommit())).toBe('<p>ALPHA</p>')
  })

  it('waits for an async tool, and starts no step after Stop', async () => {
    let release: () => void = () => {}
    const slow = readTool(() => new Promise<ToolResult>(resolve => {
      release = () => resolve({ ok: true, content: 'late', trace: 'read' })
    }))
    const h = harness({ writeProtocol: 'tools', read: slow, replies: [calls('', ['r', 'read_chapter', '{}']), text('never sent')] })
    await h.run.start()
    expect(h.summary()).toBeNull()

    h.run.cancel()
    release()
    await vi.waitFor(() => expect(h.summary()).not.toBeNull())

    expect(h.requests).toHaveLength(1)
    expect(h.summary()).toMatchObject({ endReason: 'cancelled' })
  })
})

describe('what a step offers', () => {
  it('offers only non-write tools natively on the markup protocol (the hybrid)', () => {
    const h = harness({ replies: [] })
    expect(h.run.offeredTools().map(t => t.name)).toEqual(['read_chapter'])
  })

  it('offers the writes natively on the tool protocol, the selection rewrite only with a selection', () => {
    const h = harness({ writeProtocol: 'tools', replies: [] })
    expect(h.run.offeredTools().map(t => t.name)).toEqual(['update_document', 'edit_document', 'read_chapter'])
  })
})
