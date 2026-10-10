"""Port of src/agent/runCompaction.ts — keeping a run's prompt inside the model's window."""
import math
from typing import Any, Dict, List, Optional

from .context_window import estimate_tokens

ELIDE_ABOVE = 0.85
ELIDE_TO = 0.45


def elided_result_note(trace: str) -> str:
    return f"[This result was elided to keep the conversation within the model's context window: {trace}. Read it again if you need its text.]"


def prompt_tokens(messages: List[Dict[str, Any]]) -> int:
    total = 0
    for m in messages:
        total += estimate_tokens(m.get("content") or "")
        for call in m.get("toolCalls") or []:
            total += estimate_tokens(call.get("argumentsText") or "")
    return total


_RATIO_MIN = 0.25
_RATIO_MAX = 4


def calibrated_prompt_tokens(messages: List[Dict[str, Any]], measured: Optional[Dict[str, int]]) -> Dict[str, float]:
    if not measured or not (measured.get("tokens") or 0) > 0 or measured.get("length", 0) <= 0 or measured["length"] > len(messages):
        return {"tokens": prompt_tokens(messages), "ratio": 1}
    estimated = prompt_tokens(messages[:measured["length"]])
    ratio = min(max(measured["tokens"] / estimated, _RATIO_MIN), _RATIO_MAX) if estimated > 0 else 1
    return {"tokens": measured["tokens"] + prompt_tokens(messages[measured["length"]:]) * ratio, "ratio": ratio}


def plan_elisions(messages: List[Dict[str, Any]], elidable: List[Dict[str, Any]], limit_tokens: int, keep_from: int,
                  measured: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    untouched = {"messages": messages, "elided": [], "remaining": elidable, "resentTokens": 0}
    if not (limit_tokens and limit_tokens > 0) or not elidable:
        return untouched
    calibrated = calibrated_prompt_tokens(messages, measured)
    tokens = calibrated["tokens"]
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
        tokens += (estimate_tokens(note) - estimate_tokens(m.get("content") or "")) * calibrated["ratio"]
        out[index] = {**m, "content": note}
        elided.append(entry["trace"])
    if not elided:
        return untouched
    first = min(e["index"] for e in elidable if 0 <= e["index"] < len(out) and out[e["index"]] is not messages[e["index"]])
    resent = math.floor(prompt_tokens(out[first:]) * calibrated["ratio"] + 0.5)
    return {"messages": out, "elided": elided, "remaining": remaining, "resentTokens": resent}


def elision_trace(elided: List[str], resent_tokens: float = 0) -> str:
    return (f"🧹 elided {len(elided)} earlier result{'' if len(elided) == 1 else 's'} to stay within the context window"
            + (f" (the next step re-reads ≈{str(math.floor(resent_tokens / 1000 + 0.5)) + 'k' if resent_tokens >= 1000 else resent_tokens} tokens uncached)"
               if resent_tokens > 0 else ""))
