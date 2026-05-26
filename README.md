# Web Canvas (a_better_llm_canvas)

An advanced, LLM-powered collaborative document editing workspace. Inspired by OpenAI Canvas, Web Canvas allows writers to draft, structure, and refine multi-chapter books or documentation side-by-side with an LLM chat assistant.

---

## 🌟 Key Features

### 1. **Inline AI Document Editing & Diffs**
*   **Selection-Aware Editing**: Highlight any section of your draft to request target modifications from the AI.
*   **Inline Diff View**: Real-time visual additions (green) and deletions (red) rendered directly in the editor. Accept or reject modifications on a per-change basis.
*   **Quick Action Selection Bar**: Instant options to polish, shorten, extend, or explain selected texts.

### 2. **Multi-User Secure Authentication**
*   **Registration & Login**: Full user registration with password-strength checking.
*   **Secure Session Management**: Protected using secure, `HttpOnly`, `SameSite=Lax` cookies.
*   **CSRF Protection**: Form actions validated via Double Submit Cookie CSRF tokens.

### 3. **User-Isolated Server Workspace Storage**
*   **Workspace Sync**: Automatic or manual sync between local browser storage and server-side state.
*   **Multi-User Isolation**: Automatic isolation of workspaces (saved securely on the server as `state_<username>.json`).
*   **Automatic Conflict Resolution**: Interactive UI prompt to resolve content discrepancies between local browser cache and server storage.

### 4. **Mobile & Cross-Device Optimization (M7)**
*   **Adaptive Layouts**: Responsive grids dynamically rearranging panels for Desktop, Tablet-Square, Landscape, and Portrait aspect ratios.
*   **Compact Mobile Header**: Hides heavy selectors (Model, System Prompts) on portrait mobile screens, consolidating those selections cleanly inside the Settings Modal.
*   **Viewport Containment**: Enforced viewport rules (`100%` bounds) preventing layout overflows and elastic bounces across mobile browsers.

### 5. **Multi-Provider LLM Integration**
*   Robust support for leading LLM providers:
    *   **Google Gemini** (Gemini 2.5 Flash / Pro, Gemini 1.5)
    *   **OpenAI** (GPT-4o, GPT-4o-mini, o1)
    *   **Anthropic Claude** (Claude 3.5 Sonnet / Haiku, Opus)
    *   **Grok** by xAI (Grok-3, Grok-2)
    *   **Ollama** (llama3, mistral, gemma2, phi3)
*   Dynamic local model detection and custom base API URLs.

### 6. **Multi-Document & Version History**
*   **Chapters Manager**: Organize chapters or sections in a collapsible sidebar.
*   **Auto-Save & Snapshotting**: Create manual or automated snapshots and restore past versions.
*   **Import / Export**: Import from `.md`, `.html`, or `.txt`. Export documents to Markdown, raw HTML, or plain text.

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have **Node.js** (v18+) and **npm** installed.

### 2. Installation
Clone the repository and install the dependencies:
```bash
git clone git@github.com:hongdp/a_better_llm_canvas.git
cd a_better_llm_canvas
npm install
```

### 3. Environment Setup
Create a `.env` file in the root directory (you can copy `.env.example` as a starting template):
```bash
cp .env.example .env
```
Provide API keys for your preferred LLM providers (e.g., `VITE_GEMINI_API_KEY`, `VITE_OPENAI_API_KEY`).

### 4. Run the Development Server
Run the application locally:
```bash
npm run dev
```

To run with a **custom server-side storage path** (for multi-user states and local persistence) and expose the port to your internal network, pass the storage directory parameters:
```bash
npm run dev -- --storage-dir /path/to/your/workspace --host
```

### 5. Build for Production
Bundle the production client:
```bash
npm run build
```

---

## 🛠 Tech Stack
*   **Frontend**: React (TypeScript), Vite, TailwindCSS (for modular helper utilities), Lucide React (Icons).
*   **Editor Engine**: TipTap / ProseMirror.
*   **State Management**: Zustand.
*   **Server Middleware**: Express-style middleware configured inside `vite.config.ts` for database state persistence and authentication endpoints.
