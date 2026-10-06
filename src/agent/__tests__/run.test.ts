/**
 * The run controller against a scripted driver: every step's request is
 * recorded, every reply is scripted, and the observer collects the outcome.
 * No editor, no store — the write tools run against the fake context.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LLMMessage } from '../../types/llm'
import { AgentRun, type RunSummary, type StepOutput } from '../run'
import { ToolRegistry, defineTool, type RegisteredTool } from '../registry'
import { deleteChapterTool } from '../tools/bookReads'
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
  /** More tools for the registry. */
  extra?: RegisteredTool[]
  /** The fake book's further chapters. */
  chapters?: Parameters<typeof fakeContext>[1] extends infer O ? O extends { chapters?: infer C } ? C : never : never
}) {
  const fake = fakeContext(opts.original ?? '<p>alpha</p>', { chapters: opts.chapters })
  const registry = new ToolRegistry([...DOCUMENT_WRITE_TOOLS, opts.read ?? readTool(), ...(opts.extra ?? [])])
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

describe('what a reply lost is said, not left for the model to discover', () => {
  it('reports a dropped block in the next step\'s results', async () => {
    // An unnamed edit and an unnamed canvas collide on the same chapter: the
    // canvas is dropped (stray), the edit applies, and the model is told.
    const h = harness({
      policy: { continueAfterWrites: true },
      replies: [
        text('<canvas><p>beta</p></canvas>\n<edit>\n<<<<<<< SEARCH\n<p>alpha</p>\n=======\n<p>gamma</p>\n>>>>>>> REPLACE\n</edit>\n<doc_status>updated</doc_status>'),
        text('好了。')
      ]
    })
    await h.run.start()
    const results = h.requests[1].at(-1)?.content ?? ''
    expect(results).toContain('edit_document')
    expect(results).toContain('NOT APPLIED: 1 document block(s)')
  })
})

describe('a deletion runs after the other calls of its reply', () => {
  it('lets a write in the same reply keep the number it was given from the index', async () => {
    // Reply: delete #2 (an empty chapter) and rewrite #3. The model numbered
    // both from the index as it was; deleting first would make "#3" point
    // past the end of the book.
    const h = harness({
      extra: [deleteChapterTool],
      chapters: [{ id: 'doc-2', title: 'skip', content: '<p></p>' }, { id: 'doc-3', title: '第一章', content: '<p></p>' }],
      policy: { continueAfterWrites: true },
      replies: [
        calls('<canvas chapter="3"><p>第一章正文</p></canvas>\n<doc_status>updated</doc_status>', ['d1', 'delete_chapter', '{"chapter":"2"}']),
        text('好了。')
      ]
    })
    await h.run.start()
    // Writes to another chapter wait for its content to load.
    await new Promise(r => setTimeout(r, 0))

    expect(h.fake.removed).toEqual(['doc-2'])
    expect(stripDiffMarkup(h.fake.lastWrite('doc-3') ?? '')).toBe('<p>第一章正文</p>')
    expect(h.summary()?.trace).toEqual(['✏️ rewrote #3 "第一章" (5 chars)', '🗑 deleted #2 "skip"'])
  })
})

describe('a markup-protocol turn (what every grok turn was before the loop)', () => {
  it('applies a rewrite and ends in one step', async () => {
    const h = harness({ replies: [text('Done.\n<canvas><p>beta</p></canvas>\n<doc_status>updated</doc_status>')] })
    await h.run.start()

    expect(h.requests).toHaveLength(1)
    expect(stripDiffMarkup(h.fake.lastCommit())).toBe('<p>beta</p>')
    expect(h.summary()).toMatchObject({ chatText: 'Done.', endReason: 'writes_done', steps: 1 })
  })

  it('hands a write back when writes continue the turn, and ends on the reply with no action', async () => {
    const h = harness({
      policy: { continueAfterWrites: true },
      replies: [
        text('Done.\n<canvas><p>beta</p></canvas>\n<doc_status>updated</doc_status>'),
        // The closing reply: no action and no declaration. It refers to the
        // write above, so it is not a failed update.
        text('Both paragraphs now read beta.')
      ]
    })
    await h.run.start()

    expect(h.requests).toHaveLength(2)
    expect(h.requests[1].at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('RESULT OF YOUR DOCUMENT CHANGES') })
    expect(h.corrective).toEqual([])
    expect(h.summary()).toMatchObject({ chatText: 'Done.\n\nBoth paragraphs now read beta.', endReason: 'answered', steps: 2, failedUpdate: null })
  })

  it('still corrects broken markup in the closing reply', async () => {
    const h = harness({
      policy: { continueAfterWrites: true },
      replies: [
        text('<canvas><p>beta</p></canvas>\n<doc_status>updated</doc_status>'),
        text('<edit>\n<<<<<<< SEARCH\n<p>beta</p>'),
        text('Fine as it is.\n<doc_status>unchanged</doc_status>')
      ]
    })
    await h.run.start()

    expect(h.corrective).toEqual([['malformed', 1, 3]])
    expect(h.summary()).toMatchObject({ endReason: 'answered', steps: 3 })
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
    expect(tail[2].content).toContain('update_document: Rewrote the EXISTING chapter #1 "Chapter 1": it had 5 characters and now has 14.')
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

describe('a chapter created for a write that never landed', () => {
  const cutOff = text('<canvas new_chapter="第二章"><p>写到一半')

  it('is removed when the run ends', async () => {
    const h = harness({ policy: { continueAfterWrites: true }, replies: [cutOff, text('写不下去了。\n<doc_status>unchanged</doc_status>')] })
    await h.run.start()
    // A write to a chapter other than the start one waits for its content.
    await vi.waitFor(() => expect(h.summary()).not.toBeNull())
    expect(h.requests[1].at(-1)?.content).toContain('cut off')
    expect(h.fake.book().map(c => c.title)).toEqual(['Chapter 1'])
    expect(h.fake.removed).toHaveLength(1)
    expect(h.summary()?.touched).toEqual([])
  })

  it('is left alone when the user stopped the run: what a stopped run made is theirs to keep or delete', async () => {
    const h = harness({ replies: [() => { h.run.cancel(); return cutOff }] })
    await h.run.start()
    await vi.waitFor(() => expect(h.summary()).not.toBeNull())
    expect(h.summary()).toMatchObject({ endReason: 'cancelled' })
    expect(h.fake.book().map(c => c.title)).toEqual(['Chapter 1', '第二章'])
    expect(h.fake.removed).toEqual([])
  })
})
