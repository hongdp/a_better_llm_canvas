# Pinned context: the agent explores, the user pins

Status: built 2026-10-10. Registered in the Decision Log of `docs/design.md`.
Supersedes, for turns with the agent tools on, the auto-selection of
[smart_context_selection.md](smart_context_selection.md) §4 and the sticky
admissions of [cache_first_context.md](cache_first_context.md). The ledger
itself (append-only, insertion-ordered, append-updates) is kept.

## 1. Why

Every turn still attached chapters by a keyword scorer, and every chapter
once attached stayed in the ledger for good: nothing removed it after manual
selection was retired (agentic_chat_loop.md D7). The bubble listed them as
`[Attached Context: …]`. Measured over the 63 agent turns since 2026-10-05
(assistant messages with an agent record):

| | count |
|---|---|
| Turns that carried attached chapters | 39 |
| Chapters attached in them (53 by the scorer that turn) | 125 |
| …of which the turn read or wrote | 19 |
| Reads of chapters that were not attached | 154 |
| Reads of chapters that already were | 34 |
| Writes to chapters not attached / attached | 45 / 13 |

And when the attached set changed, the request diverged at message #1 and
lost its cache (api-server.log since the prefix log began):

| Request | n | cache hit | median first token |
|---|---|---|---|
| ledger changed (message #1 differs) | 17 | 8% | 37 s |
| extends the previous request | 376 | 85% | 5 s |

The model works from the chapter index and its read tools; what the scorer
pushed in was mostly unused, and its churn cost the cache. What the model
does need on every turn are the book's standing references — character
cards, the plot outline, the setting — and only the writer knows which
chapters those are.

## 2. The design

- **A pin per chapter.** `documents.pinned` (server, `INTEGER 0/1`) and
  `CanvasDocument.pinned` (client). Set from the chapters sidebar (a pin
  button on each row, shown filled on pinned rows); `PUT
  /api/books/{id}/documents/{doc}` takes `{"pinned": bool}` as metadata —
  it does not bump the revision — and publishes a `document`/`pinned` event
  so other tabs resync. A user who is not signed in keeps pins locally.
- **What a turn carries (agent tools on).** The pinned chapters, in book
  order, the active chapter excluded (it is in the tail already), up to
  `PINNED_CONTEXT_CHARS` (60,000) of chapter text — each chapter counted as
  the ledger counts it (accepted HTML, at most 20,000) — and the rest of the
  pins skipped until some are unpinned. `pinnedContextIds` /
  `pinned_context_ids` (`utils/contextSelection`, parity-tested) decide it.
  That list is the ledger's `desiredIds`: an unpinned chapter leaves the
  ledger, a newly pinned one is appended, an edited one is appended as an
  update — all as before. No scorer, no "previously attached", no "the
  model read it last turn".
- **Nothing else changes in the request.** The CHAPTER INDEX (with
  summaries and freshness markers) and the active chapter stay in the
  volatile tail; the model reads anything else with `read_chapter` / `grep`
  / `analyze_book`. A chapter read last turn is read again when needed: its
  tool result is not replayed across turns (D4), and grep and paragraph
  ranges keep that to one cheap step.
- **No label.** The bubble no longer carries `[Attached Context: …]` lines
  on agent turns; the pins in the sidebar are what rides along. History
  stripping of the old labels stays, for old messages.
- **The first turn after this ships** drops whatever the scorer had put in
  the ledger (one re-prefill) unless the writer pins it.
- **Tools off** (the legacy single-document configuration): unchanged. That
  model cannot read anything itself, so auto-selection stays its only way to
  see other chapters.
- **Both transports**: `useChatLLM.assembleChatRequest` (tab runs) and
  `server_context.assemble_request` (server runs) branch the same way.

## 3. Also fixed with it

Server runs never added to the footer's Session Tokens (or "Last turn"
cache line): the counter was only fed by the tab's own steps. The run's
`step` events carry its cumulative usage; the tab now adds each step's
difference and shows that step's cache share.

## 4. Not built

Pins for attachments (they are read by reference, §1 of
attachments_and_web.md); pinning a paragraph range instead of a chapter; a
per-turn "include this chapter" control in the composer.
