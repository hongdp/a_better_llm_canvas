"""Port of src/agent/polish.ts and analyzeBook.ts — the model-call halves of
polish_chapter and analyze_book, over async transports."""
import asyncio
from typing import Any, Awaitable, Callable, Dict, List, Optional

from wc_text.chapter_index import pack_chapters_into_batches
from wc_text.jsstr import js_trim
from wc_text.llm_context import html_to_plain_text, truncate_with_notice
from wc_text.polish import assemble_polished, build_polish_prompt, parse_polished, split_for_polish, validate_polished

Transport = Callable[[str, str], Awaitable[str]]


def default_polish_model(provider: str, chat_model: str) -> str:
    return "grok-4.20-0309-reasoning" if provider == "grok" else chat_model


async def polish_html(html: str, transport: Transport, prompt: Dict[str, str], writing_preset: Optional[str] = None,
                      stopped: Optional[asyncio.Event] = None, on_progress: Optional[Callable[[int, int], None]] = None) -> Dict[str, Any]:
    segments = split_for_polish(html)
    chunks = [s["paras"] for s in segments if s["kind"] == "chunk"]
    system = f"{prompt['system']}\n\n{js_trim(writing_preset)}" if writing_preset and js_trim(writing_preset) else prompt["system"]
    done = 0
    if on_progress:
        on_progress(0, len(chunks))

    async def one(i: int, chunk: List[str]) -> Dict[str, Any]:
        nonlocal done
        try:
            if stopped is not None and stopped.is_set():
                return {"rewrite": None, "why": "stopped"}
            reply = await transport(system, build_polish_prompt(prompt["template"], chunk, chunks[i - 1] if i > 0 else None))
            rewrite = parse_polished(reply)
            check = validate_polished(chunk, rewrite)
            return {"rewrite": rewrite, "why": None} if check["ok"] else {"rewrite": None, "why": ", ".join(check["reasons"])}
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 — a failed chunk keeps its draft
            return {"rewrite": None, "why": "stopped" if stopped is not None and stopped.is_set() else f"failed: {e}"}
        finally:
            done += 1
            if on_progress:
                on_progress(done, len(chunks))

    results = await asyncio.gather(*(one(i, c) for i, c in enumerate(chunks)))
    return {
        "html": assemble_polished(segments, [r["rewrite"] for r in results]),
        "chunks": len(chunks),
        "polished": sum(1 for r in results if r["rewrite"] is not None),
        "kept": [f"chunk {i + 1}: {r['why']}" for i, r in enumerate(results) if r["why"]],
        "stopped": bool(stopped is not None and stopped.is_set()),
    }


ANALYZE_SYSTEM = ("You are analyzing a book chapter-by-chapter in batches to complete a task. Each round you receive your running notes and a new batch of chapters. "
                  "Update and extend the notes with everything from this batch that matters for the task (structure, plot, entities, facts, quotes). "
                  "Output ONLY the updated complete notes as plain text. Do NOT produce a final answer.")


async def analyze_in_batches(task: str, chapters: List[Dict[str, str]], budget_chars: int, transport: Transport,
                             stopped: Optional[asyncio.Event] = None, on_progress: Optional[Callable[[int, int], None]] = None) -> Dict[str, Any]:
    batches = pack_chapters_into_batches(chapters, budget_chars)
    notes = ""
    for i, batch in enumerate(batches):
        if stopped is not None and stopped.is_set():
            return {"notes": notes, "batches": i, "total": len(batches), "stopped": True}
        if on_progress:
            on_progress(i, len(batches))
        text = "\n\n".join(f"--- DOCUMENT: {c['title']} ---\n{truncate_with_notice(html_to_plain_text(c['content']), budget_chars)}" for c in batch)
        user = (f"TASK (do not answer it — only update the notes):\n{task}\n\n"
                f"RUNNING NOTES (from previous batches):\n{notes or '(none yet — this is the first batch)'}\n\n"
                f"NEW CHAPTERS (batch {i + 1} of {len(batches)}):\n{text}")
        try:
            reply = js_trim(await transport(ANALYZE_SYSTEM, user))
            if reply:
                notes = reply
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            if stopped is not None and stopped.is_set():
                return {"notes": notes, "batches": i, "total": len(batches), "stopped": True}
            return {"notes": notes, "batches": i, "total": len(batches), "stopped": False, "failed": str(e)}
    if on_progress:
        on_progress(len(batches), len(batches))
    return {"notes": notes, "batches": len(batches), "total": len(batches), "stopped": False}
