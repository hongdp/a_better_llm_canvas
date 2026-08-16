# CLAUDE.md

Guidance for AI assistants (Claude Code and others) working in this repository.

## What This Project Is

**Web Canvas** (`a_better_llm_canvas`, npm package name `web_canvas`) is an
LLM-powered document editing workspace inspired by OpenAI/Google Canvas. A
rich-text document editor ("the canvas") sits side-by-side with a chat
assistant, letting writers draft, structure, and refine multi-chapter
books/documentation collaboratively with an LLM. It also has a roleplay
"game master" mode and an AI image-generation pipeline.

The authoritative product/engineering principles live in **`SKILL.md`** and the
architecture/decision record in **`docs/design.md`**. This file summarizes them
for day-to-day work — when they conflict, `SKILL.md` and `docs/design.md` win,
and you should update them alongside your changes (see Documentation Rules
below).

## Tech Stack

- **Frontend**: React 19 + TypeScript, Vite 8, Zustand 5 (state).
- **Editor engine**: TipTap 3 / ProseMirror (`@tiptap/react`, `starter-kit`).
- **Icons**: `lucide-react`. Styling is plain CSS (`src/index.css`) with CSS
  variables for theming (dark/light). There is no Tailwind dependency despite
  what the README's stack note implies — do not add Tailwind classes.
- **Backend**: a Python **FastAPI** server (`scripts/api_server.py`) for auth,
  per-user storage, and books/documents/versions CRUD, plus server-side URL
  scraping. It binds to `127.0.0.1:3000`; Vite proxies `/api/*` to it.
- **Tests**: Vitest (`jsdom`), see `vitest.config.ts`.
- **Lint/Types**: ESLint flat config (`eslint.config.js`), `tsc -b` for type
  checking.

## Repository Layout

```
src/
  App.tsx                 # Root component: layout modes, resizing, editor loop (~520 lines)
  main.tsx                # Entry point
  index.css               # CSS entry: ordered @imports of src/styles/* (order is load-bearing)
  styles/                 # Section stylesheets (tokens, base, editor, chat, responsive, ...)
  types/                  # Shared TypeScript types (barrel: types/index.ts)
    document.ts  llm.ts  chat.ts  import.ts  auth.ts
  store/
    useAppStore.ts        # Slice assembly + auto-save subscription + public re-exports
    types.ts              # AppState = intersection of slice interfaces
    slices/               # documentsSlice, booksSlice, settingsSlice, authSlice,
                          #   versionsSlice, chatSlice, uiSlice
    defaults.ts           # Mock documents, default provider configs/prompts
    settingsPersistence.ts# Versioned cookie/localStorage settings + migrations
    serverSync.ts         # initializeStoreFromServer / performSync
    syncRuntime.ts        # Module-level isInitialized/saveTimeout (single owner)
    persistence.ts        # localStorage / IndexedDB wrappers + documents envelope
    __tests__/            # persistence + storage API tests
  components/             # React UI components
    Editor.tsx            # TipTap editor host (fragile editor↔store sync — see SKILL.md)
    editorExtensions.ts   # TipTap extensions (DiffAddition/Deletion, CustomImage, ...)
    AppHeader.tsx  CanvasHeader.tsx  CanvasFooter.tsx  VersionHistorySidebar.tsx
    ChatPanel.tsx  ChaptersSidebar.tsx  SettingsModal.tsx  AuthForm.tsx
    ImportUrlModal.tsx    # Import state machine (Phase 0/1/2); steps in import/
    import/               # Import modal step components
    ImageGenerationModal.tsx  imageGen/   # Image-gen modal + step components
    RoleplaySetupModal.tsx  RoleplayBanner.tsx
  hooks/
    useChatLLM.ts         # Chat → LLM streaming orchestrator (ref-coupled core)
    chat/                 # Extracted chat-flow modules: wholeBook, streamHandlers,
                          #   dynamicContext, types
    useRoleplayLLM.ts     # Roleplay game-master mode streaming
    useDiffHandlers.ts  useModelFetcher.ts  useImageUpload.ts
  services/
    llm.ts                # Provider-agnostic streaming (OpenAI/Gemini/Anthropic/Ollama/Grok)
    chapterSummaries.ts   # Background chapter summarizer (lazy queue)
    imageGen.ts  imageGenModels.ts
    import/               # Import pipeline: parser, contentBuilder, imageProcessor,
                          #   scraper, prompts, responseParsers, visionFilter, errors
  utils/
    convert.ts  diff.ts  text.ts  export.ts        # pure helpers (well tested)
    llmContext.ts  chapterIndex.ts  contextSelection.ts  systemPrompt.ts
  i18n/                   # en.ts / zh.ts translation bundles + index.ts hook
scripts/
  start-server.js         # Orchestrator: spawns Python API + Vite (npm run dev)
  api_server.py           # FastAPI app entry: books/documents/versions routes
  server_config.py  server_db.py  server_content.py   # Backend helper modules
  server_auth.py  server_scrape.py  server_migration.py
  test_api_server.py      # pytest — patch state on the OWNING module (see docstring)
docs/
  design.md               # Architecture + Decision Log (register new design docs here)
  features/               # Per-feature design specs
public/                   # PWA manifest, service worker (sw.js), icons
.githooks/pre-push        # Runs `npm test` before every push
```

## Common Commands

```bash
npm install                 # install deps; `prepare` wires .githooks via core.hooksPath
npm run dev                 # start full stack (Python API + Vite) via scripts/start-server.js
npm run dev -- --storage-dir <path> --host   # custom storage dir, expose to LAN
npm run dev:debug           # Vite debug mode
npm run build               # tsc -b && vite build (always run before considering work done)
npm run lint                # eslint .
npm test                    # vitest run (the pre-push gate)
npm run test:watch          # vitest watch
npm run test:coverage       # coverage over utils, services/import, store/persistence
./start.sh [--daemon|--stop|--status|--logs]  # convenience wrapper around npm run dev
```

**Logs**: `app.log` holds the orchestrator + Vite output; the Python API
server's own output (including `web_canvas.*` log lines — job starts,
time-to-first-token, per-job summaries) goes to **`api-server.log`**. Grepping
`app.log` for API behavior finds nothing.

`npm run dev` does **not** just start Vite — `scripts/start-server.js` also
spawns the Python API server (preferring `~/miniconda3/bin/python3`, falling
back to `python3`) with auto-restart, and loads `.env`/`.env.local` into the
Node process. If the Python API can't bind `:3000` (stale process), the whole
stack dies — see SKILL.md §5.6 for the kill-before-restart procedure.

## Environment & Configuration

- Copy `.env.example` → `.env` and set provider keys (`VITE_GEMINI_API_KEY`,
  `VITE_OPENAI_API_KEY`, `VITE_ANTHROPIC_API_KEY`, `VITE_GROK_API_KEY`, etc.).
- `VITE_STORAGE_DIR` sets where the API server persists books/users/sessions
  (overridable via `--storage-dir`). Defaults to `./storage`.
- `.env`, `.env.*` (except `.env.example`), `storage/`, `.local_db/`, and
  `public/sensitive_words.json` are git-ignored. Never commit secrets, storage
  data, or the SQLite DB.

## Architecture Notes (read before editing)

### State: Zustand single source of truth
The store is assembled in `src/store/useAppStore.ts` from slice creators
under `src/store/slices/` (documents, books, settings, auth, versions, chat,
ui) and holds documents, chat messages, LLM/provider configs, versions, auth,
multi-book state, and sync status. The public API is re-exported from
`useAppStore.ts` — import from there, not from slice files. Key rules:

- **Stale closures**: async stream callbacks must read fresh state via
  `useAppStore.getState()` rather than closing over snapshots.
- **Optimistic UI**: server-mutating operations (book create/update/delete)
  update local state *synchronously first*, then fire-and-forget to the server.
  On failure set `serverSaveStatus: 'failed'` — do **not** roll back local
  state. See `createNewBook`.

### Persistence: hybrid IndexedDB + localStorage
Heavy data (`documents`, `versions` with base64 images) goes to **IndexedDB**
(via `store/persistence.ts`) to dodge localStorage's ~5MB `QuotaExceededError`.
Lightweight keys (`theme`, layout, credentials) stay in synchronous
`localStorage` to avoid render flashes. Document saves are debounced (1s) and
flushed on `beforeunload`. Legacy localStorage keys are auto-migrated into
IndexedDB on init.

### Versioned persistence envelopes
Any persisted client structure that may evolve MUST use a versioned envelope
`{ version: number, data: T }` with sequential migrations (`v0→v1→v2`) and
default-field merging. Migrations run at store init and rewrite validated state
back to storage. **Every migration needs a test** that feeds a prior-version
payload and asserts the upgraded shape.

### Editor sync: the TipTap rollback race
TipTap reads content once on mount. Programmatic updates (LLM streams) use a
`useEffect` calling `editor.commands.setContent(content, { emitUpdate: false })`.
A `contentFromEditorRef` tracks editor-originated HTML; `setContent` is skipped
when incoming content matches, otherwise user edits "roll back" after a paste.
This is a performance-critical, fragile pattern — see `Editor.tsx` and
SKILL.md §2.2/§3.2 before touching the editor↔store loop.

### LLM integration
`services/llm.ts` exposes `streamLLM(messages, config, callbacks)`, dispatching
to OpenAI/Ollama/Grok (OpenAI-compatible), Gemini, or Anthropic. All responses
**stream**; never block the UI. The **Canvas Markup Protocol** wraps document
updates in `<canvas>...</canvas>` blocks so the frontend can route document
content to the editor and conversational text to chat. The static system
prompt (`utils/systemPrompt.ts`) carries the protocol ONLY — channels, markup,
status line. Persona, task, and style guidance belong to the user's preset and
their message; do not add writing instructions to the system prompt. Every reply must also end with a
`<doc_status>updated|unchanged</doc_status>` declaration — **mandatory, on
every reply**, including ones that change nothing. The model decides whether an
edit was warranted; the client rejects a turn only on evidence from the reply
itself: no declaration at all (`undeclared`), a declared update with no markup
(`claimed`), markup the parser rejected (`malformed`), or a first-person claim
of having written next to a `unchanged` declaration. Never re-add local guessing
of user intent.
Safety failures (403)
trigger a self-healing retry with local sensitive-word censorship, then an
interactive Prompt Editor UI (`status === 'prompt_edit'`).

### Backend API (`scripts/api_server.py`)
FastAPI with cookie-based sessions (HttpOnly, SameSite=Lax) + CSRF
double-submit tokens. Per-user storage isolated as `state_<username>.json` /
per-book files; metadata indexed in a local SQLite DB at `.local_db/metadata.db`
(DELETE journal mode, kept off network mounts). Endpoints are under `/api/*`:
auth (`/api/auth/*`), books (`/api/books`, `/api/books/{id}`), nested documents
and versions, legacy `/api/storage`, and scraping (`/api/import-url`,
`/api/import-file`). **Performance**: list endpoints extract metadata by regex
over the first few KB of large JSON files rather than full-parsing; the save
endpoint reorders JSON keys so `bookTitle`/`updatedAt` stay within that window.

## Conventions

- **TypeScript everywhere**; avoid `any` except at API boundaries with explicit
  validation. `tsconfig` enables `noUnusedLocals`/`noUnusedParameters` — unused
  symbols fail the build.
- **English only** for code, comments, identifiers, docs, and commit messages.
  Non-English text is allowed only in data/i18n/translation files (`src/i18n/`)
  and user-facing localized defaults.
- **Shared types** live in `src/types/` and are re-exported through
  `types/index.ts`; the store re-exports many for backward compatibility.
- **Document performance fixes inline** with a Problem / Root Cause / Fix block
  comment (SKILL.md §3.6) so cleanup refactors don't silently revert them.
  Applies to backend code too.
- **Sensitive word lists** stay in git-ignored `public/sensitive_words.json`
  (template: `….example`), fetched at runtime — never hardcode them in source.

## Testing

- Vitest, `jsdom`, globals enabled. Shared setup in `src/test-setup.ts`.
- The runner only discovers `src/**/__tests__/**/*.test.ts` — tests outside that
  pattern are silently ignored. Co-locate tests in a `__tests__/` dir next to
  the code; name them `<module>.test.ts`.
- Priority: pure logic (transformations, parsing, diffing, serialization,
  migrations) → store actions → persistence/migrations → component behavior.
- **Hook flow tests**: `useChatLLM` has re-entrant paths (lookup continuation,
  no-action retry, normal completion) that share one assistant bubble and can
  only be covered end-to-end. `src/hooks/__tests__/useChatLLM.test.ts` drives
  the real hook against a scripted `streamLLM` mock and asserts on the store,
  using a ~20-line `createRoot` + `act` harness — there is no
  `@testing-library/react` dependency, and adding one is not required. Keep
  such tests in `.ts` (no JSX) so the runner's `include` pattern picks them up.
- Tests must be deterministic and isolated; reset store/mocks/storage in
  `beforeEach`/`afterEach`; mock only at boundaries (`fetch`, LLM calls, timers).
- Coverage is collected over `src/utils/**`, `src/services/import/**`, and
  `src/store/persistence.ts`. Extend the `include` list in `vitest.config.ts`
  when adding non-trivial pure-logic modules elsewhere.
- **New logic is not "done" until `npm test` passes and the logic is covered.**

## Git Workflow

- `master` is the default/deployable branch. Feature branches: `feat/<desc>`.
- **Conventional commits**: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- A `pre-push` git hook (`.githooks/pre-push`, wired by `npm run prepare`) runs
  `npm test` and blocks the push on failure. Bypass only in emergencies with
  `git push --no-verify` (discouraged).
- Before committing: run the unit suite (`npm test`), type-check/build
  (`npm run build` or `npx tsc --noEmit`), and a security scan of the diff for
  stray secrets/keys/local config.
- **Do not commit unless the user explicitly asks.** Do not open a PR unless the
  user explicitly asks.

## Documentation Rules

- Every new design or feature spec must be registered in the **Decision Log**
  inside `docs/design.md` for traceability.
- Keep design docs, feature specs, and the Decision Log updated **before**
  committing or wrapping a phase of work.
- When you change behavior covered by `SKILL.md`, update `SKILL.md` too.

## Review Checklist (before merging a feature)

- [ ] Follows the design principles in `SKILL.md`.
- [ ] Document editing experience stays smooth; LLM edits remain reviewable
      (diff) and reversible (undo / version history).
- [ ] Works in both light and dark mode.
- [ ] Unit tests added for new functionality; no regressions (`npm test` green).
- [ ] `npm run build` / type-check passes; no secrets in the diff.
