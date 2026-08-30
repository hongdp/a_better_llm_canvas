# Cache-first context strategy

Status: **proposed** (design only — no code written yet)
Supersedes the layout half of the 2026-07-07 "Cache-Friendly Prompt Layout"
decision; the windowing/trimming helpers in `utils/llmContext.ts` stay.

## 1. Why now

A local run measured the cost directly. `api-server.log`, one ordinary chat
turn against the local Qwen3.8-Flash-Next endpoint:

```
20:32:11  Started generation job (provider=ollama)
          prompt processing, n_tokens = 4661, t = 42.56 s  (109 tok/s)
20:32:54  first token after 42.87s (7505 chars of input)
          … then 18.4 tok/s
```

Forty-three seconds before the first visible token, all of it prefill. The
same engine re-reads a prefix it has already seen in **0.2 s** when the token
sequence is byte-identical (`local_model/README.md`, 45k-token measurement).
So the prefill is not a hardware limit — it is a **prompt-layout** result.

The same arithmetic governs the paid providers: an unchanged prefix is billed
at cache-read rates (roughly a tenth) instead of full input rates. What is
slow locally is expensive remotely; one fix serves both.

## 2. The goal, stated as an invariant

> Between consecutive turns of a session, the token sequence sent to the model
> must share the longest possible identical prefix, and every change must
> happen as close to the end as possible.

Corollaries the design commits to:

- Context **grows by appending**. Nothing already sent moves or changes.
- What must change (the active document, the request) sits in a **volatile
  tail** that we accept re-prefilling every turn.
- Anything that would **shorten or reorder** the stable part is a user-visible
  event, not a silent optimization.

## 3. What the current layout does

`useChatLLM.ts:1190`:

```
apiMessages = [ systemPrompt, ...bookPrefixMessages, ...historyMessages, finalUserMessage ]
```

with `finalUserMessage.content = dynamicContext + "\n\nUSER REQUEST:\n" + prompt`,
and `dynamicContext` (`chat/dynamicContext.ts`) =
chapter index + **all attached reference chapters** + **the active document**.

The intent was right — volatile content last. But the *bulk* of the prompt is
inside that volatile tail, so the tail is where all the tokens are.

### The six prefix breakers

| # | Breaker | Where | Severity |
|---|---|---|---|
| 1 | Every attached reference chapter lives in the final message, so the whole reference block is re-prefilled each turn | `chat/dynamicContext.ts` | **critical** — this is the bulk |
| 2 | Attached chapters are ordered `[pinned in book order, then autos sorted by score desc]`. Scores are recomputed from the new prompt every turn, so the same set of chapters is emitted in a different order | `contextSelection.ts:191` | **critical** — reorders bytes even when nothing changed |
| 3 | History is trimmed from the **front** once it exceeds `MAX_HISTORY_CHARS` (80k) | `llmContext.ts:44`, `useChatLLM.ts:39` | high — one drop invalidates everything after it |
| 4 | Images are stripped from all but the last `keepImagesInLast` (4) messages, so a message's content silently changes as the conversation advances past it | `llmContext.ts:88` | high |
| 5 | Consecutive same-role messages are merged, so an earlier turn's bytes change when a neighbour is dropped | `llmContext.ts:70` | medium |
| 6 | The active document is re-serialized every turn even when unedited | `chat/dynamicContext.ts` | medium |

Breaker 2 deserves emphasis: a user who changes nothing, attaches nothing and
asks a second question still gets a different byte sequence, because the score
of each chapter moved with the new prompt text. That alone can cost a full
re-prefill of 60k characters.

Prior art in this repo already does the right thing for one case:
`buildStickyBookPrefix` (`chat/wholeBook.ts:186`) injects the book as a
`user`/`assistant` pair **before** the history and marks it `cacheHint: true`.
This design generalizes that shape to the normal path.

## 4. Proposed layout

```
[ system prompt ]                     stable for the session
[ CONTEXT LEDGER ]  ← new             append-only, user/assistant pair, cacheHint
     chapter index (stable order)
     chapter A  (attached turn 1)
     chapter B  (attached turn 1)
     chapter F  (attached turn 4)     ← appended, never inserted
[ history ]                           append-only
[ VOLATILE TAIL ]                     re-prefilled every turn, deliberately
     active document (current bytes)
     USER REQUEST: …
```

The tail is then the active document plus the request — for a book with six
attached chapters that is the difference between re-reading ~70k characters
and re-reading ~8k.

**The active document stays in the tail.** It is the most volatile object in
the app and the `<edit>` protocol needs it adjacent to the request so SEARCH
blocks are copied from current bytes (2026-07-07 decision, unchanged). We pay
one document of prefill per turn and stop paying for everything else.

## 5. The context ledger

A session-scoped, ordered record of what has already been sent:

```ts
interface ContextLedger {
  /** Chapter ids in the order they were first sent. Never reordered. */
  sentIds: string[]
  /** Bytes as sent, per id — so a re-send is detectably identical. */
  sentHash: Record<string, string>
  /** Set when the ledger was rebuilt, to explain a cold turn in the UI. */
  invalidatedAt?: number
  invalidationReason?: 'user-evicted' | 'chapter-edited' | 'budget' | 'session-start'
}
```

Rules:

1. **Append-only.** A newly selected chapter is appended to `sentIds`.
2. **Order is insertion order**, never score order, never book order. Score
   decides *admission*, never *position*.
3. **No silent eviction.** The selector may no longer drop a chapter it
   previously attached just because this turn's scores changed.
4. **An edited chapter invalidates from its position onward.** If chapter B's
   content changed, everything from B on must be re-sent. Prefer to re-append
   B at the end and mark the old copy stale in the same message… which is not
   possible without rewriting the block, so this is a genuine invalidation —
   see §7 open question 2.
5. The ledger resets on: switching books, switching the active chapter, a
   provider/model change, or an explicit user reset.

## 6. When the user's request would evict — confirm

Per the request that motivated this design: when the context the user asks for
would *remove* something already in the ledger, stop and ask. Reuse the
existing inline consent panel (`ChatPanel.tsx:389`, the whole-book cost panel):
same 3-option shape, blocks the send until answered, no new modal component.

Triggers:

- The user un-pins or blocks a chapter already in the ledger.
- The budget cannot fit a newly required chapter without dropping an old one.
- The user switches to a chapter set that is not a superset of the ledger.

The panel states the real cost, not a vague warning:

> 移除《第三章》会使已缓存的前缀失效。下一次请求需要重新读入 6 章约 68,000
> 字符（本地端约 40 秒）。
> [ 仍然移除 ] [ 保留该章并继续 ] [ 取消 ]

"保留该章并继续" is the default: the chapter stays in the ledger (costing
budget but no prefill), while ceasing to be *presented* as user-selected.

## 7. Selection algorithm changes

`selectReferenceChapters` keeps its scoring but changes what it returns:

- Input gains `ledgerIds: string[]` (what has already been sent).
- Output gains `additions: string[]` (append these) and
  `evictions: string[]` (would need confirmation).
- `attachedIds` becomes `[...ledgerIds, ...additions]` — ledger order first.
- `SCORE_PREVIOUS_TURN` (+30) becomes redundant for ledger members and should
  apply only to *non*-ledger candidates, so it stops distorting admission.
- The budget check applies to additions only.

History windowing (`trimHistoryForContext`) changes:

- Trimming from the front is allowed only when it crosses a full invalidation
  we have already told the user about; otherwise raise the window.
- `keepImagesInLast` becomes a **fixed message index** captured when the
  message enters the window, not a rolling offset (kills breaker 4).
- Same-role merging happens at message-creation time, not at assembly time
  (kills breaker 5).

## 8. Acceptance criteria

Measured, not asserted:

1. Two consecutive turns with no chapter/document change produce token
   sequences whose common prefix covers everything before the volatile tail.
   Unit-testable without a model: assemble twice, compare strings.
2. Attaching one new chapter changes only the tail of the ledger block.
3. Reordering scores (different prompt wording, same chapter set) produces a
   byte-identical ledger block.
4. An eviction cannot happen without the consent panel firing.
5. On the local endpoint, turn 2 of a session reports a first-token time at
   least 5× lower than turn 1 for an unchanged chapter set (`api-server.log`
   already logs exactly this).

## 9. Open questions

1. **Where does the chapter index go?** It changes whenever any chapter's
   title or summary changes, and summaries are refreshed in the background.
   Putting it at the head of the ledger makes it a frequent invalidator.
   Options: (a) freeze the index in the ledger and accept staleness until the
   next reset, (b) move the index into the volatile tail (it is small), (c)
   split — frozen structure in the ledger, fresh summaries in the tail.
   Recommendation: **(b)**, it is a few hundred bytes against tens of
   thousands.
2. **An edited reference chapter.** Rule 4 above has no cheap answer: the
   chapter's bytes are in the middle of the ledger. Either invalidate from
   there (honest, expensive) or append a correction block ("chapter B has been
   revised; the authoritative text follows") and leave the stale copy in
   place, which costs tokens and risks the model reading the old version.
   Recommendation: invalidate, and surface it in the same consent panel.
3. **Does the sticky whole-book path merge into the ledger** or stay separate?
   It is the same mechanism with a different admission rule; merging them is
   tempting but the whole-book path also disables lookup and reshapes the
   budget.
4. **Per-provider cache markers.** `cacheHint` maps to Anthropic
   `cache_control` and is capped at 3 breakpoints (`llm.ts:549`,
   `server_generation.py:556`). With a ledger the natural breakpoints are:
   end of system, end of ledger, end of history. That is exactly 3 — no room
   for a fourth, so the design must not add another.

## 10. Not in scope

- Changing what the scorer *considers* (title/keyword/adjacency signals).
- The agentic `<lookup>` loop, beyond having it append to the ledger like any
  other admission.
- Roleplay mode, which has its own volatile game-state block and should be
  revisited separately once this lands.
