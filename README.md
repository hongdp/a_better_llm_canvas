# Web Canvas (a_better_llm_canvas)

A self-hosted writing workspace where an LLM works on your book with you.
A rich-text editor (the canvas) sits beside a chat assistant that can read,
search and edit every chapter of a multi-chapter book, with each change shown
as a reviewable diff you can accept, reject or undo.

---

## Features

- **An assistant that works on the whole book.** Each chat turn is a run of
  steps: the model reads chapters, greps the book, lists what is there, plans,
  and writes, rewrites, renames or creates chapters through tools. It can ask
  you a question mid-turn, and you can steer a running turn by sending another
  message.
- **Reviewable edits.** Changes stream into the editor as inline diffs (green
  added, red removed), accepted or rejected per change. Every turn snapshots
  the book first, and version history restores any earlier state.
- **Turns that outlive the tab.** A turn can run on the server: close the
  browser, reload, or open the book on another device and the run continues
  and is rejoined. Long or looping runs pause instead of being killed.
- **Context you control, cache-friendly by design.** Pin the chapters the
  model should always have (an outline, a character sheet); it reads the rest
  itself. Each request extends the previous one, so the provider's prompt
  cache keeps hitting across turns, and history past the window is summarized
  rather than cut.
- **Reference files and the web.** Attach a long `.txt` (a source novel) to a
  book and the model reads it in sections; with Playwright installed it can
  also search and read web pages.
- **Many providers.** Anthropic Claude, OpenAI, Google Gemini, xAI Grok, and
  local or rented OpenAI-compatible servers (Ollama, llama.cpp, RunPod). Model
  lists come from your key; reasoning effort is set per model.
- **Per-user workspace.** Accounts with secure sessions; each user's books,
  settings and keys are kept apart on the server. Each book remembers the
  provider, model, effort and system-prompt preset it uses.
- **Also:** selection-aware rewrites, a polish pass, import from URLs or
  `.md` / `.html` / `.txt` files, export to Markdown / HTML / text, a roleplay
  game-master mode, image generation, light and dark themes, and layouts for
  desktop, tablet and phone (installable as a PWA).

---

## Install from a release

A release archive contains the source and the built frontend, so it needs
**Python 3.10+** only.

1. Download `web_canvas-<version>.tar.gz` from
   [Releases](https://github.com/hongdp/a_better_llm_canvas/releases) and
   check it against the `.sha256` file:
   ```bash
   sha256sum -c web_canvas-1.0.0.tar.gz.sha256
   tar xzf web_canvas-1.0.0.tar.gz && cd web_canvas-1.0.0
   ```
2. Install the server's dependencies (a virtual environment is recommended):
   ```bash
   python3 -m venv .venv && . .venv/bin/activate
   pip install -r requirements.txt
   ```
3. Start it. One process serves both the app and its API:
   ```bash
   python3 scripts/api_server.py --serve-dist --port 8080 --storage-dir ./storage
   ```
4. Open <http://localhost:8080>, create an account, and add your API keys
   under **Settings**. Keys are stored with your account on the server.

Optional: for the model's web search and page reading,
`pip install playwright && python -m playwright install chromium`.

### Using it from other devices

Sessions use `Secure` cookies, which browsers accept over HTTPS or on
`localhost` only. To reach the server from another device, serve HTTPS:

```bash
# A self-signed certificate: list every host name / IP you will browse to
# under [alt] in certs/san.cnf first.
openssl req -x509 -newkey rsa:2048 -nodes -keyout certs/server-key.pem \
  -out certs/server-cert.pem -days 825 -config certs/san.cnf
python3 scripts/api_server.py --serve-dist --host 0.0.0.0 --port 8443 \
  --ssl-certfile certs/server-cert.pem --ssl-keyfile certs/server-key.pem
```

Or put the server behind a reverse proxy that terminates TLS. Running it as a
service, logs, and troubleshooting: [docs/deployment.md](docs/deployment.md).

### Server options

| Option | Default | |
|---|---|---|
| `--storage-dir DIR` | `$VITE_STORAGE_DIR`, else `./storage` | Books, accounts and sessions |
| `--host` / `--port` | `127.0.0.1` / `3000` | Where to listen |
| `--serve-dist [DIR]` | off (`dist/` when given bare) | Also serve the built app |
| `--ssl-certfile` / `--ssl-keyfile` | none | Serve HTTPS |

The metadata database lives in `.local_db/metadata.db` in the install
directory (keep it on a local disk, not a network mount).

---

## Develop from source

Needs **Node.js 20+** and **Python 3.10+**.

```bash
git clone https://github.com/hongdp/a_better_llm_canvas.git
cd a_better_llm_canvas
npm ci                                  # also wires the pre-push test hook
pip install -r requirements-dev.txt
cp .env.example .env                    # optional defaults (see below)
npm run dev                             # API on :3000 + Vite on :5173 (proxying /api)
```

`npm run dev -- --storage-dir /path/to/storage --host` uses another storage
directory and listens on the network. The Vite dev server uses HTTPS when
`certs/dev-cert.pem` and `certs/dev-key.pem` exist, plain HTTP otherwise.

`.env` holds optional defaults for a new user's settings (`VITE_*_MODEL`,
`VITE_*_BASE_URL`, `VITE_STORAGE_DIR`). A `VITE_*_API_KEY` there is built into
the frontend bundle, so set keys in the app's Settings for anything that is
not your own machine — and never build a bundle you share with keys in
`.env` (`npm run release` refuses to).

| Command | |
|---|---|
| `npm run dev` | Full stack with hot reload |
| `npm test` | Frontend tests (Vitest) |
| `cd scripts && python3 -m pytest -q` | Backend tests, incl. TypeScript↔Python parity |
| `npm run lint` · `npm run build` | ESLint · type-check and build `dist/` |
| `npm start` | Serve `dist/` and the API from one process |
| `npm run release` | Build `release/web_canvas-<version>.tar.gz` from `HEAD` |

Architecture, decisions and feature specs: [docs/design.md](docs/design.md)
and [docs/features/](docs/features/). Working conventions:
[CLAUDE.md](CLAUDE.md) and [SKILL.md](SKILL.md).

---

## Tech stack

- **Frontend:** React 19, TypeScript, Vite, Zustand, TipTap / ProseMirror,
  lucide-react; plain CSS with light and dark themes.
- **Backend:** Python, FastAPI and Uvicorn; SQLite for metadata, files for
  chapter content. Generation and agent turns run server-side and stream to
  the browser over SSE.

---

## License

GNU General Public License v3.0 (GPL-3.0) — see [LICENSE](LICENSE).
