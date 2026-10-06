/**
 * One turn as a run of steps (spec §5.4).
 *
 * The controller is callback-driven, not a promise loop, on purpose: a step
 * completes inside the transport's onDone, and the next step (or the end of
 * the run) is decided synchronously right there whenever the step's tools are
 * synchronous — which the document writes are. That keeps the turn's ordering
 * identical to the single-shot path it replaced, and the hook flow tests
 * (which settle a turn in a couple of microtask flushes) prove it.
 *
 * What a run never does is rebuild an earlier message (D4): each step appends
 * to the list the previous step sent, so every follow-up step is a pure
 * prefix-cache hit on grok.
 */
import type { LLMMessage, ThinkingBlock } from '../types/llm'
import type { FinishedToolCall } from '../utils/toolCallStream'
import type { DocumentUpdateFailure } from '../utils/text'
import { NO_ACTION_RETRY_INSTRUCTION } from '../hooks/chat/streamHandlers'
import { collectStep, planWrites, type CollectedStep } from './invocations'
import { decideAfterStep, detectStepFailure, stepsLeft, type ExecutedCall, type RunBudgets, type StepDecision, type StepPolicy } from './policy'
import type { RegisteredTool, ToolRegistry } from './registry'
import type { ToolContext, ToolInvocation, ToolKind, ToolResult, WriteEffects } from './types'
import type { AgentTimelineItem, AgentTouchedChapter } from '../types/chat'

/** What one streamed model call produced. */
export interface StepOutput {
  text: string
  nativeCalls: FinishedToolCall[]
  /**
   * Anthropic reasoning blocks of this step, verbatim. Replayed ahead of the
   * step's tool calls: with extended thinking on, a tool-use turn sent back
   * without them is rejected.
   */
  thinking?: ThinkingBlock[]
}

/**
 * Streams one step. Must end in `run.stepDone(...)` or the caller's error path.
 * `final`: the last step the budget allows — send it with tool calls disabled
 * (`tool_choice: "none"`) so the turn ends in an answer.
 */
export type StepDriver = (messages: LLMMessage[], stepIndex: number, opts: { final: boolean }) => Promise<void>

/** Sent with the final step when the budget, not the model, ends the run. */
export const STEP_LIMIT_NOTE =
  'This turn has used its step budget. Do not call any more tools: answer the user now with what you have, and say what is left undone.'

export interface RunSummary {
  /** Chat text of every step that counted, joined — what the bubble shows. */
  chatText: string
  strayMarkup: number
  effects: Required<Omit<WriteEffects, 'canvasIssue'>> & { canvasIssue: NonNullable<WriteEffects['canvasIssue']> | null }
  /** The final step failed the markup protocol and was not (or no longer) retried. */
  failedUpdate: DocumentUpdateFailure | null
  /** …because the corrective budget ran out. */
  exhaustedCorrective: boolean
  /** …because there was no request to retry (a rejoined stream). */
  unretriableFailedUpdate: boolean
  endReason: Extract<StepDecision, { action: 'end' }>['reason'] | 'protocol_failure' | 'cancelled'
  /** One line per executed call, in order. */
  trace: string[]
  /** Each step's text, then the calls it made, in order. */
  timeline: AgentTimelineItem[]
  steps: number
  /** Chapters this run wrote, for the bubble's "changed this turn" block. */
  touched: AgentTouchedChapter[]
  /** Chapters this run read — the next turn's continuity signal. */
  readIds: string[]
}

/** What the bubble shows while a run is still going. */
export interface RunProgress {
  /** Chat text of the finished steps, joined. */
  chatText: string
  /** The finished steps in order: each one's text, then the calls it made. */
  timeline: AgentTimelineItem[]
  steps: number
  trace: string[]
  touched: AgentTouchedChapter[]
}

export interface RunObserver {
  /** A protocol failure is being retried with a corrective instruction. */
  onCorrective(failure: DocumentUpdateFailure, attempt: number, max: number): void
  /** A step's calls ran and the run continues; show what it did so far. */
  onStepExecuted?(progress: RunProgress): void
  /** The run is over; render the bubble and settle the editor. */
  onFinish(summary: RunSummary): void
}

export interface AgentRunOptions {
  registry: ToolRegistry
  ctx: ToolContext
  /** How this model expresses WRITES (utils/protocolChoice); reads are always native. */
  writeProtocol: 'tools' | 'markup'
  driver: StepDriver
  observer: RunObserver
  budgets: RunBudgets
  policy: StepPolicy
  /** False when there is no request to re-issue (a rejoined stream). */
  canContinue: boolean
  /** Offer the read/navigate tools (`ProviderConfig.agentTools`). Default on. */
  agentTools?: boolean
  initialMessages: LLMMessage[]
}

const UNKNOWN_TOOL_KIND: ToolKind = 'read'

/** Run `fn` over `items` in order; synchronous until the first promise. */
function runSequential<T, R>(items: T[], fn: (item: T) => R | Promise<R>): R[] | Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i++) {
    const r = fn(items[i])
    if (r instanceof Promise) {
      return (async () => {
        out.push(await r)
        for (let j = i + 1; j < items.length; j++) out.push(await fn(items[j]))
        return out
      })()
    }
    out.push(r)
  }
  return out
}

export class AgentRun {
  private messages: LLMMessage[]
  private stepsTaken = 0
  private correctiveUsed = 0
  private cancelled = false
  private finished = false
  private readonly chatTexts: string[] = []
  private readonly timeline: AgentTimelineItem[] = []
  private readonly trace: string[] = []
  private stray = 0
  private readonly effects: RunSummary['effects'] = {
    canvasIssue: null, failedEdits: 0, reinsertedImages: 0, selectionGone: false, producedNothing: false
  }

  private readonly o: AgentRunOptions

  constructor(options: AgentRunOptions) {
    this.o = options
    this.messages = options.initialMessages
  }

  /** Stream the first step. Resolves when that stream returns, not when the run ends. */
  start(): Promise<void> {
    return this.o.driver(this.messages, this.stepsTaken, { final: stepsLeft(this.o.budgets, 0) === 1 })
  }

  /** Stop starting steps (the user pressed Stop). The step in flight is the caller's to abort. */
  cancel(): void {
    this.cancelled = true
  }

  /**
   * The tools this step offers natively. On the markup protocol writes are
   * tags, so only non-write tools are sent (the hybrid, D1) — offering a
   * write both ways invites the model to mix them.
   */
  offeredTools(): RegisteredTool[] {
    // Decided once per run, at the first step. The tools array is part of
    // every request; one that changes between steps (a selection that moved,
    // say) breaks the provider's cached prefix and can orphan earlier calls.
    // Codex keeps its tools array fixed for the same reason.
    // On markup, tools with a tag form are written as tags (D1); everything
    // else is offered natively. With the agent tools off, only the tag-form
    // writes remain — the pre-loop turn.
    this.offered ??= this.o.registry.available(this.o.ctx, t =>
      (this.o.writeProtocol === 'tools' || !t.markupForm) &&
      (this.o.agentTools !== false || !!t.markupForm))
    return this.offered
  }

  private offered: RegisteredTool[] | undefined

  /** The transport finished a step. Synchronous whenever the step's tools are. */
  stepDone(out: StepOutput): void {
    if (this.finished) return
    this.stepsTaken++
    const collected = collectStep(out.text, out.nativeCalls, this.o.registry, this.stepsTaken - 1)

    const failure = detectStepFailure({
      text: out.text,
      writeProtocol: this.o.writeProtocol,
      hadNativeCalls: out.nativeCalls.length > 0,
      markupKind: collected.markupKind
    })
    if (failure) {
      this.handleProtocolFailure(failure, out.text, collected)
      return
    }

    this.o.ctx.run.step = this.stepsTaken - 1
    const writes = collected.invocations.filter(inv => this.kindOf(inv) === 'write')
    const { run: plannedWrites, dropped } = planWrites(writes)
    const toRun = [...collected.invocations.filter(inv => this.kindOf(inv) !== 'write'), ...plannedWrites]
    this.stray += collected.strayMarkup + dropped
    if (collected.chatText.trim()) {
      this.chatTexts.push(collected.chatText.trim())
      this.timeline.push({ type: 'text', text: collected.chatText.trim() })
    }

    const results = runSequential(toRun, inv => this.invoke(inv))
    if (results instanceof Promise) {
      void results.then(r => this.afterExecute(out, toRun, r))
    } else {
      this.afterExecute(out, toRun, results)
    }
  }

  private kindOf(inv: ToolInvocation): ToolKind {
    return this.o.registry.get(inv.name)?.kind ?? UNKNOWN_TOOL_KIND
  }

  private invoke(inv: ToolInvocation): ToolResult | Promise<ToolResult> {
    const tool = this.o.registry.get(inv.name)
    if (!tool) {
      // A native call must be answered even when it names nothing we have,
      // or the provider rejects the next request for the unanswered id.
      return { ok: false, content: `There is no tool named "${inv.name}".`, trace: `⚠️ unknown tool "${inv.name}"` }
    }
    const fail = (e: unknown): ToolResult => ({
      ok: false,
      content: `${inv.name} failed: ${e instanceof Error ? e.message : String(e)}`,
      trace: `⚠️ ${inv.name} failed`
    })
    try {
      const r = tool.invoke(inv, this.o.ctx)
      return r instanceof Promise ? r.catch(fail) : r
    } catch (e) {
      return fail(e)
    }
  }

  private handleProtocolFailure(failure: DocumentUpdateFailure, text: string, collected: CollectedStep): void {
    const canCorrect =
      this.o.canContinue &&
      !this.cancelled &&
      this.correctiveUsed < this.o.budgets.maxCorrective &&
      stepsLeft(this.o.budgets, this.stepsTaken) > 0
    if (canCorrect) {
      this.correctiveUsed++
      this.o.observer.onCorrective(failure, this.correctiveUsed, this.o.budgets.maxCorrective)
      // The failed reply is quoted back, then the correction: append-only.
      this.messages = [
        ...this.messages,
        { role: 'assistant', content: text },
        { role: 'user', content: NO_ACTION_RETRY_INSTRUCTION }
      ]
      void this.o.driver(this.messages, this.stepsTaken, { final: stepsLeft(this.o.budgets, this.stepsTaken) === 1 })
      return
    }
    if (collected.chatText.trim()) {
      this.chatTexts.push(collected.chatText.trim())
      this.timeline.push({ type: 'text', text: collected.chatText.trim() })
    }
    this.stray += collected.strayMarkup
    this.finish({
      failedUpdate: failure,
      exhaustedCorrective: this.o.canContinue,
      unretriableFailedUpdate: !this.o.canContinue && (failure === 'malformed' || failure === 'claimed'),
      endReason: this.cancelled ? 'cancelled' : 'protocol_failure'
    })
  }

  private afterExecute(out: StepOutput, ran: ToolInvocation[], results: ToolResult[]): void {
    if (this.finished) return
    const executed: ExecutedCall[] = ran.map((inv, i) => ({ kind: this.kindOf(inv), result: results[i] }))
    for (const { result } of executed) {
      this.trace.push(result.trace)
      this.timeline.push({ type: 'tool', line: result.trace, ok: result.ok })
    }

    const decision = decideAfterStep({
      executed,
      stepsTaken: this.stepsTaken,
      correctiveUsed: this.correctiveUsed,
      budgets: this.o.budgets,
      policy: this.o.policy
    })
    const continuing = decision.action === 'continue' && this.o.canContinue && !this.cancelled

    // A failure handed back to the model is the model's to fix; reporting it
    // in the bubble as well would warn about an edit the next step corrects.
    // What cannot be retried (a cut-off rewrite, a vanished selection) is
    // reported whatever happens next.
    const handedBack = continuing && decision.corrective
    for (const { result } of executed) {
      const e = result.effects
      if (!e) continue
      if (e.canvasIssue && !this.effects.canvasIssue) this.effects.canvasIssue = e.canvasIssue
      this.effects.reinsertedImages += e.reinsertedImages ?? 0
      this.effects.selectionGone ||= !!e.selectionGone
      if (handedBack && (result.retryable ?? !result.ok)) continue
      this.effects.failedEdits += e.failedEdits ?? 0
      this.effects.producedNothing ||= !!e.producedNothing
    }

    if (continuing && decision.action === 'continue') {
      if (decision.corrective) this.correctiveUsed++
      this.messages = [...this.messages, ...this.resultMessages(out, ran, results)]
      if (decision.final) this.messages = [...this.messages, { role: 'user', content: STEP_LIMIT_NOTE }]
      this.o.observer.onStepExecuted?.(this.progress())
      void this.o.driver(this.messages, this.stepsTaken, { final: decision.final })
      return
    }

    this.finish({
      failedUpdate: null,
      exhaustedCorrective: false,
      unretriableFailedUpdate: false,
      endReason: this.cancelled
        ? 'cancelled'
        : decision.action === 'end' ? decision.reason : 'step_limit'
    })
  }

  /**
   * The step's reply and what its calls returned, as the next step's input.
   *
   * Native calls are answered with `tool` messages under their ids — the
   * argument bytes replayed exactly as received. Markup writes have no id to
   * answer, so their outcomes go in one user message after the results.
   */
  private resultMessages(out: StepOutput, ran: ToolInvocation[], results: ToolResult[]): LLMMessage[] {
    const native = ran
      .map((inv, i) => ({ inv, result: results[i] }))
      .filter(({ inv }) => inv.source === 'native')
    const markup = ran
      .map((inv, i) => ({ inv, result: results[i] }))
      .filter(({ inv }) => inv.source === 'markup')

    const messages: LLMMessage[] = [{
      role: 'assistant',
      content: out.text,
      toolCalls: native.length > 0
        ? native.map(({ inv }) => ({
            id: inv.id,
            name: inv.name,
            argumentsText: inv.argumentsText ?? JSON.stringify(inv.args ?? {}),
            // Gemini's thoughtSignature, returned beside the call it came with.
            ...(inv.signature ? { signature: inv.signature } : {})
          }))
        : undefined,
      ...(out.thinking?.length ? { thinking: out.thinking } : {})
    }]
    for (const { inv, result } of native) {
      messages.push({ role: 'tool', toolCallId: inv.id, name: inv.name, content: result.content })
    }
    if (markup.length > 0) {
      messages.push({
        role: 'user',
        content: 'RESULT OF YOUR DOCUMENT CHANGES:\n' + markup.map(({ inv, result }) => `- ${inv.name}: ${result.content}`).join('\n')
      })
    }
    return messages
  }

  private progress(): RunProgress {
    return {
      chatText: this.chatTexts.join('\n\n'),
      timeline: [...this.timeline],
      steps: this.stepsTaken,
      trace: [...this.trace],
      touched: [...this.o.ctx.run.touched.values()]
    }
  }

  private finish(end: Pick<RunSummary, 'failedUpdate' | 'exhaustedCorrective' | 'unretriableFailedUpdate' | 'endReason'>): void {
    if (this.finished) return
    this.finished = true
    this.o.observer.onFinish({
      strayMarkup: this.stray,
      effects: this.effects,
      ...this.progress(),
      readIds: [...this.o.ctx.run.readIds],
      ...end
    })
  }
}
