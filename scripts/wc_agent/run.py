"""Port of src/agent/run.ts — one turn as a run of steps, as an async loop.

The client's controller is callback-driven (a step completes inside the
transport's onDone). On the server a step is awaited, so the controller is a
loop: `start()` runs steps until the run ends, `pause()`/`resume()` stop and
continue it between steps (backend_authority.md "Runaway runs"), and
`snapshot()`/`restore()` carry it across an API restart.
"""
import inspect
from typing import Any, Awaitable, Callable, Dict, List, Optional

from wc_text.invocations import arguments_text_of, collect_step, plan_writes
from wc_text.jsstr import js_trim
from wc_text.plan import unfinished_plan_items
from wc_text.policy import decide_after_step, detect_step_failure, steps_left
from wc_text.reminders import (PLAN_NUDGE_BUDGET, REPEAT_NUDGE_STEPS, append_reminders, html_read_nudge, long_reasoning_reminder,
                               plan_reminder, plan_unfinished_nudge, repeat_nudge, wrap_reminder)
from wc_text.stream_handlers import NO_ACTION_RETRY_INSTRUCTION, STEP_LIMIT_NOTE
from wc_text.text import is_blank_content
from wc_text.tool_call_stream import call_signature

from .registry import Tool, ToolRegistry
from .types import ToolContext, seen_chapters

UNKNOWN_TOOL_KIND = "read"


class StepOutput:
    def __init__(self, text: str, native_calls: Optional[List[Dict[str, Any]]] = None, thinking: Optional[List[Any]] = None,
                 response_items: Optional[List[Any]] = None, usage: Optional[Dict[str, Any]] = None) -> None:
        self.text = text
        self.native_calls = native_calls or []
        self.thinking = thinking
        self.response_items = response_items
        self.usage = usage


async def _maybe_await(value):
    if inspect.isawaitable(value):
        return await value
    return value


class AgentRun:
    def __init__(self, *, registry: ToolRegistry, ctx: ToolContext, write_protocol: str,
                 driver: Callable[[List[Dict[str, Any]], int, bool], Awaitable[StepOutput]], observer: Any,
                 budgets: Dict[str, Any], policy: Dict[str, Any], can_continue: bool, initial_messages: List[Dict[str, Any]],
                 agent_tools: bool = True, guard: Optional[Callable[["AgentRun"], Optional[Dict[str, Any]]]] = None,
                 long_reasoning_tokens: int = 0, reminders: Optional[Callable[["AgentRun"], List[str]]] = None) -> None:
        self.registry = registry
        self.ctx = ctx
        self.write_protocol = write_protocol
        self.driver = driver
        self.observer = observer
        self.budgets = budgets
        self.policy = policy
        self.can_continue = can_continue
        self.agent_tools = agent_tools
        self.guard = guard
        self.long_reasoning_tokens = long_reasoning_tokens
        self.host_reminders = reminders
        self.long_reasoning_due: Optional[Dict[str, int]] = None
        self.plan_nudges = 0
        #: The trace of the last HTML read that no write has followed yet (the step before an edit).
        self.html_read_pending: Optional[str] = None
        self.html_read_nudged = False
        self.messages: List[Dict[str, Any]] = list(initial_messages)
        self.steps_taken = 0
        self.corrective_used = 0
        self.cancelled = False
        self.finished = False
        self.paused: Optional[Dict[str, Any]] = None
        self.chat_texts: List[str] = []
        self.timeline: List[Dict[str, Any]] = []
        self.trace: List[str] = []
        self.stray = 0
        self.wrote = False
        self.step_dropped = 0
        self.effects: Dict[str, Any] = {"canvasIssue": None, "failedEdits": 0, "reinsertedImages": 0, "selectionGone": False, "producedNothing": False}
        self.usage: Dict[str, int] = {"promptTokens": 0, "completionTokens": 0, "cachedPromptTokens": 0}
        # Per step: the calls it made and what they returned, for the pause guard.
        self.step_log: List[Dict[str, Any]] = []
        # Steps before this index were judged already: a guard looks only at
        # what happened since the last resume, or it would pause again at once.
        self.guard_floor = 0
        self._offered: Optional[List[Tool]] = None
        self._next: Optional[Dict[str, Any]] = None
        ctx.run.write_protocol = write_protocol
        ctx.run.continues_after_writes = policy["continueAfterWrites"]

    # ── driving ──────────────────────────────────────────────────────────────
    async def start(self) -> None:
        self._next = {"messages": self.messages, "step": self.steps_taken, "final": steps_left(self.budgets, self.steps_taken) == 1}
        await self._loop()

    async def resume(self) -> None:
        self.paused = None
        self.cancelled = False
        self.guard_floor = len(self.step_log)
        await self._loop()

    async def resume_with_answer(self, answer: str) -> None:
        """The user answered `ask_user`: the answer is the next message, and the run goes on."""
        self.ctx.run.question = None
        self.messages = [*self.messages, {"role": "user", "content": f"The user answered: {answer}"}]
        self._next = {"messages": self.messages, "step": self.steps_taken, "final": steps_left(self.budgets, self.steps_taken) == 1}
        await self.resume()

    def cancel(self) -> None:
        self.cancelled = True

    async def _loop(self) -> None:
        while self._next is not None and not self.finished and not self.cancelled:
            if self.guard is not None:
                reason = self.guard(self)
                if reason:
                    self.paused = reason
                    await _maybe_await(self.observer.on_paused(reason, self.progress()))
                    return
            pending = self._next
            self._next = None
            out = await self.driver(pending["messages"], pending["step"], pending["final"])
            await self.step_done(out)
            # A step may leave the run waiting (a question for the user): the
            # next step is kept for the resume, not started now.
            if self.paused is not None:
                return
        if self.cancelled and not self.finished:
            await self.finish({"failedUpdate": None, "exhaustedCorrective": False, "unretriableFailedUpdate": False, "endReason": "cancelled"})

    def offered_tools(self) -> List[Tool]:
        if self._offered is None:
            self._offered = self.registry.available(self.ctx, lambda t:
                (self.write_protocol == "tools" or not t.markup_form or (t.native_on_markup and self.agent_tools))
                and (self.agent_tools or t.markup_form))
        return self._offered

    # ── a step finished ──────────────────────────────────────────────────────
    async def step_done(self, out: StepOutput) -> None:
        if self.finished:
            return
        self.steps_taken += 1
        if out.usage:
            for key in ("promptTokens", "completionTokens", "cachedPromptTokens"):
                self.usage[key] += int(out.usage.get(key) or 0)
        collected = collect_step(out.text, out.native_calls, self.registry.descriptor, self.steps_taken - 1,
                                 {"markupProtocol": self.write_protocol == "markup"})
        failure = detect_step_failure({"text": out.text, "writeProtocol": self.write_protocol, "hadNativeCalls": bool(out.native_calls),
                                       "markupKind": collected["markupKind"], "wroteThisRun": self.wrote})
        if failure:
            await self._handle_protocol_failure(failure, out, collected)
            return

        self.ctx.run.step = self.steps_taken - 1
        last = lambda inv: bool((self.registry.get(inv["name"]) or Tool("", "", {}, "read", None)).run_last)  # noqa: E731
        writes = [inv for inv in collected["invocations"] if self._kind_of(inv) == "write" and not last(inv)]
        planned = plan_writes(writes)
        to_run = ([inv for inv in collected["invocations"] if self._kind_of(inv) != "write" and not last(inv)]
                  + planned["run"] + [inv for inv in collected["invocations"] if last(inv)])
        self.stray += collected["strayMarkup"] + planned["dropped"]
        self.step_dropped = collected["strayMarkup"] + planned["dropped"]
        if js_trim(collected["chatText"]):
            self.chat_texts.append(js_trim(collected["chatText"]))
            self.timeline.append({"type": "text", "text": js_trim(collected["chatText"])})

        results = []
        for inv in to_run:
            results.append(await self._invoke(inv))
        await self._after_execute(out, to_run, results)

    def _kind_of(self, inv: Dict[str, Any]) -> str:
        tool = self.registry.get(inv["name"])
        return tool.kind if tool else UNKNOWN_TOOL_KIND

    async def _invoke(self, inv: Dict[str, Any]) -> Dict[str, Any]:
        tool = self.registry.get(inv["name"])
        if tool is None:
            return {"ok": False, "content": f'There is no tool named "{inv["name"]}".', "trace": f'⚠️ unknown tool "{inv["name"]}"'}
        try:
            return await tool.invoke(inv, self.ctx)
        except Exception as e:  # noqa: BLE001 — a tool failure is a result the model reads
            return {"ok": False, "content": f"{inv['name']} failed: {e}", "trace": f"⚠️ {inv['name']} failed"}

    async def _handle_protocol_failure(self, failure: str, out: StepOutput, collected: Dict[str, Any]) -> None:
        can_correct = (self.can_continue and not self.cancelled and self.corrective_used < self.budgets["maxCorrective"]
                       and steps_left(self.budgets, self.steps_taken) > 0)
        if can_correct:
            self.corrective_used += 1
            await _maybe_await(self.observer.on_corrective(failure, self.corrective_used, self.budgets["maxCorrective"]))
            reply: Dict[str, Any] = {"role": "assistant", "content": out.text}
            if out.response_items:
                reply["responseItems"] = out.response_items
            self.messages = [*self.messages, reply, {"role": "user", "content": NO_ACTION_RETRY_INSTRUCTION}]
            self.step_log.append({"calls": [], "results": [], "wrote": False, "failure": failure})
            self._next = {"messages": self.messages, "step": self.steps_taken, "final": steps_left(self.budgets, self.steps_taken) == 1}
            return
        if js_trim(collected["chatText"]):
            self.chat_texts.append(js_trim(collected["chatText"]))
            self.timeline.append({"type": "text", "text": js_trim(collected["chatText"])})
        self.stray += collected["strayMarkup"]
        await self.finish({
            "failedUpdate": failure,
            "exhaustedCorrective": self.can_continue,
            "unretriableFailedUpdate": (not self.can_continue) and failure in ("malformed", "claimed"),
            "endReason": "cancelled" if self.cancelled else "protocol_failure",
        })

    async def _after_execute(self, out: StepOutput, ran: List[Dict[str, Any]], results: List[Dict[str, Any]]) -> None:
        if self.finished:
            return
        executed = [{"kind": self._kind_of(inv), "result": r} for inv, r in zip(ran, results)]
        wrote_now = any(e["kind"] == "write" and e["result"]["ok"] for e in executed)
        if wrote_now:
            self.wrote = True
        for e in executed:
            self.trace.append(e["result"]["trace"])
            self.timeline.append({"type": "tool", "line": e["result"]["trace"], "ok": e["result"]["ok"]})
        self.step_log.append({
            "calls": [{"name": inv["name"], "arguments": arguments_text_of(inv)} for inv in ran],
            "signature": "\n".join(sorted(call_signature(inv["name"], inv.get("args"), inv.get("argumentsText")) for inv in ran)),
            "names": list(dict.fromkeys(inv["name"] for inv in ran)),
            "results": [r["content"] for r in results], "wrote": wrote_now,
        })
        reasoning = int((out.usage or {}).get("reasoningTokens") or 0)
        if self.long_reasoning_tokens > 0 and not wrote_now and reasoning > self.long_reasoning_tokens:
            self.long_reasoning_due = {"atStep": self.steps_taken + 1, "tokens": reasoning}
        if wrote_now:
            self.html_read_pending = None
        for inv, r in zip(ran, results):
            if inv["name"] == "read_chapter" and (inv.get("args") or {}).get("format") == "html" and r["ok"]:
                self.html_read_pending = r["trace"]

        decision = decide_after_step({"executed": executed, "stepsTaken": self.steps_taken, "correctiveUsed": self.corrective_used,
                                      "budgets": self.budgets, "policy": self.policy})
        continuing = decision["action"] == "continue" and self.can_continue and not self.cancelled
        handed_back = continuing and decision.get("corrective")
        for e in executed:
            eff = e["result"].get("effects")
            if not eff:
                continue
            if eff.get("canvasIssue") and not self.effects["canvasIssue"]:
                self.effects["canvasIssue"] = eff["canvasIssue"]
            self.effects["reinsertedImages"] += eff.get("reinsertedImages") or 0
            self.effects["selectionGone"] = self.effects["selectionGone"] or bool(eff.get("selectionGone"))
            if handed_back and e["result"].get("retryable", not e["result"]["ok"]):
                continue
            self.effects["failedEdits"] += eff.get("failedEdits") or 0
            self.effects["producedNothing"] = self.effects["producedNothing"] or bool(eff.get("producedNothing"))

        # The model asked the user something: the results are appended so the
        # call is answered, then the run waits for the answer (resume_with_answer).
        if self.ctx.run.question and not self.cancelled:
            self.messages = [*self.messages, *self._result_messages(out, ran, results)]
            self._next = {"messages": self.messages, "step": self.steps_taken, "final": steps_left(self.budgets, self.steps_taken) == 1}
            self.paused = {"reason": "question", **self.ctx.run.question}
            await _maybe_await(self.observer.on_asked(self.ctx.run.question, self.progress()))
            return

        # A reply with no action while the plan has work left, or right after
        # an HTML read that no edit followed: the model is reminded and
        # continues (a bounded number of times).
        unfinished = unfinished_plan_items(self.ctx.run.plan)
        may_nudge = (decision["action"] == "end" and decision["reason"] == "answered" and self.can_continue and not self.cancelled
                     and steps_left(self.budgets, self.steps_taken) > 0)
        nudge = None
        if may_nudge and unfinished and self.plan_nudges < PLAN_NUDGE_BUDGET:
            self.plan_nudges += 1
            nudge = plan_unfinished_nudge(self.ctx.run.plan)
        elif may_nudge and self.html_read_pending and not self.html_read_nudged:
            self.html_read_nudged = True
            nudge = html_read_nudge(self.html_read_pending)
        if nudge:
            reply: Dict[str, Any] = {"role": "assistant", "content": out.text}
            if out.response_items:
                reply["responseItems"] = out.response_items
            self.messages = [*self.messages, reply, {"role": "user", "content": wrap_reminder(nudge)}]
            self._next = {"messages": self.messages, "step": self.steps_taken, "final": steps_left(self.budgets, self.steps_taken) == 1}
            await _maybe_await(self.observer.on_step_executed(self.progress()))
            return

        if continuing:
            if decision.get("corrective"):
                self.corrective_used += 1
            self.messages = [*self.messages, *append_reminders(self._result_messages(out, ran, results), self._collect_reminders())]
            if decision.get("final"):
                self.messages = [*self.messages, {"role": "user", "content": STEP_LIMIT_NOTE}]
            # Before the observer: a snapshot taken there must know a step follows.
            self._next = {"messages": self.messages, "step": self.steps_taken, "final": decision["final"]}
            await _maybe_await(self.observer.on_step_executed(self.progress()))
            return

        await self.finish({
            "failedUpdate": None, "exhaustedCorrective": False, "unretriableFailedUpdate": False,
            "endReason": "cancelled" if self.cancelled else (decision["reason"] if decision["action"] == "end" else "step_limit"),
        })

    def _collect_reminders(self) -> List[str]:
        """The automated context beside the next step's results (wc_text.reminders)."""
        out: List[str] = []
        run_len = self.identical_run_length()
        if run_len == REPEAT_NUDGE_STEPS:
            out.append(repeat_nudge(self.step_log[-1]["names"], run_len))
        if self.long_reasoning_due and self.long_reasoning_due["atStep"] == self.steps_taken:
            out.append(long_reasoning_reminder(self.long_reasoning_due["tokens"]))
            self.long_reasoning_due = None
        if unfinished_plan_items(self.ctx.run.plan):
            out.append(plan_reminder(self.ctx.run.plan))
        if self.host_reminders is not None:
            out.extend(self.host_reminders(self))
        return out

    def identical_run_length(self) -> int:
        """Steps in a row, ending with the last, that made the same calls and wrote nothing (since the last resume)."""
        log = self.step_log[self.guard_floor:]
        if not log or not log[-1].get("signature") or log[-1]["wrote"]:
            return 0
        n = 0
        for step in reversed(log):
            if step.get("signature") != log[-1]["signature"] or step["wrote"]:
                break
            n += 1
        return n

    def _result_messages(self, out: StepOutput, ran: List[Dict[str, Any]], results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        native = [(inv, r) for inv, r in zip(ran, results) if inv["source"] == "native"]
        markup = [(inv, r) for inv, r in zip(ran, results) if inv["source"] == "markup"]
        reply: Dict[str, Any] = {"role": "assistant", "content": out.text}
        if native:
            calls = []
            for inv, _ in native:
                call = {"id": inv["id"], "name": inv["name"], "argumentsText": arguments_text_of(inv)}
                if inv.get("signature"):
                    call["signature"] = inv["signature"]
                calls.append(call)
            reply["toolCalls"] = calls
        if out.thinking:
            reply["thinking"] = out.thinking
        if out.response_items:
            reply["responseItems"] = out.response_items
        messages = [reply]
        for inv, r in native:
            messages.append({"role": "tool", "toolCallId": inv["id"], "name": inv["name"], "content": r["content"]})
        lost = (f"- NOT APPLIED: {self.step_dropped} document block(s) in your reply did not reach the document — a full rewrite beside <edit> blocks for the same chapter, "
                "a rewrite beside a selection rewrite, or markup that could not be read. Write what you still want changed in a reply of its own."
                if self.step_dropped > 0 else "")
        if markup or lost:
            lines = [f"- {inv['name']}: {r['content']}" for inv, r in markup] + ([lost] if lost else [])
            messages.append({"role": "user", "content": "RESULT OF YOUR DOCUMENT CHANGES:\n" + "\n".join(lines)})
        return messages

    # ── state ────────────────────────────────────────────────────────────────
    def progress(self) -> Dict[str, Any]:
        return {
            "chatText": "\n\n".join(self.chat_texts), "timeline": list(self.timeline), "steps": self.steps_taken,
            "trace": list(self.trace), "touched": list(self.ctx.run.touched.values()), "seen": seen_chapters(self.ctx.run),
            "readIds": list(self.ctx.run.read_ids), "usage": dict(self.usage), "plan": list(self.ctx.run.plan),
        }

    async def finish(self, end: Dict[str, Any]) -> None:
        if self.finished:
            return
        self.finished = True
        self._next = None
        if end["endReason"] != "cancelled":
            self._drop_empty_created()
        summary = {"strayMarkup": self.stray, "effects": dict(self.effects), **self.progress(), "question": None, **end}
        await _maybe_await(self.observer.on_finish(summary))

    def _drop_empty_created(self) -> None:
        run, document = self.ctx.run, self.ctx.document
        for chapter in list(document.chapters()):
            if chapter["id"] not in run.created or not is_blank_content(chapter["content"]):
                continue
            document.remove(chapter["id"])
            run.created.discard(chapter["id"])
            run.touched.pop(chapter["id"], None)

    def snapshot(self) -> Dict[str, Any]:
        """Everything a restart needs to continue from the last completed step."""
        run = self.ctx.run
        return {
            "messages": self.messages, "stepsTaken": self.steps_taken, "correctiveUsed": self.corrective_used,
            "chatTexts": self.chat_texts, "timeline": self.timeline, "trace": self.trace, "stray": self.stray, "wrote": self.wrote,
            "effects": self.effects, "usage": self.usage, "stepLog": self.step_log[-6:], "guardFloor": max(0, self.guard_floor - (len(self.step_log) - len(self.step_log[-6:]))),
            "next": self._next is not None,
            "final": bool(self._next and self._next["final"]),
            "run": {
                "seen": seen_chapters(run), "created": sorted(run.created), "snapshotted": sorted(run.snapshotted),
                "readIds": list(run.read_ids), "reads": run.reads, "touched": list(run.touched.values()),
                "startOutline": run.start_outline, "lastList": run.last_list,
                "selectionAttempted": run.selection_attempted, "selectionApplied": run.selection_applied,
                "plan": list(run.plan), "question": run.question,
            },
            "planNudges": self.plan_nudges, "longReasoningDue": self.long_reasoning_due,
            "htmlReadPending": self.html_read_pending, "htmlReadNudged": self.html_read_nudged, "planBaseline": run.plan_baseline,
        }

    def restore(self, snap: Dict[str, Any], stored: Callable[[str], Optional[str]]) -> None:
        from .types import restore_seen
        self.messages = list(snap["messages"])
        self.steps_taken = snap["stepsTaken"]
        self.corrective_used = snap["correctiveUsed"]
        self.chat_texts = list(snap["chatTexts"])
        self.timeline = list(snap["timeline"])
        self.trace = list(snap["trace"])
        self.stray = snap["stray"]
        self.wrote = snap["wrote"]
        self.effects = dict(snap["effects"])
        self.usage = dict(snap.get("usage") or self.usage)
        self.step_log = list(snap.get("stepLog") or [])
        self.guard_floor = int(snap.get("guardFloor") or 0)
        run = self.ctx.run
        restore_seen(run, snap["run"]["seen"], stored)
        run.created = set(snap["run"]["created"])
        run.snapshotted = set(snap["run"]["snapshotted"])
        run.read_ids = dict.fromkeys(snap["run"]["readIds"])
        run.reads = dict(snap["run"]["reads"])
        run.touched = {t["documentId"]: t for t in snap["run"]["touched"]}
        run.start_outline = snap["run"]["startOutline"]
        run.last_list = snap["run"]["lastList"]
        run.selection_attempted = snap["run"]["selectionAttempted"]
        run.selection_applied = snap["run"]["selectionApplied"]
        run.plan = list(snap["run"].get("plan") or [])
        run.question = snap["run"].get("question")
        self.plan_nudges = int(snap.get("planNudges") or 0)
        self.long_reasoning_due = snap.get("longReasoningDue")
        self.html_read_pending = snap.get("htmlReadPending")
        self.html_read_nudged = bool(snap.get("htmlReadNudged"))
        run.plan_baseline = dict(snap.get("planBaseline") or {})
        if snap.get("next"):
            self._next = {"messages": self.messages, "step": self.steps_taken, "final": snap.get("final", False)}
