"""Anthropic Messages: the request with thinking blocks and cache breakpoints, and its event stream."""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from wc_text.reasoning_effort import anthropic_thinking, resolve_reasoning_effort

from . import common
from .common import (ProviderError, _anthropic_tools, _assistant_tool_calls, _check_abort, _debug_log, _http_error, _parsed_arguments,
                     _read_error_text, _split_data_url, _thinking_blocks)

if TYPE_CHECKING:
    from server_generation import GenerationJob

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
            # Verbatim, in the order Anthropic streamed them: reasoning, the
            # text, then any reasoning that came after the text began (Claude
            # 5.x thinks again mid-reply), then tool_use. A block moved ahead
            # of the text is "modified" to the API — a 400 for the next step,
            # seen 2026-10-11 as "messages.25.content.1". Manual extended
            # thinking also needs the replayed turn to BEGIN with a block.
            strip = lambda b: {k: v for k, v in b.items() if k != "afterText"}  # noqa: E731
            blocks: List[Dict[str, Any]] = [strip(b) for b in thinking if not b.get("afterText")]
            if content:
                blocks.append({"type": "text", "text": content})
            blocks.extend(strip(b) for b in thinking if b.get("afterText"))
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

    async with common._http_stream(url, headers, body) as response:
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
            # A block that starts after the reply's text began is replayed after the text (build_anthropic_request).
            after_text = {"afterText": True} if job.length > 0 else {}
            if event_type == "content_block_start" and block.get("type") == "redacted_thinking":
                open_thinking[block_index] = {"type": "redacted_thinking", "data": str(block.get("data") or ""), **after_text}
            elif event_type == "content_block_start" and block.get("type") == "thinking":
                open_thinking[block_index] = {
                    "type": "thinking",
                    "thinking": str(block.get("thinking") or ""),
                    "signature": str(block.get("signature") or ""),
                    **after_text,
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
