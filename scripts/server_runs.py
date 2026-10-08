"""The server-side run engine (backend_authority.md §2.3, §4.3).

A run is one chat turn executed on the server: the request is assembled
here (server_context), each step is a generation job (server_generation),
the tools write the document store (server_documents), and everything the
browser needs to render it arrives as `run.*` events on the book's event
stream (server_events). A run survives the tab: its state is persisted
after every step, so an API restart resumes it at its last completed step.

One run at a time per book; further requests queue. A run that does no
useful work is paused, never killed (the "Runaway runs" decision).

Exposes `engine` (the per-process RunEngine) and `router` (/api/books/{id}/runs*).
"""
import asyncio
import json
import logging
import secrets
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request

import server_context
import server_documents
import server_events
import server_generation
from server_auth import get_authenticated_username
from server_config import sanitize_id
from server_content import load_document_content
from server_db import get_db
from wc_agent.polish import analyze_in_batches, default_polish_model, polish_html
from wc_agent.registry import ToolRegistry, to_tool_specs
from wc_agent.run import AgentRun, StepOutput
from wc_agent.tools.analyze_book import analyze_book_tool
from wc_agent.tools.ask_user import ask_user_tool
from wc_agent.tools.book_reads import BOOK_TOOLS
from wc_agent.tools.document_writes import DOCUMENT_WRITE_TOOLS, preview_rewrite
from wc_agent.tools.plan import plan_tool
from wc_agent.tools.polish_chapter import polish_chapter_tool
from wc_agent.types import ToolContext, chapter_outline, create_run_state
from wc_text.reminders import REPEAT_PAUSE_STEPS, queued_request_reminder, structure_changed_reminder, user_edited_reminder
from wc_text.chapter_index import WHOLE_BOOK_CONTEXT_CHARS
from wc_text.document_tools import to_openai_tools
from wc_text.image_preservation import replace_images_with_placeholders, restore_image_placeholders
from wc_text.jsstr import js_trim
from wc_text.stream_handlers import ASSISTANT_PLACEHOLDER, build_completion_warnings, split_streaming_response
from wc_text.text import strip_incomplete_end_tag, trim_incomplete_html_tail
from wc_text.tool_call_stream import finish_tool_calls

logger = logging.getLogger("web_canvas.runs")
router = APIRouter()

CHAT_TOOLS = ToolRegistry([*DOCUMENT_WRITE_TOOLS, *BOOK_TOOLS, polish_chapter_tool, analyze_book_tool, plan_tool, ask_user_tool])

# ── Limits (the "Runaway runs" decision) ─────────────────────────────────────
#: Steps that repeated the same calls and wrote nothing before the run is
#: paused — after the loop's own nudge at REPEAT_NUDGE_STEPS (wc_text.reminders).
REPEAT_STEPS = REPEAT_PAUSE_STEPS
#: Steps shown in a pause notice, for the user to judge.
PAUSE_DETAIL_STEPS = 3
#: Steps a run may take with no tab attached to the book before it pauses on
#: its own; the user's own limit applies while someone is watching.
UNATTENDED_STEP_CEILING = 12
#: Finished runs stay listed this long, so a reloading tab can settle its bubble.
FINISHED_RUN_TTL_SECONDS = 10 * 60
PREVIEW_THROTTLE_S = 0.25
SELECTION_PREVIEW_THROTTLE_S = 0.06
SPLIT_THROTTLE_S = 0.1
ACTIVE_STATUSES = ("queued", "running", "paused")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class RunStopped(Exception):
    """The step in flight was aborted by a stop request."""


class RunFailed(Exception):
    """The provider failed the step."""


# ── Persistence ──────────────────────────────────────────────────────────────

def ensure_tables() -> None:
    conn = get_db()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                book_id TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                finished_at TEXT,
                request TEXT NOT NULL,
                snapshot TEXT,
                record TEXT,
                result TEXT,
                pause TEXT,
                error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_runs_book ON runs(username, book_id, status);
            CREATE TABLE IF NOT EXISTS run_books (
                username TEXT NOT NULL, book_id TEXT NOT NULL, queue_held INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (username, book_id)
            );
        """)
        conn.commit()
    finally:
        conn.close()
    server_context.ensure_tables()


class Run:
    """One run's persisted state plus what only lives while it executes."""

    def __init__(self, run_id: str, username: str, book_id: str, request: Dict[str, Any], status: str = "queued",
                 created_at: Optional[str] = None) -> None:
        self.id = run_id
        self.username = username
        self.book_id = book_id
        self.request = request
        self.status = status
        self.created_at = created_at or _now_iso()
        self.updated_at = self.created_at
        self.finished_at: Optional[str] = None
        self.snapshot: Optional[Dict[str, Any]] = None
        self.record: Dict[str, Any] = {"status": "running", "steps": 0, "trace": [], "touched": [], "timeline": []}
        self.result: Optional[Dict[str, Any]] = None
        self.pause: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None
        # Live only
        self.task: Optional[asyncio.Task] = None
        self.agent: Optional[AgentRun] = None
        self.ports: Optional["ServerPorts"] = None
        self.job: Optional[server_generation.GenerationJob] = None
        self.live_text = ""
        self.live_reasoning = ""
        self.reasoning_heads: List[str] = []
        self.unattended_steps = 0
        self.snapshots: List[Dict[str, Any]] = []
        self.last_response_items: List[Any] = []
        self.finished_monotonic: Optional[float] = None
        self.stop_requested = False

    def summary(self) -> Dict[str, Any]:
        return {
            "id": self.id, "bookId": self.book_id, "status": self.status, "createdAt": self.created_at, "updatedAt": self.updated_at,
            "finishedAt": self.finished_at, "userMessageId": self.request.get("userMessageId"),
            "assistantMessageId": self.request.get("assistantMessageId"), "prompt": self.request.get("prompt"),
            "activeDocumentId": self.request.get("activeDocumentId"), "selectedText": self.request.get("selectedText") or "",
            "clientId": self.request.get("clientId"), "record": self.record, "pause": self.pause, "error": self.error,
        }

    def detail(self) -> Dict[str, Any]:
        return {**self.summary(), "liveText": self.live_text, "liveReasoning": self.live_reasoning[-400:],
                "result": self.result, "snapshots": self.snapshots}

    def persist(self) -> None:
        self.updated_at = _now_iso()
        conn = get_db()
        try:
            conn.execute("""INSERT INTO runs (id, username, book_id, status, created_at, updated_at, finished_at, request, snapshot, record, result, pause, error)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, finished_at = excluded.finished_at,
                            snapshot = excluded.snapshot, record = excluded.record, result = excluded.result, pause = excluded.pause, error = excluded.error""",
                         (self.id, self.username, self.book_id, self.status, self.created_at, self.updated_at, self.finished_at,
                          json.dumps(self.request, ensure_ascii=False), json.dumps(self.snapshot, ensure_ascii=False) if self.snapshot else None,
                          json.dumps(self.record, ensure_ascii=False), json.dumps(self.result, ensure_ascii=False) if self.result else None,
                          json.dumps(self.pause, ensure_ascii=False) if self.pause else None, self.error))
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def from_row(row) -> "Run":
        run = Run(row["id"], row["username"], row["book_id"], json.loads(row["request"]), row["status"], row["created_at"])
        run.updated_at = row["updated_at"]
        run.finished_at = row["finished_at"]
        run.snapshot = json.loads(row["snapshot"]) if row["snapshot"] else None
        run.record = json.loads(row["record"]) if row["record"] else run.record
        run.result = json.loads(row["result"]) if row["result"] else None
        run.pause = json.loads(row["pause"]) if row["pause"] else None
        run.error = row["error"]
        return run


# ── Ports over the document store ────────────────────────────────────────────

class ServerPorts:
    """The run's ports (wc_agent.types.ToolContext) over SQLite + content files + the event hub."""

    def __init__(self, engine: "RunEngine", run: Run) -> None:
        self.engine = engine
        self.run = run
        self.username = run.username
        self.book_id = run.book_id
        self.start_id: str = run.request["activeDocumentId"]
        self.original: str = ""
        self.view: str = self.start_id        # what the sending tab shows
        self.expected: str = self.start_id    # what the run expects it to show
        self.moved = False
        self._contents: Dict[str, Dict[str, Any]] = {}   # id → {revision, content}
        self._last_preview = 0.0
        self._last_selection_preview = 0.0
        self.previewing: Optional[str] = None
        self.writing: Optional[str] = None
        self.image_registry: List[Dict[str, str]] = []
        self.selected_text: str = run.request.get("selectedText") or ""
        # For the reminders the model gets when the book moves under it: the
        # revision of each chapter as the model last saw or wrote it, the
        # chapter list it was given, and how many requests waited last time.
        self.watched: Dict[str, int] = {}
        self.last_outline: Optional[str] = None
        self.last_queued = 0

    # DocumentPort
    def chapters(self) -> List[Dict[str, Any]]:
        out = []
        for meta in server_documents.list_documents(self.username, self.book_id):
            cached = self._contents.get(meta["id"])
            if cached is None or cached["revision"] != meta["revision"]:
                cached = {"revision": meta["revision"], "content": load_document_content(self.username, self.book_id, meta["id"])}
                self._contents[meta["id"]] = cached
            out.append({"id": meta["id"], "title": meta["title"], "content": cached["content"], "summary": meta.get("summary"),
                        "updatedAt": meta.get("updated_at"), "revision": meta["revision"], "loaded": True})
        return out

    def open_id(self) -> str:
        return self.view

    def user_moved(self) -> bool:
        if not self.moved and self.view != self.expected:
            self.moved = True
        return self.moved

    async def ensure_loaded(self, ids: List[str]) -> None:
        return None

    def commit(self, doc_id: str, html: str) -> None:
        cached = self._contents.get(doc_id)
        out = server_documents.write_document(self.username, self.book_id, doc_id, content=html,
                                              base_revision=cached["revision"] if cached else None, client_id=self._client_id())
        if not out.get("ok"):
            raise RuntimeError("the chapter changed while the write was being made")
        self._contents[doc_id] = {"revision": out["revision"], "content": html}
        self.watched[doc_id] = out["revision"]

    def open(self, doc_id: str) -> None:
        self.expected = doc_id
        self.view = doc_id
        self.engine.publish(self.run, "open", {"documentId": doc_id})

    def create(self, title: str) -> str:
        created = server_documents.create_document(self.username, self.book_id, title, "<p></p>", client_id=self._client_id())
        self._contents[created["id"]] = {"revision": 1, "content": "<p></p>"}
        self.watched[created["id"]] = 1
        self.last_outline = chapter_outline(self.chapters())
        return created["id"]

    def rename(self, doc_id: str, title: str) -> None:
        out = server_documents.write_document(self.username, self.book_id, doc_id, title=title, client_id=self._client_id())
        if out.get("ok") and doc_id in self._contents:
            self._contents[doc_id]["revision"] = out["revision"]
        if out.get("ok"):
            self.watched[doc_id] = out["revision"]
        self.last_outline = chapter_outline(self.chapters())

    def remove(self, doc_id: str) -> None:
        server_documents.delete_document(self.username, self.book_id, doc_id, client_id=self._client_id())
        self._contents.pop(doc_id, None)
        self.watched.pop(doc_id, None)
        self.last_outline = chapter_outline(self.chapters())
        if self.view == doc_id:
            remaining = server_documents.list_documents(self.username, self.book_id)
            self.view = remaining[0]["id"] if remaining else ""
            if not self.moved:
                self.expected = self.view

    def snapshot(self, doc_id: str, label: str) -> None:
        content = next((c["content"] for c in self.chapters() if c["id"] == doc_id), "")
        self.run.snapshots.append(server_documents.snapshot_document(self.username, self.book_id, doc_id, label, content))

    # EditorPort
    def preview_document(self, html: str) -> None:
        now = time.monotonic()
        target = self.view
        if self.previewing != target:
            self.previewing = target
            self._last_preview = 0.0
            self.publish_lock()
        if now - self._last_preview < PREVIEW_THROTTLE_S:
            return
        self._last_preview = now
        self.engine.publish(self.run, "preview", {"documentId": target, "html": restore_image_placeholders(html, self.image_registry)})

    def preview_selection(self, html: str) -> None:
        now = time.monotonic()
        if now - self._last_selection_preview < SELECTION_PREVIEW_THROTTLE_S:
            return
        self._last_selection_preview = now
        self.engine.publish(self.run, "preview_selection", {"documentId": self.start_id, "html": restore_image_placeholders(html, self.image_registry)})

    def discard_preview(self) -> None:
        if self.previewing is None:
            return
        self.engine.publish(self.run, "preview", {"documentId": self.previewing, "html": None})
        self.previewing = None
        self.publish_lock()

    def settle_preview(self) -> None:
        """A step's writes landed: the preview is over, the client converges on the store."""
        if self.previewing is None:
            return
        self.engine.publish(self.run, "preview", {"documentId": self.previewing, "html": None, "settled": True})
        self.previewing = None
        self._last_preview = 0.0
        self.publish_lock()

    # SelectionPort
    def range(self):
        return True if self.selected_text else None

    def original_text(self) -> str:
        return self.selected_text

    # ImagePort
    def preserve(self, html: str) -> str:
        return replace_images_with_placeholders(html, self.image_registry)

    def restore(self, html: str) -> str:
        return restore_image_placeholders(html, self.image_registry)

    # UiPort
    def progress(self, line: Optional[str]) -> None:
        self.engine.publish(self.run, "progress", {"line": line})

    def set_writing(self, doc_id: Optional[str]) -> None:
        self.writing = doc_id
        self.publish_lock()

    def publish_lock(self) -> None:
        ids = [i for i in (self.start_id if self.selected_text else None, self.previewing, self.writing) if i]
        self.engine.publish(self.run, "lock", {"documentIds": sorted(set(ids), key=ids.index)})

    def _client_id(self) -> Optional[str]:
        # The run's writes are not the sending tab's own: every tab, that one
        # included, must apply them.
        return None


class _Ui:
    def __init__(self, ports: ServerPorts) -> None:
        self.ports = ports

    def progress(self, line: Optional[str]) -> None:
        self.ports.progress(line)

    def writing(self, doc_id: Optional[str]) -> None:
        self.ports.set_writing(doc_id)


# ── The engine ───────────────────────────────────────────────────────────────

class RunEngine:
    def __init__(self) -> None:
        self.runs: Dict[str, Run] = {}
        self.queue_held: Dict[tuple, bool] = {}
        self._loaded = False

    # ── lookup ────────────────────────────────────────────────────────────
    def _key(self, run: Run) -> tuple:
        return (run.username, run.book_id)

    def get(self, username: str, run_id: str) -> Optional[Run]:
        run = self.runs.get(run_id)
        return run if run and run.username == username else None

    def active(self, username: str, book_id: str) -> List[Run]:
        self.prune()
        return sorted((r for r in self.runs.values() if r.username == username and r.book_id == book_id and r.status in ACTIVE_STATUSES),
                      key=lambda r: r.created_at)

    def listed(self, username: str, book_id: str) -> List[Run]:
        self.prune()
        return sorted((r for r in self.runs.values() if r.username == username and r.book_id == book_id), key=lambda r: r.created_at)

    def running(self, username: str, book_id: str) -> Optional[Run]:
        return next((r for r in self.runs.values() if r.username == username and r.book_id == book_id and r.status == "running"), None)

    def prune(self) -> None:
        now = time.monotonic()
        for run_id, run in list(self.runs.items()):
            if run.finished_monotonic is not None and now - run.finished_monotonic > FINISHED_RUN_TTL_SECONDS:
                del self.runs[run_id]

    def queue_is_held(self, username: str, book_id: str) -> bool:
        return self.queue_held.get((username, book_id), False)

    def set_queue_held(self, username: str, book_id: str, held: bool) -> None:
        self.queue_held[(username, book_id)] = held
        conn = get_db()
        try:
            conn.execute("INSERT INTO run_books (username, book_id, queue_held) VALUES (?, ?, ?) ON CONFLICT(username, book_id) DO UPDATE SET queue_held = excluded.queue_held",
                         (username, book_id, 1 if held else 0))
            conn.commit()
        finally:
            conn.close()

    # ── events ────────────────────────────────────────────────────────────
    def publish(self, run: Run, kind: str, payload: Dict[str, Any]) -> None:
        server_events.hub.publish(run.username, run.book_id, {"type": "run", "kind": kind, "runId": run.id, **payload})

    def attended(self, run: Run) -> bool:
        return server_events.hub.subscriber_count(run.username, run.book_id) > 0

    # ── lifecycle ─────────────────────────────────────────────────────────
    async def recover(self) -> None:
        """At startup: runs that were running or queued when the process died continue."""
        if self._loaded:
            return
        self._loaded = True
        ensure_tables()
        conn = get_db()
        try:
            rows = conn.execute("SELECT * FROM runs WHERE status IN ('queued', 'running', 'paused') ORDER BY created_at").fetchall()
            held = conn.execute("SELECT username, book_id, queue_held FROM run_books").fetchall()
        finally:
            conn.close()
        for h in held:
            self.queue_held[(h["username"], h["book_id"])] = bool(h["queue_held"])
        for row in rows:
            run = Run.from_row(row)
            self.runs[run.id] = run
        for run in list(self.runs.values()):
            if run.status == "running":
                logger.info("Run %s: resuming after restart at step %s", run.id, (run.snapshot or {}).get("stepsTaken", 0))
                self._launch(run)
        for key in {self._key(r) for r in self.runs.values() if r.status == "queued"}:
            self._advance(*key)

    def submit(self, username: str, book_id: str, request: Dict[str, Any]) -> Run:
        run = Run(f"run-{secrets.token_hex(6)}", username, book_id, request)
        self.runs[run.id] = run
        self._write_messages_at_start(run)
        if self.running(username, book_id) is None:
            self._launch(run)
        else:
            run.persist()
            position = len([r for r in self.active(username, book_id) if r.status == "queued"])
            self.publish(run, "queued", {"run": run.summary(), "position": position})
        return run

    def _advance(self, username: str, book_id: str) -> None:
        if self.running(username, book_id) is not None or self.queue_is_held(username, book_id):
            return
        queued = [r for r in self.active(username, book_id) if r.status == "queued"]
        if queued:
            self._launch(queued[0])

    def _launch(self, run: Run) -> None:
        run.status = "running"
        run.stop_requested = False
        run.persist()
        run.task = asyncio.create_task(self._execute(run))

    def stop(self, run: Run) -> None:
        """Stop pauses the queue: the current run stops, queued requests stay."""
        if run.status == "queued":
            self._finalize(run, "stopped", content_note="⏹️ Removed before it started.")
            return
        if run.status == "paused":
            self._finalize(run, "stopped", content_note="⏹️ Stopped while paused.")
            return
        if run.status != "running":
            return
        self.set_queue_held(run.username, run.book_id, True)
        run.stop_requested = True
        if run.agent:
            run.agent.cancel()
        if run.job is not None:
            run.job.abort()

    def resume(self, run: Run) -> bool:
        if run.status != "paused":
            return False
        if self.running(run.username, run.book_id) is not None:
            return False
        run.status = "running"
        run.pause = None
        run.unattended_steps = 0
        run.persist()
        run.task = asyncio.create_task(self._execute(run, resuming=True))
        return True

    def start_now(self, run: Run) -> bool:
        if run.status != "queued" or self.running(run.username, run.book_id) is not None:
            return False
        self._launch(run)
        return True

    def remove(self, run: Run) -> bool:
        if run.status not in ("queued", "paused"):
            return False
        self._finalize(run, "stopped", content_note="⏹️ Removed.")
        return True

    def set_view(self, run: Run, document_id: str) -> None:
        if run.ports is not None:
            run.ports.view = document_id

    # ── execution ─────────────────────────────────────────────────────────
    async def _execute(self, run: Run, resuming: bool = False) -> None:
        try:
            if run.agent is None:
                await self._build(run)
            agent = run.agent
            assert agent is not None
            if run.snapshot and run.snapshot.get("stepsTaken") and not agent.steps_taken:
                # A restart: continue from the last completed step.
                agent.restore(run.snapshot, lambda doc_id: next((c["content"] for c in run.ports.chapters() if c["id"] == doc_id), None))
                run.record = {**run.record, "status": "running"}
                self.publish(run, "started", {"run": run.summary(), "resumed": True})
                await agent.resume()
            elif resuming:
                self.publish(run, "started", {"run": run.summary(), "resumed": True})
                await agent.resume()
            else:
                self.publish(run, "started", {"run": run.summary()})
                await agent.start()
        except RunStopped:
            self._finalize(run, "stopped")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — any failure ends the run with its error on the bubble
            logger.warning("Run %s failed: %s", run.id, exc)
            run.error = str(exc) or "Run failed"
            self._finalize(run, "error")
        finally:
            run.job = None

    async def _build(self, run: Run) -> None:
        req = run.request
        ports = ServerPorts(self, run)
        run.ports = ports
        chapters = ports.chapters()
        if not any(c["id"] == ports.start_id for c in chapters):
            if not chapters:
                raise RunFailed("The book has no chapters.")
            ports.start_id = chapters[0]["id"]
            ports.view = ports.expected = ports.start_id
        ports.original = next(c["content"] for c in chapters if c["id"] == ports.start_id)
        provider = req["provider"]
        config = req.get("config") or {}
        scope = f"{provider}|{config.get('model') or ''}"
        state = server_context.load_state(run.username, run.book_id, scope)
        assembled = server_context.assemble_request(
            provider=provider, config=config, prompt_text=req["prompt"], images=req.get("images"),
            history=self._history_for(run), documents=chapters, active_document_id=ports.start_id,
            selected_text=ports.selected_text, custom_instructions=req.get("customInstructions"),
            context_window_tokens=req.get("contextWindowTokens"), state=state, image_registry=ports.image_registry)
        server_context.save_state(run.username, run.book_id, scope, state, _now_iso())
        run.request["attachmentsText"] = assembled["attachmentsText"]
        run.record["prefix"] = assembled["attachmentsText"] or None
        settings = assembled["settings"]
        ctx = ToolContext(ports, ports, ports, ports, _Ui(ports),
                          create_run_state(ports.start_id, assembled["inContextIds"], ports.original, chapter_outline(chapters)),
                          polish=_PolishPort(self, run), analyze=_AnalyzePort(self, run))
        ports.last_outline = chapter_outline(chapters)
        for doc_id in ctx.run.known:
            ports.watched[doc_id] = next((c["revision"] for c in chapters if c["id"] == doc_id), 0)
        long_reasoning = config.get("longReasoningReminderTokens")
        run.agent = AgentRun(
            registry=CHAT_TOOLS, ctx=ctx, write_protocol=assembled["protocol"],
            driver=lambda messages, step, final: self._step(run, messages, step, final),
            observer=_Observer(self, run), budgets=settings["budgets"], policy=settings["policy"],
            can_continue=True, agent_tools=settings["agentTools"], initial_messages=assembled["apiMessages"],
            guard=lambda agent: self._guard(run, agent),
            long_reasoning_tokens=int(long_reasoning) if isinstance(long_reasoning, (int, float)) and long_reasoning > 0 else 0,
            reminders=lambda agent: self._reminders(run, agent))

    def _history_for(self, run: Run) -> List[Dict[str, Any]]:
        """The conversation before this turn.

        The client's copy, with two corrections for a request that waited in
        the queue: a bubble that was still a placeholder when it was sent is
        read from the messages table (the server wrote the finished turn
        there), and turns that landed after the snapshot are appended.
        """
        history = list(run.request.get("history") or [])
        own = {run.request.get("userMessageId"), run.request.get("assistantMessageId")}
        conn = get_db()
        try:
            rows = conn.execute("SELECT * FROM messages WHERE username = ? AND book_id = ? ORDER BY sort_order",
                                (run.username, run.book_id)).fetchall()
        finally:
            conn.close()
        by_id = {m["id"]: m for m in rows}

        def from_row(m) -> Dict[str, Any]:
            entry: Dict[str, Any] = {"id": m["id"], "role": m["role"], "content": m["content"]}
            for column, key in (("agent", "agent"), ("reasoning_items", "reasoningItems")):
                if m[column]:
                    try:
                        entry[key] = json.loads(m[column])
                    except ValueError:
                        pass
            return entry

        merged: List[Dict[str, Any]] = []
        last_order = -1
        for m in history:
            row = by_id.get(m.get("id"))
            if row is not None:
                last_order = max(last_order, row["sort_order"])
                if m.get("role") == "assistant" and m.get("content") == ASSISTANT_PLACEHOLDER and row["content"] != ASSISTANT_PLACEHOLDER:
                    merged.append({**m, **from_row(row)})
                    continue
            merged.append(m)
        known = {m.get("id") for m in history} | own
        for m in rows:
            if m["id"] in known or m["sort_order"] <= last_order or m["role"] not in ("user", "assistant") or m["content"] == ASSISTANT_PLACEHOLDER:
                continue
            merged.append(from_row(m))
        return merged

    async def _step(self, run: Run, messages: List[Dict[str, Any]], step: int, final: bool) -> StepOutput:
        """One model call, as a generation job whose events are forwarded live."""
        if run.stop_requested:
            raise RunStopped()
        agent, ports = run.agent, run.ports
        assert agent is not None and ports is not None
        req = run.request
        provider = req["provider"]
        offered = agent.offered_tools()
        config = {**(req.get("config") or {}), "conversationId": run.book_id,
                  "tools": to_openai_tools(to_tool_specs(offered)) if offered else None,
                  "toolChoice": "none" if final and offered else None}
        config = {k: v for k, v in config.items() if v is not None}
        job = server_generation.registry.create(run.username, {"kind": "run", "runId": run.id, "step": step, "bookId": run.book_id})
        job.input_chars = sum(len(str(m.get("content") or "")) for m in messages)
        job.conversation = run.book_id
        job.model = str(config.get("model") or "") or None
        run.job = job
        run.live_text = ""
        run.live_reasoning = ""
        queue: asyncio.Queue = asyncio.Queue()
        job.subscribers.add(queue)
        task = asyncio.create_task(server_generation.run_job(job, provider, config, messages))
        job.task = task  # what GenerationJob.abort cancels
        tool_acc: Dict[int, Dict[str, Any]] = {}
        last_split = 0.0
        self.publish(run, "step_started", {"step": step, "final": final})
        try:
            while True:
                event = await queue.get()
                kind = event.get("type")
                if kind == "delta":
                    run.live_text += event["text"]
                    self.publish(run, "delta", {"step": step, "text": event["text"]})
                    now = time.monotonic()
                    if now - last_split >= SPLIT_THROTTLE_S:
                        last_split = now
                        self._preview_markup(run, run.live_text)
                elif kind == "reasoning":
                    run.live_reasoning = (run.live_reasoning + event["text"])[-2000:]
                    self.publish(run, "reasoning", {"step": step, "text": event["text"]})
                elif kind == "tool_call":
                    index = event.get("index") or 0
                    acc = tool_acc.setdefault(index, {"argumentsText": ""})
                    if event.get("id"):
                        acc["id"] = event["id"]
                    if event.get("name"):
                        acc["name"] = event["name"]
                    acc["argumentsText"] = event["text"] if event.get("replay") else acc["argumentsText"] + (event.get("text") or "")
                    tool = CHAT_TOOLS.get(acc.get("name"))
                    if tool and tool.preview:
                        try:
                            tool.preview(acc["argumentsText"], agent.ctx)
                        except Exception as exc:  # noqa: BLE001 — a preview must never fail the step
                            logger.debug("Run %s preview failed: %s", run.id, exc)
                elif kind in server_generation.TERMINAL_EVENT_TYPES:
                    break
        finally:
            job.subscribers.discard(queue)
            await task
            job.result_delivered = True
        run.reasoning_heads.append(job.reasoning_text[:400])
        run.reasoning_heads = run.reasoning_heads[-6:]
        if job.status == "aborted":
            raise RunStopped()
        if job.status == "error":
            raise RunFailed(job.error or "Generation failed.")
        calls = finish_tool_calls({i: {"id": c.get("id"), "name": c.get("name"), "argumentsText": c.get("arguments") or "",
                                       **({"signature": c["signature"]} if c.get("signature") else {})}
                                   for i, c in job.tool_calls.items()})
        run.last_response_items = list(job.response_items)
        return StepOutput(job.buffer, calls, thinking=list(job.thinking_blocks) or None,
                          response_items=list(job.response_items) or None, usage=job.usage)

    def _preview_markup(self, run: Run, raw: str) -> None:
        agent = run.agent
        if agent is None:
            return
        try:
            split = split_streaming_response(raw)
            if split["isSelectionEdit"]:
                cleaned = strip_incomplete_end_tag(split["selectionReplaceText"])
                if cleaned:
                    agent.ctx.editor.preview_selection(cleaned)
            elif js_trim(split["canvasText"]):
                ref = {"create": split["canvasNewChapter"]} if split.get("canvasNewChapter") else split.get("canvasChapter")
                preview_rewrite(agent.ctx, ref, trim_incomplete_html_tail(split["canvasText"]))
        except Exception as exc:  # noqa: BLE001
            logger.debug("Run %s markup preview failed: %s", run.id, exc)

    def _reminders(self, run: Run, agent: AgentRun) -> List[str]:
        """What moved under the run since its last step: the user's edits to
        chapters the model has seen, the chapter list, and requests waiting
        behind this turn (wc_text.reminders)."""
        ports = run.ports
        if ports is None:
            return []
        out: List[str] = []
        chapters = ports.chapters()
        current = {c["id"]: c for c in chapters}
        edited = []
        for doc_id in [*agent.ctx.run.known, *[i for i in agent.ctx.run.read_ids if i not in agent.ctx.run.known]]:
            now = current.get(doc_id)
            seen = ports.watched.get(doc_id)
            if now is None:
                continue
            if seen is None:
                ports.watched[doc_id] = now["revision"]
                continue
            if now["revision"] > seen:
                ports.watched[doc_id] = now["revision"]
                edited.append({"number": chapters.index(now) + 1, "title": now["title"]})
        if edited:
            out.append(user_edited_reminder(edited))
        outline = chapter_outline(chapters)
        if ports.last_outline is not None and outline != ports.last_outline:
            out.append(structure_changed_reminder("\n".join(f'{i + 1}. "{c["title"]}"' for i, c in enumerate(chapters))))
        ports.last_outline = outline
        queued = len([r for r in self.active(run.username, run.book_id) if r.status == "queued"])
        if queued != ports.last_queued and queued > 0:
            out.append(queued_request_reminder(queued))
        ports.last_queued = queued
        return out

    def _guard(self, run: Run, agent: AgentRun) -> Optional[Dict[str, Any]]:
        """Pause, never kill: the reasons a run is suspended between steps."""
        if run.stop_requested:
            return None
        # The calls, not their answers: a repeated list_chapters answers with
        # "identical to your previous result" from the second time on, and
        # the loop this guards against (13× list_chapters, 2026-10-06) is
        # the same call with the same arguments, whatever the tool says back.
        # The loop itself nudged the model at REPEAT_NUDGE_STEPS; this is
        # the pause after the nudge went unheeded.
        if agent.identical_run_length() >= REPEAT_STEPS:
            return self._pause_detail(run, agent, "repeating",
                                      f"The last {REPEAT_STEPS} steps made the same calls with the same arguments, and wrote nothing, after being told so.")
        if self.attended(run):
            run.unattended_steps = 0
        else:
            run.unattended_steps += 1
            if run.unattended_steps > UNATTENDED_STEP_CEILING:
                return self._pause_detail(run, agent, "unattended",
                                          f"No tab has been watching this book for {run.unattended_steps} steps.")
        budget = (run.request.get("config") or {}).get("runTokenBudget")
        if isinstance(budget, (int, float)) and budget > 0:
            spent = agent.usage["promptTokens"] + agent.usage["completionTokens"]
            if spent > budget:
                return self._pause_detail(run, agent, "token_budget", f"This run has used {spent:,} tokens, past its budget of {int(budget):,}.")
        return None

    def _pause_detail(self, run: Run, agent: AgentRun, reason: str, message: str) -> Dict[str, Any]:
        steps = []
        heads = run.reasoning_heads[-PAUSE_DETAIL_STEPS:]
        for i, s in enumerate(agent.step_log[-PAUSE_DETAIL_STEPS:]):
            steps.append({"calls": [c["name"] for c in s["calls"]], "results": [r[:200] for r in s["results"]],
                          "reasoning": heads[i] if i < len(heads) else ""})
        return {"reason": reason, "message": message, "steps": steps, "usage": dict(agent.usage)}

    # ── observers ─────────────────────────────────────────────────────────
    def on_corrective(self, run: Run, failure: str, attempt: int, mx: int) -> None:
        run.ports.settle_preview() if run.ports else None
        self.publish(run, "corrective", {"failure": failure, "attempt": attempt, "max": mx})

    def on_step_executed(self, run: Run, progress: Dict[str, Any]) -> None:
        if run.ports:
            run.ports.progress(None)
            run.ports.settle_preview()
        run.record = {**run.record, "status": "running", "steps": progress["steps"], "trace": progress["trace"], "touched": progress["touched"],
                      "timeline": progress["timeline"], "seen": progress["seen"], "plan": progress.get("plan") or []}
        run.snapshot = run.agent.snapshot() if run.agent else None
        run.persist()
        self._update_assistant_message(run, content=run.request.get("attachmentsText") or ASSISTANT_PLACEHOLDER)
        self.publish(run, "step", {"record": run.record, "usage": progress.get("usage")})

    def on_asked(self, run: Run, question: Dict[str, Any], progress: Dict[str, Any]) -> None:
        """The model asked the user (ask_user): the run waits as a pause with the question."""
        self.on_paused(run, {"reason": "question", "message": question["question"], "question": question["question"],
                             "options": question.get("options") or []}, progress)

    def answer(self, run: Run, answer: str) -> bool:
        if run.status != "paused" or not run.pause or run.pause.get("reason") != "question" or run.agent is None:
            return False
        if self.running(run.username, run.book_id) is not None:
            return False
        run.status = "running"
        run.pause = None
        run.unattended_steps = 0
        run.persist()
        run.task = asyncio.create_task(self._execute_answer(run, answer))
        return True

    async def _execute_answer(self, run: Run, answer: str) -> None:
        try:
            self.publish(run, "started", {"run": run.summary(), "resumed": True})
            await run.agent.resume_with_answer(answer)
        except RunStopped:
            self._finalize(run, "stopped")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning("Run %s failed: %s", run.id, exc)
            run.error = str(exc) or "Run failed"
            self._finalize(run, "error")
        finally:
            run.job = None

    def on_paused(self, run: Run, reason: Dict[str, Any], progress: Dict[str, Any]) -> None:
        if run.ports:
            run.ports.settle_preview()
        run.status = "paused"
        run.pause = reason
        run.record = {**run.record, "status": "paused", "steps": progress["steps"], "trace": progress["trace"], "touched": progress["touched"],
                      "timeline": progress["timeline"], "seen": progress["seen"], "plan": progress.get("plan") or []}
        run.snapshot = run.agent.snapshot() if run.agent else None
        run.persist()
        self._update_assistant_message(run, content=_join(run.request.get("attachmentsText"), progress["chatText"]) or ASSISTANT_PLACEHOLDER)
        self.publish(run, "paused", {"record": run.record, "pause": reason})
        logger.info("Run %s paused: %s", run.id, reason.get("reason"))

    def on_finish(self, run: Run, summary: Dict[str, Any]) -> None:
        if run.ports:
            run.ports.progress(None)
            run.ports.settle_preview()
        end = summary["endReason"]
        status = "stopped" if end == "cancelled" else "done"
        record_status = "step_limit" if end == "step_limit" else "stopped" if end == "cancelled" else "done"
        warning = build_completion_warnings({
            "canvasIssue": summary["effects"]["canvasIssue"], "editFailedCount": summary["effects"]["failedEdits"],
            "strayMarkup": summary["strayMarkup"], "selectionGone": summary["effects"]["selectionGone"],
            "toolCallProducedNothing": summary["effects"]["producedNothing"], "exhaustedNoActionRetries": summary["exhaustedCorrective"],
            "unretriableFailedUpdate": summary["unretriableFailedUpdate"], "reinsertedImages": summary["effects"]["reinsertedImages"],
        })
        limit_note = (f"\n\nℹ️ This turn stopped at its step limit ({summary['steps']} steps). Reply \"continue\" to let it go on, or raise the limit in Settings."
                      if end == "step_limit" else "")
        chat_text = summary["chatText"] or "Document updated successfully."
        if end == "cancelled":
            chat_text = _join(summary["chatText"], "⏹️ Stopped.")
        content = _join(run.request.get("attachmentsText"), chat_text) + warning + limit_note
        reasoning_items = [i for i in run.last_response_items if isinstance(i, dict) and i.get("type") == "reasoning"]
        run.record = {"status": record_status, "steps": summary["steps"], "trace": summary["trace"], "touched": summary["touched"],
                      "timeline": summary["timeline"], "prefix": run.request.get("attachmentsText") or None,
                      "suffix": js_trim(warning + limit_note) or None, "plan": summary.get("plan") or []}
        run.result = {"content": content, "record": run.record, "reasoningItems": reasoning_items, "readIds": summary["readIds"],
                      "usage": summary.get("usage"), "snapshots": run.snapshots}
        run.snapshot = None
        self._remember_reads(run, summary)
        self._finalize(run, status)

    def _remember_reads(self, run: Run, summary: Dict[str, Any]) -> None:
        """What the model read and wrote this turn feeds the next turn's context (D4, D7, D8)."""
        from wc_text.freshness import record_seen
        req = run.request
        scope = f"{req['provider']}|{(req.get('config') or {}).get('model') or ''}"
        state = server_context.load_state(run.username, run.book_id, scope)
        state["modelReadIds"] = list(summary["readIds"])
        if run.ports:
            chapters = {c["id"]: c for c in run.ports.chapters()}
            for doc_id in [*summary["readIds"], *[t["documentId"] for t in summary["touched"]]]:
                if doc_id in chapters:
                    record_seen(state.setdefault("seen", {}), doc_id, chapters[doc_id]["content"], int(state.get("turn") or 0))
        server_context.save_state(run.username, run.book_id, scope, state, _now_iso())

    def _finalize(self, run: Run, status: str, content_note: Optional[str] = None) -> None:
        run.status = status
        run.finished_at = _now_iso()
        run.finished_monotonic = time.monotonic()
        if run.result is None:
            progress = run.agent.progress() if run.agent else {"chatText": "", "steps": run.record.get("steps", 0), "trace": run.record.get("trace", []),
                                                             "touched": run.record.get("touched", []), "timeline": run.record.get("timeline", []), "readIds": []}
            note = content_note or ("⏹️ Stopped." if status == "stopped" else f"⚠️ Error during stream: {run.error}")
            run.record = {**run.record, "status": "stopped", "steps": progress["steps"], "trace": progress["trace"], "touched": progress["touched"],
                          "timeline": progress["timeline"], "suffix": note}
            run.record.pop("seen", None)
            run.result = {"content": _join(run.request.get("attachmentsText"), progress["chatText"], note), "record": run.record,
                          "reasoningItems": [], "readIds": progress.get("readIds", []), "snapshots": run.snapshots}
        run.snapshot = None
        run.pause = None
        if run.ports:
            run.ports.previewing = None
            run.ports.writing = None
            self.publish(run, "lock", {"documentIds": []})
        run.persist()
        self._update_assistant_message(run, content=run.result["content"], final=True)
        self.publish(run, "finished", {"status": status, "run": run.summary(), "result": run.result})
        logger.info("Run %s %s after %s steps", run.id, status, run.record.get("steps", 0))
        self._advance(run.username, run.book_id)

    # ── messages ──────────────────────────────────────────────────────────
    def _write_messages_at_start(self, run: Run) -> None:
        """The turn's two messages, as the client holds them, so another device loads them."""
        req = run.request
        now = _now_iso()
        conn = get_db()
        try:
            base = conn.execute("SELECT COALESCE(MAX(sort_order), -1) AS m FROM messages WHERE username = ? AND book_id = ?",
                                (run.username, run.book_id)).fetchone()["m"]
            for offset, (msg_id, role, content, images) in enumerate([
                (req.get("userMessageId"), "user", req["prompt"], req.get("images")),
                (req.get("assistantMessageId"), "assistant", ASSISTANT_PLACEHOLDER, None),
            ]):
                if not msg_id:
                    continue
                exists = conn.execute("SELECT 1 FROM messages WHERE username = ? AND book_id = ? AND id = ?", (run.username, run.book_id, msg_id)).fetchone()
                if exists:
                    continue
                conn.execute("""INSERT INTO messages (id, username, book_id, role, content, timestamp, model, sort_order, agent)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                             (msg_id, run.username, run.book_id, role, content, now, (req.get("config") or {}).get("model"), base + 1 + offset,
                              json.dumps(self._linked_record(run), ensure_ascii=False) if role == "assistant" else None))
            conn.commit()
        finally:
            conn.close()

    def _linked_record(self, run: Run) -> Dict[str, Any]:
        return {**run.record, "run": {"id": run.id, "status": run.status}}

    def _update_assistant_message(self, run: Run, content: str, final: bool = False) -> None:
        msg_id = run.request.get("assistantMessageId")
        if not msg_id:
            return
        # Always a record, with the run behind it: a reloading tab tells a
        # bubble that waits on a run from one that waits on nothing by it.
        record = self._linked_record(run)
        conn = get_db()
        try:
            if final and run.result:
                usage = run.result.get("usage") or {}
                conn.execute("""UPDATE messages SET content = ?, agent = ?, reasoning_items = ?, input_tokens = ?, output_tokens = ?, cache_hit_tokens = ?
                                WHERE username = ? AND book_id = ? AND id = ?""",
                             (content, json.dumps(record, ensure_ascii=False) if record else None,
                              json.dumps(run.result["reasoningItems"], ensure_ascii=False) if run.result.get("reasoningItems") else None,
                              usage.get("promptTokens"), usage.get("completionTokens"), usage.get("cachedPromptTokens"),
                              run.username, run.book_id, msg_id))
            else:
                conn.execute("UPDATE messages SET content = ?, agent = ? WHERE username = ? AND book_id = ? AND id = ?",
                             (content, json.dumps(record, ensure_ascii=False) if record else None, run.username, run.book_id, msg_id))
            conn.commit()
        finally:
            conn.close()


def _join(*parts: Optional[str]) -> str:
    return "\n\n".join(js_trim(p) for p in parts if p and js_trim(p))


class _Observer:
    def __init__(self, engine: RunEngine, run: Run) -> None:
        self.engine, self.run = engine, run

    def on_corrective(self, failure, attempt, mx):
        self.engine.on_corrective(self.run, failure, attempt, mx)

    def on_step_executed(self, progress):
        self.engine.on_step_executed(self.run, progress)

    def on_paused(self, reason, progress):
        self.engine.on_paused(self.run, reason, progress)

    def on_asked(self, question, progress):
        self.engine.on_asked(self.run, question, progress)

    def on_finish(self, summary):
        self.engine.on_finish(self.run, summary)


class _ModelCall:
    """One side call (a polish chunk, an analysis batch) as its own generation job."""

    def __init__(self, engine: RunEngine, run: Run, model: Optional[str], reasoning_effort: Optional[str], conversation: str) -> None:
        self.engine, self.run, self.model, self.effort, self.conversation = engine, run, model, reasoning_effort, conversation

    async def __call__(self, system: str, user: str) -> str:
        req = self.run.request
        config = {k: v for k, v in (req.get("config") or {}).items() if k not in ("tools", "toolChoice")}
        if self.model:
            config["model"] = self.model
        config["reasoningEffort"] = self.effort
        config["conversationId"] = self.conversation
        config = {k: v for k, v in config.items() if v is not None}
        job = server_generation.registry.create(self.run.username, {"kind": "batch", "runId": self.run.id, "bookId": self.run.book_id})
        job.conversation = self.conversation
        job.model = config.get("model")
        await server_generation.run_job(job, req["provider"], config, [{"role": "system", "content": system}, {"role": "user", "content": user}])
        job.result_delivered = True
        if job.status != "done":
            raise RunFailed(job.error or "stopped")
        return job.buffer


class _PolishPort:
    def __init__(self, engine: RunEngine, run: Run) -> None:
        self.engine, self.run = engine, run

    async def run(self, html: str, on_progress):
        req = self.run.request
        cfg = req.get("config") or {}
        model = js_trim(cfg.get("polishModel") or "") or default_polish_model(req["provider"], cfg.get("model") or "")
        transport = _ModelCall(self.engine, self.run, model, "default", f"{self.run.book_id}:polish")
        prompt = req.get("polishPrompt") or {"system": "", "template": "{part}"}
        return await polish_html(html, transport, prompt, req.get("customInstructions"), None, on_progress)


class _AnalyzePort:
    def __init__(self, engine: RunEngine, run: Run) -> None:
        self.engine, self.run = engine, run

    async def run(self, task: str, chapters, on_progress):
        req = self.run.request
        transport = _ModelCall(self.engine, self.run, None, (req.get("config") or {}).get("reasoningEffort"), f"{self.run.book_id}:analyze")
        return await analyze_in_batches(task, chapters, WHOLE_BOOK_CONTEXT_CHARS.get(req["provider"], 300_000), transport, None, on_progress)


engine = RunEngine()


# ── Endpoints ────────────────────────────────────────────────────────────────

def _validate_request(body: Any) -> Dict[str, Any]:
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")
    prompt = body.get("prompt")
    if not isinstance(prompt, str) or not js_trim(prompt):
        raise HTTPException(status_code=400, detail="prompt must be a non-empty string.")
    provider = body.get("provider")
    if provider not in server_generation.SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported LLM provider: {provider}")
    config = body.get("config") or {}
    if not isinstance(config, dict):
        raise HTTPException(status_code=400, detail="config must be an object.")
    if not config.get("apiKey") and provider not in ("ollama", "runpod"):
        raise HTTPException(status_code=400, detail=f"API key is missing for {provider}. Please configure it in Settings.")
    active = body.get("activeDocumentId")
    if not isinstance(active, str) or not active:
        raise HTTPException(status_code=400, detail="activeDocumentId is required.")
    history = body.get("history") or []
    if not isinstance(history, list):
        raise HTTPException(status_code=400, detail="history must be an array.")
    return {
        "prompt": prompt, "provider": provider, "config": config, "activeDocumentId": sanitize_id(active, "docId"),
        "images": body.get("images") if isinstance(body.get("images"), list) else None,
        "selectedText": body.get("selectedText") if isinstance(body.get("selectedText"), str) else "",
        "history": [m for m in history if isinstance(m, dict) and m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)],
        "userMessageId": body.get("userMessageId") if isinstance(body.get("userMessageId"), str) else None,
        "assistantMessageId": body.get("assistantMessageId") if isinstance(body.get("assistantMessageId"), str) else None,
        "customInstructions": body.get("customInstructions") if isinstance(body.get("customInstructions"), str) else None,
        "polishPrompt": body.get("polishPrompt") if isinstance(body.get("polishPrompt"), dict) else None,
        "contextWindowTokens": body.get("contextWindowTokens") if isinstance(body.get("contextWindowTokens"), int) else None,
        "clientId": body.get("clientId") if isinstance(body.get("clientId"), str) else None,
    }


@router.post("/api/books/{book_id}/runs")
async def start_run(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")
    req = _validate_request(body)
    req["clientId"] = server_events.client_id_of(request) or req.get("clientId")
    await engine.recover()
    run = engine.submit(username, safe_book_id, req)
    position = len([r for r in engine.active(username, safe_book_id) if r.status == "queued" and r.created_at < run.created_at])
    return {"run": run.summary(), "position": position if run.status == "queued" else 0, "queueHeld": engine.queue_is_held(username, safe_book_id)}


@router.get("/api/books/{book_id}/runs")
async def list_runs(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    await engine.recover()
    runs = engine.listed(username, safe_book_id)
    return {"runs": [r.detail() if r.status in ACTIVE_STATUSES else r.summary() | {"result": r.result} for r in runs],
            "queueHeld": engine.queue_is_held(username, safe_book_id)}


def _run_or_404(username: str, run_id: str) -> Run:
    run = engine.get(username, sanitize_id(run_id, "runId"))
    if run is None:
        raise HTTPException(status_code=404, detail="Run not found.")
    return run


@router.get("/api/books/{book_id}/runs/{run_id}")
async def get_run(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    await engine.recover()
    return {"run": _run_or_404(username, run_id).detail()}


@router.post("/api/books/{book_id}/runs/{run_id}/stop")
async def stop_run(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    run = _run_or_404(username, run_id)
    engine.stop(run)
    return {"success": True, "run": run.summary(), "queueHeld": engine.queue_is_held(username, run.book_id)}


@router.post("/api/books/{book_id}/runs/{run_id}/resume")
async def resume_run(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    run = _run_or_404(username, run_id)
    if not engine.resume(run):
        raise HTTPException(status_code=409, detail="This run is not paused, or another run is active.")
    return {"success": True, "run": run.summary()}


@router.post("/api/books/{book_id}/runs/{run_id}/answer")
async def answer_run(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    run = _run_or_404(username, run_id)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")
    answer = body.get("answer") if isinstance(body, dict) else None
    if not isinstance(answer, str) or not js_trim(answer):
        raise HTTPException(status_code=400, detail="answer must be a non-empty string.")
    if not engine.answer(run, js_trim(answer)):
        raise HTTPException(status_code=409, detail="This run is not waiting for an answer, or another run is active.")
    return {"success": True, "run": run.summary()}


@router.post("/api/books/{book_id}/runs/{run_id}/start")
async def start_queued_run(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    run = _run_or_404(username, run_id)
    if not engine.start_now(run):
        raise HTTPException(status_code=409, detail="This run is not queued, or another run is active.")
    return {"success": True, "run": run.summary()}


@router.post("/api/books/{book_id}/runs/{run_id}/view")
async def report_view(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    run = _run_or_404(username, run_id)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")
    doc_id = body.get("documentId") if isinstance(body, dict) else None
    if isinstance(doc_id, str) and doc_id:
        engine.set_view(run, sanitize_id(doc_id, "docId"))
    return {"success": True}


@router.delete("/api/books/{book_id}/runs/{run_id}")
async def remove_run(request: Request, book_id: str, run_id: str):
    username = get_authenticated_username(request)
    run = _run_or_404(username, run_id)
    if not engine.remove(run):
        raise HTTPException(status_code=409, detail="Only a queued or paused run can be removed.")
    return {"success": True, "run": run.summary()}


@router.post("/api/books/{book_id}/runs/queue")
async def set_queue(request: Request, book_id: str):
    username = get_authenticated_username(request)
    safe_book_id = sanitize_id(book_id, "bookId")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")
    held = bool((body or {}).get("held"))
    engine.set_queue_held(username, safe_book_id, held)
    if not held:
        engine._advance(username, safe_book_id)
    return {"success": True, "queueHeld": held}
