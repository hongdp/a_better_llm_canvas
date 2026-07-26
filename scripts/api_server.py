import os
import re
import json
import secrets
import hashlib
import argparse
import base64
import sqlite3
import shutil
import ipaddress
import socket
from urllib.parse import urlparse, urljoin
from datetime import datetime, timezone, timedelta
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

try:
    import requests as http_requests
    from bs4 import BeautifulSoup
    HAS_SCRAPING_DEPS = True
except ImportError:
    HAS_SCRAPING_DEPS = False

# Initialize FastAPI app
app = FastAPI(title="Web Canvas Backend API", version="2.0.0")

# CORS middleware configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Parse command line arguments
parser = argparse.ArgumentParser(description="Web Canvas API Server")
parser.add_argument("--storage-dir", default=os.getenv("VITE_STORAGE_DIR", "storage"), help="Path to storage folder")
parser.add_argument("--host", default="127.0.0.1", help="Host IP to listen on")
parser.add_argument("--port", type=int, default=3000, help="Port to listen on")
args, unknown = parser.parse_known_args()

STORAGE_DIR = os.path.abspath(args.storage_dir)
if not os.path.exists(STORAGE_DIR):
    os.makedirs(STORAGE_DIR, exist_ok=True)

CONTENT_DIR = os.path.join(STORAGE_DIR, "content")
if not os.path.exists(CONTENT_DIR):
    os.makedirs(CONTENT_DIR, exist_ok=True)

USERS_FILE = os.path.join(STORAGE_DIR, "users.json")
SESSIONS_FILE = os.path.join(STORAGE_DIR, "sessions.json")

# SQLite DB is stored locally (not on network mounts like SMB/NFS)
# because SQLite requires proper file locking which network filesystems don't support.
# The DB file is placed in a local directory that mirrors the storage dir name.
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.dirname(_SCRIPT_DIR)
_LOCAL_DB_DIR = os.path.join(_PROJECT_DIR, ".local_db")
if not os.path.exists(_LOCAL_DB_DIR):
    os.makedirs(_LOCAL_DB_DIR, exist_ok=True)
DB_PATH = os.path.join(_LOCAL_DB_DIR, "metadata.db")

# ── Helper to read/write json files safely ─────────────────────────────────────
def load_json_file(file_path: str) -> dict:
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}

def save_json_file(file_path: str, data: dict):
    try:
        with open(file_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    except Exception as e:
        print(f"[API Server] Error saving file {file_path}: {e}")

# ── Input validation helpers ───────────────────────────────────────────────────
def sanitize_username(username: str) -> str:
    """Strict alphanumeric username validation."""
    safe = re.sub(r"[^a-zA-Z0-9_-]", "", os.path.basename(username))
    if not safe:
        raise HTTPException(status_code=400, detail="Invalid username pattern.")
    return safe

def sanitize_id(value: str, label: str = "id") -> str:
    """Strict alphanumeric ID validation."""
    safe = re.sub(r"[^a-zA-Z0-9_-]", "", os.path.basename(value))
    if not safe:
        raise HTTPException(status_code=400, detail=f"Invalid {label} pattern.")
    return safe

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

# Global settings are stored with this special book_id
GLOBAL_SETTINGS_BOOK_ID = "__global__"

# ── Content file helpers ───────────────────────────────────────────────────────
def _get_content_dir(username: str, book_id: str) -> str:
    """Get the content directory for a book, creating it if needed."""
    safe_username = sanitize_username(username)
    safe_book_id = sanitize_id(book_id, "bookId")
    path = os.path.join(CONTENT_DIR, safe_username, safe_book_id)
    resolved = os.path.abspath(path)
    # Security: ensure within CONTENT_DIR
    if not resolved.startswith(os.path.abspath(CONTENT_DIR) + os.sep):
        raise HTTPException(status_code=403, detail="Access denied: Directory traversal detected.")
    os.makedirs(resolved, exist_ok=True)
    return resolved

def save_document_content(username: str, book_id: str, doc_id: str, content: str):
    """Save document content to a file."""
    content_dir = _get_content_dir(username, book_id)
    safe_doc_id = sanitize_id(doc_id, "docId")
    file_path = os.path.join(content_dir, f"doc-{safe_doc_id}.json")
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump({"content": content}, f, ensure_ascii=False)

def load_document_content(username: str, book_id: str, doc_id: str) -> str:
    """Load document content from file."""
    content_dir = _get_content_dir(username, book_id)
    safe_doc_id = sanitize_id(doc_id, "docId")
    file_path = os.path.join(content_dir, f"doc-{safe_doc_id}.json")
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("content", "")
        except Exception:
            return ""
    return ""

def delete_document_content(username: str, book_id: str, doc_id: str):
    """Delete a document content file."""
    content_dir = _get_content_dir(username, book_id)
    safe_doc_id = sanitize_id(doc_id, "docId")
    file_path = os.path.join(content_dir, f"doc-{safe_doc_id}.json")
    if os.path.exists(file_path):
        os.remove(file_path)

def save_version_content(username: str, book_id: str, version_id: str, content: str):
    """Save version snapshot content to a file."""
    content_dir = _get_content_dir(username, book_id)
    safe_ver_id = sanitize_id(version_id, "versionId")
    file_path = os.path.join(content_dir, f"ver-{safe_ver_id}.json")
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump({"content": content}, f, ensure_ascii=False)

def load_version_content(username: str, book_id: str, version_id: str) -> str:
    """Load version snapshot content from file."""
    content_dir = _get_content_dir(username, book_id)
    safe_ver_id = sanitize_id(version_id, "versionId")
    file_path = os.path.join(content_dir, f"ver-{safe_ver_id}.json")
    if os.path.exists(file_path):
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("content", "")
        except Exception:
            return ""
    return ""

def delete_book_content_dir(username: str, book_id: str):
    """Delete the entire content directory for a book."""
    content_dir = _get_content_dir(username, book_id)
    if os.path.exists(content_dir):
        shutil.rmtree(content_dir, ignore_errors=True)


# ── Legacy migration ──────────────────────────────────────────────────────────
def migrate_legacy_files():
    """Migrate legacy state_*.json files to SQLite + content files.
    
    This runs once at startup. Legacy files are preserved as backups
    (renamed to state_*.json.migrated).
    """
    legacy_pattern = re.compile(r"^state_([a-zA-Z0-9_-]+?)(?:_([a-zA-Z0-9_-]+))?\.json$")
    
    try:
        files = os.listdir(STORAGE_DIR)
    except Exception:
        return
    
    legacy_files = []
    for f in files:
        m = legacy_pattern.match(f)
        if m:
            legacy_files.append((f, m.group(1), m.group(2) or "default"))
    
    # Also handle bare "state.json" (pre-multi-user legacy format)
    bare_state = os.path.join(STORAGE_DIR, "state.json")
    if os.path.exists(bare_state):
        # Assign to the first registered user, or 'default_user'
        users = load_json_file(USERS_FILE)
        fallback_username = next(iter(users.keys()), None) if users else None
        if not fallback_username:
            fallback_username = "default_user"
        legacy_files.append(("state.json", fallback_username, "default"))
    
    if not legacy_files:
        return
    
    print(f"[Migration] Found {len(legacy_files)} legacy file(s) to migrate...")
    conn = get_db()
    migrated = 0
    skipped = 0
    failed = 0
    try:
        for filename, username, book_id in legacy_files:
            file_path = os.path.join(STORAGE_DIR, filename)
            if not os.path.exists(file_path):
                skipped += 1
                continue
            try:
                _migrate_single_legacy_file(conn, file_path, username, book_id)
                conn.commit()
                # Rename to .migrated as backup
                backup_path = file_path + ".migrated"
                try:
                    os.rename(file_path, backup_path)
                except OSError:
                    pass  # File rename may fail on some FS but migration is done
                migrated += 1
                print(f"[Migration] ✓ ({migrated}/{len(legacy_files)}) Migrated {filename}")
            except sqlite3.IntegrityError:
                # Already migrated in a previous run
                skipped += 1
                try:
                    os.rename(file_path, file_path + ".migrated")
                except OSError:
                    pass
            except Exception as e:
                failed += 1
                print(f"[Migration] ✗ Failed to migrate {filename}: {e}")
                conn.rollback()
    finally:
        conn.close()
    print(f"[Migration] Complete: {migrated} migrated, {skipped} skipped, {failed} failed")

def _migrate_single_legacy_file(conn: sqlite3.Connection, file_path: str, username: str, book_id: str):
    """Migrate a single legacy JSON file into the new storage schema."""
    with open(file_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    book_title = data.get("bookTitle", "Untitled Book")
    updated_at = data.get("updatedAt", now)
    active_doc_id = data.get("activeDocumentId", "")
    
    # Check if book already exists in DB (skip if already migrated)
    existing = conn.execute(
        "SELECT id FROM books WHERE username = ? AND id = ?",
        (username, book_id)
    ).fetchone()
    if existing:
        return
    
    # Insert book
    conn.execute(
        "INSERT INTO books (id, username, title, active_document_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (book_id, username, book_title, active_doc_id, updated_at, updated_at)
    )
    
    # Insert documents and save their content to files
    documents = data.get("documents", [])
    for idx, doc in enumerate(documents):
        doc_id = doc.get("id", f"doc-migrated-{idx}")
        doc_title = doc.get("title", f"Chapter {idx + 1}")
        doc_content = doc.get("content", "")
        doc_created = doc.get("createdAt", now)
        doc_updated = doc.get("updatedAt", now)
        
        conn.execute(
            "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (doc_id, username, book_id, doc_title, idx, doc_created, doc_updated)
        )
        
        # Save content to file
        save_document_content(username, book_id, doc_id, doc_content)
    
    # Insert versions and save their content to files
    versions = data.get("versions", [])
    for ver in versions:
        ver_id = ver.get("id", f"ver-migrated-{ver.get('timestamp', now)}")
        ver_doc_id = ver.get("documentId", "")
        ver_title = ver.get("title", "Untitled Version")
        ver_timestamp = ver.get("timestamp", now)
        ver_content = ver.get("content", "")
        
        conn.execute(
            "INSERT INTO versions (id, username, book_id, document_id, title, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (ver_id, username, book_id, ver_doc_id, ver_title, ver_timestamp)
        )
        save_version_content(username, book_id, ver_id, ver_content)
    
    # Insert settings
    conn.execute(
        """INSERT INTO book_settings (username, book_id, active_provider, provider_configs,
           custom_system_prompts, active_system_prompt_id, theme, debug_mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            username, book_id,
            data.get("activeProvider"),
            json.dumps(data.get("providerConfigs")) if data.get("providerConfigs") else None,
            json.dumps(data.get("customSystemPrompts")) if data.get("customSystemPrompts") else None,
            data.get("activeSystemPromptId"),
            data.get("theme"),
            1 if data.get("debugMode") else 0
        )
    )
    
    # Insert chat messages
    messages = data.get("messages", [])
    for idx, msg in enumerate(messages):
        msg_id = msg.get("id", f"msg-migrated-{idx}")
        conn.execute(
            """INSERT INTO messages (id, username, book_id, role, content, timestamp,
               thinking, model, input_tokens, output_tokens, cache_hit_tokens, sort_order)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                msg_id, username, book_id,
                msg.get("role", "assistant"),
                msg.get("content", ""),
                msg.get("timestamp", now),
                msg.get("thinking"),
                msg.get("model"),
                msg.get("inputTokens"),
                msg.get("outputTokens"),
                msg.get("cacheHitTokens"),
                idx
            )
        )


# ── Initialize DB and run migration on startup ────────────────────────────────
init_db()
migrate_legacy_files()


# ── CSRF Middleware ────────────────────────────────────────────────────────────
@app.middleware("http")
async def csrf_middleware(request: Request, call_next):
    # Validate state-changing requests (POST, PUT, DELETE)
    if request.method in ("POST", "PUT", "DELETE"):
        csrf_header = request.headers.get("x-csrf-token")
        csrf_cookie = request.cookies.get("csrf_token")
        if not csrf_cookie or csrf_header != csrf_cookie:
            return JSONResponse(
                status_code=403,
                content={"error": "CSRF token mismatch or missing."}
            )

    return await call_next(request)

# ── Authentication ─────────────────────────────────────────────────────────────
def get_authenticated_username(request: Request) -> str:
    session_id = request.cookies.get("web_canvas_session")
    if not session_id:
        raise HTTPException(status_code=401, detail="Authentication required.")

    sessions = load_json_file(SESSIONS_FILE)
    session = sessions.get(session_id)
    if not session or "username" not in session or "expiresAt" not in session:
        raise HTTPException(status_code=401, detail="Authentication required.")

    try:
        expires_at = datetime.fromisoformat(session["expiresAt"].replace("Z", "+00:00"))
        if datetime.now(timezone.utc) > expires_at:
            raise HTTPException(status_code=401, detail="Session expired.")
    except Exception:
        raise HTTPException(status_code=401, detail="Authentication required.")

    return session["username"]

# 1. Session GET endpoint
@app.get("/api/auth/session")
async def get_session(request: Request, response: Response):
    csrf_token = request.cookies.get("csrf_token")
    if not csrf_token:
        csrf_token = secrets.token_hex(16)
        response.set_cookie(
            key="csrf_token",
            value=csrf_token,
            path="/",
            samesite="lax",
            max_age=365 * 24 * 60 * 60,
            httponly=False,
            secure=True
        )

    session_id = request.cookies.get("web_canvas_session")
    sessions = load_json_file(SESSIONS_FILE)
    session = sessions.get(session_id) if session_id else None

    if session and "username" in session and "expiresAt" in session:
        try:
            expires_at = datetime.fromisoformat(session["expiresAt"].replace("Z", "+00:00"))
            if datetime.now(timezone.utc) <= expires_at:
                return {"loggedIn": True, "username": session["username"], "csrfToken": csrf_token}
        except Exception:
            pass

    return {"loggedIn": False, "csrfToken": csrf_token}

# 2. Register endpoint
@app.post("/api/auth/register")
async def register_user(request: Request):
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    if not username or not re.match(r"^[a-zA-Z0-9_-]{3,30}$", username):
        raise HTTPException(status_code=400, detail="Username must be alphanumeric, between 3 and 30 characters.")

    if not password or len(password) < 8:
        raise HTTPException(status_code=400, detail="Password must be at least 8 characters long.")

    users = load_json_file(USERS_FILE)
    if username in users:
        raise HTTPException(status_code=400, detail="Username is already taken.")

    salt_bytes = secrets.token_bytes(16)
    salt_hex = salt_bytes.hex()

    dk = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_bytes,
        n=16384,
        r=8,
        p=1,
        dklen=64
    )
    hash_hex = dk.hex()

    users[username] = {
        "username": username,
        "salt": salt_hex,
        "hash": hash_hex
    }
    save_json_file(USERS_FILE, users)

    return {"success": True}

# 3. Login endpoint
@app.post("/api/auth/login")
async def login_user(request: Request, response: Response):
    try:
        body = await request.json()
        username = body.get("username")
        password = body.get("password")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid request.")

    users = load_json_file(USERS_FILE)
    user = users.get(username)
    if not user or "salt" not in user or "hash" not in user:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    salt_bytes = bytes.fromhex(user["salt"])
    dk = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt_bytes,
        n=16384,
        r=8,
        p=1,
        dklen=64
    )
    check_hash_hex = dk.hex()

    if check_hash_hex != user["hash"]:
        raise HTTPException(status_code=401, detail="Invalid username or password.")

    session_id = secrets.token_hex(32)
    sessions = load_json_file(SESSIONS_FILE)
    sessions = {k: v for k, v in sessions.items() if v.get("username") != username}

    expires_at = datetime.now(timezone.utc) + timedelta(days=7)
    sessions[session_id] = {
        "username": username,
        "expiresAt": expires_at.isoformat().replace("+00:00", "Z")
    }
    save_json_file(SESSIONS_FILE, sessions)

    response.set_cookie(
        key="web_canvas_session",
        value=session_id,
        httponly=True,
        path="/",
        samesite="lax",
        max_age=7 * 24 * 60 * 60,
        secure=True
    )

    csrf_token = request.cookies.get("csrf_token") or secrets.token_hex(16)
    response.set_cookie(
        key="csrf_token",
        value=csrf_token,
        path="/",
        samesite="lax",
        max_age=365 * 24 * 60 * 60,
        httponly=False,
        secure=True
    )

    return {"success": True, "username": username, "csrfToken": csrf_token}

# 4. Logout endpoint
@app.post("/api/auth/logout")
async def logout_user(request: Request, response: Response):
    session_id = request.cookies.get("web_canvas_session")
    if session_id:
        sessions = load_json_file(SESSIONS_FILE)
        if session_id in sessions:
            del sessions[session_id]
            save_json_file(SESSIONS_FILE, sessions)

    response.delete_cookie(key="web_canvas_session", path="/")
    return {"success": True}


# ============================================================
# NEW BOOK/DOCUMENT API (SQLite + Content Files)
# ============================================================

# ── List Books ─────────────────────────────────────────────────────────────────
@app.get("/api/books")
async def list_books(request: Request):
    username = get_authenticated_username(request)
    conn = get_db()
    try:
        rows = conn.execute(
            "SELECT id, title, updated_at FROM books WHERE username = ? ORDER BY updated_at DESC",
            (username,)
        ).fetchall()
        return [{"id": r["id"], "title": r["title"], "updatedAt": r["updated_at"]} for r in rows]
    finally:
        conn.close()

# ── Create Book ────────────────────────────────────────────────────────────────
@app.post("/api/books")
async def create_book(request: Request):
    username = get_authenticated_username(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    book_id = sanitize_id(body.get("id", f"book-{int(datetime.now().timestamp() * 1000)}"), "bookId")
    title = body.get("title", "New Book")
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    conn = get_db()
    try:
        # Create book
        conn.execute(
            "INSERT INTO books (id, username, title, active_document_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (book_id, username, title, "", now, now)
        )

        # Create default document if provided
        documents = body.get("documents", [])
        for idx, doc in enumerate(documents):
            doc_id = sanitize_id(doc.get("id", f"doc-{int(datetime.now().timestamp() * 1000)}-{idx}"), "docId")
            doc_title = doc.get("title", f"Chapter {idx + 1}")
            doc_content = doc.get("content", "")
            doc_created = doc.get("createdAt", now)
            doc_updated = doc.get("updatedAt", now)

            conn.execute(
                "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (doc_id, username, book_id, doc_title, idx, doc_created, doc_updated)
            )
            save_document_content(username, book_id, doc_id, doc_content)

        # Set active document
        active_doc_id = body.get("activeDocumentId", documents[0]["id"] if documents else "")
        if active_doc_id:
            conn.execute(
                "UPDATE books SET active_document_id = ? WHERE username = ? AND id = ?",
                (active_doc_id, username, book_id)
            )

        # Save settings to global (upsert — settings are user-level)
        settings_fields = ["activeProvider", "providerConfigs", "customSystemPrompts",
                          "activeSystemPromptId", "theme", "debugMode"]
        if any(k in body for k in settings_fields):
            conn.execute(
                """INSERT INTO book_settings (username, book_id, active_provider, provider_configs,
                   custom_system_prompts, active_system_prompt_id, theme, debug_mode)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(username, book_id) DO UPDATE SET
                   active_provider = COALESCE(excluded.active_provider, book_settings.active_provider),
                   provider_configs = COALESCE(excluded.provider_configs, book_settings.provider_configs),
                   custom_system_prompts = COALESCE(excluded.custom_system_prompts, book_settings.custom_system_prompts),
                   active_system_prompt_id = COALESCE(excluded.active_system_prompt_id, book_settings.active_system_prompt_id),
                   theme = COALESCE(excluded.theme, book_settings.theme),
                   debug_mode = COALESCE(excluded.debug_mode, book_settings.debug_mode)
                """,
                (
                    username, GLOBAL_SETTINGS_BOOK_ID,
                    body.get("activeProvider"),
                    json.dumps(body.get("providerConfigs")) if body.get("providerConfigs") else None,
                    json.dumps(body.get("customSystemPrompts")) if body.get("customSystemPrompts") else None,
                    body.get("activeSystemPromptId"),
                    body.get("theme"),
                    (1 if body.get("debugMode") else 0) if "debugMode" in body else None
                )
            )

        # Save initial messages
        messages = body.get("messages", [])
        for idx, msg in enumerate(messages):
            msg_id = msg.get("id", f"msg-{int(datetime.now().timestamp() * 1000)}-{idx}")
            conn.execute(
                """INSERT INTO messages (id, username, book_id, role, content, timestamp,
                   thinking, model, input_tokens, output_tokens, cache_hit_tokens, sort_order)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    msg_id, username, book_id,
                    msg.get("role", "assistant"),
                    msg.get("content", ""),
                    msg.get("timestamp", now),
                    msg.get("thinking"),
                    msg.get("model"),
                    msg.get("inputTokens"),
                    msg.get("outputTokens"),
                    msg.get("cacheHitTokens"),
                    idx
                )
            )

        conn.commit()
        return {"success": True, "id": book_id}
    except sqlite3.IntegrityError:
        raise HTTPException(status_code=409, detail="Book already exists.")
    finally:
        conn.close()


# ── Get Book (metadata + document list + settings, NO content) ─────────────────
@app.get("/api/books/{book_id}")
async def get_book(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")

    conn = get_db()
    try:
        book = conn.execute(
            "SELECT * FROM books WHERE username = ? AND id = ?",
            (username, safe_book_id)
        ).fetchone()
        if not book:
            return {}

        # Get document list (metadata only, no content). Every column read in
        # the response below must be listed here — sqlite3.Row raises
        # IndexError for an unselected column, which 500s the whole endpoint
        # (this is how `summary`/`summary_content_hash` broke book switching).
        docs = conn.execute(
            "SELECT id, title, sort_order, created_at, updated_at, summary, summary_content_hash "
            "FROM documents WHERE username = ? AND book_id = ? ORDER BY sort_order",
            (username, safe_book_id)
        ).fetchall()

        # Get global user settings (shared across all books)
        settings = conn.execute(
            "SELECT * FROM book_settings WHERE username = ? AND book_id = ?",
            (username, GLOBAL_SETTINGS_BOOK_ID)
        ).fetchone()

        # Get versions
        versions = conn.execute(
            "SELECT id, document_id, title, timestamp FROM versions WHERE username = ? AND book_id = ? ORDER BY timestamp DESC",
            (username, safe_book_id)
        ).fetchall()

        # Get messages
        msgs = conn.execute(
            "SELECT * FROM messages WHERE username = ? AND book_id = ? ORDER BY sort_order",
            (username, safe_book_id)
        ).fetchall()

        result = {
            "bookTitle": book["title"],
            "activeDocumentId": book["active_document_id"],
            "updatedAt": book["updated_at"],
            "documents": [
                {
                    "id": d["id"],
                    "title": d["title"],
                    "sortOrder": d["sort_order"],
                    "createdAt": d["created_at"],
                    "updatedAt": d["updated_at"],
                    "summary": d["summary"],
                    "summaryContentHash": d["summary_content_hash"],
                }
                for d in docs
            ],
            "versions": [
                {
                    "id": v["id"],
                    "documentId": v["document_id"],
                    "title": v["title"],
                    "timestamp": v["timestamp"],
                }
                for v in versions
            ],
            "messages": [
                {
                    "id": m["id"],
                    "role": m["role"],
                    "content": m["content"],
                    "timestamp": m["timestamp"],
                    **({"thinking": m["thinking"]} if m["thinking"] else {}),
                    **({"model": m["model"]} if m["model"] else {}),
                    **({"inputTokens": m["input_tokens"]} if m["input_tokens"] else {}),
                    **({"outputTokens": m["output_tokens"]} if m["output_tokens"] else {}),
                    **({"cacheHitTokens": m["cache_hit_tokens"]} if m["cache_hit_tokens"] else {}),
                }
                for m in msgs
            ],
        }

        # Add settings if they exist
        if settings:
            if settings["active_provider"]:
                result["activeProvider"] = settings["active_provider"]
            if settings["provider_configs"]:
                try:
                    result["providerConfigs"] = json.loads(settings["provider_configs"])
                except Exception:
                    pass
            if settings["custom_system_prompts"]:
                try:
                    result["customSystemPrompts"] = json.loads(settings["custom_system_prompts"])
                except Exception:
                    pass
            if settings["active_system_prompt_id"]:
                result["activeSystemPromptId"] = settings["active_system_prompt_id"]
            if settings["theme"]:
                result["theme"] = settings["theme"]
            result["debugMode"] = bool(settings["debug_mode"])

        return result
    finally:
        conn.close()


# ── Update Book (metadata + settings) ─────────────────────────────────────────
@app.put("/api/books/{book_id}")
async def update_book(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn = get_db()
    try:
        # Ensure book exists
        book = conn.execute(
            "SELECT id FROM books WHERE username = ? AND id = ?",
            (username, safe_book_id)
        ).fetchone()
        if not book:
            raise HTTPException(status_code=404, detail="Book not found.")

        # Update book metadata
        updates = []
        params = []
        if "bookTitle" in body:
            updates.append("title = ?")
            params.append(body["bookTitle"])
        if "activeDocumentId" in body:
            updates.append("active_document_id = ?")
            params.append(body["activeDocumentId"])
        updates.append("updated_at = ?")
        params.append(now)
        params.extend([username, safe_book_id])

        conn.execute(
            f"UPDATE books SET {', '.join(updates)} WHERE username = ? AND id = ?",
            params
        )

        # Update global settings (upsert) — settings are user-level, shared across all books
        settings_fields = ["activeProvider", "providerConfigs", "customSystemPrompts",
                          "activeSystemPromptId", "theme", "debugMode"]
        has_settings = any(k in body for k in settings_fields)
        if has_settings:
            conn.execute(
                """INSERT INTO book_settings (username, book_id, active_provider, provider_configs,
                   custom_system_prompts, active_system_prompt_id, theme, debug_mode)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(username, book_id) DO UPDATE SET
                   active_provider = COALESCE(excluded.active_provider, book_settings.active_provider),
                   provider_configs = COALESCE(excluded.provider_configs, book_settings.provider_configs),
                   custom_system_prompts = COALESCE(excluded.custom_system_prompts, book_settings.custom_system_prompts),
                   active_system_prompt_id = COALESCE(excluded.active_system_prompt_id, book_settings.active_system_prompt_id),
                   theme = COALESCE(excluded.theme, book_settings.theme),
                   debug_mode = COALESCE(excluded.debug_mode, book_settings.debug_mode)
                """,
                (
                    username, GLOBAL_SETTINGS_BOOK_ID,
                    body.get("activeProvider"),
                    json.dumps(body["providerConfigs"]) if "providerConfigs" in body else None,
                    json.dumps(body["customSystemPrompts"]) if "customSystemPrompts" in body else None,
                    body.get("activeSystemPromptId"),
                    body.get("theme"),
                    (1 if body["debugMode"] else 0) if "debugMode" in body else None
                )
            )

        # Update messages if provided (full replace)
        if "messages" in body:
            conn.execute(
                "DELETE FROM messages WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            )
            for idx, msg in enumerate(body["messages"]):
                msg_id = msg.get("id", f"msg-{int(datetime.now().timestamp() * 1000)}-{idx}")
                conn.execute(
                    """INSERT INTO messages (id, username, book_id, role, content, timestamp,
                       thinking, model, input_tokens, output_tokens, cache_hit_tokens, sort_order)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        msg_id, username, safe_book_id,
                        msg.get("role", "assistant"),
                        msg.get("content", ""),
                        msg.get("timestamp", now),
                        msg.get("thinking"),
                        msg.get("model"),
                        msg.get("inputTokens"),
                        msg.get("outputTokens"),
                        msg.get("cacheHitTokens"),
                        idx
                    )
                )

        # Update document ordering if provided
        if "documentOrder" in body:
            doc_ids = body["documentOrder"]
            for idx, doc_id in enumerate(doc_ids):
                safe_doc_id = sanitize_id(doc_id, "docId")
                conn.execute(
                    "UPDATE documents SET sort_order = ? WHERE username = ? AND book_id = ? AND id = ?",
                    (idx, username, safe_book_id, safe_doc_id)
                )

        conn.commit()
        return {"success": True}
    finally:
        conn.close()


# ── Delete Book ────────────────────────────────────────────────────────────────
@app.delete("/api/books/{book_id}")
async def delete_book_endpoint(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")

    conn = get_db()
    try:
        conn.execute("DELETE FROM books WHERE username = ? AND id = ?", (username, safe_book_id))
        conn.execute("DELETE FROM book_settings WHERE username = ? AND book_id = ?", (username, safe_book_id))
        conn.execute("DELETE FROM messages WHERE username = ? AND book_id = ?", (username, safe_book_id))
        # documents and versions cascade-deleted via FK
        conn.commit()
    finally:
        conn.close()

    # Delete content files
    delete_book_content_dir(username, safe_book_id)
    return {"success": True}


# ── Get Document Content ───────────────────────────────────────────────────────
@app.get("/api/books/{book_id}/documents/{doc_id}")
async def get_document(request: Request, book_id: str, doc_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    safe_doc_id = sanitize_id(doc_id, "docId")

    conn = get_db()
    try:
        doc = conn.execute(
            "SELECT * FROM documents WHERE username = ? AND book_id = ? AND id = ?",
            (username, safe_book_id, safe_doc_id)
        ).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found.")
    finally:
        conn.close()

    content = load_document_content(username, safe_book_id, safe_doc_id)
    return {
        "id": doc["id"],
        "title": doc["title"],
        "content": content,
        "sortOrder": doc["sort_order"],
        "createdAt": doc["created_at"],
        "updatedAt": doc["updated_at"],
        "summary": doc["summary"],
        "summaryContentHash": doc["summary_content_hash"],
    }


# ── Save Document Content ─────────────────────────────────────────────────────
@app.put("/api/books/{book_id}/documents/{doc_id}")
async def update_document(request: Request, book_id: str, doc_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    safe_doc_id = sanitize_id(doc_id, "docId")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn = get_db()
    try:
        # Ensure document exists
        doc = conn.execute(
            "SELECT id FROM documents WHERE username = ? AND book_id = ? AND id = ?",
            (username, safe_book_id, safe_doc_id)
        ).fetchone()
        if not doc:
            raise HTTPException(status_code=404, detail="Document not found.")

        # Update metadata fields
        updates = []
        params = []
        if "title" in body:
            updates.append("title = ?")
            params.append(body["title"])
        if "summary" in body:
            updates.append("summary = ?")
            params.append(body["summary"])
        if "summaryContentHash" in body:
            updates.append("summary_content_hash = ?")
            params.append(body["summaryContentHash"])
        updates.append("updated_at = ?")
        params.append(now)
        params.extend([username, safe_book_id, safe_doc_id])

        conn.execute(
            f"UPDATE documents SET {', '.join(updates)} WHERE username = ? AND book_id = ? AND id = ?",
            params
        )

        # Also update book's updated_at
        conn.execute(
            "UPDATE books SET updated_at = ? WHERE username = ? AND id = ?",
            (now, username, safe_book_id)
        )

        conn.commit()
    finally:
        conn.close()

    # Save content to file
    if "content" in body:
        save_document_content(username, safe_book_id, safe_doc_id, body["content"])

    return {"success": True}


# ── Batch Create/Replace Documents ─────────────────────────────────────────────
@app.post("/api/books/{book_id}/documents")
async def create_documents(request: Request, book_id: str):
    """Create or batch-replace documents in a book."""
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    documents = body.get("documents", [])
    replace_all = body.get("replaceAll", False)
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    conn = get_db()
    try:
        # Ensure book exists
        book = conn.execute(
            "SELECT id FROM books WHERE username = ? AND id = ?",
            (username, safe_book_id)
        ).fetchone()
        if not book:
            raise HTTPException(status_code=404, detail="Book not found.")

        if replace_all:
            # Delete existing documents
            existing_docs = conn.execute(
                "SELECT id FROM documents WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            ).fetchall()
            for d in existing_docs:
                delete_document_content(username, safe_book_id, d["id"])
            conn.execute(
                "DELETE FROM documents WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            )

        created_ids = []
        for idx, doc in enumerate(documents):
            doc_id = sanitize_id(doc.get("id", f"doc-{int(datetime.now().timestamp() * 1000)}-{idx}"), "docId")
            doc_title = doc.get("title", f"Chapter {idx + 1}")
            doc_content = doc.get("content", "")
            doc_created = doc.get("createdAt", now)
            doc_updated = doc.get("updatedAt", now)

            # Determine sort order
            if replace_all:
                sort_order = idx
            else:
                max_order = conn.execute(
                    "SELECT COALESCE(MAX(sort_order), -1) as m FROM documents WHERE username = ? AND book_id = ?",
                    (username, safe_book_id)
                ).fetchone()["m"]
                sort_order = max_order + 1 + idx

            conn.execute(
                "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at, summary, summary_content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (doc_id, username, safe_book_id, doc_title, sort_order, doc_created, doc_updated,
                 doc.get("summary"), doc.get("summaryContentHash"))
            )
            save_document_content(username, safe_book_id, doc_id, doc_content)
            created_ids.append(doc_id)

        # Update book updated_at
        conn.execute(
            "UPDATE books SET updated_at = ? WHERE username = ? AND id = ?",
            (now, username, safe_book_id)
        )

        conn.commit()
        return {"success": True, "ids": created_ids}
    finally:
        conn.close()


# ── Delete Document ────────────────────────────────────────────────────────────
@app.delete("/api/books/{book_id}/documents/{doc_id}")
async def delete_document_endpoint(request: Request, book_id: str, doc_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    safe_doc_id = sanitize_id(doc_id, "docId")

    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM documents WHERE username = ? AND book_id = ? AND id = ?",
            (username, safe_book_id, safe_doc_id)
        )
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        conn.execute(
            "UPDATE books SET updated_at = ? WHERE username = ? AND id = ?",
            (now, username, safe_book_id)
        )
        conn.commit()
    finally:
        conn.close()

    delete_document_content(username, safe_book_id, safe_doc_id)
    return {"success": True}


# ── Reorder Documents ──────────────────────────────────────────────────────────
@app.put("/api/books/{book_id}/documents/reorder")
async def reorder_documents(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    doc_ids = body.get("documentIds", [])
    if not doc_ids:
        raise HTTPException(status_code=400, detail="documentIds is required.")

    conn = get_db()
    try:
        for idx, doc_id in enumerate(doc_ids):
            safe_doc_id = sanitize_id(doc_id, "docId")
            conn.execute(
                "UPDATE documents SET sort_order = ? WHERE username = ? AND book_id = ? AND id = ?",
                (idx, username, safe_book_id, safe_doc_id)
            )
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        conn.execute(
            "UPDATE books SET updated_at = ? WHERE username = ? AND id = ?",
            (now, username, safe_book_id)
        )
        conn.commit()
        return {"success": True}
    finally:
        conn.close()


# ── Get Version Content ────────────────────────────────────────────────────────
@app.get("/api/books/{book_id}/versions/{version_id}")
async def get_version(request: Request, book_id: str, version_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    safe_ver_id = sanitize_id(version_id, "versionId")

    conn = get_db()
    try:
        ver = conn.execute(
            "SELECT * FROM versions WHERE username = ? AND book_id = ? AND id = ?",
            (username, safe_book_id, safe_ver_id)
        ).fetchone()
        if not ver:
            raise HTTPException(status_code=404, detail="Version not found.")
    finally:
        conn.close()

    content = load_version_content(username, safe_book_id, safe_ver_id)
    return {
        "id": ver["id"],
        "documentId": ver["document_id"],
        "title": ver["title"],
        "timestamp": ver["timestamp"],
        "content": content,
    }


# ── Create Version Snapshot ────────────────────────────────────────────────────
@app.post("/api/books/{book_id}/versions")
async def create_version(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    ver_id = sanitize_id(body.get("id", f"ver-{int(datetime.now().timestamp() * 1000)}"), "versionId")
    doc_id = body.get("documentId", "")
    title = body.get("title", "Untitled Version")
    content = body.get("content", "")
    timestamp = body.get("timestamp", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))

    conn = get_db()
    try:
        conn.execute(
            "INSERT INTO versions (id, username, book_id, document_id, title, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            (ver_id, username, safe_book_id, doc_id, title, timestamp)
        )
        conn.commit()
    finally:
        conn.close()

    save_version_content(username, safe_book_id, ver_id, content)
    return {"success": True, "id": ver_id}


# ── Delete Version ─────────────────────────────────────────────────────────────
@app.delete("/api/books/{book_id}/versions/{version_id}")
async def delete_version(request: Request, book_id: str, version_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    safe_ver_id = sanitize_id(version_id, "versionId")

    conn = get_db()
    try:
        conn.execute(
            "DELETE FROM versions WHERE username = ? AND book_id = ? AND id = ?",
            (username, safe_book_id, safe_ver_id)
        )
        conn.commit()
    finally:
        conn.close()

    # Delete version content file
    content_dir = _get_content_dir(username, safe_book_id)
    ver_file = os.path.join(content_dir, f"ver-{safe_ver_id}.json")
    if os.path.exists(ver_file):
        os.remove(ver_file)

    return {"success": True}


# ============================================================
# LEGACY COMPATIBILITY — /api/storage shim
# ============================================================
# These endpoints allow the old frontend to continue working during
# the transition period. They internally delegate to the new SQLite layer.

@app.get("/api/storage")
async def get_storage_legacy(request: Request, bookId: str = "default"):
    """Legacy: load full book state (compatibility shim)."""
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(bookId, "bookId")

    conn = get_db()
    try:
        book = conn.execute(
            "SELECT * FROM books WHERE username = ? AND id = ?",
            (username, safe_book_id)
        ).fetchone()
        if not book:
            return {}

        # Get documents with content
        docs = conn.execute(
            "SELECT id, title, sort_order, created_at, updated_at FROM documents WHERE username = ? AND book_id = ? ORDER BY sort_order",
            (username, safe_book_id)
        ).fetchall()

        full_docs = []
        for d in docs:
            content = load_document_content(username, safe_book_id, d["id"])
            full_docs.append({
                "id": d["id"],
                "title": d["title"],
                "content": content,
                "createdAt": d["created_at"],
                "updatedAt": d["updated_at"],
            })

        # Get versions with content
        versions = conn.execute(
            "SELECT * FROM versions WHERE username = ? AND book_id = ? ORDER BY timestamp DESC",
            (username, safe_book_id)
        ).fetchall()
        full_versions = []
        for v in versions:
            content = load_version_content(username, safe_book_id, v["id"])
            full_versions.append({
                "id": v["id"],
                "documentId": v["document_id"],
                "title": v["title"],
                "timestamp": v["timestamp"],
                "content": content,
            })

        # Get global user settings (shared across all books)
        settings = conn.execute(
            "SELECT * FROM book_settings WHERE username = ? AND book_id = ?",
            (username, GLOBAL_SETTINGS_BOOK_ID)
        ).fetchone()

        # Get messages
        msgs = conn.execute(
            "SELECT * FROM messages WHERE username = ? AND book_id = ? ORDER BY sort_order",
            (username, safe_book_id)
        ).fetchall()

        result = {
            "bookTitle": book["title"],
            "documents": full_docs,
            "versions": full_versions,
            "activeDocumentId": book["active_document_id"],
            "messages": [
                {
                    "id": m["id"],
                    "role": m["role"],
                    "content": m["content"],
                    "timestamp": m["timestamp"],
                    **({"thinking": m["thinking"]} if m["thinking"] else {}),
                    **({"model": m["model"]} if m["model"] else {}),
                    **({"inputTokens": m["input_tokens"]} if m["input_tokens"] else {}),
                    **({"outputTokens": m["output_tokens"]} if m["output_tokens"] else {}),
                    **({"cacheHitTokens": m["cache_hit_tokens"]} if m["cache_hit_tokens"] else {}),
                }
                for m in msgs
            ],
        }

        if settings:
            if settings["active_provider"]:
                result["activeProvider"] = settings["active_provider"]
            if settings["provider_configs"]:
                try:
                    result["providerConfigs"] = json.loads(settings["provider_configs"])
                except Exception:
                    pass
            if settings["custom_system_prompts"]:
                try:
                    result["customSystemPrompts"] = json.loads(settings["custom_system_prompts"])
                except Exception:
                    pass
            if settings["active_system_prompt_id"]:
                result["activeSystemPromptId"] = settings["active_system_prompt_id"]
            if settings["theme"]:
                result["theme"] = settings["theme"]
            result["debugMode"] = bool(settings["debug_mode"])

        return result
    finally:
        conn.close()


@app.post("/api/storage")
async def save_storage_legacy(request: Request, bookId: str = "default"):
    """Legacy: save full book state (compatibility shim)."""
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(bookId, "bookId")

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body.")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn = get_db()
    try:
        # Upsert book
        book_title = body.get("bookTitle", "Untitled Book")
        active_doc_id = body.get("activeDocumentId", "")
        conn.execute(
            """INSERT INTO books (id, username, title, active_document_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(username, id) DO UPDATE SET
               title = excluded.title, active_document_id = excluded.active_document_id, updated_at = excluded.updated_at""",
            (safe_book_id, username, book_title, active_doc_id, now, now)
        )

        # Full replace documents
        if "documents" in body:
            # Delete existing
            existing_docs = conn.execute(
                "SELECT id FROM documents WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            ).fetchall()
            for d in existing_docs:
                delete_document_content(username, safe_book_id, d["id"])
            conn.execute(
                "DELETE FROM documents WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            )

            # Insert new
            for idx, doc in enumerate(body["documents"]):
                doc_id = doc.get("id", f"doc-{int(datetime.now().timestamp() * 1000)}-{idx}")
                doc_title = doc.get("title", f"Chapter {idx + 1}")
                doc_content = doc.get("content", "")
                doc_created = doc.get("createdAt", now)
                doc_updated = doc.get("updatedAt", now)

                conn.execute(
                    "INSERT INTO documents (id, username, book_id, title, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (doc_id, username, safe_book_id, doc_title, idx, doc_created, doc_updated)
                )
                save_document_content(username, safe_book_id, doc_id, doc_content)

        # Full replace versions
        if "versions" in body:
            conn.execute(
                "DELETE FROM versions WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            )
            for ver in body["versions"]:
                ver_id = ver.get("id", f"ver-{int(datetime.now().timestamp() * 1000)}")
                ver_doc_id = ver.get("documentId", "")
                ver_title = ver.get("title", "Untitled")
                ver_timestamp = ver.get("timestamp", now)
                ver_content = ver.get("content", "")

                conn.execute(
                    "INSERT INTO versions (id, username, book_id, document_id, title, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
                    (ver_id, username, safe_book_id, ver_doc_id, ver_title, ver_timestamp)
                )
                save_version_content(username, safe_book_id, ver_id, ver_content)

        # Upsert global settings
        conn.execute(
            """INSERT INTO book_settings (username, book_id, active_provider, provider_configs,
               custom_system_prompts, active_system_prompt_id, theme, debug_mode)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(username, book_id) DO UPDATE SET
               active_provider = excluded.active_provider,
               provider_configs = excluded.provider_configs,
               custom_system_prompts = excluded.custom_system_prompts,
               active_system_prompt_id = excluded.active_system_prompt_id,
               theme = excluded.theme,
               debug_mode = excluded.debug_mode
            """,
            (
                username, GLOBAL_SETTINGS_BOOK_ID,
                body.get("activeProvider"),
                json.dumps(body.get("providerConfigs")) if body.get("providerConfigs") else None,
                json.dumps(body.get("customSystemPrompts")) if body.get("customSystemPrompts") else None,
                body.get("activeSystemPromptId"),
                body.get("theme"),
                1 if body.get("debugMode") else 0
            )
        )

        # Full replace messages
        if "messages" in body:
            conn.execute(
                "DELETE FROM messages WHERE username = ? AND book_id = ?",
                (username, safe_book_id)
            )
            for idx, msg in enumerate(body["messages"]):
                msg_id = msg.get("id", f"msg-{int(datetime.now().timestamp() * 1000)}-{idx}")
                conn.execute(
                    """INSERT INTO messages (id, username, book_id, role, content, timestamp,
                       thinking, model, input_tokens, output_tokens, cache_hit_tokens, sort_order)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        msg_id, username, safe_book_id,
                        msg.get("role", "assistant"),
                        msg.get("content", ""),
                        msg.get("timestamp", now),
                        msg.get("thinking"),
                        msg.get("model"),
                        msg.get("inputTokens"),
                        msg.get("outputTokens"),
                        msg.get("cacheHitTokens"),
                        idx
                    )
                )

        conn.commit()
        return {"success": True}
    finally:
        conn.close()


# Legacy delete book endpoint (compatibility)
@app.post("/api/books/delete")
async def delete_book_legacy(request: Request):
    username = get_authenticated_username(request)
    try:
        body = await request.json()
        book_id = body.get("bookId")
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid payload.")

    if not book_id:
        raise HTTPException(status_code=400, detail="Missing bookId.")

    safe_book_id = sanitize_id(book_id, "bookId")

    conn = get_db()
    try:
        conn.execute("DELETE FROM books WHERE username = ? AND id = ?", (username, safe_book_id))
        conn.execute("DELETE FROM book_settings WHERE username = ? AND book_id = ?", (username, safe_book_id))
        conn.execute("DELETE FROM messages WHERE username = ? AND book_id = ?", (username, safe_book_id))
        conn.commit()
    finally:
        conn.close()

    delete_book_content_dir(username, safe_book_id)
    return {"success": True}


# ============================================================
# URL Import / Scraping endpoint
# ============================================================

# TODO(security): Consider adding rate limiting to prevent abuse of the scraping endpoint.

# SSRF prevention: block private/reserved IPs
def _is_private_ip(hostname: str) -> bool:
    """Check if a hostname resolves to a private or reserved IP address."""
    try:
        resolved = socket.getaddrinfo(hostname, None)
        for family, kind, proto, canonname, sockaddr in resolved:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_private or ip.is_reserved or ip.is_loopback or ip.is_link_local:
                return True
        return False
    except (socket.gaierror, ValueError):
        return True  # fail-closed: if we can't resolve, block it

MAX_IMAGES_DOWNLOAD = 100
MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024  # 5MB per image
SCRAPE_TIMEOUT = 30  # seconds
SCRAPE_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

@app.post("/api/import-url")
async def import_url(request: Request):
    """Scrape a URL and extract text paragraphs and images for novel generation."""
    username = get_authenticated_username(request)

    if not HAS_SCRAPING_DEPS:
        raise HTTPException(
            status_code=503,
            detail="Scraping dependencies (requests, beautifulsoup4) are not installed. "
                   "Run: pip install requests beautifulsoup4"
        )

    try:
        body = await request.json()
        url = body.get("url", "").strip()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    if not url:
        raise HTTPException(status_code=400, detail="URL is required.")

    # Validate URL protocol (allow only http and https)
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only HTTP and HTTPS URLs are allowed.")

    if not parsed.hostname:
        raise HTTPException(status_code=400, detail="Invalid URL: no hostname found.")

    # SSRF prevention: block private/reserved IP ranges
    if _is_private_ip(parsed.hostname):
        raise HTTPException(status_code=403, detail="Access to private/internal network addresses is not allowed.")

    # Fetch the page
    try:
        headers = {"User-Agent": SCRAPE_USER_AGENT}
        resp = http_requests.get(url, headers=headers, timeout=SCRAPE_TIMEOUT, allow_redirects=True)
        resp.raise_for_status()
    except http_requests.exceptions.Timeout:
        raise HTTPException(status_code=504, detail="Request timed out while fetching the URL.")
    except http_requests.exceptions.ConnectionError:
        raise HTTPException(status_code=502, detail="Could not connect to the target URL.")
    except http_requests.exceptions.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"HTTP error from target: {e.response.status_code if e.response else 'unknown'}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to fetch URL: {str(e)}")

    # Detect encoding
    resp.encoding = resp.apparent_encoding or 'utf-8'
    html_content = resp.text

    try:
        data = _parse_html_to_scraped_data(html_content, url)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse scraped content: {str(e)}")

def _resize_and_convert_to_jpeg(image_bytes: bytes) -> bytes:
    """Resize image to a maximum width of 800px and convert to a static single-frame JPEG using ffmpeg."""
    import subprocess
    cmd = [
        '/usr/bin/ffmpeg',
        '-loglevel', 'error',
        '-i', 'pipe:0',
        '-vf', "scale='min(800,iw)':-1",
        '-vframes', '1',
        '-f', 'image2',
        '-y', 'pipe:1'
    ]
    try:
        process = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE
        )
        out, err = process.communicate(input=image_bytes, timeout=10)
        if len(out) > 0:
            return out
    except Exception as e:
        print(f"[API Server] ffmpeg image conversion failed: {e}")
    return image_bytes

def _parse_html_to_scraped_data(html_content: str, url: str = None) -> dict:
    soup = BeautifulSoup(html_content, "html.parser")

    title_tag = soup.find("title")
    page_title = title_tag.get_text(strip=True) if title_tag else "Untitled"

    for tag in soup.find_all(["script", "style", "nav", "footer", "header", "aside", "noscript"]):
        tag.decompose()

    paragraphs = []
    images = []

    body_tag = soup.find("body") or soup

    for element in body_tag.descendants:
        if element.name in ("p", "div", "td", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "span", "article", "section"):
            text = element.get_text(strip=True)
            if text and len(text) > 5:
                if not paragraphs or paragraphs[-1]["text"] != text:
                    paragraphs.append({
                        "index": len(paragraphs),
                        "text": text,
                        "tag": element.name
                    })
        elif element.name == "img":
            attrs_to_check = [
                element.get("ess-data"),
                element.get("file"),
                element.get("data-src"),
                element.get("data-original"),
                element.get("data-lazy-src"),
                element.get("data-original-src"),
                element.get("src")
            ]
            attrs = [a.strip() for a in attrs_to_check if a and a.strip()]

            src = ""
            for attr in attrs:
                if attr.startswith("data:"):
                    lower = attr.lower()
                    if "image/svg+xml" in lower:
                        continue
                    if "image/gif" in lower and len(attr) < 200:
                        continue
                    src = attr
                    break

            if not src:
                for attr in attrs:
                    if attr and not attr.startswith("data:"):
                        src = attr
                        break

            alt = element.get("alt", "")
            if src and len(images) < 500:
                abs_src = urljoin(url, src) if url else src
                abs_parsed = urlparse(abs_src)
                if abs_parsed.scheme in ("http", "https"):
                    images.append({
                        "url": abs_src,
                        "alt": alt or "",
                        "position": len(paragraphs),
                        "base64": None
                    })
                elif abs_src.startswith("data:image/"):
                    is_gif = abs_src.startswith("data:image/gif")
                    limit_bytes = 50 * 1024 * 1024 if is_gif else MAX_IMAGE_SIZE_BYTES
                    if len(abs_src) <= limit_bytes * 1.37:
                        try:
                            parts = abs_src.split(";base64,", 1)
                            if len(parts) == 2:
                                header, b64_data = parts
                                raw_bytes = base64.b64decode(b64_data)
                                if is_gif or len(raw_bytes) > 1 * 1024 * 1024:
                                    converted_bytes = _resize_and_convert_to_jpeg(raw_bytes)
                                    converted_b64 = base64.b64encode(converted_bytes).decode("ascii")
                                    abs_src = f"data:image/jpeg;base64,{converted_b64}"
                        except Exception as e:
                            print(f"[API Server] Failed to convert inline base64 image: {e}")
                        images.append({
                            "alt": alt or "",
                            "position": len(paragraphs),
                            "base64": abs_src
                        })

    from concurrent.futures import ThreadPoolExecutor

    def download_image(img):
        if img.get("base64") is not None:
            return
        try:
            img_resp = http_requests.get(
                img["url"],
                headers={"User-Agent": SCRAPE_USER_AGENT},
                timeout=5,
                stream=True
            )
            img_resp.raise_for_status()

            content_type = img_resp.headers.get("Content-Type", "image/jpeg")
            if not content_type.startswith("image/"):
                parsed_url = urlparse(img.get("url", ""))
                path = parsed_url.path.lower()
                if not any(path.endswith(ext) for ext in (".jpg", ".jpeg", ".png", ".webp", ".gif")):
                    return
                if path.endswith(".png"):
                    content_type = "image/png"
                elif path.endswith(".webp"):
                    content_type = "image/webp"
                elif path.endswith(".gif"):
                    content_type = "image/gif"
                else:
                    content_type = "image/jpeg"

            is_gif = (content_type == "image/gif")
            limit_bytes = 50 * 1024 * 1024 if is_gif else MAX_IMAGE_SIZE_BYTES

            content = b""
            is_first = True
            is_html = False
            for chunk in img_resp.iter_content(chunk_size=8192):
                if is_first:
                    is_first = False
                    trimmed = chunk.lstrip()
                    if trimmed.startswith(b"<!doctype") or trimmed.startswith(b"<html") or trimmed.startswith(b"<!DOCTYPE") or trimmed.startswith(b"<HTML"):
                        is_html = True
                        break
                content += chunk
                if len(content) > limit_bytes:
                    content = None
                    break

            if is_html:
                print(f"[Import URL] Image {img.get('url')} returned HTML instead of binary image data. Skipping.")
                return

            if content:
                if is_gif or len(content) > 1 * 1024 * 1024:
                    converted_content = _resize_and_convert_to_jpeg(content)
                    b64 = base64.b64encode(converted_content).decode("ascii")
                    img["base64"] = f"data:image/jpeg;base64,{b64}"
                else:
                    b64 = base64.b64encode(content).decode("ascii")
                    img["base64"] = f"data:{content_type};base64,{b64}"
        except Exception as e:
            print(f"[Import URL] Failed to download image {img.get('url')}: {e}")

    downloadable_images = [img for img in images if img.get("base64") is None and img.get("url")]
    successful_images = [img for img in images if img.get("base64") is not None]

    batch_size = 50
    i = 0
    while len(successful_images) < MAX_IMAGES_DOWNLOAD and i < len(downloadable_images):
        batch = downloadable_images[i:i+batch_size]
        i += batch_size

        with ThreadPoolExecutor(max_workers=10) as executor:
            executor.map(download_image, batch)

        for img in batch:
            if img.get("base64"):
                successful_images.append(img)
                if len(successful_images) >= MAX_IMAGES_DOWNLOAD:
                    break

    successful_images.sort(key=lambda x: x["position"])
    successful_images = successful_images[:MAX_IMAGES_DOWNLOAD]

    for index, img in enumerate(successful_images):
        img["index"] = index
        if "url" in img:
            del img["url"]

    return {
        "title": page_title,
        "paragraphs": paragraphs,
        "images": successful_images,
        "totalParagraphs": len(paragraphs),
        "totalImages": len(successful_images)
    }

@app.post("/api/import-file")
async def import_file(request: Request):
    """Parse an uploaded HTML file content to extract text paragraphs and images."""
    username = get_authenticated_username(request)

    if not HAS_SCRAPING_DEPS:
        raise HTTPException(
            status_code=503,
            detail="Scraping dependencies (requests, beautifulsoup4) are not installed."
        )

    try:
        html_bytes = await request.body()
        html_text = html_bytes.decode("utf-8", errors="ignore")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read file payload: {str(e)}")

    if not html_text:
        raise HTTPException(status_code=400, detail="HTML content is empty.")

    try:
        data = _parse_html_to_scraped_data(html_text)
        return data
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to parse HTML file: {str(e)}")

if __name__ == "__main__":
    import uvicorn
    print(f"[Storage Server] Listening on http://{args.host}:{args.port}")
    print(f"[Storage Server] Storage directory: {STORAGE_DIR}")
    print(f"[Storage Server] Database: {DB_PATH}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")
