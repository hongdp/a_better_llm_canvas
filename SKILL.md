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
- **Safety Self-Healing & Prompt Editor UI**: When an LLM request fails due to a safety threshold or guideline violation (e.g. 403 Safety/CSAM blocks), the app automatically triggers a self-healing retry by applying local sensitive word censorship to the user prompts. If this auto-retry fails, the system transitions to an interactive Prompt Editor UI (`status === 'prompt_edit'`), allowing users to inspect/edit the raw system/user prompts, retry manually, or save progress and exit.

### 2.4 Code Quality
- TypeScript everywhere. No `any` types except at API boundaries with explicit
  validation.
- Every component has a clear interface (props/events). No prop drilling beyond
  two levels — use context or state management.
- CSS variables for theming. No magic numbers in styles.
- All user-facing strings are externalizable (prepare for i18n even if not
  implemented in v1).

### 2.5 Testing Strategy
- **Mandatory Unit Tests**: All new functionalities and components MUST be accompanied by comprehensive unit tests. You must write tests alongside your code to ensure correctness and prevent future regressions.
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
- **Sensitive Word Isolation**: Local sensitive keyword lists must be stored in a git-ignored JSON file (`public/sensitive_words.json`), using a template (`public/sensitive_words.json.example`) for developers. The web application dynamically fetches this file at runtime, ensuring sensitive keywords are kept out of source control.

### 3.2 Performance
- **Time-to-interactive < 2s** on a modern connection. Lazy-load non-critical
  features (version history panel, export module, settings).
- **Streaming latency**: First token from the LLM should appear in the UI within
  the network round-trip time — no artificial buffering.
- **Large documents**: The editor must handle documents up to 50,000 words
  without jank. Virtualize the rendering if needed.

### 3.3 Persistence & Recovery
- **Auto-save to localStorage / Backend**: Auto-save updates asynchronously in the background. In local setups, changes are persisted via write-through caching.
- **Hybrid Storage Model (IndexedDB + LocalStorage)**: Heavy workspace datasets like `documents` and `versions` (containing large embedded Base64 image payloads) are stored asynchronously using browser-native **IndexedDB** to avoid browser `QuotaExceededError` (5MB limit). Lightweight keys (e.g., `theme`, layout states, credentials) are stored in synchronous `localStorage` to prevent visual flashes.
- **Client-Side GIF Image Processing (First-Frame JPEGs)**: To support uploading and pasting GIF images up to 15MB, the app dynamically converts GIFs to static JPEGs using HTML5 Canvas. The conversion extracts the first frame of the GIF and compresses it, ensuring the resulting data URL fits within the 2MB size limit and works seamlessly with LLM Vision APIs.
- **Automated LocalStorage Migration**: On initialization, if the store detects legacy document or version keys in `localStorage`, it automatically imports them into the IndexedDB database and purges them from `localStorage` to free up space immediately.
- **Export**: Support exporting to Markdown, plain text, HTML, and PDF.
- **Import**: Support importing from Markdown and plain text files. Added local webpage HTML parsing and generation capability, allowing users to upload raw `.htm/.html` source pages (e.g. saved forum threads) to parse title, text paragraphs, and order-mapped images locally, resolving relative assets via the `<base>` tag and stripping advertisements and locked wrappers before feeding them to the chapter generation pipeline.
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
- [ ] Have unit tests been added for the new functionalities?
- [ ] Are there no regressions in existing tests (Unit/E2E)?

### 4.3 Documentation Rules
- Every separate design or feature specification document created must be registered in the **Decision Log** inside the main design document ([design.md](file:///home/hongdp/Workspace/web_canvas/docs/design.md#L375)) to maintain clear traceability.
- Always ensure all related design documents, feature specifications, and Decision Log entries are fully updated **before** committing changes or concluding a phase of work.

### 4.4 Language Policy
To ensure the codebase remains universally accessible and maintainable:
- **English Only for Project Files**: All project source code, documentation, inline comments, variable names, function definitions, pull request descriptions, and Git commit messages **MUST** be written in English.
- **Exceptions (Data and Configurations)**: You are allowed to use other languages (e.g., Chinese, Spanish, etc.) **ONLY** within data files, localized asset bundles, translation files (i18n), or user-facing configuration defaults where multiple languages are supported as part of the app's functionality.

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

### 5.6 Server Restart Gotchas

#### Stale Port 3000 Causes Silent Failures
The Python API server binds to `127.0.0.1:3000`. If a previous Python process is still alive (e.g. from a diagnostic run or a failed start), the new API server will fail with `[Errno 98] address already in use`, exit with code 1, and `start-server.js` will immediately kill Node/Vite too — the whole stack silently dies within seconds of appearing to start.

**Diagnosis flow:**
```bash
# 1. Check if both ports are up
ss -tlnp | grep -E "3000|5173"

# 2. Check which PID owns port 3000
lsof -i :3000

# 3. Run Python directly to confirm it starts clean
/home/hongdp/miniconda3/bin/python3 scripts/api_server.py \
  --storage-dir /mnt/smb_data/media/noval/workspace \
  --host 127.0.0.1 --port 3000
# Should print: [Storage Server] Listening on http://127.0.0.1:3000
```

**Fix — always hard-kill before restarting:**
```bash
pkill -9 -f "api_server.py" || true
pkill -9 -f "start-server.js" || true
sleep 2   # wait for OS to release ports
```

#### `pkill` and IDE Remote Connection Servers
When writing restart scripts, do not use `pkill -f "start-server"` or similar broad patterns if using remote IDEs (like VS Code Remote SSH or other agentic IDE environments). The IDE backend connection often runs as a node process with `--start-server` in its command line. Using `pkill -f "start-server"` will inadvertently kill the IDE connection and terminate your SSH session. Instead, match the specific script name (e.g., `api_server.py`, `start-server.js`) or use `fuser -k` on specific ports.

#### `start.sh -d` (daemon mode) is Unreliable in This Environment
The `nohup` + `disown` approach in `start.sh -d` does not reliably keep processes alive in this shell environment. The processes start but die within seconds because the parent shell exits before the children are fully detached.

**Preferred approach — use a persistent background task:**
```bash
npm run dev -- --storage-dir /mnt/smb_data/media/noval/workspace --host
```
Launch this as a persistent background task (via the agent's `run_command` with `RunPersistent: true`). The agent's task runner will keep the process alive independently of the shell session.

#### Checking True Server Health
`start.sh --status` only checks by process name. Prefer port-level verification for ground truth:
```bash
ss -tlnp | grep -E "3000|5173"
# Both lines present = both servers running
# Only 3000 present = Python up, Vite dead (likely port conflict on prior start)
# Neither = everything stopped
```

Also verify Vite responds:
```bash
curl -k https://localhost:5173 -o /dev/null -w "%{http_code}"
# Should return 200
```

---

## 6. LLM Image Analysis

### 6.1 Where the Image Prompt Lives
The LLM vision prompt for image analysis during URL import is in:
```
src/components/ImportUrlModal.tsx
```
Function: `analyzeImages` → inner `processImage` → `systemPrompt` constant (~line 1041).

### 6.2 Prompt Structure & Intent
The system prompt instructs the LLM to describe images in Chinese JSON format:
```json
{ "descriptions": [{ "index": <N>, "description": "..." }] }
```

**Current focus priority (in order):**
1. **People** — appearance (age, hair, skin, build), body parts (hands, arms, legs, feet, shoulders, neck, waist), clothing/style/accessories, posture & position in frame, facial expressions
2. **Multiple people** — describe each individually + their spatial relationships
3. **Scene/background** — brief setting and atmosphere

**Description length:** 100–250 Chinese characters.

### 6.3 Image Filtering Before LLM Call
Images are filtered before being sent to the LLM:
- Must be `image/jpeg`, `image/png`, `image/webp`, or `image/jpg` MIME type
- Must be `≥ 1000` bytes of base64 data
- Must be `≥ 512 total pixels` and neither dimension `< 20px`
- Tiny images (e.g. 15×13 emoji/icon placeholders common on Chinese forums) are silently skipped with the label `（配图尺寸过小，已忽略分析）`

**Concurrency:** Up to 10 images analyzed in parallel (`concurrencyLimit = 10`).
