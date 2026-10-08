"""Port of src/agent/tools/plan.ts — the model's checklist for a turn."""
import re
from typing import Any, Dict

from wc_text.plan import apply_plan_update, render_plan
from wc_text.text import is_blank_content

from ..registry import Tool
from ..types import ToolContext, result


def _title_key(title: str) -> str:
    return re.sub(r"\s+", "", title).lower()


async def _plan_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    updated = apply_plan_update(ctx.run.plan, args.get("items"), args.get("merge"))
    if isinstance(updated, str):
        return result(False, f"plan was not updated: {updated}", f"⚠️ plan: {updated}", retryable=True)
    ctx.run.plan = updated
    chapters = ctx.document.chapters()
    notes = []
    for item in updated:
        if item["status"] != "done":
            continue
        named = next((c for c in chapters if _title_key(c["title"]) in item["title"].lower() or _title_key(c["title"]) in _title_key(item["title"])), None)
        if named and named.get("loaded") is not False and is_blank_content(named["content"]):
            notes.append(f'"{item["title"]}" is marked done, but the chapter "{named["title"]}" is still empty.')
    done = sum(1 for i in updated if i["status"] in ("done", "dropped"))
    return result(True, render_plan(updated) + ("\n" + "\n".join(notes) if notes else ""), f"📋 plan {done}/{len(updated)}")


plan_tool = Tool(
    name="plan",
    description=("Keep a checklist of the steps of this turn. The user sees it live under your reply; the editor reminds you of it after each step. "
                 "Use it when the request takes 3 or more steps (several chapters to write, a series of edits); skip it for one-step work. "
                 "Send the whole list to create or reorder it; to update statuses, send only {id, status} for the items that changed. Keep one item in_progress at a time and mark each done as soon as it is."),
    parameters={"type": "object", "properties": {
        "items": {"type": "array", "description": "The steps, in order.", "items": {"type": "object", "properties": {
            "id": {"type": "string", "description": 'A short stable id (e.g. "ch5"). Required for a status update; optional when sending the whole list.'},
            "title": {"type": "string", "description": 'The step, e.g. "Write chapter 5: the harbor".'},
            "status": {"type": "string", "description": '"pending" (default), "in_progress", "done" or "dropped".'},
        }}},
        "merge": {"type": "boolean", "description": "true: update only the items named, keep the rest. Default false (replace the list)."},
    }, "required": ["items"]},
    kind="read", parse=lambda raw: {"items": raw.get("items"), "merge": raw.get("merge") if isinstance(raw.get("merge"), bool) else None} if raw is not None else "its arguments could not be parsed",
    execute=_plan_execute,
)
