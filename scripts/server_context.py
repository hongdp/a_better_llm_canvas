"""Request assembly for a server-side run (backend_authority.md §4.3): the
port of useChatLLM.assembleChatRequest over wc_text, with the conversation's
context state — the append-only ledger and what the model has seen — kept
per book on the server instead of in one browser tab.
"""
import json
import logging
import math
from typing import Any, Awaitable, Callable, Dict, List, Optional

from server_db import get_db
from wc_text.chapter_index import build_chapter_index  # noqa: F401 — re-exported for callers that need the index alone
from wc_text.context_ledger import hash_content, ledger_chapter_ids, order_admissions_by_stability, plan_ledger_turn
from wc_text.context_selection import pinned_context_ids, select_reference_chapters
from wc_text.attachments import render_attachment_index
from wc_text.context_window import cjk_ratio_of, estimate_tokens, history_budget_chars, resolve_context_window_tokens
from wc_text.conversation_summary import build_summary_request, parse_summary_reply, plan_conversation_summary, summary_messages
from wc_text.diff import strip_diff_markup
from wc_text.dynamic_context import build_ledger_messages, build_volatile_tail, ledger_block
from wc_text.freshness import freshness_markers
from wc_text.image_preservation import replace_images_with_placeholders
from wc_text.llm_context import build_attachments_label, html_to_plain_text, strip_chat_display_artifacts, trim_history_for_context, was_turn_interrupted
from wc_text.reminders import interrupted_turn_reminder, wrap_reminder
from wc_text.policy import resolve_run_settings
from wc_text.protocol_choice import resolve_document_protocol
from wc_text.provider_profile import get_cache_profile, target_prompt_tokens
from wc_text.system_prompt import build_chat_system_prompt

MAX_LEDGER_DOC_CHARS = 20_000
REASONING_HISTORY_TURNS = 8
logger = logging.getLogger("web_canvas.context")


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


CHAT_SUMMARY_SCOPE = "chat-summary"


def load_chat_summary(username: str, book_id: str) -> Optional[Dict[str, str]]:
    """The server's copy of the conversation summary for a book (agentic_chat_loop.md §0.9)."""
    conn = get_db()
    try:
        row = conn.execute("SELECT state FROM run_context WHERE username = ? AND book_id = ? AND scope = ?",
                           (username, book_id, CHAT_SUMMARY_SCOPE)).fetchone()
    finally:
        conn.close()
    if not row:
        return None
    try:
        data = json.loads(row["state"])
    except ValueError:
        return None
    if isinstance(data, dict) and isinstance(data.get("upToId"), str) and isinstance(data.get("text"), str) and data["text"].strip():
        return {"upToId": data["upToId"], "text": data["text"]}
    return None


def save_chat_summary(username: str, book_id: str, summary: Dict[str, str], now: str) -> None:
    save_state(username, book_id, CHAT_SUMMARY_SCOPE, summary, now)


def text_seen_in_context(documents: List[Dict[str, Any]], in_context_ids: List[str]) -> Dict[str, str]:
    """Port of useChatLLM's textSeenInContext: the chapters whose whole current text the request carries (§0.11)."""
    out: Dict[str, str] = {}
    for doc_id in in_context_ids:
        doc = next((d for d in documents if d["id"] == doc_id), None)
        if doc is None:
            continue
        accepted = strip_diff_markup(doc["content"])
        if len(html_to_plain_text(accepted)) <= MAX_LEDGER_DOC_CHARS:
            out[doc_id] = hash_content(accepted)
    return out


def agent_history_note(message: Dict[str, Any]) -> str:
    trace = (message.get("agent") or {}).get("trace") if message.get("role") == "assistant" else None
    if not trace:
        return ""
    line = "; ".join(trace)
    return f"\n\n[Tools used in this turn: {line[:400] + '…' if len(line) > 400 else line}]"


async def assemble_request(*, provider: str, config: Dict[str, Any], prompt_text: str, images: Optional[List[str]], history: List[Dict[str, Any]],
                           documents: List[Dict[str, Any]], active_document_id: str, selected_text: str, custom_instructions: Optional[str],
                           context_window_tokens: Optional[int], state: Dict[str, Any], image_registry: List[Dict[str, str]],
                           attachments: Optional[List[Dict[str, Any]]] = None,
                           stored_summary: Optional[Dict[str, str]] = None,
                           summarize: Optional[Callable[[str, str], Awaitable[str]]] = None) -> Dict[str, Any]:
    """The messages of a run's first step, and the context state after it.

    `documents` carry their content (the accepted reading is derived here).
    `state` is mutated: the ledger, the seen record and the continuity lists
    advance as the client's refs did. History past the budget is summarized
    through `summarize(system, user)` (agentic_chat_loop.md §0.9); a new note
    comes back as `chatSummary` for the caller to store.
    """
    settings = resolve_run_settings(provider, config)
    protocol = resolve_document_protocol(provider, config.get("documentProtocol"))
    # Agent tools on: only the chapters the writer pinned ride ahead of the history, and the model
    # reads the rest (pinned_context.md). Tools off: the scorer's prefetch, as before.
    selection = None if settings["agentTools"] else select_reference_chapters({
        "promptText": prompt_text,
        "recentHistory": [m["content"] for m in history if m.get("id") != "welcome"],
        "documents": documents,
        "activeDocumentId": active_document_id,
        "previousAttachedIds": state.get("previousAttachedIds") or [],
        "modelReadIds": state.get("modelReadIds") or [],
        "ledgerIds": [e["id"] for e in state["ledger"]["entries"]],
    })
    if selection is not None:
        state["previousAttachedIds"] = selection["attachedIds"]

    system_prompt = {"role": "system", "content": build_chat_system_prompt({
        "customInstructions": custom_instructions, "agentTools": settings["agentTools"],
        "continueAfterWrites": settings["policy"]["continueAfterWrites"], "protocol": protocol,
    })}

    with_reasoning = {m["id"] for m in [m for m in history if m.get("role") == "assistant" and m.get("reasoningItems")][-REASONING_HISTORY_TURNS:]}
    history_texts = []
    history_ids: List[str] = []
    for m in history:
        if m.get("id") == "welcome":
            continue
        history_ids.append(str(m.get("id") or ""))
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
    summarizable = [{"id": history_ids[i], "role": m["role"], "content": m["content"], **({"images": m["images"]} if m.get("images") else {})}
                    for i, m in enumerate(history_texts)]
    plan = plan_conversation_summary(summarizable, budget, stored_summary)
    chat_summary: Optional[Dict[str, str]] = None
    if plan["needs"] and summarize is not None:
        req = build_summary_request(plan["needs"]["previousSummary"], plan["needs"]["messages"])
        try:
            made = parse_summary_reply(await summarize(req["system"], req["user"]))
        except Exception as exc:  # noqa: BLE001 — a failed summary falls back to the plain cut
            logger.warning("Conversation summary failed; the oldest history is cut instead: %s", exc)
            made = None
        if made and plan["upToId"]:
            chat_summary = {"upToId": plan["upToId"], "text": made}
            plan = {**plan, "summary": made, "needs": None}
        else:
            plan = {"cutIndex": 0, "summary": None, "needs": None, "upToId": None}
    elif plan["needs"]:
        plan = {"cutIndex": 0, "summary": None, "needs": None, "upToId": None}
    summary_prefix = summary_messages(plan["summary"]) if plan["summary"] else []
    history_messages = trim_history_for_context(history_texts[plan["cutIndex"]:] if plan["summary"] else history_texts,
                                                {"maxChars": 10 ** 15 if plan["summary"] else budget})
    if history_messages:
        history_messages[-1]["cacheHint"] = True

    state["turn"] = int(state.get("turn") or 0) + 1
    seen = state.setdefault("seen", {})
    book_order = [d["id"] for d in documents]
    docs_for_plan = []
    for d in documents:
        accepted = strip_diff_markup(d["content"])
        docs_for_plan.append({"id": d["id"], "chars": min(len(accepted), MAX_LEDGER_DOC_CHARS), "hash": hash_content(accepted)})
    # Pins are budgeted on the text the ledger renders, not the HTML (pinned_context.md §2).
    wanted = selection["attachedIds"] if selection is not None else pinned_context_ids(
        [{"id": d["id"], "pinned": bool(d.get("pinned")),
          "chars": min(len(html_to_plain_text(strip_diff_markup(d["content"]))), MAX_LEDGER_DOC_CHARS) if d.get("pinned") else 0} for d in documents],
        active_document_id)
    # A pinned chapter the writer has open keeps its place in the ledger (§2.1).
    active_doc = next((d for d in documents if d["id"] == active_document_id), None)
    keep_ids = [active_doc["id"]] if selection is None and active_doc is not None and active_doc.get("pinned") else []
    desired = order_admissions_by_stability(wanted, [{"id": d["id"], "updatedAt": d.get("updatedAt")} for d in documents],
                                            book_order, active_document_id)
    by_id = {d["id"]: d for d in documents}
    plan = plan_ledger_turn(state["ledger"], desired, docs_for_plan, active_document_id,
                            {"render": lambda doc_id, kind: ledger_block(by_id[doc_id], kind) if doc_id in by_id else "", "keepIds": keep_ids})
    attached_ids = ledger_chapter_ids(plan["ledger"])
    prefix = build_ledger_messages(documents, plan["ledger"]["entries"], None, {"agentTools": settings["agentTools"]})
    state["ledger"] = plan["ledger"]
    state["previousAttachedIds"] = attached_ids
    markers = freshness_markers(documents, active_document_id, attached_ids, seen, state["turn"]) if settings["agentTools"] else None
    # The open pinned chapter's copy above may be older than its text now: say which is current.
    active_copy = next((e for e in reversed(plan["ledger"]["entries"]) if keep_ids and e["id"] == keep_ids[0]), None)
    active_copy_older = bool(active_copy and active_copy["hash"] != next((d["hash"] for d in docs_for_plan if d["id"] == keep_ids[0]), None))
    tail_opts: Dict[str, Any] = {"agentTools": True, "markers": markers} if settings["agentTools"] else {}
    if active_copy_older:
        tail_opts["activeCopyOlder"] = True
    tail = build_volatile_tail(documents, active_document_id, selected_text,
                               lambda html: replace_images_with_placeholders(html, image_registry), tail_opts)
    # Agent turns carry no label: the pins in the sidebar are what rides along.
    attachments_text = "" if selection is None else build_attachments_label(attached_ids, documents, selection["autoIds"])
    # The turn after a Stop says so (agentic_chat_loop.md §0.8).
    interrupted = f"\n\n{wrap_reminder(interrupted_turn_reminder())}" if was_turn_interrupted(history) else ""
    # The book's reference files, by reference (attachments_and_web.md §1).
    index = render_attachment_index(attachments or []) if settings["agentTools"] else ""
    files = f"\n\n{index}" if index else ""
    final_user: Dict[str, Any] = {"role": "user", "content": f"{tail}{files}\n\nUSER REQUEST:\n{prompt_text}{interrupted}"}
    if images:
        final_user["images"] = images
    api_messages = [system_prompt, *prefix, *summary_prefix, *history_messages, final_user]
    return {
        "apiMessages": api_messages, "attachmentsText": attachments_text,
        "inContextIds": [*attached_ids, active_document_id], "protocol": protocol, "settings": settings,
        "chatSummary": chat_summary,
    }
