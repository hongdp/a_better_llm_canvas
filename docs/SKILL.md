---
name: web-canvas
description: >
  An LLM-powered web frontend for document editing, inspired by OpenAI/Google Canvas.
  Users interact with a chat interface alongside a live document canvas, using LLM
  capabilities to draft, edit, rewrite, and refine documents collaboratively.
---

# Web Canvas — Project Principles

## 1. Design Principles

### 1.1 The Document is the Product
The canvas (document) is the primary artifact. Chat is a means to shape the document,
not an end in itself. Every UI decision should prioritize the reading and editing
experience of the document over the chat experience.

### 1.2 Minimal Friction, Maximum Control
- **Direct manipulation first**: Users should be able to select text and act on it
  (rewrite, expand, shorten, translate) without leaving the canvas.
- **Chat as fallback**: Complex or ambiguous instructions go through chat; simple
  operations should be accessible via inline controls, keyboard shortcuts, or
  context menus.
- **Never destructive**: Every LLM edit must be reviewable (diff view) and
  reversible (undo stack / version history). The user always has the final say.

### 1.3 Progressive Disclosure
- New users see a clean chat + canvas split. Advanced features (version history,
  model settings, export options) are discoverable but never in the way.
- Quick-action buttons (e.g., "Fix grammar", "Make concise", "Change tone") are
  visible for common tasks; the chat input handles everything else.

### 1.4 Visual Clarity
- LLM-generated changes are visually distinct from user edits (e.g., highlighted
  diffs, animated insertions).
- The UI clearly communicates state: idle, thinking, streaming, awaiting review.
- Dark mode and light mode are first-class citizens, not afterthoughts.

### 1.5 Responsive & Adaptive Layout
- Desktop: side-by-side chat + canvas.
- Tablet: collapsible chat panel, full-width canvas.
- Mobile: stacked layout with swipe navigation between chat and canvas.

---

## 2. Implementation Principles

### 2.1 Architecture
- **Frontend-only MVP**: The initial version runs entirely in the browser, calling
  LLM provider APIs directly from the client (API key stored locally). No backend
  server is required for v1.
- **Component-based UI**: Use a modern component framework. Keep components small,
  focused, and composable.
- **State management**: A single source of truth for document content, chat messages, and streaming lifecycle. Note: Asynchronous stream callbacks must query the fresh store state dynamically (e.g., `useAppStore.getState().messages`) rather than closing over local variable snapshots to prevent stale closure bugs.

### 2.2 Document Engine
- Use a battle-tested rich-text editing library (e.g., TipTap / ProseMirror,
  Lexical, or CodeMirror for code documents) rather than building from scratch.
- The document model must support:
  - **Operational transforms or CRDTs** for future collaborative editing.
  - **Structured diffs** so LLM edits can be shown as additions/deletions.
  - **Serialization** to Markdown and plain text for LLM prompt construction.
- **TipTap Sync Hook**: TipTap only reads content once on mount. To synchronize programmatically updated content (e.g., LLM streams), implement a `useEffect` hook that checks for updates and calls `editor.commands.setContent(content, { emitUpdate: false })` to avoid loop recursion.

### 2.3 LLM Integration
- **Provider-agnostic**: Abstract the LLM API behind a provider interface.
  Support OpenAI, Google Gemini, Anthropic, and local models (Ollama) from day one.
- **Streaming responses**: All LLM calls stream tokens into the document or chat
  in real time. Never block the UI waiting for a full response.
- **Prompt engineering is internal**: Users write natural language; the system
  constructs structured prompts (system message, document context, selection
  context, instruction) behind the scenes.
- **Context windowing**: For long documents, send only relevant sections (around
  the selection or the full document if small enough), not the entire history.
- **Canvas Markup Protocol**: Restructure streaming data separating conversational response text from document updates using XML-like blocks. The LLM wraps document updates inside `<canvas>...</canvas>` blocks, which the frontend extracts to stream directly to the editor canvas while routing outer text to the chat.
- **Dynamic Model Discovery**: Fetch available models dynamically via Google's ListModels API or provider configuration endpoints when the API key is set, falling back to static offline model lists if configuration is missing.

### 2.4 Code Quality
- TypeScript everywhere. No `any` types except at API boundaries with explicit
  validation.
- Every component has a clear interface (props/events). No prop drilling beyond
  two levels — use context or state management.
- CSS variables for theming. No magic numbers in styles.
- All user-facing strings are externalizable (prepare for i18n even if not
  implemented in v1).

### 2.5 Testing Strategy
- **Unit tests** for state management, prompt construction, and document
  transformations.
- **Integration tests** for the LLM provider abstraction (mock API responses).
- **E2E tests** for critical user flows: create document → chat edit → review
  diff → accept/reject.

### 2.6 Persistent Data Versioning
- **Versioned Envelopes**: Any persistent structures stored client-side (cookies, localStorage, or IndexedDB) that are subject to future updates MUST be stored in a versioned envelope `{ version: number, data: T }`.
- **Sequential Schema Migrations**: When updating a schema, increment the version number and write a safe, sequential migration pipeline (e.g., `v0 ➔ v1 ➔ v2`) to dynamically parse, map, and rewrite the stored state without destroying existing user settings.
- **Default Fallback Merging**: Migrated structures MUST always be merged with default configuration models to guarantee that newly introduced fields are correctly initialized for existing installations.
- **Self-Healing Persistent Layer**: Migrations must be triggered during store initialization, automatically rewriting the updated, validated, and versioned state back to client storage.

---

## 3. Operation Principles

### 3.1 Security & Privacy
- **No server, no data leakage (v1)**: API keys are stored in browser
  `localStorage` (or a more secure browser API if available). Document content
  never leaves the browser except to the user-configured LLM provider.
- **Key hygiene**: Warn users if they attempt to share/export a document that
  contains embedded API keys. Provide a "clear keys" action.
- **CSP headers**: If served from a static host, configure Content Security
  Policy to restrict outbound requests to known LLM API domains only.

### 3.2 Performance
- **Time-to-interactive < 2s** on a modern connection. Lazy-load non-critical
  features (version history panel, export module, settings).
- **Streaming latency**: First token from the LLM should appear in the UI within
  the network round-trip time — no artificial buffering.
- **Large documents**: The editor must handle documents up to 50,000 words
  without jank. Virtualize the rendering if needed.

### 3.3 Persistence & Recovery
- **Auto-save to localStorage** on every meaningful change (debounced).
- **Export**: Support exporting to Markdown, plain text, HTML, and PDF.
- **Import**: Support importing from Markdown and plain text files.
- **Crash recovery**: On reload, detect unsaved state and offer to restore.

### 3.4 Deployment
- Static site deployment (Vercel, Netlify, GitHub Pages, or any CDN).
- No server-side dependencies for v1.
- CI pipeline: lint → type-check → test → build → deploy.

### 3.5 Observability (Future)
- Optional, opt-in analytics for usage patterns (which quick actions are popular,
  average edit cycle length).
- Error reporting for failed LLM calls (rate limits, malformed responses) to
  surface issues to the user gracefully.

---

## 4. Development Workflow

### 4.1 Branching & Commits
- `main` is always deployable.
- Feature branches named `feat/<short-description>`.
- Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- **Pre-commit Verification**: Always execute comprehensive testing and compilation validation (e.g., run `npx tsc --noEmit` and build verification) **before** committing changes to ensure no broken code enters the branch history.
- **User Approval**: Never perform git commits unless explicit instruction or approval is obtained from the user.
- **Pre-commit Security Check**: Always perform a careful security scan (e.g., check `git diff` or staged files) **before** committing to ensure no private information, API keys, or local deployment configurations are accidentally staged or checked in.

### 4.2 Review Checklist
Before merging any feature:
- [ ] Does it follow the design principles above?
- [ ] Is the document editing experience still smooth?
- [ ] Are LLM edits reviewable and reversible?
- [ ] Does it work in both light and dark mode?
- [ ] Are there no regressions in existing E2E tests?

### 4.3 Documentation Rules
- Every separate design or feature specification document created must be registered in the **Decision Log** inside the main design document ([design.md](file:///home/hongdp/Workspace/web_canvas/docs/design.md#L375)) to maintain clear traceability.
- Always ensure all related design documents, feature specifications, and Decision Log entries are fully updated **before** committing changes or concluding a phase of work.

---

## 5. Local Deployment Workflow

This section outlines the guidelines and procedure to build and run the local development/deployment server for Web Canvas.

### 5.1 Prerequisites
- **Node.js**: Version 18 or higher.
- **npm**: Standard Node package manager.
- Install packages:
  ```bash
  npm install
  ```

### 5.2 Environment Configuration
Configure environment variables in `.env` (copying from `.env.example`). Configure API keys and storage parameters.
- `VITE_STORAGE_DIR`: Fallback storage path for books, users, and session databases (if not overridden via CLI).

### 5.3 Build Verification
Before deploying or checking in, compile TypeScript and bundle assets to verify build integrity:
```bash
npm run build
```

### 5.4 Launching the Server
Start the local server programmatically with custom configurations:
```bash
npm run dev -- --storage-dir <absolute-or-relative-path> [--host] [--mode debug]
```
- `--storage-dir`: Specify absolute/relative path where book states and database files are persisted.
- `--host`: Exposes the Vite dev server to external networks.
- `--mode debug`: Starts Vite in debug mode (enables debug logs).

Example command:
```bash
npm run dev -- --storage-dir /mnt/smb_data/media/noval/workspace --host
```

### 5.5 Listening Port Verification
Ensure the server is running and listening on port `5173`:
```bash
ss -tulpn | grep 5173
# Or
lsof -i :5173
```
