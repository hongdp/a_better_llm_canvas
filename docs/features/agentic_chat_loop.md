# Agentic chat loop with document tools (grok-first)

Status: **phases 0–2 implemented** (2026-10-05/06); phases 2b–4 proposed.
§0 is the design as it stands. §4 records why each part is the way it is,
and the implementation history below records how it got there.

## 0. The design as built (2026-10-06)

### 0.1 A turn is a run of steps

Each user message starts one `AgentRun` (`src/agent/run.ts`). A **step** is
one streamed model call. When a step finishes:

1. `collectStep` turns everything the reply asked for into
   `ToolInvocation`s. Native tool calls and markup blocks (`<canvas>`,
   `<edit>`, `<selection_replace>`) come out in the same shape, so one tool
   implementation serves both protocols.
2. `detectStepFailure` judges a reply that asked for nothing against the
   markup protocol (`undeclared` / `claimed` / `malformed`). A failure is
   answered with a corrective step.
3. Reads and navigation run first, then the writes in reply order
   (`planWrites`: a full rewrite beside a selection rewrite is dropped).
   They run sequentially, synchronously whenever the tools are.
4. `decideAfterStep` (`src/agent/policy.ts`) continues or ends the run
   (§0.2).
5. To continue, the run **appends** the step's assistant message and its
   results (one `tool` message per native call; one "RESULT OF YOUR DOCUMENT
   CHANGES" user message for markup writes) and streams the next step.

The run is callback-driven, not a promise loop: a step completes inside the
transport's `onDone`, so a turn whose tools are synchronous settles in the
same order as the single-shot turn it replaced.

### 0.2 When the run ends (D3, D5)

| Step produced | Next |
|---|---|
| no action | **end**: the text is the answer |
| a read or navigation call | **continue**: the model asked for something |
| writes, all succeeded | **continue** (default): the results go back like any tool result. With `continueAfterWrites` off: **end** |
| a write that failed and can be retried (unmatched SEARCH, unread chapter, bad arguments) | **continue** with the error, as a corrective step |
| a markup protocol failure | **continue** with `NO_ACTION_RETRY_INSTRUCTION`, as a corrective step |

- **Ending.** The model ends its turn by replying with no action. After a
  write succeeded in the run, that closing reply is taken at its word: a
  missing `<doc_status>`, or "updated" with no markup, is not a failure.
  Only broken markup is (`wroteThisRun`).
- **Budgets.**
  - `agentMaxSteps`: 6 for grok and other cloud providers, 10 for local
    (`ollama`, `runpod`); 0 = no limit.
  - Corrective steps share one budget of 3 (`MAX_NO_ACTION_RETRIES`).
  - The last allowed step is sent with `toolChoice: 'none'` and
    `STEP_LIMIT_NOTE`, so the turn still ends in an answer. A run that ran
    out while it still wanted something ends as `step_limit`; one whose last
    step only wrote ends as `writes_done`.
- **Stop** aborts the step in flight and starts no more. Earlier steps'
  writes stay, each already a reviewable diff. A half-streamed rewrite of
  the open chapter is kept as one undo step.

### 0.3 Two protocols, one registry (D1)

The registry (`ToolRegistry` + `defineTool`, `src/agent/registry.ts`) is the
only list of tools. Offering, provider schemas, live preview and execution
all go through it. Adding a tool takes two steps: one `defineTool({...})`
module, then one entry in `CHAT_TOOLS` (`useChatLLM.ts`).

| Tool | Kind | Markup models (grok) | Tool-protocol models (local) |
|---|---|---|---|
| `update_document` | write | `<canvas chapter="N">`, or `<canvas new_chapter="title">` to create one (live preview) | native (`chapter` or `new_chapter`) |
| `edit_document` | write | `<edit chapter="N">` SEARCH/REPLACE | native |
| `replace_selection` | write | `<selection_replace>` | native |
| `polish_chapter`, `delete_chapter`, `rename_chapter` | write | native (no tag form) | native |
| `read_chapter`, `grep`, `list_chapters` | read | native | native |
| `open_chapter` | navigate | native | native |
| `analyze_book` | read | native | native |

- A tool with a tag form (`markupForm`) is never also offered natively to a
  markup model; offering a write both ways invites mixing. A native call of
  such a write marks the reply as tool-protocol, and tags beside it are
  dropped as stray. A write that only exists as a call (polish, delete)
  does not: a `<canvas>` beside a `delete_chapter` is applied.
- A tool marked `runLast` (`delete_chapter`) runs after every other call
  of its reply. The model numbered the other calls from the index as it
  was, before the deletion renumbered it.
- The offered set is fixed at the run's first step. The tools array is part
  of every request, so changing it would break the cached prefix.
- With `agentTools` off, only the tag-form writes remain: the pre-loop
  one-shot turn.

### 0.4 Writing (D2)

- **Any chapter.** A write names its target with `chapter` (an argument, or
  an attribute on the tag): a number from the CHAPTER INDEX, or a title.
  With no `chapter`, it changes the chapter the turn started on.
- **One working copy per chapter** (`DocState`):
  - `base`: the accepted reading, which the model sees and SEARCH matches
    against;
  - `reviewBase`: the rejected reading, i.e. the last text the user
    confirmed;
  - `html`: the copy with every write of this run applied.

  After each write the chapter's stored content becomes
  `diffHtml(reviewBase, html)`. So several writes in one run compose into
  one reviewable diff per chapter, and a change still under review stays
  under review.
- **Guards.**
  - Seen-content rule: an `<edit>` on a chapter whose HTML this run has not
    shown the model is refused, and the refusal tells it to read the chapter
    with `format: "html"`.
  - Truncated or elided full rewrites are refused.
  - Image tokens are preserved and reinserted.
  - A version snapshot is taken per chapter before its first change.
- **New chapters: creating IS writing** (user decision, 2026-10-06). There
  is no `create_chapter`. A chapter is created by the write that fills it:
  `<canvas new_chapter="title">…</canvas>` on markup, `update_document`
  with `new_chapter` with tools. It is appended to the book and opened
  (unless a selection rewrite is pending or the user moved). On markup it is
  created as soon as the opening tag has streamed, so the live preview runs
  in it — from the next chunk: in the chunk that opens it, the editor on
  screen is still the previous chapter's until React re-renders. Still
  explicit: a `chapter="…"` that names nothing is an error, never
  a new chapter.
  - Why: a lone `create_chapter` step planned the chapter in its reasoning
    (105–158 s to the first token, measured), and grok's reasoning does not
    carry to the next call. So the writing step planned again (up to 33 s),
    or claimed the chapter was written and wrote nothing.
  - A title already taken by a chapter with text is refused, with the write
    that rewrites it. An empty chapter of that title (titles compared
    ignoring whitespace) is filled instead of duplicated.
  - A chapter created for a write that never landed (cut off, refused) is
    removed when the run ends; on Stop it is left, with its draft.
- **Live preview, routed by target.**
  - The open chapter is painted as the rewrite streams.
  - A rewrite of a chapter that is not open shows a progress line in the
    bubble instead.
  - The preview follows the run from chapter to chapter. A new chapter is
    opened as its write starts, and the preview restarts there, so Stop
    keeps that chapter's partial draft.
  - The user may switch chapters mid-run. The preview then never paints
    over the chapter they opened.
- **The user keeps writing while the run works** (user decision,
  2026-10-06). Only the chapters the run is writing into are read-only:
  - the chapter the live preview is painting, until its step ends (the
    preview is settled at every step boundary);
  - the start chapter of a selection turn, for the whole run (its selection
    preview writes through real transactions);
  - a chapter being polished.

  Every other chapter stays editable. Read-only covers the editor and the
  review banner's accept/reject buttons (`isEditLocked`,
  `ChatSlice.editLockedIds`). A streamer that names no chapters (roleplay,
  whole-book batches) still locks the whole editor.

  Three rules keep the user's edits safe:
  - **A write never overwrites a user edit.** `RunState.known` holds each
    chapter's stored content as the run last saw or wrote it. A write to a
    chapter whose stored content has moved since is refused, as retryable,
    and the run's copy is forgotten. The model reads the chapter again and
    redoes the change on the user's text. A polish whose chapter moved is
    discarded. A read returns what is stored now.
  - **No preview over a user edit.** A rewrite of a chapter the user
    changed shows as a progress line, never painted.
  - **The view is the user's once they move.** After the user opens
    another chapter during the run, the run stops changing the view:
    a new chapter's write no longer opens it, and
    `open_chapter` says it left the chapter for the user
    (`DocumentPort.userMoved`).

  Found while building it: two paths settled the preview to the turn's
  original text whichever chapter was painted (a corrective step, and an
  error). An error also reset the start chapter's stored text, which would
  have erased a user edit. Both now use the stored text of the open
  chapter; the reset is kept only for a selection turn.
- **Series.** The model is taught one chapter per reply; it continues after
  each. A tip, not a rule (user decision, 2026-10-06): asking for what the
  next chapter needs (reading its sources) in the reply that writes this one
  saves a step. Measured before creation became writing: a 19-chapter run
  spent 21 of its 40 steps on a lone `create_chapter`, each re-sending about
  90k tokens.
- **Lengths are stated, not guessed.** Write results give the chapter's
  length ("#23 was rewritten (2738 characters)"), counted the way
  `read_chapter` counts a paragraph range ("¶869–¶933 (3585 characters)").
  The model cannot count its own output: it said a rewrite was "as long as
  the source" at 76% of it.
- **Deleting.** `delete_chapter` deletes only what nothing would be lost
  from: a chapter this run created (unless the user typed into it since) or
  an empty one. It refuses the turn's start chapter, the book's last
  chapter, and a server chapter whose text has not loaded ('' there is not
  "empty"). A chapter with text is the user's to delete; the loop cannot ask
  for confirmation yet (`approval`, phase 3), so the tool says to ask the
  user. The result tells the model the chapters after it moved up.
- **Renaming, and undoing a wrongly titled new chapter** (user request,
  2026-10-06). `rename_chapter` renames any chapter. Its result says when the
  chapter's first heading still reads the old title. A title another chapter
  has is refused.
  - With `replace=true`, a chapter this run created gives its text to the
    chapter that has the title and is removed. This is the fix for
    `new_chapter="第二章 入城"` written when "第二章 进城" was meant. The text
    lands in place: same position, id and title. It is a reviewable diff with
    a snapshot first, and its leading heading is renamed to match. Nothing is
    written again.
  - Deleting the original and renaming the new chapter was the request as
    asked. It was not built that way: the chapter would move to the end of
    the book, and a chapter with text is the user's to delete.
  - Only a chapter the run created may take another's place. Its text is the
    model's own, so a rejected review loses nothing of the user's.
- **Creating and rewriting answer differently.** A new chapter's result
  says "Created a NEW chapter … at the end of the book" with the book's new
  chapter count. When another chapter's title looks like it (the same
  chapter marker such as 第二章, one title inside the other, or most
  characters shared — never two different chapter numbers), the result names
  it and the `rename_chapter … replace=true` call that would undo the
  mistake. A rewrite says "Rewrote the EXISTING chapter …" with its length
  before and after, and "No chapter was added."
- **A selection rewrite survives the user leaving its chapter.** When the
  selection's chapter is no longer on screen at placement, the rewrite is
  placed in the stored chapter by its text, starting from the turn's
  original. The chapter is locked for the turn, so only the run has changed
  it, and starting from the original also replaces a half-streamed preview.
  `alignSelectionBlocks` lines up the block structure: a selection inside a
  paragraph serializes as inline text while its rewrite is a `<p>`. A
  rewrite that cannot be placed reverts any half-streamed preview and is
  reported. On screen, a range that no longer fits is still reported and is
  never forced in from the original. Edits beside the selection read the
  selection chapter's stored text when another chapter is open; they used
  to read the editor, which then held the other chapter.
- **Correcting a selection rewrite in the same turn.** An edit that lands
  inside unreviewed inserted text (the selection's fresh rewrite, or any
  pending addition) changes that text in place. It is a proposal nobody has
  accepted, so the review still shows one diff and reject-all still returns
  the confirmed text. Text inside a pending deletion, or across a pending
  change's edge, is refused, and the result says the edit was found but
  touches text under review (`underReview`), not that it was missing.
  Before (2026-10-06), a selection rewrite came out with a stray English
  word. Every edit removing it was refused as "a diff nested in a diff" and
  reported as "SEARCH not found", so the model re-read and re-sent a correct
  SEARCH twice, then gave up.
- **Pending changes.** A chapter that still carries unreviewed markup is
  shown to the model as "now / was" pairs (`utils/pendingChanges`). "Keep
  what it said before" then restores just that paragraph, and every other
  pending change stays.

### 0.5 Context (D4, D6–D8)

A request is laid out cache-first (cache_first_context.md):

1. **System prompt.** The protocol for this model's write form, plus
   WORKING ACROSS THE BOOK when the agent tools are on: the index, ¶
   numbers, the freshness markers, the chapter attribute, the ending rule,
   and one chapter per reply. It carries no writing guidance.
2. **Ledger.** `REFERENCED CHAPTERS`, with a cache hint. It is append-only
   across turns:
   - a chapter edited since it was sent stays where it was, marked stale,
     and the new version is appended with an UPDATED header;
   - past a stale budget the ledger is consolidated.
3. **History.** Each past turn's chat text, plus one line
   `[Tools used in this turn: …]`. Tool exchanges are not replayed across
   turns; the chapters come back through the ledger.
4. **Volatile tail.**
   - The CHAPTER INDEX, with D8 markers: `[in context]`, `[in context —
     CHANGED since you last saw it]`, `[changed since you read it]`,
     `[read earlier, not in context]`.
   - The active chapter, its pending changes, and the user's request.

How the context behaves:
- **Within a run, nothing already sent is rebuilt**, so every follow-up step
  is an exact-prefix cache hit on grok. Tool-call arguments, Anthropic
  thinking blocks and Gemini thought signatures are replayed byte-exact.
- **The model chooses what to read** from the index (D6); the user steers it
  in the conversation (D7). A chapter the model read is carried into the
  next turn's ledger (`modelReadIds`, score 60).
- **Re-reading is the model's call** (user decision, 2026-10-06). A
  19-chapter run read its outline and sources once, in step 2, and never
  again. The tools refused repeats, and nothing said it could look again.
  - The duplicate guard now refuses only a repeat within the same or the
    previous step. A chapter the request already carries may be read whole
    again from step 3 on.
  - The prompt asks the model to judge, before each chapter, whether to look
    again at what the chapter depends on, reading only what it needs. It may
    also revise the outline when the outline no longer fits; it says what it
    changed (the change is a reviewable diff), and asks before restructuring
    the plan.
  - Rejected: a note in `create_chapter`'s result saying how far back each
    source sits ("read in step 2, ~90k chars ago"). The count would be exact,
    but the model sees its own context, and no number says when it has lost
    track.
- **Paragraphs are lines.**
  - `read_chapter` returns `¶N`-numbered text, or exact HTML for SEARCH.
  - Long chapters come in whole-paragraph parts, and it accepts
    `paragraphs="40-60"`.
  - `grep` reports `¶N` for each hit.

### 0.6 What the user sees

- **The bubble shows the turn in order.** Each step's text is followed by
  the tool calls it made (`agent.timeline`, `AgentTimeline`). While a run is
  going, the step in flight shows as `agent.live`.
- **Below it, "changed this turn"** (本轮修改) lists one row per chapter
  written. Each row has a live review status and a button that opens the
  chapter at its diff.
- **The record is stored** server-side in the `messages.agent` JSON column,
  as trace lines and counts only, never chapter text.
- **Polish** (D9) runs only when the user asks: the Polish button in the
  canvas header, or "润色" in chat, which calls `polish_chapter`. Chunks of
  about 1000 characters go in parallel to a separate polish model. Each
  rewrite is checked against measured bounds, and a chunk that fails keeps
  its draft.

### 0.7 Settings and transports

- **Per-provider settings:**

  | Setting | Default |
  |---|---|
  | `agentTools` | on |
  | `agentMaxSteps` | 6, or 10 for local providers; 0 = no limit |
  | `continueAfterWrites` | on |
  | polish model | grok: `grok-4.20-0309-reasoning` |

  The polish prompt is a separate setting.
- **Transports.** Every step goes through `services/llm.ts` (direct) or a
  backend generation job (`scripts/server_generation.py`, which grok uses).
  Both send `toolChoice` and `reasoningEffort`, and both carry the tool
  messages for every provider shape.
- **Reload.** A rejoined stream renders the step in flight and applies its
  writes. It cannot continue the run (`canContinue` false: one step, no
  continuation after writes). Full resume is phase 3 (§8).
  - The rejoined step continues the bubble's record (steps, trace, timeline,
    changed chapters) instead of replacing it.
  - It also knows what the model had read. The record carries the chapters
    whose HTML the model has seen, each with a hash of its stored content
    (`AgentTurnRecord.seen`, `restoreSeen`). A chapter still stored exactly
    so counts as seen; one the user changed since does not. Before, the
    rejoined step's edit of a chapter read one step earlier was refused as
    "not read yet" (2026-10-06). The list is dropped when the turn ends.
  - When the run would have gone on, the bubble says the reload stopped it
    and that "continue" picks it up. Before, a reload at chapter 19 left the
    turn showing one trace line, with no reason given.

## Implementation history

**Phase 0 (plumbing), done.**
- `LLMMessage` carries `toolCalls` / `toolCallId` / `name`, and `role: 'tool'`.
- The provider shapes are built in `services/providerMessages.ts` (browser)
  and `scripts/server_generation.py` (backend), with parity tests on both
  sides (`providerMessages.test.ts`, `test_server_generation_tools.py`).
- Argument bytes are replayed exactly as received (`FinishedToolCall.argumentsText`).
- The Anthropic/Gemini adapters translate any tool (`fromOpenAITools`).
  Before this they filtered by the document tools' names.
- The backend's Anthropic and Gemini paths had never sent `tools` or read
  tool calls back. Both now do.

**Phase 1 (extract), done.**
- `src/agent/` holds `types`, `registry` (`defineTool`, `ToolRegistry`),
  `invocations` (`collectStep`, `planWrites`), `policy` (`decideAfterStep`,
  `detectStepFailure`, budgets), `run` (`AgentRun`) and
  `tools/documentWrites`.
- `useChatLLM` builds the ports (`buildToolContext`) and an `AgentRun` per
  turn. Its `onDone` hands the step to `run.stepDone`; the old self-calling
  retry (`startLLMStreamingRef`) is gone.
- The controller is callback-driven, so a turn whose tools are synchronous
  settles exactly as before. Every pre-existing `useChatLLM` / rejoin /
  selection flow test passes unmodified.
- The multi-step path (tool results, hybrid write + read, step limit including
  0 = unlimited, failed-write feed-back, Stop between steps) is implemented
  and tested in `src/agent/__tests__/run.test.ts`. The app does not reach it
  yet: no read tool is registered and `DEFAULT_POLICY` keeps feed-back off.
  Phase 2 turns both on.

**Phase 2 (read, navigate, cross-chapter writes), done.**
- The tools:
  - `src/agent/tools/bookReads.ts`: `read_chapter` (list of chapters,
    text/html, paging, duplicate guard), `grep` (was `search_book`), `list_chapters`,
    `open_chapter` and `create_chapter`;
  - `src/agent/chapters.ts`: chapter references, as a number or a title.
- Writes take `chapter`, as a tool argument or a markup attribute on
  `<canvas chapter>` / `<edit chapter>`. The parser groups edit blocks by
  chapter, and extra canvases that name a chapter are applied.
- The seen-content rule, a version snapshot per chapter before its first
  change, and a preview routed by target: another chapter shows a progress
  line, and a created chapter is opened when its first write starts.
- D3 with retryable failures fed back. D5 with the final step sent as
  `toolChoice: 'none'`, in both transports and all providers. D8 markers
  (`src/agent/freshness.ts`). The "changed this turn" block and the step
  trace (`AgentTurnSummary.tsx`). Settings `agentTools`, `agentMaxSteps`
  (0 = unlimited) and `continueAfterWrites`, per provider.
- Anthropic thinking blocks and Gemini `thoughtSignature` are captured and
  replayed byte-exact in both transports. Parallel Gemini calls now get one
  index each.
- Found while testing: a chapter the model read scored only 30 (continuity),
  under the 40 threshold, so D4's "the ledger carries it next turn" did not
  happen. `contextSelection` now has `modelReadIds` worth 60.

Deliberate differences from the pre-loop behavior, each with a test:
- **Plain answers on the tool protocol are no longer retried.** That
  protocol never teaches `<doc_status>`, yet a prose answer was judged
  "undeclared" and retried three times with a tag instruction. `malformed`
  and `claimed` are still caught.
- **Every native write in a reply runs, in order, on the working copy.**
  Before, only the first ran and the rest were reported as stray. A rewrite
  beside a selection is still dropped.
- **Lost or empty arguments are reported.** An `update_document` whose
  arguments never parsed is reported as truncated, and an empty write as
  unusable. Before, both ended in silence.
- **`setStreaming(false)` moves to the end of the run**, after the writes.
  `Editor.tsx` syncs content independently of the flag, and a multi-step run
  must not drop it between steps.

Phase 2 behavior changes, each tested:
- **Failed edits and unusable write calls are handed back to the model.** It
  gets the failed SEARCH text and fixes it, within the 3-round corrective
  budget. A failure handed back is not also warned about. A cut-off rewrite
  or a vanished selection is not retryable and is reported as before.
- **The selection and the offered tools are fixed at a run's first step.**
- **`addDocument` ids carry a random suffix**, so two chapters can be created
  in one millisecond. Version snapshot ids get the same.

Follow-ups from the first browser test (2026-10-05):
- **Switching chapters during a turn is allowed.** The sidebar no longer
  blocks it. Writes target ids, and the live preview tracks the chapter it
  paints (`previewDocIdRef`): once another chapter is open, settling or
  stopping never touches it, and a selection preview stops writing. Reorder
  stays blocked mid-turn, because chapter numbers must keep their meaning.
  The editor stays read-only.
- **"In context — CHANGED since you last saw it".** User-reported: an outline
  revised before "write chapter 6" was re-sent in full by the ledger, so the
  model had the new text. Nothing told it the text was new, though, and its
  earlier replies were planned against the old one. Index lines of in-context
  chapters whose hash differs from what the model last saw now say so (D8).
- Measured on that turn: step 1 hit 4,224 of 46,312 cached tokens (9%). The
  edited outline was dropped from its ledger slot and re-appended, which
  invalidated everything after it. See "Prior art" for the append-update
  alternative.

A change still under review stays under review (user-reported, 2026-10-06).
Two cases:
- asking for another change while the previous one was unreviewed silently
  accepted the previous one;
- "why did you change this? keep what it said before" could not be done
  exactly, because the model had never seen the earlier wording.

Two readings of a chapter with pending markup:
- **The model still writes against the ACCEPTED reading**, because its
  SEARCH text must be copyable.
- **The review diff is drawn from the REJECTED reading** (`DocState.reviewBase`
  = `resolveDiffMarkupInHtml(original, 'reject')`, the same function
  reject-all uses), so everything unconfirmed stays one pending diff.
  Reject-all returns exactly the last confirmed text. The Polish button
  follows the same rule.

The model is also shown what each pending change replaced:
`utils/pendingChanges` lists "now / was" per changed paragraph, appended to
the active chapter in the tail, and to `read_chapter` results for other
chapters. It comes with the instruction to restore only the part asked for.
A restored paragraph then matches the confirmed text, so its diff is gone,
while every other pending change remains. Without pending markup the tail is
byte-identical to before.

Known gaps:
- The Anthropic replay approximates order as thinking → text → tool_use. A
  reply that interleaves text between thinking blocks is reordered on replay.
- Gemini signatures on text parts are not captured (recommended by the docs,
  not enforced).
- The docs say Claude 4.7+ models reject `thinking: {type: "enabled"}`. The
  backend's reasoning-effort retry probably catches it; the direct path does
  not.
- A full rewrite of a chapter that is not open shows progress only, with no
  live text. A second chapter rewritten in the same reply also gets no
  preview.
Primary target: **grok** (grok-4.5 / grok-4.6 over the backend job transport).
Other providers must keep working, but every trade-off below is decided by
what grok does, because grok is what this app is used with day to day.

## 1. What changes, in one paragraph

Today a chat turn is **one model call**: `useChatLLM` assembles a prompt
(system + ledger + history + volatile tail), streams one reply, and `onDone`
classifies it (canvas / edits / selection / chat) and applies it. The model
cannot look at a chapter it was not handed, cannot switch chapters, and cannot
see whether its edit landed. This design turns a turn into a **loop of steps**:
each step is one model call; the model may call tools (read a chapter, search
the book, open another chapter, edit the document); the client executes them,
feeds the results back, and calls the model again until it answers without a
tool call, a stop condition fires, or the user presses Stop. Tools live in a
registry, so adding one is one file plus one line.

## 2. What exists today (and must keep working)

| Capability | Where | Fate in the loop |
|---|---|---|
| Full rewrite (`<canvas>` / `update_document`) with live preview | `useChatLLM` `onChunk` / `onToolCallDelta` | Write tool `update_document`, `preview()` hook |
| Search/replace edits (`<edit>` / `edit_document`), span diffs | `applyEditBlocks`, `applyEditBlocksLocally` | Write tool `edit_document`; **failures are fed back** instead of only warned |
| Selection rewrite (`<selection_replace>` / `replace_selection`) + edits beside it | `replaceSelectionWithHtml` | Write tool `replace_selection` |
| `<doc_status>` checks + no-action retry (3 rounds) | `detectFailedDocumentUpdate`, `NO_ACTION_RETRY_INSTRUCTION` | Becomes a **corrective step** inside the loop (same budget) |
| Truncation / elision guard, image placeholder reinsertion | `validateCanvasReplacement`, `reinsertMissingImages` | Inside `update_document.execute`; failure → tool error result |
| Layer-1 auto-attach + cache ledger | `selectReferenceChapters`, `planLedgerTurn` | Kept as the **prefetch**; tool reads feed the next turn's continuity signal |
| Whole-book Rung 0/1/sticky | `wholeBook.ts`, `assembleChatRequest` | Kept as prompt-assembly modes (user-initiated) |
| Whole-book Rung 2 batched map-reduce + consent card | `runWholeBookBatches` | Becomes approval-gated tool `analyze_book` (phase 3) |
| Stop keeps the half-streamed draft as one undo step | `keepCanvasPreview` | Unchanged; applies to the step in flight. Earlier steps' writes are already committed |
| Resumable backend jobs, rejoin after reload | `remoteGeneration.ts`, `server_generation.py` | One job **per step**; run state persisted on the bubble (phase 3) |
| Version snapshot before a send | `createVersionSnapshot` | Taken lazily before the **first write to each document** in a run |
| Roleplay GM mode | `useRoleplayLLM.ts` | Out of scope; the runtime is built so it can become a second tool profile |

## 3. Grok facts that drive the design

All measured in this repo (see the cited files/decision-log rows), not assumed:

1. **Tool arguments arrive in one delta.** Same request, same document: tool
   args came in ONE 113-char delta vs 54 content deltas
   (`utils/protocolChoice.ts`). Hence grok is on the **markup** protocol under
   `auto` — a native `update_document` call would kill the live preview.
   *Unmeasured:* whether a 7k-char chapter rewrite also arrives as one delta, or
   whether the 113-char case was just short. Measure before deciding anything
   else about grok writes (§10, M1).
2. **Time to first token is long and paid per call.** grok-4.6 at its default
   `high` effort: 127–199 s before the first visible token; the app default is
   `low` (`utils/reasoningEffort.ts`). Rejoins measured 230 s to first token.
   **Every extra loop step pays this again.** Step count is the dominant cost
   for grok, far ahead of tokens.
3. **Automatic exact-prefix cache, routed by `x-grok-conv-id`**
   (`utils/providerProfile.ts`). Both transports send the header
   (`conversationId = activeBookId`). Append-only prompts are what make
   follow-up steps cheap.
4. **Long-context price cliff at 200k prompt tokens, counting CACHED tokens**
   (`longContextThreshold`). A loop accumulates tool results; a long run can
   cross the cliff while the hit rate looks perfect.
5. **Bare-acknowledgement failure.** grok-4.5 often answers a write request
   with prose and no markup — per-round success drifted between 22% and 65%
   for an identical prompt, uncorrelated with prompt wording
   (decision log 2026-07-25; `MAX_NO_ACTION_RETRIES = 3` from the measured
   curve). The loop must keep this recovery, not regress it.
6. **Grok runs through the backend job transport** for any logged-in client.
   `server_generation.build_openai_request` currently copies only `role` and
   `content` per message — tool-call history would be silently dropped there,
   the same class of bug as the dropped `conversationId` / `reasoningEffort`.

## 4. Decisions

### D1. Grok writes stay on markup; reads/navigation become native tools (hybrid)

A step's output is normalized into **tool invocations** regardless of how they
arrived:

```
native tool_calls ──┐
                    ├──► ToolInvocation[] ──► registry.execute()
<canvas>/<edit>/    │
<selection_replace>─┘   (MarkupToolSource parses them into the SAME
                         update_document / edit_document / replace_selection
                         invocations)
```

For grok under `auto`:
- **Write tools are NOT offered natively** (they arrive as markup → preview
  survives). Offering both is exactly what the protocol-choice comment warns
  against: the model mixes them.
- **Read / navigate tools ARE offered natively.** A `read_chapter` call needs
  no preview, so grok's one-delta delivery costs nothing there.

For tool-protocol providers (ollama/runpod/Qwen): everything is native.
For `markup` with tools disabled (or a provider that rejects `tools`): the loop
degenerates to one step + the corrective step — today's behavior exactly.

**Decided (user, 2026-10-05):** measurement M1 settles it. If grok streams a
long tool argument in fragments, grok goes all-native and the hybrid is
dropped; otherwise the hybrid stays, so the live preview survives.

M2 still checks that grok follows the hybrid at all, which means calling
`read_chapter` natively and then writing with markup. The earlier worry, that
grok writes a chapter before reading it, is now handled mechanically by D2's
seen-content rule rather than by prompt wording.

### D2. Writes may target any chapter; every touched chapter is listed in chat

**Decided (user, 2026-10-05).** Write tools take an optional `chapter`
argument: the exact title or the number shown in the chapter index. When it
is absent, the write goes to the active chapter. The model does not have to
switch the user's view to edit elsewhere, and the editor stays where the user
put it.

**Two write paths, one result shape:**

| Target | Path | Live preview | Undo |
|---|---|---|---|
| active chapter | the editor, exactly as today (`EditorPort`) | yes | Ctrl+Z, as today |
| any other chapter | the run working copy (§5.3) → `updateDocument(id, …)` with the review diff | progress line in the chat bubble ("rewriting 《第五章》… 3.2k chars"), never the editor | diff review (reject all) + a per-chapter version snapshot taken before the run's first write to it |
| a chapter **created in this run** | opened in the editor when it is created (D6), then the active-chapter path | yes | as the active chapter |

The preview must be routed by target. The current streaming path paints any
`<canvas>` text into the editor; a `<canvas chapter="第五章">` painted over the
open chapter would be data loss on screen. On markup, the target is an
optional `chapter="…"` attribute on `<canvas>` and `<edit>` (§7).

**Seen-content rule (checkable, replaces prompt pleading).** `edit_document`
on a chapter is refused unless this run has shown the model that chapter's
**HTML**. The active chapter is in the volatile tail; any other chapter must
come from `read_chapter(…, format: "html")`. Ledger chapters do not count,
because they are rendered as plain text and a SEARCH copied from them will not
match the HTML. The refusal is a tool error ("call read_chapter … first"), so
the model recovers within the loop. `update_document` on a chapter with
content requires the same; on an empty or new chapter it does not.

**Every touched chapter is presented in the chat.** The assistant bubble gets
a "本轮修改" (changed this turn) block, live during the run and persisted
afterwards. It has one row per chapter written:

- chapter title, plus what happened: "3 处修改" (3 changes) / "整章重写"
  (full rewrite) / "选区改写" (selection rewrite), and "1 处未能定位" (1 edit
  could not be located) when an edit failed;
- a status computed **live** from the chapter's current content: 有待审阅修改
  (has diff markup) / 已处理 (resolved), so it stays true after the user
  accepts or rejects;
- **查看** (view): `setActiveDocumentId(id)`, wait for the content, scroll to
  the first `.diff-addition` / `.diff-deletion`. The active chapter gets a row
  too, so the list is uniform;
- a deleted chapter shows a disabled row ("章节已删除", chapter deleted).

`open_chapter` stays as a tool. It no longer gates writes; its job is
showing the user a chapter ("open the chapter you just changed"). It is
refused while a selection rewrite is pending in this run, and
`replace_selection` only ever targets the chapter the selection was made in.

Two store fixes this depends on (found while checking the write path):
- **Blanking guard.** "Refuse to blank a non-empty chapter" lives only in
  `updateActiveDocument`, and `updateDocument` has no such check. Move it to
  where both converge, or the new path is the one that empties a chapter.
- **Snapshots.** `createVersionSnapshot` snapshots only the active document.
  Add a `documentId` parameter.

Persistence needs no change: the debounced sync PUTs every loaded document
that differs from its last PUT (`booksSlice`), whether or not it is active.

### D3. Ending the loop after writes

The concern this answers (user, 2026-10-05): with "end after a successful
write", can the model edit one chapter and then move on to the next? **As
first written, no.** A step that edited chapter 3 and nothing else ended the
run before the model could open chapter 4. Revised policy, applied per step
after executing its invocations:

| Step contained | Next |
|---|---|
| no invocations | **end** (the text is the answer), after the `<doc_status>` check on markup |
| only writes, all succeeded, `continueAfterWrites` on (the default) | **continue**: the write's result goes back like any tool result; the model keeps working, or ends with a reply that has no action |
| only writes, all succeeded, `continueAfterWrites` off | **end**; the step's chat text is the reply |
| writes **and** any read / navigate call | **continue**. "Edit chapter 3 + read chapter 4" in one step is how the model says "there is more" |
| any read / navigate call | **continue** (the model asked for information) |
| any write that failed (unmatched SEARCH, truncated, elided, bad args, seen-content rule) | **continue** with the error as the tool result (§5.3), counted against the corrective budget |
| a markup protocol failure (`undeclared` / `claimed` / `malformed`) | **continue** with `NO_ACTION_RETRY_INSTRUCTION` as a corrective step |

With D2, the usual multi-chapter flow takes **two steps**, with no
confirmation round: step 1 reads chapters 3 and 4 in parallel, and step 2
edits both and ends. The sequential case ("change 3, then adapt 4 to it") is
step 1 editing 3 while reading 4, then step 2 editing 4.

**Writes continue the turn** (user decision, 2026-10-06). A write is a tool
call like any other: its result goes back to the model, and the turn ends
only on a reply with no action. This is the loop Claude Code and Codex run,
and `continueAfterWrites` now defaults to **on for every provider** (still a
setting, per provider). Why "end after a write" was dropped:
- Its reason was latency: grok at `high` effort was measured at 127–199 s to
  its first token, so one more step looked expensive. The logs now show a
  step that follows a tool result and needs no new planning reaching its
  first token in 1–6 s (5.6 s for step 2 of the last measured run); only steps that plan new
  work are slow, and that time is spent either way.
- Ending on a write-only reply produced three measured failures: grok
  created every chapter first and then packed them into one reply; the
  chapters came out squeezed short; and a run that had created two chapters
  ended after writing the first, leaving the second empty (the workaround
  "create chapter N+1 in the reply that writes chapter N" breaks as soon as
  the model creates ahead).

Three rules come with it:
- **The closing reply is taken at its word.** After a write succeeded in the
  run, the reply that ends it ("both chapters are written") refers to those
  writes: a missing `<doc_status>`, or `updated` with no markup of its own,
  is not a failed update (`detectStepFailure`'s `wroteThisRun`). Broken
  markup still is. Without this every written turn would end in a
  corrective retry.
- **A write on the last allowed step is done**, not cut off: the run ends as
  `writes_done`, not `step_limit` (`decideAfterStep`). A step that still
  wanted something (a read, a fix) is reported as the limit.
- **A rejoined stream** (`canContinue` false) has no request to continue
  from, so the setting is forced off there.

The cost is one closing step per written turn, usually a few seconds. Off
restores the old behavior: the protocol then says a write-only reply ends
the turn, and `create_chapter`'s result teaches creating the next chapter in
the reply that writes this one.

### D4. One run = one append-only message list

Within a run, earlier messages are **never rebuilt**. The volatile tail (chapter
index + active document) is rendered once, into the first user message, and
stays byte-identical for every step. State changes reach the model only through
tool results ("now active: Chapter 5", the fresh text of a read, the result of
an edit). This is what makes step N+1 a pure cache hit on grok's prefix (fact
3). Corollary: assistant tool-call messages are replayed with the
**argument string exactly as received**, never re-serialized from parsed JSON.

Across turns, the history stores the turn's final chat text plus one compact
trace line (`[tools: read_chapter "第三章", edit_document "第五章" ×2]`),
**not** the tool exchanges. Chapters the model read are added to
`previousAttachedIdsRef`, so the scorer's continuity signal admits them into
the ledger next turn — where they are cached properly instead of being
replayed as tool output.

### D5. Run budgets, enforced by the loop, not the model

- `maxSteps`: **a per-provider setting** (`ProviderConfig.agentMaxSteps`,
  edited in Settings beside the document protocol). Defaults are 6 for grok
  and 10 for local models. **`0` means no step limit** (user, 2026-10-05).
  With 0, the run still ends on a final answer, Stop, the corrective budget,
  and the duplicate guard. When the limit is
  hit, the last step is sent with `tool_choice: "none"` so the turn still
  ends in an answer, and the bubble says the limit was reached
  ("已达步数上限（6）" (step limit reached, 6)). The field is optional:
  absent means the provider default, so stored settings need no migration.
  A test still feeds a config without the field through
  `settingsPersistence` and asserts the default.
- `maxCorrectiveSteps` = `MAX_NO_ACTION_RETRIES` (3) — shared by markup
  failures and failed writes, so the measured recovery curve is preserved.
- **Prompt-token ceiling — dropped (user decision, 2026-10-06).** The plan:
  as grok's context nears its 200k price cliff, send the next step with
  `tool_choice: "none"` and an "answer now" note, i.e. end the turn. The
  user does not want a turn cut short for its size. A long run that nears
  the cliff should shrink its context instead (compaction, phase 4). It was
  never implemented. Measured the same day: one run reached 148k tokens
  while marking up an outline.
- Per-result caps: `read_chapter` returns at most 20k chars (the same cap as the
  ledger, `MAX_LEDGER_DOC_CHARS`) with `offset` paging; `grep` at most
  N snippets.
- Duplicate guard: an identical `(name, arguments)` read in the same run returns
  "already provided in step k" instead of the text again.

### D6. The model finds the chapters it needs from the index

**Decided (user, 2026-10-05).** A request like "根据小说大纲写第一章" ("write
chapter 1 from the novel's outline") must work even when no chapter is called
大纲 (outline). Deciding which chapter is the outline is the model's job, done
from the chapter index. Title matching only saves a step when it happens to
hit.

- **What the model already has.** Every request carries the `CHAPTER INDEX`
  (`buildChapterIndex`): every chapter numbered, with its title and a digest.
  The digest is the generated summary, or else the first 300 chars of text,
  capped at 400 chars (150 above 40 chapters). An outline titled 故事线 or
  设定集 reads as an outline from its digest alone.
- **The rule.** `read_chapter` takes the index number. Its description says:
  find the chapter in the CHAPTER INDEX and pass its number; when no title or
  digest tells you where something is, use `grep`.
- **Prefetch.** The Layer-1 scorer (`selectReferenceChapters`) stays. When it
  attaches the right chapter, the model can write in the first step. When it
  misses, the cost is one `read_chapter` step, not a wrong answer.
  `detectReferencedDocIds` only matches a title that appears whole in the
  prompt, so "大纲" never finds a chapter called 故事线.

Gaps to close in phase 2 (found in the code):
1. **Empty digests.** A chapter that has no generated summary and whose
   content has not lazy-loaded yet has an empty digest, so the model sees
   only its title. The index marks such lines `(not summarized yet)`, so the
   model knows the title is all it has. `grep` loads contents
   (`ensureDocumentContents`) before searching. An optional server-side fix
   is to return a short text excerpt with the chapter list metadata.
2. **The active chapter's index line** says "[ACTIVE — this is the document
   you can edit]", which contradicts D2. It becomes "[ACTIVE — open in the
   editor; writes go here unless you name another chapter]". It lives in the
   per-turn tail, so the cache is unaffected.
3. **One step for create + write.** When the outline is already in context,
   "write chapter 1" is a single step on grok: a native
   `create_chapter("第一章")` plus `<canvas chapter="第一章">` in the same reply.
   Non-write calls run before writes within a step (`AgentRun.stepDone`), and
   a new, empty chapter needs no prior read (D2's seen-content rule).

**Decided (user, 2026-10-05; revised 2026-10-06): a chapter created in this
run opens in the editor as soon as it is created.** It was first opened
"when its first write starts", but the step after `create_chapter` spends
20–60 s planning the chapter before its first token, and the user sat on the
old chapter meanwhile. That wait is reasoning, not cache: the step was
measured at 94% cached and still took 56.7 s to its first token. A pending
selection rewrite keeps the view where it is. Writes to chapters that
already existed still never switch the view (D2).

**Writing a series: one chapter per reply** (user decision, 2026-10-06).
Measured on "开始逐章节写作一直写完" ("write the chapters one by one until
done"):
- Told only that a write-only reply ends the turn, grok created four
  chapters in four steps. Each step took 28–66 s of reasoning (step 2: 3,542
  reasoning tokens for 41 output tokens) and produced no text.
- It then wrote all four in ONE reply. Only the first previewed live, and
  each chapter was squeezed to fit one output (902 chars for chapter 1).

The rule now taught in the protocol section: **one chapter per reply** —
the model continues after each (D3, writes continue the turn). Each chapter
gets its own step, a full output budget, and a live preview: it was opened
when created, and the preview follows the run from chapter to chapter (it
restarts on the newly open chapter, so Stop keeps that chapter's partial
draft). A chapter created in the same reply as its own `<canvas>` cannot be
previewed until the reply ends, so it shows as a progress line.

First version (same day), superseded: with writes ending the turn, the
reply that wrote chapter N had to create chapter N+1 to keep the run going.
A real run broke it at once — grok created two chapters up front, wrote the
first, and the turn ended with the second empty. A "continue while created
chapters are empty" safety net was offered and not chosen; making writes
continue the turn (D3) removed the need for it.

Note the budget: N chapters take up to 2N+1 steps (create, write, …, close),
more than grok's default `agentMaxSteps` of 6 allows for a long series.
Raise it, or set 0, for "write until done".

Same day, measured on a real turn: the model refused-created an existing
chapter, then called `open_chapter` twice before rewriting, which was two
wasted steps. `open_chapter`'s result had said "read it with format html
before editing it", which invites exactly that. Results now name the next
write in the model's own form (`RunState.writeProtocol`: `<canvas
chapter="N">` on markup, `update_document chapter="N"` with tools), say a
full rewrite needs no read, and `open_chapter` is described as "only to
show the user". Creating a chapter from a `<canvas chapter>` that names no
existing chapter was considered and declined: new chapters stay explicit
(user decision).

**Revised 2026-10-06: creating IS writing.** The user asked whether grok's
reasoning is cached, and to force a chapter's creation and its first draft
into one step. Measured on two turns:
- "写第一章": the first step thought for 158.8 s (2,732 chars of reasoning
  summary) and emitted 37 chars of text plus `create_chapter`. The next
  thought for 33 s and claimed "第一章按大纲写好了" with no write; the text
  landed two steps later.
- "继续写第二章": the create step thought for 105 s; the write after it
  started at once (1.7 s).

The prompt cache covers a request's input only. Reasoning is output: it is
generated again in every step, and on Chat Completions it cannot be sent
back at all (only xAI's Responses API carries encrypted reasoning to the
next request, with no documented latency gain). So a step that only creates
throws its planning away.

`create_chapter` is retired. The write creates its chapter, explicitly:
`<canvas new_chapter="title">` / `update_document` `new_chapter`. A
same-reply `create_chapter` plus `<canvas chapter>` was always allowed (item
3 above); grok did not use it. A chapter created that way could not be
previewed until the reply ended, either. Now the opening tag creates the
chapter mid-stream, and the preview runs in it (`claimNewChapter`).

### D7. No manual context selection

**Decided (user, 2026-10-05); implemented 2026-10-06.** The user no longer picks context by hand.

As built, against the plan below:
- **Removed:** the attach bar (pin, block, and the live preview of
  auto-selected tags), the whole-book toggle and the consent card, together
  with `wholeBook.ts`, `planWholeBook`, the sticky prefix, `cycleReferenceState`,
  `pinnedReferenceIds` / `blockedReferenceIds` and `wholeBookMode`. Its
  localStorage key is deleted on init (`clearRetiredSettings`).
- **Migration:** the per-document IndexedDB records get a **v3 → v4**
  migration that drops the reference fields, with a test that feeds a v3
  index. The legacy whole-array shapes (v0–v2) drop them too.
- **`analyze_book`** is the batched map-reduce: `agent/analyzeBook.ts` does
  the batching, and the hook's `analyze` port supplies the chat model with a
  cache key of its own. There is no consent card; the trace shows the call
  count.
- **Not built:** the digest tool ("fast mode"). `list_chapters` already
  returns the index with every chapter's summary, so `buildWholeBookDigest`
  was removed.
- **Not done yet:** a provider-sized ledger budget. The prefetch still works
  within the fixed 60k selection budget.
- **Tests:** the cache-first flow tests put chapters in the ledger by naming
  them in the request instead of pinning them.

The original plan:
The model decides what to read, and the user steers it in the conversation
("参考第三章" (refer to chapter 3), "别看番外" (skip the side stories)).

Removed, with what replaces each:

| Manual control today | Where | Replaced by |
|---|---|---|
| Pin a chapter (always attach) | attach bar in `ChatPanel`, `pinnedReferenceIds` per document | The model reads it with `read_chapter` when needed. When the user names the chapter in a message, the title-mention prefetch attaches it with no extra step |
| Block a chapter (never auto-attach) | same bar, `blockedReferenceIds` | Saying so in the conversation. This is **soft**: it depends on the model complying, and the prefetch cannot read negation |
| Whole book, once (attach every chapter) | 📚 toggle, `wholeBookMode: 'once'` | The model reads what it needs, several chapters per step (`read_chapter` takes a list of numbers) |
| Whole book, sticky (book in the cached prefix) | `wholeBookMode: 'sticky'` | Chapters read this turn enter the ledger next turn (continuity), so a whole-book discussion is cached from its second turn on. The ledger budget comes from the provider (`targetPromptTokens`, i.e. grok's 200k cliff), not from the fixed 60k auto-selection budget |
| Whole book, fast mode (structure + summaries) | consent card "fast" | A read tool returning `buildWholeBookDigest` (heading tree + summaries) |
| Batched map-reduce + cost consent card | `runWholeBookBatches`, consent card | The `analyze_book(question)` tool. **No consent card.** Its call count and cost show in the step trace, and the step limit stops a runaway run |

What stays automatic (it was never manual):
- **The prefetch.** The Layer-1 scorer still attaches chapters before the
  first step: a title mentioned in the message, the chapters adjacent to the
  active one, keyword overlap, and continuity. A chapter that is already
  attached costs grok no step; every missed chapter costs one first-token
  wait.
- **The ledger.** It is cache-first and append-only, and chapters the model
  read are admitted by continuity.

What the user still sees: the `[Attached Context: …]` label on each bubble
(what the prefetch attached) and the step trace (what the model chose to
read). Context becomes visible after the fact instead of controlled
beforehand.

Removal checklist:
- the attach bar, the whole-book toggle and the consent card in `ChatPanel`,
  with their i18n strings;
- `planWholeBook`, `stickyConsentGivenRef`, `buildStickyBookPrefix` and the
  whole-book branches of `assembleChatRequest`. `runWholeBookBatches` and
  `packChaptersIntoBatches` move behind `analyze_book`;
- `pinnedReferenceIds` / `blockedReferenceIds`:
  - removed from the store, `CanvasDocument` and `cycleReferenceState`;
  - the documents envelope gets a **v2→v3 migration** that drops them, with a
    test that feeds a v2 payload (CLAUDE.md persistence rule);
  - the roleplay mode's empty initializers go too;
- `wholeBookMode` and its localStorage key (deleted on init);
- `selectReferenceChapters` loses its `pinnedIds` / `blockedIds` inputs. The
  cache-first flow test "puts the pinned chapter ahead of the history" is
  rewritten to put a title-mentioned chapter there.

Trade-offs, stated plainly:
1. **Exclusion is no longer a guarantee.** "别参考番外" is an instruction, not
   a filter.
2. **A chapter the user would have pinned may now cost one step** on grok
   when the prefetch misses it. That is a wait of up to one first token,
   paid only when the model decides it needs the chapter.

### D8. Freshness markers: the model knows what it has, and whether it changed

**Decided (2026-10-05, from the user's question** "should a last-saved
timestamp version system tell the agent when to re-read a chapter?"). The
answer is yes to the goal, but the mechanism is a content-hash record
attached to the chapter index, not a version-control system and not
timestamps.

**What already works.** The ledger stores each chapter's content hash and
re-sends any chapter whose hash changed (`planLedgerTurn`'s `'edited'`
drop). A chapter that is IN context is always current.

**The gap.** The model cannot tell what is in context. The index header only
says that full text appears "if it is in REFERENCED DOCUMENT CONTEXTS or is
the active document", so the model has to infer it, and each wrong guess
costs something:
- re-reading a chapter it already has costs one step, a full first-token
  wait on grok;
- trusting a chapter it read two turns ago gives a stale answer. Tool
  results are not replayed across turns (D4), so that text is gone, and the
  chapter may have changed since: the user rejected the agent's diff, or
  rewrote the outline.

**Mechanism.**
- **The seen record** (`seen: Map<docId, { hash, turn }>`) is session-scoped
  with the same scope as the ledger (book + provider + model). It is updated
  every time the model is shown a chapter's full text: the ledger or an
  inline attachment, the active chapter in the tail, a `read_chapter`
  result, or the model's own successful write.
- **What is hashed is the ACCEPTED reading** (`stripDiffMarkup`). Accepting
  the agent's own diff is therefore not a change, while rejecting it is, and
  the model needs to learn that its edit was rejected.
- **Each index line carries a marker.** The index is in the per-turn tail,
  so markers changing never cost the cached prefix:
  - `[in context]`: the full text is in this request;
  - `[changed since you read it]`: seen before, the hash differs now, and it
    is not in context;
  - `[read earlier, not in context]`: seen before and unchanged, but its text
    is no longer in this request;
  - no marker: never shown to the model.
- **`read_chapter` results say the same**, e.g. "第三章 — unchanged since turn
  4" (chapter 3) or "— changed since you last read it".
- **The duplicate guard (D5) keys on the hash.** Asking for the same chapter
  with the same hash while it is in context returns "already provided in step
  k", not the text again.

**Why not timestamps.** The question the model needs answered is "is this the
same text I saw?", and a hash answers exactly that. `updatedAt` answers "was
something saved?":
- it moves when no text changed;
- it compares clocks across devices;
- it cannot tell "the user accepted my diff" (no change for the model) from
  "the user rejected it" (a change).

**Not persisted.** After a reload nothing counts as seen across turns
except what the ledger re-sends (within the turn in flight, the run's own
seen list does survive: §0, Reload). That is correct, because a reloaded session's prompt prefix
is new anyway. The user-facing version history (`DocumentVersion` snapshots)
is a separate feature and is unchanged.

### D9. Polish pass — on the user's request only (implemented 2026-10-06)

**Decided (user, 2026-10-05): polish runs only when the user asks.** It is
not a step after every full-chapter write. It has two entry points:
- the **Polish button** in the canvas header (`requestPolish` → the chat
  hook's `runPolish`). It polishes the open chapter directly, with no chat
  model, so there is no first-token wait for a decision the user already
  made. It shows as a turn of its own: a user line, then a reply carrying the
  chapter in its "changed this turn" block;
- the **`polish_chapter` tool**. Its description says to call it only when the
  user explicitly asks (e.g. "润色第六章", "polish chapter 6"). It has no tag
  form, so it is offered natively even on the markup protocol (D1; the
  `markupForm` flag). After a polish, the chapter's HTML counts as unseen
  again, so an edit has to read it first.

Both paths use `polishHtml` (`src/agent/polish.ts`) and the pure helpers in
`src/utils/polish.ts`:
- every chunk is sent in parallel;
- each chunk is validated, and one that fails keeps its draft;
- Stop keeps the chunks that finished;
- the result is one diff against the accepted reading, with a version
  snapshot first.

Settings:
- `ProviderConfig.polishModel` — absent means `grok-4.20-0309-reasoning` on
  grok, else the chat model;
- the polish prompt (system + per-chunk template), user-editable, stored as
  a versioned localStorage envelope (`web_canvas_polish_prompt`, v1). The
  default is the tuning session's prompt. The user's writing preset is
  appended to the system prompt.

Polish calls send no reasoning effort and use their own
`x-grok-conv-id` (`<book>:polish`).

The rest of this section is the original proposal and its evaluation, kept
for the record. Points 1 and 6 assumed an automatic pass; the user's decision
replaces that trigger.

**Source.** Proposed 2026-10-05 by the user's prose-tuning session
("老头修仙记"), from measurements on a real chapter request (the book's own
prompt assembly, grok on markup).

**The measurements.** Metric: the narration's clause rhythm, with dialogue
excluded. Human reference (four source posts): mean clause 10.7 chars, 20.7%
of clauses at most 6 chars, 0.9 runs per thousand chars of three or more such
clauses.

| Draft | Mean clause (chars) | ≤6-char clauses | Runs / 1k chars | Notes |
|---|---|---|---|---|
| grok-4.6, no polish | 7.6 | 43% | 5.4 | |
| grok-4.7 | 7.2 | 48% | 7.3 | newer models were choppier |
| grok-4.6 + 4.20-reasoning, whole-chapter rewrite | — | — | — | 97–100% copied verbatim; no effect |
| grok-4.6 + 4.20-reasoning, ~1000-char chunks rewritten in parallel, tightened instructions | 9.4 | 22% | 1.1 | all dialogue kept; length +15%; no run-on over 25 chars; ~35 s per chapter |

Each condition was run n = 5. The metrics measure rhythm only, not content;
the user is still reading the samples.

**Decision as proposed:**
- **A fixed pipeline step, not a tool.** The model would not call it
  reliably, and its cost and latency should be predictable.
- It applies only to full-chapter writes (`update_document` / `<canvas>`).
- It is off unless `ProviderConfig.polishModel` is set.

**Evaluation (this session), with changes to the proposal:**
1. **When: at the end of the run, not right after the write.** Polishing the
   working copy mid-run would break the model's next `<edit>` on that
   chapter, because its SEARCH text is copied from its own draft. At the run's
   end, every chapter fully rewritten this run is polished from its final
   working copy, and the review diff is `base → polished`. Under D3 the write
   step is usually the last step anyway, so this costs no latency.
2. **The polish instructions are a user-editable preset, not code.** They are
   writing guidance, and CLAUDE.md keeps writing guidance out of the
   protocol prompt and with the user's presets. The default is the prompt the
   tuning session settled on.
3. **The validation thresholds must sit above the measured expansion.**
   Confirmed by the per-chunk measurement below: ±15% would have sent 43% of
   the chunks back to their draft.
4. **Chunks keep the HTML and the image tokens.** Chunks split on block
   boundaries (`<p>`, headings) of the working HTML, not on plain text. A
   chunk is also sent back if a heading or an `{{IMAGE_PLACEHOLDER_n}}` is
   lost.
5. **A separate cache key.** Polish requests share no prefix with the
   conversation, so they get their own `x-grok-conv-id` (book id +
   `:polish`) rather than competing on the book's cache shard.
6. **Shown in the bubble.** One timeline line, e.g. "✨ polished #6 (5/6
   chunks; 1 kept as drafted)". While it runs, "润色中 k/n" (polishing k/n).
   The live preview still streams the draft (D1 exists for it), and the
   editor then swaps in the polished text. The diff base never changes.
7. **Stop** keeps finished chunks and drops the rest. **Budget**: outside
   `agentMaxSteps`, inside token accounting. **Resume**: one backend job per
   chunk (meta: runId, chunk); a full resume waits for phase 3.
8. **Dependency.** grok-4.20 rejects `reasoning_effort`. The fix is on branch
   `feat/grok-reasoning-models` (uncommitted, per the tuning session), so
   polish calls to it must not send the parameter.

**Per-chunk measurement (tuning session, 2026-10-05).** Setup: the same
chunk prompt, grok-4.20-0309-reasoning, 10 chapters of grok-4.6 drafts.
That gave 51 chunks of 69–1080 chars, holding 159 dialogue lines.

Length change per chunk: mean +13.8%, median +14.0%, P10 +6.5%, P90 +22.0%,
range −2.8%…+27.9%. Chunks almost only grow; short tail chunks behave the
same.

Fall-back rate by threshold:

| Run-on bound (chars) | Length bound | Fall-back |
|---|---|---|
| — | ±15% | 22/51 (43%) |
| — | −10%…+25% | 4/51 (8%) |
| >25 | −10%…+25% | 13/51 (25%) |
| >30 | −10%…+25% | 6/51 (12%) |
| **>30** | **−10%…+30%** | **2/51 (4%)** |

The run-on bound is 30, not 25: nine chunks peak at 26–28 chars, and the
human source posts peak at 28–43. The one chunk that genuinely reads badly
is a 59-char unbroken run, and 30 still catches it.

Other results:
- Dialogue: 1 of 159 lines lost, in one chunk. The per-chunk dialogue check
  catches it and that chunk falls back.
- Paragraphs: two chunks merged two paragraphs into one (18→17, 14→13).
  Requiring equal `<p>` counts would reject them for nothing.
- Time: 25.6 s per chunk on average. A chapter is about 5 chunks sent in
  parallel, so it takes 26–53 s; serially it would be over 2 minutes.
  **Chunks must be sent in parallel.**

**Validation, per chunk:**
- every dialogue line kept verbatim;
- length change −10%…+30%;
- no unbroken run over 30 chars;
- every heading and every image token kept;
- `<p>` count at least the original's minus one.

A chunk that fails any check keeps its draft. The default preset is the
tuning session's chunk prompt (`chunk2_template.json`, backed up with the
data in this session's scratchpad `d9/`). Copy it into the repo when this is
implemented.

**Measurement M5 (before defaults):** n ≥ 8 per condition, as §10 requires.
The run above is one pass over one set of 10 chapters: repeat it on other
chapters, and several times, before fixing the thresholds.
Measure:
- the per-chunk length-change distribution, to set the bound;
- the fall-back rate at the chosen bounds;
- dialogue preservation;
- time per chapter.

The user's read of the samples decides whether the rhythm gain is worth the
+15% length.

### Prior art: what Codex and Claude Code do

Researched 2026-10-05, at the user's request, in a local clone of the Codex
CLI (`~/Workspace/codex-deskd/codex-rs`). Claude Code's own behaviour is
observable in the sessions that built this. What each does, and what this
design took from it:

| Question | Codex | Claude Code | This design |
|---|---|---|---|
| Does the model learn that content it read has changed? | **No.** No mtime/hash tracking and no read-before-edit check. `apply_patch` fails when its context lines no longer match; that failure is the only staleness guard. The base prompt tells the model to assume unexpected changes came from the user. | Yes. An edit requires a prior read, and a file that changed since it was read is flagged to the model. | D8: a hash record plus index markers, and D2's seen-content rule. A failed SEARCH is fed back (D3), Codex's guard, as a second line. |
| How are context changes communicated? | Appended, never rewritten. A per-section snapshot is diffed against what the model last saw, and only the change is appended ("These … instructions replace all previously provided …"). Full context is re-injected only after compaction. | Appended as reminders. | D4 (append-only within a run). Markers live in the per-turn tail, so they never touch the cached prefix. A re-read of a changed chapter says it replaces the earlier copy. |
| Earlier tool results | Kept in history, truncated when recorded, until compaction drops them all. | Kept until compaction. | Dropped across turns (D4); the chapters read come back through the ledger, which caches them. Chapter text can always be re-read, so carrying stale copies is cost without benefit. |
| Size of one result | About 10k tokens per output, cut out of the middle (head + tail) with a "…N tokens truncated…" marker and the original size. Files are read with shell ranges (`sed -n 'a,bp'`). | Whole file up to 2000 lines, printed with line numbers (`cat -n`); `offset`/`limit` for a range; "when you know which part you need, read only that part". | **Paragraphs as lines** (user decision, 2026-10-06): text reads are numbered `¶N`, `grep` reports `¶N`, and `read_chapter` takes a paragraph range. The model greps to a hit and reads only around it. Whole-chapter reads stay the default (a chapter is the size of a small source file, and prose needs its context); parts end at whole paragraphs (`READ_CHAPTER_CAP` 20k, `READ_CALL_CAP` 60k per call). No middle cut: it would remove the very passage a writer needs. |
| Near the context ceiling | Compacts at 90% of the window (hard cap 95%). An optional mode warns the model at about 6k remaining tokens to save notes. | Compacts. | Nothing yet. D5's ceiling (end the turn) was dropped by the user; compaction (below) is the answer, not done yet. |
| Iterations per turn | Unlimited while the model needs a follow-up; an optional session token budget with reminders. | Unlimited. | `agentMaxSteps`, 0 = unlimited (user decision). |
| Stable cached prefix | Session `prompt_cache_key`; send only the new items when the input strictly extends the last one; stable synthetic call ids; tools array unchanged within a session (new tools arrive through a search tool, not a changed array). | — | xAI's `x-grok-conv-id` per book; byte-exact argument replay; deterministic ids (`call_<step>_<i>`, `markup_<step>_<i>`). **The tools offered stay identical for every step of a run** — `offeredTools` must not depend on anything that changes mid-run. |
| Progressive disclosure | Skills appear as metadata only (name + description, about 2% of the window); the body is read on demand. | Same pattern for skills. | The CHAPTER INDEX is the metadata, `read_chapter` is the body. `chapterIndex.ts` already named this pattern. |

**Adopted as a later phase: conversation compaction.** `trimHistoryForContext`
drops old turns outright today. Codex replaces them with a handoff summary
and keeps the most recent user messages verbatim (its prompt asks for
progress, decisions, constraints and user preferences, what remains, and
critical references). For a book, the chapter summaries already carry the
document memory; what is lost today is the conversation's decisions ("the
heroine keeps her name", "no epilogue"). Compaction costs one re-prefill of
the history when it happens, and is cheaper than re-explaining those
decisions.

## 5. Interfaces (as built)

`src/agent/` is pure TypeScript with no React. Tools reach the editor and
the store only through ports, so they run under a fake context in tests
(`src/agent/__tests__/fakeContext.ts`). The hook (`useChatLLM`) builds the
real ports once per run (`buildToolContext`) and the run itself
(`createRun`).

### 5.1 Tool definition (`src/agent/types.ts`, `registry.ts`)

```ts
export type ToolKind = 'read' | 'navigate' | 'write'

export interface AgentTool<A> extends ToolSpec {   // name, description, parameters (JSON schema)
  kind: ToolKind
  /** Has a tag form on the markup protocol; then never offered natively there (D1). */
  markupForm?: boolean
  /** Offered this run? (a selection exists, a polish model is configured, …) */
  isAvailable(ctx: ToolContext): boolean
  /** Validate the raw arguments; a string is an error the model reads. null = never parsed. */
  parse(raw: Record<string, unknown> | null): A | string
  /** Render the call while its arguments are still arriving (write tools). */
  preview?(partialArgumentsText: string, ctx: ToolContext): void
  /** Synchronous when it can be: it keeps the turn's ordering (§0.1). */
  execute(args: A, ctx: ToolContext, call: ToolInvocation): ToolResult | Promise<ToolResult>
}

export interface ToolResult {
  ok: boolean
  /** Can the model fix this by trying again? Default `!ok`. */
  retryable?: boolean
  content: string        // what the model reads next step
  trace: string          // one line in the bubble's timeline
  effects?: WriteEffects // what the completion note reports (truncated, failed edits, …)
}
```

`defineTool(tool)` erases the argument type and wraps parse + execute into
one `invoke`. An argument error becomes a failed, retryable result. A new
tool is one `defineTool` module plus one entry in `CHAT_TOOLS`. The provider
adapters (`toOpenAITools` / `fromOpenAITools`) translate any schema.

### 5.2 Ports (`ToolContext`)

```ts
interface ToolContext {
  getState: () => AppState     // fresh store reads (stale-closure rule)
  editor: EditorPort           // previewDocument, discardPreview, previewSelection, replaceRange, current
  selection: SelectionPort     // the turn's selection: range, end, originalText, relocate (rejoin)
  document: DocumentPort       // startId, original, chapters(), openId(), userMoved(), ensureLoaded, commit, open, create, snapshot
  images: ImagePort            // {{IMAGE_PLACEHOLDER_n}} preserve / restore
  ui: UiPort                   // progress(line | null): one live line in the bubble; writing(id | null): lock a chapter for a slow write
  polish?: PolishPort          // the polish model (D9); absent when none is configured
  run: RunState                // state the run's tools share (§5.3)
}
```

`EditorPort` holds every rule in CLAUDE.md "Editor sync":
- previews never enter the undo history and never write the store;
- the run's end settles them.

`DocumentPort.commit` goes through the store's blanking guard.
`DocumentPort.create` appends a chapter without switching to it;
`create_chapter` then opens it.

### 5.3 Run state and working copies

```ts
interface RunState {
  step: number
  writeProtocol?: 'tools' | 'markup'   // set by the run: results name the next write in this form
  continuesAfterWrites?: boolean       // set by the run
  docs: Map<string, DocState>          // one working copy per chapter written
  known: Map<string, string>           // stored content as the run last saw or wrote it (user-edit rule)
  htmlShown: Set<string>               // chapters whose HTML the model saw this run (seen-content rule)
  inContext: Set<string>               // chapters whose full text this request carries
  created: Set<string>                 // chapters created this run (no snapshot; opened)
  snapshotted: Set<string>
  readIds: Set<string>                 // fed to the next turn's context selection
  reads: Map<string, number>           // duplicate-read guard
  touched: Map<string, AgentTouchedChapter>  // the "changed this turn" rows
  selectionAttempted: boolean
  selectionApplied: boolean
}

interface DocState {
  original: string    // the chapter as the run found it (may carry a pending diff)
  base: string        // accepted reading: what the model saw, what SEARCH matches
  reviewBase: string  // rejected reading: what the user last confirmed
  html: string        // every write of this run applied
  dirty: boolean
}
```

- Every write matches against `html`, so step 3 can edit text that step 2
  wrote.
- After each write the store receives `diffHtml(reviewBase, html)` through
  `commitDoc`.
- Chapter contents are loaded before their first use (`withLoaded`), so a
  lazy, still-empty chapter never becomes a base.
- Unmatched edit blocks return `ok: false`, retryable, with each failed
  SEARCH quoted.

### 5.4 The run (`src/agent/run.ts`)

```ts
type StepDriver = (messages: LLMMessage[], stepIndex: number, opts: { final: boolean }) => Promise<void>

new AgentRun({
  registry, ctx,
  writeProtocol: 'tools' | 'markup',  // utils/protocolChoice
  driver,                             // streams one step; ends in run.stepDone(out) or the error path
  observer,                           // onCorrective, onStepExecuted(progress), onFinish(summary)
  budgets, policy,                    // policy.resolveRunSettings(provider, config, canContinue)
  canContinue,                        // false on a rejoined stream
  agentTools,
  initialMessages
})
run.start()             // streams step 0
run.offeredTools()      // fixed at the first step
run.stepDone({ text, nativeCalls, thinking })
run.cancel()            // Stop: start no more steps
```

`RunSummary` (to `onFinish`) carries everything the hook needs:
- the joined chat text and the timeline;
- the trace and `touched`;
- `readIds` and the summed write effects;
- the protocol-failure flags;
- `endReason`: `answered`, `writes_done`, `step_limit`,
  `corrective_exhausted`, `protocol_failure` or `cancelled`.

### 5.5 Message shape

`LLMMessage` has optional tool fields; they are additive, so existing callers
are untouched:

```ts
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  cacheHint?: boolean
  toolCalls?: { id: string; name: string; argumentsText: string; signature?: string }[] // assistant
  thinking?: ThinkingBlock[]   // assistant, Anthropic: replayed before text and tool_use
  toolCallId?: string          // tool
  name?: string                // tool (Gemini keys results by name)
}
```

`argumentsText` is the argument string exactly as received, and
`signature` is Gemini's `thoughtSignature`. Neither is ever re-serialized.

Adapters, both transports, with parity tests:

| | OpenAI / grok / llama.cpp | Anthropic | Gemini |
|---|---|---|---|
| assistant call | `tool_calls[{id,type:'function',function:{name,arguments}}]` | `tool_use` content block | `functionCall` part |
| result | `{role:'tool', tool_call_id, content}` | user `tool_result` block | `functionResponse` part |
| ids | provider's | provider's | none from the provider; results matched by name |

Browser side: `services/providerMessages.ts`. Backend:
`scripts/server_generation.py` (`build_openai_request`, `build_anthropic_request`
and `build_gemini_request`). Parity tests are `providerMessages.test.ts` and
`test_server_generation_tools.py`.

### 5.6 Chat bubble data

```ts
interface ChatMessage {
  // … existing fields
  agent?: AgentTurnRecord
}

interface AgentTurnRecord {
  status: 'running' | 'done' | 'stopped' | 'step_limit'
  steps: number
  trace: string[]                    // one line per executed call, in order
  touched: AgentTouchedChapter[]     // D2's "changed this turn" rows
  timeline?: AgentTimelineItem[]     // each step's text, then its calls: { type: 'text' } | { type: 'tool', line, ok }
  prefix?: string                    // bubble text before the timeline (attached-context label)
  suffix?: string                    // after it (completion warnings, the step-limit note)
  live?: string                      // while running: the step in flight
}

interface AgentTouchedChapter {
  documentId: string
  titleAtRun: string                 // shown if the chapter is later renamed or deleted
  kind: 'edits' | 'rewrite' | 'selection' | 'created' | 'polished'
  changes: number
  failed: number
}
```

- **No chapter text.** The record holds trace lines and counts only. The
  review status of each row is not stored; it is computed from the
  chapter's live content, so it cannot go stale.
- **Old messages are unchanged.** The field is optional, so a message with
  no `agent` renders exactly as before.
- **`content` keeps the joined text**, for history and older clients.
- **Storage.** The record lives in the JSON `agent` column of `messages`,
  added by the `server_db.init_db` migration. Before that column existed,
  only fixed columns were saved and the record vanished on reload.

## 6. Tool set

| Tool | Kind | grok delivery | Notes |
|---|---|---|---|
| `update_document` | write | markup `<canvas chapter="…">` | optional `chapter` (D2); guards: truncation, elision, image reinsertion; seen-content rule when the chapter has content |
| `edit_document` | write | markup `<edit chapter="…">` | optional `chapter` (D2); seen-content rule; failures fed back (§5.3) |
| `replace_selection` | write | markup `<selection_replace>` | always the chapter the selection was made in; once per run |
| `list_chapters` | read | native | index + summaries + char counts. Cheap; the volatile tail already has the index, so this mostly serves long books whose index is digested |
| `read_chapter` | read | native | `{chapters: [numbers or titles], format: "text" \| "html", paragraphs?: "40-60" \| "45" \| "81-" \| "-15"}` ("-15" is the first 15: grok asked that way and was refused, 2026-10-06). Text returns **numbered paragraphs** (`¶12 …`, headings `# …`, images `[image]`); html returns exact block HTML, unnumbered (SEARCH copies it), and marks the chapter `htmlShown`. A long chapter is returned in parts of ≤20k chars ending at a whole paragraph, with the range to continue from. A text read of a whole chapter already in context is refused as redundant in the first two steps; a range read never is. A repeat of the same read is refused only within one step of the first |
| `grep` | read | native | regex over every chapter's text, or only those named (lazy contents loaded first). Output "snippets" (chapter, offset, context) or "chapters" (counts). A broken regex is searched literally. Its trace names the scope ("in the whole book" or "in #13"); "→ 30 in 1 chapter(s)" without it read as "grep only searches one chapter". Chapters whose text could not be loaded are listed as not searched, not reported as having no match. Replaced `search_book` (user request, 2026-10-06): grep is the search interface models already know |
| `open_chapter` | navigate | native | ONLY to show the user a chapter (`setActiveDocumentId`); writing never needs it (D2). Says "already open" when it is. Refused while a selection rewrite is pending |
| `delete_chapter` | write | native (no tag form) | Deletes a chapter created this run or an empty one; anything with text is refused ("ask the user"). Runs last in its reply; reports the renumbering (§0.4) |
| `rename_chapter` | write | native (no tag form) | `{chapter, title, replace?}`. Renames; a taken title is refused. `replace=true` moves a chapter created this run into the one with that title (in place, reviewable) and removes it (§0). Runs last in its reply |
| `polish_chapter` | write | native (no tag form) | D9. Only when the user asks. Rewrites the chapter chunk by chunk with the polish model, as a reviewable diff, and makes the model read it again before editing |
| `analyze_book` | read | native | D7. Notes from reading the whole book (or the chapters named) in batches, one model call per batch, for a task that needs all of it at once. Batches are packed by `WHOLE_BOOK_CONTEXT_CHARS` per provider. Stop ends it between batches, keeping the notes so far. Replaced the whole-book toggle and its consent card |

Phase 3+: `analyze_book` (Rung 2 map-reduce, approval-gated, replaces the
consent card for that rung), `update_chapter_summary`, `rename_chapter`,
`generate_image` (`services/imageGen`), `import_url`. Destructive ones
(`delete_chapter`) only with `approval`.

## 7. Prompt (as built)

- **System prompt.** `buildChatSystemPrompt({ protocol, agentTools,
  continueAfterWrites, … })` teaches exactly one write protocol, so it can
  never describe tools the request does not send. Its sections:
  - the protocol, unchanged from before the loop: `MARKUP_PROTOCOL_RULES`
    or `TOOL_PROTOCOL_RULES`;
  - with the agent tools on, WORKING ACROSS THE BOOK (`agentRules`);
  - the user's custom instructions;
  - the format reminder.

  WORKING ACROSS THE BOOK says:
  - decide from the CHAPTER INDEX what to read; grep when no title or
    summary says where something is; never guess at an unread chapter;
  - paragraphs are numbered like lines (`¶12`); read only the range around
    a grep hit;
  - what each index marker means (D8);
  - the active document is as of the start of the turn; tool results say
    what changed since;
  - how to name another chapter in a write, and that an `<edit>` there
    needs its HTML read first;
  - a new chapter must be created before it is written, in an earlier reply
    or the same one (creation runs first);
  - on markup: `<doc_status>` is required only on a reply that calls no
    tool;
  - **ending:** do each piece of work in the reply that says you are doing
    it ("Now I'll rewrite chapter 3" goes in the same reply as its
    `<canvas chapter="3">`). After a reply that changes the document or
    calls a tool, the model receives the results and continues. A reply
    that does neither ends the turn, so it is sent only when the work is
    done (D3). With `continueAfterWrites` off, it says instead that a
    write-only reply ends the turn.
    - Why it is worded this way (2026-10-06): the earlier rules said "a
      reply that calls a tool is not your final reply" and "a reply with no
      action ends your turn". For a model that wanted to announce a rewrite
      and write it in the next reply, the only move within those rules was
      to call some tool. grok called `create_chapter("skip")` and left an
      empty chapter behind. The wording now says where the work goes and no
      longer offers a tool call as the way to keep going;
  - **one chapter per reply** when writing several.

  It carries no writing guidance (CLAUDE.md rule).
- **The parsers.** The tag parser (`parseAssistantResponse`) and the
  streaming splitter (`splitStreamingResponse`) read the `chapter`
  attribute. The splitter reports the target, because the live preview is
  routed by it.
- **Volatile tail.** The heading over the active chapter reads "CURRENT
  ACTIVE DOCUMENT CONTENT (Your writes change this chapter unless you name
  another)". With the agent tools off it still reads "(This is the ONLY
  document you can update)". This is in the per-turn tail, so the cached
  prefix is not affected.

## 8. Resumability (grok runs on backend jobs)

Each step is its own `/api/generate` job.

**Built (phase 2).**
- On reload, the rejoin path renders the step in flight exactly as before.
  When the step finishes, its writes are applied.
- The run cannot go on from there. It is built with `canContinue` false:
  one step, no corrective retry, no continuation after writes. The user
  sends "继续" (continue) to pick up.

**Phase 3 (full resume).**
- Add `GET /api/generate/{id}/request`, returning the job's request
  messages.
- The client appends the step's results and continues the loop.
- A tool-call id ledger on the bubble makes execution idempotent.

**Stop.** `handleStopGeneration` aborts the step in flight, on the client
and through `abortRemoteGeneration`, and ends the run. Earlier steps' writes
stay, each already a reviewable diff.

## 9. Phased plan

| Phase | Scope | Behavior change |
|---|---|---|
| | **Status (2026-10-06):** 0, 1, 2 and 2b are done (2b without the digest tool and the provider-sized ledger budget; see D7), and so are D9 polish, `grep`, paragraph numbering, the append-update ledger, writes continuing the turn, and changes kept under review. 3 and 4 continue in [backend_authority.md](backend_authority.md). | |
| 0. Plumbing | `LLMMessage` tool fields; adapters in `llm.ts` + `server_generation.py` with parity tests; Anthropic/Gemini adapters translate arbitrary schemas | none |
| 1. Extract | `src/agent/` registry + loop + `EditorPort`; port the 3 write tools and `MarkupToolSource`; `useChatLLM.onDone` becomes "run loop with `maxSteps` covering the corrective retries only" | none — existing `useChatLLM.test.ts` must pass unmodified |
| 2. Read/navigate + cross-chapter writes | `list_chapters`, `read_chapter`, `grep` (was `search_book`), `open_chapter`, `create_chapter`; D8 freshness markers; `chapter` target on writes (tools + markup attribute) with preview routing; seen-content rule; blanking guard moved into `updateDocument`; per-document version snapshots; 本轮修改 (changed this turn) block; D3 policy; edit-failure feedback; trace UI; history trace line + continuity feed; settings `agentMaxSteps` (0 = unlimited) and `continueAfterWrites` | the loop, behind a per-provider setting `agentTools: auto/on/off` (grok `auto` = on only after M2 passes) |
| 2b. Retire manual context (D7) | remove the attach bar, the whole-book toggle and the consent card; `analyze_book` and the digest tool; provider-sized ledger budget; documents envelope v3 migration | context is chosen by the model and steered by the conversation |
| 3. Hardening | full resume (§8); cliff-aware budget telemetry in the turn cache panel. (The append-update ledger planned here was done early, 2026-10-05; see cache_first_context.md §13.) | |
| 4. More tools | image gen, import, summaries; roleplay as a second tool profile; conversation compaction (handoff summary + recent user messages verbatim, see "Prior art") | |

## 10. Measurements required before defaults are set (grok)

Extend the acceptance harness (`scripts/acceptance/`, today only `contextCache.accept.ts`) on real chapters, n ≥ 8 per
condition — the 2026-07-25 log showed 22–65% drift for an identical prompt
within an hour, so smaller batches mean nothing.

- **M1. Tool-argument streaming on a long write.** Native `update_document`
  rewriting a 7k-char chapter: delta count and time to first delta. If grok
  streams long arguments in fragments, grok goes all-native and D1's hybrid
  is dropped; otherwise the hybrid stays (decided, D1).
- **M2. Hybrid compliance.** With read tools native + markup writes: (a) rate of
  calling `read_chapter` when the request names a chapter that is not attached;
  (b) how often a `chapter="…"` attribute names the intended chapter, and how
  often the seen-content rule has to refuse an edit; (c) bare acknowledgement
  rate compared with the current baseline; (d) for "change 3, then adapt 4",
  how often grok writes 3 **and** reads 4 in one step (D3's continuation
  signal) rather than stopping after 3; (e) D6: "根据小说大纲写第一章" in a book
  whose outline is titled without the word 大纲 (e.g. 故事线), once with a
  generated summary and once without. Measure how often grok reads the right
  chapter and how many steps it takes; (f) D7: "参考第三章" (refer to chapter
  3) and "别参考番外" (don't use the side stories) in the message. Measure
  whether the reply uses or avoids those chapters.
- **M3. Step latency.** TTFT for step 2 vs step 1 at `low` effort, and cached
  token share of step 2 (expect ≈ step-1 prompt). Confirms D4, sets the
  `agentMaxSteps` default, and sets the grok default for `continueAfterWrites`
  (on if step-2 TTFT ≤ 15 s). Settled 2026-10-06 from the logs: a step after a
  tool result reached its first token in 1–6 s, and the default is on for
  every provider (D3).
- **M4. Parallel calls.** Does grok emit several `read_chapter` calls in one
  step when asked about three chapters? If not, multi-read costs one step each
  and `maxSteps` must reflect it.

## 11. Testing

The suites as built:

| Suite | Covers |
|---|---|
| `src/agent/__tests__/run.test.ts` | the controller against a scripted driver: each D3 row, budgets (final step with `toolChoice: 'none'`, 0 = unlimited, corrective), write + read continuing, Stop between steps, append-only messages |
| `src/agent/__tests__/policy.test.ts` | `detectStepFailure` (including the closing reply after a write), `decideAfterStep`, `resolveRunSettings` defaults, `collectStep`, `planWrites` |
| `src/agent/__tests__/documentWrites.test.ts` | the write tools on a fake context (`fakeContext.ts`): working copies, the review base, the seen-content rule, preview routing, guards |
| `src/agent/__tests__/bookReads.test.ts` | `read_chapter` (paragraph ranges, parts, duplicate guard), `grep`, `list_chapters`, `open_chapter`, `delete_chapter` |
| `src/agent/__tests__/freshness.test.ts`, `polish.test.ts` | D8 markers; D9 polish and `polish_chapter` |
| `src/hooks/__tests__/useChatLLMAgent.test.ts` | the real hook with a scripted `streamLLM`. Covers: finding and reading the outline; writing another chapter; creating chapters; writing a series (including the run that used to stop after chapter one, and Stop keeping the second chapter's draft); restoring one pending change; the Polish button; the step limit; what each protocol offers |
| `src/hooks/__tests__/useChatLLM.test.ts`, `useChatLLMRejoin.test.ts`, `selectionWithEdits.test.ts`, `selectAllRewrite.test.ts` | the pre-loop flows, still green. Every written turn now has one more step, the closing reply, which the scripted transports return by default |
| `src/services/__tests__/providerMessages.test.ts`, `scripts/test_server_generation_tools.py` | adapter parity, browser and backend |
| `src/utils/__tests__/paragraphs.test.ts`, `pendingChanges.test.ts`, `polish.test.ts`, `systemPrompt.test.ts` | the pure helpers and the prompt |
| `src/components/__tests__/AgentTimeline.test.ts` | the bubble's timeline |
