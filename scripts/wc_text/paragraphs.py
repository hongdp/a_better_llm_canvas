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


# ── Paragraphs by position (agentic_chat_loop.md §0.11) ─────────────────────
# Port of the same section of src/utils/paragraphs.ts.

from .jsstr import JS_WS  # noqa: E402

_WS_CLASS = "[" + "".join("\\" + c if c in "\\]^-" else c for c in JS_WS) + "]"
_WS_RUN = re.compile(_WS_CLASS + "+")
_VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
_OPEN_NAME = re.compile(r"^<([a-zA-Z][\w-]*)")
_PLAIN_BLOCK = re.compile(r"^<(p|h[1-6])>(?:[^<]|<br" + _WS_CLASS + r"*/?>)*</\1>$", re.I)
_BLOCK_HTML = re.compile(r"^" + _WS_CLASS + r"*<(?:p|h[1-6]|blockquote|ul|ol|div|hr|figure|img|pre|table)\b", re.I)
_ACTIONS = ["replace", "insert_before", "insert_after", "delete"]


def _tag_end(html: str, start: int) -> int:
    quote = None
    for i in range(start + 1, len(html)):
        ch = html[i]
        if quote:
            if ch == quote:
                quote = None
            continue
        if ch in ('"', "'"):
            quote = ch
        elif ch == ">":
            return i + 1
    return -1


def paragraph_spans(html: str) -> List[Dict]:
    out: List[Dict] = []
    i = 0
    n = len(html)
    while i < n:
        if html[i] != "<":
            nxt = html.find("<", i)
            end = n if nxt == -1 else nxt
            if _js_trim(html[i:end]):
                out.append({"start": i, "end": end, "html": html[i:end], "loose": True})
            i = end
            continue
        if html.startswith("<!--", i):
            close = html.find("-->", i + 4)
            i = n if close == -1 else close + 3
            continue
        m = _OPEN_NAME.match(html[i:i + 40])
        close_at = _tag_end(html, i)
        if not m or close_at == -1:
            i = n if close_at == -1 else close_at
            continue
        name = m.group(1).lower()
        if name in _VOID_TAGS or html[close_at - 2] == "/":
            out.append({"start": i, "end": close_at, "html": html[i:close_at], "loose": False})
            i = close_at
            continue
        pattern = re.compile(r"<(/?)" + re.escape(name) + r"(?=[" + "".join("\\" + c if c in "\\]^-" else c for c in JS_WS) + r"/>])", re.I)
        depth = 1
        end = n
        pos = close_at
        while True:
            mm = pattern.search(html, pos)
            if not mm:
                break
            at = _tag_end(html, mm.start())
            if at == -1:
                break
            if mm.group(1):
                depth -= 1
            elif html[at - 2] != "/":
                depth += 1
            if depth == 0:
                end = at
                break
            pos = at
        out.append({"start": i, "end": end, "html": html[i:end], "loose": False})
        i = end
    return out


def numbered_paragraph_spans(html: str):
    numbered = chapter_paragraphs(html)
    out: List[Dict] = []
    for span in paragraph_spans(html):
        block = f"<p>{_js_trim(span['html'])}</p>" if span["loose"] else span["html"]
        text = _js_trim(re.sub(r"\{\{IMAGE_PLACEHOLDER_[0-9]+\}\}", "", block_text(block)))
        if not text and not _IMAGE_RE.search(block):
            continue
        p = numbered[len(out)] if len(out) < len(numbered) else None
        if p is None or p["text"] != text:
            return None
        out.append({**span, "number": p["number"], "text": text, "kind": p["kind"]})
    return out if len(out) == len(numbered) else None


def is_plain_chapter_html(html: str) -> bool:
    spans = paragraph_spans(html)
    if numbered_paragraph_spans(html) is None:
        return False
    return all(not s["loose"] and _PLAIN_BLOCK.match(_js_trim(s["html"])) for s in spans)


def _squash(s: str) -> str:
    return _js_trim(_WS_RUN.sub(" ", s))


def _anchor_of(s: str) -> str:
    out = re.sub(r"^¶\d+" + _WS_CLASS + "*", "", _squash(s))
    return re.sub(r"^#" + _WS_CLASS + "+", "", out)


def as_blocks(html: str) -> str:
    if _BLOCK_HTML.match(html):
        return _js_trim(html)
    parts = [_js_trim(p) for p in re.split(r"\n" + _WS_CLASS + r"*\n", html)]
    return "".join("<p>" + p.replace("\n", "<br>") + "</p>" for p in parts if p)


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def apply_paragraph_edits(html: str, edits: List[Dict]) -> Dict:
    spans = numbered_paragraph_spans(html)
    if spans is None:
        return {"ok": False, "error": "this chapter's HTML could not be split into paragraphs reliably; use edit_document with SEARCH text from its HTML instead", "stale": []}
    if not edits:
        return {"ok": False, "error": "no edits were given", "stale": []}
    stale: List[Dict] = []
    errors: List[str] = []
    removed = set()
    for e in edits:
        n = e["paragraph"]
        span = spans[n - 1] if _is_int(n) and 1 <= n <= len(spans) else None
        if e["action"] not in _ACTIONS:
            errors.append(f'¶{n}: unknown action "{e["action"]}"')
            continue
        if span is None:
            errors.append(f"¶{n}: the chapter has {len(spans)} paragraphs")
            continue
        if (e["action"] == "replace" or e["action"].startswith("insert")) and not _js_trim(e.get("html") or ""):
            errors.append(f"¶{n}: {e['action']} needs html")
            continue
        anchor = _anchor_of(e.get("startsWith") or "")
        if not anchor:
            errors.append(f"¶{n}: starts_with is empty — give the first words of the paragraph as you read them")
            continue
        if not _squash(span["text"]).startswith(anchor) and not (span["kind"] == "image" and re.match(r"^\[?image\]?$", anchor, re.I)):
            stale.append({"number": span["number"], "text": "[image]" if span["kind"] == "image" else span["text"]})
            continue
        if e["action"] == "replace" and span["kind"] == "image":
            errors.append(f"¶{n} is an image: delete it, or insert next to it")
            continue
        if e["action"] in ("replace", "delete"):
            if n in removed:
                errors.append(f"¶{n} is replaced or deleted twice")
                continue
            removed.add(n)
    if stale or errors:
        lines = errors + [f"¶{s['number']} does not start with what you gave; it now reads: {s['text'][:160] + '…' if len(s['text']) > 160 else s['text']}" for s in stale]
        return {"ok": False, "error": "nothing was applied:\n" + "\n".join(lines), "stale": stale}
    rank = {"insert_after": 0, "replace": 1, "delete": 1, "insert_before": 2}
    splices = []
    for order, e in enumerate(edits):
        span = spans[e["paragraph"] - 1]
        at = span["end"] if e["action"] == "insert_after" else span["start"]
        to = span["end"] if e["action"] in ("replace", "delete") else at
        splices.append({"at": at, "to": to, "text": "" if e["action"] == "delete" else as_blocks(e.get("html") or ""),
                        "paragraph": e["paragraph"], "rank": rank[e["action"]], "order": order})
    splices.sort(key=lambda s: (-s["at"], -s["paragraph"], s["rank"], -s["order"]))
    out = html
    for s in splices:
        out = out[:s["at"]] + s["text"] + out[s["to"]:]
    return {"ok": True, "html": out, "paragraphsBefore": len(spans), "paragraphsAfter": len(chapter_paragraphs(out)),
            "firstChanged": min(e["paragraph"] for e in edits)}
