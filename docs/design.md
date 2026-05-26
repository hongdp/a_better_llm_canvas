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
- [ ] Selection-aware prompting (send selected text as context)
- [ ] Diff rendering in the editor (additions/deletions)
- [ ] Accept / reject per-change
- [ ] Quick action toolbar on text selection

### M4 — Polish & History (Week 4)
- [ ] Version history manager (snapshots, restore)
- [ ] Auto-save to localStorage
- [ ] Export to Markdown / plain text / HTML
- [ ] Settings panel (provider config, model selection, theme)
- [ ] Responsive layout for tablet/mobile

### M5 — Multi-Provider & Beyond (Week 5+)
- [ ] Gemini provider
- [ ] Anthropic provider
- [ ] Ollama provider
- [ ] Import from file
- [ ] Keyboard shortcuts
- [ ] PDF export

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
| 2026-05-25 | LLM Debug Mode & Credential Masking | Implemented a developer toggle in Settings to console-log raw LLM API requests and responses, with robust credential masking filters matching secure coding principles. |
