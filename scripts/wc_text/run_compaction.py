"""Port of src/agent/runCompaction.ts — keeping a run's prompt inside the model's window."""
from typing import Any, Dict, List

from .context_window import estimate_tokens

ELIDE_ABOVE = 0.85
ELIDE_TO = 0.6


def elided_result_note(trace: str) -> str:
    return f"[This result was elided to keep the conversation within the model's context window: {trace}. Read it again if you need its text.]"


def prompt_tokens(messages: List[Dict[str, Any]]) -> int:
    total = 0
    for m in messages:
        total += estimate_tokens(m.get("content") or "")
        for call in m.get("toolCalls") or []:
            total += estimate_tokens(call.get("argumentsText") or "")
    return total


def plan_elisions(messages: List[Dict[str, Any]], elidable: List[Dict[str, Any]], limit_tokens: int, keep_from: int) -> Dict[str, Any]:
    untouched = {"messages": messages, "elided": [], "remaining": elidable}
    if not (limit_tokens and limit_tokens > 0) or not elidable:
        return untouched
    tokens = prompt_tokens(messages)
    if tokens <= limit_tokens * ELIDE_ABOVE:
        return untouched
    out = list(messages)
    elided: List[str] = []
    remaining: List[Dict[str, Any]] = []
    for entry in elidable:
        index = entry["index"]
        m = out[index] if 0 <= index < len(out) else None
        if tokens <= limit_tokens * ELIDE_TO or index >= keep_from or m is None:
            remaining.append(entry)
            continue
        note = elided_result_note(entry["trace"])
        tokens += estimate_tokens(note) - estimate_tokens(m.get("content") or "")
        out[index] = {**m, "content": note}
        elided.append(entry["trace"])
    if not elided:
        return untouched
    return {"messages": out, "elided": elided, "remaining": remaining}


def elision_trace(elided: List[str]) -> str:
    return f"🧹 elided {len(elided)} earlier result{'' if len(elided) == 1 else 's'} to stay within the context window"
