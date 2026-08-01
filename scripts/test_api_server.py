import pytest
from unittest.mock import patch, MagicMock
import sys
import os

# Add scripts directory to path to import api_server and its sibling modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import api_server
import server_auth
import server_db
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
