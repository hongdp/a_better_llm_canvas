"""The server-side agent loop and tools against an in-memory book
(wc_agent; a port of the essentials of src/agent/__tests__)."""
import asyncio
import json
from typing import Any, Dict, List, Optional

import pytest

from wc_agent.registry import Tool, ToolRegistry
from wc_agent.run import AgentRun, StepOutput
from wc_agent.tools.book_reads import BOOK_TOOLS, read_chapter_tool
from wc_agent.tools.document_writes import DOCUMENT_WRITE_TOOLS, similar_chapters
from wc_agent.types import ToolContext, create_run_state
from wc_text.diff import strip_diff_markup
from wc_text.policy import DEFAULT_BUDGETS, DEFAULT_POLICY
from wc_text.stream_handlers import NO_ACTION_RETRY_INSTRUCTION


class FakeBook:
    """Every port over one in-memory book: no editor, no store, every call recorded."""

    def __init__(self, original: str, chapters: Optional[List[Dict[str, Any]]] = None, selected_text: str = "",
                 in_context: Optional[List[str]] = None, lazy: Optional[Dict[str, str]] = None) -> None:
        self.book: List[Dict[str, Any]] = [{"id": "doc-1", "title": "Chapter 1", "content": original}, *(chapters or [])]
        self.lazy = dict(lazy or {})
        self.writes: List[Dict[str, str]] = []
        self.snapshots: List[str] = []
        self.opened: List[str] = []
        self.removed: List[str] = []
        self.progress: List[Optional[str]] = []
        self.previews: List[str] = []
        self.selection_previews: List[str] = []
        self.open_id = "doc-1"
        self.moved = False
        self.created = 0
        self.selected_text = selected_text
        book = self

        class Document:
            start_id = "doc-1"
            original = ""

            def chapters(self):
                return [{**c, "loaded": c["id"] not in book.lazy} for c in book.book]

            def open_id(self):
                return book.open_id

            def user_moved(self):
                return book.moved

            async def ensure_loaded(self, ids):
                for i in ids:
                    if i in book.lazy:
                        ch = next((c for c in book.book if c["id"] == i), None)
                        if ch:
                            ch["content"] = book.lazy.pop(i)

            def commit(self, doc_id, html):
                book.writes.append({"id": doc_id, "html": html})
                ch = next((c for c in book.book if c["id"] == doc_id), None)
                if ch:
                    ch["content"] = html

            def open(self, doc_id):
                book.open_id = doc_id
                book.opened.append(doc_id)

            def create(self, title):
                book.created += 1
                doc_id = f"new-{book.created}"
                book.book.append({"id": doc_id, "title": title, "content": "<p></p>"})
                return doc_id

            def rename(self, doc_id, title):
                ch = next((c for c in book.book if c["id"] == doc_id), None)
                if ch:
                    ch["title"] = title

            def remove(self, doc_id):
                book.removed.append(doc_id)
                book.book = [c for c in book.book if c["id"] != doc_id]
                if book.open_id == doc_id:
                    book.open_id = book.book[0]["id"] if book.book else ""

            def snapshot(self, doc_id, label):
                book.snapshots.append(doc_id)

        class Editor:
            def preview_document(self, html):
                book.previews.append(html)

            def preview_selection(self, html):
                book.selection_previews.append(html)

            def discard_preview(self):
                pass

        class Selection:
            def range(self):
                return True if book.selected_text else None

            def original_text(self):
                return book.selected_text

        class Images:
            def preserve(self, h):
                return h

            def restore(self, h):
                return h

        class Ui:
            def progress(self, line):
                book.progress.append(line)

            def writing(self, doc_id):
                pass

        document = Document()
        document.original = original
        self.ctx = ToolContext(document, Editor(), Selection(), Images(), Ui(),
                               create_run_state("doc-1", in_context, original))

    def user_edits(self, doc_id: str, html: str) -> None:
        ch = next(c for c in self.book if c["id"] == doc_id)
        ch["content"] = html

    def last_write(self, doc_id: str) -> Optional[str]:
        return next((w["html"] for w in reversed(self.writes) if w["id"] == doc_id), None)


def run_tool(tool: Tool, args: Dict[str, Any], ctx: ToolContext, call: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    inv = {"id": "x", "name": tool.name, "args": args, "source": "native", **(call or {})}
    return asyncio.run(tool.invoke(inv, ctx))


# ── writes ────────────────────────────────────────────────────────────────────

def test_second_edit_matches_text_the_first_wrote():
    fake = FakeBook("<p>alpha</p>")
    update, edit, _ = DOCUMENT_WRITE_TOOLS
    assert run_tool(edit, {"edits": [{"search": "<p>alpha</p>", "replace": "<p>beta</p>"}]}, fake.ctx)["ok"]
    out = run_tool(edit, {"edits": [{"search": "<p>beta</p>", "replace": "<p>gamma</p>"}]}, fake.ctx)
    assert out["ok"], out
    assert strip_diff_markup(fake.last_write("doc-1")) == "<p>gamma</p>"
    assert "diff-deletion" in fake.last_write("doc-1")


def test_rewrite_guards_truncated_and_empty():
    fake = FakeBook("<p>alpha</p>")
    update = DOCUMENT_WRITE_TOOLS[0]
    out = run_tool(update, {"html": "<p>cut"}, fake.ctx, {"unclosed": True})
    assert out["ok"] is False and out["effects"]["canvasIssue"] == "truncated"
    assert fake.last_write("doc-1") == "<p>alpha</p>"
    out = run_tool(update, {"html": "   "}, fake.ctx)
    assert out["effects"] == {"producedNothing": True}


def test_edit_on_unread_chapter_is_refused_then_allowed_after_html_read():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "Chapter 2", "content": "<p>two</p>"}])
    edit = DOCUMENT_WRITE_TOOLS[1]
    out = run_tool(edit, {"chapter": "2", "edits": [{"search": "<p>two</p>", "replace": "<p>TWO</p>"}]}, fake.ctx)
    assert out["ok"] is False and out["retryable"] is True and "not read yet" in out["trace"]
    assert run_tool(read_chapter_tool, {"chapters": ["2"], "format": "html"}, fake.ctx)["ok"]
    out = run_tool(edit, {"chapter": "2", "edits": [{"search": "<p>two</p>", "replace": "<p>TWO</p>"}]}, fake.ctx)
    assert out["ok"], out
    assert fake.snapshots == ["doc-2"]
    assert "TWO" in fake.last_write("doc-2")


def test_user_edit_meanwhile_refuses_the_write_and_keeps_their_text():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "Chapter 2", "content": "<p>two</p>"}])
    edit = DOCUMENT_WRITE_TOOLS[1]
    run_tool(read_chapter_tool, {"chapters": ["2"], "format": "html"}, fake.ctx)
    fake.user_edits("doc-2", "<p>two, by the user</p>")
    out = run_tool(edit, {"chapter": "2", "edits": [{"search": "<p>two</p>", "replace": "<p>TWO</p>"}]}, fake.ctx)
    assert out["ok"] is False and "edited by the user meanwhile" in out["trace"]
    assert fake.last_write("doc-2") is None


def test_new_chapter_is_created_by_the_write_and_rewrite_answers_differently():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "第二章 进城", "content": "<p>two</p>"}])
    update = DOCUMENT_WRITE_TOOLS[0]
    out = run_tool(update, {"new_chapter": "第二章 入城", "html": "<p>new text</p>"}, fake.ctx)
    assert out["ok"] and "Created a NEW chapter" in out["content"] and "rename_chapter" in out["content"]
    assert fake.opened == ["new-1"] and strip_diff_markup(fake.last_write("new-1")) == "<p>new text</p>"
    out = run_tool(update, {"html": "<p>rewritten</p>"}, fake.ctx)
    assert "Rewrote the EXISTING chapter" in out["content"] and "No chapter was added" in out["content"]


def test_new_chapter_title_of_an_unread_chapter_is_refused():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "Chapter 2", "content": "<p>two</p>"}])
    out = run_tool(DOCUMENT_WRITE_TOOLS[0], {"new_chapter": "Chapter 2", "html": "<p>x</p>"}, fake.ctx)
    assert out["ok"] is False and "not overwritten" in out["trace"]
    assert fake.last_write("doc-2") is None and fake.created == 0


def test_selection_rewrite_is_placed_by_text_and_edits_beside_it_apply_locally():
    fake = FakeBook("<p>Keep this. Change this.</p><p>other</p>", selected_text="Change this.")
    _, edit, replace = DOCUMENT_WRITE_TOOLS
    out = run_tool(replace, {"html": "<p>Changed.</p>"}, fake.ctx)
    assert out["ok"], out
    html = fake.last_write("doc-1")
    assert strip_diff_markup(html) == "<p>Keep this. Changed.</p><p>other</p>"
    out = run_tool(edit, {"edits": [{"search": "<p>other</p>", "replace": "<p>others</p>"}]}, fake.ctx)
    assert out["ok"], out
    assert "others" in fake.last_write("doc-1")


def test_rename_and_replace():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "第二章 进城", "content": "<h1>第二章 进城</h1><p>old</p>"}])
    update, rename = DOCUMENT_WRITE_TOOLS[0], BOOK_TOOLS[-1]
    run_tool(update, {"new_chapter": "第二章 入城", "html": "<h1>第二章 入城</h1><p>new</p>"}, fake.ctx)
    out = run_tool(rename, {"chapter": "3", "title": "第二章 进城"}, fake.ctx)
    assert out["ok"] is False and "replace=true" in out["content"]
    out = run_tool(rename, {"chapter": "3", "title": "第二章 进城", "replace": True}, fake.ctx)
    assert out["ok"], out
    assert fake.removed == ["new-1"]
    assert strip_diff_markup(fake.last_write("doc-2")) == "<h1>第二章 进城</h1><p>new</p>"


def test_similar_chapters_never_pairs_different_numbers():
    chapters = [{"id": "a", "title": "第二章 进城"}, {"id": "b", "title": "第三章 入城"}]
    assert [c["number"] for c in similar_chapters("第二章 入城", "x", chapters)] == [1]


# ── reads ─────────────────────────────────────────────────────────────────────

def test_read_chapter_numbers_paragraphs_and_pages():
    paras = "".join(f"<p>{'段落' * 300}{i}</p>" for i in range(40))
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "Long", "content": paras}])
    out = run_tool(read_chapter_tool, {"chapters": ["2"]}, fake.ctx)
    assert out["ok"] and "¶1 " in out["content"] and "Stopped at ¶" in out["content"]
    out = run_tool(read_chapter_tool, {"chapters": ["2"], "paragraphs": "\"38-\""}, fake.ctx)
    assert "¶38 " in out["content"] and "¶37 " not in out["content"]
    out = run_tool(read_chapter_tool, {"chapters": ["2"], "paragraphs": "-2"}, fake.ctx)
    assert "¶2 " in out["content"] and "¶3 " not in out["content"]


def test_read_repeat_guard_and_in_context():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "Two", "content": "<p>two</p>"}], in_context=["doc-2"])
    out = run_tool(read_chapter_tool, {"chapters": ["2"]}, fake.ctx)
    assert "already in your context" in out["content"]
    fake.ctx.run.step = 3
    assert "¶1 two" in run_tool(read_chapter_tool, {"chapters": ["2"]}, fake.ctx)["content"]
    assert "already returned in step 4" in run_tool(read_chapter_tool, {"chapters": ["2"]}, fake.ctx)["content"]


def test_grep_finds_across_chapters_with_paragraph_numbers():
    fake = FakeBook("<p>阿青来了</p>", chapters=[{"id": "doc-2", "title": "阿红", "content": "<p>x</p><p>阿青又来了</p>"}])
    out = run_tool(BOOK_TOOLS[1], {"pattern": "阿青|阿红"}, fake.ctx)
    assert '#1 "Chapter 1" ¶1' in out["content"] and '#2 "阿红" ¶2' in out["content"]
    assert "2 match(es) in 2 chapter(s)" in out["content"]
    out = run_tool(BOOK_TOOLS[1], {"pattern": "("}, fake.ctx)
    assert "plain text" in out["content"]


def test_list_chapters_says_when_nothing_changed():
    fake = FakeBook("<p>alpha</p>")
    from wc_agent.types import chapter_outline
    fake.ctx.run.start_outline = chapter_outline(fake.ctx.document.chapters())
    out = run_tool(BOOK_TOOLS[2], {}, fake.ctx)
    assert "No chapter has been added" in out["content"]
    assert "identical to your previous" in run_tool(BOOK_TOOLS[2], {}, fake.ctx)["content"]


def test_delete_only_what_nothing_would_be_lost_from():
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "Two", "content": "<p>two</p>"}, {"id": "doc-3", "title": "Empty", "content": "<p></p>"}])
    delete = BOOK_TOOLS[4]
    assert run_tool(delete, {"chapter": "2"}, fake.ctx)["ok"] is False
    out = run_tool(delete, {"chapter": "3"}, fake.ctx)
    assert out["ok"] and fake.removed == ["doc-3"]


# ── the run ───────────────────────────────────────────────────────────────────

def read_tool(execute=None):
    async def default(args, ctx, call):
        return {"ok": True, "content": f"TEXT OF {args.get('chapter')}", "trace": f"read {args.get('chapter')}"}
    return Tool(name="read_chapter", description="Read.", parameters={"type": "object", "properties": {"chapter": {"type": "string"}}},
                kind="read", execute=execute or default)


class Harness:
    def __init__(self, replies, *, write_protocol="markup", budgets=None, policy=None, can_continue=True, original="<p>alpha</p>",
                 extra=None, guard=None, chapters=None):
        self.fake = FakeBook(original, chapters=chapters)
        self.registry = ToolRegistry([*DOCUMENT_WRITE_TOOLS, read_tool(), *(extra or [])])
        self.requests: List[List[Dict[str, Any]]] = []
        self.corrective: List[Any] = []
        self.paused: List[Any] = []
        self.summary: Optional[Dict[str, Any]] = None
        self.replies = list(replies)
        harness = self

        async def driver(messages, step, final):
            harness.requests.append(messages)
            if not harness.replies:
                raise AssertionError("scripted replies exhausted")
            nxt = harness.replies.pop(0)
            return nxt(messages) if callable(nxt) else nxt

        class Observer:
            def on_corrective(self, failure, attempt, mx):
                harness.corrective.append((failure, attempt, mx))

            def on_step_executed(self, progress):
                pass

            def on_paused(self, reason, progress):
                harness.paused.append(reason)

            def on_asked(self, question, progress):
                harness.paused.append({"reason": "question", **question})

            def on_finish(self, summary):
                harness.summary = summary

        self.run = AgentRun(registry=self.registry, ctx=self.fake.ctx, write_protocol=write_protocol, driver=driver, observer=Observer(),
                            budgets={**DEFAULT_BUDGETS, **(budgets or {})}, policy={**DEFAULT_POLICY, **(policy or {})},
                            can_continue=can_continue, initial_messages=[{"role": "system", "content": "sys"}, {"role": "user", "content": "request"}],
                            guard=guard)


def text(t: str) -> StepOutput:
    return StepOutput(t)


DONE = text("done\n<doc_status>unchanged</doc_status>")


def calls(t: str, *c) -> StepOutput:
    return StepOutput(t, [{"id": i, "name": n, "args": json.loads(a), "argumentsText": a} for i, n, a in c])


def test_markup_turn_applies_a_rewrite_and_ends():
    h = Harness([text("Sure.\n<canvas><p>beta</p></canvas>\n<doc_status>updated</doc_status>")])
    asyncio.run(h.run.start())
    assert h.summary["endReason"] == "writes_done" and h.summary["steps"] == 1
    assert strip_diff_markup(h.fake.last_write("doc-1")) == "<p>beta</p>"


def test_writes_continue_the_turn_and_a_plain_reply_ends_it():
    h = Harness([text("<canvas><p>beta</p></canvas>"), text("Done.")], policy={"continueAfterWrites": True, "feedBackFailedWrites": True})
    asyncio.run(h.run.start())
    assert h.summary["endReason"] == "answered" and h.summary["steps"] == 2
    assert h.requests[1][-1]["content"].startswith("RESULT OF YOUR DOCUMENT CHANGES")
    assert h.summary["chatText"] == "Done."


def test_protocol_failure_is_retried_by_appending():
    h = Harness([text("I changed it."), text("<canvas><p>beta</p></canvas>\n<doc_status>updated</doc_status>")])
    asyncio.run(h.run.start())
    assert h.corrective == [("undeclared", 1, 3)]
    assert h.requests[1][:2] == h.requests[0] and h.requests[1][-1]["content"] == NO_ACTION_RETRY_INSTRUCTION
    assert h.summary["endReason"] == "writes_done"


def test_read_is_answered_under_its_call_id_with_exact_bytes():
    h = Harness([calls("Reading.", ("c1", "read_chapter", '{"chapter":  "2"}')), text("Answer.\n<doc_status>unchanged</doc_status>")])
    asyncio.run(h.run.start())
    assistant, tool = h.requests[1][2], h.requests[1][3]
    assert assistant["toolCalls"][0]["argumentsText"] == '{"chapter":  "2"}'
    assert tool == {"role": "tool", "toolCallId": "c1", "name": "read_chapter", "content": "TEXT OF 2"}
    assert h.summary["endReason"] == "answered" and h.summary["trace"] == ["read 2"]


def test_step_limit_sends_the_final_step_with_the_note():
    h = Harness([calls("r", ("c1", "read_chapter", '{"chapter":"1"}')), calls("r", ("c2", "read_chapter", '{"chapter":"2"}')), text("done")], budgets={"maxSteps": 2})
    asyncio.run(h.run.start())
    assert h.summary["endReason"] == "step_limit" and h.summary["steps"] == 2
    assert "step budget" in h.requests[1][-1]["content"]


def test_unlimited_steps_when_the_limit_is_zero():
    h = Harness([calls("r", ("c%d" % i, "read_chapter", '{"chapter":"%d"}' % i)) for i in range(8)] + [DONE], budgets={"maxSteps": 0})
    asyncio.run(h.run.start())
    assert h.summary["steps"] == 9 and h.summary["endReason"] == "answered"


def test_guard_pauses_between_steps_and_resume_continues():
    pauses = {"count": 0}

    def guard(run):
        if run.steps_taken == 1 and pauses["count"] == 0:
            pauses["count"] += 1
            return {"reason": "repeating"}
        return None
    h = Harness([calls("r", ("c1", "read_chapter", '{"chapter":"1"}')), DONE], guard=guard)
    asyncio.run(h.run.start())
    assert h.paused == [{"reason": "repeating"}] and h.summary is None and h.run.paused
    asyncio.run(h.run.resume())
    assert h.summary["endReason"] == "answered" and h.summary["steps"] == 2


def test_snapshot_and_restore_continue_from_the_last_completed_step():
    h = Harness([calls("r", ("c1", "read_chapter", '{"chapter":"1"}'))], guard=lambda run: {"reason": "x"} if run.steps_taken == 1 else None)
    asyncio.run(h.run.start())
    snap = json.loads(json.dumps(h.run.snapshot()))
    h2 = Harness([DONE])
    h2.run.restore(snap, lambda doc_id: next((c["content"] for c in h2.fake.book if c["id"] == doc_id), None))
    asyncio.run(h2.run.resume())
    assert h2.summary["steps"] == 2 and h2.summary["trace"] == ["read 1"]
    assert h2.requests[0][2]["toolCalls"][0]["id"] == "c1"


def test_cancel_ends_the_run_without_dropping_created_chapters():
    def stop_after_first(messages):
        h.run.cancel()
        return text("<canvas new_chapter=\"New\"><p>draft")
    h = Harness([stop_after_first])
    asyncio.run(h.run.start())
    assert h.summary["endReason"] == "cancelled"
    assert any(c["title"] == "New" for c in h.fake.book)


def test_empty_created_chapter_is_dropped_at_the_end():
    h = Harness([text("<canvas new_chapter=\"New\"><p>cut"), DONE], policy={"continueAfterWrites": True, "feedBackFailedWrites": True})
    asyncio.run(h.run.start())
    assert not any(c["title"] == "New" for c in h.fake.book) and h.fake.removed == ["new-1"]


def test_markup_model_gets_update_document_natively_beside_its_tag():
    h = Harness([text("x")])
    names = [t.name for t in h.run.offered_tools()]
    assert names == ["update_document", "read_chapter"]
    h2 = Harness([text("x")], write_protocol="tools")
    assert [t.name for t in h2.run.offered_tools()] == ["update_document", "edit_document", "read_chapter"]


def test_tags_beside_a_native_write_are_both_applied():
    h = Harness([StepOutput('<canvas chapter="2"><p>tagged</p></canvas>', [{"id": "w1", "name": "update_document", "args": {"html": "<p>native</p>"}, "argumentsText": '{"html":"<p>native</p>"}'}])],
                chapters=[{"id": "doc-2", "title": "Two", "content": "<p></p>"}], policy={"continueAfterWrites": False, "feedBackFailedWrites": True})
    asyncio.run(h.run.start())
    assert strip_diff_markup(h.fake.last_write("doc-1")) == "<p>native</p>"
    assert strip_diff_markup(h.fake.last_write("doc-2")) == "<p>tagged</p>"
    assert h.summary["strayMarkup"] == 0


# ── reminders, plan, ask_user ────────────────────────────────────────────────

def test_identical_steps_get_one_nudge_in_their_results():
    read = calls("r", ("c", "read_chapter", '{"chapter":"2"}'))
    h = Harness([read, read, read, read, DONE])
    asyncio.run(h.run.start())
    assert h.summary["steps"] == 5
    assert "<system-reminder>" not in h.requests[2][-1]["content"]
    assert "the same call (read_chapter)" in h.requests[3][-1]["content"]
    assert "<system-reminder>" not in h.requests[4][-1]["content"]
    assert h.run.identical_run_length() == 0  # the closing reply made no call


def test_argument_order_does_not_make_calls_differ():
    a = calls("r", ("c", "read_chapter", '{"chapter":"2","format":"text"}'))
    b = calls("r", ("c", "read_chapter", '{"format":"text","chapter":"2"}'))
    h = Harness([a, b, a, DONE])
    asyncio.run(h.run.start())
    assert "the same call" in h.requests[3][-1]["content"]


def test_long_reasoning_reminder_lands_one_step_later():
    read = calls("r", ("c", "read_chapter", '{"chapter":"2"}'))
    read.usage = {"promptTokens": 1, "completionTokens": 1, "reasoningTokens": 5000}
    later = calls("r", ("c2", "read_chapter", '{"chapter":"3"}'))
    h = Harness([read, later, DONE])
    h.run.long_reasoning_tokens = 1000
    asyncio.run(h.run.start())
    assert "reasoning trace (about 5,000 tokens)" not in h.requests[1][-1]["content"]
    assert "reasoning trace (about 5,000 tokens)" in h.requests[2][-1]["content"]


def test_plan_reminds_and_nudges_an_early_ending():
    from wc_agent.tools.plan import plan_tool
    plan_call = calls("Planning.", ("p", "plan", '{"items":[{"id":"a","title":"写第一章","status":"in_progress"},{"id":"b","title":"写第二章"}]}'))
    # Nothing was written, so "done" would be refused: the items are dropped.
    h = Harness([plan_call, text("写完了。\n<doc_status>unchanged</doc_status>"), calls("", ("p2", "plan", '{"items":[{"id":"a","status":"dropped"},{"id":"b","status":"dropped"}]}')), DONE],
                extra=[plan_tool])
    asyncio.run(h.run.start())
    assert "PLAN (0/2 done)" in h.requests[1][-1]["content"]
    nudge = h.requests[2][-1]["content"]
    assert "Your plan still has 2 unfinished items" in nudge and h.requests[2][-2]["content"] == "写完了。\n<doc_status>unchanged</doc_status>"
    assert h.summary["endReason"] == "answered" and h.summary["steps"] == 4
    assert [i["status"] for i in h.summary["plan"]] == ["dropped", "dropped"]


def test_plan_says_when_a_done_chapter_is_still_empty():
    from wc_agent.tools.plan import plan_tool
    fake = FakeBook("<p>alpha</p>", chapters=[{"id": "doc-2", "title": "第二章", "content": "<p></p>"}])
    out = run_tool(plan_tool, {"items": [{"title": "写第二章", "status": "done"}]}, fake.ctx)
    assert out["ok"] and 'the chapter "第二章" is still empty' in out["content"]


def test_ask_user_waits_for_the_answer():
    from wc_agent.tools.ask_user import ask_user_tool
    h = Harness([calls("", ("q", "ask_user", '{"question":"Which?","options":["A (Recommended)","B"]}')), DONE], extra=[ask_user_tool])
    asyncio.run(h.run.start())
    assert h.summary is None and h.run.paused == {"reason": "question", "question": "Which?", "options": ["A (Recommended)", "B"]}
    asyncio.run(h.run.resume_with_answer("B"))
    assert h.summary["endReason"] == "answered"
    assert h.requests[1][-1] == {"role": "user", "content": "The user answered: B"}


def test_failed_search_names_the_nearest_paragraph():
    fake = FakeBook('<p>她说：“我们走吧。”他没有回头。</p><p>第二段。</p>')
    edit = DOCUMENT_WRITE_TOOLS[1]
    # The matcher forgives quotes alone; a changed punctuation mark makes it miss.
    out = run_tool(edit, {"edits": [{"search": '<p>她说："我们走吧。"他没有回头！</p>', "replace": "<p>x</p>"}]}, fake.ctx)
    assert out["ok"] is False
    assert "Nearest: ¶1 — copy this HTML exactly: <p>她说：“我们走吧。”他没有回头。</p>" in out["content"]
    assert "curly quotes" in out["content"]


def test_plan_refuses_done_on_a_write_item_with_nothing_written():
    from wc_agent.tools.plan import plan_tool
    h = Harness([
        calls("", ("p", "plan", '{"items":[{"id":"w","title":"改写第十四章","status":"in_progress"},{"id":"r","title":"对大纲接缝"}]}')),
        calls("", ("p2", "plan", '{"items":[{"id":"w","status":"done"},{"id":"r","status":"done"}],"merge":true}')),
        text("<canvas><p>written</p></canvas>"),
        calls("", ("p3", "plan", '{"items":[{"id":"w","status":"done"}],"merge":true}')),
        DONE,
    ], policy={"continueAfterWrites": True, "feedBackFailedWrites": True}, extra=[plan_tool])
    asyncio.run(h.run.start())
    refused = next(m["content"] for m in h.requests[2] if m.get("role") == "tool" and m.get("toolCallId") == "p2")
    assert '"改写第十四章" was marked done, but nothing has been written' in refused and "▶ 改写第十四章" in refused and "☑ 对大纲接缝" in refused
    accepted = next(m["content"] for m in h.requests[4] if m.get("role") == "tool" and m.get("toolCallId") == "p3")
    assert "☑ 改写第十四章" in accepted
    assert [i["status"] for i in h.summary["plan"]] == ["done", "done"]


def test_html_read_without_an_edit_is_nudged_once_at_the_ending():
    async def html_read(args, ctx, call):
        return {"ok": True, "content": "<p>¶88</p>", "trace": f"read #1 ¶88 ({args.get('format')})"}
    h = Harness([calls("", ("c", "read_chapter", '{"chapter":"1","format":"html"}')), DONE, DONE])
    h.registry = ToolRegistry([*DOCUMENT_WRITE_TOOLS, read_tool(html_read)])
    h.run.registry = h.registry
    asyncio.run(h.run.start())
    assert len(h.requests) == 3
    assert "Your last read of a chapter's HTML (read #1 ¶88 (html)) is the step before an edit" in h.requests[2][-1]["content"]
    assert h.summary["endReason"] == "answered"
