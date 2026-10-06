/**
 * polish_chapter: the polish pass (agentic_chat_loop.md D9) as a tool the
 * model calls ONLY when the user asks for it in the conversation. The same
 * pass runs from the Polish button without the chat model at all.
 */
import { defineTool } from '../registry'
import { citeChapter } from '../chapters'
import type { ToolResult } from '../types'
import { commitDoc, docState, editedMeanwhile, resolveTarget, touch, userEdited, withLoaded } from './documentWrites'

export const polishChapterTool = defineTool<{ chapter: unknown }>({
  name: 'polish_chapter',
  description:
    'Polish a chapter\'s prose: rewrite choppy narration into fuller sentences, chunk by chunk, with a separate polish model; every line of dialogue is kept, and a chunk that fails the checks keeps its draft. ' +
    'Call this ONLY when the user explicitly asks to polish (润色) a chapter — never on your own initiative, and never right after writing a chapter unless asked.',
  parameters: {
    type: 'object',
    properties: {
      chapter: { type: 'string', description: 'Optional. Its number in the CHAPTER INDEX or its exact title; omit for the active chapter.' }
    }
  },
  kind: 'write',
  isAvailable: ctx => ctx.polish !== undefined,
  parse: raw => ({ chapter: raw?.chapter }),
  execute: ({ chapter }, ctx): ToolResult | Promise<ToolResult> => {
    const target = resolveTarget(chapter, ctx)
    if (typeof target === 'string') return { ok: false, retryable: true, content: target, trace: `⚠️ polish: ${target.split('\n')[0]}` }
    const polish = ctx.polish
    if (!polish) return { ok: false, retryable: false, content: 'No polish model is configured.', trace: '⚠️ polish: not configured' }

    return withLoaded(ctx, target, async () => {
      if (userEdited(ctx, target.id)) return editedMeanwhile(ctx, target)
      const st = docState(ctx, target)
      // A polish takes 26–53 s; the chapter is locked for the user meanwhile,
      // so the rewrite cannot land over their edit. Other chapters stay open.
      ctx.ui.writing(target.id)
      let outcome
      try {
        outcome = await polish.run(ctx.images.preserve(st.html), (done, total) => {
          ctx.ui.progress(`✨ polishing ${citeChapter(target)} … ${done}/${total}`)
        })
      } finally {
        ctx.ui.writing(null)
      }
      ctx.ui.progress(null)
      // Locked, but the stored content could still have moved (a review
      // button pressed just before the lock): never write over it.
      if (userEdited(ctx, target.id)) {
        return { ...editedMeanwhile(ctx, target), retryable: false, content: `The user edited ${citeChapter(target)} while it was being polished, so the polish was discarded. Tell the user; polish it again only if they ask.` }
      }
      if (outcome.polished > 0) {
        st.html = ctx.images.restore(outcome.html)
        st.dirty = true
        commitDoc(ctx, target, st)
        // Its text is not what the model last saw: an edit must read it first.
        ctx.run.htmlShown.delete(target.id)
      }
      touch(ctx, target, 'polished', outcome.polished, outcome.chunks - outcome.polished)
      const summary = `${outcome.polished} of ${outcome.chunks} chunk(s) rewritten`
      return {
        ok: outcome.polished > 0,
        retryable: false,
        content: `Polished ${citeChapter(target)}: ${summary}.` +
          (outcome.kept.length ? ` Kept as drafted — ${outcome.kept.join('; ')}.` : '') +
          (outcome.polished > 0 ? ' Its text changed: read it again (format "html") before editing it.' : ''),
        trace: `✨ polished ${citeChapter(target)} (${summary})`
      }
    })
  }
})
