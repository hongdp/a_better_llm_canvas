/**
 * `ask_user`: a question the model needs answered before it can go on — a
 * choice between two readings of the request, a destructive step the user
 * should confirm (deleting a chapter with text, restructuring the outline).
 * The turn ends with the question shown as choices under the bubble; the
 * user's answer is the next message. On a server run the run pauses instead
 * and continues with the answer (backend_authority.md §4.3).
 *
 * Modeled on Grok Build's ask_user_question (2026-10-08).
 */
import { defineTool } from '../registry'
import type { ToolResult } from '../types'

export const askUserTool = defineTool<{ question: string; options: string[] }>({
  name: 'ask_user',
  description:
    'Ask the user one question and wait for the answer. Use it only when the answer changes what you would do: the request can be read two ways, or the next step is hard to undo (deleting a chapter with text, restructuring the outline, discarding a draft). ' +
    'Never use it to ask permission for ordinary work, to confirm an obvious next step, or to announce progress. Put the choice you recommend first and end its label with "(Recommended)"; the user can also type their own answer.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, in the language of the conversation.' },
      options: { type: 'array', description: 'Two to four short choices; the recommended one first. Optional.', items: { type: 'string' } }
    },
    required: ['question']
  },
  kind: 'read',
  isAvailable: () => true,
  parse: raw => {
    const question = typeof raw?.question === 'string' ? raw.question.trim() : ''
    if (!question) return 'the question was empty'
    const options = Array.isArray(raw?.options) ? raw.options.filter((o): o is string => typeof o === 'string' && o.trim() !== '').map(o => o.trim()).slice(0, 4) : []
    return { question, options }
  },
  execute: ({ question, options }, ctx): ToolResult => {
    ctx.run.question = { question, options }
    return {
      ok: true,
      content: 'The question is shown to the user. Their answer arrives as the next message; wait for it — this turn ends here.',
      trace: `❓ asked: ${question}${options.length > 0 ? ` [${options.join(' / ')}]` : ''}`
    }
  }
})
