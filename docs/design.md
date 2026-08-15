# Web Canvas — Design Document

## 1. Overview

**Web Canvas** is an LLM-powered document editing frontend inspired by OpenAI Canvas
and Google's Gemini Canvas. It pairs a rich-text document editor ("the canvas") with
a conversational chat interface, enabling users to draft, edit, and refine documents
through natural language instructions and direct manipulation.

### 1.1 Goals

| # | Goal | Success Metric |
|---|------|----------------|
| G1 | Fluid document editing via LLM | Users can go from blank page to polished document in < 5 chat turns |
| G2 | Inline, reviewable edits | Every LLM change shows a diff; accept/reject per-change |
| G3 | Provider-agnostic | Works with OpenAI, Gemini, Anthropic, and Ollama out of the box |
| G4 | Zero backend (v1) | Fully static deployment; API keys stay in the browser |
| G5 | Premium, modern UI | Comparable visual quality to ChatGPT / Gemini web apps |

### 1.2 Non-Goals (v1)

- Real-time multi-user collaboration (future).
- Server-side API key management or user accounts.
- Code execution or REPL-style code canvas (text documents only in v1).
- Plugin / extension system.

---

## 2. User Flows

### 2.1 Core Flow — Chat-Driven Editing

```
┌─────────────────────────────────────────────────────┐
│  User opens app → sees empty canvas + chat panel    │
│                                                     │
│  1. User types: "Draft a blog post about Rust"      │
│  2. LLM streams content into the canvas             │
│  3. User selects a paragraph, types: "Make shorter" │
│  4. LLM rewrites selection; diff highlights appear  │
│  5. User accepts or rejects the change              │
│  6. User exports final document as Markdown          │
└─────────────────────────────────────────────────────┘
```

### 2.2 Quick Actions Flow

`Select text → Context toolbar appears:`
```
  [ Rewrite ] [ Expand ] [ Shorten ] [ Fix Grammar ] [ Translate ▾ ]
```
`Click "Shorten" → LLM processes → Diff shown inline → Accept / Reject`

### 2.3 Version History Flow

```
Click "History" → Side panel shows timeline of snapshots:
  • v3  "Shortened introduction"         2 min ago
  • v2  "Added conclusion paragraph"     5 min ago
  • v1  "Initial draft"                 10 min ago

Click any version → Canvas shows that snapshot (read-only)
Click "Restore" → Document reverts to that version
```

---

## 3. Architecture

### 3.1 High-Level Component Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                        Web Canvas App                        │
│                                                              │
│  ┌──────────────┐   ┌───────────────────────────────────┐    │
│  │              │   │           Canvas Panel             │    │
│  │  Chat Panel  │   │  ┌─────────────────────────────┐  │    │
│  │              │   │  │   Rich Text Editor           │  │    │
│  │  ┌────────┐  │   │  │   (TipTap / ProseMirror)    │  │    │
│  │  │Messages│  │   │  │                             │  │    │
│  │  │  List  │  │   │  │   • Markdown serialization  │  │    │
│  │  │        │  │   │  │   • Diff highlighting       │  │    │
│  │  └────────┘  │   │  │   • Selection tracking      │  │    │
│  │              │   │  └─────────────────────────────┘  │    │
│  │  ┌────────┐  │   │                                   │    │
│  │  │ Input  │  │   │  ┌─────────────────────────────┐  │    │
│  │  │  Box   │  │   │  │   Quick Action Toolbar      │  │    │
│  │  └────────┘  │   │  └─────────────────────────────┘  │    │
│  └──────────────┘   └───────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │                    Core Services                       │  │
│  │  ┌──────────┐  ┌──────────┐  ┌───────────────────┐    │  │
│  │  │ LLM      │  │ Document │  │ Version / History │    │  │
│  │  │ Provider │  │ Store    │  │ Manager           │    │  │
│  │  │ Layer    │  │          │  │                   │    │  │
│  │  └──────────┘  └──────────┘  └───────────────────┘    │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Module Breakdown

#### 3.2.1 Chat Panel
| Responsibility | Details |
|---------------|---------|
| Message display | Render user and assistant messages with Markdown support |
| Input handling | Multi-line text input with submit on Enter (Shift+Enter for newline) |
| Context awareness | Automatically includes current document state and selection in prompts |
| Streaming display | Show assistant response tokens as they arrive |

#### 3.2.2 Canvas Panel
| Responsibility | Details |
|---------------|---------|
| Rich text editing | WYSIWYG editing with Markdown shortcuts |
| Selection tracking | Track user's current selection for context-aware LLM actions |
| Diff rendering | Show LLM-proposed changes as inline additions (green) / deletions (red) |
| Accept/Reject UI | Per-change and bulk accept/reject controls |
| Quick actions | Contextual toolbar on text selection |

#### 3.2.3 LLM Provider Layer
| Responsibility | Details |
|---------------|---------|
| Provider abstraction | Uniform interface: `stream(messages, config) → AsyncIterable<string>` |
| Supported providers | OpenAI, Google Gemini, Anthropic Claude, Ollama (local) |
| Prompt construction | Build system prompt + document context + user instruction |
| Error handling | Graceful handling of rate limits, network errors, malformed responses |
| Streaming | Server-Sent Events / fetch streaming for real-time token delivery |

##### Model Discovery & Resolution Policy
When integrating new LLM providers, developers **must** prioritize retrieving models dynamically from the provider's official model discovery endpoint (e.g. `/v1/models`) upon boot or credential updates.
- A static list of fallback models (`FALLBACK_<PROVIDER>_MODELS`) must be maintained in the codebase.
- The app will automatically attempt a dynamic fetch if credentials are present, falling back to the static list if the request fails or credentials are unset.
- Retrieved models must be synchronized to the global store so that both app headers and configurations settings modals render them dynamically.

#### 3.2.4 Document Store
| Responsibility | Details |
|---------------|---------|
| State management | Single source of truth for current document content |
| Persistence | Auto-save to `localStorage`; export to file |
| Serialization | Convert between editor model ↔ Markdown ↔ plain text |
| Multi-document | Collapsible vertical Chapters sidebar for multi-chapter writing (see [Feature Specification](file:///home/hongdp/Workspace/web_canvas/docs/features/multi_document_references.md)) |

#### 3.2.5 Version / History Manager
| Responsibility | Details |
|---------------|---------|
| Snapshots | Create a named snapshot before each LLM edit |
| Undo/Redo | Standard undo/redo stack for manual edits; version restore for LLM edits |
| Timeline UI | Scrollable list of versions with labels and timestamps |
| Diff between versions | Show what changed between any two snapshots |

#### 3.2.6 Storage & Standalone Backend Manager
| Responsibility | Details |
|---------------|---------|
| Server-First Persistence | All book, document, and session data is persisted in the Python FastAPI backend. Server acts as the single source of truth. |
| Write-Through Cache | Uses client browser `localStorage` as a write-through cache to avoid data loss on crashes. |
| Debounced Auto-Save | Store mutations are batched and saved to the backend via a 3-second debounce. |
| Transactional Safety | Prevents loopback requests during fetches by cancelling pending save timeouts and disabling store subscription listeners during load transactions. |

#### 3.2.7 AI Image Generation Service
| Responsibility | Details |
|---------------|---------|
| Multi-Provider Support | Interfaces with OpenAI DALL-E, Google Gemini Imagen, Stability AI, and Grok Image (xAI). |
| Prompt Enhancement | Enhances short prompts into highly descriptive, detailed prompts via the active Chat LLM. |
| Model Discovery | Performs dynamic discovery of available image-generation models via `/v1/models` endpoints. |
| Editor Integration | Automatically inserts the generated base64 image asset inline into the active document context. |

#### 3.2.8 Local Webpage HTML Analysis & Generation
| Responsibility | Details |
|---------------|---------|
| Web Scraping | Scrapes title, paragraphs, and images in document order locally or via the FastAPI `/api/import-url` endpoint. |
| Outline Planning (Phase 1) | Automatically splits imported book contents into structured chapter outline schemas. |
| Narrative Generation (Phase 2) | Feeds sequential chapter ranges and references to LLM to write cohesive stories, maintaining narrative continuity. |
| Safety Mitigation | Automatically censors explicit keywords using a local `sensitive_words.json` and strips images to bypass safety filters, falling back to a self-healing retry pipeline with an interactive manual prompt editor on block. |

#### 3.2.9 Progressive Web Application (PWA) Support
| Responsibility | Details |
|---------------|---------|
| Standalone App Shell | Service worker (`sw.js`) utilizes stale-while-revalidate and cache-first strategies to speed up page loading and prevent page state reloads when backgrounded. |
| Manifest Config | Provides PWA properties for "Add to Home Screen" support on desktop/mobile and configures notch-friendly status bar orientations. |
| Secure Local Access | Serves local HTTPS with a self-signed cert whose SAN lists the LAN/Tailscale IPs (as `IP Address` entries), enabling service-worker registration and avoiding Firefox's "NetworkError" on same-origin fetch. |

---

## 4. Data Model

### 4.1 Document

```
Document {
  id:         string (UUID)
  title:      string
  content:    EditorJSON          // ProseMirror/TipTap JSON
  markdown:   string              // Serialized markdown (derived)
  createdAt:  ISO8601
  updatedAt:  ISO8601
  versions:   Version[]
}
```

### 4.2 Version

```
Version {
  id:         string (UUID)
  documentId: string
  label:      string              // e.g., "Shortened introduction"
  content:    EditorJSON
  createdAt:  ISO8601
}
```

### 4.3 Chat Message

```
ChatMessage {
  id:         string (UUID)
  role:       "user" | "assistant"
  content:    string
  images?:    string[]            // base64 Data URLs (multimodal uploads/pastes/inline elements)
  timestamp:  ISO8601
  provider?:  string              // e.g., "gemini"
  model?:     string              // e.g., "gemini-1.5-flash"
}
```

### 4.4 Provider Config

```
ProviderConfig {
  provider:   "openai" | "gemini" | "anthropic" | "ollama" | "grok"
  apiKey:     string              // stored in localStorage
  model:      string              // e.g., "gpt-4o", "gemini-2.5-pro"
  baseUrl?:   string              // for custom endpoints
  maxOutputTokens?: number        // configurable response output limit
  geminiSafetySettings?: GeminiSafetySetting[] // category thresholds
}
```

### 4.5 Image Generation Config

```
ImageGenConfig {
  provider:               "openai" | "gemini" | "stabilityai" | "grok"
  apiKey:                 string
  model?:                 string
  baseUrl?:               string
  styleSystemPrompt?:     string
  llmEnhancementEnabled?: boolean
}
```

---

## 5. Prompt Strategy

### 5.1 System Prompt Template

```
You are a document editing assistant. The user is working on a document
and will give you instructions to modify it.

RULES:
- Return ONLY the modified text. Do not add explanations or commentary.
- Preserve the original formatting (Markdown) unless asked to change it.
- If the user selected specific text, modify ONLY that selection.
- Match the tone and style of the surrounding document.

DOCUMENT:
{full_document_markdown}

SELECTED TEXT (if any):
{selected_text}
```

### 5.2 Context Windowing Strategy

For documents exceeding the model's context window:

1. **Small docs (< 8K tokens)**: Send the full document.
2. **Medium docs (8K–32K tokens)**: Send full document if model supports it;
   otherwise send selection ± 2000 words of surrounding context.
3. **Large docs (> 32K tokens)**: Always send selection ± 2000 words, plus
   document outline (headings) for structural context.

---

## 6. UI / UX Design

### 6.1 Desktop Layout

```
┌──────────────────────────────────────┐
│  ▪ Web Canvas            [Settings] [History] [Export]│
├──────────────┬───────────────────────┤
│              │                       │
│   Chat       │          Document Canvas             │
│   Panel      │                       │
│   (30%)      │          (70%)        │
│              │                       │
│              │                       │
│              │                       │
│              │                       │
│  ┌────────┐  │                       │
│  │  💬    │  │                       │
│  └────────┘  │                       │
├──────────────┴───────────────────────┤
│  Status bar: Provider: GPT-4o  │  Words: 1,234     │
└──────────────────────────────────────┘
```

### 6.2 Mobile & Responsive Layouts

Web Canvas dynamically adapts to different screen sizes and orientations through a custom 4-state layout engine (`desktop` | `portrait` | `landscape` | `tablet-square`).

#### 6.2.1 Mobile Portrait Layout

In Portrait orientation, the UI is stacked vertically. The Rich Text Editor occupies the top half, while the Assistant Chat resides in a collapsible bottom drawer/toolbar:

**A) Collapsed State (Default writing focus):**
```
┌──────────────────────────────────────┐
│  [Logo]                 [Settings] ☼ │  ← App Header (56px)
├──────────────────────────────────────┤
│                                      │
│  Chapter Title Input                 │
│                                      │
│  The quick brown fox jumps over the  │  ← Editor Viewport (flex-grow)
│  lazy dog. |                         │
│                                      │
├──────────────────────────────────────┤
│  [💬] [Write instructions...]    [➔] │  ← Collapsed Chat Toolbar (72px)
└──────────────────────────────────────┘
   └─ Toggle Drawer Button (MessageSquare icon)
```

**B) Expanded State (Conversational reviews):**
```
┌──────────────────────────────────────┐
│  [Logo]                 [Settings] ☼ │
├──────────────────────────────────────┤
│  Chapter Title Input                 │  ← Editor Viewport (top 50% height)
│  The quick brown fox jumps over...   │
├──────────────────────────────────────┤
│  Assistant Chat (Gemini)         [X] │  ← Drawer Header
│  ┌────────────────────────────────┐  │
│  │ User: Make this paragraph flow │  │
│  │ Assistant: Streamed response...│  │  ← Messages List (overflow-y)
│  └────────────────────────────────┘  │
│  [▼] [Write instructions...]    [➔] │  ← Input Wrapper
└──────────────────────────────────────┘
   └─ Collapse Drawer Button (ChevronDown icon)
```

#### 6.2.2 Mobile Landscape & Tablet/Square Layout

In Landscape (wide and short) and Tablet/Square (iPad / Foldables) aspect ratios, the UI splits side-by-side. Sidebars slide over the canvas as overlay drawers rather than squeezing the panels:

```
┌──────────────────────────────────────┐
│  [Logo]                 [Settings] ☼ │  ← Compact Header (44px)
├───────────────────┬──────────────────┤
│ Assistant Chat    │ Document Editor  │
│                   │                  │
│ • Message History │ • Editor View    │  ← Side-by-side Split View
│                   │ • Text selection │
│                   │   quick menu     │
│ [Write...]    [➔] │                  │
└───────────────────┴──────────────────┘
```

### 6.3 Visual Design Direction

- **Color palette**: Dark mode default with warm accent colors (amber/gold
  for actions, soft greens/reds for diffs).
- **Typography**: `Inter` for UI chrome, `Merriweather` or system serif for
  document body (configurable).
- **Glass effects**: Frosted glass on the chat panel overlay (when floating).
- **Animations**: Smooth panel resize, fade-in for streamed text, subtle
  pulse on the "thinking" indicator.

### 6.4 Interaction Patterns

| Action | Trigger | Result |
|--------|---------|--------|
| New instruction | Type in chat + Enter | LLM edits document; diff shown |
| Quick action | Select text → click toolbar button | LLM applies action to selection |
| Accept change | Click ✓ on diff | Change committed to document |
| Reject change | Click ✗ on diff | Change discarded; original restored |
| Accept all | Click "Accept All" button | All pending diffs committed |
| Undo | Ctrl+Z | Standard undo |
| Restore version | Click version in history panel | Document reverts |
| Export | Click Export → choose format | File downloaded |

### 6.5 AI Image Generation Dialog Flow

1. **Trigger**: User opens the "AI Image Generation" modal (or selects text and selects "Generate Image").
2. **LLM Prompt Enhancement (Step 2)**:
   - Takes raw prompt + document selection context.
   - User clicks "Enhance Prompt" -> streams vivid expansion from the active chat LLM (using image enhancement system prompt rules) into the editable textarea.
   - User can review/tweak the enhanced prompt or click "Use raw" to discard it.
3. **Image Options (Step 3)**:
   - Choose Aspect Ratio (1:1, 16:9, 9:16, 4:3, 3:4).
   - Select Image Provider (OpenAI DALL-E, Google Imagen, Stability AI, Grok Image).
   - Advanced settings: manual API key input, custom Base URL override, OpenAI style category (vivid/natural), and negative prompts.
4. **Generation & Review**:
   - User clicks "Generate Image" -> spinner shows "Generating image...".
   - The generated image is returned as a base64 string, rendered in the right panel with interactive Zoom (scale) sliders and aspect preservation.
   - User clicks "Insert into Editor" to insert the image tag inline inside the active editor document at the cursor position.

### 6.6 Webpage Scraping, Outline Planning, & Chapter Generation Flow

1. **Scraping Phase**:
   - User inputs a URL or uploads a local HTML file inside `ImportUrlModal`.
   - The utility parses the DOM, filters out scripting/forum garbage, and returns a structured list of textual paragraphs and image elements in original document order.
   - Images are fetched/downloaded on the server (FastAPI `/api/import-url`) or locally, and converted to base64 strings under a 5MB size limit.
2. **Phase 1: Outline Planning**:
   - The scraped content is interleaved and sent to the LLM.
   - The LLM creates a structured JSON containing a consolidated Book Title, summary, and a list of chapters (including title, description, original paragraph range, and image indices).
3. **Phase 2: Narrative Generation**:
   - The system iterates over the planned chapters sequentially.
   - For each chapter, the system constructs a prompt containing the writing rules, active chapter plan, current original paragraphs/images, and the *previous chapter's ending text* to ensure narratively continuous transitions.
   - Content generates inline and places image tags (`{{IMG-N}}`) at matching positions.
4. **Self-Healing Safety Fallback**:
   - If the generation fails due to a safety/CSAM block (HTTP 403 / guidelines violation), the application automatically retries.
   - It performs local censorship of explicit keywords using a git-ignored/dynamic list `sensitive_words.json`, strips/simplifies image alt texts, and opens a **Safety Retry Prompt Editor** UI so the user can manually correct the prompt or save the generated chapters to the workspace and exit.

---

## 7. Technology Choices

> These are recommendations and current choices.

| Concern | Recommendation | Alternatives |
|---------|---------------|-------------|
| Framework | **Vite + React** | Next.js (if SSR needed later) |
| Language | **TypeScript** | — |
| Rich text editor | **TipTap** (ProseMirror-based) | Lexical, Slate |
| Styling | **Vanilla CSS** (CSS variables + modules) | Tailwind (if requested) |
| State management | **Zustand** | Jotai, Redux Toolkit |
| LLM streaming | **Fetch API + ReadableStream** | Vercel AI SDK |
| Persistence | **IndexedDB** (heavy documents/versions) + **localStorage** (configs/preferences) | Server storage API (FastAPI backend) |
| Testing | **Vitest + Playwright** | Jest, Cypress |
| Local HTTPS | **Self-signed cert with IP SAN** (`certs/`, OpenSSL) | @vitejs/plugin-basic-ssl (dropped — no IP SAN) |
| Deployment | **Vercel / Netlify** (static) | Python self-hosted server |

---

## 8. Milestone Plan

### M1 — Skeleton (Week 1)
- [x] Project scaffolding (Vite + React + TypeScript)
- [x] Basic layout: chat panel + canvas panel (resizable split)
- [x] TipTap editor integration with Markdown support
- [x] Dark/light theme with CSS variables

### M2 — LLM Integration (Week 2)
- [x] Provider abstraction layer
- [x] OpenAI provider implementation (streaming)
- [x] Chat message flow: user input → LLM → streamed response in chat
- [x] Document editing: LLM output replaces / appends to canvas content

### M3 — Inline Editing (Week 3)
- [x] Selection-aware prompting (send selected text as context)
- [x] Diff rendering in the editor (additions/deletions)
- [x] Accept / reject per-change
- [x] Quick action toolbar on text selection

### M4 — Polish & History (Week 4)
- [x] Version history manager (snapshots, restore)
- [x] Auto-save to localStorage
- [x] Export to Markdown / plain text / HTML
- [x] Settings panel (provider config, model selection, theme)
- [x] Responsive layout for tablet/mobile
- [x] Import from file (HTML, Markdown, Plain Text with auto-splitting)

### M5 — Multi-Provider & Beyond (Week 5+)
- [x] Gemini provider
- [x] Anthropic provider
- [x] Ollama provider
- [x] OpenAI provider

### M6 — Chat agent optimization
- [x] Add capability to revert and edit the past chat user input. 
- [x] Improve output token efficiency when using selected edit to allow LLM to decide only output modification to the selected text, not whole document. 

### M7 — Cross Device optimization.
- [x] When the UI get started, allow a start up flag to set a local server directory to store the local storage data. This allows cross session materialization.
- [x] Create two version of the configs, use the local one that contains the actual config related to the local enviorment, but commit only the version that shown as example to others that need to use this repo.
- [x] Come up with a design of Mobile UI, adapting to portrait, landscape and square aspect ratio.
- [x] Implement the mobile friendly UI while keeping all the functionality of the desktop web version.
- [x] Implement user registration and login with secure HttpOnly session cookies, CSRF protection, and user-isolated server-side document storage paths.
- [x] Optimize portrait layout headers by moving provider model and system prompt selections to the Settings Modal, keeping the mobile header compact.
- [x] Ensure the user interface is strictly constrained to the screen size (horizontal and vertical viewport boundaries) on all devices and orientations.

### M8 — PWA, HTML Scraping, & AI Image Generation
- [x] Build and register Progressive Web Application (PWA) manifest and caching service worker (`sw.js`).
- [x] Serve secure local HTTPS via a self-signed cert with IP SAN entries (`certs/`) for PWA testing and cross-browser LAN access (fixes Firefox same-origin fetch).
- [x] Create cross-provider Image Generation service supporting OpenAI DALL-E, Google Imagen, Stability AI, and Grok Image.
- [x] Design and implement an interactive Image Generation Modal with LLM-powered prompt enhancement, aspect ratio, negative prompts, and dynamic model discovery.
- [x] Implement client-side and backend-assisted webpage HTML scrapers to parse paragraphs and images in document order.
- [x] Develop a two-phase novel import pipeline: Chapter Planning (JSON outlines) and Narrative Generation (with previous-chapter continuity linking).
- [x] Build a local keyword-censoring safety fallback pipeline and interactive Safety Retry Prompt Editor UI to handle 403/guideline blocking issues.
- [x] Migrate heavy workspace models (documents and versions) containing Base64 image payloads from `localStorage` to `IndexedDB` to bypass 5MB quotas.


---

## 9. Open Questions

1. **Editor choice**: TipTap is recommended for its ProseMirror foundation and
   extensibility. Should we evaluate Lexical as well, or commit to TipTap?

2. **Diff granularity**: Should diffs be word-level (more precise, harder to
   implement) or block-level (paragraph/sentence)?

3. **Multi-document**: Should v1 support tabs for multiple documents, or keep
   it single-document for simplicity?

4. **Monetization / hosting**: Is this intended to be a personal tool, an
   open-source project, or a hosted product? This affects auth and deployment
   decisions.

---

## 10. References

- [OpenAI Canvas](https://openai.com/index/introducing-canvas/) — Primary
  inspiration for the editing UX.
- [TipTap Editor](https://tiptap.dev/) — Rich text editor framework.
- [ProseMirror](https://prosemirror.net/) — Underlying editing engine.
- [Zustand](https://zustand-demo.pmnd.rs/) — Lightweight state management.

---

## 11. Decision Log

Record significant design decisions here as the project evolves.

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-05-25 | Project kick-off | Initial principles established |
| 2026-05-25 | Created separate feature spec for multi-document references | Registered separate document [multi_document_references.md](file:///home/hongdp/Workspace/web_canvas/docs/features/multi_document_references.md) to detail chapter outline and context loading. |
| 2026-05-25 | Custom System Prompt & Cookie Settings Migration | Added systemPrompt field and UI inputs to allow user-defined instructions, and migrated user preferences/configurations to client-side __Secure- cookies. |
| 2026-05-25 | Multiple System Prompts & Selector Manager | Added global SystemPromptTemplate presets, header selector dropdown, settings modal preset editor card manager, and upgraded providers configuration cookie schema to version 2 with automated backward-compatible migrations. |
| 2026-05-25 | Dismissible UI API Error Alerts | Upgraded dynamic model fetch effect to catch and report connection/auth errors to local state, added dismiss button (X) to main error banner, and integrated a dismissible alert inside the Settings Modal to warn users about key/network issues. |
| 2026-05-25 | LLM Debug Mode & Credential Masking | Implemented a developer toggle in Settings to console-log raw LLM API requests and responses, with robust credential masking filters matching secure coding principles. Supports enabling via `npm run dev:debug` CLI script or VITE_DEBUG=true environment variable. |
| 2026-05-25 | Gemini Safety Settings Configuration | Added safety block threshold selectors in the Settings Modal for Harassment, Hate Speech, Sexually Explicit, and Dangerous Content categories, passing them dynamically to Gemini's stream request. |
| 2026-05-25 | Configurable Max Output Tokens | Added `maxOutputTokens` field to ProviderConfigs, defaulting to 16,384 tokens to avoid premature text truncation, with UI controls in the Settings Modal allowing settings up to 65,536 tokens. |
| 2026-05-25 | Prioritize LocalStorage Settings with Cookie Fallback | Migrated settings (theme, provider configs, custom prompts, active provider/prompt, debug mode) to prioritize LocalStorage storage. Retained cookies as synchronized fallbacks. Optimized prompts cookie space by saving only custom/modified presets. |
| 2026-05-25 | Inline Editing & Diff Review System (Milestone 3) | Implemented selection-aware prompts, token-based HTML diffing, TipTap mark extensions (ins/del), floating bubble menu actions, and bulk accept/reject review banners. |
| 2026-05-25 | Token Caching & Session Usage Stats Tracking | Implemented session token counters (input, output, cache hit, cache miss) with extraction handlers parsing usage metadata for Gemini, OpenAI, and Anthropic response streams. |
| 2026-05-25 | Dynamic API Switching & Grok Integration | Added xAI Grok as a supported LLM provider. Built a horizontal tabs settings card inside the Settings Modal to configure individual providers, and added header dropdown controls to seamlessly toggle active providers and models in real-time. |
| 2026-05-25 | Multi-Chapter Document Imports & Splitter | Added client-side text/markdown/HTML file importers, with structural splitting on headers/hr delimiters to let users import whole drafts and segment them automatically into chapters. |
| 2026-05-25 | Duplicate H1 Prevention & Live Title Sync | Configured prompt instructions to allow exactly one leading H1 per chapter, syncing editor H1 edits directly to sidebar titles, and parsing imported H1 tags as metadata. |
| 2026-05-25 | Book Title Persistence & Export Naming | Added a persisted book title setting. Export filenames are sanitized (replacing spaces/special characters with underscores), using `BookTitle_ChapterTitle` for single chapters and `BookTitle` for combined drafts. |
| 2026-05-25 | Live Save Status Indicator | Added a toolbar button showing save status: a rotating `RefreshCw` icon for unsaved edits (debounced for 1.5 seconds) and an emerald green `Save` disk icon once saved. Clicking the button forces saving immediately. |
| 2026-05-25 | Fixed Formatting Toolbar & Clean Bubble Menu | Added a sticky translucent formatting toolbar at the top of the editor for formatting tags, leaving the text-selection BubbleMenu dedicated purely to AI generation actions and diff resolutions. |
| 2026-05-25 | Book Title UI Design Alignment | Redesigned the Book Title sidebar input to match the Document Title UI styling, utilizing a borderless transparent style, `Book` icon, and hover/focus transitions for visual cohesion. |
| 2026-05-25 | Revert & Edit Past Chat & Selection Replacement (Milestone 6) | Implemented capability to edit and resubmit past user prompts, truncating history from that point. Upgraded the streaming engine to parse and splice selection-replace token optimization blocks directly into the active editor range, computing and applying HTML diffs on completion. |
| 2026-05-26 | Cross-Device Optimization & Collapsible Chat Drawer (Milestone 7) | Implemented local storage server-side serialization with `--storage-dir` CLI flag support. Refactored layout architecture into a 4-state dynamic layout engine (`desktop` | `portrait` | `landscape` | `tablet-square`). Configured mobile landscape/tablet layouts as side-by-side splits with collapsible sidebars and overlay drawers. Designed and implemented mobile portrait layout as a vertical stack: Editor in main viewport and a collapsible/expandable Chat drawer toolbar at the bottom that automatically slides up on generation and keeps selection editing fully functional. |
| 2026-05-26 | Transactional Storage Synchronization Safety | Ensured that pulling server data to sync to local only occurs on post-login selection or manual pull trigger. Added execution safety to prevent concurrent modifications by canceling pending `saveTimeout` debounced writes and pausing auto-save state listeners during pulls. |
| 2026-05-26 | Dynamic Model Discovery Policy & Grok Dynamic Fetching | Added availableGrokModels state to the store and integrated dynamic model fetching for Grok (/v1/models) in both the header and Settings Modal. Established developer guidelines to prioritize model-discovery APIs and fallback to static lists for all future provider integrations. |
| 2026-05-26 | Standalone Python Backend Server & Server-First Storage | Split Vite frontend and Python FastAPI backend (running on port 3000, proxied by Vite). Redesigned storage to be server-first, using localStorage strictly as a write-through cache. Removed obsolete sync toggle checks, conflict resolution modals, and offline storageMode options. |
| 2026-05-28 | Sensitive Words Separation & Safety Retry Prompt Editor | Extracted sensitive words to a git-ignored JSON config file, loaded dynamically at runtime. Implemented automated safety self-healing retry pipeline on 403 Safety/CSAM blocks, alongside an interactive Prompt Editor UI allowing manual prompt correction or saving progress on failure. |
| 2026-05-28 | Hybrid Persistent Storage Model (IndexedDB Migration) | Migrated heavy workspace collections (documents and versions) containing Base64 image payloads from localStorage to browser-native IndexedDB to bypass the 5MB browser quota limitation. Lightweight configurations remain synchronous in localStorage. Created automatic migration logic on start-up. |
| 2026-05-28 | Editor Custom Image Node Extension Setup | Created and registered a CustomImage Node extension in Editor.tsx to support rendering and preserving inline <img> tags (including Base64 encoded image assets) without external dependencies. |
| 2026-05-28 | Base64 Image Placeholder Extraction & Restoration | Implemented an extraction and restoration pipeline in App.tsx that substitutes large inline base64 image tags with lightweight placeholders (`{{IMAGE_PLACEHOLDER_N}}`) before prompt construction to avoid LLM context bloat and token corruption, restoring the original tags dynamically during token stream updates and diff calculations. |
| 2026-05-28 | Image Size Pre-filtering Validation | Updated processFiles in App.tsx to pre-filter and reject image uploads exceeding the 2MB size limit before checking the maximum allowed attachment count (3 images), preventing invalid files from blocking valid uploads. |
| 2026-05-28 | Client-Side GIF Image Processing (First-Frame JPEGs) | Implemented convertGifToJpegIfNeeded inside App.tsx using HTML5 Canvas to dynamically flatten animated GIFs to their first frame. Elevated file size checks for image/gif uploads up to 15MB, while converting them to static JPEGs and enforcing a 2MB post-conversion size limit to ensure compatibility and lightweight storage. Added paste/drop handler support in chat inputs to convert inline GIFs automatically. |
| 2026-05-28 | Local Webpage HTML Analysis & Generation | Added client-side HTML DOM parser utilities and drop-zone file selection component inside ImportUrlModal.tsx to scrape webpage text paragraphs and order-mapped images locally, resolving relative URLs against the base tag and cleaning forum noise. Feeds directly into the outline planning and chapter generation pipeline. |
| 2026-07-07 | Cache-Friendly Prompt Layout & Context Windowing | Restructured chat/roleplay prompt assembly to `[stable system prompt] + [windowed history] + [volatile document/game-state context merged into the final user message]` so provider prompt-cache prefixes (OpenAI/Gemini implicit, Anthropic `cache_control` via a new `LLMMessage.cacheHint`) survive across turns and the document sits adjacent to the request for accurate `<edit>` SEARCH copying. Added `src/utils/llmContext.ts` (tested): history trimmed to a char budget, base64 images stripped from all but the most recent messages, `[Attached Context: …]` display artifacts stripped from history, reference documents truncated per-doc with an explicit notice. Wired the user-selected System Prompt preset (previously ignored by chat) into the chat system prompt; world lore moved into the roleplay system prompt with game state merged into the final action message. Removed the Anthropic 8192 `max_tokens` clamp and refreshed default Anthropic model IDs. |
| 2026-07-12 | Smart Context Selection & Agentic Chapter Lookup (design) | Registered [smart_context_selection.md](file:///home/hongdp/Workspace/web_canvas/docs/features/smart_context_selection.md): a layered chapter-context system — always-on chapter index (title + LLM-generated summary, stored on `CanvasDocument` behind a versioned migration), deterministic auto-selection with pin/block manual adjustment replacing the send-and-clear reference tags, an agentic `<lookup>` markup tag letting the model request full chapter text mid-turn (bounded retry loop), and a whole-book escalation ladder (free heading digest → attach-all → confirmed map-reduce). Chose a text-protocol tag over native tool-calling because `services/llm.ts` shares one streaming path across 5 providers and the Canvas Markup Protocol already establishes the pattern. |
| 2026-08-15 | Server-side resumable generation | Registered [resumable_generation.md](file:///home/hongdp/Workspace/web_canvas/docs/features/resumable_generation.md). LLM streaming moved from the browser tab into the FastAPI backend: `POST /api/generate` starts a buffered job, `GET /api/generate/{id}/stream?from=<charOffset>` replays then streams live, plus `abort` and `active`. Motivation: mobile Firefox discards a backgrounded tab (measured: JS context destroyed, navType 'reload'), which killed any in-flight generation — no client-side trick survives that, so the work had to outlive the tab. The client keeps `streamLLM`'s signature and picks a transport (remote when logged in, direct otherwise; only a failed START falls back, never a running job). Per-event character offsets make reconnects lossless; jobs are per-user, retained 10 min, capped at 20/user and 4M chars. Provider parity with services/llm.ts was ported deliberately, including the Anthropic total-input/cumulative-output usage fixes and Gemini safety-block detection. Known gaps in spec §8 (roleplay cannot rejoin; a server restart drops in-flight jobs). |
| 2026-08-15 | Mobile editing performance: selection storm, incremental persistence, image re-decode | Investigated a mobile-Firefox freeze/crash when deleting a large selection. Fixes, each with an inline Problem/Root Cause/Fix note: (1) `Editor.onSelectionUpdate` serialized the selected slice to HTML and wrote it to the store on EVERY drag tick — now a 200ms trailing debounce publishes the settled selection once; (2) `ChaptersSidebar` re-hashed every chapter's content twice per row per render (`isSummaryStale` inline in JSX) and `CanvasFooter` recounted words per render — both memoized on the documents/text identity; (3) IndexedDB stored the whole documents array as one value (structured-cloning the entire book per save) — v3 layout writes one record per document with a reference diff, legacy payloads migrate on load (pure diff + tests); (4) `syncToServer` PUT every loaded chapter on each save — now skips chapters whose synced fields are reference-identical to the last successful PUT; (5) `App.handleEditorChangeFor` re-parsed the ENTIRE document HTML (`tempDiv.innerHTML`) on every update just to read a leading `<h1>`, materializing every embedded `<img>` (an imported chapter holds 200 base64 images ≈ 440MB of decoded surfaces) — replaced with a bounded regex; `Editor` now serializes selections into an inert document so selected images are never decoded. Method note: a minimal static repro (800-block contenteditable; with/without content-visibility; with/without a backdrop-filter bubble menu; and the user's real `<br>`-heavy chapter, also ×20) reproduced NOTHING, which ruled out Gecko-generic, CSS and content-structure causes; USB debugging (adb + geckordp remote JS) supplied the decisive data — two ANR records with 3–4GB RSS shmem, and post-fix DOM/frame-gap probes on-device showing a clean delete (52ms max frame gap, 0 bulk DOM replacements). |
| 2026-07-31 | Large-file decomposition (structure-only refactor) | Split every oversized file into focused modules with zero behavior change, verified per area: `useAppStore.ts` 2197→146 (slice creators under `store/slices/` + defaults/settingsPersistence/serverSync/syncRuntime, public API re-exported so all import sites stayed unchanged; 92/92 AppState keys verified); `useChatLLM.ts` 1193→920 (`hooks/chat/`: wholeBook, streamHandlers, dynamicContext — the ref-coupled streaming core deliberately kept intact); `App.tsx` 1006→522 (AppHeader/CanvasHeader/CanvasFooter/VersionHistorySidebar with verbatim DOM); `ImportUrlModal` 1734→1072 and `ImageGenerationModal` 1051→399 (pure logic to `services/import/*` + `services/imageGenModels.ts` with new parser tests, steps to `components/import|imageGen/`); `index.css` 2173→ordered `@import` entry over `src/styles/*` (byte-identical built CSS verified); `api_server.py` 1905→1011 (server_config/db/content/auth/scrape/migration sibling modules; pytest patches target owning modules; identical 22-route set verified). Executed as five parallel subagents over disjoint file sets, committed per area for bisectability. |
| 2026-07-12 | Smart Context Selection implemented (Phases 1–4) | Shipped the layered context system: documents moved into a versioned IndexedDB envelope (v2: legacy `selectedReferenceIds` → sticky `pinnedReferenceIds` + `blockedReferenceIds`, with migration tests); lazy background chapter summarizer (`services/chapterSummaries.ts`: edit-idle 60s / chapter-switch / send-time triggers, serial queue, silent failure, summaries carried over server-metadata rebuilds); Layer 0 CHAPTER INDEX in the dynamic context; pure scorer `utils/contextSelection.ts` (title/history mentions, adjacency, CJK-aware keyword overlap, continuity; pinned ∞ / blocked −∞; 60k-char budget with lowest-score eviction) driving a four-state tag bar (auto ✨ dashed / pinned / neutral / blocked) with live debounced preview and budget chip; agentic `<lookup>` loop in `useChatLLM` (max 2 rounds × 3 chapters, transient rounds never persisted, prefix messages reused for cache hits, Settings toggle); whole-book "All chapters" one-shot super-tag with model-aware budgets (`WHOLE_BOOK_CONTEXT_CHARS`), Rung 1 attach-all (>200k-char confirm), Rung 2 batched map-reduce with running notes and cost consent, fast-mode fallback to a heading-tree + summary digest. v1 deviations documented in spec §11 (summaries local-first, chat model as summarizer, window.confirm consent, no sticky cache placement). |
| 2026-07-07 | LLM History Hygiene & Context Plain-Texting | Extended `src/utils/llmContext.ts` (tested): `stripChatDisplayArtifacts` now also removes trailing UI-appended `⚠️` notes (canvas truncated/elided, unmatched edits, stream errors) so the model never sees app-to-user status text as its own words; `trimHistoryForContext` drops empty messages and merges consecutive same-role turns (Anthropic rejects empty text blocks / benefits from clean alternation). Added `htmlToPlainText` (block boundaries → newlines, list bullets, entity decoding) for reference docs, roleplay lore, and game state — replacing naive tag-stripping that fused headings into run-on text. Roleplay world lore is now capped at 30k chars with a truncation notice. Extracted duplicated reference-doc auto-detection into `detectReferencedDocIds` (min-title-length guard so one-letter titles can't attach to every prompt) and `buildAttachmentsLabel`, shared by send and resubmit paths. |
| 2026-07-12 | Image Preservation Across Full Rewrites (3-layer fix) | Images were lost during `<canvas>` full rewrites: `<img>` tags are swapped for `{{IMAGE_PLACEHOLDER_N}}` tokens before sending, but the system prompt never mentioned the tokens and restoration was exact-string-only, so a dropped/reformatted token silently deleted the image. Fix: (1) system prompt rule 11 instructs the model to copy image tokens verbatim; (2) restoration (extracted to tested `src/utils/imagePreservation.ts`) tolerates brace/spacing/case/separator drift, unknown-index tokens, and the model wrapping a token in its own `<img>` tag; (3) safety net `reinsertMissingImages` runs after every valid canvas replacement — any original image (by `src`) absent from the rewrite is re-inserted after its surviving anchor paragraph (tail-text match), else at its proportional block position, and an ℹ️ chat note reports the restoration so intentional removals can still be done manually. Applies to the canvas path only; `<edit>`-based removals stay targeted and intentional. |







| 2026-07-16 | Manual Context Pins Fixed for Lazy-Loaded Chapters | Pinning an unopened chapter in a server-synced book was a silent no-op: server books load chapter metadata only (`contentLoaded: false`, content fetched on chapter open), and `selectReferenceChapters`'s `attachable()` guard drops empty docs — so pinned-but-unopened chapters never attached (UI showed 📌, request carried nothing). Whole-book mode and the Layer 2 `<lookup>` loop had the same hole, so nothing ever fulfilled the scorer's documented "Layer 2 can fetch them later" degrade path. Fix: new store action `ensureDocumentContents(ids)` backed by `src/store/contentLoader.ts` (tested: concurrent-fetch dedup keyed by book/doc, settles without rejecting, failed docs stay unloaded and degrade to their index line; module added to coverage include). Wired at four points: eager load on pin in `cycleReferenceState`, awaited for pins in `assembleChatRequest` before Layer 1 selection, awaited for all non-active chapters in `planWholeBook`, and awaited per lookup round before filtering requested chapters. `setActiveDocumentId`'s inline lazy-load fetch now reuses the same action. |
| 2026-07-25 | Tag-Free Replies Are Model Instability, Not a Prompt Bug (investigation) | Symptom: the model replies with a bare acknowledgement ("已按大纲接上第二章", ~13 output tokens), the response carries no `<canvas>`/`<edit>` tags, `parseAssistantResponse` classifies it as plain chat, and `onDone` leaves the document untouched — the chat says the document was updated and nothing happened. Measured against grok-4.5 with the user's real preset and a fixed request (n=19 + n=18, interleaved): tag-free replies occur with the preset disabled, with no chat history at all, and under every prompt variant tried; the success rate for an IDENTICAL prompt drifted from ~65% to ~22% within the same hour. Hypotheses tested and rejected: (a) the preset overriding the protocol — reproduces without it; (b) `x-grok-conv-id` shard pinning causing the model to repeat its previous completion — 2/6 shared vs 1/6 unique, no effect; (c) a reminder appended to the final user message — 1/5, 4/5 and 4/5 for three wordings against a 3/4 control, i.e. nothing that survives the noise (the reminder was implemented, measured, and REVERTED rather than shipped on a favourable n=1). Elided history correlates but does not explain it (~32% tag-free-history vs ~71% no-history). Conclusion recorded for the next attempt: this is not fixable by instruction alone — the client must detect "assistant produced no document action", retry once with a corrective instruction, and surface a ⚠️ instead of reporting success. |
| 2026-07-25 | System Prompt Layering: Format Protocol Last | Investigated alongside the above and kept as hardening, though it was NOT the cause: `buildSystemPrompt` appended the user's writing preset LAST, after the protocol rules, and presets routinely carry output-channel language ("output the prose directly", "add no explanations", "avoid non-<language> text"). System-prompt assembly extracted verbatim to pure, tested `src/utils/systemPrompt.ts` with a fixed layering — protocol rules → chapter-lookup protocol → preset → `FORMAT_PROTOCOL_REMINDER`, which is always last and scopes every preceding instruction (presets included) to style/voice/language/content. Deterministic output keeps provider prompt-cache prefixes intact. |
| 2026-07-25 | Book Switching Broken by an Unselected Column | `GET /api/books/{id}` returned 500 on every call (38 tracebacks in `api-server.log`): the document-metadata SELECT listed only `id, title, sort_order, created_at, updated_at`, while the response read `d["summary"]` / `d["summary_content_hash"]` — `sqlite3.Row` raises `IndexError` for an unselected column, so the endpoint died and the UI silently refused to switch books. Introduced with the server-synced summaries work (2026-07-15). Fix: SELECT the two columns, plus an inline note that every column read in the response must be listed, and a regression test in `scripts/test_api_server.py` that calls `get_book` against a temp DB (chapters with and without a summary). |
| 2026-07-25 | Retry Depth Set From the Measured Curve | The no-action recovery round was bounded at 1 on a guess. Measured against grok-4.5 on the user's real chapter-rewrite turn (full context: chapter index + two auto-attached chapters + a 7.6k-char active chapter + history; n=8 trials, up to 4 attempts each): 0 retries → 2/8 turns produced document content, 1 → 4/8, 2 → 7/8, 3 → 8/8. Every trial eventually succeeded, so failures are independent re-rolls rather than a stuck state, and a failed round costs ~25 output tokens (the input is largely re-read, mostly at cache-hit price). `MAX_NO_ACTION_RETRIES` raised 1 → 3 and the status bubble now counts attempts. Context shape does NOT explain the failure: attaching two full chapters (2/8), summaries only (3/8) and nothing (3/8) were indistinguishable at n=8, after an n=5 batch had suggested otherwise — batch-to-batch drift for an identical prompt ran 22%–65% within one hour. `WHOLE_BOOK_CONTEXT_CHARS.grok` raised 300k → 500k chars so sticky whole-book engages for all but the largest book in this library (516k chars of text; per-book sizes measured with embedded base64 images excluded). Whole-book mode stays manual (not persisted): the sticky prefix is rebuilt from live state each send, so it is never stale, but switching the active chapter reorders it and costs one full-price re-read (cache miss is 6.7x a hit at the provider's listed prices). |
| 2026-07-26 | Edit Blocks Rejected for a Missing Terminator | Symptom: an `<edit>` response rendered its raw SEARCH/REPLACE markup into the chat and changed nothing. Cause: `parseEditBlocks` required the canonical `>>>>>>> REPLACE` line, but grok-4.5 routinely ends a block at `</edit>` instead. Zero blocks parsed ⇒ `parseAssistantResponse` classified the reply as plain chat ⇒ no document branch ran, and at 477 chars it was far too long to trip the short-acknowledgement retry, so it failed silently. Fix: the parser now scans SEARCH → divider → terminator, accepting `>>>>>>> REPLACE`, `</edit>`, or the start of the next block; a REPLACE half that runs to end-of-text with no terminator is DROPPED (that is a cut-off stream, and applying half a replacement would truncate the document). Safety net: `looksLikeUnfulfilledDocumentUpdate` now also fires on any unparsed `<edit>`/`<<<<<<< SEARCH` markup regardless of length, so a shape we still cannot parse triggers the bounded retry and, failing that, a ⚠️ instead of dumping markers into the chat. |
