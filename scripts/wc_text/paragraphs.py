"""Port of src/utils/paragraphs.ts — a chapter as numbered paragraphs."""
import re
from typing import Dict, List

from .dom import Element, parse_fragment, serialize
from .llm_context import _js_trim


def _decode_entities(s: str) -> str:
    return (s.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">")
            .replace("&quot;", '"').replace("&#39;", "'").replace("&amp;", "&"))


def block_text(html: str) -> str:
    """blockText: tags dropped, list items and line breaks kept apart."""
    out = re.sub(r"<(?:br|hr)\s*/?>", "\n", html, flags=re.I)
    out = re.sub(r"</li>", "\n", out, flags=re.I)
    out = re.sub(r"<[^>]+>", "", out)
    out = _decode_entities(out)
    out = re.sub(r"[ \t]+\n", "\n", out)
    return _js_trim(out)


def top_level_blocks(html: str) -> List[str]:
    """topLevelBlocks: body children re-serialized; loose text becomes a <p> of its text."""
    blocks: List[str] = []
    for node in parse_fragment(html).children:
        if isinstance(node, Element):
            blocks.append(serialize(node))
        else:
            text = _js_trim(node.data)
            if text:
                blocks.append(f"<p>{text}</p>")
    return blocks


_IMAGE_RE = re.compile(r"<img\b|\{\{IMAGE_PLACEHOLDER_[0-9]+\}\}", re.I)


def chapter_paragraphs(html: str) -> List[Dict]:
    out: List[Dict] = []
    number = 0
    for block in top_level_blocks(html):
        text = _js_trim(re.sub(r"\{\{IMAGE_PLACEHOLDER_[0-9]+\}\}", "", block_text(block)))
        image = bool(_IMAGE_RE.search(block))
        if not text and not image:
            continue
        number += 1
        if re.match(r"<h[1-6]\b", block, re.I):
            kind = "heading"
        elif image and not text:
            kind = "image"
        elif re.match(r"<p\b", block, re.I):
            kind = "paragraph"
        else:
            kind = "other"
        out.append({"number": number, "html": block, "text": text, "kind": kind})
    return out


def chapter_chars(html: str) -> int:
    return sum(len(p["text"]) for p in chapter_paragraphs(html))


def numbered_line(p: Dict) -> str:
    if p["kind"] == "image":
        return f"¶{p['number']} [image]"
    return f"¶{p['number']} {'# ' if p['kind'] == 'heading' else ''}{re.sub(r'\n+', ' / ', p['text'])}"
