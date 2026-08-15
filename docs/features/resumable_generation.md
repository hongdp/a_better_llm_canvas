# Feature Specification — Server-Side Resumable Generation

Status: **In implementation**

## 1. Why

LLM generation runs in the browser tab: `services/llm.ts` streams straight
from the provider. When the tab dies, the stream dies with it — and mobile
Firefox routinely discards a backgrounded tab, so switching apps during a
long generation loses everything produced so far. Measured on-device: the
injected JS context was destroyed and the page came back with
`navType: "reload"` after ~15 s in the background.

No client-side trick fixes this. Wake locks do not survive a deliberate app
switch, and a half-received stream cannot be resumed from the client because
the provider connection is gone. The generation has to live somewhere that
outlives the tab: **the backend already running on the user's machine**.

Secondary wins: generation started on the phone can be watched on the
desktop, and closing the tab no longer aborts work in flight.

## 2. Shape

```
browser                     FastAPI backend                  provider
   │  POST /api/generate ────────►│
   │  ◄──── { jobId }             │──── streaming request ───►│
   │                              │◄──── deltas ──────────────│
   │  GET  …/stream?from=0 ──────►│   (buffered in the job)
   │  ◄──── replay + live SSE ────│
   │                              │
   │  (tab dies, reloads)         │   generation continues
   │  GET  /api/generate/active ─►│
   │  ◄──── [{ jobId, … }]        │
   │  GET  …/stream?from=1234 ───►│
   │  ◄──── the rest ─────────────│
```

The job keeps generating regardless of who is listening; the buffer is the
source of truth and any number of readers may attach at any offset.

## 3. HTTP contract

All endpoints require the existing session cookie; POSTs require the CSRF
header, exactly like the rest of `/api/*`.

### `POST /api/generate` → `{ "jobId": "gen-…", "createdAt": "…" }`

```jsonc
{
  "provider": "openai|gemini|anthropic|ollama|grok",
  "config": {                    // same fields the client uses today
    "apiKey": "…", "model": "…", "baseUrl": "…",
    "maxOutputTokens": 16384,
    "geminiSafetySettings": [ … ]   // gemini only
  },
  "messages": [
    { "role": "system|user|assistant", "content": "…",
      "images": ["data:image/…"],     // optional
      "cacheHint": true }             // optional, Anthropic breakpoints
  ],
  "meta": {                      // opaque to the server, echoed back
    "bookId": "…", "documentId": "…",
    "assistantMessageId": "…",
    "kind": "chat|roleplay|summary|batch"
  }
}
```

Starts streaming immediately in a background task and returns as soon as the
job is registered — the caller does not wait for the first token.

### `GET /api/generate/{jobId}/stream?from=<charOffset>` → SSE

Replays everything already buffered past `from`, then continues live:

```
data: {"type":"delta","text":"…","offset":1234}
data: {"type":"done","offset":5678,"usage":{"promptTokens":…,"completionTokens":…,"cachedPromptTokens":…}}
data: {"type":"error","message":"…","offset":1234}
```

`offset` is the buffer length after applying that event, so a reconnecting
client passes the last offset it rendered and never sees a duplicate or a
gap. Attaching to a finished job replays the whole buffer and ends with the
terminal event.

### `POST /api/generate/{jobId}/abort` → `{ "success": true }`

Cancels the provider request. The job stays readable (status `aborted`) so
clients can keep the partial text.

### `GET /api/generate/active` → job list

```jsonc
[{ "jobId": "…", "status": "running|done|error|aborted",
   "meta": { … }, "length": 1234, "createdAt": "…", "updatedAt": "…" }]
```

Used on page load to find a generation that outlived the tab.

## 4. Retention and limits

- Jobs live in memory, keyed per user. Finished jobs are kept **10 minutes**
  so a reload right after completion still gets the result.
- At most **20 jobs per user**; the oldest finished job is evicted first, and
  a running job is never evicted.
- Buffer cap **4 MB** per job; past that the job keeps streaming to
  subscribers but stops growing the buffer and marks `truncatedBuffer: true`
  (a whole-book batch answer is far below this).
- A server restart drops in-flight jobs. That is accepted for v1: the client
  keeps its own partial text (§5) so nothing the user could already see is
  lost.

## 5. Client

`streamLLM(messages, config, callbacks)` keeps its signature — every caller
(`useChatLLM`, `useRoleplayLLM`, chapter summaries, whole-book batches) is
unchanged. Internally it picks a transport:

- **remote** (default when logged in): POST the job, persist
  `{ jobId, meta, offset }` to localStorage, attach to the SSE stream, and
  map events onto the existing `onChunk` / `onDone` / `onError` callbacks.
  The persisted offset advances as chunks are rendered.
- **direct** (not logged in, or the remote start fails): today's code path,
  untouched, so the app still works fully offline from the backend.

Rejoin on load: if the persisted job is still `running` (or finished within
the retention window and its text was never fully rendered), the client
re-attaches from the stored offset and streams into the same assistant
message, so a reloaded tab visibly continues where it left off.

Abort: the stop button calls the abort endpoint as well as dropping the
reader, so stopping on one device stops the actual generation.

## 6. Security notes

Provider API keys already reach this backend (they are part of the synced
`providerConfigs` settings blob), and the backend is the user's own machine
behind their own auth. The job endpoints add no new exposure class, but two
rules hold: keys are never logged (the existing masking helper applies), and
jobs are strictly scoped to the creating username — a job id from another
user's session must 404, not leak.

## 7. Testing

- **pytest**: job registry lifecycle (create → buffer → done), replay from an
  offset (no duplicates, no gaps), abort, retention/eviction, per-user
  isolation (another user's job id 404s), and provider request building for
  all five providers with a stubbed HTTP layer.
- **vitest**: the remote transport maps SSE events onto the callback
  contract; a reconnect resumes from the stored offset; a failed remote start
  falls back to the direct path; abort calls the endpoint.
- **End-to-end**: a stub provider served locally, driven through the real
  backend, verifying that killing and re-attaching a reader loses nothing.
