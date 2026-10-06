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

export type { JsonSchema, ToolSpec }

/**
 * What a tool does, which decides what the loop does after it (D3): a read
 * or navigation means the model asked for something and must see the answer;
 * a successful write may end the turn.
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

/** The active document, as this turn found it. */
export interface DocumentPort {
  /** Content when the turn began — may still carry an unresolved diff. */
  readonly original: string
  /** Store write for the active document (goes through its blanking guard). */
  commit(html: string): void
}

/** `{{IMAGE_PLACEHOLDER_n}}` tokens, one registry per request. */
export interface ImagePort {
  preserve(html: string): string
  restore(html: string): string
}

/**
 * State one run's tools share.
 *
 * `working` is the active document's clean copy with this run's writes
 * applied (§5.3): every write matches against it and the store receives the
 * review rendering `base → working`, so two writes in one run compose instead
 * of the second one diffing against a document the first already changed.
 */
export interface RunState {
  working: { base: string; html: string; dirty: boolean } | null
  /** A selection rewrite was executed this run (placed or not). */
  selectionAttempted: boolean
  /** …and it landed. Edits beside it then apply locally around it. */
  selectionApplied: boolean
}

export interface ToolContext {
  getState: () => AppState
  editor: EditorPort
  selection: SelectionPort
  document: DocumentPort
  images: ImagePort
  run: RunState
}

// ── Tools ───────────────────────────────────────────────────────────────────

export interface AgentTool<A = Record<string, unknown>> extends ToolSpec {
  kind: ToolKind
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
