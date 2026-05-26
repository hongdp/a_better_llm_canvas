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

### 3.3 Mobile UI & Responsive Layouts

Web Canvas dynamically adapts to different screen sizes and orientations through a custom 4-state layout engine (`desktop` | `portrait` | `landscape` | `tablet-square`).

#### 3.3.1 Mobile Portrait Layout

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

#### 3.3.2 Mobile Landscape & Tablet/Square Layout

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
  role:       "user" | "assistant" | "system"
  content:    string
  metadata: {
    model?:      string           // e.g., "gpt-4o"
    provider?:   string           // e.g., "openai"
    selection?:  { from: number, to: number }  // text selection context
    action?:     string           // e.g., "rewrite", "expand"
  }
  createdAt:  ISO8601
}
```

### 4.4 Provider Config

```
ProviderConfig {
  provider:   "openai" | "gemini" | "anthropic" | "ollama"
  apiKey:     string              // stored in localStorage
  model:      string              // e.g., "gpt-4o", "gemini-2.5-pro"
  baseUrl?:   string              // for Ollama or custom endpoints
  parameters: {
    temperature?: number
    maxTokens?:   number
  }
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

### 6.1 Layout

```
┌─────────────────────────────────────────────────────┐
│  ▪ Web Canvas            [Settings] [History] [Export]│
├──────────────┬──────────────────────────────────────┤
│              │                                      │
│   Chat       │          Document Canvas             │
│   Panel      │                                      │
│   (30%)      │          (70%)                       │
│              │                                      │
│              │                                      │
│              │                                      │
│              │                                      │
│  ┌────────┐  │                                      │
│  │  💬    │  │                                      │
│  └────────┘  │                                      │
├──────────────┴──────────────────────────────────────┤
│  Status bar: Provider: GPT-4o  │  Words: 1,234     │
└─────────────────────────────────────────────────────┘
```

### 6.2 Visual Design Direction

- **Color palette**: Dark mode default with warm accent colors (amber/gold
  for actions, soft greens/reds for diffs).
- **Typography**: `Inter` for UI chrome, `Merriweather` or system serif for
  document body (configurable).
- **Glass effects**: Frosted glass on the chat panel overlay (when floating).
- **Animations**: Smooth panel resize, fade-in for streamed text, subtle
  pulse on the "thinking" indicator.

### 6.3 Interaction Patterns

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

---

## 7. Technology Choices

> These are recommendations. Final choices will be confirmed during implementation.

| Concern | Recommendation | Alternatives |
|---------|---------------|-------------|
| Framework | **Vite + React** | Next.js (if SSR needed later) |
| Language | **TypeScript** | — |
| Rich text editor | **TipTap** (ProseMirror-based) | Lexical, Slate |
| Styling | **Vanilla CSS** (CSS variables + modules) | Tailwind (if requested) |
| State management | **Zustand** | Jotai, Redux Toolkit |
| LLM streaming | **Fetch API + ReadableStream** | Vercel AI SDK |
| Persistence | **localStorage** (v1) | IndexedDB (large docs) |
| Testing | **Vitest + Playwright** | Jest, Cypress |
| Deployment | **Vercel / Netlify** (static) | GitHub Pages |

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

