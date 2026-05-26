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
- **State management**: A single source of truth for:
  - Document content (current state + history)
  - Chat messages
  - LLM request/response lifecycle
  - UI state (panel layout, selection, active tool)

### 2.2 Document Engine
- Use a battle-tested rich-text editing library (e.g., TipTap / ProseMirror,
  Lexical, or CodeMirror for code documents) rather than building from scratch.
- The document model must support:
  - **Operational transforms or CRDTs** for future collaborative editing.
  - **Structured diffs** so LLM edits can be shown as additions/deletions.
  - **Serialization** to Markdown and plain text for LLM prompt construction.

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

### 4.2 Review Checklist
Before merging any feature:
- [ ] Does it follow the design principles above?
- [ ] Is the document editing experience still smooth?
- [ ] Are LLM edits reviewable and reversible?
- [ ] Does it work in both light and dark mode?
- [ ] Are there no regressions in existing E2E tests?



