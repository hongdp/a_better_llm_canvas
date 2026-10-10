"""Port of src/agent/tools/analyzeBook.ts."""
from typing import Any, Dict, List, Union

from wc_text.attachments import attachment_chunks, find_attachment_range
from wc_text.chapters import cite_chapter
from wc_text.diff import strip_diff_markup
from wc_text.jsstr import js_trim

from ..polish import ANALYZE_CONFIRM_TOKENS
from ..registry import Tool
from ..types import ToolContext, result

NOTES_CAP = 20_000
#: An attachment is cut into pieces of at most this many characters before batching (§1).
ATTACHMENT_CHUNK_CHARS = 40_000


def _analyze_parse(raw) -> Union[Dict[str, Any], str]:
    task = js_trim(raw["task"]) if raw and isinstance(raw.get("task"), str) else ""
    if not task:
        return "the task was empty"
    refs = raw["chapters"] if isinstance(raw.get("chapters"), list) else ([raw["chapters"]] if raw.get("chapters") is not None else [])
    from .book_reads import _parse_range
    rng = _parse_range(raw.get("paragraphs"))
    if isinstance(rng, str):
        return rng
    section = js_trim(raw["section"]) if isinstance(raw.get("section"), str) and js_trim(raw["section"]) else None
    out = {"task": task, "refs": refs, "range": rng, "confirmed": raw.get("confirmed") is True}
    if section:
        out["section"] = section
    return out


def _thousands(n: int) -> str:
    return f"{int(n / 1000 + 0.5)}k" if n >= 10_000 else str(n)


async def _analyze_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    task, refs, section, rng, confirmed = args["task"], args["refs"], args.get("section"), args.get("range"), args.get("confirmed", False)
    analyze = ctx.analyze
    if analyze is None:
        return result(False, "No model is available to analyze the book.", "⚠️ analyze_book: not available", retryable=False)
    from .book_reads import attachment_list, resolve_ref
    all_chapters = ctx.document.chapters()
    scope = [{**c, "number": i + 1} for i, c in enumerate(all_chapters)]
    files: List[Dict[str, Any]] = []
    if refs:
        picked: List[Dict[str, Any]] = []
        known = attachment_list(ctx)
        for ref in refs:
            r = resolve_ref(ref, all_chapters, known)
            if "error" in r:
                return result(False, f"analyze_book was not run: {r['error']}", f"⚠️ analyze_book: {r['error'].splitlines()[0]}", retryable=True)
            if "attachment" in r:
                if not any(a["id"] == r["attachment"]["id"] for a in files):
                    files.append(r["attachment"])
            elif not any(c["id"] == r["chapter"]["id"] for c in picked):
                picked.append(scope[r["chapter"]["number"] - 1])
        scope = picked
    if (section or rng) and not files:
        return result(False, "analyze_book was not run: section and paragraphs pick a part of an attachment (A1); name one in chapters.",
                      "⚠️ analyze_book: section/paragraphs without an attachment", retryable=True)
    await ctx.document.ensure_loaded([c["id"] for c in scope])
    now = ctx.document.chapters()
    unloaded = [c for c in scope if next((n for n in now if n["id"] == c["id"]), {}).get("loaded") is False]
    chapters = []
    for c in scope:
        if c in unloaded:
            continue
        working = ctx.run.docs.get(c["id"])
        content = working.html if working else strip_diff_markup(next((n["content"] for n in now if n["id"] == c["id"]), ""))
        if js_trim(content):
            chapters.append({"id": c["id"], "title": c["title"], "content": content})
    # An attachment, or the part of it named: a section per pseudo-chapter, cut to fit a batch.
    parts: List[str] = []
    for att in files:
        paras = await ctx.attachments.paragraphs(att["id"])
        span = None
        if rng:
            span = {"from": rng["from"], "to": min(rng["to"] if rng.get("to") is not None else len(paras), len(paras))}
            if span["from"] > len(paras):
                return result(False, f"analyze_book was not run: {att['ref']} has {len(paras)} paragraphs; there is no ¶{span['from']}.",
                              f"⚠️ analyze_book: {att['ref']} has no ¶{span['from']}", retryable=True)
            parts.append(f"{att['ref']} ¶{span['from']}–{span['to']}")
        elif section:
            hit = find_attachment_range(att["sections"], section)
            if hit is None:
                sample = ", ".join(f'"{s["title"]}"' for s in att["sections"][:6])
                return result(False, f'analyze_book was not run: {att["ref"]} "{att["name"]}" has no section matching "{section}".'
                              + (f' Its sections begin {sample}…; grep chapters=["{att["ref"]}"] for a heading, or pass paragraphs.' if sample
                                 else " It has no section headings; pass paragraphs instead."),
                              f'⚠️ analyze_book: no section "{section}" in {att["ref"]}', retryable=True)
            span = {"from": hit["from"], "to": hit["to"]}
            parts.append(f"{att['ref']} {section}")
        else:
            parts.append(att["ref"])
        for i, chunk in enumerate(attachment_chunks(att, paras, ATTACHMENT_CHUNK_CHARS, span)):
            chapters.append({"id": f"{att['id']}#{i}", "title": chunk["title"], "content": chunk["text"]})

    # A long read asks first: the estimate goes to the model, which asks the user.
    plan = analyze.plan(task, chapters) if hasattr(analyze, "plan") else None
    labels = [f"#{c['number']}" for c in scope] + parts
    where = "the book" if not refs else (", ".join(labels) if len(labels) <= 4 else f"{len(labels)} chapters")
    if plan and plan["inputTokens"] > ANALYZE_CONFIRM_TOKENS and not confirmed:
        return result(False,
                      f"analyze_book was not run: reading {where} would send about {plan['inputTokens']} input tokens in {plan['calls']} model call{'' if plan['calls'] == 1 else 's'}, more than {ANALYZE_CONFIRM_TOKENS} — ask first. "
                      "Ask the user with ask_user whether to spend that, giving these numbers. To spend less, read only what the task needs: grep for it and read those paragraphs with read_chapter, or name a part (section=\"第62–87章\" or paragraphs=\"1203-2890\" for an attachment, or fewer chapters). "
                      "If the user agrees, call analyze_book again with the same arguments and confirmed: true.",
                      f"📚 analyze_book: {where} ≈ {_thousands(plan['inputTokens'])} tokens in {plan['calls']} calls — asks first", retryable=False)

    out = await analyze.run(task, chapters, lambda done, total: ctx.ui.progress(f"📚 reading the book for analysis … batch {min(done + 1, total)}/{total}"))
    ctx.ui.progress(None)
    notes = out["notes"] if len(out["notes"]) <= NOTES_CAP else f"{out['notes'][:NOTES_CAP]}\n[notes cut at {NOTES_CAP} characters]"
    ended = (f" Stopped by the user after {out['batches']} of {out['total']} batches." if out.get("stopped")
             else f" Batch {out['batches'] + 1} of {out['total']} failed ({out['failed']}); the notes cover the batches before it." if out.get("failed") else "")
    skipped = f"\nNot read — their text could not be loaded: {', '.join(cite_chapter(c) for c in unloaded)}." if unloaded else ""
    return result(out["batches"] > 0 and bool(out["notes"]),
                  f"NOTES from reading {len(chapters)} chapter(s) of {where} in {out['batches']} batch(es) for: {task}.{ended}\n{notes or '(no notes)'}{skipped}",
                  f"📚 analyzed {where} — {len(chapters)} chapter{'' if len(chapters) == 1 else 's'}, {out['batches']} model call{'' if out['batches'] == 1 else 's'}"
                  + (" (stopped)" if out.get("stopped") else " (failed)" if out.get("failed") else ""), retryable=False)


analyze_book_tool = Tool(
    name="analyze_book",
    description=("Read every chapter of the book — or the chapters you name — in batches, with a separate model call per batch, and get back notes for a task that needs all of them at once: the plot so far across the whole book, every appearance of a thread or character, consistency checks. "
                 "One model call per batch (the trace shows how many). For a few chapters read_chapter is cheaper and exact; to find where something appears, use grep. "
                 'For an attachment (A1), read only the part the task needs: section="第62–87章" (headings) or paragraphs="1203-2890" (¶ numbers, which grep reports; in a novel .txt a ¶ is a line). '
                 "A run past 200,000 input tokens is not started: you get the estimate, ask the user with ask_user, and call again with confirmed: true if they agree."),
    parameters={"type": "object", "properties": {
        "task": {"type": "string", "description": 'What the notes are for, e.g. "list every promise 晓晓 makes and whether it is kept".'},
        "chapters": {"type": "array", "items": {"type": "string"}, "description": "Optional: only these chapters (numbers from the CHAPTER INDEX, or titles), or attachments (A1)."},
        "section": {"type": "string", "description": 'Attachments only: the sections to read, by heading — one ("第三十章") or a run ("第62–87章").'},
        "paragraphs": {"type": "string", "description": 'Attachments only: a ¶ range, e.g. "1203-2890" or "1203-" (to the end). Wins over section.'},
        "confirmed": {"type": "boolean", "description": "true only after the user agreed to a run past 200,000 input tokens."},
    }, "required": ["task"]},
    kind="read", is_available=lambda ctx: ctx.analyze is not None, parse=_analyze_parse, execute=_analyze_execute,
)
