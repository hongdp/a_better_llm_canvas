/**
 * The agentic chat loop's vocabulary (docs/features/agentic_chat_loop.md §5).
 *
 * A turn is a run of STEPS; each step is one model call. Whatever a step asks
 * for — a native tool call, or a `<canvas>`/`<edit>`/`<selection_replace>`
 * block on the markup protocol — is normalized into the same
 * {@link ToolInvocation} and executed by the tool registered under its name.
 * Nothing here touches React: tools reach the editor and the store only
 * through the ports in {@link ToolContext}, so they run under a fake in tests.
 */
import type { JsonSchema, ToolSpec } from '../utils/documentTools'
import type { AppState } from '../store/types'
import type { AgentTouchedChapter } from '../types/chat'
import type { PolishOutcome } from './polish'

export type { JsonSchema, ToolSpec }

/**
 * What a tool does, which decides what the loop does after it (D3): a read
 * or navigation means the model asked for something and must see the answer;
 * a successful write hands its result back too, unless `continueAfterWrites`
 * is off — then it ends the turn.
 */
export type ToolKind = 'read' | 'navigate' | 'write'

/** One requested tool call, whichever way it arrived. */
export interface ToolInvocation {
  /** Provider id for a native call; synthesized for markup. */
  id: string
  name: string
  /** Parsed arguments; null when the JSON never became valid (cut off). */
  args: Record<string, unknown> | null
  /**
   * 'native' = a provider tool call, which must be answered with a `tool`
   * message if the run continues. 'markup' = parsed from the tag protocol;
   * it has no call id to answer.
   */
  source: 'native' | 'markup'
  /** Native only: the argument bytes as received, for an exact replay. */
  argumentsText?: string
  /** Native only: Gemini's thoughtSignature for this call, replayed with it. */
  signature?: string
  /** Markup only: the block's closing tag never arrived (truncated reply). */
  unclosed?: boolean
}

/**
 * What a write did to the document, in the terms the completion note is
 * written in (`buildCompletionWarnings`). Summed over a step's writes.
 */
export interface WriteEffects {
  canvasIssue?: 'truncated' | 'elided'
  failedEdits?: number
  reinsertedImages?: number
  selectionGone?: boolean
  /** Called, but nothing in the arguments could be applied. */
  producedNothing?: boolean
}

export interface ToolResult {
  ok: boolean
  /**
   * Whether the model can fix this failure by trying again: an edit whose
   * SEARCH did not match, a refused edit on an unread chapter. Defaults to
   * `!ok`. A selection that is gone, or a rewrite cut off by the output
   * limit, is not — a second attempt would fail the same way (spec D3).
   */
  retryable?: boolean
  /** What the model reads if the run continues. Plain text, capped by the tool. */
  content: string
  /** One line for the turn's trace in the chat bubble. */
  trace: string
  effects?: WriteEffects
}

// ── Ports ───────────────────────────────────────────────────────────────────

/** The parts of a TipTap editor the write tools use. */
export interface EditorLike {
  getHTML(): string
}

/**
 * The editor, behind the rules in CLAUDE.md "Editor sync". Previews never
 * enter the undo history and never write the store; the run's end settles
 * them.
 */
export interface EditorPort {
  /** The live editor, or null before it mounts (a rejoin runs before it does). */
  current(): EditorLike | null
  /** Paint a partial full-document rewrite (already cleaned of a cut-off tail). */
  previewDocument(html: string): void
  /**
   * Put the open chapter back to its stored content if a preview painted it.
   * Used when a rewrite turns out to target another chapter after all.
   */
  discardPreview(): void
  /** Paint a partial selection rewrite over the selected range. */
  previewSelection(html: string): void
  /**
   * Write `html` over [from, to] as a real transaction and return where the
   * insert ends, or null when the range no longer fits the document.
   */
  replaceRange(from: number, to: number, html: string): number | null
}

/** The user's selection for this turn, located by position or (after a reload) by text. */
export interface SelectionPort {
  /** Re-find a selection known only by its text (rejoin), if not yet placed. */
  relocate(): void
  range(): { from: number; to: number } | null
  /** Where the latest preview's insert ends; the range's `to` before any. */
  end(): number | null
  /** The selected HTML as it was when the turn began. */
  originalText(): string
}

/** A chapter as the tools see it. */
export interface BookChapter {
  id: string
  title: string
  content: string
  summary?: string
  /** False while a server book's content has not arrived ('' is then not "empty"). */
  loaded?: boolean
}

/** The book, as this turn found it and as it is now. */
export interface DocumentPort {
  /** The chapter the turn started on: writes go here when no chapter is named. */
  readonly startId: string
  /** That chapter's content when the turn began — may carry an unresolved diff. */
  readonly original: string
  /** Every chapter, in CHAPTER INDEX order, as the store holds it now. */
  chapters(): BookChapter[]
  /** The chapter open in the editor right now. */
  openId(): string
  /**
   * The user has opened another chapter during this run. From then on the
   * run never moves the view: they may be typing there (writes and previews
   * of other chapters show as progress instead).
   */
  userMoved(): boolean
  /** Load chapters whose content has not arrived yet (server books lazy-load). */
  ensureLoaded(ids: string[]): Promise<void>
  /** Store write for one chapter (goes through the blanking guard). */
  commit(id: string, html: string): void
  /** Show a chapter in the editor. */
  open(id: string): void
  /** Append a new, empty chapter WITHOUT switching to it; returns its id. */
  create(title: string): string
  /** Delete a chapter (store + server), as the chapter list's delete does. */
  remove(id: string): void
  /** Version snapshot of a chapter, taken before the run first changes it. */
  snapshot(id: string, label: string): void
}

/** Chat-side signals a tool can raise while it runs. */
export interface UiPort {
  /** One live progress line in the bubble (a rewrite of a chapter that is not open); null clears it. */
  progress(line: string | null): void
  /**
   * A chapter a slow write is rewriting right now (a polish), locked for the
   * user until it lands; null when done. Other chapters stay editable.
   */
  writing(id: string | null): void
}

/** `{{IMAGE_PLACEHOLDER_n}}` tokens, one registry per request. */
export interface ImagePort {
  preserve(html: string): string
  restore(html: string): string
}

/**
 * One chapter's clean working copy (§5.3): every write matches against `html`
 * and the store receives the review rendering `base → html`, so two writes in
 * one run compose instead of the second diffing against a document the first
 * already changed.
 */
export interface DocState {
  /** The chapter as the run first found it (may carry an unresolved diff). */
  original: string
  /** Its accepted reading — what the model was shown and edits match against. */
  base: string
  /**
   * What the review diff is drawn against: the chapter with every pending
   * change REJECTED, i.e. the last text the user confirmed. Drawing it
   * against `base` instead folded an unreviewed diff into the new one as if
   * accepted (user-reported 2026-10-06).
   */
  reviewBase: string
  html: string
  dirty: boolean
}

/** State one run's tools share. */
export interface RunState {
  /** Step being executed (0-based); set by the run before each step's tools run. */
  step: number
  /**
   * How this model writes (set by the run). Tool results that tell the model
   * how to write next must name the form it actually uses — describing tags
   * to a tool-protocol model invites it to mix the two.
   */
  writeProtocol?: 'tools' | 'markup'
  /** Writes hand their result back instead of ending the turn (set by the run). */
  continuesAfterWrites?: boolean
  docs: Map<string, DocState>
  /**
   * Each chapter's stored content as this run last saw or wrote it: when its
   * HTML was shown (the request, an html read, creation) and after each
   * commit. The user may edit other chapters while the run works; a stored
   * content that no longer matches means they did, and a write based on the
   * run's copy would overwrite their edit (see documentWrites userEdited).
   */
  known: Map<string, string>
  /**
   * Chapters whose HTML the model has seen this run — the start chapter (in
   * the request), `read_chapter` with format html, chapters it created. An
   * edit anywhere else is refused: its SEARCH text could not have been copied
   * from current bytes (spec D2's seen-content rule).
   */
  htmlShown: Set<string>
  /** Chapters whose full text this request already carries (ledger, inline, active). */
  inContext: Set<string>
  /** Chapters created this run: no snapshot needed, opened on first write (D6). */
  created: Set<string>
  /** Chapters already snapshotted this run. */
  snapshotted: Set<string>
  /** Chapters read this run — fed to the next turn's continuity signal. */
  readIds: Set<string>
  /** Full-text reads returned this run, by request key → step (duplicate guard, D5). */
  reads: Map<string, number>
  /** What each chapter received this run — the bubble's "changed this turn" rows. */
  touched: Map<string, AgentTouchedChapter>
  /** A selection rewrite was executed this run (placed or not). */
  selectionAttempted: boolean
  /** …and it landed. Edits beside it then apply locally around it. */
  selectionApplied: boolean
}

export function createRunState(init: { startId: string; inContext?: Iterable<string>; startContent?: string }): RunState {
  return {
    step: 0,
    docs: new Map(),
    known: new Map(init.startContent === undefined ? [] : [[init.startId, init.startContent]]),
    htmlShown: new Set([init.startId]),
    inContext: new Set([init.startId, ...(init.inContext ?? [])]),
    created: new Set(),
    snapshotted: new Set(),
    readIds: new Set(),
    reads: new Map(),
    touched: new Map(),
    selectionAttempted: false,
    selectionApplied: false
  }
}

/** The polish pass (D9), bound to the polish model. Absent where none is configured. */
export interface PolishPort {
  /** Polish a chapter's HTML (image placeholder tokens in, tokens out). */
  run(html: string, onProgress: (done: number, total: number) => void): Promise<PolishOutcome>
}

export interface ToolContext {
  getState: () => AppState
  polish?: PolishPort
  editor: EditorPort
  selection: SelectionPort
  document: DocumentPort
  images: ImagePort
  ui: UiPort
  run: RunState
}

// ── Tools ───────────────────────────────────────────────────────────────────

export interface AgentTool<A = Record<string, unknown>> extends ToolSpec {
  kind: ToolKind
  /**
   * The markup protocol has a tag for this call (`<canvas>`, `<edit>`,
   * `<selection_replace>`). Such tools are not offered natively to a model on
   * markup — it writes the tag instead (D1). A write WITHOUT a tag form
   * (polish_chapter) is offered natively to every model.
   */
  markupForm?: boolean
  /**
   * Runs after every other call of its step. A deletion renumbers the
   * chapters after it, and the model numbered the other calls of the same
   * reply from the index as it was.
   */
  runLast?: boolean
  /** Offered this step? (a selection exists, the book is loaded, …) */
  isAvailable(ctx: ToolContext): boolean
  /**
   * Validate the raw arguments. A string is an error the model can read;
   * null input means the arguments never parsed.
   */
  parse(raw: Record<string, unknown> | null): A | string
  /** Render a call while its arguments are still arriving. */
  preview?(partialArgumentsText: string, ctx: ToolContext): void
  /**
   * Run the call. Synchronous when it can be: the step's completion handler
   * runs inside the stream's onDone, and keeping it synchronous keeps the
   * turn's ordering exactly what it was before the loop existed.
   */
  execute(args: A, ctx: ToolContext, call: ToolInvocation): ToolResult | Promise<ToolResult>
}
