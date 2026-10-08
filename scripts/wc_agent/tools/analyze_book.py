"""Port of src/agent/tools/analyzeBook.ts."""
from typing import Any, Dict, List, Union

from wc_text.chapters import cite_chapter, resolve_chapter
from wc_text.diff import strip_diff_markup
from wc_text.jsstr import js_trim

from ..registry import Tool
from ..types import ToolContext, result

NOTES_CAP = 20_000


def _analyze_parse(raw) -> Union[Dict[str, Any], str]:
    task = js_trim(raw["task"]) if raw and isinstance(raw.get("task"), str) else ""
    if not task:
        return "the task was empty"
    refs = raw["chapters"] if isinstance(raw.get("chapters"), list) else ([raw["chapters"]] if raw.get("chapters") is not None else [])
    return {"task": task, "refs": refs}


async def _analyze_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    task, refs = args["task"], args["refs"]
    analyze = ctx.analyze
    if analyze is None:
        return result(False, "No model is available to analyze the book.", "⚠️ analyze_book: not available", retryable=False)
    all_chapters = ctx.document.chapters()
    scope = [{**c, "number": i + 1} for i, c in enumerate(all_chapters)]
    if refs:
        picked: List[Dict[str, Any]] = []
        for ref in refs:
            r = resolve_chapter(ref, all_chapters)
            if isinstance(r, str):
                return result(False, f"analyze_book was not run: {r}", f"⚠️ analyze_book: {r.splitlines()[0]}", retryable=True)
            if not any(c["id"] == r["id"] for c in picked):
                picked.append(scope[r["number"] - 1])
        scope = picked
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

    out = await analyze.run(task, chapters, lambda done, total: ctx.ui.progress(f"📚 reading the book for analysis … batch {min(done + 1, total)}/{total}"))
    ctx.ui.progress(None)
    where = "the book" if not refs else (", ".join(f"#{c['number']}" for c in scope) if len(scope) <= 4 else f"{len(scope)} chapters")
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
                 "One model call per batch (the trace shows how many). For a few chapters read_chapter is cheaper and exact; to find where something appears, use grep."),
    parameters={"type": "object", "properties": {
        "task": {"type": "string", "description": 'What the notes are for, e.g. "list every promise 晓晓 makes and whether it is kept".'},
        "chapters": {"type": "array", "items": {"type": "string"}, "description": "Optional: only these chapters (numbers from the CHAPTER INDEX, or titles)."},
    }, "required": ["task"]},
    kind="read", is_available=lambda ctx: ctx.analyze is not None, parse=_analyze_parse, execute=_analyze_execute,
)
