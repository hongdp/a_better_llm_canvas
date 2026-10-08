"""Port of src/agent/tools/plan.ts — the model's checklist for a turn."""
import re
from typing import Any, Dict

from wc_text.plan import apply_plan_update, render_plan
from wc_text.reminders import plan_not_written_note
from wc_text.text import is_blank_content

from ..registry import Tool
from ..types import ToolContext, result, writes_so_far


def _title_key(title: str) -> str:
    return re.sub(r"\s+", "", title).lower()


_WRITE_ITEM_RE = re.compile(r"写|改|补|删|增|润色|rewrite|write|edit|revise|insert|add|create|polish|delete|rename|expand|fix", re.I)


async def _plan_execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    applied = apply_plan_update(ctx.run.plan, args.get("items"), args.get("merge"))
    if isinstance(applied, str):
        return result(False, f"plan was not updated: {applied}", f"⚠️ plan: {applied}", retryable=True)
    # A write item is done only once something was written since it started
    # (2026-10-08: "改写第十四章" was marked done in the reply meant to write
    # it; the write came one step later).
    written = writes_so_far(ctx.run)
    before = {i["id"]: i for i in ctx.run.plan}
    refused = []
    updated = []
    for item in applied:
        prev = before.get(item["id"])
        if prev is None or item["status"] == "in_progress":
            keep = prev is not None and prev["status"] == "in_progress" and item["status"] == "in_progress"
            ctx.run.plan_baseline[item["id"]] = ctx.run.plan_baseline.get(item["id"], written) if keep else written
        if item["status"] == "done" and prev and prev["status"] != "done" and _WRITE_ITEM_RE.search(item["title"]) and written <= ctx.run.plan_baseline.get(item["id"], written):
            refused.append(plan_not_written_note(item["title"]))
            item = {**item, "status": "in_progress" if prev["status"] == "pending" else prev["status"]}
        updated.append(item)
    for item_id in list(ctx.run.plan_baseline):
        if not any(i["id"] == item_id for i in updated):
            del ctx.run.plan_baseline[item_id]
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
    extra = [*refused, *notes]
    return result(True, render_plan(updated) + ("\n" + "\n".join(extra) if extra else ""),
                  f"📋 plan {done}/{len(updated)}" + (' (a "done" refused: nothing written yet)' if refused else ""))


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
