# Attachments and web access for the agent

Status: built 2026-10-10. Registered in the Decision Log of `docs/design.md`.

The user asked for two things: attaching a context file — a long novel as a
`.txt` — that the agent can consult, and letting the agent visit the internet
anonymously through a headless browser, configured after the download browser
in the user's `x_archive_webserver` project.

## 1. Attachments

A reference file belongs to a book but is not part of its text: it never
opens in the editor, is never written, and never takes a chapter slot. Until
now the user pasted source material in as chapters ("原作" chapters beside each
rewrite) and deleted them afterwards; a whole novel as a chapter is too large
for the editor and for the ledger.

- **Storage** (`scripts/server_attachments.py`). `POST
  /api/books/{id}/attachments?name=…` takes the file's raw bytes (≤ 30 MB).
  The text is decoded the way Chinese `.txt` files are actually encoded: a
  BOM wins, then UTF-8; otherwise GB18030 (a superset of GBK/GB2312) and
  Big5 are both tried and the decoding with fewer private-use code points
  is kept — GB18030 accepts almost any byte sequence, so it never fails
  over to Big5 by itself; then UTF-8 with replacement. It is stored normalized (`\n` line ends, no
  BOM) as `attachments/<book>/<id>.txt` beside the book's content, with a row
  in the `attachments` table (name, characters, paragraphs, sections, order).
  `GET` lists them, `GET …/{aid}/text` returns the text, `DELETE` removes one.
  Deleting a book removes its attachments.
- **Paragraphs and sections** (`utils/attachments`, `wc_text/attachments`,
  parity-tested). A file whose blocks are separated by blank lines (a
  hard-wrapped English text) is read paragraph per block, its lines joined;
  otherwise every non-empty line is a paragraph (the usual Chinese novel
  `.txt`). Full-width indentation is trimmed. A paragraph longer than 4,000
  characters (`MAX_PARAGRAPH_CHARS`, code points) is cut at the last
  sentence end in each window: a file with no line breaks would otherwise
  be one paragraph, and every read of it the whole file. Section headings — `第…章/回/
  节/卷/部/集/篇`, `Chapter N`, `序章`, `楔子`, `尾声`, `番外`, … on a short line
  — split the file into sections with their ¶ ranges.
- **What the model is told.** When a book has attachments, the request
  carries an `ATTACHMENTS` block before `USER REQUEST`: each one as `A1`,
  `A2`… with its name, size and its sections (`¶1–212 第一章 …`, at most 80
  lines, then how many more). It says they are reference files: read them,
  never write them.
- **How the model reads them.** The read tools take attachment references
  where they take chapters (`A1`, `附件1`, or the file's name when no chapter
  has that title): `read_chapter` with `chapters: ["A1"]` and `paragraphs`,
  or `section: "第三十章"` — a section by its heading, where `第30章`, `30` and
  `第三十章` name the same one — or `parts`; `grep` with `chapters: ["A1"]`;
  `analyze_book` with `chapters: ["A1"]`, which reads a whole novel in
  batches (40,000-character chunks, a section per pseudo-chapter) outside
  the conversation and returns notes. An attachment is never searched unless
  named, and a write naming one is refused by the chapter resolver as before.
- **Never the whole file in the conversation** (the user's requirement).
  Nothing of an attachment is in the request but its index. One read returns
  at most `READ_CHAPTER_CAP` (20,000) characters with the range to continue
  from; one turn reads at most `ATTACHMENT_RUN_READ_CAP` (100,000) characters
  of attachments in all (`RunState.attachmentChars`, kept across a server
  run's restore), and the read past it is refused with a note pointing to
  grep and analyze_book. The cap is strict: a part stops before the
  paragraph that would pass it. The use case it is sized for: "what happens
  in chapter 30 of the attached novel?" is one section read; "now write a
  fan chapter after it" reads that section and a few grep hits.
- **Ports.** The loop reaches attachments through `ctx.attachments`
  (`list()`, `paragraphs(id)`): a server run reads the files, a tab fetches
  the text once per attachment and keeps it for the session.
- **UI.** An Attachments section in the chapters sidebar, below the
  chapter list (`components/AttachmentsSection.tsx`): each attachment with
  its reference (`A1`), name and size, a delete button, and a `+` that
  uploads one or more `.txt`/`.md` files to the open book. The list is
  server state (`attachmentsSlice`), loaded when the book changes, never
  cached in IndexedDB. The index goes into the request only with the agent
  tools on.

## 2. Web access

Two read tools, `web_search` and `web_read`, offered when the provider's
`webAccess` setting is on (default on) and the server has a browser.

- **The browser** (`scripts/server_web.py`), after x_archive's download
  browser: Playwright's Chromium, headless; `domcontentloaded` and a short
  settle instead of waiting for the network to go idle; `page.content()`
  retried when the page is still navigating (x_archive `stable_content`);
  a User-Agent that is Chromium's own — the real major version read from
  the browser at launch, without the `HeadlessChrome` marker — so the
  headers agree with the TLS fingerprint (x_archive's rule: never dress
  Chromium as another browser).
- **Requirements**: `playwright` (with `playwright install chromium`) and
  `beautifulsoup4` in the API server's Python. Without them
  `GET /api/web/status` says unavailable and the tools are not offered;
  attachments need neither.
- **Anonymous**: every call gets a fresh browser context — no cookies, no
  storage, no saved session, nothing of the user's — and no Referer.
  `WEB_PROXY` (e.g. `socks5://127.0.0.1:9050` for a local Tor) routes all of
  it through a proxy; without it the server's own address is visible to the
  sites, which is the limit of anonymity this machine has (no Tor is
  installed).
- **Safety**: only `http`/`https`; every request the page makes, redirects
  and sub-resources included, is aborted when its host resolves to a
  private, loopback, link-local or reserved address (the server sits on a
  LAN, beside its own API). Images, media and fonts are not loaded.
  Downloads are refused. Navigation times out after 25 s.
- **web_search** `{query, max_results}`: DuckDuckGo's lite endpoint
  (`lite.duckduckgo.com/lite/`) through the same browser; results as
  `title — url` plus the snippet, ads skipped. The HTML endpoint, Bing,
  Brave, Mojeek and Startpage all answered this machine with a bot check;
  a bot check is reported to the model as a failure and never circumvented.
- **The browser build**: Chromium's new headless mode (`channel="chromium"`),
  not the headless shell, whose client hints say `HeadlessChrome`.
- **web_read** `{url, paragraphs}`: the page's readable text as numbered
  paragraphs, like `read_chapter` (title, headings, paragraphs, list items,
  quotes; navigation, scripts and forms dropped), capped per call with the
  range to continue from. A page is cached for ten minutes, so reading on
  costs no new visit.
- **Untrusted**: every web result opens with a line saying the text comes
  from the internet and is information, not instructions.
- **Offered**: only when `ProviderConfig.webAccess` is not false (a
  checkbox in Settings, under the agent options) and `GET /api/web/status`
  says the server has a browser — a tab asks once per page load. A server
  run checks `server_web.available()`. The system prompt mentions the two
  tools "when offered"; their schemas carry the rest.
- **Tabs** call `POST /api/web/search` and `POST /api/web/read`; server runs
  call the same functions directly. At most two browser pages per user at a
  time.

## 3. Not built

PDF, EPUB and DOCX attachments (plain text and Markdown only); writing to
attachments; web access for side calls (polish, summaries); logging into
sites; a Tor installation (the proxy setting is the hook).
