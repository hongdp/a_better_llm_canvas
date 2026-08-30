/**
 * Acceptance: does a real engine actually reuse the prefix we went to such
 * trouble to keep stable?
 *
 * Every prompt here is built with the PRODUCT's own functions — the same
 * `buildLedgerMessages`, `buildVolatileTail`, `planLedgerTurn` and
 * `trimHistoryForContext` the app calls — so this measures the shipped
 * assembly, not a re-implementation of it.
 *
 * The signal is `timings.cache_n` from llama.cpp: how many prompt tokens came
 * out of cache instead of being computed. `usage.prompt_tokens` is the total;
 * `timings.prompt_n` is only what was actually computed. Verified against the
 * running server: a repeated prompt reports cache_n 792, prompt_n 4 for 796
 * total.
 *
 * TRAP, found the hard way: llama.cpp keeps an LRU of PAST prompts in RAM
 * (`--cache-ram`), not just the last one in the slot. A first version of this
 * file reported a 99.9% hit for a prompt that differed at character 103 —
 * because an earlier run had already sent it. Every prompt here therefore
 * carries a per-test nonce at the very front, so nothing can be served from a
 * previous run and a hit can only mean what we think it means.
 *
 * WHAT THIS ENGINE ACTUALLY DELIVERS, measured on the hybrid Qwen3.8-Flash-Next
 * (Gated DeltaNet + sparse attention; the GGUF carries `ssm.*` metadata):
 *
 *   the identical prompt again        4522/4526 cached, 0.3s (cold: 42.5s)
 *   a prompt sharing a 3282-token prefix   1511/4526 cached, 23.9s
 *
 * A recurrent state cannot be rewound to an arbitrary token the way a plain KV
 * cache can, so extending a conversation gets PARTIAL reuse here — and how
 * much varies: appending chat history reused 3690 of ~3700 shared tokens
 * (4.3× faster), while appending a chapter inside the ledger block reused
 * 1510 of 3281.
 *
 * Three fixes were tried and MEASURED NOT to help, so do not retry them:
 *   --swa-full                     no change (1511/4526)
 *   -cms 512 -ctxcp 64             no change (1510/4525)
 *   one message pair per chapter   no change (1510/4642) — the "diverge at a
 *                                  message boundary" theory is wrong
 * These tests therefore assert the DIRECTION the design predicts — an extended
 * prefix is reused and a broken one is not — rather than a reuse percentage
 * this architecture cannot reach. On a plain transformer (grok, which caches an
 * exact prefix automatically) the same layout reuses the whole prefix.
 *
 * Requires a local llama.cpp server (see local_model/README.md):
 *   systemctl --user start llama-qwen38   # or ./start-flash-next.sh
 *   npm run test:acceptance
 */
import { describe, it, expect, beforeAll } from 'vitest'
import {
  buildLedgerMessages,
  buildVolatileTail,
  type RenderableDoc
} from '../../src/hooks/chat/dynamicContext'
import {
  EMPTY_LEDGER,
  hashContent,
  planLedgerTurn,
  orderAdmissionsByStability
} from '../../src/utils/contextLedger'
import { trimHistoryForContext } from '../../src/utils/llmContext'
import { buildChatSystemPrompt } from '../../src/utils/systemPrompt'
import type { LLMMessage } from '../../src/types/llm'

const ENDPOINT = process.env.ACCEPTANCE_ENDPOINT ?? 'http://127.0.0.1:8090/v1'

interface Timings {
  /** Prompt tokens served from cache. */
  cached: number
  /** Prompt tokens actually computed this request. */
  computed: number
  /** cached + computed, straight from usage. */
  total: number
  promptMs: number
}

/** Send a prompt and report what the engine did with it. */
async function measure(messages: LLMMessage[]): Promise<Timings> {
  const res = await fetch(`${ENDPOINT}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'acceptance',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      // The reply is irrelevant; prefill is the measurement.
      max_tokens: 1,
      temperature: 0,
      stream: false
    })
  })
  if (!res.ok) throw new Error(`endpoint ${res.status}: ${await res.text()}`)
  const body = await res.json()
  const t = body.timings ?? {}
  return {
    cached: t.cache_n ?? 0,
    computed: t.prompt_n ?? 0,
    total: body.usage?.prompt_tokens ?? (t.cache_n ?? 0) + (t.prompt_n ?? 0),
    promptMs: t.prompt_ms ?? 0
  }
}

// ── A small book, shaped like the one this app is used for ──────────────────
const CJK = '江湖夜雨十年灯，剑气如霜照旧痕。少年不识愁滋味，只把长歌当酒吞。'
const body = (seed: string, repeats: number) =>
  `<p>${seed}</p>` + Array.from({ length: repeats }, (_, i) => `<p>${i}${CJK}</p>`).join('')

const DOCS: RenderableDoc[] = [
  { id: 'outline', title: '大纲', content: body('大纲：全书结构与人物线。', 12) },
  { id: 'ch7', title: '第七章', content: body('第七章：雪夜访客。', 30) },
  { id: 'ch8', title: '第八章', content: body('第八章：山门之变。', 30) },
  { id: 'ch9', title: '第九章', content: '<p>第九章：（正在写）</p>' }
]
const TIMES = [
  { id: 'outline', updatedAt: '2026-08-17T10:00:00.000Z' },
  { id: 'ch7', updatedAt: '2026-06-01T00:00:00.000Z' },
  { id: 'ch8', updatedAt: '2026-08-16T00:00:00.000Z' },
  { id: 'ch9', updatedAt: '2026-08-17T09:00:00.000Z' }
]
const planDocs = DOCS.map(d => ({ id: d.id, chars: d.content.length, hash: hashContent(d.content) }))
const bookOrder = DOCS.map(d => d.id)
const noImages = (html: string) => html

/**
 * A value no previous run can have produced. It goes at the FRONT of the
 * system prompt, so every prompt in a test is unique and cannot be answered
 * from llama.cpp's RAM prompt cache — see the note at the top of this file.
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/** Assemble a turn exactly as useChatLLM does: system, ledger, history, tail. */
function assemble(opts: {
  nonce: string
  ledgerIds: string[]
  activeId: string
  history: LLMMessage[]
  prompt: string
  docs?: RenderableDoc[]
}): LLMMessage[] {
  const docs = opts.docs ?? DOCS
  const system: LLMMessage = {
    role: 'system',
    content: `[acceptance ${RUN_ID}/${opts.nonce}]\n` +
      buildChatSystemPrompt({ customInstructions: '', protocol: 'markup' })
  }
  const ledger = buildLedgerMessages(docs, opts.ledgerIds)
  const history = trimHistoryForContext(opts.history, { maxChars: 100_000 })
  const tail: LLMMessage = {
    role: 'user',
    content: `${buildVolatileTail(docs, opts.activeId, '', noImages)}\n\nUSER REQUEST:\n${opts.prompt}`
  }
  return [system, ...ledger, ...history, tail]
}

const HISTORY: LLMMessage[] = [
  { role: 'user', content: '按大纲把第九章开个头。' },
  { role: 'assistant', content: '好的，我先写一段雪夜的场景。' }
]

/** The ledger the writing workflow produces: outline last, by stability. */
const LEDGER_IDS = planLedgerTurn(
  EMPTY_LEDGER,
  orderAdmissionsByStability(['outline', 'ch7', 'ch8'], TIMES, bookOrder, 'ch9'),
  planDocs,
  'ch9'
).ledger.entries.map(e => e.id)

describe('acceptance: the engine reuses what we keep stable', () => {
  beforeAll(async () => {
    const res = await fetch(`${ENDPOINT}/models`).catch(() => null)
    if (!res?.ok) {
      throw new Error(
        `No model server at ${ENDPOINT}. Start one first:\n` +
        `  systemctl --user start llama-qwen38\n` +
        `  (or web_canvas/local_model/start-flash-next.sh)`
      )
    }
  })

  it('orders the ledger with the constantly-revised outline last', () => {
    expect(LEDGER_IDS).toEqual(['ch7', 'ch8', 'outline'])
  })

  it('A1: a second turn that changes only the request reuses the whole prefix', async () => {
    const nonce = 'A1'
    const first = await measure(
      assemble({ nonce, ledgerIds: LEDGER_IDS, activeId: 'ch9', history: HISTORY, prompt: '继续写下去。' })
    )
    const second = await measure(
      assemble({
        nonce,
        ledgerIds: LEDGER_IDS,
        activeId: 'ch9',
        history: [...HISTORY, { role: 'user', content: '继续写下去。' }, { role: 'assistant', content: '（上一轮的回复）' }],
        prompt: '这一段再冷一点。'
      })
    )
    console.log(
      `A1  cold ${first.cached}/${first.total} cached, ${(first.promptMs / 1000).toFixed(1)}s | ` +
      `turn2 ${second.cached}/${second.total} cached, ${(second.promptMs / 1000).toFixed(1)}s → ` +
      `${(first.promptMs / Math.max(second.promptMs, 1)).toFixed(1)}× faster`
    )

    // Nothing before the new history turn changed, so it must come from cache.
    expect(first.cached).toBeLessThan(first.total * 0.2)      // the run really was cold
    expect(second.cached).toBeGreaterThan(first.total * 0.8)
    expect(second.promptMs).toBeLessThan(first.promptMs / 3)
  })

  it('A2: reordering the same chapters destroys the cache (the bug we fixed)', async () => {
    const nonce = 'A2'
    const seeded = await measure(
      assemble({ nonce, ledgerIds: LEDGER_IDS, activeId: 'ch9', history: HISTORY, prompt: '继续。' })
    )
    // The same chapters in a different order — what score-sorted attachment
    // produced on every single turn.
    const after = await measure(
      assemble({ nonce, ledgerIds: [...LEDGER_IDS].reverse(), activeId: 'ch9', history: HISTORY, prompt: '继续。' })
    )
    console.log(
      `A2  seeded ${seeded.cached}/${seeded.total} | reordered ${after.cached}/${after.total} cached, ` +
      `${(after.promptMs / 1000).toFixed(1)}s re-prefill`
    )

    // The prefix survives only as far as the first chapter's title.
    expect(after.cached).toBeLessThan(seeded.total * 0.35)
  })

  it('A3: appending a chapter keeps everything before it cached', async () => {
    const nonce = 'A3'
    const seeded = await measure(
      assemble({ nonce, ledgerIds: ['ch7', 'ch8'], activeId: 'ch9', history: HISTORY, prompt: '继续。' })
    )
    const appended = await measure(
      assemble({ nonce, ledgerIds: ['ch7', 'ch8', 'outline'], activeId: 'ch9', history: HISTORY, prompt: '继续。' })
    )
    console.log(
      `A3  seeded ${seeded.cached}/${seeded.total} | after appending 大纲 ` +
      `${appended.cached}/${appended.total} cached`
    )

    // Everything ahead of the appended chapter is unchanged, so the engine
    // must reuse SOME of it — the architecture caps how much (see the header),
    // but appending must never look like a cold prompt.
    expect(appended.cached).toBeGreaterThan(1000)
    expect(appended.promptMs).toBeLessThan(seeded.promptMs)
  })

  it('B: making the LAST ledger chapter active costs almost nothing', async () => {
    const nonce = 'B'
    const seeded = await measure(
      assemble({ nonce, ledgerIds: LEDGER_IDS, activeId: 'ch9', history: HISTORY, prompt: '继续。' })
    )
    // Workflow B: the outline becomes the active document and leaves the
    // ledger — from the END, where nothing follows it.
    const plan = planLedgerTurn(
      { entries: LEDGER_IDS.map(id => ({ id, hash: hashContent(DOCS.find(d => d.id === id)!.content), chars: 0 })) },
      ['ch7', 'ch8', 'ch9'],
      planDocs,
      'outline'
    )
    expect(plan.ledger.entries.map(e => e.id)).toEqual(['ch7', 'ch8', 'ch9'])

    const switched = await measure(
      assemble({
        nonce,
        ledgerIds: plan.ledger.entries.map(e => e.id),
        activeId: 'outline',
        history: HISTORY,
        prompt: '把第九章的改动同步进大纲。'
      })
    )
    console.log(
      `B   seeded ${seeded.cached}/${seeded.total} | outline now active ` +
      `${switched.cached}/${switched.total} cached`
    )

    // ch7 and ch8 still lead the ledger unchanged, so the prefix is reused —
    // the point of putting the constantly-revised outline last.
    expect(switched.cached).toBeGreaterThan(1000)
    expect(switched.promptMs).toBeLessThan(seeded.promptMs)
  })

  it('C: making the FIRST ledger chapter active is the expensive case', async () => {
    const nonce = 'C'
    const seeded = await measure(
      assemble({ nonce, ledgerIds: LEDGER_IDS, activeId: 'ch9', history: HISTORY, prompt: '继续。' })
    )
    // Workflow C: back to finish ch7, which stability ordering put first.
    const jumped = await measure(
      assemble({ nonce, ledgerIds: ['ch8', 'outline'], activeId: 'ch7', history: HISTORY, prompt: '把第七章的结尾写完。' })
    )
    console.log(
      `C   seeded ${seeded.cached}/${seeded.total} | jumped back to ch7 ` +
      `${jumped.cached}/${jumped.total} cached — the documented expensive case`
    )

    // Documented, not hidden: this is the case the design admits is costly.
    expect(jumped.cached).toBeLessThan(seeded.total * 0.35)
  })
})
