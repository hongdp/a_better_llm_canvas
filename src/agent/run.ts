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
import type { LLMMessage, StreamUsage, ThinkingBlock } from '../types/llm'
import { callSignature, type FinishedToolCall } from '../utils/toolCallStream'
import type { PlanItem } from '../utils/plan'
import { unfinishedPlanItems } from '../utils/plan'
import { appendReminders, htmlReadNudge, longReasoningReminder, lookupStreakNudge, planReminder, planUnfinishedNudge, repeatNudge, steerMessage, unbackedClaimNudge, LOOKUP_NUDGE_STEPS, PLAN_NUDGE_BUDGET, REPEAT_NUDGE_STEPS, wrapReminder } from './reminders'
import { claimsOwnWrite, isBlankContent, type DocumentUpdateFailure } from '../utils/text'
import { NO_ACTION_RETRY_INSTRUCTION } from '../hooks/chat/streamHandlers'
import { collectStep, planWrites, type CollectedStep } from './invocations'
import { elisionTrace, planElisions, type ElidableResult, type MeasuredPrompt } from './runCompaction'
import { decideAfterStep, detectStepFailure, stepsLeft, type ExecutedCall, type RunBudgets, type StepDecision, type StepPolicy } from './policy'
import type { RegisteredTool, ToolRegistry } from './registry'
import { seenChapters, writesSoFar, type AskedQuestion, type SeenChapter, type ToolContext, type ToolInvocation, type ToolKind, type ToolResult, type WriteEffects } from './types'
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
  /**
   * grok's output items of this step (xAI Responses API), verbatim: the
   * reasoning ciphertext the next step sends back so the model keeps its
   * plan (LLMMessage.responseItems).
   */
  responseItems?: unknown[]
  /** What the step cost, when the transport reported it. */
  usage?: StreamUsage
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
  endReason: Extract<StepDecision, { action: 'end' }>['reason'] | 'protocol_failure' | 'cancelled' | 'asked'
  /** The run ended with a question for the user (`ask_user`); the next message answers it. */
  question: AskedQuestion | null
  /** One line per executed call, in order. */
  trace: string[]
  /** Each step's text, then the calls it made, in order. */
  timeline: AgentTimelineItem[]
  steps: number
  /** Chapters this run wrote, for the bubble's "changed this turn" block. */
  touched: AgentTouchedChapter[]
  /** Chapters this run read — the next turn's continuity signal. */
  readIds: string[]
  /** The model's checklist for the turn, as it ended. */
  plan: PlanItem[]
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
  /** What the model has seen so far (a reload restores it). */
  seen: SeenChapter[]
  /** The model's checklist for the turn, as it stands. */
  plan: PlanItem[]
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
  /**
   * Hidden reasoning tokens in one step that wrote nothing, past which the
   * step after next is told to act instead of think (agent/reminders).
   * 0 or absent = off.
   */
  longReasoningTokens?: number
  /** Extra reminders the host has for the model, collected after each step's calls ran. */
  reminders?: () => string[]
  /**
   * The prompt tokens a step may use (the host's target for the model's
   * window, less the output). Past ELIDE_ABOVE of it, the oldest read results
   * are elided before the next step (agent/runCompaction). Absent = never.
   */
  promptTokenLimit?: number
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
  /** A write succeeded in this run (see detectStepFailure's wroteThisRun). */
  private wrote = false
  /** Document blocks the current step's reply lost (stray markup, dropped writes). */
  private stepDropped = 0
  private readonly effects: RunSummary['effects'] = {
    canvasIssue: null, failedEdits: 0, reinsertedImages: 0, selectionGone: false, producedNothing: false
  }
  /** Each step's calls (as one sorted signature) and whether it wrote, for the repeat nudge. */
  private readonly stepLog: Array<{ signature: string; names: string[]; wrote: boolean }> = []
  /** A step past the reasoning threshold: the reminder is due when this step count is reached (one step later). */
  private longReasoningDue: { atStep: number; tokens: number } | null = null
  private planNudges = 0
  /** The trace of the last HTML read that no write has followed yet (the step before an edit). */
  private htmlReadPending: string | null = null
  private htmlReadNudged = false
  /** A reply claimed a write the run never made: told once per run. */
  private claimNudged = false
  /** The look-up streak reminder was given (once per run). */
  private lookupNudged = false
  /** Messages the user sent while the run was working; the next step carries them (steer). */
  private readonly pendingSteers: string[] = []
  /** Read results in the messages that may be elided when the prompt outgrows the window. */
  private elidable: ElidableResult[] = []
  /** Where the latest step's results start in the messages: never elided. */
  private lastResultsStart = 0
  /** The last step's real prompt size and the messages it covered (calibrates the elision check). */
  private measured: MeasuredPrompt | null = null

  private readonly o: AgentRunOptions

  constructor(options: AgentRunOptions) {
    this.o = options
    this.messages = options.initialMessages
    options.ctx.run.writeProtocol = options.writeProtocol
    options.ctx.run.continuesAfterWrites = options.policy.continueAfterWrites
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
   * A message the user sent mid-turn (agentic_chat_loop.md §0.8). It is
   * appended as a user message once the step in flight has finished — after
   * its results, or after a reply that would otherwise have ended the turn.
   */
  steer(text: string): void {
    if (text.trim()) this.pendingSteers.push(text)
  }

  /** The pending steers as one user message, cleared. */
  private takeSteer(): string | null {
    if (this.pendingSteers.length === 0) return null
    const text = this.pendingSteers.join('\n\n')
    this.pendingSteers.length = 0
    return steerMessage(text)
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
      (this.o.writeProtocol === 'tools' || !t.markupForm || (!!t.nativeOnMarkup && this.o.agentTools !== false)) &&
      (this.o.agentTools !== false || !!t.markupForm))
    return this.offered
  }

  private offered: RegisteredTool[] | undefined

  /** The transport finished a step. Synchronous whenever the step's tools are. */
  stepDone(out: StepOutput): void {
    if (this.finished) return
    // What this step was sent is `this.messages`, untouched until its results are appended.
    if (out.usage?.promptTokens) this.measured = { tokens: out.usage.promptTokens, length: this.messages.length }
    this.stepsTaken++
    const collected = collectStep(out.text, out.nativeCalls, this.o.registry, this.stepsTaken - 1, {
      markupProtocol: this.o.writeProtocol === 'markup'
    })

    const failure = detectStepFailure({
      text: out.text,
      writeProtocol: this.o.writeProtocol,
      hadNativeCalls: out.nativeCalls.length > 0,
      markupKind: collected.markupKind,
      wroteThisRun: this.wrote
    })
    if (failure) {
      this.handleProtocolFailure(failure, out, collected)
      return
    }

    this.o.ctx.run.step = this.stepsTaken - 1
    // Reads and navigation first, then the writes in reply order, then what
    // must run last (a deletion, which renumbers the chapters after it).
    const last = (inv: ToolInvocation) => !!this.o.registry.get(inv.name)?.runLast
    const writes = collected.invocations.filter(inv => this.kindOf(inv) === 'write' && !last(inv))
    const { run: plannedWrites, dropped } = planWrites(writes)
    const toRun = [
      ...collected.invocations.filter(inv => this.kindOf(inv) !== 'write' && !last(inv)),
      ...plannedWrites,
      ...collected.invocations.filter(last)
    ]
    this.stray += collected.strayMarkup + dropped
    this.stepDropped = collected.strayMarkup + dropped
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
    const fail = (e: unknown): ToolResult => {
      console.error(`[agent] tool ${inv.name} raised`, e)
      return {
        ok: false,
        content: `${inv.name} failed: ${e instanceof Error ? e.message : String(e)}`,
        trace: `⚠️ ${inv.name} failed`
      }
    }
    try {
      const r = tool.invoke(inv, this.o.ctx)
      return r instanceof Promise ? r.catch(fail) : r
    } catch (e) {
      return fail(e)
    }
  }

  private handleProtocolFailure(failure: DocumentUpdateFailure, out: StepOutput, collected: CollectedStep): void {
    const text = out.text
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
        // With its reasoning (grok): the retry should know what it planned,
        // and xAI's prefix cache counts the reasoning as part of the prefix.
        { role: 'assistant', content: text, ...(out.responseItems?.length ? { responseItems: out.responseItems } : {}) },
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
    const wroteNow = executed.some(e => e.kind === 'write' && e.result.ok)
    if (wroteNow) this.wrote = true
    this.stepLog.push({
      signature: ran.map(inv => callSignature(inv.name, inv.args, inv.argumentsText)).sort().join('\n'),
      names: [...new Set(ran.map(inv => inv.name))],
      wrote: wroteNow
    })
    const reasoning = out.usage?.reasoningTokens ?? 0
    const threshold = this.o.longReasoningTokens ?? 0
    if (threshold > 0 && !wroteNow && reasoning > threshold) this.longReasoningDue = { atStep: this.stepsTaken + 1, tokens: reasoning }
    if (wroteNow) this.htmlReadPending = null
    ran.forEach((inv, i) => {
      if (inv.name === 'read_chapter' && inv.args?.format === 'html' && results[i].ok) this.htmlReadPending = results[i].trace
    })
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

    // The model asked the user something: its results are appended so the
    // call is answered, then the turn ends and the next message answers it.
    if (this.o.ctx.run.question && !this.cancelled) {
      this.lastResultsStart = this.messages.length
      this.messages = [...this.messages, ...this.resultMessages(out, ran, results)]
      this.finish({ failedUpdate: null, exhaustedCorrective: false, unretriableFailedUpdate: false, endReason: 'asked' })
      return
    }

    // A reply with no action while the plan has work left, or right after an
    // HTML read that no edit followed: the model is reminded and continues
    // (a bounded number of times).
    const unfinished = unfinishedPlanItems(this.o.ctx.run.plan)
    const mayNudge = decision.action === 'end' && decision.reason === 'answered' && this.o.canContinue && !this.cancelled && stepsLeft(this.o.budgets, this.stepsTaken) > 0
    const nudge = mayNudge && unfinished.length > 0 && this.planNudges < PLAN_NUDGE_BUDGET
      ? (this.planNudges++, planUnfinishedNudge(this.o.ctx.run.plan))
      : mayNudge && this.htmlReadPending && !this.htmlReadNudged
        ? (this.htmlReadNudged = true, htmlReadNudge(this.htmlReadPending))
        // A claim of having written, with nothing written this run: the
        // editor's facts, once (the markup declaration check catches the
        // same claim beside an `unchanged` declaration earlier, as a failure).
        : mayNudge && !this.wrote && !this.claimNudged && claimsOwnWrite(out.text)
          ? (this.claimNudged = true, unbackedClaimNudge({ writes: writesSoFar(this.o.ctx.run), reads: this.o.ctx.run.readIds.size, planLeft: unfinished.length }))
          : null
    // A message the user sent meanwhile rides with the nudge, or on its own
    // keeps a turn going that would have ended with this reply.
    const steer = this.o.canContinue && !this.cancelled && stepsLeft(this.o.budgets, this.stepsTaken) > 0 ? this.takeSteer() : null
    const maySteer = !!steer && decision.action === 'end' && (decision.reason === 'answered' || decision.reason === 'writes_done')
    if (nudge || maySteer) {
      this.messages = [
        ...this.messages,
        { role: 'assistant', content: out.text, ...(out.responseItems?.length ? { responseItems: out.responseItems } : {}) },
        { role: 'user', content: [nudge ? wrapReminder(nudge) : '', steer ?? ''].filter(Boolean).join('\n\n') }
      ]
      this.o.observer.onStepExecuted?.(this.progress())
      void this.o.driver(this.messages, this.stepsTaken, { final: stepsLeft(this.o.budgets, this.stepsTaken) === 1 })
      return
    }

    if (continuing && decision.action === 'continue') {
      if (decision.corrective) this.correctiveUsed++
      this.lastResultsStart = this.messages.length
      this.messages = [...this.messages, ...appendReminders(this.resultMessages(out, ran, results), this.collectReminders())]
      if (steer) this.messages = [...this.messages, { role: 'user', content: steer }]
      if (decision.final) this.messages = [...this.messages, { role: 'user', content: STEP_LIMIT_NOTE }]
      this.compactIfNeeded()
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
   * Keep the next step's prompt inside the window: past the threshold, the
   * oldest read results are replaced by a note (runCompaction). Shown in the
   * bubble's trace, like a tool call.
   */
  private compactIfNeeded(): void {
    const limit = this.o.promptTokenLimit ?? 0
    if (!(limit > 0) || this.elidable.length === 0) return
    const plan = planElisions(this.messages, this.elidable, limit, this.lastResultsStart, this.measured)
    this.elidable = plan.remaining
    if (plan.elided.length === 0) return
    this.messages = plan.messages
    const line = elisionTrace(plan.elided)
    this.trace.push(line)
    this.timeline.push({ type: 'tool', line, ok: true })
  }

  /**
   * The automated context the next step carries beside its results: the
   * repeat nudge, the long-reasoning reminder, the plan, and whatever the
   * host noticed (the user edited a chapter, a request is waiting).
   */
  private collectReminders(): string[] {
    const out: string[] = []
    const runLen = this.identicalRunLength()
    if (runLen === REPEAT_NUDGE_STEPS) out.push(repeatNudge(this.stepLog[this.stepLog.length - 1].names, runLen))
    if (this.longReasoningDue && this.longReasoningDue.atStep === this.stepsTaken) {
      out.push(longReasoningReminder(this.longReasoningDue.tokens))
      this.longReasoningDue = null
    }
    if (unfinishedPlanItems(this.o.ctx.run.plan).length > 0) out.push(planReminder(this.o.ctx.run.plan))
    const lookups = this.lookupStreak()
    if (!this.lookupNudged && lookups >= LOOKUP_NUDGE_STEPS) {
      this.lookupNudged = true
      out.push(lookupStreakNudge(lookups, this.offeredTools().some(t => t.name === 'analyze_book')))
    }
    out.push(...(this.o.reminders?.() ?? []))
    return out
  }

  /** Steps in a row, ending with the last, that only called look-up tools and wrote nothing. */
  lookupStreak(): number {
    let n = 0
    for (let i = this.stepLog.length - 1; i >= 0; i--) {
      const step = this.stepLog[i]
      if (step.wrote || step.names.length === 0 || step.names.some(name => this.o.registry.get(name)?.kind !== 'read')) break
      n++
    }
    return n
  }

  /** How many steps in a row, ending with the last, made the same calls and wrote nothing. */
  identicalRunLength(): number {
    const last = this.stepLog[this.stepLog.length - 1]
    if (!last || !last.signature || last.wrote) return 0
    let n = 0
    for (let i = this.stepLog.length - 1; i >= 0; i--) {
      const step = this.stepLog[i]
      if (step.signature !== last.signature || step.wrote) break
      n++
    }
    return n
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
      ...(out.thinking?.length ? { thinking: out.thinking } : {}),
      ...(out.responseItems?.length ? { responseItems: out.responseItems } : {})
    }]
    for (const { inv, result } of native) {
      // A read's result may be elided later when the prompt outgrows the
      // window (compactIfNeeded); its index is where this message will sit.
      if (result.ok && this.kindOf(inv) === 'read') this.elidable.push({ index: this.lastResultsStart + messages.length, trace: result.trace })
      messages.push({ role: 'tool', toolCallId: inv.id, name: inv.name, content: result.content })
    }
    // Blocks the reply lost never reached the document. Unsaid, the model
    // believes they did — it found out only by reading the chapter, and wrote
    // a whole chapter twice (2026-10-06).
    const lost = this.stepDropped > 0
      ? `- NOT APPLIED: ${this.stepDropped} document block(s) in your reply did not reach the document — a full rewrite beside <edit> blocks for the same chapter, a rewrite beside a selection rewrite, or markup that could not be read. Write what you still want changed in a reply of its own.`
      : ''
    if (markup.length > 0 || lost) {
      messages.push({
        role: 'user',
        content: 'RESULT OF YOUR DOCUMENT CHANGES:\n' + [...markup.map(({ inv, result }) => `- ${inv.name}: ${result.content}`), ...(lost ? [lost] : [])].join('\n')
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
      touched: [...this.o.ctx.run.touched.values()],
      seen: seenChapters(this.o.ctx.run),
      plan: [...this.o.ctx.run.plan]
    }
  }

  private finish(end: Pick<RunSummary, 'failedUpdate' | 'exhaustedCorrective' | 'unretriableFailedUpdate' | 'endReason'>): void {
    if (this.finished) return
    this.finished = true
    // Not on Stop: the hook keeps the half-written draft in the chapter the
    // preview created, and nothing a stopped run made is removed behind the
    // user's back — it is theirs to keep or delete.
    if (end.endReason !== 'cancelled') this.dropEmptyCreated()
    this.o.observer.onFinish({
      strayMarkup: this.stray,
      effects: this.effects,
      ...this.progress(),
      readIds: [...this.o.ctx.run.readIds],
      question: end.endReason === 'asked' ? this.o.ctx.run.question : null,
      ...end
    })
  }

  /**
   * A chapter is created by the write that fills it, as soon as its preview
   * starts (documentWrites, claimNewChapter). If that write never landed —
   * cut off, refused, never retried — the chapter is still empty when the
   * run ends: leave nothing behind.
   */
  private dropEmptyCreated(): void {
    const { run, document } = this.o.ctx
    for (const chapter of document.chapters()) {
      if (!run.created.has(chapter.id) || !isBlankContent(chapter.content)) continue
      document.remove(chapter.id)
      run.created.delete(chapter.id)
      run.touched.delete(chapter.id)
    }
  }
}
