"""Port of src/utils/chapterIndex.ts."""
import re
from typing import Dict, List, Optional

from .llm_context import _js_trim, html_to_plain_text

INDEX_DIGEST_MAX_CHARS = 400
LARGE_BOOK_CHAPTER_THRESHOLD = 40
LARGE_BOOK_DIGEST_MAX_CHARS = 150
FALLBACK_DIGEST_CHARS = 300


def get_chapter_digest(doc: Dict, max_chars: int = INDEX_DIGEST_MAX_CHARS) -> str:
    summary = doc.get("summary")
    source = summary if summary and _js_trim(summary) else html_to_plain_text(doc.get("content", ""))[:FALLBACK_DIGEST_CHARS]
    flattened = _js_trim(re.sub(r"\s*\n\s*", " ", source))
    if len(flattened) <= max_chars:
        return flattened
    return f"{flattened[:max_chars]}…"


def build_chapter_index(documents: List[Dict], active_document_id: Optional[str], options: Optional[Dict] = None) -> str:
    options = options or {}
    if len(documents) < 2:
        return ""
    digest_max = LARGE_BOOK_DIGEST_MAX_CHARS if len(documents) > LARGE_BOOK_CHAPTER_THRESHOLD else INDEX_DIGEST_MAX_CHARS
    markers = options.get("markers") or {}
    agent_tools = bool(options.get("agentTools"))
    lines = []
    for idx, doc in enumerate(documents):
        active = doc["id"] == active_document_id
        if active:
            marker = (" [ACTIVE — open in the editor; writes go here unless you name another chapter]" if agent_tools
                      else " [ACTIVE — this is the document you can edit]")
        else:
            marker = ""
        freshness = f" [{markers[doc['id']]}]" if markers.get(doc["id"]) else ""
        digest = ""
        if not active:
            text = get_chapter_digest(doc, digest_max)
            digest = f" — {text}" if text else (" — (not summarized yet)" if agent_tools else " — ")
        lines.append(f'{idx + 1}. "{doc["title"]}"{marker}{freshness}{digest}')
    return ("CHAPTER INDEX (all chapters in this book; full text NOT included unless it appears in REFERENCED DOCUMENT CONTEXTS or is the active document):\n"
            + "\n".join(lines))


#: Tokens of chapter text per analyze_book batch, under each provider's window and price line (ANALYZE_BATCH_TOKENS).
ANALYZE_BATCH_TOKENS = {"gemini": 140_000, "anthropic": 120_000, "openai": 80_000, "grok": 140_000, "ollama": 20_000}


def analyze_batch_chars(provider: str, cjk_ratio: float) -> int:
    """Port of analyzeBatchChars."""
    from .context_window import tokens_to_chars
    return tokens_to_chars(ANALYZE_BATCH_TOKENS.get(provider, 80_000), cjk_ratio)


def pack_chapters_into_batches(docs: List[Dict], max_chars_per_batch: int) -> List[List[Dict]]:
    batches: List[List[Dict]] = []
    current: List[Dict] = []
    current_chars = 0
    for doc in docs:
        cost = len(doc["content"])
        if current and current_chars + cost > max_chars_per_batch:
            batches.append(current); current = []; current_chars = 0
        current.append(doc); current_chars += cost
    if current:
        batches.append(current)
    return batches
