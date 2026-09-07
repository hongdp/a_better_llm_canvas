"""SQLite database layer: DB path/config, connections, schema init/migrations.

Tests that need an isolated database should patch `server_db.DB_PATH`
(patching a re-exported alias on another module does not affect the code
here, which reads this module's global).
"""

import os
import sqlite3
from typing import Optional

# SQLite DB is stored locally (not on network mounts like SMB/NFS)
# because SQLite requires proper file locking which network filesystems don't support.
# The DB file is placed in a local directory that mirrors the storage dir name.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.dirname(_SCRIPT_DIR)
_LOCAL_DB_DIR = os.path.join(_PROJECT_DIR, ".local_db")
if not os.path.exists(_LOCAL_DB_DIR):
    os.makedirs(_LOCAL_DB_DIR, exist_ok=True)
DB_PATH = os.path.join(_LOCAL_DB_DIR, "metadata.db")

# Global settings are stored with this special book_id
GLOBAL_SETTINGS_BOOK_ID = "__global__"

# ── SQLite Database Layer ──────────────────────────────────────────────────────
def get_db() -> sqlite3.Connection:
    """Get a SQLite connection with foreign keys enabled.

    Uses DELETE journal mode instead of WAL for compatibility with
    network filesystems (SMB/NFS) where WAL's shared-memory mmap fails.
    """
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn

def init_db():
    """Create database tables if they don't exist."""
    conn = get_db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS books (
                id TEXT NOT NULL,
                username TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Untitled Book',
                active_document_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (username, id)
            );
            CREATE INDEX IF NOT EXISTS idx_books_username ON books(username);

            CREATE TABLE IF NOT EXISTS documents (
                id TEXT NOT NULL,
                username TEXT NOT NULL,
                book_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT 'Untitled Chapter',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (username, book_id, id),
                FOREIGN KEY (username, book_id) REFERENCES books(username, id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS versions (
                id TEXT NOT NULL,
                username TEXT NOT NULL,
                book_id TEXT NOT NULL,
                document_id TEXT NOT NULL,
                title TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                PRIMARY KEY (username, book_id, id)
            );

            CREATE TABLE IF NOT EXISTS book_settings (
                username TEXT NOT NULL,
                book_id TEXT NOT NULL,
                active_provider TEXT,
                provider_configs TEXT,
                custom_system_prompts TEXT,
                active_system_prompt_id TEXT,
                theme TEXT,
                debug_mode INTEGER DEFAULT 0,
                PRIMARY KEY (username, book_id)
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT NOT NULL,
                username TEXT NOT NULL,
                book_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                thinking TEXT,
                model TEXT,
                input_tokens INTEGER,
                output_tokens INTEGER,
                cache_hit_tokens INTEGER,
                sort_order INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (username, book_id, id)
            );

            -- The book to reopen on the next device (see record_last_active_book).
            CREATE TABLE IF NOT EXISTS user_state (
                username TEXT PRIMARY KEY,
                last_active_book_id TEXT,
                updated_at TEXT NOT NULL
            );
        """)

        # Migrate per-book settings to global settings if not done yet
        # Settings (API keys, system prompts, theme) are user-level, not per-book
        existing_global = conn.execute(
            "SELECT 1 FROM book_settings WHERE book_id = '__global__'"
        ).fetchone()
        if not existing_global:
            # Copy settings from 'default' book (where migration put them) to __global__
            default_settings = conn.execute(
                "SELECT * FROM book_settings WHERE book_id = 'default'"
            ).fetchone()
            if default_settings:
                conn.execute(
                    """INSERT OR IGNORE INTO book_settings
                       (username, book_id, active_provider, provider_configs,
                        custom_system_prompts, active_system_prompt_id, theme, debug_mode)
                       VALUES (?, '__global__', ?, ?, ?, ?, ?, ?)""",
                    (
                        default_settings["username"],
                        default_settings["active_provider"],
                        default_settings["provider_configs"],
                        default_settings["custom_system_prompts"],
                        default_settings["active_system_prompt_id"],
                        default_settings["theme"],
                        default_settings["debug_mode"],
                    )
                )
                print("[Init] Migrated settings from 'default' book to global settings.")

        # Schema migration: chapter summary metadata (smart context selection).
        # SQLite has no IF NOT EXISTS for columns, so probe table_info first.
        doc_columns = {row["name"] for row in conn.execute("PRAGMA table_info(documents)").fetchall()}
        if "summary" not in doc_columns:
            conn.execute("ALTER TABLE documents ADD COLUMN summary TEXT")
            conn.execute("ALTER TABLE documents ADD COLUMN summary_content_hash TEXT")
            print("[Init] Migrated documents table: added summary columns.")

        conn.commit()
    finally:
        conn.close()


# ── Per-user state: the book to reopen on the next device ─────────────────────
# Problem: a new device (or a browser whose cache was cleared, or an account
#   switch, which clears the same keys) always opened the book with id
#   'default'. The client chose the book from localStorage alone, and the
#   server kept no per-user pointer to the book last worked in — only a
#   per-book active_document_id.
# Fix: every write to a book (metadata PUT, create, legacy save) records it as
#   the user's last active book, and /api/auth/session hands the pointer back
#   so the client can open that book before it has any local state.

def record_last_active_book(conn: sqlite3.Connection, username: str, book_id: str, now: str) -> None:
    """Upsert the pointer inside the caller's transaction."""
    conn.execute(
        """INSERT INTO user_state (username, last_active_book_id, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(username) DO UPDATE SET
           last_active_book_id = excluded.last_active_book_id, updated_at = excluded.updated_at""",
        (username, book_id, now),
    )


def clear_last_active_book(conn: sqlite3.Connection, username: str, book_id: str) -> None:
    """Forget the pointer when the book it names is deleted."""
    conn.execute(
        "UPDATE user_state SET last_active_book_id = NULL WHERE username = ? AND last_active_book_id = ?",
        (username, book_id),
    )


def lookup_last_active_book_id(username: str) -> Optional[str]:
    """The recorded book if it still exists; otherwise the most recently
    updated book, so accounts that predate the pointer (and pointers left
    behind by a deletion) still get a sensible answer; None for an account
    with no books. Never raises — a session check must not fail over this."""
    try:
        conn = get_db()
        try:
            row = conn.execute(
                """SELECT b.id FROM user_state s
                   JOIN books b ON b.username = s.username AND b.id = s.last_active_book_id
                   WHERE s.username = ?""",
                (username,),
            ).fetchone()
            if row:
                return row["id"]
            row = conn.execute(
                "SELECT id FROM books WHERE username = ? ORDER BY updated_at DESC LIMIT 1",
                (username,),
            ).fetchone()
            return row["id"] if row else None
        finally:
            conn.close()
    except Exception as e:
        print(f"[user_state] last-active-book lookup failed for {username!r}: {e}")
        return None
