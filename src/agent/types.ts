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
import type { AttachmentMeta } from '../utils/attachments'
import type { WebPage, WebSearchResult } from '../utils/webText'
import type { JsonSchema, ToolSpec } from '../utils/documentTools'
import type { AppState } from '../store/types'
import type { AgentTouchedChapter } from '../types/chat'
import type { PolishOutcome } from './polish'
import type { AnalyzeChapter, AnalyzeOutcome, AnalyzePlan } from './analyzeBook'
import { hashContent } from '../utils/contextLedger'
import type { PlanItem } from '../utils/plan'

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
  /** Rename a chapter (its title only). */
  rename(id: string, title: string): void
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
  /**
   * The book's chapters (ids and titles, in order) when the run began, so
   * list_chapters can say whether any were added, removed or renamed since.
   */
  startOutline?: string
  /** The last list_chapters result of this run, to say when nothing changed since. */
  lastList?: string
  /** A selection rewrite was executed this run (placed or not). */
  selectionAttempted: boolean
  /** …and it landed. Edits beside it then apply locally around it. */
  selectionApplied: boolean
  /** The model's checklist for this turn (the `plan` tool), shown under the bubble. */
  plan: PlanItem[]
  /** Writes landed (writesSoFar) when each plan item started: a "done" needs more since. */
  planBaseline: Map<string, number>
  /**
   * Chapters whose WHOLE current text the model has seen this run, by the
   * hash of the accepted reading it saw (agentic_chat_loop.md §0.11): in
   * context at the start (the ledger, not cut) or a whole text read. A plain
   * chapter may then be rewritten without an HTML read.
   */
  textSeen: Map<string, string>
  /** Characters of attachments read into the conversation this run (capped: ATTACHMENT_RUN_READ_CAP). */
  attachmentChars: number
  /** Chapters whose shrinking rewrite was held back once (utils/paragraphs rewriteLoss); a second send applies. */
  rewriteLossWarned: Set<string>
  /** A question the model asked the user this step (`ask_user`); the loop stops for the answer. */
  question: AskedQuestion | null
}

/** What `ask_user` put to the user. */
export interface AskedQuestion {
  question: string
  /** Choices, the recommended one first; the user may also answer freely. */
  options: string[]
}

/** A book's chapter list as a comparable string: ids and titles, in order. */
export function chapterOutline(chapters: Array<{ id: string; title: string }>): string {
  return chapters.map(c => `${c.id}\u0000${c.title}`).join('\u0001')
}

export function createRunState(init: {
  startId: string
  inContext?: Iterable<string>
  startContent?: string
  startOutline?: string
  /** Hashes of the accepted readings of the chapters whose whole text the request carries. */
  textSeen?: Iterable<[string, string]>
}): RunState {
  return {
    ...(init.startOutline !== undefined ? { startOutline: init.startOutline } : {}),
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
    selectionApplied: false,
    plan: [],
    planBaseline: new Map(),
    textSeen: new Map(init.textSeen ?? []),
    attachmentChars: 0,
    rewriteLossWarned: new Set(),
    question: null
  }
}

/** How much the run has written so far: chapters touched plus the changes in them. */
export function writesSoFar(run: RunState): number {
  let n = 0
  for (const t of run.touched.values()) n += 1 + t.changes
  return n
}

/** A chapter whose HTML the model has seen this run, by the stored content it saw. */
export interface SeenChapter {
  id: string
  hash: string
}

/** What the model has seen, for the turn's record: a page reload restores it (restoreSeen). */
export function seenChapters(run: RunState): SeenChapter[] {
  return [...run.htmlShown].flatMap(id => {
    const known = run.known.get(id)
    return known === undefined ? [] : [{ id, hash: hashContent(known) }]
  })
}

/**
 * A reloaded page rejoins the step in flight with a new run state.
 *
 * Problem: that state knew only the start chapter, so the rejoined step's
 *   edit of a chapter it had read in the step before was refused as "not
 *   read yet" (2026-10-06, "继续写第二章").
 * Fix: the turn's record carries what the model had seen, with the hash of
 *   each chapter's stored content. A chapter still stored exactly as seen
 *   is seen again; one that changed since (the user edited it) is not.
 */
export function restoreSeen(run: RunState, seen: SeenChapter[] | undefined, stored: (id: string) => string | undefined): RunState {
  for (const { id, hash } of seen ?? []) {
    const content = stored(id)
    if (content === undefined || hashContent(content) !== hash) continue
    run.htmlShown.add(id)
    run.known.set(id, content)
    run.inContext.add(id)
  }
  return run
}

/** The polish pass (D9), bound to the polish model. Absent where none is configured. */
export interface PolishPort {
  /** Polish a chapter's HTML (image placeholder tokens in, tokens out). */
  run(html: string, onProgress: (done: number, total: number) => void): Promise<PolishOutcome>
}

/** analyze_book's model calls (D7), batched by ../analyzeBook. Absent where no model is wired. */
export interface AnalyzePort {
  run(task: string, chapters: AnalyzeChapter[], onProgress: (done: number, total: number) => void): Promise<AnalyzeOutcome>
  /** What run() would cost, before running it (calls, input tokens); absent = never asks first. */
  plan?(task: string, chapters: AnalyzeChapter[]): AnalyzePlan
}

/** The book's reference files (docs/features/attachments_and_web.md §1). */
export interface AttachmentsPort {
  list(): AttachmentMeta[]
  paragraphs(id: string): Promise<string[]>
}

/** The anonymous browser (attachments_and_web.md §2). Absent when web access is off. */
export interface WebPort {
  search(query: string, maxResults: number): Promise<WebSearchResult[]>
  read(url: string): Promise<WebPage>
}

export interface ToolContext {
  getState: () => AppState
  polish?: PolishPort
  analyze?: AnalyzePort
  attachments?: AttachmentsPort
  web?: WebPort
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
  /** Earlier names a call may still use (history, habit); never offered (read_and_list.md §4). */
  aliases?: string[]
  markupForm?: boolean
  /**
   * Offered natively to a markup model too (with the agent tools on), beside
   * its tag form. update_document only: measured 2026-10-07, grok asked for
   * an outline and character cards announced "writing it now" and called a
   * tool instead, run after run — even a create_chapter tool, which it called
   * again and again without ever writing. It wants to deliver such a document
   * through a call; the tag stays for prose, where the text previews live.
   */
  nativeOnMarkup?: boolean
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
