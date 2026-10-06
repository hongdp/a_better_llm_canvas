/**
 * When a run continues, and when it ends (spec D3, D5).
 *
 * Pure: the run controller feeds it what a step produced and what executing
 * it did, and gets back what to do next. Every row of the D3 table is one
 * branch here, so each is testable without a model.
 */
import { detectFailedDocumentUpdate, type DocumentUpdateFailure } from '../utils/text'
import { MAX_NO_ACTION_RETRIES } from '../hooks/chat/streamHandlers'
import type { ToolKind, ToolResult } from './types'

export interface RunBudgets {
  /** Steps a run may take in total; 0 = no limit (user decision, D5). */
  maxSteps: number
  /**
   * Corrective steps: protocol failures, and failed writes fed back. One
   * shared budget, sized from the measured recovery curve (see
   * MAX_NO_ACTION_RETRIES) — every corrective round is a re-roll.
   */
  maxCorrective: number
}

export interface StepPolicy {
  /** Give the model another step after writes that all succeeded (D3). */
  continueAfterWrites: boolean
  /** Send a failed write's error back as a corrective step instead of only reporting it. */
  feedBackFailedWrites: boolean
}

/**
 * Default step limits per provider (D5). Grok pays its first-token latency
 * on every step (127–199 s measured at high effort), local models do not pay
 * per token — so local runs get more room.
 */
export function defaultMaxSteps(provider: string): number {
  return provider === 'ollama' || provider === 'runpod' ? 10 : 6
}

export const DEFAULT_BUDGETS: RunBudgets = { maxSteps: 6, maxCorrective: MAX_NO_ACTION_RETRIES }

/** The pre-loop behaviour: a write ends the turn, failures are only reported. */
export const DEFAULT_POLICY: StepPolicy = { continueAfterWrites: false, feedBackFailedWrites: false }

/**
 * Whether a write hands its result back to the model, like every other tool
 * call, instead of ending the turn. On for every provider (user decision,
 * 2026-10-06) — the standard agent loop: the turn ends when the model replies
 * with no action at all.
 *
 * It was off for grok, to spare a confirmation round its first-token wait
 * (127–199 s measured at high effort). Measured since: a step that only
 * follows a tool result reaches its first token in 1–6 s. And ending on every
 * write cost far more — the model created all its chapters up front and
 * packed several into one reply (squeezed short, one previewed), or ended
 * with a created chapter still empty.
 */
export function defaultContinueAfterWrites(provider: string): boolean {
  void provider
  return true
}

export interface RunSettings {
  /** Offer the read/navigate tools. */
  agentTools: boolean
  budgets: RunBudgets
  policy: StepPolicy
}

/**
 * A provider's run settings, from its config (`ProviderConfig.agentTools`,
 * `agentMaxSteps`, `continueAfterWrites`) with the defaults above.
 *
 * `canContinue` false (a rejoined stream, which has no request to re-issue)
 * pins the run to its one step.
 */
export function resolveRunSettings(
  provider: string,
  config: { agentTools?: boolean; agentMaxSteps?: number; continueAfterWrites?: boolean } | undefined,
  canContinue = true
): RunSettings {
  const agentTools = config?.agentTools !== false
  const configured = config?.agentMaxSteps
  const maxSteps = typeof configured === 'number' && Number.isFinite(configured) && configured >= 0
    ? Math.floor(configured)
    : defaultMaxSteps(provider)
  return {
    agentTools,
    budgets: { maxSteps: canContinue ? maxSteps : 1, maxCorrective: MAX_NO_ACTION_RETRIES },
    policy: {
      // A rejoined stream has no request to continue from.
      continueAfterWrites: canContinue && agentTools && (config?.continueAfterWrites ?? defaultContinueAfterWrites(provider)),
      // Feeding a failed edit back is what lets the model fix it; with the
      // agent tools off the turn keeps its pre-loop shape.
      feedBackFailedWrites: agentTools
    }
  }
}

/**
 * Did a step that asked for nothing fail the markup protocol?
 *
 * Only a reply with NO native tool call is judged: a call IS a declaration,
 * and a step that called a read tool is not the final reply (spec §7).
 *
 * On the tool protocol the system prompt never mentions `<doc_status>`, so a
 * plain chat answer is never "undeclared" there. Treating it as one retried
 * every question three times with an instruction about tags the model was
 * never taught (CLAUDE.md: the declaration machinery is markup-only).
 */
export function detectStepFailure(params: {
  text: string
  writeProtocol: 'tools' | 'markup'
  hadNativeCalls: boolean
  markupKind: string | null
  /**
   * An earlier step of this run already changed the document. Its closing
   * reply ("done — both chapters are written") then refers to those changes:
   * a missing declaration, or "updated" with no markup of its own, is not a
   * lost write. Only broken markup still is.
   */
  wroteThisRun?: boolean
}): DocumentUpdateFailure | null {
  if (params.hadNativeCalls || params.markupKind !== 'chat') return null
  const failure = detectFailedDocumentUpdate(params.text)
  if (failure === 'undeclared' && params.writeProtocol === 'tools') return null
  if (params.wroteThisRun && failure !== 'malformed') return null
  return failure
}

export interface ExecutedCall {
  kind: ToolKind
  result: ToolResult
}

export type StepDecision =
  | { action: 'end'; reason: 'answered' | 'writes_done' | 'step_limit' | 'corrective_exhausted' }
  /**
   * `final`: the next step is the last the budget allows. It is sent with
   * tool calls disabled so the turn still ends in an answer (D5).
   */
  | { action: 'continue'; corrective: boolean; final: boolean }

/** Steps still allowed after `stepsTaken` (Infinity when unlimited). */
export function stepsLeft(budgets: RunBudgets, stepsTaken: number): number {
  return budgets.maxSteps > 0 ? budgets.maxSteps - stepsTaken : Infinity
}

/**
 * After a step's invocations ran: continue, or end?
 *
 * Applied in this order — a step can match several rows:
 *  1. no step budget left → end (the caller reports the limit when the model
 *     still wanted more);
 *  2. a read or navigation → continue (the model asked for information);
 *  3. a failed write with feed-back on and corrective budget left → continue;
 *  4. writes only, all succeeded → continue if `continueAfterWrites` (the
 *     default: the model sees each write's result and decides what is next),
 *     else end;
 *  5. nothing executed → end (the text is the answer).
 */
export function decideAfterStep(params: {
  executed: ExecutedCall[]
  stepsTaken: number
  correctiveUsed: number
  budgets: RunBudgets
  policy: StepPolicy
}): StepDecision {
  const { executed, stepsTaken, correctiveUsed, budgets, policy } = params
  const wantsMore = executed.some(e => e.kind !== 'write')
  const writes = executed.filter(e => e.kind === 'write')
  // Only a failure the model can fix by trying again is worth a step.
  const failedWrite = writes.some(e => !e.result.ok && (e.result.retryable ?? true))
  const correctiveLeft = budgets.maxCorrective - correctiveUsed

  if (executed.length === 0) return { action: 'end', reason: 'answered' }

  const wouldContinue =
    wantsMore ||
    (failedWrite && policy.feedBackFailedWrites && correctiveLeft > 0) ||
    (!failedWrite && policy.continueAfterWrites)
  if (!wouldContinue) {
    return { action: 'end', reason: failedWrite && policy.feedBackFailedWrites ? 'corrective_exhausted' : 'writes_done' }
  }
  const left = stepsLeft(budgets, stepsTaken)
  // Out of steps. Only a step that still WANTED something (a read, a fix) was
  // cut short; one whose writes landed was done — continuing would only have
  // given the model its results back.
  if (left <= 0) return { action: 'end', reason: wantsMore || (failedWrite && policy.feedBackFailedWrites) ? 'step_limit' : 'writes_done' }
  // A continuation that exists only to fix a failed write spends the
  // corrective budget; one the model asked for (a read) does not.
  return { action: 'continue', corrective: !wantsMore && failedWrite, final: left === 1 }
}
