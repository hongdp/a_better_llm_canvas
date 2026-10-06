/**
 * Polish pass, the engine (agentic_chat_loop.md D9): every chunk of a chapter
 * rewritten in parallel by the polish model, each one validated, a failure
 * keeping its draft.
 *
 * Run only when the user asks — the Polish button, or a chat request the
 * model answers with `polish_chapter` (user decision, 2026-10-05). Parallel
 * because it has to be: 25.6 s per chunk measured, about five chunks a
 * chapter, so 26–53 s in parallel against over two minutes in sequence.
 */
import {
  assemblePolished,
  buildPolishPrompt,
  parsePolished,
  splitForPolish,
  validatePolished,
  type PolishPrompt
} from '../utils/polish'

/**
 * The polish model when none is set. grok: the model the polish pass was
 * measured with; elsewhere the chat model itself (unmeasured).
 */
export function defaultPolishModel(provider: string, chatModel: string): string {
  return provider === 'grok' ? 'grok-4.20-0309-reasoning' : chatModel
}

/** One model call: system + user in, the reply text out. Rejects on abort. */
export type PolishTransport = (system: string, user: string, signal?: AbortSignal) => Promise<string>

export interface PolishOutcome {
  html: string
  chunks: number
  /** Chunks whose rewrite passed and was used. */
  polished: number
  /** Why each other chunk kept its draft ("chunk 3: dialogue changed"). */
  kept: string[]
  /** The run was stopped; unfinished chunks kept their drafts. */
  stopped: boolean
}

export async function polishHtml(
  html: string,
  opts: {
    transport: PolishTransport
    prompt: PolishPrompt
    /** The user's writing preset, appended to the polish system prompt. */
    writingPreset?: string
    signal?: AbortSignal
    onProgress?: (done: number, total: number) => void
  }
): Promise<PolishOutcome> {
  const segments = splitForPolish(html)
  const chunks = segments.flatMap(s => (s.kind === 'chunk' ? [s.paras] : []))
  const system = opts.writingPreset?.trim()
    ? `${opts.prompt.system}\n\n${opts.writingPreset.trim()}`
    : opts.prompt.system
  let done = 0
  opts.onProgress?.(0, chunks.length)

  const results = await Promise.all(chunks.map(async (chunk, i) => {
    try {
      const reply = await opts.transport(system, buildPolishPrompt(opts.prompt.template, chunk, chunks[i - 1] ?? null), opts.signal)
      const rewrite = parsePolished(reply)
      const check = validatePolished(chunk, rewrite)
      return check.ok ? { rewrite, why: null } : { rewrite: null, why: check.reasons.join(', ') }
    } catch (e) {
      return { rewrite: null, why: opts.signal?.aborted ? 'stopped' : `failed: ${e instanceof Error ? e.message : String(e)}` }
    } finally {
      opts.onProgress?.(++done, chunks.length)
    }
  }))

  return {
    html: assemblePolished(segments, results.map(r => r.rewrite)),
    chunks: chunks.length,
    polished: results.filter(r => r.rewrite).length,
    kept: results.flatMap((r, i) => (r.why ? [`chunk ${i + 1}: ${r.why}`] : [])),
    stopped: !!opts.signal?.aborted
  }
}
