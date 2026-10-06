# Agentic chat loop with document tools (grok-first)

Status: **phases 0–1 implemented** (2026-10-05); phases 2–4 proposed.
Revised after user review on 2026-10-05 (D1 decided, D2 and D3 rewritten,
step limit made a setting).

### Implementation status

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

Known gaps, not grok's:
- Anthropic with extended thinking expects its thinking blocks to be replayed
  next to `tool_use`.
- Newer Gemini models expect `thoughtSignature` on replayed calls.

Neither is in the wire contract, so a multi-step run with reasoning on those
providers may be rejected.
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
| a chapter **created in this run** | opened in the editor when its first write starts (D6), then the active-chapter path | yes | as the active chapter |

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
| only writes, all succeeded, `continueAfterWrites` off | **end**; the step's chat text is the reply |
| only writes, all succeeded, `continueAfterWrites` on | **continue**; the model answers in prose (end) or keeps working |
| writes **and** any read / navigate call | **continue**. "Edit chapter 3 + read chapter 4" in one step is how the model says "there is more" |
| any read / navigate call | **continue** (the model asked for information) |
| any write that failed (unmatched SEARCH, truncated, elided, bad args, seen-content rule) | **continue** with the error as the tool result (§5.3), counted against the corrective budget |
| a markup protocol failure (`undeclared` / `claimed` / `malformed`) | **continue** with `NO_ACTION_RETRY_INSTRUCTION` as a corrective step |

With D2, the usual multi-chapter flow takes **two steps**, with no
confirmation round: step 1 reads chapters 3 and 4 in parallel, and step 2
edits both and ends. The sequential case ("change 3, then adapt 4 to it") is
step 1 editing 3 while reading 4, then step 2 editing 4.

The gap that remains: a model that edits chapter 3 alone, intending to
continue, while `continueAfterWrites` is off. Three things cover it:
- the protocol section of the system prompt states the rule ("a reply whose
  only actions are document changes ends your turn; if more work remains,
  request what you need in the same reply");
- the bubble says so when the run ended this way (the user can reply "继续"
  (continue));
- the `continueAfterWrites` setting (per provider, in Settings). Its default
  for grok is set by M3. If a step-2 first token at `low` effort is short
  (target ≤ 15 s; its prompt is all cache hits), the default is **on** and the
  gap closes. Local models default to on.

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
  the duplicate guard and the prompt-token ceiling below. The ceiling is cost
  protection, not a step count, so it is not lifted by 0. When the limit is
  hit, the last step is sent with `tool_choice: "none"` so the turn still
  ends in an answer, and the bubble says the limit was reached
  ("已达步数上限（6）" (step limit reached, 6)). The field is optional:
  absent means the provider default, so stored settings need no migration.
  A test still feeds a config without the field through
  `settingsPersistence` and asserts the default.
- `maxCorrectiveSteps` = `MAX_NO_ACTION_RETRIES` (3) — shared by markup
  failures and failed writes, so the measured recovery curve is preserved.
- **Prompt-token ceiling** = `targetPromptTokens(profile, window)` — for grok
  the 200k cliff minus output headroom. Before each step the loop estimates the
  next prompt; if it would cross, the step is sent with `tool_choice: "none"`
  plus a one-line "answer now with what you have" note.
- Per-result caps: `read_chapter` returns at most 20k chars (the same cap as the
  ledger, `MAX_LEDGER_DOC_CHARS`) with `offset` paging; `search_book` at most
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
  digest tells you where something is, use `search_book`.
- **Prefetch.** The Layer-1 scorer (`selectReferenceChapters`) stays. When it
  attaches the right chapter, the model can write in the first step. When it
  misses, the cost is one `read_chapter` step, not a wrong answer.
  `detectReferencedDocIds` only matches a title that appears whole in the
  prompt, so "大纲" never finds a chapter called 故事线.

Gaps to close in phase 2 (found in the code):
1. **Empty digests.** A chapter that has no generated summary and whose
   content has not lazy-loaded yet has an empty digest, so the model sees
   only its title. The index marks such lines `(not summarized yet)`, so the
   model knows the title is all it has. `search_book` loads contents
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

**Decided (user, 2026-10-05): a chapter created in this run opens in the
editor when its first write starts,** so a brand-new chapter keeps the live
preview. It is empty and nobody was editing it, so the switch interrupts
nothing. Writes to chapters that already existed still never switch the view
(D2).

### D7. No manual context selection

**Decided (user, 2026-10-05).** The user no longer picks context by hand.
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
| Batched map-reduce + cost consent card | `runWholeBookBatches`, consent card | The `analyze_book(question)` tool. **No consent card.** Its call count and cost show in the step trace, and D5's token ceiling stops a runaway run |

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

## 5. Interfaces

New module tree `src/agent/` — pure TypeScript, no React, testable with a
scripted transport the way `useChatLLM.test.ts` already scripts `streamLLM`.

### 5.1 Tool definition

```ts
// src/agent/types.ts
export type ToolKind = 'read' | 'navigate' | 'write' | 'external'

export interface AgentTool<A = Record<string, unknown>> {
  name: string
  description: string
  parameters: JsonSchema               // existing type from utils/documentTools
  kind: ToolKind
  /** Offered this step? (selection present, book loaded, whole-book sticky…) */
  isAvailable(ctx: ToolContext): boolean
  /** Validate/coerce raw JSON. A string is an error fed back to the model. */
  parse(raw: Record<string, unknown> | null): A | string
  /** Optional live rendering from a partial argument string (write tools). */
  preview?(partialArgumentsText: string, ctx: ToolContext): void
  execute(args: A, ctx: ToolContext): Promise<ToolResult>
  /** Needs the user's OK first (cost, destructive). Phase 3. */
  approval?(args: A, ctx: ToolContext): ApprovalRequest | null
}

export interface ToolResult {
  ok: boolean
  /** What the model reads next step. Plain text, capped by the tool. */
  content: string
  /** One line for the chat bubble's trace ("📖 Read 第三章 (8.2k chars)"). */
  trace: string
  /** Chat-visible warning, if any (re-uses buildCompletionWarnings text). */
  warning?: string
}
```

Adding a tool = write one `AgentTool`, call `registry.register(tool)`. The
provider adapters (`toOpenAITools` / `toAnthropicTools` / `toGeminiTools`) must
translate **whatever schemas they are given**. Today the Anthropic and Gemini
paths in `services/llm.ts` filter `DOCUMENT_TOOLS` by name, so any new tool
would be silently dropped on those providers — fix that in phase 0.

### 5.2 Context the tools run in

```ts
export interface ToolContext {
  getState: () => AppState                 // fresh store reads (stale-closure rule)
  editor: EditorPort                       // the only way tools touch TipTap
  images: { preserve(html: string): string; restore(html: string): string }
  run: RunState                            // turn base per doc, selection, budgets, step index
  signal: AbortSignal
  ui: { setSaveStatus(s: 'saved' | 'unsaved'): void; requestApproval(r: ApprovalRequest): Promise<boolean> }
}

/** Wraps the fragile editor rules (see CLAUDE.md "Editor sync") in one place. */
export interface EditorPort {
  previewHtml(html: string): void          // addToHistory:false, emitUpdate:false, throttled
  settle(html: string): void               // settleCanvasPreview
  keepPreview(original: string): string | null // keepCanvasPreview (Stop)
  replaceSelection(from: number, to: number, html: string): number | null // replaceSelectionWithHtml
  getHtml(): string
}
```

`useChatLLM` builds the `ToolContext` from its refs once per run; the refs that
exist today (`canvasPreviewActiveRef`, `selectionRangeRef`, …) move behind
`EditorPort` and `RunState`.

### 5.3 Write tools against a run working copy

`RunState.docs: Map<docId, { base: string; working: string; htmlShown: boolean }>`.
It is keyed by chapter, because writes may target any chapter (D2):
- `base` = the **accepted reading** (`stripDiffMarkup`) of the document the
  first time this run touches it — the same base the edits path uses today.
  The chapter's content is loaded first (`ensureDocumentContents`), so a lazy,
  still-empty chapter can never become the base; that is the data-loss bug
  the rejoin path already hit once.
- `working` = clean HTML with every write of this run applied.
- `htmlShown` = this run has sent the model the chapter's HTML (the volatile
  tail for the active chapter, or `read_chapter` with `format: "html"`). This
  is what D2's seen-content rule checks.
- After each write the target chapter's stored content becomes the review
  rendering of `base → working`, built with the existing diff functions
  (`diffHtml` / span-level diffs). The user sees one reviewable diff per
  chapter per turn. The active chapter goes through `EditorPort`; any other
  chapter goes through `updateDocument`.
- The run keeps ONE image-placeholder registry across all steps and chapters
  (today it is reset per request), so `{{IMAGE_PLACEHOLDER_n}}` stays unique
  when several chapters are read in one run.

`edit_document.execute` matches SEARCH against `working`, so step 3 can edit
text that step 2 wrote. Unmatched blocks return `ok:false` with each failed
SEARCH (`applyEditBlocks` already returns them in `failed`) plus the closest
block of `working` by text overlap (new helper) — the model can correct itself, which today ends in a
"N changes could not be located" warning and nothing else.

### 5.4 The loop

```ts
// src/agent/loop.ts
export async function runAgentLoop(opts: {
  initialMessages: LLMMessage[]
  registry: ToolRegistry
  protocol: ProtocolPlan            // per tool kind: 'native' | 'markup' | 'off'
  transport: StepTransport          // one streamed model call
  ctx: ToolContext
  budgets: RunBudgets
  observer: RunObserver             // bubble text, reasoning, trace, step status
}): Promise<RunOutcome>
```

Per step: offer `registry.available(ctx, protocol)` → stream via `transport`
(chunks → observer + markup preview; tool deltas → `tool.preview`) → collect
`ToolInvocation[]` from `NativeToolSource` + `MarkupToolSource` → execute
sequentially (writes are never parallel; reads may be) → apply D3 → append
`assistant{content, toolCalls}` + `tool{toolCallId, content}` messages → next.

`StepTransport` is `streamLLM` with the run's step id in `remoteMeta`. Writes
coming from markup have no native call id, so their results are not sent back
as `tool` messages; if the loop continues after one (a failure), the result
goes into the corrective user message instead.

### 5.5 Message shape

`LLMMessage` gains optional fields (additive, existing callers untouched):

```ts
interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  images?: string[]
  cacheHint?: boolean
  toolCalls?: { id: string; name: string; argumentsText: string }[] // assistant
  toolCallId?: string                                                  // tool
  name?: string                                                        // tool
}
```

Adapters, both transports, with parity tests:

| | OpenAI / grok / llama.cpp | Anthropic | Gemini |
|---|---|---|---|
| assistant call | `tool_calls[{id,type:'function',function:{name,arguments}}]` | `tool_use` content block | `functionCall` part |
| result | `{role:'tool', tool_call_id, content}` | user `tool_result` block | `functionResponse` part |
| ids | provider's | provider's | synthesized `s<step>_<i>` |

For grok the one that matters is `server_generation.build_openai_request`
(fact 6): it must copy `tool_calls`, `tool_call_id` and `name`, and accept
`role: "tool"`. Add a test that feeds a tool exchange through it and asserts
the body, mirroring the TS adapter test.

### 5.6 Chat bubble data

```ts
interface ChatMessage {
  // … existing fields
  agent?: {
    runId: string
    status: 'running' | 'done' | 'stopped' | 'step_limit' | 'interrupted'
    steps: { jobId?: string; invocations: { id: string; name: string; trace: string; ok: boolean }[] }[]
    /** D2's "changed this turn" block — one entry per chapter written. */
    touched: {
      documentId: string
      titleAtRun: string           // shown if the chapter is later renamed/deleted
      kind: 'edits' | 'rewrite' | 'selection' | 'created'
      changes: number
      failed: number
    }[]
  }
}
```

Trace lines and counts only, never chapter text. The review status per row is
**not** stored; it is computed from the chapter's live content, so it cannot
go stale. Optional and additive, so stored messages need no migration. Add a
test that an old message (no `agent`) renders unchanged.

The bubble renders top to bottom:
1. the step trace, collapsed by default ("📖 Read 第三章 · ✏️ Edited 第五章 ×3");
2. the **本轮修改** (changed this turn) block (D2), always expanded;
3. the reply text.

## 6. Initial tool set

| Tool | Kind | grok delivery | Notes |
|---|---|---|---|
| `update_document` | write | markup `<canvas chapter="…">` | optional `chapter` (D2); guards: truncation, elision, image reinsertion; seen-content rule when the chapter has content |
| `edit_document` | write | markup `<edit chapter="…">` | optional `chapter` (D2); seen-content rule; failures fed back (§5.3) |
| `replace_selection` | write | markup `<selection_replace>` | always the chapter the selection was made in; once per run |
| `list_chapters` | read | native | index + summaries + char counts. Cheap; the volatile tail already has the index, so this mostly serves long books whose index is digested |
| `read_chapter` | read | native | `{chapter: number or exact title, format: "text" \| "html", offset?}`, 20k cap, paging. `text` for reading (cheaper); `html` (image placeholders in) when the model will edit it, which sets `htmlShown`. Ambiguous or unknown chapter → error listing candidates. `text` is refused for chapters already in the ledger / sticky prefix, which are in context already; `html` is not |
| `search_book` | read | native | keyword/regex over all chapters (lazy contents via `ensureDocumentContents`) → snippets with chapter + offset |
| `open_chapter` | navigate | native | shows the user a chapter (`setActiveDocumentId`). Not needed for writing (D2). Refused while a selection rewrite is pending |
| `create_chapter` | navigate | native | `addDocument(title)`; the view switches to it only when its first write starts (D6), so the user is not moved to an empty page; content comes from `update_document` with `chapter` |

Phase 3+: `analyze_book` (Rung 2 map-reduce, approval-gated, replaces the
consent card for that rung), `update_chapter_summary`, `rename_chapter`,
`generate_image` (`services/imageGen`), `import_url`. Destructive ones
(`delete_chapter`) only with `approval`.

## 7. Prompt changes

- Markup system prompt (grok): keep the existing protocol text byte-stable and
  append one short section. It says:
  - read/navigate tools exist, and the document is still changed only with
    tags;
  - `<canvas>` and `<edit>` take an optional `chapter="…"` attribute (the
    number or exact title from the chapter index); without it they change the
    active chapter. To `<edit>` another chapter, read its HTML first;
  - a reply whose only actions are document changes ends the turn (D3);
  - the `<doc_status>` line is required only on a reply **without native tool
    calls**, since a step with a call is not the final reply.

  No writing guidance (CLAUDE.md rule). The tag parser
  (`parseAssistantResponse`) and the streaming splitter
  (`splitStreamingResponse`) learn the attribute. The splitter must report the
  target, because the live preview is routed by it (D2).
- Volatile tail: "CURRENT ACTIVE DOCUMENT CONTENT (This is the ONLY document
  you can update)" becomes "…(changed by default; other chapters can be
  changed by naming them)". This is in the per-turn tail, so the cached prefix
  is not affected.
- Tool system prompt: rule 5 ("the user message carries the CURRENT ACTIVE
  DOCUMENT CONTENT") gains "…as of the start of this turn; after
  a `read_chapter` or an edit, the tool result is the current text".
- `buildChatSystemPrompt` takes the `ProtocolPlan` instead of a single
  protocol, so it can never describe tools the request does not send.

## 8. Resumability (grok runs on backend jobs)

Each step is its own `/api/generate` job, tagged `meta.runId` + `meta.step`.
The bubble's `agent.steps` record which tool call ids were applied, persisted
with the chat. On reload:

- **Phase 2 (simple):** rejoin renders the step in flight exactly as today; when
  it finishes, its invocations are executed (if not already recorded as
  applied) and the run **ends** with "continued steps were interrupted — send
  'continue'". Never re-applies a write.
- **Phase 3 (full):** add `GET /api/generate/{id}/request` returning the job's
  request messages; the client appends the step's results and continues the
  loop. The tool-call id ledger on the bubble makes execution idempotent.

`handleStopGeneration` aborts the step in flight (client + `abortRemoteGeneration`)
and ends the run; earlier steps' writes stay, each already a reviewable diff.

## 9. Phased plan

| Phase | Scope | Behavior change |
|---|---|---|
| 0. Plumbing | `LLMMessage` tool fields; adapters in `llm.ts` + `server_generation.py` with parity tests; Anthropic/Gemini adapters translate arbitrary schemas | none |
| 1. Extract | `src/agent/` registry + loop + `EditorPort`; port the 3 write tools and `MarkupToolSource`; `useChatLLM.onDone` becomes "run loop with `maxSteps` covering the corrective retries only" | none — existing `useChatLLM.test.ts` must pass unmodified |
| 2. Read/navigate + cross-chapter writes | `list_chapters`, `read_chapter`, `search_book`, `open_chapter`, `create_chapter`; `chapter` target on writes (tools + markup attribute) with preview routing; seen-content rule; blanking guard moved into `updateDocument`; per-document version snapshots; 本轮修改 (changed this turn) block; D3 policy; edit-failure feedback; trace UI; history trace line + continuity feed; settings `agentMaxSteps` (0 = unlimited) and `continueAfterWrites` | the loop, behind a per-provider setting `agentTools: auto/on/off` (grok `auto` = on only after M2 passes) |
| 2b. Retire manual context (D7) | remove the attach bar, the whole-book toggle and the consent card; `analyze_book` and the digest tool; provider-sized ledger budget; documents envelope v3 migration | context is chosen by the model and steered by the conversation |
| 3. Hardening | full resume (§8); cliff-aware budget telemetry in the turn cache panel | |
| 4. More tools | image gen, import, summaries; roleplay as a second tool profile | |

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
  (on if step-2 TTFT ≤ 15 s).
- **M4. Parallel calls.** Does grok emit several `read_chapter` calls in one
  step when asked about three chapters? If not, multi-read costs one step each
  and `maxSteps` must reflect it.

## 11. Testing

- `src/agent/__tests__/loop.test.ts`: scripted transport; one test per D3 row
  (including write+read continuing); budgets (step limit → final step with
  `tool_choice: none`, `agentMaxSteps: 0` runs past the default limit,
  corrective, token ceiling); duplicate reads; abort mid-step keeps earlier
  writes.
- Cross-chapter writes: a `<canvas chapter="B">` streamed while A is open never
  touches the editor, and B's stored content becomes a reviewable diff; an
  edit on an unread chapter is refused; a write to a lazy, unloaded chapter
  loads it first and never blanks it; the 本轮修改 (changed this turn) rows
  match `touched`, and the status follows accept/reject.
- Per-tool tests against a fake `EditorPort` + store.
- `MarkupToolSource` produces the same invocations as `toolCallToParsedResponse`
  for the existing fixtures.
- Adapter parity: the same tool exchange through `llm.ts` and
  `server_generation.py` yields the same OpenAI body (pytest + vitest).
- Every existing `useChatLLM` flow test stays green through phase 1.
