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
import type { LLMMessage } from '../types/llm'
import type { FinishedToolCall } from '../utils/toolCallStream'
import type { DocumentUpdateFailure } from '../utils/text'
import { NO_ACTION_RETRY_INSTRUCTION } from '../hooks/chat/streamHandlers'
import { collectStep, planWrites, type CollectedStep } from './invocations'
import { decideAfterStep, detectStepFailure, stepsLeft, type ExecutedCall, type RunBudgets, type StepDecision, type StepPolicy } from './policy'
import type { RegisteredTool, ToolRegistry } from './registry'
import type { ToolContext, ToolInvocation, ToolKind, ToolResult, WriteEffects } from './types'

/** What one streamed model call produced. */
export interface StepOutput {
  text: string
  nativeCalls: FinishedToolCall[]
}

/** Streams one step. Must end in `run.stepDone(...)` or the caller's error path. */
export type StepDriver = (messages: LLMMessage[], stepIndex: number) => Promise<void>

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
  steps: number
}

export interface RunObserver {
  /** A protocol failure is being retried with a corrective instruction. */
  onCorrective(failure: DocumentUpdateFailure, attempt: number, max: number): void
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
    return this.o.driver(this.messages, this.stepsTaken)
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
    return this.o.registry.available(this.o.ctx, t => this.o.writeProtocol === 'tools' || t.kind !== 'write')
  }

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

    const writes = collected.invocations.filter(inv => this.kindOf(inv) === 'write')
    const { run: plannedWrites, dropped } = planWrites(writes)
    const toRun = [...collected.invocations.filter(inv => this.kindOf(inv) !== 'write'), ...plannedWrites]
    this.stray += collected.strayMarkup + dropped
    if (collected.chatText.trim()) this.chatTexts.push(collected.chatText.trim())

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
      return { ok: false, content: `There is no tool named "${inv.name}".`, trace: `${inv.name}: unknown tool` }
    }
    const fail = (e: unknown): ToolResult => ({
      ok: false,
      content: `${inv.name} failed: ${e instanceof Error ? e.message : String(e)}`,
      trace: `${inv.name}: error`
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
      void this.o.driver(this.messages, this.stepsTaken)
      return
    }
    if (collected.chatText.trim()) this.chatTexts.push(collected.chatText.trim())
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
      const e = result.effects
      if (!e) continue
      if (e.canvasIssue && !this.effects.canvasIssue) this.effects.canvasIssue = e.canvasIssue
      this.effects.failedEdits += e.failedEdits ?? 0
      this.effects.reinsertedImages += e.reinsertedImages ?? 0
      this.effects.selectionGone ||= !!e.selectionGone
      this.effects.producedNothing ||= !!e.producedNothing
    }

    const decision = decideAfterStep({
      executed,
      stepsTaken: this.stepsTaken,
      correctiveUsed: this.correctiveUsed,
      budgets: this.o.budgets,
      policy: this.o.policy
    })

    if (decision.action === 'continue' && this.o.canContinue && !this.cancelled) {
      if (decision.corrective) this.correctiveUsed++
      this.messages = [...this.messages, ...this.resultMessages(out, ran, results)]
      void this.o.driver(this.messages, this.stepsTaken)
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
            argumentsText: inv.argumentsText ?? JSON.stringify(inv.args ?? {})
          }))
        : undefined
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

  private finish(end: Pick<RunSummary, 'failedUpdate' | 'exhaustedCorrective' | 'unretriableFailedUpdate' | 'endReason'>): void {
    if (this.finished) return
    this.finished = true
    this.o.observer.onFinish({
      chatText: this.chatTexts.join('\n\n'),
      strayMarkup: this.stray,
      effects: this.effects,
      trace: this.trace,
      steps: this.stepsTaken,
      ...end
    })
  }
}
