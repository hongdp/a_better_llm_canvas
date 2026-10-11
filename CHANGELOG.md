# Changelog

## 1.0.0 — 2026-10-11

The first installable release. Download `web_canvas-1.0.0.tar.gz` from the
GitHub release; it needs Python only (see the README).

### The assistant

- Agentic chat turns: the model reads, greps and lists the book, plans,
  writes, renames and creates chapters through tools, asks questions, and can
  be steered mid-turn. Edits arrive as reviewable diffs; every turn is
  snapshotted first.
- Turns can run on the server, survive reloads, restarts and device changes,
  and pause rather than die when they loop or run long.
- Pinned context: the chapters you pin ride with every request; the model
  reads the rest itself.
- Each request extends the previous one (turn transcripts replayed, context
  sent as differences, a frozen ledger, summaries made from the live
  conversation), so prompt caches keep hitting across turns.
- Reference attachments (long `.txt` files read in sections) and web search /
  page reading (with Playwright).

### Providers

- Anthropic: adaptive thinking with an effort level on Claude Opus 4.6+ and
  every 5.x model (they refuse a token budget), a budget on 4.5 and earlier;
  thinking streams live; refusals and in-stream errors are reported.
- OpenAI: models at api.openai.com run on the Responses API (from gpt-5.4 on,
  Chat Completions refuses tools with reasoning); reasoning carried across
  steps and turns; non-strict tools. Compatible servers stay on Chat
  Completions.
- Gemini: Gemini 3 models (2.5 is closed to new keys), thinking levels,
  thoughts streamed as reasoning, SSE streaming, the key kept out of URLs.
- Grok on the xAI Responses API; Ollama, llama.cpp and RunPod endpoints.
- Model lists come from your key (through the server); reasoning effort is
  resolved per model on the server.
- Generation always runs on the server; the in-browser transport is gone.

### Workspace

- Settings belong to the user; each book remembers its provider, model,
  effort and system-prompt preset.
- Chapter summaries are no longer used: the chapter index lists chapters by
  number and title (stale summaries had been copied between books).

### Installing and running

- `python3 scripts/api_server.py --serve-dist` serves the built app and the
  API from one process, optionally over HTTPS (`--ssl-certfile`,
  `--ssl-keyfile`).
- `requirements.txt` / `requirements-dev.txt` for the server.
- `npm run release` builds the archive from a clean export with no `.env`
  and refuses a bundle containing anything shaped like an API key.
- A fresh clone builds without a local development certificate.
