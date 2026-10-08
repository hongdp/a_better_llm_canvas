"""Port of src/agent/invocations.ts — one step's output as tool invocations."""
import json
from typing import Any, Callable, Dict, List, Optional

from .jsstr import js_trim
from .text import parse_assistant_response, strip_stray_document_markup


def _edits_by_chapter(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for block in blocks:
        key = block.get("chapter") or ""
        edit = {k: v for k, v in block.items() if k != "chapter"}
        groups.setdefault(key, []).append(edit)
    return [({"chapter": chapter, "edits": edits} if chapter else {"edits": edits}) for chapter, edits in groups.items()]


def _markup_invocations(parsed: Dict[str, Any], step: int) -> List[Dict[str, Any]]:
    n = 0
    out: List[Dict[str, Any]] = []

    def make(name: str, args: Dict[str, Any], unclosed: Optional[bool] = None) -> Dict[str, Any]:
        nonlocal n
        inv: Dict[str, Any] = {"id": f"markup_{step}_{n}", "name": name, "args": args, "source": "markup"}
        n += 1
        if unclosed is not None:
            inv["unclosed"] = unclosed
        return inv

    kind = parsed["kind"]
    if kind == "selection":
        out.append(make("replace_selection", {"html": parsed["selectionText"]}))
    if kind == "canvas":
        args: Dict[str, Any] = {"html": parsed["canvasText"]}
        if parsed.get("canvasNewChapter"):
            args["new_chapter"] = parsed["canvasNewChapter"]
        elif parsed.get("canvasChapter"):
            args["chapter"] = parsed["canvasChapter"]
        out.append(make("update_document", args, not parsed["canvasClosed"]))
    if kind in ("selection", "edits"):
        for args in _edits_by_chapter(parsed["editBlocks"]):
            out.append(make("edit_document", args))
    for extra in parsed["extraCanvases"]:
        args = {"html": extra["text"]}
        if extra.get("newChapter"):
            args["new_chapter"] = extra["newChapter"]
        elif extra.get("chapter"):
            args["chapter"] = extra["chapter"]
        out.append(make("update_document", args, not extra["closed"]))
    return out


def collect_step(text: str, native_calls: List[Dict[str, Any]], lookup: Callable[[str], Optional[Dict[str, Any]]], step: int,
                 opts: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """`lookup(name)` returns the tool's {kind, markupForm} or None (the registry's get)."""
    opts = opts or {}
    native: List[Dict[str, Any]] = []
    for i, c in enumerate(native_calls):
        inv: Dict[str, Any] = {"id": c.get("id") or f"call_{step}_{i}", "name": c["name"], "args": c.get("args"),
                               "source": "native", "argumentsText": c.get("argumentsText")}
        if c.get("signature"):
            inv["signature"] = c["signature"]
        native.append(inv)
    unknown = sum(1 for c in native_calls if lookup(c["name"]) is None)

    def tagged_write(inv: Dict[str, Any]) -> bool:
        tool = lookup(inv["name"])
        return bool(tool and tool.get("kind") == "write" and tool.get("markupForm"))

    if not opts.get("markupProtocol") and any(tagged_write(inv) for inv in native):
        stray = strip_stray_document_markup(text)
        return {"invocations": native, "chatText": stray["text"], "strayMarkup": stray["removed"], "unknownCalls": unknown, "markupKind": None}

    parsed = parse_assistant_response(text)
    return {"invocations": [*native, *_markup_invocations(parsed, step)], "chatText": parsed["chatText"],
            "strayMarkup": parsed["strayMarkup"], "unknownCalls": unknown, "markupKind": parsed["kind"]}


def plan_writes(writes: List[Dict[str, Any]]) -> Dict[str, Any]:
    selection = next((w for w in writes if w["name"] == "replace_selection"), None)
    if selection is None:
        return {"run": writes, "dropped": 0}
    run = [selection, *[w for w in writes if w["name"] == "edit_document" or
                         (w["name"] == "update_document" and ((w.get("args") or {}).get("chapter") is not None or (w.get("args") or {}).get("new_chapter") is not None))]]
    return {"run": run, "dropped": len(writes) - len(run)}


def arguments_text_of(inv: Dict[str, Any]) -> str:
    """The replayed argument bytes of a native call: as received, else re-serialized."""
    if inv.get("argumentsText") is not None:
        return inv["argumentsText"]
    return json.dumps(inv.get("args") or {}, ensure_ascii=False, separators=(",", ":"))


__all__ = ["collect_step", "plan_writes", "arguments_text_of", "js_trim"]
