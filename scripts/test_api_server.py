import pytest
from unittest.mock import patch, MagicMock
import sys
import os

# Add scripts directory to path to import api_server
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
import api_server
from api_server import _parse_html_to_scraped_data

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
    
    with patch("api_server.http_requests.get") as mock_get:
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
    with patch("api_server.http_requests.get") as mock_get:
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

    with patch.object(api_server, "DB_PATH", str(db_file)):
        api_server.init_db()

        conn = api_server.get_db()
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
        api_server.init_db()
