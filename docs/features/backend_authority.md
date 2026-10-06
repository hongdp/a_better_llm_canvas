# Backend authority: server-side state and agent (Python)

Status: **proposed** (2026-10-06). Nothing is implemented yet. Registered in
the Decision Log of `docs/design.md`.

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
- **Paused until this lands:** creating a chapter the moment its call
  arrives (live preview for a new chapter), keeping text written for a
  chapter that does not exist yet, and queueing requests. They are
  specified here (§6) and built server-side.

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

When a `create_chapter` call is complete in the stream, the server creates
the chapter immediately. It does not wait for the reply to finish. Text
already streamed for that chapter is emitted as one `preview`, and the
rest follows live. If the call arrives after the text, the text lands when
the reply ends, as today. A Stop after the early creation leaves an empty
chapter, which `delete_chapter` or the user can remove.

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
