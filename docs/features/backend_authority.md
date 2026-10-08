# Backend authority: server-side state and agent (Python)

Status: **phase 1 implemented** (2026-10-06): chapter revisions, conflict
handling and book events, as built in §4.1. Phases 2–4 are proposed.
Registered in the Decision Log of `docs/design.md`.

The decisions already taken (user, 2026-10-06):

- **The server is the single source of truth** for chapters, versions, chat
  messages and agent runs. The frontend is a UI over that state.
- **The agent runs on the server, in Python.** The loop, the tools, context
  assembly and the text logic they rely on are ported from TypeScript. The
  option of a Node service reusing the TypeScript was considered and not
  chosen.
- **Offline: only a temporary cache.** Edits made while disconnected are
  held locally and submitted on reconnect against the revision they were
  based on. A conflict is shown, never silently merged.
- **Paused until this lands:** keeping text written for a chapter that
  does not exist yet, and queueing requests. They are specified here (§6)
  and built server-side. Creating a chapter the moment its write arrives
  was paused too, and landed client-side on 2026-10-06 instead (§6.1).

## 1. Why

Today the browser owns the truth. The Zustand store holds the documents,
persists them to IndexedDB, and PUTs them to the server last-write-wins.
The agent loop (`src/agent`, `useChatLLM`) runs in the page. The server
stores files, authenticates, and relays model calls as resumable jobs
(`server_generation.py`).

Every recent failure traces back to that split:

| Observed (2026-10-06) | Cause |
|---|---|
| A 19-chapter run stopped at chapter 19 | A page reload killed the loop; a rejoined stream can finish one step but not continue the run |
| A run's third step hung as "running" | A service restart killed the job; the bubble's state lives in the page |
| A selection rewrite (2510 chars) was dropped | The write depended on the editor showing the right chapter at the right moment |
| Edits beside a selection could write one chapter over another | Editor, store and run each held a copy of "the chapter" |
| Requests cannot be queued across devices or reloads | The queue would live in one page's memory |

Each was patched where it surfaced. The structure behind them stays:
three copies of each chapter (editor, store, run) are kept in step from
inside a page that can disappear at any time.

## 2. Target architecture

```
 Browser (UI only)                         Server (truth + agent)
 ─────────────────                         ──────────────────────
 TipTap editor (local, fast typing) ──patch(baseRev)──▶ Document store (revisions)
 Chat panel, timeline, review UI   ◀──── events (SSE) ── Run engine (asyncio)
 Temporary offline cache                                  ├─ tool registry (Python)
                                                          ├─ context assembly
                                                          └─ LLM transports (existing)
```

### 2.1 Documents with revisions

- Every chapter has a monotonically increasing `revision`.
- **Every write carries the revision it was based on**: the user's typing
  (debounced patches), accept/reject, renames and reorders, and the
  agent's writes. The server applies it only if the base matches, else
  answers `409` with the current revision and content.
- The run engine writes through the same path, so the `RunState.known`
  rule (refuse a write to a chapter the user changed meanwhile) becomes the
  ordinary revision check.
- Version snapshots are taken by the server before the first agent write
  to a chapter in a run, as `commitDoc` does today.
- The client store becomes a cache. It renders server state and applies
  server events.

### 2.2 Events

One server-sent event stream per open book, carrying:

- `doc.updated {id, revision, content | patch, by}`: from any writer,
  any device;
- `run.*`: `started`, `step` (text deltas, tool timeline items),
  `preview` (partial rewrite text for a chapter), `finished`, `queued`;
- `lock {chapterIds}`: chapters the run is writing into (the edit lock of
  agentic_chat_loop.md §0.4, decided on the server).

A reconnecting client resumes from an event id. The resumable-job buffers
in `server_generation.py` already work this way for one generation; this
generalizes them to the book.

### 2.3 Run engine

- **One asyncio task per run, one run at a time per book.** Further
  requests wait in a per-book **queue** (§6.3).
- **Each step is persisted before it is executed:** the request messages
  (append-only, as today), the reply, the tool results. A server restart
  resumes the run at its last completed step, instead of losing it.
- **The LLM transports are the existing ones** in `server_generation.py`,
  called in-process instead of via `/api/generate`.
- **Tool execution reads and writes the document store**, never an editor:
  - the live preview is an event the client paints;
  - a selection rewrite is placed by text (`alignSelectionBlocks`, already
    built this way), from the request's captured selection text.

#### Runaway runs (user decision, 2026-10-08)

On the client, three things end a run that does no useful work: the user
presses Stop, a reload or a closed tab kills it, and `agentMaxSteps`. On the
server the first two are gone by design (a run outlives the tab), and the
user has set the step limit to 0 for grok. A 127-step run that never wrote
(2026-10-07) would burn tokens unattended. The server therefore **pauses,
never kills**, consistent with "analyze the cause, do not forbid":

- **Pause with a notice.** When the last N steps repeated the same calls
  with the same results and wrote nothing, or when a run's accumulated
  cost passes a budget, the run is suspended and a `run.paused` event names
  why, with the last steps' reasoning summaries (the step journal). The
  user resumes it, changes the instruction, or abandons it; the persisted
  steps make a resume exact.
- **Unattended runs are tighter.** While a tab is attached the user's
  settings apply, 0 steps included. Once every tab has gone, a run that
  passes the unattended step or cost ceiling pauses on its own.
- **Budget in money.** Usage is already recorded per step; the run keeps
  the running total and pauses at the configured amount.

### 2.4 Frontend

- **`useChatLLM` shrinks to a renderer**: send a request, cancel it, and
  apply `run.*` events to the bubble and the editor.
- **The editor keeps typing local and smooth.** It sends patches; on
  `409` it rebases or shows the conflict.
- **The `Editor.tsx` content-sync race simplifies.** Every external change
  arrives as a `doc.updated` with a revision, so "did this come from me?"
  becomes a revision comparison instead of the `contentFromEditorRef`
  string match.
- **IndexedDB keeps only the temporary offline queue.**

## 3. What is ported to Python

Measured on `claude/chat-agentic-loop-tools-26ee78` (non-test lines):

| Area | Source | Lines |
|---|---|---|
| Loop, policy, registry, invocations, tools, freshness, polish | `src/agent/**` | ~2,500 |
| Request assembly, stream splitting, ledger planning, prompts | `src/hooks/useChatLLM.ts`, `src/hooks/chat/*` (the non-React parts) | ~1,200 of 2,660 |
| Text logic | `utils/text.ts` (edit matching, 6 levels), `diff.ts` (custom LCS, no library), `diffResolution.ts`, `paragraphs.ts`, `polish.ts`, `systemPrompt.ts`, `contextLedger.ts`, `chapterIndex.ts`, `contextSelection.ts`, `pendingChanges.ts`, `imagePreservation.ts`, `llmContext.ts` | ~3,300 |

**HTML parsing.** Several of these use the browser's `DOMParser`
(paragraphs, image handling, plain-text extraction). Python uses one parser
for all of them; `html5lib` follows the same HTML5 algorithm as browsers.
TipTap's own normalization (what the editor stores after a round trip) is
NOT reproduced. The server stores what it is sent, and the editor's
normalized output arrives as an ordinary user patch.

**Parity before replacement.** The TypeScript suites are the
specification:

- every pure function gets its test cases ported as fixtures;
- a parity harness runs the same inputs through both implementations
  (Node in CI, as the provider-message parity tests do today) and must
  match byte for byte for `diffHtml`, edit application and prompt
  assembly;
- prompt bytes matter beyond correctness: grok's cache is exact-prefix, so
  a one-character drift in assembly costs every cached prefix.

## 4. Phases

Each phase ships on its own and leaves the app working.

| Phase | Scope | Exit criterion |
|---|---|---|
| 1. Document authority | Revisions on chapters; revision-checked writes (user, accept/reject, agent writes from the current client loop); `doc.updated` events; store as cache; offline queue | Two tabs editing different chapters stay in sync; a stale write gets 409 and a visible conflict, never a silent overwrite |
| 2. Pure logic in Python | Port §3's text logic and prompt/context assembly, with ported fixtures and the parity harness | Parity harness green on every fixture and on a replay of real stored turns |
| 3. Server run engine | Run API and `run.*` events; tools against the document store; persisted steps and resume after restart; per-book queue; client loop kept behind a per-provider switch | A run survives a page reload and an API restart; a request sent mid-run queues |
| 4. Retire the client loop | Remove `src/agent` from the bundle and shrink `useChatLLM` to the renderer; build the three paused features (§6) server-side | No agent code in the frontend; the paused features shipped |

### 4.1 Phase 1 as built

**Server** (`scripts/api_server.py`, `server_events.py`, `server_db.py`,
`server_content.py`; tests in `test_document_authority.py`):

- `documents.revision` (INTEGER, default 1; added to existing databases at
  startup). Every read returns it; create returns `revision: 1`.
- `PUT /api/books/{id}/documents/{doc}` takes an optional `baseRevision`.
  A text or title change is applied with a conditional `UPDATE … WHERE
  revision = ?`; a stale base gets **409** with the chapter as it is now
  (`revision`, `title`, `content`). A write without a base still wins, so
  an older client keeps working. A summary-only save neither bumps the
  revision nor publishes an event: a background summary would otherwise
  turn every open tab's next save into a conflict.
- Content files are replaced atomically (temp file + `os.replace`).
- **Events:** `GET /api/books/{id}/events` is a server-sent event stream
  from an in-process hub (one uvicorn process, so a dict of asyncio queues
  is the broker). Kinds: `document updated|deleted` and `documents
  created|replaced|reordered`. Each carries the writer's `X-Client-Id`, so a
  tab ignores its own echo. A 15s heartbeat comment keeps proxies from
  closing an idle stream; a subscriber that stops reading (256 queued) is
  dropped and reconnects. Measured through the Vite proxy: an event
  arrives about 20 ms after the write's response.

**Client** (`src/store/documentSync.ts`, `bookEvents.ts`; tests in
`src/store/__tests__/documentSync.test.ts`, `initialBookChoice.test.ts`):

- `CanvasDocument.revision` is the server revision the local text is based
  on; `unsynced` marks a text or title change the server has not
  confirmed. Both persist with the chapter in IndexedDB, so a reload cannot
  drop an edit made inside the save debounce. Optional fields: an older
  record reads as "synced, revision unknown", no migration needed.
- `serverCopies` records each chapter as the server last confirmed it, on
  **load as well as on save**. A save sends text only for a chapter that
  differs from it or is unsynced, with `baseRevision`. Re-sending an
  unchanged chapter after a reload would bump its revision and make
  another tab's next save a conflict.
- **A 409** keeps the local text as a version snapshot, adopts the server's
  copy and shows a banner ("Open history"). Two identical copies are
  adopted silently. The agent's writes take the same path: they mark the
  chapter unsynced like typing does.
- **Loading a book** (`initializeStoreFromServer`, `switchBook` on the same
  book) keeps every unsynced local chapter, text and base revision,
  instead of an empty stub (`mergeServerChapters`), and keeps an unsynced
  chapter only this device holds. `switchBook` saves unsynced chapters
  before it reloads.
- **The cache belongs to one book.** Startup may open another book than
  the cache holds (the account moved on, on another device). Then the
  cache's unsynced chapters are saved to **their** book first
  (`saveOtherBookEdits`; a 409 there becomes a version in that book) and
  are not merged into the one that opens.
- **Events** (`connectBookEvents`, wired in `App.tsx` per open book):
  - a chapter with an unsynced edit is never overwritten (its save will
    conflict instead);
  - a newer revision of a loaded chapter is fetched and adopted (unless a
    keystroke landed during the fetch);
  - an unloaded chapter only moves its revision;
  - structural events, and a reconnect after a drop, re-read the chapter
    list (`resyncBook`).
  
  During an agent run, an event that changes a chapter the run has read
  surfaces as a user edit, and the run refuses to write over it
  (agentic_chat_loop.md, the `RunState.known` rule).

**Not in phase 1**, by choice:

- event resume by id: a reconnect re-reads the list instead;
- patches: full chapter HTML per debounced save stays;
- `lock` and `run.*` events (phase 3);
- server-taken version snapshots;
- shrinking IndexedDB to an offline queue (it remains the full cache);
- the focus-time check still reloads the whole book through `switchBook`
  when another device wrote. It also brings chat and settings, which have
  no events yet.

## 5. Risks

- **Size.** About 7,000 lines and their tests are rewritten. Mitigation:
  phases 1–2 change no behavior, and the parity harness turns the port
  into a mechanical, checkable task.
- **Diff and edit-matching drift.** These are the most subtle code paths
  (six matching levels, span diffs, pending-markup rules). Mitigation:
  port them first and test them hardest.
- **Preview latency.** Preview text now travels model → server → browser,
  instead of model → server job → browser with the client parsing it. The
  hop count is the same; the parse moves to the server.
- **Two implementations during the transition.** The switch in phase 3
  keeps one path authoritative per provider at a time; the parity harness
  keeps them from diverging.

## 6. Paused features, as they will work server-side

### 6.1 Creating a chapter the moment its call arrives

**Landed client-side, 2026-10-06** (agentic_chat_loop.md §0, "creating IS
writing"): there is no `create_chapter` any more. A chapter is created by
the write that fills it — `<canvas new_chapter="title">` creates it as soon
as the opening tag has streamed, so the live preview runs in it; a
`new_chapter` write through `update_document` creates it when the call
completes. A chapter whose write never landed is removed at run end; on
Stop it is kept with its draft. The server run engine (phase 3) ports this
behaviour as is: the write's first bytes create the chapter and the
`preview` events follow.

### 6.2 Keeping text written for a chapter that does not exist

A full rewrite (`<canvas chapter="X">`, `update_document`) naming a chapter
that does not exist, with no `create_chapter("X")` in the same reply, is
held rather than refused. The model is told: "No chapter 'X' exists. Your
text is kept: call create_chapter("X") and it will be written there; do not
send the text again."

- Calling `create_chapter("X")` is the confirmation: the held text is
  written without being generated again.
- Titles match ignoring whitespace differences (ASCII vs ideographic
  space).
- Numbered references match the new chapter's number.
- Text still held when the run ends is discarded, with a note in the
  bubble.
- Partial edits (`<edit>`) to a missing chapter have nothing to hold and
  are refused as today.

### 6.3 Queueing requests

A request sent while a run is active joins the book's queue and is shown
as queued (cancelable).

- **Bound to the chapter that was open when it was sent**, not the one
  open when it runs (user decision).
- **A selection made with it** is carried as its text, and placed by text
  when it runs.
- **Stop pauses the queue** (user decision): the current run stops, and
  queued requests stay listed, each with "send now" and "remove".
- **Server-side**, so the queue survives reloads and is the same on every
  device.

## 7. Open questions

- **Event transport:** SSE is enough for server→client. Do patches go over
  plain HTTP, or does a WebSocket become worthwhile for typing?
- **Patch format:** full chapter HTML per debounce (simple; chapters are
  tens of KB), or ProseMirror steps (smaller; ties the server to the
  editor's schema)? Start with full HTML plus revision.
- **Roleplay mode and the import pipeline** are client-driven too. They
  are out of scope here; they keep working against the new document API.
