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

Tests that stub the network should patch `server_generation._http_stream`
(this module reads its own global) and may clear `server_generation.registry`.
"""

import asyncio
import json
import logging
import re
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse

from server_auth import get_authenticated_username

logger = logging.getLogger("web_canvas.generation")

router = APIRouter()

# ── Retention and limits (spec §4) ────────────────────────────────────────────
FINISHED_JOB_TTL_SECONDS = 10 * 60
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

SUPPORTED_PROVIDERS = ("openai", "ollama", "grok", "gemini", "anthropic")

_DATA_URL_RE = re.compile(r"^data:(image/[a-zA-Z+.-]+);base64,(.+)$")


class ProviderError(Exception):
    """A provider-reported failure that should become the job's error event."""


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
        self.abort_requested = False
        self.task: Optional[asyncio.Task] = None
        #: Prompt size in characters, for reading the latency line in context.
        self.input_chars = 0
        #: Reasoning the model streamed before (or between) visible tokens.
        #: Counted, never buffered — it is not document text and must not move
        #: the replay offsets.
        self.reasoning_chars = 0
        self.first_reasoning_latency: Optional[float] = None
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
        self._publish({"type": "reasoning", "text": text})

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
        logger.info(
            "Job %s %s: %s chars in, first token %s, reasoning %s chars, output %s chars",
            self.job_id,
            status,
            self.input_chars,
            f"{self.first_delta_latency:.2f}s" if self.first_delta_latency is not None else "never",
            self.reasoning_chars,
            self.length,
        )
        self.finished_at = _monotonic()
        self._publish(self.terminal_event())
        return True

    def abort(self) -> bool:
        """Cancel the provider request; the partial buffer stays readable."""
        if self.status != "running":
            return False
        self.abort_requested = True
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
        """Drop finished jobs past the retention window."""
        now = _monotonic()
        for job_id, job in list(self._jobs.items()):
            if job.finished_at is not None and now - job.finished_at > FINISHED_JOB_TTL_SECONDS:
                del self._jobs[job_id]

    def clear(self) -> None:
        self._jobs.clear()

    def _enforce_user_limit(self, username: str) -> None:
        user_jobs = [j for j in self._jobs.values() if j.username == username]
        excess = len(user_jobs) - MAX_JOBS_PER_USER
        if excess <= 0:
            return
        # Oldest finished job goes first; a running job is never evicted, so a
        # user with 20 live generations simply exceeds the cap for a while.
        finished = sorted(
            (j for j in user_jobs if j.finished_at is not None),
            key=lambda j: j.finished_at,
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


def build_openai_request(
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
    provider: str = "openai",
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    """OpenAI-compatible request (openai / ollama / grok)."""
    api_key = config.get("apiKey") or ""
    base_url = config.get("baseUrl") or ""

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
        if images:
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

    # Ollama rejects stream_options, so it is detected the same way the client
    # detects it: the sentinel key or a loopback base URL.
    is_ollama = (
        api_key == "ollama-no-key"
        or "localhost" in base_url
        or "127.0.0.1" in base_url
    )
    if not is_ollama:
        body["stream_options"] = {"include_usage": True}

    return url, headers, body


def build_gemini_request(
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> Tuple[str, Dict[str, str], Dict[str, Any]]:
    system_message = next((m for m in messages if m.get("role") == "system"), None)

    contents: List[Dict[str, Any]] = []
    for message in messages:
        if message.get("role") == "system":
            continue
        parts: List[Dict[str, Any]] = [{"text": message.get("content") or ""}]
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
    if config.get("maxOutputTokens"):
        body["generationConfig"] = {"maxOutputTokens": config["maxOutputTokens"]}

    # Support model names with or without the 'models/' prefix.
    model = config.get("model") or ""
    model_name = model[7:] if model.startswith("models/") else model
    url = (
        f"{config.get('baseUrl') or ''}/models/{model_name}"
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
    for message in non_system:
        images = message.get("images") or []
        content = message.get("content") or ""
        if images:
            parts: List[Dict[str, Any]] = [{"type": "text", "text": content}]
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
        target = anthropic_messages[idx]
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

    url = f"{config.get('baseUrl') or ''}/messages"
    headers = {
        "Content-Type": "application/json",
        "x-api-key": config.get("apiKey") or "",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
    }
    return url, headers, body


# ══════════════════════════════════════════════════════════════════════════════
# Provider streaming
# ══════════════════════════════════════════════════════════════════════════════

@asynccontextmanager
async def _http_stream(url: str, headers: Dict[str, str], body: Dict[str, Any]):
    """Open a streaming POST. The single seam tests patch to stub the network."""
    timeout = httpx.Timeout(HTTP_READ_TIMEOUT, connect=HTTP_CONNECT_TIMEOUT)
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


async def _stream_openai(
    job: GenerationJob,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
    provider: str,
) -> Optional[Dict[str, Any]]:
    url, headers, body = build_openai_request(config, messages, provider)
    _debug_log("OpenAI", url, headers, body, config)

    usage: Optional[Dict[str, Any]] = None
    async with _http_stream(url, headers, body) as response:
        if response.status_code >= 400:
            err = await _read_error_text(response)
            raise ProviderError(f"OpenAI API error ({response.status_code}): {err or 'request failed'}")

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

    async with _http_stream(url, headers, body) as response:
        if response.status_code >= 400:
            err = await _read_error_text(response)
            raise ProviderError(f"Anthropic API error ({response.status_code}): {err or 'request failed'}")

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
            if event_type in ("content_block_delta", "message_delta") and delta.get("text"):
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
            raise ProviderError(f"Gemini API error ({response.status_code}): {err or 'request failed'}")

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


async def run_job(
    job: GenerationJob,
    provider: str,
    config: Dict[str, Any],
    messages: List[Dict[str, Any]],
) -> None:
    """Drive one provider stream to a terminal job state. Never raises."""
    try:
        if provider in ("openai", "ollama", "grok"):
            usage = await _stream_openai(job, config, messages, provider)
        elif provider == "gemini":
            usage = await _stream_gemini(job, config, messages)
        elif provider == "anthropic":
            usage = await _stream_anthropic(job, config, messages)
        else:
            raise ProviderError(f"Unsupported LLM provider: {provider}")
        job.finish("done", usage=usage)
    except (asyncio.CancelledError, _JobAborted):
        # Swallowed deliberately: cancellation here is the abort endpoint's
        # signal (it already flipped the status), and re-raising would only
        # surface as an unretrieved task exception on a job nobody awaits.
        job.finish("aborted")
    except Exception as exc:  # noqa: BLE001 — any provider failure becomes an error event
        message = str(exc) or "Unknown network error"
        logger.warning("Generation job %s failed: %s", job.job_id, message)
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
                return
            else:
                # Informational (reasoning, and anything added later). Passing
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
    if not config.get("apiKey") and provider != "ollama":
        raise HTTPException(
            status_code=400,
            detail=f"API key is missing for {provider}. Please configure it in Settings.",
        )

    job = registry.create(username, meta if isinstance(meta, dict) else {})
    job.input_chars = sum(len(str(m.get("content") or "")) for m in messages if isinstance(m, dict))
    job.task = asyncio.create_task(run_job(job, provider, config, messages))
    logger.info("Started generation job %s (provider=%s)", job.job_id, provider)
    return {"jobId": job.job_id, "createdAt": job.created_at}


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
