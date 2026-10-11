"""Server-side resumable LLM generation jobs (docs/features/resumable_generation.md).

Generation normally runs inside the browser tab (`src/services/llm.ts`), so a
tab that is discarded mid-stream loses everything. This module moves the
provider connection into the backend: a job owns the provider stream, buffers
every delta, and any number of SSE readers may attach or re-attach at an
arbitrary character offset.

Exposes:
- `JobRegistry` / `registry` — the in-memory, per-username job store.
- `GenerationJob` — buffer + status + subscriber fan-out for one generation.
- `build_openai_request` / `build_gemini_request` / `build_anthropic_request`
  — pure request builders mirroring `src/services/llm.ts` exactly.
- `router` — an APIRouter with the four /api/generate endpoints, included
  into the app by api_server.

Provider parity note: the request shapes, delta extraction and usage
accounting below are a direct port of `src/services/llm.ts`. When that file
changes, this one must change with it — in particular the Anthropic usage
rules and the Gemini safety-block detection, which carry their own comments.
That includes tool calling (docs/features/agentic_chat_loop.md): tool
definitions arrive OpenAI-shaped in `config["tools"]` and are translated per
provider through `wc_text.document_tools` (the parity-checked port of
src/utils/documentTools.ts); history messages may carry
`toolCalls` (assistant) or be `role: "tool"` results, and every builder
replays them in its provider's native shape; every stream reader reports
tool-call deltas through `GenerationJob.note_tool_call`.

Reasoning artifacts are part of that replay (`providerMessages.ts` header):
an assistant message may carry `thinking` (Anthropic thinking /
redacted_thinking blocks, replayed verbatim BEFORE its text and tool_use
blocks) and a toolCalls entry may carry `signature` (Gemini thoughtSignature,
replayed as a sibling of that call's `functionCall`). The stream readers
capture both: completed thinking blocks become `thinking_block` events
(`GenerationJob.note_thinking_block`), and a call's signature rides on its
`tool_call` event. Both are kept on the job so a late reader gets them too.

Tests that stub the network should patch `server_generation._http_stream`
(this module reads its own global) and may clear `server_generation.registry`.
"""

import asyncio
import hashlib
import json
import logging
import os
import random
import re
from urllib.parse import urlparse
import secrets
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from server_auth import get_authenticated_username
# The parity-checked ports of src/utils/documentTools.ts: this module used to keep
# its own copies, which no parity case covered (test audit, 2026-10-10).
from wc_text.provider_profile import uses_responses_api
from wc_text.reasoning_effort import anthropic_thinking, resolve_reasoning_effort
from wc_text.document_tools import from_openai_tools, to_anthropic_tools, to_gemini_tools
from wc_text.retry_policy import (MAX_TRANSPORT_RETRIES, is_context_length_error, is_retryable_status, parse_retry_after,
                                  retry_delay_ms, with_jitter)

logger = logging.getLogger("web_canvas.generation")

router = APIRouter()

# ── Retention and limits (spec §4) ────────────────────────────────────────────
# Problem: a run that looped (grok announced a chapter and called
#   list_chapters 13 times, 2026-10-06) could not be explained afterwards. The
#   83 s of reasoning in which it chose that call existed only in the job's
#   live stream, and a finished job is forgotten after ten minutes.
# Fix: every finished step is appended to a local journal: its reasoning,
#   its visible text and its tool calls. One JSON line per step, one file per
#   day, kept JOURNAL_KEEP_DAYS days, beside the metadata DB (local disk,
#   git-ignored, like the stories themselves).
JOURNAL_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".local_db", "step-journal")
JOURNAL_KEEP_DAYS = 7
JOURNAL_MAX_CHARS = 200_000
_journal_pruned_on: Optional[str] = None


def journal_step(job: "GenerationJob") -> None:
    """Append a finished job to the step journal. Never raises."""
    global _journal_pruned_on
    try:
        os.makedirs(JOURNAL_DIR, exist_ok=True)
        today = datetime.now().strftime("%Y-%m-%d")
        if _journal_pruned_on != today:
            _journal_pruned_on = today
            cutoff = time.time() - JOURNAL_KEEP_DAYS * 86400
            for name in os.listdir(JOURNAL_DIR):
                path = os.path.join(JOURNAL_DIR, name)
                if name.endswith(".jsonl") and os.path.getmtime(path) < cutoff:
                    os.remove(path)
        record = {
            "at": _now_iso(),
            "job": job.job_id,
            "kind": job.meta.get("kind"),
            "message": job.meta.get("assistantMessageId"),
            "conversation": job.conversation,
            "model": job.model,
            "status": job.status,
            "firstTokenSeconds": round(job.first_delta_latency, 2) if job.first_delta_latency is not None else None,
            "reasoning": job.reasoning_text,
            "text": job.buffer[:JOURNAL_MAX_CHARS],
            "toolCalls": [
                {"name": call.get("name"), "arguments": (call.get("arguments") or "")[:JOURNAL_MAX_CHARS]}
                for _, call in sorted(job.tool_calls.items())
            ],
            "error": job.error,
        }
        with open(os.path.join(JOURNAL_DIR, f"{today}.jsonl"), "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as exc:  # the journal must never fail a job
        logger.warning("Step journal write failed for %s: %s", job.job_id, exc)


FINISHED_JOB_TTL_SECONDS = 10 * 60
# Problem: every finished job expired after ten minutes, read or not. A turn
#   whose only reader was gone when it finished (phone locked, tab discarded,
#   laptop closed) was deleted before anyone could come back for it — the
#   tokens were spent and the reply no longer existed anywhere. With first
#   tokens measured at 230s, "gone for ten minutes" is an ordinary turn.
# Root Cause: retention was keyed on WHEN the job finished, not on whether its
#   result had reached anybody.
# Fix: a result no reader has received the terminal event for is kept a day.
#   Memory stays bounded by the per-user cap below, exactly as before — the
#   cap counts jobs, not minutes — and delivered results still go in ten.
UNDELIVERED_JOB_TTL_SECONDS = 24 * 60 * 60
MAX_JOBS_PER_USER = 20
# The offset contract is expressed in characters (the client resumes from the
# number of characters it has rendered), so the buffer cap is measured in
# characters too — mixing in a byte cap would make offsets ambiguous.
MAX_BUFFER_CHARS = 4 * 1024 * 1024

# Idle SSE keep-alive. Not a poll: readers are woken by their queue, this only
# emits a comment line so intermediaries do not drop an idle connection.
SSE_HEARTBEAT_SECONDS = 15.0

#: Event types that END a stream. Everything else is informational and must
#: NOT close it — see the reader loop in _job_event_stream.
TERMINAL_EVENT_TYPES = frozenset({"done", "error", "aborted"})

# Connect fast, but allow long silences between provider deltas (reasoning
# models can think for minutes before the first token).
HTTP_CONNECT_TIMEOUT = 30.0
HTTP_READ_TIMEOUT = 600.0
# Problem: a stuck stream was noticed only when the 600 s read timeout fired.
# Root cause: one timeout for every provider, sized for the slowest silence —
#   a local server prefilling a long prompt, or an OpenAI reasoning model
#   thinking, sends nothing for minutes.
# Fix: grok streams its reasoning summary throughout (measured 2026-10-09:
#   the longest silence 3.6 s at high effort, 11.7 s in another request), so
#   its streams fail after 180 s without a byte; the others keep 600 s.
#   httpx's read timeout is per read, i.e. exactly the idle gap.
IDLE_TIMEOUT_SECONDS = {"grok": 180.0}
# xAI's repetition detectors (agentic_chat_loop.md §0.10): sent on a server
# run's steps. A trigger ENDS the generation (measured), so a step that
# failed after one is the loop, not a transient error.
LOOP_CHECK_HEADERS = {"x-grok-doom-loop-check": "1024", "x-grok-exact-repetition-check": "64"}

SUPPORTED_PROVIDERS = ("openai", "ollama", "runpod", "grok", "gemini", "anthropic")

#: Hosts /api/models will query. Local model servers only — see the endpoint.
LOCAL_HOSTNAMES = frozenset({"localhost", "127.0.0.1", "::1", "0.0.0.0"})

#: Additionally allowed for /api/models, over HTTPS only: RunPod's per-pod HTTP
#: proxy. A pod reached through the SSH tunnel is already loopback and needs
#: nothing here; this is for addressing a pod directly.
#:
#: Widening an SSRF guard deserves a reason. This suffix resolves to RunPod's
#: public proxy tier, never to anything on this machine's network, so it does
#: not buy an attacker reach they did not already have from the open internet.
#: The endpoint's whole behaviour is one GET of {base}/models whose parsed
#: names are returned, and reaching it already requires an authenticated
#: session. Matching is on a leading-dot suffix so a lookalike registration
#: like "evilproxy.runpod.net.attacker.com" cannot satisfy it.
REMOTE_MODEL_HOST_SUFFIXES = (".proxy.runpod.net",)


#: The non-local hosts /api/models will query, with the user's key (the official model lists).
OFFICIAL_MODEL_HOSTS = {"anthropic": "api.anthropic.com", "openai": "api.openai.com"}
_OPENAI_CHAT_MODEL_RE = re.compile(r"^(?:gpt-\d|o\d)")
_OPENAI_NON_CHAT_RE = re.compile(r"audio|realtime|image|transcribe|tts|search|instruct|live|embedding|diarize|whisper|translate")


def is_queryable_model_host(base_url: str) -> bool:
    """Whether /api/models may fetch a listing from this URL."""
    parsed = urlparse(base_url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in ("http", "https"):
        return False
    if host in LOCAL_HOSTNAMES:
        return True
    # Remote hosts are HTTPS-only: the listing would otherwise cross the
    # public internet in the clear.
    return parsed.scheme == "https" and any(
        host.endswith(suffix) for suffix in REMOTE_MODEL_HOST_SUFFIXES
    )

_DATA_URL_RE = re.compile(r"^data:(image/[a-zA-Z+.-]+);base64,(.+)$")


class ProviderError(Exception):
    """A provider-reported failure that should become the job's error event.

    `status` is the HTTP status when there was one, `retry_after` the
    provider's Retry-After in seconds, `transient` a failure reported inside
    the stream that the same request may survive (xAI's server_error).
    """

    def __init__(self, message: str, status: Optional[int] = None, retry_after: Optional[float] = None, transient: bool = False) -> None:
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after
        self.transient = transient


def _http_error(provider_label: str, response: Any, text: str) -> ProviderError:
    """The error for a response that failed before streaming, with what the retry policy needs."""
    headers = getattr(response, "headers", None) or {}
    retry_after = parse_retry_after(headers.get("retry-after") if hasattr(headers, "get") else None)
    return ProviderError(f"{provider_label} API error ({response.status_code}): {text or 'request failed'}",
                         status=response.status_code, retry_after=retry_after)


class _JobAborted(Exception):
    """Raised inside a streaming loop once the abort endpoint has been hit."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _monotonic() -> float:
    """Wall-clock-independent clock used for retention (patchable in tests)."""
    return time.monotonic()


def mask_request_details(url: str, headers: Dict[str, str], body: Any) -> Dict[str, Any]:
    """Mask credentials in a request for safe debug logging.

    Mirrors `maskRequestDetails` in src/services/llm.ts. API keys must never
    reach the logs (spec §6): bearer tokens, `x-api-key`, and Gemini's
    `?key=` query parameter are all redacted.
    """
    masked_headers = dict(headers)
    if "Authorization" in masked_headers:
        masked_headers["Authorization"] = "Bearer ***"
    if "x-api-key" in masked_headers:
        masked_headers["x-api-key"] = "***"
    return {
        "url": re.sub(r"key=[^&]+", "key=***", url),
        "headers": masked_headers,
        "body": body,
    }


# ══════════════════════════════════════════════════════════════════════════════
# Job model
# ══════════════════════════════════════════════════════════════════════════════

class GenerationJob:
    """One provider generation: a growing buffer plus subscriber fan-out.

    The buffer is the source of truth for replay; `length` is the total number
    of characters produced and is what every event's `offset` refers to. The
    two only diverge once the buffer cap is hit (`truncated_buffer`).
    """

    def __init__(self, job_id: str, username: str, meta: Optional[Dict[str, Any]] = None):
        self.job_id = job_id
        self.username = username
        self.meta: Dict[str, Any] = meta if isinstance(meta, dict) else {}
        self.status = "running"  # running | done | error | aborted
        self.buffer = ""
        self.length = 0
        self.truncated_buffer = False
        self.usage: Optional[Dict[str, Any]] = None
        self.error: Optional[str] = None
        self.created_at = _now_iso()
        self.updated_at = self.created_at
        # Time-to-first-token, measured from job creation. The only number that
        # separates provider prefill (large contexts cost seconds before the
        # first byte) from latency this app added; logged once per job.
        self.created_monotonic = _monotonic()
        self.first_delta_latency: Optional[float] = None
        self.finished_at: Optional[float] = None  # monotonic, drives retention
        #: True once some reader has been sent the terminal event. Until then
        #: the result exists nowhere but here (see UNDELIVERED_JOB_TTL_SECONDS).
        self.result_delivered = False
        self.abort_requested = False
        self.task: Optional[asyncio.Task] = None
        #: Prompt size in characters, for reading the latency line in context.
        self.input_chars = 0
        #: Tool calls assembled so far, by index. Kept OUT of `buffer` so
        #: replay offsets stay tied to document text alone — but kept, because
        #: a reconnect that cannot see them loses the whole edit.
        self.tool_calls: Dict[int, Dict[str, Any]] = {}
        #: Completed Anthropic reasoning blocks, in stream order. Kept for the
        #: same reason as tool_calls: the next step must replay them verbatim,
        #: and a reader that attaches after they streamed has no other source.
        self.thinking_blocks: List[Dict[str, Any]] = []
        #: grok (xAI Responses API): this step's output items, verbatim and in
        #: order — reasoning (with its encrypted_content), message,
        #: function_call. The next step sends them back unchanged so the model
        #: keeps its reasoning (see _stream_responses).
        self.response_items: List[Dict[str, Any]] = []
        #: Reasoning the model streamed before (or between) visible tokens.
        #: Counted, never buffered — it is not document text and must not move
        #: the replay offsets.
        self.reasoning_chars = 0
        #: The reasoning text itself, for the step journal only (capped).
        self.reasoning_text = ""
        #: Set at start, for the step journal: the cache conversation and model.
        self.conversation: Optional[str] = None
        self.model: Optional[str] = None
        self.first_reasoning_latency: Optional[float] = None
        #: Why the job failed, for the run engine (agentic_chat_loop.md §0.10):
        #: transient | idle | repetition | context | fatal. None while running or done.
        self.error_kind: Optional[str] = None
        #: The job had streamed text or a tool call when it failed.
        self.failed_after_output = False
        #: xAI repetition-detector triggers seen (cumulative), with `loopCheck` on.
        self.loop_triggers: List[str] = []
        #: Attempts that failed before any output and were sent again.
        self.retries = 0
        # One queue per attached SSE reader. Everything here runs on the single
        # event loop, so plain set mutation is safe without a lock.
        self.subscribers: set = set()

    # ── mutation ──────────────────────────────────────────────────────────────
    def append(self, text: str) -> None:
        """Buffer a provider delta and wake every attached reader."""
        if not text or self.status != "running":
            return
        if self.first_delta_latency is None:
            self.first_delta_latency = _monotonic() - self.created_monotonic
            logger.info(
                "Job %s first token after %.2fs (%s chars of input)",
                self.job_id, self.first_delta_latency, self.input_chars,
            )
        self.length += len(text)
        remaining = MAX_BUFFER_CHARS - len(self.buffer)
        if remaining > 0:
            self.buffer += text[:remaining]
        if len(self.buffer) >= MAX_BUFFER_CHARS and not self.truncated_buffer:
            # Past the cap the job keeps streaming to live subscribers but the
            # buffer stops growing, so a late reader cannot replay the tail.
            self.truncated_buffer = True
        self.updated_at = _now_iso()
        self._publish({"type": "delta", "text": text, "offset": self.length})

    def note_tool_call(
        self,
        index: int,
        call_id: Optional[str],
        name: Optional[str],
        arguments: str,
        signature: Optional[str] = None,
    ) -> None:
        """Forward a tool-call argument delta live.

        Not buffered, for the same reason reasoning is not: it is not document
        text, and putting it in the buffer would shift every replay offset. A
        reconnect re-reads the whole call from the provider's final message
        instead.

        `signature` is Gemini's thoughtSignature for the call. Opaque and
        whole, so it is stored (last non-empty wins), never appended to; the
        key exists only once one arrived, so other providers' entries keep
        their exact shape.
        """
        if self.status != "running":
            return
        entry = self.tool_calls.setdefault(index, {"id": None, "name": None, "arguments": ""})
        if call_id:
            entry["id"] = call_id
        if name:
            entry["name"] = name
        entry["arguments"] += arguments or ""
        if signature:
            entry["signature"] = signature

        event: Dict[str, Any] = {
            "type": "tool_call",
            "index": index,
            "id": call_id,
            "name": name,
            "text": arguments or "",
        }
        if signature:
            event["signature"] = signature
        self._publish(event)

    def note_thinking_block(self, block: Dict[str, Any]) -> None:
        """Keep one COMPLETED Anthropic reasoning block and pass it on.

        Informational (never in TERMINAL_EVENT_TYPES) and never buffered. The
        event carries the block's position so a reader that reconnects
        mid-turn — and is replayed every block again — can skip the ones it
        already has: a duplicated block makes Anthropic reject the replay.
        """
        if self.status != "running" or not isinstance(block, dict):
            return
        index = len(self.thinking_blocks)
        self.thinking_blocks.append(block)
        self._publish({"type": "thinking_block", "index": index, "block": block})

    def note_response_item(self, item: Dict[str, Any]) -> None:
        """Keep one COMPLETED xAI Responses output item and pass it on.

        Same rules as thinking blocks: informational, never buffered, and the
        event carries the item's position so a reconnecting reader skips what
        it already has — a duplicated reasoning item would be replayed twice.
        """
        if self.status != "running" or not isinstance(item, dict):
            return
        index = len(self.response_items)
        self.response_items.append(item)
        self._publish({"type": "response_item", "index": index, "item": item})

    def replace_tool_call_arguments(self, index: int, arguments: str) -> None:
        """The provider's final arguments for a call, when the deltas disagree."""
        entry = self.tool_calls.get(index)
        if self.status != "running" or entry is None or entry.get("arguments") == arguments:
            return
        entry["arguments"] = arguments
        self._publish({
            "type": "tool_call", "index": index, "id": entry.get("id"), "name": entry.get("name"),
            "text": arguments, "replay": True,
        })

    def note_reasoning(self, text: str) -> None:
        """Record a reasoning delta and pass it on live.

        A model can spend a minute reasoning before its first visible token
        (grok-4.6, measured). Without this the server sees that as silence and
        so does the user.
        """
        if not text or self.status != "running":
            return
        if self.first_reasoning_latency is None:
            self.first_reasoning_latency = _monotonic() - self.created_monotonic
            logger.info(
                "Job %s started reasoning after %.2fs",
                self.job_id, self.first_reasoning_latency,
            )
        self.reasoning_chars += len(text)
        if len(self.reasoning_text) < JOURNAL_MAX_CHARS:
            self.reasoning_text += text[: JOURNAL_MAX_CHARS - len(self.reasoning_text)]
        self._publish({"type": "reasoning", "text": text})

    def note_loop_triggers(self, triggers: Any) -> None:
        """Record xAI repetition-detector triggers (each report is cumulative)."""
        if not isinstance(triggers, list):
            return
        new = [str(t) for t in triggers if isinstance(t, str) and t not in self.loop_triggers]
        if new:
            self.loop_triggers.extend(new)
            logger.info("Job %s: repetition detector fired: %s", self.job_id, ", ".join(new))

    @property
    def has_output(self) -> bool:
        """Text or a tool call has streamed: sending the request again would duplicate it."""
        return self.length > 0 or bool(self.tool_calls)

    def reset_for_retry(self) -> None:
        """Forget what a failed attempt that produced nothing left behind."""
        self.tool_calls = {}
        self.thinking_blocks = []
        self.response_items = []
        self.loop_triggers = []

    def finish(
        self,
        status: str,
        usage: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> bool:
        """Move the job to a terminal state. First terminal state wins."""
        if self.status != "running":
            return False
        self.status = status
        self.usage = usage
        self.error = error
        self.updated_at = _now_iso()
        # Prompt-cache result belongs in the same line as the latency it
        # explains. A turn that lost its cached prefix is otherwise
        # indistinguishable from a slow model: same log, ten times the wait.
        prompt_tokens = (usage or {}).get("promptTokens") or 0
        cached_tokens = (usage or {}).get("cachedPromptTokens")
        if cached_tokens is not None and prompt_tokens:
            cache_note = f"cache {cached_tokens}/{prompt_tokens} ({100 * cached_tokens / prompt_tokens:.0f}%)"
        elif prompt_tokens:
            cache_note = f"cache n/a, {prompt_tokens} prompt tokens"
        else:
            cache_note = "cache n/a"
        logger.info(
            "Job %s %s: %s chars in, first token %s, reasoning %s chars, output %s chars, %s",
            self.job_id,
            status,
            self.input_chars,
            f"{self.first_delta_latency:.2f}s" if self.first_delta_latency is not None else "never",
            self.reasoning_chars,
            self.length,
            cache_note,
        )
        self.finished_at = _monotonic()
        journal_step(self)
        self._publish(self.terminal_event())
        return True

    def abort(self) -> bool:
        """Cancel the provider request; the partial buffer stays readable."""
        if self.status != "running":
            return False
        self.abort_requested = True
        # Whoever stopped the turn has already dropped their reader, so the
        # terminal event usually reaches nobody — but this result was thrown
        # away on purpose and must not be kept a day as "unread".
        self.result_delivered = True
        # Flip the status synchronously so the endpoint's response and the
        # terminal SSE event cannot race the task's own cancellation handling.
        self.finish("aborted")
        if self.task is not None:
            self.task.cancel()
        return True

    # ── reads ────────────────────────────────────────────────────────────────
    def terminal_event(self) -> Dict[str, Any]:
        if self.status == "error":
            return {
                "type": "error",
                "message": self.error or "Generation failed.",
                "offset": self.length,
                "truncatedBuffer": self.truncated_buffer,
            }
        return {
            "type": "done",
            "offset": self.length,
            "usage": self.usage,
            "status": self.status,
            "truncatedBuffer": self.truncated_buffer,
        }

    def summary(self) -> Dict[str, Any]:
        return {
            "jobId": self.job_id,
            "status": self.status,
            "meta": self.meta,
            "length": self.length,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "truncatedBuffer": self.truncated_buffer,
            "delivered": self.result_delivered,
        }

    # ── internals ────────────────────────────────────────────────────────────
    def _publish(self, event: Dict[str, Any]) -> None:
        for queue in list(self.subscribers):
            queue.put_nowait(event)


class JobRegistry:
    """In-memory job store, keyed by job id and scoped by username."""

    def __init__(self):
        self._jobs: Dict[str, GenerationJob] = {}

    def create(self, username: str, meta: Optional[Dict[str, Any]] = None) -> GenerationJob:
        self.prune()
        job = GenerationJob(f"gen-{secrets.token_hex(8)}", username, meta)
        self._jobs[job.job_id] = job
        self._enforce_user_limit(username)
        return job

    def get(self, username: str, job_id: str) -> Optional[GenerationJob]:
        """Jobs are strictly per-user: another user's id looks nonexistent."""
        self.prune()
        job = self._jobs.get(job_id)
        if job is None or job.username != username:
            return None
        return job

    def list_for_user(self, username: str) -> List[GenerationJob]:
        self.prune()
        jobs = [j for j in self._jobs.values() if j.username == username]
        jobs.sort(key=lambda j: j.created_at)
        return jobs

    def prune(self) -> None:
        """Drop finished jobs past their retention window (delivered or not)."""
        now = _monotonic()
        for job_id, job in list(self._jobs.items()):
            if job.finished_at is None:
                continue
            ttl = FINISHED_JOB_TTL_SECONDS if job.result_delivered else UNDELIVERED_JOB_TTL_SECONDS
            if now - job.finished_at > ttl:
                del self._jobs[job_id]

    def clear(self) -> None:
        self._jobs.clear()

    def _enforce_user_limit(self, username: str) -> None:
        user_jobs = [j for j in self._jobs.values() if j.username == username]
        excess = len(user_jobs) - MAX_JOBS_PER_USER
        if excess <= 0:
            return
        # Delivered results go first (a copy exists on some client), then the
        # oldest unread one; a running job is never evicted, so a user with 20
        # live generations simply exceeds the cap for a while.
        finished = sorted(
            (j for j in user_jobs if j.finished_at is not None),
            key=lambda j: (not j.result_delivered, j.finished_at),
        )
        for job in finished[:excess]:
            self._jobs.pop(job.job_id, None)


registry = JobRegistry()


# ══════════════════════════════════════════════════════════════════════════════
# Provider request builders — ported from src/services/llm.ts
# ══════════════════════════════════════════════════════════════════════════════

def _split_data_url(image: str) -> Optional[Tuple[str, str]]:
    match = _DATA_URL_RE.match(image or "")
    if not match:
        return None
    return match.group(1), match.group(2)


# ── Tool calling: definitions and history (docs/features/agentic_chat_loop.md)
#
# Wire contract, per message: an assistant reply may carry
# `toolCalls: [{id, name, argumentsText}]`; a tool result is
# `{role: "tool", content, toolCallId, name}`. Before these helpers existed the
# builders copied only role + content, so an agentic loop's tool history was
# dropped without a word and the model never saw its own calls or their
# results.

def _assistant_tool_calls(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The tool calls an assistant message made, or [] for any other message."""
    if message.get("role") != "assistant":
        return []
    calls = message.get("toolCalls")
    if not isinstance(calls, list):
        return []
    return [call for call in calls if isinstance(call, dict)]


def _thinking_blocks(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    """An assistant message's Anthropic reasoning blocks, copied verbatim.

    Mirrors `anthropicThinkingPart` in providerMessages.ts: the known fields
    only, values untouched — Anthropic checks each signature and rejects a
    modified block (400). Anything malformed is skipped rather than sent.
    """
    if message.get("role") != "assistant":
        return []
    raw = message.get("thinking")
    if not isinstance(raw, list):
        return []
    blocks: List[Dict[str, Any]] = []
    for block in raw:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "redacted_thinking" and isinstance(block.get("data"), str):
            blocks.append({"type": "redacted_thinking", "data": block["data"]})
        elif (
            block.get("type") == "thinking"
            and isinstance(block.get("thinking"), str)
            and isinstance(block.get("signature"), str)
        ):
            blocks.append({"type": "thinking", "thinking": block["thinking"], "signature": block["signature"]})
    return blocks


def _arguments_text(call: Dict[str, Any]) -> str:
    text = call.get("argumentsText")
    return text if isinstance(text, str) else ""


def _parsed_arguments(call: Dict[str, Any]) -> Dict[str, Any]:
    """argumentsText as an object — for providers that take arguments parsed.

    Anything that is not a JSON object becomes {}: the providers that want a
    parsed value (Anthropic `input`, Gemini `args`) reject anything else.
    """
    try:
        parsed = json.loads(_arguments_text(call))
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _tool_specs(tools: Any) -> List[Dict[str, Any]]:
    """The OpenAI-shaped tool list a request carries, read back (`fromOpenAITools`;
    malformed entries are skipped rather than failing the whole request)."""
    return from_openai_tools(tools if isinstance(tools, list) else None)


def _anthropic_tools(tools: Any) -> List[Dict[str, Any]]:
    return to_anthropic_tools(_tool_specs(tools))


def _gemini_tools(tools: Any) -> List[Dict[str, Any]]:
    """`toGeminiTools`, or nothing at all for a request without tools."""
    specs = _tool_specs(tools)
    return to_gemini_tools(specs) if specs else []


# ══════════════════════════════════════════════════════════════════════════════
# Reasoning effort
# ══════════════════════════════════════════════════════════════════════════════
#
# Mirrors src/utils/reasoningEffort.ts — the client resolves the level against
# its capability table and sends the RESULT, so this module only has to know
# how each provider spells it. Keep the two in step: a level the client sends
# and this drops is a setting the user changed for nothing.

#: Anthropic and Gemini take a token budget instead of a word.
THINKING_BUDGET_TOKENS = {
    "minimal": 512,
    "low": 1024,
    "medium": 4096,
    "high": 16384,
    "xhigh": 32768,
}


def _reasoning_effort(config: Dict[str, Any]) -> Optional[str]:
    """The level the client resolved, or None when the parameter is to be omitted."""
    effort = config.get("reasoningEffort")
    if not effort or effort == "default":
        return None
    return str(effort) if str(effort) in THINKING_BUDGET_TOKENS else None


def build_openai_request(
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
    provider: str = "openai",
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    """OpenAI-compatible request (openai / ollama / runpod / grok)."""
    api_key = config.get("apiKey") or ""
    base_url = (config.get("baseUrl") or "").rstrip("/")

    headers: Dict[str, str] = {"Content-Type": "application/json"}
    if api_key and api_key != "ollama-no-key":
        headers["Authorization"] = f"Bearer {api_key}"
    # xAI routes requests with the same conversation id to the same cache
    # shard, which maximizes automatic prompt-cache hits across turns.
    if provider == "grok" and config.get("conversationId"):
        headers["x-grok-conv-id"] = str(config["conversationId"])

    url = f"{base_url}/chat/completions"

    openai_messages: List[Dict[str, Any]] = []
    for message in messages:
        images = message.get("images") or []
        content = message.get("content") or ""
        if message.get("role") == "tool":
            openai_messages.append({
                "role": "tool",
                "tool_call_id": message.get("toolCallId") or "",
                "content": content,
            })
            continue
        tool_calls = _assistant_tool_calls(message)
        if tool_calls:
            openai_messages.append({
                "role": "assistant",
                # A reply that only called tools has no text; the API's own
                # replay of such a turn uses null, not "".
                "content": content or None,
                # `arguments` is the text exactly as the model streamed it —
                # never parsed and re-dumped. xAI's prompt cache is
                # exact-prefix, so a re-spaced replay turns every later step
                # into a full-price prefill.
                "tool_calls": [
                    {
                        "id": call.get("id") or "",
                        "type": "function",
                        "function": {"name": call.get("name") or "", "arguments": _arguments_text(call)},
                    }
                    for call in tool_calls
                ],
            })
        elif images:
            parts: List[Dict[str, Any]] = [{"type": "text", "text": content}]
            for idx, img in enumerate(images):
                parts.append({"type": "text", "text": f"\n[Image {idx + 1}]:"})
                parts.append({"type": "image_url", "image_url": {"url": img}})
            openai_messages.append({"role": message.get("role"), "content": parts})
        else:
            openai_messages.append({"role": message.get("role"), "content": content})

    body: Dict[str, Any] = {
        "model": config.get("model"),
        "messages": openai_messages,
        "stream": True,
    }
    if config.get("maxOutputTokens"):
        body["max_tokens"] = config["maxOutputTokens"]

    effort = _reasoning_effort(config)
    if effort:
        body["reasoning_effort"] = effort

    # Tools come from the client already in OpenAI shape — the internal
    # representation, since four of five providers speak it natively.
    if config.get("tools"):
        body["tools"] = config["tools"]
        # The agentic run's last step: tools stay (earlier calls reference
        # them) but no new call is allowed. Mirrors streamOpenAI.
        if config.get("toolChoice") == "none":
            body["tool_choice"] = "none"

    # llama.cpp rejects stream_options, and it sits behind both `ollama` and
    # `runpod`. Detected the same way the client detects it (services/llm.ts):
    # the provider, the sentinel key, or a loopback base URL. The provider has
    # to be in the test because a pod addressed directly is neither loopback
    # nor keyless.
    is_llama_cpp = (
        provider == "runpod"
        or api_key == "ollama-no-key"
        or "localhost" in base_url
        or "127.0.0.1" in base_url
    )
    if not is_llama_cpp:
        body["stream_options"] = {"include_usage": True}

    return url, headers, body


def build_gemini_request(
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    system_message = next((m for m in messages if m.get("role") == "system"), None)

    # Gemini keys a function result by the tool's NAME, not a call id. The
    # client sends `name` on every tool message; recovering it from the call
    # it answers covers a message that arrives without one.
    call_names: Dict[str, str] = {}
    for message in messages:
        for call in _assistant_tool_calls(message):
            if call.get("id") and call.get("name"):
                call_names[str(call["id"])] = str(call["name"])

    contents: List[Dict[str, Any]] = []
    previous_was_tool = False
    for message in messages:
        role = message.get("role")
        if role == "system":
            continue
        content = message.get("content") or ""
        if role == "tool":
            response_part = {
                "functionResponse": {
                    "name": message.get("name") or call_names.get(str(message.get("toolCallId") or ""), ""),
                    "response": {"content": content},
                }
            }
            # Every result for one model turn travels in ONE user message.
            if previous_was_tool and contents:
                contents[-1]["parts"].append(response_part)
            else:
                contents.append({"role": "user", "parts": [response_part]})
            previous_was_tool = True
            continue
        previous_was_tool = False

        tool_calls = _assistant_tool_calls(message)
        if tool_calls:
            model_parts: List[Dict[str, Any]] = [{"text": content}] if content else []
            for call in tool_calls:
                part: Dict[str, Any] = {
                    "functionCall": {"name": call.get("name") or "", "args": _parsed_arguments(call)}
                }
                # Back on the part it came on, as a sibling of functionCall.
                # Gemini 3 rejects a step whose first call lacks it; only the
                # first of parallel calls ever has one.
                signature = call.get("signature")
                if isinstance(signature, str) and signature:
                    part["thoughtSignature"] = signature
                model_parts.append(part)
            contents.append({"role": "model", "parts": model_parts})
            continue

        parts: List[Dict[str, Any]] = [{"text": content}]
        for idx, img in enumerate(message.get("images") or []):
            split = _split_data_url(img)
            if split:
                parts.append({"text": f"\n[Image {idx + 1}]:"})
                parts.append({"inlineData": {"mimeType": split[0], "data": split[1]}})
        contents.append({
            "role": "model" if message.get("role") == "assistant" else "user",
            "parts": parts,
        })

    body: Dict[str, Any] = {"contents": contents}
    if system_message:
        body["systemInstruction"] = {"parts": [{"text": system_message.get("content") or ""}]}
    if config.get("geminiSafetySettings"):
        body["safetySettings"] = config["geminiSafetySettings"]
    generation_config: Dict[str, Any] = {}
    if config.get("maxOutputTokens"):
        generation_config["maxOutputTokens"] = config["maxOutputTokens"]
    gemini_effort = _reasoning_effort(config)
    if gemini_effort:
        # Gemini spends effort as a token budget rather than a word.
        generation_config["thinkingConfig"] = {"thinkingBudget": THINKING_BUDGET_TOKENS[gemini_effort]}
    if generation_config:
        body["generationConfig"] = generation_config
    gemini_tools = _gemini_tools(config.get("tools"))
    if gemini_tools:
        body["tools"] = gemini_tools
        if config.get("toolChoice") == "none":
            body["toolConfig"] = {"functionCallingConfig": {"mode": "NONE"}}

    # Support model names with or without the 'models/' prefix.
    model = config.get("model") or ""
    model_name = model[7:] if model.startswith("models/") else model
    url = (
        f"{(config.get('baseUrl') or '').rstrip('/')}/models/{model_name}"
        f":streamGenerateContent?key={config.get('apiKey') or ''}"
    )
    return url, {"Content-Type": "application/json"}, body


def build_anthropic_request(
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    system_message = next((m for m in messages if m.get("role") == "system"), None)
    non_system = [m for m in messages if m.get("role") != "system"]

    anthropic_messages: List[Dict[str, Any]] = []
    # source_index[i]: the anthropic_messages entry non_system[i] landed in
    # (`sourceIndex` in src/services/providerMessages.ts). Merging tool results
    # breaks the old one-to-one indexing, and the cache breakpoint loop below
    # has to find the message the hint was set on.
    source_index: List[int] = []
    previous_was_tool = False
    for message in non_system:
        images = message.get("images") or []
        content = message.get("content") or ""
        role = message.get("role")

        if role == "tool":
            result_block = {
                "type": "tool_result",
                "tool_use_id": message.get("toolCallId") or "",
                "content": content,
            }
            # Anthropic requires every result for one assistant turn in ONE
            # user message, so consecutive tool messages share it.
            if previous_was_tool and anthropic_messages:
                anthropic_messages[-1]["content"].append(result_block)
            else:
                anthropic_messages.append({"role": "user", "content": [result_block]})
            source_index.append(len(anthropic_messages) - 1)
            previous_was_tool = True
            continue
        previous_was_tool = False
        source_index.append(len(anthropic_messages))

        tool_calls = _assistant_tool_calls(message)
        thinking = _thinking_blocks(message)
        if tool_calls or thinking:
            # Reasoning first, verbatim, then text, then tool_use — the order
            # Anthropic streamed them in; manual extended thinking also needs
            # the replayed turn to BEGIN with a thinking block.
            blocks: List[Dict[str, Any]] = list(thinking)
            if content:
                blocks.append({"type": "text", "text": content})
            for call in tool_calls:
                blocks.append({
                    "type": "tool_use",
                    "id": call.get("id") or "",
                    "name": call.get("name") or "",
                    "input": _parsed_arguments(call),
                })
            anthropic_messages.append({"role": "assistant", "content": blocks})
            continue

        if images:
            # A text block may not be empty (minLength 1): an image-only message has none.
            parts: List[Dict[str, Any]] = [{"type": "text", "text": content}] if content else []
            for idx, img in enumerate(images):
                split = _split_data_url(img)
                if split:
                    parts.append({"type": "text", "text": f"\n[Image {idx + 1}]:"})
                    parts.append({
                        "type": "image",
                        "source": {"type": "base64", "media_type": split[0], "data": split[1]},
                    })
            anthropic_messages.append({"role": message.get("role"), "content": parts})
        else:
            anthropic_messages.append({"role": message.get("role"), "content": content})

    body: Dict[str, Any] = {
        "model": config.get("model"),
        "messages": anthropic_messages,
        # Respect the user's configured limit as-is: modern Claude models accept
        # far more than 8192 output tokens, and clamping silently truncated long
        # full-document <canvas> rewrites.
        "max_tokens": config.get("maxOutputTokens") or 8192,
        "stream": True,
    }

    anthropic_tools = _anthropic_tools(config.get("tools"))
    if anthropic_tools:
        body["tools"] = anthropic_tools
        if config.get("toolChoice") == "none":
            body["tool_choice"] = {"type": "none"}

    # Thinking, in the shape this model takes (wc_text.reasoning_effort.anthropic_thinking):
    # adaptive with an effort on Opus 4.6+ and 5.x, which refuse a budget; a
    # budget under max_tokens before that. The level is resolved here against
    # the model, so an unset one gets the app's default and one the model does
    # not take is not sent at all.
    body.update(anthropic_thinking(
        config.get("model") or "",
        resolve_reasoning_effort("anthropic", config.get("model") or "", config.get("reasoningEffort")),
        body.get("max_tokens") or 8192,
    ))

    # Structured system prompt with cache_control for Anthropic prompt caching.
    if system_message:
        body["system"] = [{
            "type": "text",
            "text": system_message.get("content") or "",
            "cache_control": {"type": "ephemeral"},
        }]

    # Place cache breakpoints where the caller marked the end of a stable
    # prefix (`cacheHint`, e.g. the last history message before the volatile
    # document context). Anthropic looks back from each breakpoint for hits,
    # so a breakpoint that advances turn-by-turn still reads last turn's cache.
    # Max 3 message-level breakpoints (the system block uses the 4th slot).
    cache_breakpoints = 0
    for idx, source in enumerate(non_system):
        if not source.get("cacheHint") or cache_breakpoints >= 3 or not source.get("content"):
            continue
        target = anthropic_messages[source_index[idx]]
        if isinstance(target["content"], str):
            target["content"] = [{
                "type": "text",
                "text": target["content"],
                "cache_control": {"type": "ephemeral"},
            }]
            cache_breakpoints += 1
        elif isinstance(target["content"], list) and target["content"]:
            target["content"][-1]["cache_control"] = {"type": "ephemeral"}
            cache_breakpoints += 1

    url = f"{(config.get('baseUrl') or '').rstrip('/')}/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": config.get("apiKey") or "",
        # Prompt caching is GA: the old prompt-caching beta header is not sent.
        "anthropic-version": "2023-06-01",
    }
    return url, headers, body


# ══════════════════════════════════════════════════════════════════════════════
# Provider streaming
# ══════════════════════════════════════════════════════════════════════════════

@asynccontextmanager
async def _http_stream(url: str, headers: Dict[str, str], body: Dict[str, Any], read_timeout: Optional[float] = None):
    """Open a streaming POST. The single seam tests patch to stub the network."""
    timeout = httpx.Timeout(read_timeout or HTTP_READ_TIMEOUT, connect=HTTP_CONNECT_TIMEOUT)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", url, headers=headers, json=body) as response:
            yield response


async def _read_error_text(response: Any) -> str:
    try:
        raw = await response.aread()
    except Exception:
        return ""
    if isinstance(raw, (bytes, bytearray)):
        return raw.decode("utf-8", "replace")
    return str(raw or "")


def _debug_log(provider: str, url: str, headers: Dict[str, str], body: Dict[str, Any], config: Dict[str, Any]) -> None:
    if config.get("debug"):
        logger.info("Outgoing %s request: %s", provider, mask_request_details(url, headers, body))


def _check_abort(job: GenerationJob) -> None:
    if job.abort_requested:
        raise _JobAborted()


# Problem: a turn whose first step re-sent its whole prompt (cache 512 of
#   17117 tokens, 2026-10-06) looks the same in the log whether OUR request
#   changed (a preset switch, a rebuilt message) or the provider simply
#   missed its cache, so there was nothing to say which one to fix.
# Fix: compare each request with the previous one in the same conversation
#   (the cache routing key) and log where they part: the model, the tools,
#   or the first message that differs.
PREFIX_MEMORY = 64
_last_requests: "OrderedDict[str, Tuple[float, str, str, List[str]]]" = OrderedDict()


def _fingerprint(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def describe_prefix(conversation: str, body: Dict[str, Any], now: Optional[float] = None) -> str:
    """How this request's prefix relates to the conversation's previous one."""
    now = time.monotonic() if now is None else now
    messages = body.get("messages") or body.get("input") or []
    hashes = [_fingerprint(m) for m in messages]
    tools = _fingerprint(body.get("tools") or [])
    model = str(body.get("model") or "")
    previous = _last_requests.pop(conversation, None)
    _last_requests[conversation] = (now, model, tools, hashes)
    while len(_last_requests) > PREFIX_MEMORY:
        _last_requests.popitem(last=False)
    if previous is None:
        return "first request seen in this conversation"
    then, prev_model, prev_tools, prev_hashes = previous
    same = 0
    while same < min(len(hashes), len(prev_hashes)) and hashes[same] == prev_hashes[same]:
        same += 1
    parts = [f"{now - then:.0f}s after the previous request"]
    if prev_model != model:
        parts.append(f"model changed ({prev_model} -> {model})")
    if prev_tools != tools:
        parts.append("tools changed")
    if same == len(prev_hashes):
        parts.append(f"extends it (all {same} earlier messages identical)")
    else:
        differing = messages[same] if same < len(messages) else {}
        content = differing.get("content") if isinstance(differing, dict) else None
        parts.append(
            f"first {same} of its {len(prev_hashes)} messages identical; "
            f"message #{same} ({differing.get('role') if isinstance(differing, dict) else '?'}, "
            f"{len(content) if isinstance(content, str) else 0} chars) differs"
        )
    return "; ".join(parts)


def _response_items(message: Dict[str, Any]) -> List[Dict[str, Any]]:
    """An assistant message's xAI Responses output items, verbatim.

    Mirrors `responseItemsOf` in providerMessages.ts. The items are opaque
    (the reasoning ciphertext above all) and go back exactly as they came.
    """
    if message.get("role") != "assistant":
        return []
    raw = message.get("responseItems")
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, dict) and isinstance(item.get("type"), str)]


# grok, and OpenAI at its own host, run on the Responses API (wc_text.provider_profile.uses_responses_api).
# Problem (OpenAI, measured 2026-10-10): from gpt-5.4 on, Chat Completions
#   refuses function tools with reasoning ("use /v1/responses"), and gpt-5.6 /
#   gpt-6.x refuse tools there even with no effort set — every agent step
#   carries tools, so those models could not be used at all.
# Fix: the same Responses path as grok, with OpenAI's own spelling of the
#   reasoning (build_responses_request). A compatible server under the
#   `openai` provider stays on Chat Completions.


def build_responses_request(
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
    provider: str = "grok",
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    """grok over the xAI Responses API, or OpenAI over its own (uses_responses_api).

    Problem: on Chat Completions a step's reasoning is gone by the next step.
      grok planned a chapter for 83 s, called a tool, and the next step — with
      0 reasoning tokens and only its own one-line announcement to go on —
      looped on list_chapters 13 times (2026-10-06). xAI also names omitted
      reasoning "the top cause of cache misses", and lists Chat Completions as
      deprecated.
    Fix: the Responses API returns each step's reasoning as an encrypted item;
      every step sends the previous steps' items back unchanged. `store` is
      false and the ciphertext is requested explicitly, so nothing of the
      book is kept on xAI's side for later retrieval.
    """
    api_key = config.get("apiKey") or ""
    base_url = (config.get("baseUrl") or "").rstrip("/")
    headers: Dict[str, str] = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    if provider == "grok" and config.get("conversationId"):
        headers["x-grok-conv-id"] = str(config["conversationId"])

    items: List[Dict[str, Any]] = []
    for message in messages:
        role = message.get("role")
        content = message.get("content") or ""
        if role == "tool":
            items.append({"type": "function_call_output", "call_id": message.get("toolCallId") or "", "output": content})
            continue
        if role == "assistant":
            # Items the reply kept go back verbatim; whatever they do not
            # cover (a history message keeps only its reasoning) is rebuilt
            # from the text and calls, after them.
            replay = _response_items(message)
            items.extend(replay)
            has_message = any(item.get("type") == "message" for item in replay)
            replayed_calls = {item.get("call_id") for item in replay if item.get("type") == "function_call"}
            calls = [c for c in _assistant_tool_calls(message) if c.get("id") not in replayed_calls]
            if not has_message and (content or (not calls and not replay)):
                items.append({"role": "assistant", "content": content})
            for call in calls:
                items.append({
                    "type": "function_call",
                    "call_id": call.get("id") or "",
                    "name": call.get("name") or "",
                    "arguments": _arguments_text(call),
                })
            continue
        images = message.get("images") or []
        if images:
            parts: List[Dict[str, Any]] = [{"type": "input_text", "text": content}]
            for idx, img in enumerate(images):
                parts.append({"type": "input_text", "text": f"\n[Image {idx + 1}]:"})
                parts.append({"type": "input_image", "image_url": img})
            items.append({"role": role, "content": parts})
        else:
            items.append({"role": role, "content": content})

    body: Dict[str, Any] = {
        "model": config.get("model"),
        "input": items,
        "stream": True,
        "store": False,
        "include": ["reasoning.encrypted_content"],
    }
    if config.get("maxOutputTokens"):
        body["max_output_tokens"] = config["maxOutputTokens"]
    if provider == "openai":
        # Resolved against the model here: OpenAI's families take different
        # sets (gpt-5 has minimal, 5.1 none, 5.4+ xhigh; gpt-4o/4.1 refuse the
        # field), and a summary streams the reasoning to the chat live.
        effort = resolve_reasoning_effort("openai", config.get("model") or "", config.get("reasoningEffort"))
        if effort:
            body["reasoning"] = {"effort": effort, "summary": "auto"}
        else:
            # A model without reasoning has no encrypted reasoning to return.
            body.pop("include", None)
    else:
        effort = _reasoning_effort(config)
        if effort:
            body["reasoning"] = {"effort": effort}
    if config.get("conversationId"):
        body["prompt_cache_key"] = str(config["conversationId"])
    tools = _tool_specs(config.get("tools"))
    if tools:
        # OpenAI's Responses API makes function tools strict by default, and a
        # strict schema has every property required: the model then fills each
        # optional argument with an empty value (`"paragraphs": ""`, measured
        # 2026-10-10), which the tools read as a request. Ours are not strict.
        strict = {"strict": False} if provider == "openai" else {}
        body["tools"] = [{"type": "function", **spec, **strict} for spec in tools]
        if config.get("toolChoice") == "none":
            body["tool_choice"] = "none"
    return f"{base_url}/responses", headers, body


async def _stream_responses(
    job: GenerationJob,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
    provider: str = "grok",
) -> Optional[Dict[str, Any]]:
    url, headers, body = build_responses_request(config, messages, provider)
    label = "xAI" if provider == "grok" else "OpenAI"
    _debug_log(f"{label} Responses", url, headers, body, config)
    if config.get("conversationId"):
        logger.info("Job %s prefix: %s", job.job_id, describe_prefix(f"{provider}:{config['conversationId']}", body))

    if provider == "grok" and config.get("loopCheck"):
        headers = {**headers, **LOOP_CHECK_HEADERS}
    usage: Optional[Dict[str, Any]] = None
    async with _http_stream(url, headers, body, read_timeout=IDLE_TIMEOUT_SECONDS.get(provider)) as response:
        if response.status_code >= 400:
            raise _http_error(label, response, await _read_error_text(response))
        async for line in response.aiter_lines():
            _check_abort(job)
            trimmed = (line or "").strip()
            if not trimmed.startswith("data:"):
                continue
            data = trimmed[5:].strip()
            if not data or data == "[DONE]":
                continue
            try:
                event = json.loads(data)
            except ValueError:
                logger.warning("Failed to parse xAI Responses SSE chunk for job %s", job.job_id)
                continue
            kind = event.get("type")
            index = event.get("output_index") or 0
            if kind == "response.output_text.delta":
                job.append(event.get("delta") or "")
            elif kind == "response.reasoning_summary_text.delta":
                job.note_reasoning(event.get("delta") or "")
            elif kind == "response.output_item.added":
                item = event.get("item") or {}
                if item.get("type") == "function_call":
                    job.note_tool_call(index, item.get("call_id"), item.get("name"), item.get("arguments") or "")
            elif kind == "response.function_call_arguments.delta":
                job.note_tool_call(index, None, None, event.get("delta") or "")
            elif kind == "response.output_item.done":
                item = event.get("item")
                if isinstance(item, dict):
                    if item.get("type") == "function_call" and isinstance(item.get("arguments"), str):
                        job.replace_tool_call_arguments(index, item["arguments"])
                    job.note_response_item(item)
            elif kind == "response.doom_loop_check":
                job.note_loop_triggers((event.get("doom_loop_check") or {}).get("triggers"))
            elif kind in ("response.completed", "response.incomplete"):
                job.note_loop_triggers(((event.get("response") or {}).get("doom_loop_check") or {}).get("triggers"))
                u = (event.get("response") or {}).get("usage") or {}
                usage = {
                    "promptTokens": u.get("input_tokens") or 0,
                    "completionTokens": u.get("output_tokens") or 0,
                    "cachedPromptTokens": (u.get("input_tokens_details") or {}).get("cached_tokens") or 0,
                    "reasoningTokens": (u.get("output_tokens_details") or {}).get("reasoning_tokens") or 0,
                }
            elif kind in ("response.failed", "error"):
                failure = (event.get("response") or {}).get("error") or event
                code = str(failure.get("code") or "")
                message = str(failure.get("message") or "")
                raise ProviderError(f"{label} API error: {message or code or 'response failed'}",
                                    transient=code in ("server_error", "internal_error", "overloaded") or "internal error" in message.lower())
    return usage


async def _stream_openai(
    job: GenerationJob,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
    provider: str,
) -> Optional[Dict[str, Any]]:
    url, headers, body = build_openai_request(config, messages, provider)
    _debug_log("OpenAI", url, headers, body, config)
    if config.get("conversationId"):
        logger.info("Job %s prefix: %s", job.job_id, describe_prefix(f"{provider}:{config['conversationId']}", body))

    usage: Optional[Dict[str, Any]] = None
    async with _http_stream(url, headers, body) as response:
        if response.status_code >= 400:
            err = await _read_error_text(response)
            raise _http_error("OpenAI", response, err)

        async for line in response.aiter_lines():
            _check_abort(job)
            trimmed = (line or "").strip()
            if not trimmed or not trimmed.startswith("data:"):
                continue
            data = trimmed[5:].strip()
            if data == "[DONE]":
                continue
            try:
                parsed = json.loads(data)
            except ValueError:
                logger.warning("Failed to parse OpenAI SSE chunk for job %s", job.job_id)
                continue

            choices = parsed.get("choices") or []
            if choices:
                delta = choices[0].get("delta") or {}
                content = delta.get("content")
                if content:
                    job.append(content)
                # Reasoning models emit their thinking on a separate key before
                # any visible token. Dropping it made a minute of work look
                # like a dead connection. Two spellings in the wild.
                reasoning = delta.get("reasoning_content") or delta.get("reasoning")
                if reasoning:
                    job.note_reasoning(reasoning)
                for tc in delta.get("tool_calls") or []:
                    fn = tc.get("function") or {}
                    job.note_tool_call(
                        tc.get("index") or 0,
                        tc.get("id"),
                        fn.get("name"),
                        fn.get("arguments") or "",
                    )
            if parsed.get("usage"):
                u = parsed["usage"]
                usage = {
                    "promptTokens": u.get("prompt_tokens") or 0,
                    "completionTokens": u.get("completion_tokens") or 0,
                    "cachedPromptTokens": (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0,
                    "reasoningTokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0,
                }
    return usage


async def _stream_anthropic(
    job: GenerationJob,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    url, headers, body = build_anthropic_request(config, messages)
    _debug_log("Anthropic", url, headers, body, config)

    # Anthropic usage accounting.
    # Problem: session cache stats showed near-zero hits and negative misses.
    # Root cause: Anthropic's `input_tokens` EXCLUDES cached tokens —
    #   cache_read/cache_creation are separate fields — so using it as the
    #   total undercounted input, and `miss = input - hit` went negative
    #   whenever the cache worked. Also `message_delta.usage.output_tokens`
    #   is CUMULATIVE, so `+=` double-counted output.
    # Fix: total input = input_tokens + cache_creation + cache_read;
    #   treat message_delta's output as the authoritative running total.
    input_tokens = 0
    output_tokens = 0
    cached_prompt_tokens = 0
    # Reasoning blocks being assembled, by content-block index (streamAnthropic's
    # `openThinking`): thinking_delta text plus the signature_delta that comes
    # just before content_block_stop. redacted_thinking arrives whole in its
    # start event. Published once complete, never half-built.
    open_thinking: Dict[int, Dict[str, Any]] = {}
    stop_reason: Optional[str] = None

    async with _http_stream(url, headers, body) as response:
        if response.status_code >= 400:
            err = await _read_error_text(response)
            raise _http_error("Anthropic", response, err)

        async for line in response.aiter_lines():
            _check_abort(job)
            trimmed = (line or "").strip()
            if not trimmed or not trimmed.startswith("data:"):
                continue
            try:
                parsed = json.loads(trimmed[5:].strip())
            except ValueError:
                continue  # structural events (ping, event: lines) are not deltas

            event_type = parsed.get("type")
            delta = parsed.get("delta") or {}
            block = parsed.get("content_block") or {}
            # Tool calls are keyed by the event's content-block index, as
            # streamAnthropic does (`json.index ?? 0`): a text block before
            # the call makes it index 1, and that is fine — it is a key.
            block_index = parsed.get("index")
            if block_index is None:
                block_index = 0
            if event_type == "content_block_start" and block.get("type") == "redacted_thinking":
                open_thinking[block_index] = {"type": "redacted_thinking", "data": str(block.get("data") or "")}
            elif event_type == "content_block_start" and block.get("type") == "thinking":
                open_thinking[block_index] = {
                    "type": "thinking",
                    "thinking": str(block.get("thinking") or ""),
                    "signature": str(block.get("signature") or ""),
                }
            elif event_type == "content_block_delta" and delta.get("type") == "thinking_delta":
                building = open_thinking.get(block_index)
                if building is not None and building["type"] == "thinking":
                    building["thinking"] += delta.get("thinking") or ""
                # Shown live, as grok's reasoning is: a long think is not a dead connection.
                if delta.get("thinking"):
                    job.note_reasoning(delta["thinking"])
            elif event_type == "content_block_delta" and delta.get("type") == "signature_delta":
                building = open_thinking.get(block_index)
                if building is not None and building["type"] == "thinking":
                    building["signature"] += delta.get("signature") or ""
            elif event_type == "content_block_stop" and block_index in open_thinking:
                job.note_thinking_block(open_thinking.pop(block_index))
            elif event_type == "content_block_start" and block.get("type") == "tool_use":
                # Anthropic opens a block naming the tool, then streams its
                # input as JSON fragments.
                job.note_tool_call(block_index, block.get("id"), block.get("name"), "")
            elif event_type == "content_block_delta" and delta.get("type") == "input_json_delta":
                job.note_tool_call(block_index, None, None, delta.get("partial_json") or "")
            elif event_type in ("content_block_delta", "message_delta") and delta.get("text"):
                job.append(delta["text"])

            if event_type == "message_start" and (parsed.get("message") or {}).get("usage"):
                u = parsed["message"]["usage"]
                input_tokens = (
                    (u.get("input_tokens") or 0)
                    + (u.get("cache_creation_input_tokens") or 0)
                    + (u.get("cache_read_input_tokens") or 0)
                )
                output_tokens = u.get("output_tokens") or 0
                cached_prompt_tokens = u.get("cache_read_input_tokens") or 0
            elif event_type == "message_delta" and (parsed.get("usage") or {}).get("output_tokens"):
                # Assignment, not +=: this field is a running total.
                output_tokens = parsed["usage"]["output_tokens"]
            if event_type == "message_delta" and delta.get("stop_reason"):
                stop_reason = delta["stop_reason"]
            elif event_type == "error":
                # An error inside an open stream (overloaded_error): retryable like a 529.
                err = parsed.get("error") or {}
                raise ProviderError(f"Anthropic stream error: {err.get('type') or 'error'}: {err.get('message') or ''}",
                                    transient=err.get("type") in ("overloaded_error", "api_error"))

    # A refusal is a 200 with no answer: say so, or the turn ends in silence.
    if stop_reason == "refusal" and job.length == 0 and not job.tool_calls:
        raise ProviderError("Anthropic declined to answer this request (stop_reason: refusal).")

    if input_tokens > 0 or output_tokens > 0:
        return {
            "promptTokens": input_tokens,
            "completionTokens": output_tokens,
            "cachedPromptTokens": cached_prompt_tokens,
        }
    return None


def _extract_json_objects(buffer: str) -> Tuple[List[str], str]:
    """Split off every complete top-level {...} object from a Gemini stream.

    streamGenerateContent emits a JSON array whose elements arrive piecewise,
    so the client brace-matches complete objects out of a growing buffer
    instead of waiting for valid JSON. Ported from llm.ts with proper
    backslash-escape tracking.
    """
    objects: List[str] = []
    depth = 0
    in_string = False
    escaped = False
    start = -1
    consumed = 0

    for i, char in enumerate(buffer):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if depth == 0:
                start = i
            depth += 1
        elif char == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    objects.append(buffer[start:i + 1])
                    consumed = i + 1
                    start = -1

    return objects, buffer[consumed:]


def _handle_gemini_chunk(
    job: GenerationJob,
    chunk: Dict[str, Any],
    usage: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    # Detect prompt-level safety blocks (e.g. prohibited content).
    block_reason = (chunk.get("promptFeedback") or {}).get("blockReason")
    if block_reason:
        raise ProviderError(f"Content generation blocked by safety policy: {block_reason}")

    if chunk.get("usageMetadata"):
        meta = chunk["usageMetadata"]
        usage = {
            "promptTokens": meta.get("promptTokenCount") or 0,
            "completionTokens": meta.get("candidatesTokenCount") or 0,
            "cachedPromptTokens": meta.get("cachedContentTokenCount") or 0,
        }

    candidates = chunk.get("candidates") or []
    if candidates:
        candidate = candidates[0]
        # Detect response-level safety blocks or abnormal termination
        # (e.g. SAFETY, RECITATION).
        finish_reason = candidate.get("finishReason")
        if finish_reason and finish_reason not in ("STOP", "MAX_TOKENS"):
            raise ProviderError(
                f"Content generation blocked or terminated abnormally: {finish_reason}"
            )
        parts = (candidate.get("content") or {}).get("parts") or []
        if parts:
            text = parts[0].get("text")
            if text:
                job.append(text)
        for part in parts:
            function_call = part.get("functionCall") if isinstance(part, dict) else None
            if isinstance(function_call, dict):
                # Gemini delivers a call whole, not in fragments, so it is one
                # delta carrying the complete arguments — and each call gets
                # the next index (streamGemini's `functionCallIndex++`), since
                # parallel calls sharing index 0 merge into one garbage call.
                # Compact, non-ASCII-preserving JSON mirrors
                # `JSON.stringify(args ?? {})` byte for byte.
                args = function_call.get("args")
                signature = part.get("thoughtSignature")
                job.note_tool_call(
                    len(job.tool_calls),
                    None,
                    function_call.get("name"),
                    json.dumps(
                        args if args is not None else {},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    # Sits beside functionCall on the part; first of parallel
                    # calls only. Must go back on the same part.
                    signature if isinstance(signature, str) else None,
                )
    return usage


async def _stream_gemini(
    job: GenerationJob,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    url, headers, body = build_gemini_request(config, messages)
    _debug_log("Gemini", url, headers, body, config)

    usage: Optional[Dict[str, Any]] = None
    buffer = ""
    async with _http_stream(url, headers, body) as response:
        if response.status_code >= 400:
            err = await _read_error_text(response)
            raise _http_error("Gemini", response, err)

        async for text in response.aiter_text():
            _check_abort(job)
            buffer += text or ""
            objects, buffer = _extract_json_objects(buffer)
            for raw in objects:
                try:
                    chunk = json.loads(raw)
                except ValueError:
                    continue  # a fragment that is not a standalone object
                usage = _handle_gemini_chunk(job, chunk, usage)
    return usage


_REASONING_REJECTION_RE = re.compile(
    r"(reasoning_effort|thinking|reasoning)[^\n]{0,120}?"
    r"(unsupported|not supported|unknown|unrecognized|invalid|does not support)"
    r"|(unsupported|unknown|unrecognized|invalid)[^\n]{0,40}?(reasoning_effort|thinking)",
    re.IGNORECASE,
)


def _is_reasoning_effort_rejection(message: str) -> bool:
    """Did the provider refuse the request because of the effort parameter?

    The client's capability table is a best guess about other people's APIs
    (none of them expose it), so a wrong guess must cost one retry rather than
    the whole turn.
    """
    return bool(_REASONING_REJECTION_RE.search(message or ""))


async def _dispatch_provider(
    job: GenerationJob,
    provider: str,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    if uses_responses_api(provider, config.get("baseUrl") or ""):
        return await _stream_responses(job, config, messages, provider)
    if provider in ("openai", "ollama", "runpod"):
        return await _stream_openai(job, config, messages, provider)
    if provider == "gemini":
        return await _stream_gemini(job, config, messages)
    if provider == "anthropic":
        return await _stream_anthropic(job, config, messages)
    raise ProviderError(f"Unsupported LLM provider: {provider}")


def classify_failure(exc: BaseException, job: GenerationJob) -> str:
    """Why a job failed (agentic_chat_loop.md §0.10): transient | idle | repetition | context | fatal."""
    if job.loop_triggers:
        # The detector ends the generation (measured): whatever the error says, the loop is the cause.
        return "repetition"
    if isinstance(exc, httpx.ReadTimeout):
        return "idle"
    if isinstance(exc, httpx.TransportError):
        return "transient"
    if isinstance(exc, ProviderError):
        if exc.status is not None:
            if is_context_length_error(exc.status, str(exc)):
                return "context"
            return "transient" if is_retryable_status(exc.status, str(exc)) else "fatal"
        return "transient" if exc.transient else "fatal"
    return "fatal"


async def _dispatch_with_retries(job: GenerationJob, provider: str, config: Dict[str, Any], messages: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """One provider call, sent again while it fails transiently before producing anything.

    Problem: a 429, a 503 or a dropped connection ended the turn, and on a
      server run it ended the run, with every finished step's progress.
    Fix: the same request is sent again (wc_text.retry_policy: Retry-After
      when given, else 1, 2, 4, 8 s with jitter, at most four more times) —
      only while nothing has streamed, so nothing is duplicated. A request
      that started streaming is the run engine's to redo (server_runs._step).
    """
    attempt = 0
    while True:
        try:
            return await _dispatch_provider(job, provider, config, messages)
        except (asyncio.CancelledError, _JobAborted):
            raise
        except Exception as exc:  # noqa: BLE001 — classified, then retried or re-raised
            kind = classify_failure(exc, job)
            if kind != "transient" or job.has_output or attempt >= MAX_TRANSPORT_RETRIES or job.abort_requested:
                raise
            attempt += 1
            job.retries = attempt
            retry_after = getattr(exc, "retry_after", None)
            delay = with_jitter(retry_delay_ms(attempt, retry_after), random.random()) / 1000
            logger.info("Job %s: %s; retry %d/%d in %.1fs", job.job_id, str(exc)[:200] or type(exc).__name__, attempt, MAX_TRANSPORT_RETRIES, delay)
            job.reset_for_retry()
            job._publish({"type": "retry", "attempt": attempt, "max": MAX_TRANSPORT_RETRIES, "delayMs": int(delay * 1000),
                          "reason": (str(exc) or type(exc).__name__)[:200]})
            await asyncio.sleep(delay)
            _check_abort(job)


async def run_job(
    job: GenerationJob,
    provider: str,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> None:
    """Drive one provider stream to a terminal job state. Never raises."""
    try:
        try:
            usage = await _dispatch_with_retries(job, provider, config, messages)
        except ProviderError as exc:
            # A replayed reasoning item the service can no longer decrypt
            # (key rotation, model change) is a 400 for the whole turn: once
            # more without the items, so only the carried reasoning is lost.
            if job.length == 0 and "encrypted_content" in str(exc) and any(
                isinstance(m, dict) and m.get("responseItems") for m in messages
            ):
                logger.info("Job %s: provider rejected the replayed reasoning; retrying without it", job.job_id)
                stripped = [{k: v for k, v in m.items() if k != "responseItems"} if isinstance(m, dict) else m for m in messages]
                usage = await _dispatch_provider(job, provider, config, stripped)
                job.finish("done", usage=usage)
                return
            # Safe to retry only before any token was buffered — a parameter
            # rejection is a 400 at request time, so nothing has streamed.
            # "default" is the one setting that sends nothing; an unset one may
            # resolve to the app's default level (build_anthropic_request).
            if not (
                config.get("reasoningEffort") != "default"
                and job.length == 0
                and _is_reasoning_effort_rejection(str(exc))
            ):
                raise
            logger.info(
                "Job %s: provider rejected the reasoning effort; retrying without it",
                job.job_id,
            )
            retry_config = {**config, "reasoningEffort": "default"}
            usage = await _dispatch_provider(job, provider, retry_config, messages)
        job.finish("done", usage=usage)
    except (asyncio.CancelledError, _JobAborted):
        # Swallowed deliberately: cancellation here is the abort endpoint's
        # signal (it already flipped the status), and re-raising would only
        # surface as an unretrieved task exception on a job nobody awaits.
        job.finish("aborted")
    except Exception as exc:  # noqa: BLE001 — any provider failure becomes an error event
        message = str(exc) or type(exc).__name__ or "Unknown network error"
        job.error_kind = classify_failure(exc, job)
        job.failed_after_output = job.has_output
        if job.error_kind == "idle":
            message = f"The model sent nothing for {int(IDLE_TIMEOUT_SECONDS.get(provider, HTTP_READ_TIMEOUT))} s; the stream was given up."
        logger.warning("Generation job %s failed (%s%s): %s", job.job_id, job.error_kind,
                       ", after output" if job.failed_after_output else "", message)
        job.finish("error", error=message)


# ══════════════════════════════════════════════════════════════════════════════
# SSE
# ══════════════════════════════════════════════════════════════════════════════

def _sse(event: Dict[str, Any]) -> str:
    # Compact separators: one frame per delta, so the padding adds up.
    return f"data: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"


async def _job_event_stream(job: GenerationJob, from_offset: int):
    """Replay the buffer past `from_offset`, then stream live events.

    Every event carries the offset *after* it has been applied, so a client
    that reconnects with the last offset it rendered sees neither a duplicate
    nor a gap.
    """
    queue: asyncio.Queue = asyncio.Queue()
    # Subscribing BEFORE snapshotting the buffer is what makes the handover
    # exact: there is no await between the two statements, so no append can
    # slip in unseen — every queued event is strictly newer than the snapshot.
    job.subscribers.add(queue)
    snapshot = job.buffer
    snapshot_offset = job.length
    tool_calls_snapshot = {i: dict(c) for i, c in job.tool_calls.items()}
    thinking_snapshot = list(job.thinking_blocks)
    response_items_snapshot = list(job.response_items)
    terminal = job.terminal_event() if job.status != "running" else None

    try:
        # Flush the response headers immediately.
        #
        # Problem: the client saw NOTHING for 15s after attaching — measured on
        #   a real turn, twice, at exactly SSE_HEARTBEAT_SECONDS.
        # Root cause: the HTTP response headers are written with the first body
        #   chunk. On a job whose first token is slow (grok-4.6 took 40s+ on the
        #   same turn) the generator produced no bytes until the keep-alive
        #   fired, so the browser could not distinguish a live stream from a
        #   stalled connection, and neither could the UI.
        # Fix: one frame up front. It carries no text and advances no offset,
        #   so replay stays exact; unknown types are ignored by older clients.
        yield _sse({"type": "attached", "offset": from_offset, "status": job.status})

        # Completed reasoning blocks, every one, in order and ahead of the
        # calls they preceded: the next step replays them to Anthropic and a
        # missing one is a 400. Each keeps its position so a reconnecting
        # reader can skip what it already has.
        for index, block in enumerate(thinking_snapshot):
            yield _sse({"type": "thinking_block", "index": index, "block": block})
        # grok's output items (reasoning with its ciphertext), for the same
        # reason: the next step sends them back.
        for index, item in enumerate(response_items_snapshot):
            yield _sse({"type": "response_item", "index": index, "item": item})

        # Tool calls are replayed WHOLE, not by offset: they are not document
        # text, so there is no offset to resume from. A reader that reconnects
        # mid-call would otherwise see the tail of an argument it never saw the
        # start of — or, after a reload, nothing at all.
        for index, call in sorted(tool_calls_snapshot.items()):
            replay_event: Dict[str, Any] = {
                "type": "tool_call",
                "index": index,
                "id": call.get("id"),
                "name": call.get("name"),
                "text": call.get("arguments") or "",
                "replay": True,
            }
            if call.get("signature"):
                replay_event["signature"] = call["signature"]
            yield _sse(replay_event)

        sent_offset = from_offset
        start = max(0, min(from_offset, len(snapshot)))
        if start < len(snapshot):
            # With a truncated buffer the replay text is shorter than the
            # offset it advances to; that gap is exactly what truncatedBuffer
            # warns about, and resuming at snapshot_offset keeps the client
            # aligned with the live deltas that follow.
            yield _sse({"type": "delta", "text": snapshot[start:], "offset": snapshot_offset})
            sent_offset = snapshot_offset

        if terminal is not None:
            yield _sse(terminal)
            # Reached only once the frame was written: a reader that vanished
            # cancels this generator AT the yield, leaving the flag unset.
            job.result_delivered = True
            return

        while True:
            try:
                event = await asyncio.wait_for(queue.get(), timeout=SSE_HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                yield ": keep-alive\n\n"
                continue

            if event["type"] == "delta":
                if event["offset"] <= sent_offset:
                    continue  # already covered by the replay
                yield _sse(event)
                sent_offset = event["offset"]
            elif event["type"] in TERMINAL_EVENT_TYPES:
                yield _sse(event)
                job.result_delivered = True  # same rule as the replay above
                return
            else:
                # Informational (reasoning, tool_call, thinking_block, and
                # anything added later). Passing
                # it through the terminal branch closed the stream on the FIRST
                # reasoning delta — the job kept generating server-side while
                # every client saw "disconnected before completion".
                yield _sse(event)
    finally:
        job.subscribers.discard(queue)


# ══════════════════════════════════════════════════════════════════════════════
# Endpoints (spec §3)
# ══════════════════════════════════════════════════════════════════════════════

@router.post("/api/generate")
async def start_generation(request: Request):
    """Register a job, kick off the provider stream, return immediately."""
    username = get_authenticated_username(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    provider = body.get("provider")
    config = body.get("config") or {}
    messages = body.get("messages") or []
    meta = body.get("meta") or {}

    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported LLM provider: {provider}")
    if not isinstance(config, dict):
        raise HTTPException(status_code=400, detail="config must be an object.")
    if not isinstance(messages, list) or not messages:
        raise HTTPException(status_code=400, detail="messages must be a non-empty array.")
    if not config.get("apiKey") and provider not in ("ollama", "runpod"):
        raise HTTPException(
            status_code=400,
            detail=f"API key is missing for {provider}. Please configure it in Settings.",
        )

    job = registry.create(username, meta if isinstance(meta, dict) else {})
    job.input_chars = sum(len(str(m.get("content") or "")) for m in messages if isinstance(m, dict))
    job.conversation = str(config["conversationId"]) if config.get("conversationId") else None
    job.model = str(config.get("model") or "") or None
    job.task = asyncio.create_task(run_job(job, provider, config, messages))
    logger.info("Started generation job %s (provider=%s)", job.job_id, provider)
    return {"jobId": job.job_id, "createdAt": job.created_at}


@router.post("/api/models")
async def list_provider_models(request: Request):
    """List the models a LOCAL endpoint serves, on the browser's behalf.

    Problem: the model dropdown is populated by a fetch from the page, and the
      dev server is served over HTTPS — so every plain-http local endpoint is
      blocked as mixed content and a locally-served model can never be picked.
      (Measured: 127.0.0.1:8090, 192.168.0.110:8090 and 127.0.0.1:11434 all
      fail from the page with "Failed to fetch"; the same URLs answer fine from
      this process, which is why generation works and discovery does not.)
    Fix: ask the backend, which is same-origin for the page and on the same
      host as the model server.

    Deliberately restricted to loopback: this is for local model servers, and a
    wide-open fetcher would turn this endpoint into an SSRF proxy.
    """
    get_authenticated_username(request)
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON payload.")

    base_url = str((body or {}).get("baseUrl") or "").rstrip("/")
    if not base_url:
        raise HTTPException(status_code=400, detail="baseUrl is required.")

    # Anthropic's API cannot be called from a page (CORS), so the Claude and
    # OpenAI model lists are fetched here too — with the user's key, from the
    # provider's own host only, so this never becomes a proxy for any URL.
    provider = (body or {}).get("provider")
    if provider in OFFICIAL_MODEL_HOSTS:
        host = OFFICIAL_MODEL_HOSTS[provider]
        if urlparse(base_url).hostname != host:
            raise HTTPException(status_code=400, detail=f"Only {host} can be queried for {provider} models.")
        api_key = str(body.get("apiKey") or "")
        headers = ({"x-api-key": api_key, "anthropic-version": "2023-06-01"} if provider == "anthropic"
                   else {"Authorization": f"Bearer {api_key}"})
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(f"{base_url}/models", params={"limit": 1000} if provider == "anthropic" else None, headers=headers)
                response.raise_for_status()
                data = response.json()
        except Exception as exc:  # noqa: BLE001 — a bad key or an outage: the UI keeps its fallback list
            logger.info("%s model listing failed: %s", provider, exc)
            return {"models": []}
        ids = [m["id"] for m in data.get("data") or [] if isinstance(m, dict) and isinstance(m.get("id"), str)]
        if provider == "openai":
            # Text models only, the gpt line newest first, then the o-series: the
            # account also lists audio, image and realtime models.
            text = [i for i in ids if _OPENAI_CHAT_MODEL_RE.match(i) and not _OPENAI_NON_CHAT_RE.search(i)]
            ids = sorted((i for i in text if i.startswith("gpt-")), reverse=True) + sorted((i for i in text if not i.startswith("gpt-")), reverse=True)
        return {"models": ids}

    if not is_queryable_model_host(base_url):
        raise HTTPException(
            status_code=400,
            detail=(
                "Only local endpoints (localhost / 127.0.0.1) or an https "
                "*.proxy.runpod.net endpoint can be queried this way."
            ),
        )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{base_url}/models")
            response.raise_for_status()
            data = response.json()
    except Exception as exc:  # noqa: BLE001 — an unreachable local server is normal
        logger.info("Model listing failed for %s: %s", base_url, exc)
        return {"models": []}

    # "Ollama-compatible" covers two dialects: Ollama's own {models:[{name}]}
    # and OpenAI's {data:[{id}]}. llama.cpp answers with both.
    names: List[str] = []
    if isinstance(data.get("data"), list):
        names = [m.get("id") for m in data["data"] if isinstance(m, dict) and m.get("id")]
    if not names and isinstance(data.get("models"), list):
        names = [
            m.get("name") or m.get("model")
            for m in data["models"]
            if isinstance(m, dict) and (m.get("name") or m.get("model"))
        ]

    # Context window, when the server states it. llama.cpp reports the value it
    # was actually STARTED with (`-c`), which is the only trustworthy source:
    # the client cannot infer it, and it changes whenever the model is
    # relaunched — this endpoint was restarted from 32K to 262144 in one day.
    # Anything that budgets history against "the model's limit" needs this
    # number rather than a table that silently goes stale.
    context_windows: Dict[str, int] = {}
    if isinstance(data.get("data"), list):
        for entry in data["data"]:
            if not isinstance(entry, dict):
                continue
            meta = entry.get("meta")
            n_ctx = meta.get("n_ctx") if isinstance(meta, dict) else None
            if isinstance(n_ctx, int) and n_ctx > 0 and entry.get("id"):
                context_windows[str(entry["id"])] = n_ctx

    return {"models": names, "contextWindows": context_windows}


@router.get("/api/generate/active")
async def list_active_generations(request: Request):
    username = get_authenticated_username(request)
    return [job.summary() for job in registry.list_for_user(username)]


@router.get("/api/generate/{job_id}/stream")
async def stream_generation(
    request: Request,
    job_id: str,
    from_offset: int = Query(0, alias="from", ge=0),
):
    username = get_authenticated_username(request)
    job = registry.get(username, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Generation job not found.")

    return StreamingResponse(
        _job_event_stream(job, from_offset),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable proxy buffering so deltas are not held back.
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/api/generate/{job_id}/abort")
async def abort_generation(request: Request, job_id: str):
    username = get_authenticated_username(request)
    job = registry.get(username, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Generation job not found.")
    job.abort()
    return {"success": True}
