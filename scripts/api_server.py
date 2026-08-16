"""Web Canvas backend entry point: FastAPI app + books/documents/versions routes.

The helper layers live in focused sibling modules (scripts/ is NOT a package;
running `python3 scripts/api_server.py` puts this directory on sys.path, so
plain sibling imports work — the pytest flow does the same via sys.path.append):

- server_config    — CLI args, storage paths, JSON-file + validation helpers
- server_db        — SQLite path/pragmas, get_db, init_db (schema migrations)
- server_content   — document/version content-file save/load/delete
- server_auth      — sessions, CSRF middleware, /api/auth/* endpoints
- server_scrape    — URL/HTML scraping pipeline, /api/import-url, /api/import-file
- server_generation — resumable LLM generation jobs, /api/generate/*
- server_migration — one-time legacy state_*.json migration

Note for tests: patch state on the module that OWNS it (server_db.DB_PATH,
server_auth.SESSIONS_FILE, server_scrape.http_requests) — patching an alias
re-exported here would not affect the executing code.
"""

import os
import sys
import json
import logging
import sqlite3
from datetime import datetime, timezone
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware

import server_config
import server_auth
import server_db
import server_scrape
import server_generation
from server_config import sanitize_id
from server_db import get_db, init_db, GLOBAL_SETTINGS_BOOK_ID
from server_auth import get_authenticated_username
from server_content import (
    _get_content_dir,
    save_document_content,
    load_document_content,
    delete_document_content,
    save_version_content,
    load_version_content,
    delete_book_content_dir,
)
from server_migration import migrate_legacy_files

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

# ── Initialize DB and run migration on startup ────────────────────────────────
init_db()
migrate_legacy_files()

# CSRF middleware + auth (/api/auth/*) and scraping (/api/import-*) routes
app.middleware("http")(server_auth.csrf_middleware)
app.include_router(server_auth.router)
app.include_router(server_scrape.router)
# Resumable server-side generation jobs (/api/generate/*)
app.include_router(server_generation.router)


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
        # Return the server-side timestamp so the client can tell ITS OWN write
        # apart from another device's. Comparing a server timestamp against
        # the client clock is unreliable — devices drift by minutes — and a
        # false "someone else changed this" verdict forces a full reload.
        return {"success": True, "updatedAt": now}
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


def _configure_app_logging() -> None:
    """Let this app's own INFO lines through.

    Problem: nothing this server logged with logger.info ever reached the log —
      time-to-first-token, job starts, all silently dropped.
    Root cause: uvicorn.run(log_level="warning") configures the ROOT logger at
      WARNING, and every "web_canvas.*" logger inherits it.
    Fix: give the app namespace its own INFO handler on stdout (which
      start.sh redirects into app.log). uvicorn's access-log noise stays off,
      because only this namespace is raised.
    """
    app_logger = logging.getLogger("web_canvas")
    app_logger.setLevel(logging.INFO)
    if not app_logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(message)s"))
        app_logger.addHandler(handler)
    # Already handled here; do not also bubble up to whatever uvicorn installs.
    app_logger.propagate = False


if __name__ == "__main__":
    import uvicorn
    _configure_app_logging()
    print(f"[Storage Server] Listening on http://{server_config.args.host}:{server_config.args.port}")
    print(f"[Storage Server] Storage directory: {server_config.STORAGE_DIR}")
    print(f"[Storage Server] Database: {server_db.DB_PATH}")
    uvicorn.run(app, host=server_config.args.host, port=server_config.args.port, log_level="warning")
