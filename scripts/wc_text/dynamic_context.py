"""Port of src/hooks/chat/dynamicContext.ts — the ledger block and the volatile tail."""
from typing import Callable, Dict, List, Optional, Union

from .chapter_index import build_chapter_index
from .diff import strip_diff_markup
from .llm_context import html_to_plain_text, truncate_with_notice
from .pending_changes import pending_changes, render_pending_changes

MAX_REFERENCE_DOC_CHARS = 20_000


def render_ledger_chapter(title: str, content: str, per_doc_chars: int) -> str:
    return f"--- DOCUMENT: {title} ---\n{truncate_with_notice(html_to_plain_text(content), per_doc_chars)}\n"


def ledger_block(doc: Dict, kind: str = "fresh", per_doc_chars: int = MAX_REFERENCE_DOC_CHARS) -> str:
    title = (f"{doc['title']} (UPDATED — this version replaces the earlier copy of this chapter above; disregard that one)"
             if kind == "update" else doc["title"])
    return render_ledger_chapter(title, strip_diff_markup(doc["content"]), per_doc_chars)


def build_ledger_messages(documents: List[Dict], ledger: List[Union[str, Dict]], per_doc_chars: Optional[int] = None,
                          opts: Optional[Dict] = None) -> List[Dict]:
    per_doc_chars = MAX_REFERENCE_DOC_CHARS if per_doc_chars is None else per_doc_chars
    opts = opts or {}
    if not ledger:
        return []
    by_id = {d["id"]: d for d in documents}
    parts = []
    for item in ledger:
        entry = {"id": item} if isinstance(item, str) else item
        if entry.get("text"):
            parts.append(entry["text"])
            continue
        doc = by_id.get(entry["id"])
        parts.append(ledger_block(doc, "fresh", per_doc_chars) if doc else "")
    chapters = "\n".join(p for p in parts if p)
    if not chapters:
        return []
    header = ("REFERENCED CHAPTERS (full text, as plain text, for details and consistency; to change one, read its HTML with read and name it in your write):"
              if opts.get("agentTools") else
              "REFERENCED CHAPTERS (read-only; use them for details and consistency, never edit them):")
    return [
        {"role": "user", "content": f"{header}\n\n{chapters}", "cacheHint": True},
        {"role": "assistant", "content": "Understood. I have read these chapters and will use them as reference."},
    ]


def build_volatile_tail(documents: List[Dict], active_document_id: Optional[str], selected_text: str,
                        preserve_images: Callable[[str], str], opts: Optional[Dict] = None) -> str:
    opts = opts or {}
    chapter_index = build_chapter_index(documents, active_document_id, {"agentTools": opts.get("agentTools"), "markers": opts.get("markers")})
    index_block = f"{chapter_index}\n\n" if chapter_index else ""
    active = next((d for d in documents if d["id"] == active_document_id), None)
    active_content = (active or {}).get("content") or ""
    clean_active = preserve_images(strip_diff_markup(active_content))
    pending = render_pending_changes(pending_changes(active_content))
    pending_block = f"\n\n{pending}" if pending else ""
    if selected_text:
        clean_selected = preserve_images(selected_text)
        return ("I have selected the following text in the document. I want you to focus your action on this specific text.\n"
                f"{index_block}\nCURRENT SELECTED TEXT:\n\"\"\"\n{clean_selected}\n\"\"\"\n\n"
                f"CURRENT ACTIVE DOCUMENT CONTENT (For context):\n\"\"\"\n{clean_active}\n\"\"\"{pending_block}")
    label = ("Your writes change this chapter unless you name another" if opts.get("agentTools")
             else "This is the ONLY document you can update")
    if opts.get("agentTools") and opts.get("activeCopyOlder"):
        label += ". Its copy under REFERENCED CHAPTERS is older: this is its current text"
    return (f"Here is the current state of my document.\n{index_block}\n"
            f"CURRENT ACTIVE DOCUMENT CONTENT ({label}):\n\"\"\"\n{clean_active}\n\"\"\"{pending_block}")
