# Agentic chat loop with document tools (grok-first)

Status: **phases 0–2 implemented** (2026-10-05); phases 2b–4 proposed.
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

**Not persisted.** After a reload nothing counts as seen except what the
ledger re-sends. That is correct, because a reloaded session's prompt prefix
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
| Near the context ceiling | Compacts at 90% of the window (hard cap 95%). An optional mode warns the model at about 6k remaining tokens to save notes. | Compacts. | D5's ceiling: the final step gets `tool_choice: "none"`. **Not done yet:** compaction (below). |
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

The bubble renders the turn **in the order it happened**: each step's text,
then the tool calls that step made, where it made them (`agent.timeline`,
`AgentTimeline`). While the turn runs, the step in flight follows (`live`).
The **本轮修改** (changed this turn) block (D2) comes after. `content` keeps
the joined text for history and older clients. The record is stored
server-side in a JSON `agent` column of `messages` (`server_db.init_db`
migration). Before that column existed, only fixed columns were saved and
the record vanished on reload.

## 6. Initial tool set

| Tool | Kind | grok delivery | Notes |
|---|---|---|---|
| `update_document` | write | markup `<canvas chapter="…">` | optional `chapter` (D2); guards: truncation, elision, image reinsertion; seen-content rule when the chapter has content |
| `edit_document` | write | markup `<edit chapter="…">` | optional `chapter` (D2); seen-content rule; failures fed back (§5.3) |
| `replace_selection` | write | markup `<selection_replace>` | always the chapter the selection was made in; once per run |
| `list_chapters` | read | native | index + summaries + char counts. Cheap; the volatile tail already has the index, so this mostly serves long books whose index is digested |
| `read_chapter` | read | native | `{chapters: [numbers or titles], format: "text" \| "html", paragraphs?: "40-60" \| "45" \| "81-"}`. Text returns **numbered paragraphs** (`¶12 …`, headings `# …`, images `[image]`); html returns exact block HTML, unnumbered (SEARCH copies it), and marks the chapter `htmlShown`. A long chapter is returned in parts of ≤20k chars ending at a whole paragraph, with the range to continue from. A text read of a whole chapter already in context is refused as redundant; a range read is not |
| `grep` | read | native | regex over every chapter's text, or only those named (lazy contents loaded first). Output "snippets" (chapter, offset, context) or "chapters" (counts). A broken regex is searched literally. Replaced `search_book` (user request, 2026-10-06): grep is the search interface models already know |
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
