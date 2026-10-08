"""Request assembly for a server-side run (backend_authority.md §4.3): the
port of useChatLLM.assembleChatRequest over wc_text, with the conversation's
context state — the append-only ledger and what the model has seen — kept
per book on the server instead of in one browser tab.
"""
import json
import math
from typing import Any, Dict, List, Optional

from server_db import get_db
from wc_text.chapter_index import build_chapter_index  # noqa: F401 — re-exported for callers that need the index alone
from wc_text.context_ledger import hash_content, ledger_chapter_ids, order_admissions_by_stability, plan_ledger_turn
from wc_text.context_selection import select_reference_chapters
from wc_text.context_window import cjk_ratio_of, estimate_tokens, history_budget_chars, resolve_context_window_tokens
from wc_text.diff import strip_diff_markup
from wc_text.dynamic_context import build_ledger_messages, build_volatile_tail, ledger_block
from wc_text.freshness import freshness_markers
from wc_text.image_preservation import replace_images_with_placeholders
from wc_text.llm_context import build_attachments_label, strip_chat_display_artifacts, trim_history_for_context
from wc_text.policy import resolve_run_settings
from wc_text.protocol_choice import resolve_document_protocol
from wc_text.provider_profile import get_cache_profile, target_prompt_tokens
from wc_text.system_prompt import build_chat_system_prompt

MAX_LEDGER_DOC_CHARS = 20_000
REASONING_HISTORY_TURNS = 8


def empty_state() -> Dict[str, Any]:
    return {"ledger": {"entries": []}, "seen": {}, "previousAttachedIds": [], "modelReadIds": [], "turn": 0}


def ensure_tables() -> None:
    conn = get_db()
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS run_context (
            username TEXT NOT NULL, book_id TEXT NOT NULL, scope TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
            PRIMARY KEY (username, book_id, scope))""")
        conn.commit()
    finally:
        conn.close()


def load_state(username: str, book_id: str, scope: str) -> Dict[str, Any]:
    conn = get_db()
    try:
        row = conn.execute("SELECT state FROM run_context WHERE username = ? AND book_id = ? AND scope = ?",
                           (username, book_id, scope)).fetchone()
    finally:
        conn.close()
    if not row:
        return empty_state()
    try:
        state = json.loads(row["state"])
    except ValueError:
        return empty_state()
    return {**empty_state(), **state} if isinstance(state, dict) else empty_state()


def save_state(username: str, book_id: str, scope: str, state: Dict[str, Any], now: str) -> None:
    conn = get_db()
    try:
        conn.execute("""INSERT INTO run_context (username, book_id, scope, state, updated_at) VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(username, book_id, scope) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at""",
                     (username, book_id, scope, json.dumps(state, ensure_ascii=False), now))
        conn.commit()
    finally:
        conn.close()


def agent_history_note(message: Dict[str, Any]) -> str:
    trace = (message.get("agent") or {}).get("trace") if message.get("role") == "assistant" else None
    if not trace:
        return ""
    line = "; ".join(trace)
    return f"\n\n[Tools used in this turn: {line[:400] + '…' if len(line) > 400 else line}]"


def assemble_request(*, provider: str, config: Dict[str, Any], prompt_text: str, images: Optional[List[str]], history: List[Dict[str, Any]],
                     documents: List[Dict[str, Any]], active_document_id: str, selected_text: str, custom_instructions: Optional[str],
                     context_window_tokens: Optional[int], state: Dict[str, Any], image_registry: List[Dict[str, str]]) -> Dict[str, Any]:
    """The messages of a run's first step, and the context state after it.

    `documents` carry their content (the accepted reading is derived here).
    `state` is mutated: the ledger, the seen record and the continuity lists
    advance as the client's refs did.
    """
    settings = resolve_run_settings(provider, config)
    protocol = resolve_document_protocol(provider, config.get("documentProtocol"))
    selection = select_reference_chapters({
        "promptText": prompt_text,
        "recentHistory": [m["content"] for m in history if m.get("id") != "welcome"],
        "documents": documents,
        "activeDocumentId": active_document_id,
        "previousAttachedIds": state.get("previousAttachedIds") or [],
        "modelReadIds": state.get("modelReadIds") or [],
        "ledgerIds": [e["id"] for e in state["ledger"]["entries"]],
    })
    state["previousAttachedIds"] = selection["attachedIds"]

    system_prompt = {"role": "system", "content": build_chat_system_prompt({
        "customInstructions": custom_instructions, "agentTools": settings["agentTools"],
        "continueAfterWrites": settings["policy"]["continueAfterWrites"], "protocol": protocol,
    })}

    with_reasoning = {m["id"] for m in [m for m in history if m.get("role") == "assistant" and m.get("reasoningItems")][-REASONING_HISTORY_TURNS:]}
    history_texts = []
    for m in history:
        if m.get("id") == "welcome":
            continue
        entry: Dict[str, Any] = {"role": m["role"], "content": strip_chat_display_artifacts(m.get("content") or "") + agent_history_note(m)}
        if m.get("images"):
            entry["images"] = m["images"]
        if provider == "grok" and m.get("id") in with_reasoning:
            entry["responseItems"] = m["reasoningItems"]
        history_texts.append(entry)
    active_content = next((d["content"] for d in documents if d["id"] == active_document_id), "")
    profile = get_cache_profile(provider)
    budget = history_budget_chars({
        "contextTokens": target_prompt_tokens(profile, resolve_context_window_tokens(provider, config.get("model") or "", context_window_tokens)),
        "maxOutputTokens": config.get("maxOutputTokens") or 16_384,
        "fixedTokens": estimate_tokens(system_prompt["content"]) + estimate_tokens(active_content)
        + sum(math.ceil(e["chars"] * 0.9) for e in state["ledger"]["entries"]),
        "cjkRatio": cjk_ratio_of("".join(m["content"] for m in history_texts) or active_content),
    })
    history_messages = trim_history_for_context(history_texts, {"maxChars": budget})
    if history_messages:
        history_messages[-1]["cacheHint"] = True

    state["turn"] = int(state.get("turn") or 0) + 1
    seen = state.setdefault("seen", {})
    book_order = [d["id"] for d in documents]
    desired = order_admissions_by_stability(selection["attachedIds"], [{"id": d["id"], "updatedAt": d.get("updatedAt")} for d in documents],
                                            book_order, active_document_id)
    docs_for_plan = []
    for d in documents:
        accepted = strip_diff_markup(d["content"])
        docs_for_plan.append({"id": d["id"], "chars": min(len(accepted), MAX_LEDGER_DOC_CHARS), "hash": hash_content(accepted)})
    by_id = {d["id"]: d for d in documents}
    plan = plan_ledger_turn(state["ledger"], desired, docs_for_plan, active_document_id,
                            {"render": lambda doc_id, kind: ledger_block(by_id[doc_id], kind) if doc_id in by_id else ""})
    attached_ids = ledger_chapter_ids(plan["ledger"])
    prefix = build_ledger_messages(documents, plan["ledger"]["entries"], None, {"agentTools": settings["agentTools"]})
    state["ledger"] = plan["ledger"]
    state["previousAttachedIds"] = attached_ids
    markers = freshness_markers(documents, active_document_id, attached_ids, seen, state["turn"]) if settings["agentTools"] else None
    tail = build_volatile_tail(documents, active_document_id, selected_text,
                               lambda html: replace_images_with_placeholders(html, image_registry),
                               {"agentTools": True, "markers": markers} if settings["agentTools"] else {})
    attachments_text = build_attachments_label(attached_ids, documents, selection["autoIds"])
    final_user: Dict[str, Any] = {"role": "user", "content": f"{tail}\n\nUSER REQUEST:\n{prompt_text}"}
    if images:
        final_user["images"] = images
    api_messages = [system_prompt, *prefix, *history_messages, final_user]
    return {
        "apiMessages": api_messages, "attachmentsText": attachments_text,
        "inContextIds": [*attached_ids, active_document_id], "protocol": protocol, "settings": settings,
    }
