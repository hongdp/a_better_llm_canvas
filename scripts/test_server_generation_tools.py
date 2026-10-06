"""Tool calling in the backend generation transport (server_generation.py).

Covers the request builders replaying tool history in each provider's native
shape, the Anthropic / Gemini tool-definition translation, and the stream
readers reporting tool calls through `GenerationJob.note_tool_call`.

The HTTP layer is stubbed by patching `server_generation._http_stream` — the
module that OWNS it (see test_api_server.py).
"""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server_generation  # noqa: E402


# Deliberately unusual spacing and non-ASCII: a builder that parses and
# re-dumps this would change the bytes, which is what the tests catch.
ARGS_TEXT = '{"chapter":  "第三章"}'

UPDATE_TOOL = {
    "type": "function",
    "function": {
        "name": "update_document",
        "description": "Replace the document.",
        "parameters": {
            "type": "object",
            "properties": {
                "html": {"type": "string", "description": "New HTML.", "format": "html"},
                "tags": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                },
            },
            "required": ["html"],
            "additionalProperties": False,
        },
    },
}

READ_TOOL = {
    "type": "function",
    "function": {
        "name": "read_chapter",
        "description": "Read a chapter.",
        "parameters": {"type": "object", "properties": {}, "required": []},
    },
}


def _tool_history():
    """system, user, assistant(two calls), two tool results, user."""
    return [
        {"role": "system", "content": "SYSTEM"},
        {"role": "user", "content": "Fix chapter three."},
        {
            "role": "assistant",
            "content": "Reading it first.",
            "toolCalls": [
                {"id": "call_1", "name": "read_chapter", "argumentsText": ARGS_TEXT},
                {"id": "call_2", "name": "read_chapter", "argumentsText": '{"chapter":"第四章"}'},
            ],
        },
        {"role": "tool", "toolCallId": "call_1", "name": "read_chapter", "content": "<p>three</p>"},
        {"role": "tool", "toolCallId": "call_2", "name": "read_chapter", "content": "<p>four</p>"},
        {"role": "user", "content": "Go on.", "cacheHint": True},
    ]


@pytest.fixture(autouse=True)
def _clean_generation_registry():
    server_generation.registry.clear()
    yield
    server_generation.registry.clear()


# ── OpenAI-compatible (grok first) ────────────────────────────────────────────

def test_openai_request_replays_tool_calls_and_results_exactly():
    history = [
        {"role": "system", "content": "SYSTEM"},
        {"role": "user", "content": "Fix chapter three."},
        {
            "role": "assistant",
            "content": "Reading it first.",
            "toolCalls": [{"id": "call_1", "name": "read_chapter", "argumentsText": ARGS_TEXT}],
        },
        {"role": "tool", "toolCallId": "call_1", "name": "read_chapter", "content": "<p>three</p>"},
        {"role": "user", "content": "Go on."},
    ]
    _, _, body = server_generation.build_openai_request(
        {"model": "grok-4", "baseUrl": "https://api.x.ai/v1", "apiKey": "k", "tools": [READ_TOOL]},
        history,
        "grok",
    )

    assert body["messages"] == [
        {"role": "system", "content": "SYSTEM"},
        {"role": "user", "content": "Fix chapter three."},
        {
            "role": "assistant",
            "content": "Reading it first.",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "read_chapter", "arguments": ARGS_TEXT},
            }],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "<p>three</p>"},
        {"role": "user", "content": "Go on."},
    ]
    # Byte-identical: xAI's prompt cache is exact-prefix.
    arguments = body["messages"][2]["tool_calls"][0]["function"]["arguments"]
    assert arguments.encode("utf-8") == ARGS_TEXT.encode("utf-8")
    assert body["tools"] == [READ_TOOL]


def test_openai_request_uses_null_content_for_a_tool_only_reply():
    _, _, body = server_generation.build_openai_request(
        {"model": "gpt", "baseUrl": "https://api.openai.com/v1", "apiKey": "k"},
        [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": "",
                "toolCalls": [{"id": "c", "name": "update_document", "argumentsText": "{}"}],
            },
        ],
    )
    assistant = body["messages"][1]
    assert assistant == {
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": "c", "type": "function", "function": {"name": "update_document", "arguments": "{}"}}],
    }


def test_openai_request_leaves_plain_and_image_messages_unchanged():
    _, _, body = server_generation.build_openai_request(
        {"model": "gpt", "baseUrl": "https://api.openai.com/v1", "apiKey": "k"},
        [
            {"role": "user", "content": "look", "images": ["data:image/png;base64,AAAA"]},
            {"role": "assistant", "content": "ok"},
        ],
    )
    assert body["messages"] == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "look"},
                {"type": "text", "text": "\n[Image 1]:"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
            ],
        },
        {"role": "assistant", "content": "ok"},
    ]


# ── Anthropic ────────────────────────────────────────────────────────────────

def test_anthropic_request_translates_tools_generically_and_skips_malformed():
    _, _, body = server_generation.build_anthropic_request(
        {
            "model": "claude",
            "baseUrl": "https://api.anthropic.com/v1",
            "apiKey": "k",
            "tools": [
                UPDATE_TOOL,
                {"type": "function", "function": {"name": "no_schema"}},
                {"type": "function"},
                "garbage",
                {"type": "function", "function": {"name": "undescribed", "parameters": {"type": "object"}}},
            ],
        },
        [{"role": "user", "content": "hi"}],
    )
    assert body["tools"] == [
        {
            "name": "update_document",
            "description": "Replace the document.",
            "input_schema": UPDATE_TOOL["function"]["parameters"],
        },
        {"name": "undescribed", "description": "", "input_schema": {"type": "object"}},
    ]


def test_anthropic_request_omits_tools_when_none_are_sent():
    _, _, body = server_generation.build_anthropic_request(
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k"},
        [{"role": "user", "content": "hi"}],
    )
    assert "tools" not in body


def test_anthropic_request_replays_tool_use_and_merges_results():
    _, _, body = server_generation.build_anthropic_request(
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k"},
        _tool_history(),
    )
    messages = body["messages"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user", "user"]
    assert messages[1]["content"] == [
        {"type": "text", "text": "Reading it first."},
        {"type": "tool_use", "id": "call_1", "name": "read_chapter", "input": {"chapter": "第三章"}},
        {"type": "tool_use", "id": "call_2", "name": "read_chapter", "input": {"chapter": "第四章"}},
    ]
    # Both results in ONE user message, in order.
    assert messages[2]["content"] == [
        {"type": "tool_result", "tool_use_id": "call_1", "content": "<p>three</p>"},
        {"type": "tool_result", "tool_use_id": "call_2", "content": "<p>four</p>"},
    ]


def test_anthropic_tool_only_reply_has_no_empty_text_block_and_bad_args_become_empty_input():
    _, _, body = server_generation.build_anthropic_request(
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k"},
        [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": "",
                "toolCalls": [
                    {"id": "a", "name": "update_document", "argumentsText": '{"html": "<p>x'},
                    {"id": "b", "name": "update_document", "argumentsText": "[1, 2]"},
                ],
            },
        ],
    )
    assert body["messages"][1]["content"] == [
        {"type": "tool_use", "id": "a", "name": "update_document", "input": {}},
        {"type": "tool_use", "id": "b", "name": "update_document", "input": {}},
    ]


def test_anthropic_cache_hint_after_merged_tool_results_lands_on_its_own_message():
    history = _tool_history() + [
        {"role": "assistant", "content": "Done."},
        {"role": "user", "content": "<document context>"},
    ]
    _, _, body = server_generation.build_anthropic_request(
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k"},
        history,
    )
    messages = body["messages"]
    # The hinted message is non_system[4]; after the merge it is message 3.
    # Indexing anthropic_messages by the source position would mark message 4
    # ("Done.") instead.
    assert messages[3]["content"] == [
        {"type": "text", "text": "Go on.", "cache_control": {"type": "ephemeral"}},
    ]
    assert messages[4]["content"] == "Done."
    assert messages[5]["content"] == "<document context>"
    for earlier in messages[:3]:
        content = earlier["content"]
        blocks = content if isinstance(content, list) else []
        assert not any("cache_control" in block for block in blocks)


def test_anthropic_cache_hint_on_a_merged_tool_result_marks_that_merged_message():
    # Mirrors providerMessages.ts `sourceIndex`: a hint maps to the MESSAGE the
    # source landed in, and the breakpoint goes on that message's last block.
    history = _tool_history()
    history[3]["cacheHint"] = True  # the FIRST of the two merged results
    history[5].pop("cacheHint")
    _, _, body = server_generation.build_anthropic_request(
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k"},
        history,
    )
    results = body["messages"][2]["content"]
    assert "cache_control" not in results[0]
    assert results[1]["cache_control"] == {"type": "ephemeral"}
    assert body["messages"][3]["content"] == "Go on."


def test_anthropic_cache_hints_still_cap_at_three():
    history = [{"role": "system", "content": "S"}]
    for i in range(5):
        history.append({"role": "user", "content": f"u{i}", "cacheHint": True})
        history.append({
            "role": "assistant",
            "content": "",
            "toolCalls": [{"id": f"c{i}", "name": "read_chapter", "argumentsText": "{}"}],
        })
        history.append({"role": "tool", "toolCallId": f"c{i}", "name": "read_chapter", "content": "r"})
    _, _, body = server_generation.build_anthropic_request(
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k"},
        history,
    )
    marked = [
        block
        for message in body["messages"]
        if isinstance(message["content"], list)
        for block in message["content"]
        if "cache_control" in block
    ]
    assert len(marked) == 3


# ── Gemini ───────────────────────────────────────────────────────────────────

def test_gemini_request_cleans_tool_schemas_like_toGeminiTools():
    _, _, body = server_generation.build_gemini_request(
        {
            "model": "gemini-2.5-pro",
            "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
            "apiKey": "k",
            "tools": [UPDATE_TOOL, READ_TOOL, {"type": "function", "function": {"name": "broken"}}],
        },
        [{"role": "user", "content": "hi"}],
    )
    assert body["tools"] == [{
        "functionDeclarations": [
            {
                "name": "update_document",
                "description": "Replace the document.",
                "parameters": {
                    "type": "OBJECT",
                    "properties": {
                        # `format` dropped
                        "html": {"type": "STRING", "description": "New HTML."},
                        # `minLength` dropped, `items` cleaned recursively
                        "tags": {"type": "ARRAY", "items": {"type": "STRING"}},
                    },
                    "required": ["html"],
                    # `additionalProperties` dropped
                },
            },
            {
                "name": "read_chapter",
                "description": "Read a chapter.",
                # Empty properties / required are truthy in JS, so kept.
                "parameters": {"type": "OBJECT", "properties": {}, "required": []},
            },
        ]
    }]


def test_gemini_request_replays_function_calls_and_merges_responses():
    _, _, body = server_generation.build_gemini_request(
        {"model": "gemini-2.5-pro", "baseUrl": "https://g/v1beta", "apiKey": "k"},
        _tool_history(),
    )
    assert body["systemInstruction"] == {"parts": [{"text": "SYSTEM"}]}
    assert body["contents"] == [
        {"role": "user", "parts": [{"text": "Fix chapter three."}]},
        {
            "role": "model",
            "parts": [
                {"text": "Reading it first."},
                {"functionCall": {"name": "read_chapter", "args": {"chapter": "第三章"}}},
                {"functionCall": {"name": "read_chapter", "args": {"chapter": "第四章"}}},
            ],
        },
        {
            "role": "user",
            "parts": [
                {"functionResponse": {"name": "read_chapter", "response": {"content": "<p>three</p>"}}},
                {"functionResponse": {"name": "read_chapter", "response": {"content": "<p>four</p>"}}},
            ],
        },
        {"role": "user", "parts": [{"text": "Go on."}]},
    ]
    assert "tools" not in body


def test_gemini_tool_only_reply_has_no_empty_text_part():
    _, _, body = server_generation.build_gemini_request(
        {"model": "gemini-2.5-pro", "baseUrl": "https://g/v1beta", "apiKey": "k"},
        [
            {"role": "user", "content": "go"},
            {
                "role": "assistant",
                "content": "",
                "toolCalls": [{"id": "x", "name": "update_document", "argumentsText": "not json"}],
            },
            # No `name`: recovered from the call it answers.
            {"role": "tool", "toolCallId": "x", "content": "applied"},
        ],
    )
    assert body["contents"][1] == {
        "role": "model",
        "parts": [{"functionCall": {"name": "update_document", "args": {}}}],
    }
    assert body["contents"][2]["parts"][0]["functionResponse"]["name"] == "update_document"


# ── Stream readers ───────────────────────────────────────────────────────────

class _FakeStreamResponse:
    """Stands in for an httpx streaming response."""

    def __init__(self, lines=None, text_chunks=None):
        self.status_code = 200
        self._lines = lines or []
        self._text_chunks = text_chunks or []

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aiter_text(self):
        for chunk in self._text_chunks:
            yield chunk

    async def aread(self):
        return b""


def _run_job(provider, config, messages, response):
    captured = []

    @asynccontextmanager
    async def fake_stream(url, headers, body):
        captured.append({"url": url, "headers": headers, "body": body})
        yield response

    job = server_generation.GenerationJob("gen-tools", "alice", {})
    with patch.object(server_generation, "_http_stream", fake_stream):
        asyncio.run(server_generation.run_job(job, provider, config, messages))
    return job, captured


def _sse(event):
    return "data: " + json.dumps(event, ensure_ascii=False)


def test_anthropic_stream_reports_tool_use_by_block_index():
    lines = [
        "event: message_start",
        _sse({"type": "message_start", "message": {"usage": {"input_tokens": 10, "output_tokens": 1}}}),
        _sse({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
        _sse({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Updating."}}),
        _sse({"type": "content_block_stop", "index": 0}),
        _sse({
            "type": "content_block_start",
            "index": 1,
            "content_block": {"type": "tool_use", "id": "toolu_1", "name": "update_document", "input": {}},
        }),
        _sse({"type": "content_block_delta", "index": 1,
              "delta": {"type": "input_json_delta", "partial_json": '{"html": "<p>新'}}),
        _sse({"type": "content_block_delta", "index": 1,
              "delta": {"type": "input_json_delta", "partial_json": '</p>"}'}}),
        _sse({"type": "content_block_stop", "index": 1}),
        _sse({"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 20}}),
    ]
    job, captured = _run_job(
        "anthropic",
        {"model": "claude", "baseUrl": "https://api.anthropic.com/v1", "apiKey": "k", "tools": [UPDATE_TOOL]},
        [{"role": "user", "content": "go"}],
        _FakeStreamResponse(lines=lines),
    )

    assert job.status == "done", job.error
    assert job.buffer == "Updating."  # text deltas unaffected
    assert job.tool_calls == {
        1: {"id": "toolu_1", "name": "update_document", "arguments": '{"html": "<p>新</p>"}'},
    }
    assert captured[0]["body"]["tools"][0]["name"] == "update_document"
    assert job.usage == {"promptTokens": 10, "completionTokens": 20, "cachedPromptTokens": 0}


def test_gemini_stream_reports_function_call_like_streamGemini():
    chunk = {
        "candidates": [{
            "content": {"role": "model", "parts": [
                {"text": "Done."},
                {"functionCall": {"name": "update_document", "args": {"html": "<p>新</p>", "n": 2}}},
            ]},
            "finishReason": "STOP",
        }],
        "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 7},
    }
    raw = "[" + json.dumps(chunk, ensure_ascii=False) + "]"
    # Split mid-object to exercise the brace-matching buffer.
    job, _ = _run_job(
        "gemini",
        {"model": "gemini-2.5-pro", "baseUrl": "https://g/v1beta", "apiKey": "k", "tools": [UPDATE_TOOL]},
        [{"role": "user", "content": "go"}],
        _FakeStreamResponse(text_chunks=[raw[:40], raw[40:]]),
    )

    assert job.status == "done", job.error
    assert job.buffer == "Done."
    # index 0, JSON.stringify spelling: compact separators, non-ASCII kept.
    assert job.tool_calls == {
        0: {"id": None, "name": "update_document", "arguments": '{"html":"<p>新</p>","n":2}'},
    }
