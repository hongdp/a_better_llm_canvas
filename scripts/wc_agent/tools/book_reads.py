"""Port of src/agent/tools/bookReads.ts — read_chapter, grep, list_chapters,
open_chapter, delete_chapter."""
import re
from typing import Any, Dict, List, Optional, Union

from wc_text.attachments import (ATTACHMENT_RUN_READ_CAP, attachment_budget_note, find_attachment_range, render_attachment_part,
                                 resolve_attachment_ref)
from wc_text.chapters import cite_chapter, resolve_chapter
from wc_text.context_ledger import hash_content
from wc_text.diff import strip_diff_markup
from wc_text.jsstr import js_trim
from wc_text.llm_context import html_to_plain_text
from wc_text.paragraphs import chapter_paragraphs, numbered_line
from wc_text.pending_changes import pending_changes, render_pending_changes
from wc_text.text import is_blank_content

from ..registry import Tool
from ..types import ToolContext, chapter_outline, result
from .document_writes import forget_chapter, rename_chapter_tool, user_edited

READ_CHAPTER_CAP = 20_000
READ_CALL_CAP = 60_000
SNIPPET_RADIUS = 60
DEFAULT_SEARCH_RESULTS = 20
MAX_SEARCH_RESULTS = 50
RECENT_STEPS = 1
DEFAULT_CONTEXT = SNIPPET_RADIUS
MAX_CONTEXT = 300


def _full_write(ctx: ToolContext, number: int) -> str:
    return f'<canvas chapter="{number}">…</canvas>' if ctx.run.write_protocol == "markup" else f'update_document with chapter="{number}"'


def _fail(name: str, message: str) -> Dict[str, Any]:
    return result(False, message, f"{name}: {message.splitlines()[0] if message else ''}", retryable=True)


def accepted_html(ctx: ToolContext, doc_id: str) -> str:
    working = ctx.run.docs.get(doc_id)
    if working:
        return working.html
    return strip_diff_markup(next((c["content"] for c in ctx.document.chapters() if c["id"] == doc_id), ""))


_ATTACHMENT_REF = re.compile(r"^\s*(?:A|附件)\s*\d+\s*$", re.I)


def resolve_ref(ref: Any, chapters: List[Dict[str, Any]], attachments: List[Dict[str, Any]]) -> Dict[str, Any]:
    """A chapter or an attachment (docs/features/attachments_and_web.md §1): "A1" is an attachment,
    anything else a chapter first and an attachment's name second. {"chapter"}, {"attachment"} or {"error"}."""
    if attachments and _ATTACHMENT_REF.match(str(ref)):
        att = resolve_attachment_ref(ref, attachments)
        if att is not None:
            return {"attachment": att}
    r = resolve_chapter(ref, chapters)
    if not isinstance(r, str):
        return {"chapter": r}
    att = resolve_attachment_ref(ref, attachments) if attachments else None
    return {"attachment": att} if att is not None else {"error": r}


def attachment_list(ctx: ToolContext) -> List[Dict[str, Any]]:
    return ctx.attachments.list() if ctx.attachments is not None else []


def _chapter_refs(raw: Dict[str, Any]) -> List[Any]:
    if isinstance(raw.get("chapters"), list):
        return raw["chapters"]
    if raw.get("chapters") is not None:
        return [raw["chapters"]]
    if raw.get("chapter") is not None:
        return [raw["chapter"]]
    return []


# ── read_chapter ─────────────────────────────────────────────────────────────

def _parse_range(raw: Any) -> Union[Dict[str, Any], None, str]:
    import json
    if raw is None or raw == "":
        return None
    if isinstance(raw, list) and 1 <= len(raw) <= 2 and all(_is_intlike(n) for n in raw):
        a = int(raw[0])
        b = int(raw[1]) if len(raw) == 2 else None
        if a >= 1 and (b is None or b >= a):
            return {"from": a, "to": b if b is not None else a}
        return f"paragraph range {json.dumps(raw, ensure_ascii=False)} is not valid"
    value = re.sub(r'^["\'“”「」]+|["\'“”「」]+$', "", js_trim(str(raw)))
    head = re.match(r"^\s*(?:-|–|~)\s*¶?(\d+)\s*$", value)
    if head:
        to = int(head.group(1))
        return {"from": 1, "to": to} if to >= 1 else f"paragraph range {json.dumps(raw, ensure_ascii=False)} is not valid"
    m = re.match(r"^\s*¶?(\d+)\s*(?:(-|–|~)\s*¶?(\d+)?)?\s*$", value)
    if not m:
        return f'paragraphs must look like "40-60", "45", "81-" or "-15", not {json.dumps(raw, ensure_ascii=False)}'
    start = int(m.group(1))
    to: Optional[int] = int(m.group(3)) if m.group(3) is not None else (None if m.group(2) else start)
    if start < 1 or (to is not None and to < start):
        return f"paragraph range {json.dumps(raw, ensure_ascii=False)} is not valid"
    return {"from": start, "to": to}


def _is_intlike(n: Any) -> bool:
    if isinstance(n, bool):
        return False
    if isinstance(n, (int, float)):
        return float(n).is_integer()
    if isinstance(n, str):
        return bool(re.fullmatch(r"\s*-?\d+\s*", n))
    return False


MAX_READ_PARTS = 12


def _read_parse(raw: Optional[Dict[str, Any]]) -> Union[Dict[str, Any], str]:
    if raw is None:
        return "its arguments could not be parsed"
    fmt = "html" if raw.get("format") == "html" else "text"
    parts = raw.get("parts")
    if isinstance(parts, list) and parts:
        if len(parts) > MAX_READ_PARTS:
            return f"at most {MAX_READ_PARTS} parts in one call ({len(parts)} were given)"
        items = []
        for i, part in enumerate(parts):
            p = part if isinstance(part, dict) else None
            if p is not None:
                ref = p.get("chapter")
                if ref is None:
                    chs = p.get("chapters")
                    ref = chs[0] if isinstance(chs, list) and chs else chs
            else:
                ref = part
            if ref is None or ref == "":
                return f"part {i + 1} names no chapter"
            rng = _parse_range(p.get("paragraphs") if p else None)
            if isinstance(rng, str):
                return f"part {i + 1}: {rng}"
            section = p.get("section") if p and isinstance(p.get("section"), str) and js_trim(p["section"]) else None
            items.append({"ref": ref, "range": rng, "section": section})
        return {"items": items, "format": fmt}
    refs = _chapter_refs(raw)
    if not refs:
        return 'no chapter was named (pass "chapters": [numbers from the CHAPTER INDEX], or "parts")'
    rng = _parse_range(raw.get("paragraphs"))
    if isinstance(rng, str):
        return rng
    section = raw.get("section") if isinstance(raw.get("section"), str) and js_trim(raw["section"]) else None
    return {"items": [{"ref": ref, "range": rng, "section": section} for ref in refs], "format": fmt}


async def _read_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    items, fmt = args["items"], args["format"]
    chapters = ctx.document.chapters()
    attachments = attachment_list(ctx)
    resolved: List[Dict[str, Any]] = []
    errors: List[str] = []
    for item in items:
        r = resolve_ref(item["ref"], chapters, attachments)
        if "error" in r:
            errors.append(r["error"])
            continue
        key = ("a", r["attachment"]["id"]) if "attachment" in r else ("c", r["chapter"]["id"])
        if item.get("section") and "attachment" not in r:
            errors.append(f'section="{item["section"]}" names a part of an attachment; for a chapter, pass paragraphs instead.')
            continue
        if not any(x["key"] == key and x["range"] == item["range"] and x.get("section") == item.get("section") for x in resolved):
            resolved.append({**r, "key": key, "range": item["range"], "section": item.get("section")})
    if not resolved:
        return _fail("read_chapter", "\n".join(errors))

    await ctx.document.ensure_loaded(list(dict.fromkeys(x["chapter"]["id"] for x in resolved if "chapter" in x)))

    parts: List[str] = []
    traces: List[str] = []
    budget = READ_CALL_CAP
    skipped: List[str] = []
    for entry in resolved:
        rng = entry["range"]
        if "attachment" in entry:
            # A reference file: text only, never written (attachments_and_web.md §1).
            att = entry["attachment"]
            paras = await ctx.attachments.paragraphs(att["id"])
            if entry.get("section"):
                # A section by its heading: "第三十章" and "第30章" are the same chapter.
                sec = find_attachment_range(att["sections"], entry["section"])
                if sec is None:
                    sample = ", ".join(f'"{s["title"]}"' for s in att["sections"][:6])
                    errors.append(f'{att["ref"]} "{att["name"]}" has no section matching "{entry["section"]}".'
                                  + (f" Its sections begin {sample}…; grep chapters=[\"{att['ref']}\"] for a heading." if sample else " It has no section headings; grep it instead."))
                    continue
                rng = {"from": sec["from"], "to": sec["to"]}
            start = rng["from"] if rng else 1
            if start > len(paras):
                errors.append(f'{att["ref"]} "{att["name"]}" has {len(paras)} paragraphs; there is no ¶{start}.')
                continue
            # Never the whole file: the turn's reads of attachments are capped (§1, user requirement).
            left = ATTACHMENT_RUN_READ_CAP - ctx.run.attachment_chars
            if left <= 0:
                errors.append(attachment_budget_note(att["ref"], ctx.run.attachment_chars))
                continue
            if budget <= 0:
                skipped.append(f'{att["ref"]}{f" ¶{start}" if rng else ""}')
                continue
            out = render_attachment_part(att, paras, start, rng["to"] if rng else None, min(READ_CHAPTER_CAP, budget, left))
            if out["last"] < start:
                # Not even its first paragraph fits in what the turn has left.
                errors.append(attachment_budget_note(att["ref"], ctx.run.attachment_chars))
                continue
            budget -= out["used"]
            ctx.run.attachment_chars += out["used"]
            parts.append(out["content"])
            traces.append(f'{att["ref"]} "{att["name"]}" ¶{start}–{out["last"]} ({out["used"] / 1000:.1f}k, attachment)')
            continue
        chapter = entry["chapter"]
        if user_edited(ctx, chapter["id"]):
            forget_chapter(ctx, chapter["id"])
        html = accepted_html(ctx, chapter["id"])
        paras = chapter_paragraphs(html)
        total_chars = sum(len(p["text"]) for p in paras)

        if fmt == "text" and not rng and chapter["id"] in ctx.run.in_context and chapter["id"] not in ctx.run.docs and ctx.run.step <= RECENT_STEPS:
            parts.append(f"=== {cite_chapter(chapter)} is already in your context in full (it is the active chapter or in REFERENCED CHAPTERS). ===")
            traces.append(f"{cite_chapter(chapter)} (already in context)")
            continue
        start = rng["from"] if rng else 1
        to = min(rng["to"] if rng and rng["to"] is not None else len(paras), len(paras))
        if start > len(paras):
            errors.append(f"{cite_chapter(chapter)} has {len(paras)} paragraphs; there is no ¶{start}.")
            continue
        key = f"{chapter['id']}|{fmt}|{start}-{to}|{hash_content(html)}"
        earlier = ctx.run.reads.get(key)
        if earlier is not None and ctx.run.step - earlier <= RECENT_STEPS:
            parts.append(f"=== {cite_chapter(chapter)} ¶{start}–¶{to} was already returned in step {earlier + 1} of this turn and has not changed since. ===")
            traces.append(f"{cite_chapter(chapter)} (repeat)")
            continue
        if budget <= 0:
            skipped.append(f"{cite_chapter(chapter)}{f' ¶{start}–{to}' if rng else ''}")
            continue

        cap = min(READ_CHAPTER_CAP, budget)
        lines: List[str] = []
        used = 0
        last = start - 1
        for p in paras[start - 1:to]:
            line = ctx.images.preserve(p["html"]) if fmt == "html" else numbered_line(p)
            if lines and used + len(line) > cap:
                break
            lines.append(line)
            used += len(line)
            last = p["number"]
        budget -= used
        whole = start == 1 and last == len(paras)
        part_chars = sum(len(p["text"]) for p in paras[start - 1:last])
        span = "" if whole else f", ¶{start}–¶{last} of {len(paras)} ({part_chars} characters)"
        range_to = rng["to"] if rng and rng["to"] is not None else ""
        more = (f'\n[Stopped at ¶{last} to stay under {cap} characters. Continue with chapters=[{chapter["number"]}], paragraphs="{last + 1}-{range_to}", format="{fmt}".]'
                if last < to else "")
        stored = next((c["content"] for c in ctx.document.chapters() if c["id"] == chapter["id"]), "")
        pending = render_pending_changes(pending_changes(stored))
        parts.append(f"=== {cite_chapter(chapter)} — {len(paras)} paragraphs, {total_chars} characters{span}, {fmt} ===\n" + "\n".join(lines) + more + (f"\n\n{pending}" if pending else ""))
        traces.append(f"{cite_chapter(chapter)}{'' if whole else f' ¶{start}–{last}'} ({used / 1000:.1f}k, {fmt})")

        ctx.run.reads[key] = ctx.run.step
        ctx.run.read_ids[chapter["id"]] = None
        if whole:
            # The whole current text, seen: enough to rewrite a plain chapter (§0.11).
            ctx.run.text_seen[chapter["id"]] = hash_content(html)
        if fmt == "html":
            ctx.run.html_shown.add(chapter["id"])
            ctx.run.known.setdefault(chapter["id"], stored)
    if skipped:
        parts.append(f"[Not returned — this call reached its {READ_CALL_CAP}-character limit: {', '.join(skipped)}. Ask for them in another call.]")
    if errors:
        parts.append("\n".join(errors))
    return result(not errors, "\n\n".join(parts), f"📖 read {', '.join(traces)}", retryable=bool(errors) and not traces)


read_chapter_tool = Tool(
    name="read_chapter",
    description=(
        "Read one or more chapters. Find them in the CHAPTER INDEX and pass their numbers. "
        'Format "text" (default) returns numbered paragraphs ("¶12 …"), for reading content and consistency; '
        '"html" returns the chapter\'s HTML without numbers, for SEARCH edits — not needed for edit_paragraphs, nor to rewrite a chapter of plain paragraphs whose whole text you have seen. '
        'Pass paragraphs (e.g. "40-60", or "81-" for the rest) to read only part of a chapter — after grep found a ¶ number, read around it instead of the whole chapter. '
        f'To look at several places at once, pass parts (up to {MAX_READ_PARTS}), e.g. [{{"chapter":"3","paragraphs":"10-16"}},{{"chapter":"8","paragraphs":"30-36"}}]: one call, one step. '
        f"A long chapter comes back in parts of at most {READ_CHAPTER_CAP} characters, ending at a whole paragraph, with the range to continue from. "
        "If no title or summary tells you where something is, use grep. "
        'Attachments (A1, A2… in ATTACHMENTS) are read the same way: chapters=["A1"] with a paragraph range (¶ numbers, which grep reports; in a novel .txt a ¶ is a line), or with section (a heading such as "第三十章" — 第30章 is the same chapter — or a run, "第62–87章"). '
        "A turn reads at most 100,000 characters of attachments: find passages with grep and read those paragraphs, or let analyze_book read a part (section or paragraphs) and return notes."),
    parameters={"type": "object", "properties": {
        "chapters": {"type": "array", "description": "Chapter numbers from the CHAPTER INDEX (or exact titles), or attachment references (A1).", "items": {"type": "string"}},
        "format": {"type": "string", "description": '"text" (default, numbered paragraphs) or "html" (for SEARCH edits).'},
        "paragraphs": {"type": "string", "description": 'Optional paragraph range, e.g. "40-60", "45", "81-" (to the end) or "-15" (the first 15). Default: the whole chapter.'},
        "section": {"type": "string", "description": 'Attachments only: a section by its heading, e.g. "第三十章" (第30章 is the same chapter), or a run, "第62–87章".'},
        "parts": {"type": "array", "description": "Instead of chapters/paragraphs: several places to read in one call, each a chapter and an optional paragraph range.",
                  "items": {"type": "object", "properties": {
                      "chapter": {"type": "string", "description": "A chapter number from the CHAPTER INDEX (or its exact title)."},
                      "paragraphs": {"type": "string", "description": "Optional range, as in paragraphs above."},
                      "section": {"type": "string", "description": "Attachments only: a section by its heading."}}, "required": ["chapter"]}},
    }},
    kind="read", parse=_read_parse, execute=_read_execute,
)


# ── grep ─────────────────────────────────────────────────────────────────────

def _compile_pattern(pattern: str):
    try:
        return re.compile(pattern, re.I), False
    except re.error:
        return re.compile(re.escape(pattern), re.I), True


MAX_GREP_PATTERNS = 10


def _grep_parse(raw: Optional[Dict[str, Any]]) -> Union[Dict[str, Any], str]:
    listed = [p for p in raw.get("patterns") if isinstance(p, str) and js_trim(p)] if raw and isinstance(raw.get("patterns"), list) else []
    single = raw.get("pattern") if raw and isinstance(raw.get("pattern"), str) else (raw.get("query") if raw and isinstance(raw.get("query"), str) else "")
    patterns = list(dict.fromkeys(listed if listed else ([single] if js_trim(single) else [])))
    if not patterns:
        return "the pattern was empty"
    if len(patterns) > MAX_GREP_PATTERNS:
        return f"at most {MAX_GREP_PATTERNS} patterns in one call ({len(patterns)} were given)"

    def num(v: Any, fallback: int, cap: int) -> int:
        return max(0, min(cap, int(v))) if isinstance(v, (int, float)) and not isinstance(v, bool) else fallback
    return {"patterns": patterns, "refs": _chapter_refs(raw) if raw else [], "output": "chapters" if raw and raw.get("output") == "chapters" else "snippets",
            "context": num(raw.get("context") if raw else None, DEFAULT_CONTEXT, MAX_CONTEXT),
            "maxResults": max(1, num(raw.get("max_results") if raw else None, DEFAULT_SEARCH_RESULTS, MAX_SEARCH_RESULTS))}


def _search_pattern(pattern: str, scope: List[Dict[str, Any]], ctx: ToolContext, output: str, context: int, max_results: int, scoped: bool,
                    attached: Optional[List[Any]] = None) -> Dict[str, Any]:
    regex, literal = _compile_pattern(pattern)
    hits: List[str] = []
    per_chapter: List[str] = []
    total = 0
    for att, paras in attached or []:
        # A reference file named in `chapters` (attachments_and_web.md §1); never searched otherwise.
        label = f'{att["ref"]} "{att["name"]}"'
        count = 0
        for n, text in enumerate(paras, start=1):
            for m in regex.finditer(text):
                if not m.group(0):
                    continue
                count += 1
                if output == "snippets" and len(hits) < max_results:
                    start = max(0, m.start() - context)
                    end = min(len(text), m.end() + context)
                    hits.append(f'{label} ¶{n}: {"…" if start > 0 else ""}{re.sub(r"\s+", " ", text[start:end])}{"…" if end < len(text) else ""}')
        if count:
            per_chapter.append(f'{label} — {count} match{"" if count == 1 else "es"}')
            total += count
    for chapter in scope:
        count = 0
        for para in chapter_paragraphs(accepted_html(ctx, chapter["id"])):
            text = para["text"]
            for m in regex.finditer(text):
                if not m.group(0):
                    continue
                count += 1
                if output == "snippets" and len(hits) < max_results:
                    start = max(0, m.start() - context)
                    end = min(len(text), m.end() + context)
                    snippet = re.sub(r"\s+", " ", text[start:end])
                    hits.append(f'#{chapter["number"]} "{chapter["title"]}" ¶{para["number"]}: {"…" if start > 0 else ""}{snippet}{"…" if end < len(text) else ""}')
        title_hit = any(m.group(0) for m in regex.finditer(chapter["title"]))
        if count == 0 and title_hit:
            if output == "snippets" and len(hits) < max_results:
                hits.append(f'#{chapter["number"]} "{chapter["title"]}" (title matches)')
            per_chapter.append(f'#{chapter["number"]} "{chapter["title"]}" — title matches')
            total += 1
        elif count > 0:
            per_chapter.append(f'#{chapter["number"]} "{chapter["title"]}" — {count} match{"" if count == 1 else "es"}')
            total += count
    scope_note = f" in {len(scope) + len(attached or [])} chapter(s)" if scoped else ""
    literal_note = " (not a valid regular expression; searched as plain text)" if literal else ""
    if total == 0:
        head = f"No matches for /{pattern}/{scope_note}{literal_note}."
    else:
        head = f"{total} match(es) in {len(per_chapter)} chapter(s){scope_note}{literal_note}" + (f"; showing the first {len(hits)}" if output == "snippets" and total > len(hits) else "") + ":"
    return {"pattern": pattern, "head": head, "lines": per_chapter if output == "chapters" else hits, "total": total, "chapterCount": len(per_chapter)}


async def _grep_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    patterns, refs, output, context, max_results = args["patterns"], args["refs"], args["output"], args["context"], args["maxResults"]
    all_chapters = ctx.document.chapters()
    scope = [{**c, "number": i + 1} for i, c in enumerate(all_chapters)]
    attachments_scope: List[Dict[str, Any]] = []
    if refs:
        picked: List[Dict[str, Any]] = []
        known = attachment_list(ctx)
        for ref in refs:
            r = resolve_ref(ref, all_chapters, known)
            if "error" in r:
                return _fail("grep", r["error"])
            if "attachment" in r:
                if not any(a["id"] == r["attachment"]["id"] for a in attachments_scope):
                    attachments_scope.append(r["attachment"])
            elif not any(c["id"] == r["chapter"]["id"] for c in picked):
                picked.append(scope[r["chapter"]["number"] - 1])
        scope = picked
    await ctx.document.ensure_loaded([c["id"] for c in scope])
    attached = [(a, await ctx.attachments.paragraphs(a["id"])) for a in attachments_scope]
    loaded_now = ctx.document.chapters()
    unloaded = [c for c in scope if next((n for n in loaded_now if n["id"] == c["id"]), {}).get("loaded") is False]
    searchable = [c for c in scope if c not in unloaded]
    results = [_search_pattern(p, searchable, ctx, output, context, max_results, bool(refs), attached) for p in patterns]

    skipped = [f"Not searched — their text could not be loaded: {', '.join(f'#{c['number']} \"{c['title']}\"' for c in unloaded)}."] if unloaded else []
    labels = [f"#{c['number']}" for c in scope] + [a["ref"] for a, _ in attached]
    where = "in the whole book" if not refs else (f"in {', '.join(labels)}" if len(labels) <= 4 else f"in {len(labels)} chapters")
    not_loaded = f" · {len(unloaded)} not loaded" if unloaded else ""
    if len(results) == 1:
        r = results[0]
        across = f" in {r['chapterCount']} chapter(s)" if r["chapterCount"] > 1 or (not refs and r["chapterCount"]) else ""
        return result(True, "\n".join([r["head"], *r["lines"], *skipped]),
                      f"🔎 grep /{r['pattern']}/ {where} → {r['total']} match{'' if r['total'] == 1 else 'es'}{across}" + not_loaded)
    total = sum(r["total"] for r in results)
    content = "\n\n".join(["\n".join([f"=== /{r['pattern']}/ ===", r["head"], *r["lines"]]) for r in results] + skipped)
    each = ", ".join("/" + r["pattern"] + "/ " + str(r["total"]) for r in results)
    return result(True, content, f"🔎 grep {len(results)} patterns {where} → {each} ({total} in all)" + not_loaded)


grep_tool = Tool(
    name="grep",
    description=(
        "Search the book like grep: a regular expression (case-insensitive) over every chapter's text, or only the chapters you name. "
        'Use it to locate where a name, phrase, object or event appears before reading — e.g. "阿青|阿红", "第[一二三]次", "outline". '
        f"To check several things at once, pass patterns (up to {MAX_GREP_PATTERNS}): each is searched and reported on its own — one call, one step. "
        'output "snippets" (default) returns each match with its chapter number, paragraph number (¶) and surrounding text — read around it with read_chapter paragraphs="…", or change it with edit_paragraphs; output "chapters" returns only the chapters that match, with counts. '
        'Chapter titles are searched too. An attachment (A1…) is searched only when named in chapters.'),
    parameters={"type": "object", "properties": {
        "pattern": {"type": "string", "description": "A JavaScript regular expression, matched case-insensitively. Plain words work as they are."},
        "patterns": {"type": "array", "description": f"Instead of pattern: up to {MAX_GREP_PATTERNS} expressions, each searched and reported separately.", "items": {"type": "string"}},
        "chapters": {"type": "array", "description": "Optional: limit the search to these chapters (numbers from the CHAPTER INDEX, or titles), or search attachments (A1).", "items": {"type": "string"}},
        "output": {"type": "string", "description": '"snippets" (default) or "chapters".'},
        "context": {"type": "integer", "description": f"Characters of text on each side of a match in snippets. Default {DEFAULT_CONTEXT}, at most {MAX_CONTEXT}."},
        "max_results": {"type": "integer", "description": f"Snippets to return per pattern. Default {DEFAULT_SEARCH_RESULTS}, at most {MAX_SEARCH_RESULTS}."},
    }},
    kind="read", parse=_grep_parse, execute=_grep_execute,
)


# ── list_chapters ────────────────────────────────────────────────────────────

async def _list_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    lines = []
    for i, c in enumerate(ctx.document.chapters()):
        html = accepted_html(ctx, c["id"])
        chars = len(html_to_plain_text(html))
        paras = len(chapter_paragraphs(html))
        marks = [m for m in [
            "open in the editor" if c["id"] == ctx.document.open_id() else "",
            "created this turn" if c["id"] in ctx.run.created else "",
            "changed this turn" if c["id"] in ctx.run.touched else "",
        ] if m]
        summary = c.get("summary") or ""
        summary_note = f" — {re.sub(r'\\s+', ' ', js_trim(summary))[:200]}" if js_trim(summary) else ""
        lines.append(f'{i + 1}. "{c["title"]}" ({paras} paragraphs, {chars} chars{"; " + "; ".join(marks) if marks else ""}){summary_note}')
    listing = "\n".join(lines)
    notes: List[str] = []
    if ctx.run.last_list == listing:
        notes.append("This is identical to your previous list_chapters result: nothing has changed since then.")
    if ctx.run.start_outline is not None and ctx.run.start_outline == chapter_outline(ctx.document.chapters()):
        write = '<canvas new_chapter="its title">…</canvas>' if ctx.run.write_protocol == "markup" else "update_document with new_chapter"
        notes.append("No chapter has been added, removed or renamed in this turn: this is the CHAPTER INDEX of your request, with sizes. "
                     f"Listing changes nothing in the book. A new chapter appears here only after you write it, with {write}.")
    ctx.run.last_list = listing
    return result(True, f"{listing}\n\n" + "\n".join(notes) if notes else listing, "📚 list chapters")


list_chapters_tool = Tool(
    name="list_chapters",
    description=("The current list of chapters with their numbers, sizes and summaries. The CHAPTER INDEX in the request already has this as of the start of the turn; call this only when chapters were added, removed or renamed during the turn, or when you need their sizes. "
                 "It changes nothing in the book: a new chapter is added by writing it (new_chapter)."),
    parameters={"type": "object", "properties": {}}, kind="read", parse=lambda raw: {}, execute=_list_execute,
)


# ── open_chapter ─────────────────────────────────────────────────────────────

async def _open_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    target = resolve_chapter(args["chapter"], ctx.document.chapters())
    if isinstance(target, str):
        return _fail("open_chapter", target)
    if ctx.selection.range() is not None and not ctx.run.selection_applied and target["id"] != ctx.document.open_id():
        return result(False, "The user has text selected in the open chapter; finish with the selection before showing another chapter.",
                      f"open {cite_chapter(target)}: refused (selection pending)", retryable=False)
    if target["id"] == ctx.document.open_id():
        return result(True, f"{cite_chapter(target)} is already open.", f"📂 {cite_chapter(target)} already open")
    if ctx.document.user_moved():
        return result(True, f"{cite_chapter(target)} was NOT opened: the user is working in another chapter. Tell them it is #{target['number']} in the chapter list. Writing and reading it need no opening.",
                      f"📂 left {cite_chapter(target)} for the user to open")
    ctx.document.open(target["id"])
    return result(True, f"{cite_chapter(target)} is now open in the editor for the user to see. To rewrite it whole, write it now: {_full_write(ctx, target['number'])}."
                  + ("" if target["id"] in ctx.run.html_shown else ' Only edits to parts of it need its HTML first (read_chapter, format "html").'),
                  f"📂 open {cite_chapter(target)}")


open_chapter_tool = Tool(
    name="open_chapter",
    description="ONLY to show a chapter to the user, when they ask to see it. Never call it to prepare a write or a read: every write names its chapter directly (`chapter`), and read_chapter reads any chapter. Opening a chapter changes nothing you can write or read.",
    parameters={"type": "object", "properties": {"chapter": {"type": "string", "description": "Its number in the CHAPTER INDEX, or its exact title."}}, "required": ["chapter"]},
    kind="navigate", parse=lambda raw: {"chapter": raw["chapter"]} if raw and raw.get("chapter") is not None else "no chapter was named",
    execute=_open_execute,
)


# ── delete_chapter ───────────────────────────────────────────────────────────

async def _delete_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    chapters = ctx.document.chapters()
    target = resolve_chapter(args["chapter"], chapters)
    if isinstance(target, str):
        return _fail("delete_chapter", target)

    def refuse(content: str, why: str) -> Dict[str, Any]:
        return result(False, content, f"🗑 delete {cite_chapter(target)} refused — {why}", retryable=False)
    if target["id"] == ctx.document.start_id:
        return refuse(f"{cite_chapter(target)} is the chapter this turn started on; it cannot be deleted during the turn.", "the turn started there")
    if len(chapters) <= 1:
        return refuse("It is the only chapter of the book.", "the only chapter")
    own = target["id"] in ctx.run.created and not user_edited(ctx, target["id"])
    if not own:
        await ctx.document.ensure_loaded([target["id"]])
        now = next((c for c in ctx.document.chapters() if c["id"] == target["id"]), None)
        if not now or now.get("loaded") is False:
            return refuse(f"{cite_chapter(target)} could not be loaded, so it is not known to be empty. It was not deleted.", "not loaded")
        if not is_blank_content(now["content"]):
            return refuse(f"{cite_chapter(target)} has text. Only the user can delete a chapter with text: ask them with ask_user whether to, and tell them it is #{target['number']} in the chapter list.", "it has text")
    ctx.document.remove(target["id"])
    forget_chapter(ctx, target["id"])
    ctx.run.created.discard(target["id"])
    ctx.run.in_context.discard(target["id"])
    ctx.run.touched.pop(target["id"], None)
    after = len(chapters) - target["number"]
    return result(True, f"Deleted {cite_chapter(target)}." + (f" The {after} chapter(s) after it moved up by one: #{target['number'] + 1} is now #{target['number']}, and so on. The CHAPTER INDEX in your request still shows the old numbers." if after > 0 else ""),
                  f"🗑 deleted {cite_chapter(target)}")


delete_chapter_tool = Tool(
    name="delete_chapter",
    description=("Delete a chapter you created by mistake, or an empty chapter. A chapter that has text can only be deleted by the user — ask them with ask_user; never empty a chapter to get around this. "
                 "Deleting renumbers the chapters after it."),
    parameters={"type": "object", "properties": {"chapter": {"type": "string", "description": "Its number in the CHAPTER INDEX, or its exact title."}}, "required": ["chapter"]},
    kind="write", run_last=True, parse=lambda raw: {"chapter": raw["chapter"]} if raw and raw.get("chapter") is not None else "no chapter was named",
    execute=_delete_execute,
)

BOOK_TOOLS = [read_chapter_tool, grep_tool, list_chapters_tool, open_chapter_tool, delete_chapter_tool, rename_chapter_tool]
