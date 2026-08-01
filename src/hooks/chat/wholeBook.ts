/**
 * Whole-book request flow (spec §6): the consent types, the escalation-ladder
 * planner, the Rung 2 batched map-reduce reader, and the sticky prompt-prefix
 * builder. Everything here is parameterized on what the hook owns (the
 * consent UI callback, the sticky-consent flag, the abort signal) so it can
 * live outside the hook without capturing its refs.
 */
import { useAppStore } from '../../store/useAppStore'
import { streamLLM, type LLMMessage } from '../../services/llm'
import { truncateWithNotice, htmlToPlainText } from '../../utils/llmContext'
import { packChaptersIntoBatches, WHOLE_BOOK_CONTEXT_CHARS } from '../../utils/chapterIndex'

/** A chapter carried by a whole-book plan (content already loaded). */
export interface WholeBookDoc {
  id: string
  title: string
  content: string
}

// A consented whole-book execution plan (spec §6), produced by planWholeBook
// BEFORE anything enters the chat and executed by assembleChatRequest.
export interface WholeBookPlan {
  mode: 'full' | 'fast' | 'batched'
  /** Sticky layout: book text in the stable prompt prefix (cacheable). */
  sticky: boolean
  docs: WholeBookDoc[]
  batches: WholeBookDoc[][]
  budgetChars: number
}

// Whole-book cost consent (spec §6): rendered as an inline 3-option panel in
// ChatPanel; handleSendMessage awaits the user's choice BEFORE anything
// enters the chat, so cancelling has zero side effects.
export interface WholeBookConsentRequest {
  approxTokensK: number
  chapterCount: number
  /** Total LLM calls for the batched (Rung 2) path; absent for Rung 1. */
  batchCount?: number
}
export type WholeBookConsentChoice = 'proceed' | 'fast' | 'cancel'

// ── Whole-book planning (escalation ladder, spec §6) ────────────────────────
// Plan + consent happen BEFORE anything enters the chat so 'cancelled' has
// zero side effects. 'once' resets after the send; 'sticky' persists and
// consents only on its first send. `stickyConsentGiven` is the hook's mutable
// flag for that: it resets whenever a send happens with the mode off.
export async function planWholeBook(
  requestConsent: (req: WholeBookConsentRequest) => Promise<WholeBookConsentChoice>,
  stickyConsentGiven: { current: boolean }
): Promise<WholeBookPlan | null | 'cancelled'> {
  const s = useAppStore.getState()
  const wholeBookMode = s.documents.length > 1 ? s.wholeBookMode : 'off'
  if (s.wholeBookMode === 'once') s.setWholeBookMode('off')

  if (wholeBookMode === 'off') {
    stickyConsentGiven.current = false
    return null
  }

  // Whole-book explicitly asks for every chapter — fetch any content the
  // server hasn't lazily sent yet, otherwise chapters the user never opened
  // would be silently missing from "the whole book".
  await s.ensureDocumentContents(
    s.documents.filter(d => d.id !== s.activeDocumentId).map(d => d.id)
  )
  const loaded = useAppStore.getState()
  const docs = loaded.documents.filter(d =>
    d.id !== loaded.activeDocumentId && d.contentLoaded !== false && d.content.length > 0
  )
  const totalChars = docs.reduce((sum, d) => sum + d.content.length, 0)
  const budgetChars = WHOLE_BOOK_CONTEXT_CHARS[s.activeProvider] ?? 300_000
  const approxTokensK = Math.max(1, Math.round(totalChars / 4000))
  // Rung 1 confirms above ~50k tokens; Rung 2 (multi-call) always confirms.
  const CONFIRM_THRESHOLD_CHARS = 200_000
  // Sticky only changes the layout when the book fits in one call —
  // re-running a batched pass every turn would multiply cost, so an
  // over-budget book behaves like 'once' even when sticky.
  const sticky = wholeBookMode === 'sticky' && totalChars <= budgetChars

  if (totalChars <= budgetChars) {
    let mode: 'full' | 'fast' = 'full'
    const needsConsent = totalChars > CONFIRM_THRESHOLD_CHARS &&
      !(sticky && stickyConsentGiven.current)
    if (needsConsent) {
      const choice = await requestConsent({ approxTokensK, chapterCount: docs.length })
      if (choice === 'cancel') return 'cancelled'
      mode = choice === 'proceed' ? 'full' : 'fast'
      if (sticky && choice === 'proceed') stickyConsentGiven.current = true
    }
    return { mode, sticky, docs, batches: [], budgetChars }
  }

  const batches = packChaptersIntoBatches(docs, budgetChars)
  const choice = await requestConsent({
    approxTokensK,
    chapterCount: docs.length,
    batchCount: batches.length + 1
  })
  if (choice === 'cancel') return 'cancelled'
  return { mode: choice === 'proceed' ? 'batched' : 'fast', sticky: false, docs, batches, budgetChars }
}

// Whole-book Rung 2: client-orchestrated map-reduce. Reads the book in
// book-order batches, carrying a running-notes scratchpad between rounds;
// the caller feeds the final notes into a normal request. Rounds are
// transient (only the status bubble is visible; nothing enters history).
// The abort signal is owned by the calling hook (the same controller that
// governs the main stream, so Stop cancels the batch loop too).
// Returns the notes, or null when aborted/failed.
export async function runWholeBookBatches(
  promptText: string,
  batches: WholeBookDoc[][],
  assistantMsgId: string,
  perBatchChars: number,
  signal: AbortSignal
): Promise<string | null> {
  const s = useAppStore.getState()

  const setStatus = (text: string) => {
    useAppStore.setState((state) => ({
      messages: state.messages.map(m => m.id === assistantMsgId ? { ...m, content: text } : m)
    }))
  }

  let notes = ''
  for (let i = 0; i < batches.length; i++) {
    if (signal.aborted) return null
    const batch = batches[i]
    const label = batch.length === 1
      ? `"${batch[0].title}"`
      : `"${batch[0].title}" – "${batch[batch.length - 1].title}"`
    setStatus(`📚 Reading ${label} (batch ${i + 1}/${batches.length})…`)

    const batchText = batch
      .map(doc => `--- DOCUMENT: ${doc.title} ---\n${truncateWithNotice(htmlToPlainText(doc.content), perBatchChars)}`)
      .join('\n\n')
    const messages: LLMMessage[] = [
      {
        role: 'system',
        content: 'You are analyzing a book chapter-by-chapter in batches to complete the user\'s task. Each round you receive your running notes and a new batch of chapters. Update and extend the notes with everything from this batch that matters for the task (structure, plot, entities, facts, quotes). Output ONLY the updated complete notes as plain text. Do NOT produce the final answer yet.'
      },
      {
        role: 'user',
        content: `TASK (do not answer yet — only update notes):\n${promptText}\n\nRUNNING NOTES (from previous batches):\n${notes || '(none yet — this is the first batch)'}\n\nNEW CHAPTERS (batch ${i + 1} of ${batches.length}):\n${batchText}`
      }
    ]

    const batchResult = await new Promise<string | null>((resolve) => {
      streamLLM(
        messages,
        { ...s.providerConfigs[s.activeProvider], provider: s.activeProvider, debug: s.debugMode, signal, conversationId: s.activeBookId },
        {
          onChunk: () => {},
          onDone: (fullText, usage) => {
            useAppStore.getState().addSessionTokens(
              usage?.promptTokens ?? Math.ceil(JSON.stringify(messages).length / 4),
              usage?.completionTokens ?? Math.ceil(fullText.length / 4),
              usage?.cachedPromptTokens ?? 0
            )
            resolve(fullText.trim() || null)
          },
          onError: (err) => {
            const isAbort = err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('cancel')
            if (!isAbort) {
              console.error(`[WholeBook] batch ${i + 1}/${batches.length} failed:`, err.message)
            }
            resolve(null)
          }
        }
      )
    })

    if (batchResult === null) {
      // Abort or failure: bail out; the caller reports to the user.
      return null
    }
    notes = batchResult
  }
  return notes
}

// Sticky whole-book prompt layout: the (unchanging) book text moves into the
// stable prompt prefix — right after the system prompt, before history — with
// its own cache breakpoint, so turns 2+ read it at cache prices. The volatile
// tail (index + active doc) stays in the final user message.
export function buildStickyBookPrefix(docs: WholeBookDoc[]): LLMMessage[] {
  const bookText = docs
    .map(d => `--- DOCUMENT: ${d.title} ---\n${htmlToPlainText(d.content)}`)
    .join('\n\n')
  return [
    {
      role: 'user',
      content: `REFERENCED BOOK CONTENT (read-only; every chapter except the active document — use it for details and consistency):\n\n${bookText}`,
      cacheHint: true
    },
    // Providers require alternating roles; the ack keeps history's
    // leading user turn valid after the injected user message.
    { role: 'assistant', content: 'Understood. I have read the full book content and will use it as reference.' }
  ]
}
