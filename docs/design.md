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
| 2026-08-15 | Server-side resumable generation | Registered [resumable_generation.md](file:///home/hongdp/Workspace/web_canvas/docs/features/resumable_generation.md). LLM streaming moved from the browser tab into the FastAPI backend: `POST /api/generate` starts a buffered job, `GET /api/generate/{id}/stream?from=<charOffset>` replays then streams live, plus `abort` and `active`. Motivation as filed: mobile Firefox discards a backgrounded tab (measured: JS context destroyed, navType 'reload'), which would kill an in-flight generation. Device testing afterwards CORRECTED that premise — an active streaming connection keeps the tab alive, so discards only happen while idle and the motivating scenario does not reproduce (spec §1). Kept deliberately for the benefits that do hold: a closed tab / crash / OOM kill no longer loses work in flight, the stop button now cancels the upstream request instead of merely dropping the local reader (it used to keep generating and billing), and a generation started on the phone can be watched on the desktop. The client keeps `streamLLM`'s signature and picks a transport (remote when logged in, direct otherwise; only a failed START falls back, never a running job). Per-event character offsets make reconnects lossless; jobs are per-user, retained 10 min, capped at 20/user and 4M chars. Provider parity with services/llm.ts was ported deliberately, including the Anthropic total-input/cumulative-output usage fixes and Gemini safety-block detection. Known gaps in spec §8 (roleplay cannot rejoin; a server restart drops in-flight jobs). |
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
| 2026-08-15 | The Model Declares Document Status; the Client Only Checks It | The no-action retry originally fired on any short tag-free reply, then on a local guess at whether the user's prompt "asked for an edit" (`requestExpectsDocumentChange`). Both are the same mistake: the client cannot know whether a turn warranted a document change, so ordinary conversation ("does this pacing work?", "流式测试正常") burned three extra generations and ended in a ⚠️ about a failure that never happened. Whether to edit is the model's call. The protocol now requires every reply to end with `<doc_status>updated|unchanged</doc_status>`, stripped before the bubble renders (`stripDocStatus`, also mid-stream so it never flickers). `detectFailedDocumentUpdate` retries exactly two self-inconsistent turns: `malformed` — edit markup the parser rejected — and `claimed` — a declared update that emitted no markup. The declaration outranks prose in BOTH directions, so it silences false positives (a model describing what the *user* changed) as well as catching claims no regex would match ("嗯。"). Not provider-native structured output: Anthropic has no `response_format`, and JSON-wrapping the document would break incremental streaming into the editor and the mid-stream HTML tail trimming. Models that omit the trailer fall back to the prose heuristic, so the change degrades rather than breaks. |
| 2026-08-15 | System Prompt Reduced to the Wire Protocol | The static system prompt opened with a persona ("You are an elite creative writing assistant… you help authors write, format, rewrite and structure their books") and carried style language ("beautifully formatted HTML"). That competes with the user's own preset and their message, and the user loses by construction: the preset sits in the MIDDLE of the prompt while ours sits at both ends (protocol first, `FORMAT_PROTOCOL_REMINDER` last). `PROTOCOL_RULES` now declares its own scope in the first line — output channels, markup, status line, nothing about what or how to write — and every task/style instruction comes from the preset and the user message. Kept as protocol, not style: HTML-only tag contents (the editor stores HTML), preserving markup that was not asked to change (whatever is emitted replaces the document, so dropped formatting is lost), and the image-token rules. Examples were neutralised to demonstrate the channel rather than a voice. Pinned by a test asserting the assembled prompt matches no persona/style vocabulary, so it cannot creep back. |
| 2026-08-15 | Slow First Token: Measured, Split, and Made Visible | User report: "streaming works, but the first token is very slow." Instrumented the live session at the fetch boundary rather than guessing. Press→POST 80ms, POST→jobId 51ms, stream attach→first byte **15,008ms**, attach→first delta **40,748ms**; a second turn ran 60s+ with zero tokens. Two independent causes. (1) The 15s was ours: HTTP response headers flush with the first body chunk, and `_job_event_stream` writes nothing until a delta or the `SSE_HEARTBEAT_SECONDS = 15.0` keep-alive, so the client could not distinguish a live stream from a stalled one. Fixed with an `attached` frame emitted the moment the reader subscribes — no text, no offset advance, ignored by older clients. (2) The rest is provider-side (grok-4.6 reasoning before its first visible token) and cannot be removed, so it is now legible instead: `StreamingStatus` separates "is thinking..." from "is streaming changes..." and counts the seconds. Also found from the backend job registry: one chat message spawned 2–3 jobs (70 → 20 → 5,122 chars), each a discarded no-action retry costing a full prefill — the retry-scope change of the same date cuts those. Backend now logs time-to-first-token with input size, so this never needs ad-hoc instrumentation again. |
| 2026-08-15 | Reasoning Made Visible; INFO Logging Was Never On | Follow-up to the latency work: the user reported 50s with no output AND no `first token after` line in the log. Two separate defects. (1) `uvicorn.run(log_level="warning")` configures the ROOT logger at WARNING, so every `logger.info` in this app — job starts, the new time-to-first-token line — was silently discarded. `_configure_app_logging()` now gives the `web_canvas` namespace its own INFO handler on stdout (which `start.sh` redirects into `app.log`) with `propagate = False`, leaving uvicorn's access-log noise off. (2) Reasoning models stream their thinking on `delta.reasoning_content` (also seen as `delta.reasoning`), and the OpenAI-compatible reader only read `delta.content` — so a model that thinks for a minute before its first visible token looked identical to a dead connection. Reasoning is now forwarded as an unbuffered `reasoning` event: counted (`reasoning_chars`, `reasoningTokens` from `completion_tokens_details`) and shown live as a dimmed tail under the status line, but never appended to `job.buffer`, so replay offsets and document text are untouched and a reconnect simply misses what was thought while away. Client repaints are throttled to 250ms and capped to a 240-char tail, since deltas arrive far faster than a human reads. Also: `diff.perf.test.ts` budgets are absolute wall-clock and failed three pushes under concurrent build load with no code change — each measurement now takes the fastest of 3 runs, which keeps the budget meaningful while dropping scheduler noise. |
| 2026-08-15 | The Log Fix That Logged Nothing, and One Free Reconnect | Two follow-ups from live testing. (1) `_configure_app_logging` (added hours earlier) still produced an empty log: `start-server.js` pipes the API server's stdout, and **a piped stdout is block-buffered in Python** — lines sat in an 8KB buffer instead of reaching `app.log`. This had silently swallowed every `print()` this server ever made too (`grep -c "\[API\]" app.log` → 0). Fixed by reconfiguring stdout to line buffering, falling back to stderr (line-buffered when piped no matter what), and verified end-to-end by running the real config in a piped subprocess. Lesson: a logging change is not verified until a line is observed at the destination. (2) A stream that ends without a terminal event usually means the connection dropped, not that the job died — the backend keeps generating. `attachToJob` now re-attaches **once** from the offset already rendered, carrying the accumulated text forward (a mid-turn reconnect must still report one whole answer, or the caller parses only the tail); a job that is really gone fails its retry immediately and reports as before, with the persisted record kept for a later cold resume. The pre-existing cold-reload test had to make the in-page reconnect fail as well, since a live page now self-heals. |
| 2026-08-15 | Reasoning Events Closed Every Stream | Same-day regression from the reasoning work, and the worst kind: every message failed with "⚠️ Error during stream: Generation stream disconnected before completion" while the backend job ran to completion. Cause: the reader loop in `_job_event_stream` was written as `delta → forward, everything else → forward and RETURN`, which was correct when the only other events were `done`/`error`. The new `reasoning` event took that branch, so the FIRST reasoning delta (1.5s into a turn, measured) closed the SSE stream; the client's one re-attach hit the same wall and gave up. Terminal types are now an explicit `TERMINAL_EVENT_TYPES` frozenset and anything else is forwarded without ending the stream. Why the tests missed it: the backend reasoning test drained a subscriber queue directly and the client test fed a synthetic SSE body, so neither exercised the reader loop that does the classifying — the new regression test drives `_job_event_stream` end-to-end (attached → reasoning → delta → done) and fails without the fix. Lesson: when adding a message type to a protocol, test it through the component that DISPATCHES on type, not around it. |
| 2026-08-15 | Where the 100s Actually Went: grok-4.6 Reasoning | With logging finally reaching disk, the answer arrived in one line per job (`api-server.log`, NOT `app.log` — the API server's output goes there, which cost an hour of grepping the wrong file): first token after 127.08s / 187.59s / 198.95s / 45.11s on 41,773 chars of input, and the completed turn read `reasoning 8648 chars, output 7317 chars`. The newest job also logged `started reasoning after 1.54s` — the provider responds essentially immediately and then thinks for minutes. So the stack's own contribution is ~1.5s and everything else is grok-4.6's reasoning phase, which no client change can shorten; forwarding the reasoning deltas (same date) is the whole available remedy, and it turns three minutes of silence into three minutes of visible thinking. Also fixed here: `start-server.js` treated `MAX_RESTARTS` as a LIFETIME cap, so ten restarts across a long session left Vite serving a UI with no backend — the counter now resets after a process stays up 60s, and respawns back off exponentially (2s→15s) because uvicorn can sit in graceful shutdown still holding `:3000` when an SSE stream is open, turning every fast retry into an EADDRINUSE that burned the budget. |
| 2026-08-15 | The Declaration Becomes Mandatory | "It said it wrote and it didn't" came back after the intent-guessing heuristic was removed, because the loosened rule left a hole: a reply with NO `<doc_status>` fell through to prose matching, and a model whose phrasing missed those patterns passed as a normal chat answer. Per the user's call — "if the LLM doesn't produce the structured output it should error; if it doesn't want to write it should still emit a structured reply" — the declaration is now required on every reply and its absence is a failure mode of its own (`undeclared`), retried like the others with a corrective turn that spells out BOTH acceptable shapes so a model with nothing to change can comply without inventing an edit. A second hole closed at the same time: a declaration of `unchanged` sitting next to a FIRST-PERSON claim of having written is the model contradicting itself, and is now `claimed` rather than trusted — narrowly, via `SELF_CLAIM_PATTERNS`, whose lookbehind keeps "你已经把第二章改好了" (the model describing the USER's edit) out of it. The broad prose heuristic is deleted: with the declaration mandatory, an undeclared reply is already a protocol failure and no pattern-matching of prose is needed to reach that verdict. |
| 2026-08-15 | A Wrapper That Dropped Every Optional Callback | The reasoning UI shipped, the backend logged `started reasoning after 1.54s`, and the panel still showed nothing but "is thinking...". `streamLLM` wraps the caller's callbacks to add debug logging and rebuilt the object **field by field** (`{ onChunk, onDone, onError }`), so every optional callback — `onReasoning`, `onAttached` — was silently dropped before reaching the transport. Fixed by spreading `...callbacks` first, which also makes the wrapper future-proof for callbacks added later. The direct transport now reads `delta.reasoning_content` / `delta.reasoning` too, so the fallback path shows the same thinking as the backend path. This is the third defect in one day from the same shape of mistake — code that enumerates cases (event types in the SSE reader, config fields in the remote start payload, callback names here) and therefore silently ignores anything new. Where enumeration is unavoidable, the test must go through the enumerating code, not around it. |
| 2026-08-15 | Thinking Effort: Default Low, Adjustable Per Model | The 127–199s waits were entirely the model's reasoning phase, so the effort level is the only lever that shortens them. xAI's docs confirm grok-4.6 takes `reasoning_effort` = low/medium/high (default)/xhigh and cannot disable reasoning; **no provider exposes capability metadata over its API** (xAI's `/language-models` returns pricing and modalities, OpenAI's and Anthropic's model lists are silent), so supported levels live in a table in `utils/reasoningEffort.ts` and a wrong guess degrades rather than fails: the backend retries once with the parameter stripped when the provider's 400 names it, guarded on `job.length == 0` so nothing can be duplicated. The app default is **low**, not the provider's — for document editing, a deep pass that keeps the writer staring at an empty page is the wrong trade, and anyone who wants it can pick it. Two distinct "unset" states: absent means "use this app's default", explicit `'default'` means "send no parameter". Providers spell effort three ways — a word (`reasoning_effort` for OpenAI-compatible and Grok), a Gemini `thinkingConfig.thinkingBudget`, and an Anthropic `thinking.budget_tokens` clamped below `max_tokens` — mapped in both transports, since generation runs on the backend but falls back to the direct path. |
| 2026-08-16 | Per-Test Timeouts Cannot Catch a Wedged Suite | A test harness passing inline arrow callbacks into `useModelFetcher` re-ran its effect every render and spun forever; the run had to be killed by hand. Measured what the defaults actually protect against, with a two-case probe: a test awaiting a promise that never resolves fails at ~5,009ms as expected, while a test that spins synchronously is only reported **after** it finishes (60,001ms) — the runner's timers cannot fire when nothing yields, so an unterminated loop wedges the suite indefinitely. Conclusion: per-test timeouts are necessary but structurally unable to cover the loop case, so `.githooks/pre-push` now bounds the whole run (`timeout 300 npm test`, against a ~5s suite) and reports a wedge distinctly from a failure; `testTimeout`/`hookTimeout` are stated explicitly in `vitest.config.ts` with a note on that gap. Both hook branches were exercised before committing (exit 1 with the diagnostic on timeout, exit 0 on success). Related measurement, since it prompted the question: the suite is NOT slow — 519 tests in ~5.2s; `--pool=threads` was 0.24s *slower*, and moving pure-logic files to the `node` environment fails outright because the shared `src/test-setup.ts` needs jsdom. |
| 2026-08-16 | Local Models Are Unselectable Without Discovery | Deploying Qwen3.8-27B locally (llama.cpp, OpenAI-compatible on 127.0.0.1:8090) needed no application change — both transports already treat a loopback baseUrl as OpenAI-compatible-without-`stream_options` — except for one wall: the model field is a **fixed dropdown** seeded from `PROVIDER_MODELS.ollama` (`llama3`, `mistral`, …), so a locally-served model simply could not be chosen. The list is now discovered from the endpoint like Gemini's and Grok's, accepting both dialects that "Ollama-compatible" covers: Ollama's `{models:[{name}]}` and OpenAI's `{data:[{id}]}` (llama.cpp answers with both). A configured model the endpoint does not serve is replaced, since it would 404 on every send; an unreachable endpoint is silent, because "no local server running" is the normal case rather than an error. Test-harness note recorded with it: the hook lists its `setErrorMsg`/`setIsLoadingModels` callbacks in effect deps, so a caller passing inline arrows re-runs the effect on every render — a test doing that spun until the worker died, which looked like a product bug and was not one. |
| 2026-08-16 | Two Model Dropdowns, One Fixed | The discovered list was wired into Settings only; the **top bar** — the control people actually use to switch models mid-session — still read the shipped `PROVIDER_MODELS` for ollama, so a local model appeared in one place and not the other. `AppHeader.getAvailableModels` now prefers the discovered list, exactly as it already did for Gemini and Grok. Verified by driving the real header: switching the provider to Ollama leaves the model dropdown holding `qwen3.8-27b-uncensored`. Only these two components consume the lists, so nothing else is out of step. |
| 2026-08-16 | HTTPS Blocks Client-Side Discovery of a Local Model | The model dropdown stayed empty even after discovery shipped. Measured from the page rather than reasoned about: `http://127.0.0.1:8090/v1/models`, `http://192.168.0.110:8090/...` AND `http://127.0.0.1:11434/...` all fail with "Failed to fetch", while the same URLs answer instantly from the server process. Cause is **mixed content** — the dev server is served over HTTPS, so the browser blocks every plain-http request, and no bind address or LAN exposure can fix that. Generation was unaffected because it runs on the backend, which is why the split went unnoticed. Fix: `POST /api/models` lists on the browser's behalf — same-origin for the page, same host as the model server — restricted to loopback hostnames so it cannot serve as an SSRF proxy, and returning `{models: []}` for an unreachable server since that is the normal case. The client tries direct first (correct when the page is plain http) and falls back. Second bug, found only by driving the real UI: the backend returns already-normalized **strings** while the client parser read `.name` off each entry, so a 200 response produced an empty list and the dropdown silently kept its hardcoded contents. Both sides were green against their own fixtures; nothing covered the seam. The parser now resolves per item and a test feeds it the backend's exact shape. |
| 2026-08-16 | A Stale Selection Range Killed the Whole Turn | Reported live as `⚠️ Error during stream: Position 10 out of range` — a ProseMirror throw, not a provider failure. A `<selection_replace>` dispatches `tr.replace(from, to, slice)` with positions captured when the turn STARTED; if the document moved on meanwhile (chapter switched, content shortened) those positions no longer exist. "Position 10" says it plainly: a nearly empty document holding a range from a much longer one. The throw escaped through the stream callback, so a complete generation was discarded along with it. `clampSelectionRange` now fits what is still addressable and returns null when the start itself is past the end — writing at a guessed position is worse than not writing — and the finished turn says so (`selectionGone`) with the rewrite left visible in chat rather than silently dropped. The local model made this easy to hit: at ~50 tok/s the window between capturing a selection and applying it is full of fast edits. Found alongside a second papercut in the same session: a base URL typed with a trailing slash built `/v1//chat/completions`, which llama.cpp answers with a bare 404 "File Not Found" that reads like a missing model; all six URL builders now normalize it. |
| 2026-08-16 | Summaries Get Their Own Provider, and Somewhere to Be Read | Two gaps found together. (1) Background chapter summaries ran on `providerConfigs[activeProvider]` — chatting with grok billed grok for work on EVERY chapter, and the existing `summaryModel` field could only pick a cheaper model within the same provider. A `summaryProvider` setting ('active' keeps the old behaviour) now lets the drudge work go to a local endpoint while chat stays wherever it is; the per-provider `summaryModel` still applies within the chosen one. (2) The summaries were written, synced, and injected into every prompt while being **visible nowhere in the UI** — a grep for a component rendering `doc.summary` found none — so their quality could not be judged at all. The chapters sidebar now expands a chapter's summary inline. Reading real ones immediately paid off: of 352 chapters only 51 are summarized, and Chinese chapters produce **English** summaries at 1,400–1,800 characters against a prompt asking for "about 120 words" — worth revisiting. Test note: the first version of the provider test used `vi.resetModules()` with a dynamic import, which handed the service a SECOND copy of the store module, so it read state the test never wrote — the same phantom-instance trap as the browser-console probe earlier in the session. |
| 2026-08-16 | Summaries in the Chapter's Own Language — and a Causal Claim Corrected | Chinese chapters were producing English summaries at 1,400-1,800 characters against a prompt asking for "about 120 words". First attempt — an English instruction saying "write in the same language as the chapter" — appeared to fail outright: two runs, both 0% Chinese. Concluding from that that English instructions force English output was **wrong**, and the user's counter-question ("maybe it doesn't know which part is the chapter?") is what prompted the measurement that showed it. Three runs per prompt on the same chapter: English instruction → 83%, 83%, **0%** Chinese (the failure also running 1,475 characters, five times the cap); Chinese instruction → 82%, 83%, 87% at 352-490 characters. Marking the chapter boundary with explicit `<chapter>` tags was tested separately and changed nothing (61%, 63% vs 67%). So `detectSummaryLanguage` + per-language prompts stay — for **consistency**, which is the real defect, not for capability. This is the two-sample causal inference this log has warned about twice before, made by the same author who wrote those warnings. The underlying volatility is a property of the local IQ2_M quantization: instruction-following that mostly holds and occasionally collapses. |
| 2026-08-16 | A Paused Summary Queue Read as a Wedged One | Reported: "Summarizing… 1 done, 1 left" outliving a run, and a second chapter apparently un-addable mid-run. The queue logic was sound (both symptoms failed to reproduce in tests against it); the defect was in what the status strip SAID. The queue defers while a chat stream runs — correct, and on a single-slot local server unavoidable — but the strip's waiting condition was identical to its working condition, so a queue pausing for a multi-minute generation displayed "Summarizing…" the whole time, and a chapter enqueued during the pause produced no visible change. The defer retry also re-entered processQueue and reset `completedThisRun`, turning "1 done" into "0 done". `waitingForChat` is now its own status field with its own strip text ("助手回复中，摘要已暂停…"), and a run's counters survive defers (`runActive`). The general lesson repeats from the streaming-status work the same week: when a system is legitimately waiting, the UI must say WHAT it is waiting for — every "busy" label that covers a wait state manufactures a hang report. |
| 2026-08-16 | Layout: Read Summaries Where There Is Room; Sizes That Survive Reload | Follow-up to the user's layout review, direction chosen explicitly: top drawer + targeted sizing (full splitter system rejected as high-regression against four responsive modes). `BookOverviewDrawer` lists every chapter beside the full summary the assistant reads, with per-chapter re-summarize and the queue status (including waiting-for-chat) — replacing the 0.72rem sidebar expander as the place summaries are actually judged. Desktop: height-adjustable (pointer events, so touch works) and persisted; phone layouts: fills the document area, since half-covering a phone screen serves nobody. Chapters sidebar gains a drag handle (200–420px) via a CSS variable that only the desktop rule consumes — phone overlay rules keep their fixed 280px untouched; chat width now persists instead of resetting to 380 on every load. All sizes go through `layoutPrefs` (clamped on LOAD as well as save: a width stored on a bigger monitor must not overflow a smaller one). Debugging note for the log: the sidebar width "not applying" during verification was the 0.25s width transition FROZEN at currentTime 0 — Chrome suspends animations in background tabs, and a rAF-based probe hangs there too. `getAnimations()` showed it; disabling the transition showed 340px instantly. The feature was never broken. |
| 2026-08-16 | A Resumed Turn That Wrote Nothing Said Nothing | Reported alongside local-model testing: after a mid-generation refresh the stream visibly resumes, finishes, and the document never changes. Three separate things were tangled in that. (1) The partial content vanishing on refresh is BY DESIGN — the store is deliberately not written during streaming (it would churn persistence every tick and fight Editor.tsx's content sync), so a reload shows the last saved content. (2) The rejoin path itself is sound and test-covered: a resumed job's `<canvas>` lands in the document as a diff. (3) The real defect: a rejoined turn runs with `noActionRetryArmed: false` (there is no request left to replay), so a reply that produced no usable update produced **no message either** — the failure was silent, which is exactly what "it finished and nothing happened" describes. Now such a turn explains itself and tells the user to re-send. Deliberately narrow: only `malformed` and `claimed` warn, since those mean content was LOST; a merely `undeclared` reply is a protocol lapse that would shout over ordinary conversation. Measured context for why this surfaced now: the local 14B emits bare `<p>` HTML with no `<canvas>` wrapper on an expansion request (A/B against the same prompt without the protocol: 603 chars of genuine expansion bare, 533 chars unusable under the protocol), so on that model nothing reaches the document by construction. |
| 2026-08-16 | A Resumed Generation Streamed Into the Bubble and Nowhere Else | "I refreshed mid-generation, it says it is still streaming, and the document stays empty." The server side was never at fault — the rejoin replays from offset 0, so the accumulated text IS sent back. The client dropped it: the rejoin effect runs ON MOUNT, before the editor exists, so `buildStreamCallbacks` captured `activeEditor: null` and held it for the entire resumed turn. Every document-side render is guarded by that value (`if (activeEditor && …)`), so the replay reached the chat bubble (store-based, no editor needed) and the document preview was skipped from first chunk to last. Fixed by binding the editor through a ref read at CALL time rather than captured at build time — the same treatment the store already gets via `useAppStore.getState()` for the identical reason. Note the existing rejoin test passed throughout, because its harness passes `activeEditor: null` and asserts only the store; the new test mounts the editor AFTER the hook, the way the real one mounts, and fails without the fix (verified by reverting). Lesson: a harness that hardcodes the degenerate value cannot see a bug that only exists in that value. |
| 2026-08-16 | Nothing Was Saved While Streaming, and a Reload Forgot Where to Edit | Two independent reasons a refresh lost work. (1) `schedulePendingSave` was a pure debounce — `clearTimeout` then `setTimeout(3000)` — and a stream calls it on EVERY chunk, tens of times a second, so the timer never expired and **nothing was persisted for the entire generation**. A refresh mid-stream therefore found no reply on the server at all. The debounce stays (it is what prevents a save per keystroke) but is now capped: past 10s of starvation the pending save runs and the debounce restarts; `clearPendingSave` also forgets accumulated starvation, so a cancelled save does not leave the next one already overdue. (2) Asked directly whether a reload still knows WHERE to apply an edit: `<canvas>` needs no position and `<edit>` locates itself by SEARCH text, but `<selection_replace>` used `selectionRangeRef` — an in-memory ref — so after a reload a finished rewrite had nowhere to land and was dropped silently. The selected TEXT now rides along in the persisted job meta, and `findTextRange` relocates it by content the way edit blocks always have, refusing when the passage is missing or ambiguous rather than guessing. Method note: the first mutation check on the starvation cap passed with the fix disabled — the mutation hit the early return while `Math.min(delayMs, remaining)` still did the work. Reverting to the original pure debounce turned two tests red, which is what actually proved them. A mutation that leaves a second mechanism intact proves nothing. |
| 2026-08-16 | From a Private Tag Language to Native Tool Calling | The Canvas Markup Protocol asked every model to learn `<canvas>` / `<edit>` / `<selection_replace>` / `<doc_status>`. Frontier models managed it; a local Qwen3-14B never did — measured A/B on the same expansion request, it produced 603 characters of genuine expansion with a bare prompt and 533 characters of unusable bare `<p>` under the protocol, so NOTHING reached the document, every time. Given the identical task as an OpenAI function call it called `update_document` correctly on the first attempt, because that format is in its training data and ours is not. Migrated to OpenAI-shape function calling as the single internal representation (four of five providers speak it natively; Anthropic gets `input_schema` + `tool_use`, Gemini `functionDeclarations` + `functionCall`, both as thin edge adapters). The feared cost — losing the live document preview — does not exist: arguments arrive as string deltas (measured 205 on a real local stream, first at 0.3s), and `partialStringArgument` reads a still-arriving value out of JSON no parser would accept, so the editor renders as before. Three consequences fall out structurally: `<doc_status>` retires (calling a tool IS the declaration), the `malformed` failure mode retires (the API rejects bad shapes), and the system prompt drops from 5,090 to 1,347 characters — the schemas carry their own documentation, and repeating it would give the model two sources to reconcile. Legacy tag parsing stays behind the tool path for models with no tool support. Acceptance: the same 14B, the same request, the real shipping prompt and tools — 0 characters reached the document before, 426 after. |
| 2026-08-16 | Tool Calls Had to Survive a Reload Too | Reported right after the tool migration: "streaming update still does not work, and a refresh loses it." Two causes, one mine per cause. (1) The API server process predated the tool-call forwarding by three hours — the client received no `tool_call` events at all, which is invisible in tests and obvious in `ps`. Restarting fixed it, and it is the third time this session that a stale backend passed for a code defect; the log line to check is the process start time against the file mtime. (2) The real defect: tool arguments were published live but never buffered, on the reasoning-event precedent — deliberately, so replay offsets stay tied to document text. But reasoning is disposable and an edit is not, so a reader that reconnected after a reload saw no call and lost the whole edit. Calls are now kept on the job in a separate map and replayed WHOLE on attach (there is no offset to resume a tool call from), marked `replay: true` so the client REPLACES its accumulator instead of appending — appending a whole call onto a partial one would duplicate the text into invalid JSON. Verified against a live generation: a reader attaching mid-flight gets `attached` → `tool_call` (whole, flagged) → `done`, and the final arguments parse. |
| 2026-08-16 | The Same Wrapper Mistake, Twice in One Day | "刷新后还是没有流式更新", after the tool-call replay shipped. The backend was current this time (the new CLAUDE.md check confirmed it in one command — 21:17:23 against a 21:17:08 edit), so it was a real defect: the rejoin path rebuilt the callbacks object field by field, forwarding only onChunk/onDone/onError, so the server's replayed tool call arrived at a listener that did not exist and the document never changed. This is EXACTLY the bug fixed hours earlier in `streamLLM`'s debug wrapper, which swallowed onReasoning and onAttached the same way — and the fix is the same one: spread the original first. The compiler cannot help, because every callback but three is optional, so the warning now lives on the `StreamCallbacks` type itself where a wrapper author will read it. The rejoin also skips `startLLMStreaming`, so the per-turn tool accumulator reset had to be duplicated there — a second instance of "the rejoin path is not the send path" after the editor-binding bug. New test drives a replayed tool call through the real rejoin and fails without the spread (verified). |
| 2026-08-16 | Review Markup Was Being Fed Back to the Model | "现在不刷新也没有流式更新了." Instrumented a real turn in the browser rather than reasoning about it: tools went out correctly (`update_document, edit_document, lookup_chapters`), grok called `edit_document` with 228 characters of arguments, and the document did not move — with no warning. Capturing the raw arguments on the next turn showed why: the search string contained `<ins data-diff-id="diff-tz9zohl" class="diff-addition">`. Pending review markup lives in the stored document, and the stored document is what the prompt carries, so the model copies markup that DISAPPEARS the moment the user accepts or rejects that diff — after which the search can never match. `stripDiffMarkup` now cleans the active document on its way into the prompt (insertions kept, deletions dropped: the "accepted" reading the user is looking at). Second defect from the same turn: a tool call whose arguments yield nothing applicable (empty `edits`) was mapped to `kind: 'chat'`, so the turn ended in silence — and worse, the legacy `<doc_status>` check then fired and RETRIED it. A document tool call is now the declaration: legacy text detection is skipped entirely when one is present, and an unusable call says so. Note the second turn, run identically, DID apply its edit (3777 → 3972 chars) — the failure is conditional on pending diffs, which is exactly why it read as random. |
| 2026-08-16 | Selection Rewrites Lost Their Stream, and Their Place | Clarified mid-investigation that the workflow under test was the selection rewrite — which changed the diagnosis completely. Two defects, both mine, both introduced by the tool migration. (1) The live preview handler read `if (acc.name !== 'update_document') return`, so a `replace_selection` call streamed nothing into the document. The tag protocol HAD previewed these (throttled `tr.replace` at 60ms), so to anyone whose main use is rewriting a selection, streaming simply stopped working. Restored, at the same throttle, sharing the clamp. (2) `findTextRange` — added the same day so a reload could relocate a selection by text — computed positions with string arithmetic on HTML. **A plain-text index is not a ProseMirror position**: every block boundary adds one, so the error grew with each preceding paragraph and a relocated rewrite would land off-target. Replaced with `findTextRangeInSpans`, which walks the real node tree (also handling a passage split across text nodes by marks), deferred until the editor exists since the rejoin runs before it mounts. The test that "covered" the old version asserted only that the range was non-null on a single-paragraph fixture — a fixture too simple to expose the very error the arithmetic made. |
| 2026-08-16 | Document Protocol Became a Per-Model Setting | The user laid out the regression precisely: streaming preview worked before backend forwarding; after it, a refresh lost the reconnect and the diff, but an unrefreshed turn was fine; after the tool migration, even an unrefreshed turn lost the preview while the diff survived. One measurement explained the last step. Same grok request, same document, sent twice: tool arguments arrived in **1 delta of 113 characters**, ordinary content in **54**. With a single chunk there is no intermediate state to render, so `partialStringArgument` — the whole reason the tool path was supposed to keep its preview — never has anything partial to read. Live preview under tool calling is structurally impossible on that provider. The tools were never wrong: a local Qwen3-14B could not emit `<canvas>` at all and called `update_document` correctly on the first try (205 argument deltas, streams fine). Both protocols are right somewhere, so the choice is now a per-provider setting (`ProviderConfig.documentProtocol`, bound to the model like `reasoningEffort`) defaulting to 'auto': tools for local models, markup for grok/gemini and anything unmeasured. The system prompt teaches exactly one of them — `buildChatSystemPrompt` now requires `protocol`, because describing tools to a request that sends none silently disables editing. Verified end to end in the browser: grok on markup sent `hasTools: false` with the tag rules, and the document changed **65 times** during one selection rewrite, against 0 under tools. Note what the earlier measurement missed — I had verified argument streaming granularity on llama.cpp only, and generalized it to every provider. |
| 2026-08-16 | The Rejoined Selection Rewrite Previewed Nothing | "重连后的live preview还是没有", with the per-model protocol in place and the end-of-turn diff already fixed. A resumed turn carries the selected TEXT, not a range — ProseMirror positions die with the editor that made them — so a rejoined rewrite has to relocate it before it can preview. That relocation was wired into the tool-call preview and the final apply, but NOT into the markup chunk preview, which is the path grok is on precisely because it cannot stream tool arguments. So `selectionRangeRef` stayed null for the whole rejoined turn and the guard beneath it skipped every preview, leaving exactly the reported symptom: nothing until the diff lands. Third instance of the same shape ("the rejoin path is not the send path", after the editor binding and the callback spread), and the reason it recurs is duplication — the relocation existed as two hand-copied blocks, so a third caller silently did without. Now one module-level `relocateResumedSelection` in chat/streamHandlers, taking the refs as arguments rather than through a useCallback that would capture them and destabilise the streaming callbacks. Test drives a replayed markup selection rewrite through the real rejoin with a fake editor and asserts a transaction was dispatched mid-stream; removing the new call turns it red (verified). |
| 2026-08-16 | A Failed Relocation Must Not Consume Its Input | Sharing the selection relocation across all three callers fixed the missing preview and immediately broke something worse: "刷新后还是没有live preview甚至现在diff也没了". The helper cleared `pendingSelectionText` whether or not it found the passage. On a reload the editor mounts BEFORE the server sync fills it, so the first chunks search an empty document, fail, and threw away the only thing later callers could relocate with — costing the diff too, which had been working. It now returns without consuming on failure, so a later chunk (or the final apply) retries once the document is there. The general shape is worth remembering: a "resolve once, then cache" helper must distinguish "resolved to nothing" from "could not resolve yet", and the second must not be recorded as the first. Test mounts the fake editor with an EMPTY document, streams a chunk (asserting no preview), fills the document, streams another, and asserts the preview lands; removing the early return turns it red (verified). Confirmed by the user end to end afterwards: preview, diff, and refresh-mid-stream all behave. |
