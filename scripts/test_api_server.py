import pytest
from unittest.mock import patch, MagicMock
import sys
import os

# Add scripts directory to path to import api_server and its sibling modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import api_server
import server_auth
import server_db
import server_generation
from server_scrape import _parse_html_to_scraped_data

# NOTE: patches must target the module that OWNS the state the executing code
# reads (server_scrape.http_requests, server_db.DB_PATH, server_auth.SESSIONS_FILE).
# Patching a name re-exported on api_server would not affect those code paths.

def test_extract_various_image_attributes():
    html_content = """
    <html>
        <head><title>Test Page</title></head>
        <body>
            <p>Some text content to create a paragraph.</p>
            <!-- t66y style -->
            <img ess-data="https://example.com/image.webp" iyl-data="http://a.d/adblo_ck.jpg" referrerpolicy="no-referrer">
            <!-- standard src -->
            <img src="https://example.com/image2.jpg">
            <!-- lazy load data-src -->
            <img data-src="https://example.com/image3.png">
            <!-- empty/invalid img -->
            <img title="no src">
        </body>
    </html>
    """
    
    with patch("server_scrape.http_requests.get") as mock_get:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {"Content-Type": "image/jpeg"}
        mock_resp.iter_content.return_value = [b"fake_image_data_that_is_short"]
        mock_get.return_value = mock_resp
        
        result = _parse_html_to_scraped_data(html_content, "https://example.com/")
        
        assert result["title"] == "Test Page"
        assert result["totalParagraphs"] == 1
        assert result["totalImages"] == 3
        
        # Verify that http_requests.get was called with the correct URLs extracted from different attributes
        called_urls = [call.args[0] for call in mock_get.call_args_list]
        assert "https://example.com/image.webp" in called_urls
        assert "https://example.com/image2.jpg" in called_urls
        assert "https://example.com/image3.png" in called_urls

def test_extract_inline_base64_image():
    html_content = """
    <html>
        <body>
            <p>Paragraph</p>
            <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=">
        </body>
    </html>
    """
    with patch("server_scrape.http_requests.get") as mock_get:
        result = _parse_html_to_scraped_data(html_content, "https://example.com/")
        
        assert result["totalImages"] == 1
        # Should not make any network requests for base64 inline images
        mock_get.assert_not_called()
        
        img = result["images"][0]
        assert img["base64"].startswith("data:image/png;base64,")



def test_init_db_migrates_summary_columns(tmp_path):
    """A pre-summary database gains the summary columns on init_db, and
    existing rows survive with NULL summaries."""
    db_file = tmp_path / "metadata.db"

    # Build the OLD schema (documents without summary columns) + one row.
    import sqlite3
    conn = sqlite3.connect(str(db_file))
    conn.executescript("""
        CREATE TABLE books (
            id TEXT NOT NULL, username TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'Untitled Book',
            active_document_id TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY (username, id)
        );
        CREATE TABLE documents (
            id TEXT NOT NULL, username TEXT NOT NULL, book_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT 'Untitled Chapter',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY (username, book_id, id)
        );
    """)
    conn.execute(
        "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at) VALUES ('d1', 'u', 'b', 'Ch 1', 0, 't', 't')"
    )
    conn.commit()
    conn.close()

    with patch.object(server_db, "DB_PATH", str(db_file)):
        server_db.init_db()

        conn = server_db.get_db()
        try:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(documents)").fetchall()}
            assert "summary" in cols
            assert "summary_content_hash" in cols

            row = conn.execute("SELECT * FROM documents WHERE id = 'd1'").fetchone()
            assert row["summary"] is None

            # Round-trip: a summary written the way update_document writes it.
            conn.execute(
                "UPDATE documents SET summary = ?, summary_content_hash = ? WHERE id = 'd1'",
                ("A short summary.", "abc123"),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM documents WHERE id = 'd1'").fetchone()
            assert row["summary"] == "A short summary."
            assert row["summary_content_hash"] == "abc123"
        finally:
            conn.close()

        # Idempotent: running init_db again must not fail on existing columns.
        server_db.init_db()


def test_get_book_returns_document_metadata_with_summaries(tmp_path, monkeypatch):
    """GET /api/books/{id} must not 500 on the document metadata SELECT.

    Regression: the response reads d["summary"] / d["summary_content_hash"],
    but the SELECT listed only id/title/sort_order/created_at/updated_at.
    sqlite3.Row raises IndexError for an unselected column, so every book
    switch returned 500 and the UI silently refused to change books.
    """
    import asyncio
    import json as _json
    from datetime import datetime, timedelta, timezone
    from starlette.requests import Request

    monkeypatch.setattr(server_db, "DB_PATH", str(tmp_path / "metadata.db"))
    monkeypatch.setattr(server_auth, "SESSIONS_FILE", str(tmp_path / "sessions.json"))
    server_db.init_db()

    now = datetime.now(timezone.utc).isoformat()
    conn = server_db.get_db()
    try:
        conn.execute(
            "INSERT INTO books (id, username, title, active_document_id, created_at, updated_at)"
            " VALUES ('book-1', 'alice', 'My Book', 'doc-1', ?, ?)",
            (now, now),
        )
        conn.execute(
            "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at,"
            " summary, summary_content_hash)"
            " VALUES ('doc-1', 'alice', 'book-1', 'Chapter 1', 0, ?, ?, 'A short summary.', 'hash-1')",
            (now, now),
        )
        # A chapter that was never summarized must still come back (NULL columns).
        conn.execute(
            "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at)"
            " VALUES ('doc-2', 'alice', 'book-1', 'Chapter 2', 1, ?, ?)",
            (now, now),
        )
        conn.commit()
    finally:
        conn.close()

    expires = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    with open(server_auth.SESSIONS_FILE, "w", encoding="utf-8") as f:
        _json.dump({"sess-1": {"username": "alice", "expiresAt": expires}}, f)

    request = Request({
        "type": "http",
        "method": "GET",
        "path": "/api/books/book-1",
        "headers": [(b"cookie", b"web_canvas_session=sess-1")],
        "query_string": b"",
    })

    result = asyncio.run(api_server.get_book(request, "book-1"))

    assert result["bookTitle"] == "My Book"
    assert [d["id"] for d in result["documents"]] == ["doc-1", "doc-2"]
    assert result["documents"][0]["summary"] == "A short summary."
    assert result["documents"][0]["summaryContentHash"] == "hash-1"
    assert result["documents"][1]["summary"] is None


# ==============================================================================
# Resumable generation jobs (docs/features/resumable_generation.md)
#
# The HTTP layer is stubbed by patching server_generation._http_stream — the
# module that OWNS it. Patching an alias elsewhere would not affect the
# executing code.
# ==============================================================================

import asyncio
import json as _json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from starlette.requests import Request as _StarletteRequest

from fastapi import HTTPException


@pytest.fixture(autouse=True)
def _clean_generation_registry():
    server_generation.registry.clear()
    yield
    server_generation.registry.clear()


class _FakeStreamResponse:
    """Stands in for an httpx streaming response."""

    def __init__(self, status_code=200, lines=None, text_chunks=None, error_body=b""):
        self.status_code = status_code
        self._lines = lines or []
        self._text_chunks = text_chunks or []
        self._error_body = error_body

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        for chunk in self._text_chunks:
            yield chunk

    async def aread(self):
        return self._error_body


def _stub_http_stream(captured, response):
    @asynccontextmanager
    async def fake_stream(url, headers, body):
        captured.append({"url": url, "headers": headers, "body": body})
        yield response
    return fake_stream


def _run_job(job, provider, config, messages, response, captured):
    with patch.object(server_generation, "_http_stream", _stub_http_stream(captured, response)):
        asyncio.run(server_generation.run_job(job, provider, config, messages))


def _new_job(username="alice", meta=None):
    return server_generation.GenerationJob("gen-test", username, meta or {})


def _sse_payloads(chunks):
    """Parse rendered SSE frames into event dicts, dropping keep-alives."""
    events = []
    for chunk in chunks:
        for line in chunk.splitlines():
            if line.startswith("data: "):
                events.append(_json.loads(line[6:]))
    return events


# ── Registry lifecycle ────────────────────────────────────────────────────────

class _FakeRequest:
    """Minimal stand-in: the models endpoint only reads auth + the JSON body."""
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


@pytest.fixture
def _stub_models_auth(monkeypatch):
    """Auth is covered by its own tests; these exercise the listing logic.
    NOT autouse — patching it module-wide broke the cross-user 404 test."""
    monkeypatch.setattr(server_generation, "get_authenticated_username", lambda request: "alice")


def test_models_endpoint_normalizes_both_dialects(monkeypatch, _stub_models_auth):
    """The browser cannot reach a plain-http local endpoint from an HTTPS page
    (mixed content), so the backend lists models on its behalf."""
    from contextlib import asynccontextmanager

    class _Resp:
        def __init__(self, payload):
            self._payload = payload
        def raise_for_status(self):
            pass
        def json(self):
            return self._payload

    async def run(payload):
        captured = {}

        class _Client:
            def __init__(self, **kw):
                pass
            async def __aenter__(self):
                return self
            async def __aexit__(self, *a):
                return False
            async def get(self, url):
                captured["url"] = url
                return _Resp(payload)

        monkeypatch.setattr(server_generation.httpx, "AsyncClient", _Client)
        request = _FakeRequest({"baseUrl": "http://127.0.0.1:8090/v1"})
        result = await server_generation.list_provider_models(request)
        return result, captured

    # Ollama's own shape.
    result, captured = asyncio.run(run({"models": [{"name": "qwen3.8-27b-uncensored"}]}))
    assert result == {"models": ["qwen3.8-27b-uncensored"]}
    assert captured["url"] == "http://127.0.0.1:8090/v1/models"

    # OpenAI's shape.
    result, _ = asyncio.run(run({"data": [{"id": "local-a"}, {"id": "local-b"}]}))
    assert result == {"models": ["local-a", "local-b"]}


def test_models_endpoint_refuses_non_local_hosts(_stub_models_auth):
    """Without this the endpoint is an open SSRF proxy: the caller picks the URL."""
    for base in ("http://evil.example.com/v1", "https://169.254.169.254/latest", "file:///etc/passwd"):
        with pytest.raises(HTTPException) as exc:
            asyncio.run(server_generation.list_provider_models(_FakeRequest({"baseUrl": base})))
        assert exc.value.status_code == 400


def test_models_endpoint_reports_an_unreachable_server_as_empty(_stub_models_auth):
    """No local server running is the normal case, not an error."""
    class _Boom:
        def __init__(self, **kw):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url):
            raise OSError("connection refused")

    original = server_generation.httpx.AsyncClient
    server_generation.httpx.AsyncClient = _Boom
    try:
        result = asyncio.run(server_generation.list_provider_models(
            _FakeRequest({"baseUrl": "http://127.0.0.1:9999/v1"})
        ))
    finally:
        server_generation.httpx.AsyncClient = original
    assert result == {"models": []}


def test_generation_job_lifecycle_buffers_and_finishes():
    job = server_generation.registry.create("alice", {"kind": "chat"})
    assert job.status == "running"
    assert job.summary()["meta"] == {"kind": "chat"}

    job.append("Hello ")
    job.append("world")
    assert job.buffer == "Hello world"
    assert job.length == 11
    assert job.summary()["length"] == 11

    job.finish("done", usage={"promptTokens": 10, "completionTokens": 3})
    assert job.status == "done"
    assert job.finished_at is not None
    assert job.terminal_event() == {
        "type": "done",
        "offset": 11,
        "usage": {"promptTokens": 10, "completionTokens": 3},
        "status": "done",
        "truncatedBuffer": False,
    }

    # Terminal state is sticky and the buffer stays readable.
    assert job.finish("error", error="late") is False
    job.append("ignored")
    assert job.buffer == "Hello world"


def test_app_logging_lets_info_through_uvicorns_warning_root():
    """uvicorn.run(log_level="warning") sets the ROOT logger to WARNING, so
    every logger.info in this app was dropped — including the one number that
    diagnoses a slow first token."""
    import logging
    import sys
    import api_server

    app_logger = logging.getLogger("web_canvas")
    prior_level, prior_handlers = app_logger.level, list(app_logger.handlers)
    app_logger.handlers.clear()
    try:
        logging.getLogger().setLevel(logging.WARNING)   # what uvicorn does
        api_server._configure_app_logging()

        assert app_logger.isEnabledFor(logging.INFO)
        assert app_logger.handlers, "own handler required — the root has none at INFO"
        # A piped stdout is block-buffered: without line buffering the lines
        # sit in an 8KB buffer and never reach app.log.
        assert sys.stdout.line_buffering or app_logger.handlers[0].stream is sys.stderr
        # Not double-logged through whatever uvicorn installs on the root.
        assert app_logger.propagate is False
        # Child loggers (server_generation) inherit the raised level.
        assert logging.getLogger("web_canvas.generation").isEnabledFor(logging.INFO)
    finally:
        app_logger.handlers[:] = prior_handlers
        app_logger.setLevel(prior_level)


def test_generation_records_time_to_first_token_once():
    """The one number that separates provider prefill from our own latency."""
    job = server_generation.registry.create("alice", {})
    assert job.first_delta_latency is None

    job.append("first")
    latency = job.first_delta_latency
    assert latency is not None and latency >= 0

    # Later deltas must not overwrite it — it is time to FIRST token.
    job.append("second")
    assert job.first_delta_latency == latency

    # An empty delta is not a token.
    fresh = server_generation.registry.create("alice", {})
    fresh.append("")
    assert fresh.first_delta_latency is None


def test_generation_buffer_cap_marks_truncated_but_keeps_streaming():
    job = _new_job()
    cap = server_generation.MAX_BUFFER_CHARS
    job.append("a" * (cap - 5))
    assert job.truncated_buffer is False

    job.append("b" * 20)
    assert job.truncated_buffer is True
    assert len(job.buffer) == cap
    # Live subscribers still advance: total length counts every produced char.
    assert job.length == cap + 15
    assert job.summary()["truncatedBuffer"] is True


# ── Replay from an offset ─────────────────────────────────────────────────────

def test_generation_stream_announces_itself_before_any_token():
    """Headers flush with the first body chunk, so a slow model used to leave
    the client with 15s of dead air (SSE_HEARTBEAT_SECONDS) and no way to tell
    a live stream from a stalled one."""
    async def scenario():
        job = server_generation.registry.create("alice", {})
        job.append("late text")
        job.finish("done")
        return [ev async for ev in server_generation._job_event_stream(job, 0)]

    events = _sse_payloads(asyncio.run(scenario()))
    assert events[0] == {"type": "attached", "offset": 0, "status": "done"}
    # The announcement carries no text and advances no offset.
    assert events[1] == {"type": "delta", "text": "late text", "offset": 9}


def test_generation_stream_survives_a_reasoning_event():
    """Regression: the reader treated every non-delta event as terminal, so the
    FIRST reasoning delta closed the stream. The job kept generating while every
    client reported "disconnected before completion"."""
    async def scenario():
        job = server_generation.registry.create("alice", {})
        stream = server_generation._job_event_stream(job, 0)
        seen = [await anext(stream)]            # attached
        job.note_reasoning("weighing options")
        seen.append(await anext(stream))        # reasoning — must NOT end it
        job.append("Answer")
        seen.append(await anext(stream))        # the stream is still live
        job.finish("done")
        seen.append(await anext(stream))
        await stream.aclose()
        return seen

    events = _sse_payloads(asyncio.run(scenario()))
    assert [e["type"] for e in events] == ["attached", "reasoning", "delta", "done"]
    assert events[1]["text"] == "weighing options"
    assert events[2] == {"type": "delta", "text": "Answer", "offset": 6}


def test_generation_stream_replay_has_no_duplicates_and_no_gaps():
    """A reader that dies mid-stream and re-attaches at its last offset sees
    every character exactly once."""
    async def scenario():
        job = server_generation.registry.create("alice", {})
        job.append("Hello ")

        first = server_generation._job_event_stream(job, 0)
        seen = []
        seen.append(await anext(first))          # "attached" announcement
        seen.append(await anext(first))          # replay of "Hello "
        job.append("brave ")
        seen.append(await anext(first))          # live delta
        await first.aclose()                     # tab dies here

        # Generation continues with nobody listening.
        job.append("world")
        job.finish("done", usage={"promptTokens": 1, "completionTokens": 2})

        events = _sse_payloads(seen)
        last_offset = events[-1]["offset"]

        second = server_generation._job_event_stream(job, last_offset)
        rest = [ev async for ev in second]

        return events + _sse_payloads(rest)

    events = asyncio.run(scenario())

    # Every attach announces itself first; the announcement carries no text.
    assert [e["type"] for e in events if e["type"] == "attached"] == ["attached", "attached"]
    deltas = [e for e in events if e["type"] == "delta"]
    assert "".join(d["text"] for d in deltas) == "Hello brave world"
    # Offsets are monotonic and equal the buffer length after each event.
    assert [d["offset"] for d in deltas] == [6, 12, 17]
    assert events[-1] == {
        "type": "done",
        "offset": 17,
        "usage": {"promptTokens": 1, "completionTokens": 2},
        "status": "done",
        "truncatedBuffer": False,
    }


def test_generation_stream_attaching_to_finished_job_replays_everything():
    async def scenario():
        job = server_generation.registry.create("alice", {})
        job.append("done text")
        job.finish("error", error="boom")
        return [ev async for ev in server_generation._job_event_stream(job, 0)]

    events = _sse_payloads(asyncio.run(scenario()))
    assert events[0]["type"] == "attached"
    assert events[1] == {"type": "delta", "text": "done text", "offset": 9}
    assert events[2]["type"] == "error"
    assert events[2]["message"] == "boom"
    assert events[2]["offset"] == 9


def test_generation_stream_from_current_offset_replays_nothing():
    async def scenario():
        job = server_generation.registry.create("alice", {})
        job.append("already rendered")
        job.finish("done")
        return [ev async for ev in server_generation._job_event_stream(job, 16)]

    events = _sse_payloads(asyncio.run(scenario()))
    assert [e["type"] for e in events] == ["attached", "done"]


# ── Abort ─────────────────────────────────────────────────────────────────────

def test_generation_abort_stops_stream_and_keeps_partial_text():
    job = _new_job()
    captured = []

    lines = [
        'data: {"choices":[{"delta":{"content":"partial"}}]}',
        'data: {"choices":[{"delta":{"content":" more"}}]}',
        "data: [DONE]",
    ]

    class _AbortingResponse(_FakeStreamResponse):
        async def aiter_lines(self):
            for line in self._lines:
                yield line
                # The abort endpoint fires between two provider deltas.
                job.abort()

    _run_job(
        job, "openai",
        {"apiKey": "sk-test", "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1"},
        [{"role": "user", "content": "hi"}],
        _AbortingResponse(lines=lines), captured,
    )

    assert job.status == "aborted"
    assert job.buffer == "partial"
    assert job.terminal_event()["status"] == "aborted"


def test_generation_abort_is_idempotent_and_ignores_finished_jobs():
    job = _new_job()
    job.finish("done")
    assert job.abort() is False
    assert job.status == "done"


# ── Retention and eviction ────────────────────────────────────────────────────

def test_generation_finished_jobs_expire_after_retention_window():
    fresh = server_generation.registry.create("alice", {})
    stale = server_generation.registry.create("alice", {})
    running = server_generation.registry.create("alice", {})

    fresh.finish("done")
    stale.finish("done")
    stale.finished_at -= server_generation.FINISHED_JOB_TTL_SECONDS + 1

    server_generation.registry.prune()

    ids = {j.job_id for j in server_generation.registry.list_for_user("alice")}
    assert fresh.job_id in ids
    assert running.job_id in ids
    assert stale.job_id not in ids


def test_generation_evicts_oldest_finished_job_over_the_cap():
    reg = server_generation.registry
    base = server_generation._monotonic()
    jobs = []
    for i in range(server_generation.MAX_JOBS_PER_USER):
        job = reg.create("alice", {"n": i})
        job.finish("done")
        # Deterministic ordering, still inside the retention window.
        job.finished_at = base + i * 0.001
        jobs.append(job)

    newest = reg.create("alice", {"n": "new"})

    ids = {j.job_id for j in reg.list_for_user("alice")}
    assert len(ids) == server_generation.MAX_JOBS_PER_USER
    assert jobs[0].job_id not in ids   # oldest finished evicted
    assert jobs[1].job_id in ids
    assert newest.job_id in ids


def test_generation_never_evicts_a_running_job():
    reg = server_generation.registry
    running = [reg.create("alice", {}) for _ in range(server_generation.MAX_JOBS_PER_USER)]
    extra = reg.create("alice", {})

    # Nothing is evictable, so the cap is exceeded rather than killing work.
    assert len(reg.list_for_user("alice")) == server_generation.MAX_JOBS_PER_USER + 1

    finished = running[0]
    finished.finish("done")
    reg.create("alice", {})

    ids = {j.job_id for j in reg.list_for_user("alice")}
    assert finished.job_id not in ids
    assert extra.job_id in ids
    assert all(j.job_id in ids for j in running[1:])


# ── Per-user isolation ────────────────────────────────────────────────────────

def test_generation_jobs_are_scoped_to_the_creating_user():
    job = server_generation.registry.create("alice", {})
    assert server_generation.registry.get("alice", job.job_id) is job
    assert server_generation.registry.get("bob", job.job_id) is None
    assert server_generation.registry.list_for_user("bob") == []


def test_generation_other_users_job_id_404s(tmp_path, monkeypatch):
    monkeypatch.setattr(server_auth, "SESSIONS_FILE", str(tmp_path / "sessions.json"))
    expires = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
    with open(server_auth.SESSIONS_FILE, "w", encoding="utf-8") as f:
        _json.dump({
            "sess-alice": {"username": "alice", "expiresAt": expires},
            "sess-bob": {"username": "bob", "expiresAt": expires},
        }, f)

    job = server_generation.registry.create("alice", {})

    def _request(session_id, path):
        return _StarletteRequest({
            "type": "http",
            "method": "GET",
            "path": path,
            "headers": [(b"cookie", f"web_canvas_session={session_id}".encode())],
            "query_string": b"",
        })

    # Alice can read her own job.
    response = asyncio.run(server_generation.stream_generation(
        _request("sess-alice", f"/api/generate/{job.job_id}/stream"), job.job_id, 0))
    assert response.media_type == "text/event-stream"
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"

    # Bob must not learn that the job exists.
    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(server_generation.stream_generation(
            _request("sess-bob", f"/api/generate/{job.job_id}/stream"), job.job_id, 0))
    assert excinfo.value.status_code == 404

    with pytest.raises(HTTPException) as excinfo:
        asyncio.run(server_generation.abort_generation(
            _request("sess-bob", f"/api/generate/{job.job_id}/abort"), job.job_id))
    assert excinfo.value.status_code == 404

    # ...and it stays out of his active list.
    assert asyncio.run(server_generation.list_active_generations(_request("sess-bob", "/api/generate/active"))) == []
    active = asyncio.run(server_generation.list_active_generations(_request("sess-alice", "/api/generate/active")))
    assert [j["jobId"] for j in active] == [job.job_id]
    assert job.status == "running"  # bob's abort attempt did nothing


# ── Provider request building (all five providers, stubbed HTTP) ──────────────

def test_generation_openai_request_and_usage():
    job = _new_job()
    captured = []
    lines = [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        "",
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":30,"completion_tokens":2,'
        '"prompt_tokens_details":{"cached_tokens":12}}}',
        "data: [DONE]",
    ]
    _run_job(
        job, "openai",
        {
            "apiKey": "sk-secret", "model": "gpt-4o",
            "baseUrl": "https://api.openai.com/v1", "maxOutputTokens": 4096,
        },
        [
            {"role": "system", "content": "You are helpful"},
            {"role": "user", "content": "Describe", "images": ["data:image/png;base64,AAA"]},
        ],
        _FakeStreamResponse(lines=lines), captured,
    )

    request = captured[0]
    assert request["url"] == "https://api.openai.com/v1/chat/completions"
    assert request["headers"]["Authorization"] == "Bearer sk-secret"
    body = request["body"]
    assert body["model"] == "gpt-4o"
    assert body["stream"] is True
    assert body["max_tokens"] == 4096
    assert body["stream_options"] == {"include_usage": True}
    # System messages stay inline for OpenAI-compatible providers.
    assert body["messages"][0] == {"role": "system", "content": "You are helpful"}
    assert body["messages"][1]["content"] == [
        {"type": "text", "text": "Describe"},
        {"type": "text", "text": "\n[Image 1]:"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA"}},
    ]

    assert job.status == "done"
    assert job.buffer == "Hello"
    assert job.usage == {
        "promptTokens": 30, "completionTokens": 2, "cachedPromptTokens": 12,
        # Present even at zero: a large value is the proof that a slow first
        # token was the model thinking rather than a stalled connection.
        "reasoningTokens": 0,
    }


def test_generation_streams_reasoning_without_disturbing_the_document_text():
    """Reasoning arrives on its own key and can precede every visible token.
    It is reported live and counted, but never buffered — buffering it would
    shift the replay offsets and push thinking into the document."""
    job = _new_job()
    seen: asyncio.Queue = asyncio.Queue()
    job.subscribers.add(seen)
    lines = [
        'data: {"choices":[{"delta":{"reasoning_content":"weighing options"}}]}',
        'data: {"choices":[{"delta":{"content":"Answer"}}]}',
        "data: [DONE]",
    ]
    _run_job(
        job, "openai",
        {"apiKey": "sk", "model": "o-reasoner", "baseUrl": "https://api.openai.com/v1"},
        [{"role": "user", "content": "hi"}],
        _FakeStreamResponse(lines=lines), [],
    )

    assert job.buffer == "Answer"                          # not document text
    assert job.length == 6                                 # ...and no offset shift
    assert job.reasoning_chars == len("weighing options")
    assert job.first_reasoning_latency is not None

    events = []
    while not seen.empty():
        events.append(seen.get_nowait())
    assert [e["type"] for e in events] == ["reasoning", "delta", "done"]
    assert events[0]["text"] == "weighing options"


def test_generation_applies_reasoning_effort_per_provider():
    """Each provider spells effort differently; the client sends the resolved
    level and this maps it. A level that never reaches the wire is a setting
    the user changed for nothing."""
    openai_body = server_generation.build_openai_request(
        {"apiKey": "sk", "model": "grok-4.6", "baseUrl": "https://api.x.ai/v1", "reasoningEffort": "low"},
        [{"role": "user", "content": "hi"}], "grok",
    )[2]
    assert openai_body["reasoning_effort"] == "low"

    gemini_body = server_generation.build_gemini_request(
        {"apiKey": "k", "model": "gemini-2.5-pro", "baseUrl": "https://g", "reasoningEffort": "medium"},
        [{"role": "user", "content": "hi"}],
    )[2]
    assert gemini_body["generationConfig"]["thinkingConfig"] == {"thinkingBudget": 4096}

    # Anthropic's budget must stay under max_tokens, so it is clamped.
    anthropic_body = server_generation.build_anthropic_request(
        {"apiKey": "k", "model": "claude-sonnet-5", "baseUrl": "https://a",
         "maxOutputTokens": 4096, "reasoningEffort": "high"},
        [{"role": "user", "content": "hi"}],
    )[2]
    assert anthropic_body["thinking"] == {"type": "enabled", "budget_tokens": 2048}


def test_generation_retries_without_effort_when_the_provider_rejects_it():
    """The capability table is a guess about someone else's API. A wrong guess
    costs one retry, not the turn."""
    job = _new_job()
    captured = []
    attempts = []

    class _RejectThenAccept:
        """400s the first request, streams the second."""
        def __init__(self):
            self.calls = 0

        @property
        def status_code(self):
            return 400 if self.calls == 1 else 200

        async def aiter_lines(self):
            for line in ['data: {"choices":[{"delta":{"content":"ok"}}]}', "data: [DONE]"]:
                yield line

        async def aread(self):
            return b'{"error":"Unsupported parameter: reasoning_effort"}'

    response = _RejectThenAccept()

    from contextlib import asynccontextmanager

    @asynccontextmanager
    async def fake_stream(url, headers, body):
        response.calls += 1
        attempts.append(body)
        captured.append({"url": url, "headers": headers, "body": body})
        yield response

    with patch.object(server_generation, "_http_stream", fake_stream):
        asyncio.run(server_generation.run_job(
            job, "grok",
            {"apiKey": "sk", "model": "grok-4.6", "baseUrl": "https://api.x.ai/v1", "reasoningEffort": "xhigh"},
            [{"role": "user", "content": "hi"}],
        ))

    assert len(attempts) == 2
    assert attempts[0]["reasoning_effort"] == "xhigh"
    assert "reasoning_effort" not in attempts[1]   # dropped, not repeated
    assert job.status == "done"
    assert job.buffer == "ok"


def test_generation_reasoning_rejection_matcher_is_not_a_blanket_retry():
    assert server_generation._is_reasoning_effort_rejection("Unsupported parameter: reasoning_effort")
    assert server_generation._is_reasoning_effort_rejection("thinking is not supported for this model")
    # Unrelated failures must still fail — retrying them just doubles the cost.
    assert not server_generation._is_reasoning_effort_rejection("Incorrect API key provided.")
    assert not server_generation._is_reasoning_effort_rejection("429 rate limit exceeded")


def test_generation_omits_reasoning_effort_when_not_chosen():
    """'default' and absence both mean: send nothing, let the provider decide."""
    for config in (
        {"apiKey": "sk", "model": "grok-4.6", "baseUrl": "https://api.x.ai/v1"},
        {"apiKey": "sk", "model": "grok-4.6", "baseUrl": "https://api.x.ai/v1", "reasoningEffort": "default"},
    ):
        body = server_generation.build_openai_request(config, [{"role": "user", "content": "hi"}], "grok")[2]
        assert "reasoning_effort" not in body

    gemini = server_generation.build_gemini_request(
        {"apiKey": "k", "model": "gemini-2.5-pro", "baseUrl": "https://g"},
        [{"role": "user", "content": "hi"}],
    )[2]
    assert "generationConfig" not in gemini or "thinkingConfig" not in gemini.get("generationConfig", {})


def test_generation_tolerates_a_trailing_slash_in_the_base_url():
    """Typing the URL with a trailing slash is normal; the resulting `//path`
    is not. llama.cpp answers it with a bare 404 "File Not Found", which reads
    like a missing model rather than a stray character."""
    url, _, _ = server_generation.build_openai_request(
        {"apiKey": "sk", "model": "m", "baseUrl": "http://127.0.0.1:8090/v1/"},
        [{"role": "user", "content": "hi"}], "ollama",
    )
    assert url == "http://127.0.0.1:8090/v1/chat/completions"

    gemini_url, _, _ = server_generation.build_gemini_request(
        {"apiKey": "k", "model": "gemini-2.5-pro", "baseUrl": "https://g/v1beta/"},
        [{"role": "user", "content": "hi"}],
    )
    assert "//models/" not in gemini_url

    anthropic_url, _, _ = server_generation.build_anthropic_request(
        {"apiKey": "k", "model": "claude-sonnet-5", "baseUrl": "https://a/v1/"},
        [{"role": "user", "content": "hi"}],
    )
    assert anthropic_url == "https://a/v1/messages"


def test_generation_ollama_request_omits_auth_and_stream_options():
    job = _new_job()
    captured = []
    _run_job(
        job, "ollama",
        {"apiKey": "ollama-no-key", "model": "llama3", "baseUrl": "http://localhost:11434/v1"},
        [{"role": "user", "content": "hi"}],
        _FakeStreamResponse(lines=['data: {"choices":[{"delta":{"content":"yo"}}]}', "data: [DONE]"]),
        captured,
    )

    request = captured[0]
    assert request["url"] == "http://localhost:11434/v1/chat/completions"
    assert "Authorization" not in request["headers"]
    # Ollama rejects stream_options; it must never be sent.
    assert "stream_options" not in request["body"]
    assert job.buffer == "yo"
    assert job.usage is None


def test_generation_grok_request_sets_conversation_cache_header():
    job = _new_job()
    captured = []
    _run_job(
        job, "grok",
        {
            "apiKey": "xai-key", "model": "grok-4.3",
            "baseUrl": "https://api.x.ai/v1", "conversationId": "conv-9",
        },
        [{"role": "user", "content": "hi"}],
        _FakeStreamResponse(lines=['data: {"choices":[{"delta":{"content":"ok"}}]}']),
        captured,
    )

    request = captured[0]
    assert request["headers"]["x-grok-conv-id"] == "conv-9"
    assert request["headers"]["Authorization"] == "Bearer xai-key"
    assert request["body"]["stream_options"] == {"include_usage": True}
    assert job.status == "done"


def test_generation_gemini_request_and_chunked_json_parsing():
    job = _new_job()
    captured = []
    # Objects arrive split across network chunks, exactly like the real stream.
    text_chunks = [
        '[{"candidates":[{"content":{"parts":[{"text":"Hel',
        'lo"}]}}]},{"candidates":[{"content":{"parts":[{"text":" there"}]},'
        '"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":7,'
        '"candidatesTokenCount":3,"cachedContentTokenCount":2}}]',
    ]
    _run_job(
        job, "gemini",
        {
            "apiKey": "gem-secret", "model": "models/gemini-2.5-flash",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
            "maxOutputTokens": 8192,
            "geminiSafetySettings": [{"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"}],
        },
        [
            {"role": "system", "content": "Be brief"},
            {"role": "assistant", "content": "prior"},
            {"role": "user", "content": "Look", "images": ["data:image/jpeg;base64,ZZZ"]},
        ],
        _FakeStreamResponse(text_chunks=text_chunks), captured,
    )

    request = captured[0]
    # The 'models/' prefix is stripped so the path is not doubled.
    assert request["url"] == (
        "https://generativelanguage.googleapis.com/v1beta"
        "/models/gemini-2.5-flash:streamGenerateContent?key=gem-secret"
    )
    body = request["body"]
    assert body["systemInstruction"] == {"parts": [{"text": "Be brief"}]}
    assert body["safetySettings"][0]["threshold"] == "BLOCK_NONE"
    assert body["generationConfig"] == {"maxOutputTokens": 8192}
    assert body["contents"][0]["role"] == "model"
    assert body["contents"][1]["parts"] == [
        {"text": "Look"},
        {"text": "\n[Image 1]:"},
        {"inlineData": {"mimeType": "image/jpeg", "data": "ZZZ"}},
    ]

    assert job.status == "done"
    assert job.buffer == "Hello there"
    assert job.usage == {"promptTokens": 7, "completionTokens": 3, "cachedPromptTokens": 2}


def test_generation_gemini_prompt_safety_block_becomes_error():
    job = _new_job()
    captured = []
    _run_job(
        job, "gemini",
        {"apiKey": "k", "model": "gemini-2.5-flash", "baseUrl": "https://g/v1beta"},
        [{"role": "user", "content": "bad"}],
        _FakeStreamResponse(text_chunks=['[{"promptFeedback":{"blockReason":"SAFETY"}}]']),
        captured,
    )
    assert job.status == "error"
    assert job.error == "Content generation blocked by safety policy: SAFETY"


def test_generation_gemini_abnormal_finish_reason_becomes_error():
    job = _new_job()
    captured = []
    _run_job(
        job, "gemini",
        {"apiKey": "k", "model": "gemini-2.5-flash", "baseUrl": "https://g/v1beta"},
        [{"role": "user", "content": "hi"}],
        _FakeStreamResponse(text_chunks=[
            '[{"candidates":[{"content":{"parts":[{"text":"partial"}]},"finishReason":"RECITATION"}]}]'
        ]),
        captured,
    )
    assert job.status == "error"
    assert job.error == "Content generation blocked or terminated abnormally: RECITATION"
    # The partial text stays readable even though the job errored.
    assert job.buffer == ""


def test_generation_anthropic_request_caching_and_usage():
    job = _new_job()
    captured = []
    lines = [
        "event: message_start",
        'data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
        '"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":1}}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
        'data: {"type":"message_delta","usage":{"output_tokens":7}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":11}}',
    ]
    _run_job(
        job, "anthropic",
        {
            "apiKey": "sk-ant-secret", "model": "claude-sonnet-5",
            "baseUrl": "https://api.anthropic.com/v1", "maxOutputTokens": 16384,
        },
        [
            {"role": "system", "content": "System prompt"},
            {"role": "user", "content": "old turn", "cacheHint": True},
            {"role": "assistant", "content": "answer"},
            {"role": "user", "content": "See this", "images": ["data:image/png;base64,QQQ"], "cacheHint": True},
        ],
        _FakeStreamResponse(lines=lines), captured,
    )

    request = captured[0]
    assert request["url"] == "https://api.anthropic.com/v1/messages"
    assert request["headers"]["x-api-key"] == "sk-ant-secret"
    assert request["headers"]["anthropic-version"] == "2023-06-01"
    assert request["headers"]["anthropic-beta"] == "prompt-caching-2024-07-31"

    body = request["body"]
    assert body["max_tokens"] == 16384
    # System prompt is a structured block with its own cache breakpoint.
    assert body["system"] == [{
        "type": "text", "text": "System prompt", "cache_control": {"type": "ephemeral"},
    }]
    # The system message is excluded from messages[]; indexes still line up.
    assert len(body["messages"]) == 3
    assert body["messages"][0]["content"] == [
        {"type": "text", "text": "old turn", "cache_control": {"type": "ephemeral"}},
    ]
    assert body["messages"][1]["content"] == "answer"  # no hint, stays a string
    # For a multi-part message the breakpoint lands on the LAST part.
    image_parts = body["messages"][2]["content"]
    assert image_parts[0] == {"type": "text", "text": "See this"}
    assert image_parts[-1] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": "QQQ"},
        "cache_control": {"type": "ephemeral"},
    }

    assert job.buffer == "Hi there"
    # Total input = input + cache_creation + cache_read; output is the
    # CUMULATIVE message_delta value, not a sum of the deltas.
    assert job.usage == {
        "promptTokens": 115,
        "completionTokens": 11,
        "cachedPromptTokens": 100,
    }


def test_generation_anthropic_cache_breakpoints_capped_at_three():
    messages = [{"role": "system", "content": "sys"}] + [
        {"role": "user", "content": f"m{i}", "cacheHint": True} for i in range(5)
    ]
    _url, _headers, body = server_generation.build_anthropic_request(
        {"apiKey": "k", "model": "claude-sonnet-5", "baseUrl": "https://api.anthropic.com/v1"},
        messages,
    )
    marked = [m for m in body["messages"] if isinstance(m["content"], list)]
    # The system block takes the 4th slot, so only 3 message-level ones remain.
    assert len(marked) == 3
    assert [m["content"][0]["text"] for m in marked] == ["m0", "m1", "m2"]


def test_generation_provider_http_error_becomes_error_event():
    job = _new_job()
    captured = []
    _run_job(
        job, "openai",
        {"apiKey": "sk", "model": "gpt-4o", "baseUrl": "https://api.openai.com/v1"},
        [{"role": "user", "content": "hi"}],
        _FakeStreamResponse(status_code=429, error_body=b"rate limited"), captured,
    )
    assert job.status == "error"
    assert job.error == "OpenAI API error (429): rate limited"


def test_generation_unsupported_provider_errors_without_a_request():
    job = _new_job()
    captured = []
    _run_job(job, "mystery", {}, [{"role": "user", "content": "hi"}], _FakeStreamResponse(), captured)
    assert captured == []
    assert job.status == "error"
    assert job.error == "Unsupported LLM provider: mystery"


def test_generation_masking_never_leaks_credentials():
    masked = server_generation.mask_request_details(
        "https://g/v1beta/models/m:streamGenerateContent?key=super-secret",
        {"Authorization": "Bearer sk-secret", "x-api-key": "sk-ant-secret"},
        {"model": "m"},
    )
    dumped = _json.dumps(masked)
    assert "super-secret" not in dumped
    assert "sk-secret" not in dumped
    assert "sk-ant-secret" not in dumped
    assert masked["url"].endswith("key=***")
