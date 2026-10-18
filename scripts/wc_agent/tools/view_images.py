"""view_images: the agent looks at the pictures in a chapter (2026-10-18).

Problem: a chapter's photos reached the model only as "[image]" in a text
  read (or a placeholder token in an HTML one), so writing around them — a
  caption, a scene a photo illustrates, a description of what it shows —
  meant guessing. "处女老婆被别人开苞" is one chapter with 20 photos between its
  paragraphs, linked from another site.
Fix: a read tool that sends a chapter's images to the model itself, shrunk
  (server_web.view_images), on the tool's result message as `images` — each
  provider renders them its own way (wc_providers). Offered only to a model
  that takes image input (`supports_vision`); at most VIEW_PER_CALL per call
  and VIEW_PER_RUN per run, since every image costs about a thousand tokens
  each step it stays in the conversation.
"""
import re
from typing import Any, Dict, List, Optional, Union

from wc_text.chapters import cite_chapter
from wc_text.diff import strip_diff_markup
from wc_text.paragraphs import block_images, chapter_paragraphs

from ..registry import Tool
from ..types import ToolContext, result
from .book_reads import _parse_range
from .document_writes import resolve_target, with_loaded

VIEW_PER_CALL = 6
VIEW_PER_RUN = 30
_SRC_RE = re.compile(r"""\bsrc\s*=\s*("([^"]*)"|'([^']*)')""", re.I)

#: Providers whose chat models take image input; a local or unknown model is offered no view_images.
_VISION_PROVIDERS = {"anthropic", "openai", "grok", "gemini"}


def supports_vision(provider: str, model: str) -> bool:
    """Whether a run's model can be shown images (view_images is offered only then)."""
    if provider not in _VISION_PROVIDERS:
        return False
    # The few text-only names those providers still serve.
    return not re.search(r"(^|[-_])(mini-tts|embedding|audio|realtime|transcribe)([-_]|$)", model or "", re.I)


def chapter_images(html: str) -> List[Dict[str, Any]]:
    """Every <img> of a chapter's accepted reading in order: its number, the ¶ it sits in (as `read` numbers them), its src."""
    out: List[Dict[str, Any]] = []
    for p in chapter_paragraphs(strip_diff_markup(html)):
        for tag in block_images(p["html"]):
            m = _SRC_RE.search(tag)
            src = (m.group(2) if m.group(2) is not None else m.group(3)) if m else ""
            if src:
                out.append({"n": len(out) + 1, "paragraph": p["number"], "src": src})
    return out


def _parse(raw: Optional[Dict[str, Any]]) -> Union[Dict[str, Any], str]:
    raw = raw or {}
    rng = _parse_range(raw.get("paragraphs"))
    if isinstance(rng, str):
        return rng
    wanted = raw.get("images")
    if isinstance(wanted, (int, float)) and not isinstance(wanted, bool):
        wanted = [wanted]
    elif isinstance(wanted, str) and wanted.strip():
        wanted = [w for w in re.split(r"[\s,，、]+", wanted.strip()) if w]
    numbers: Optional[List[int]] = None
    if isinstance(wanted, list) and wanted:
        try:
            numbers = [int(n) for n in wanted]
        except (TypeError, ValueError):
            return "images must be image numbers, like [1, 2, 3]"
    return {"chapter": raw.get("chapter"), "range": rng, "numbers": numbers}


async def _execute(args: Dict[str, Any], ctx: ToolContext, call: Dict[str, Any]) -> Dict[str, Any]:
    target = resolve_target(args["chapter"], ctx)
    if isinstance(target, str):
        return result(False, target, f"⚠️ view_images: {target.splitlines()[0]}", retryable=True)

    async def body() -> Dict[str, Any]:
        html = next((c["content"] for c in ctx.document.chapters() if c["id"] == target["id"]), "")
        images = chapter_images(html)
        cite = cite_chapter(target)
        if not images:
            return result(False, f"{cite} has no images.", f"🖼️ {cite}: no images", retryable=False)
        rng = args["range"]
        chosen = images
        if rng:
            chosen = [i for i in chosen if i["paragraph"] >= rng["from"] and (rng["to"] is None or i["paragraph"] <= rng["to"])]
        if args["numbers"]:
            by_n = {i["n"]: i for i in images}
            missing = [n for n in args["numbers"] if n not in by_n]
            if missing:
                return result(False, f"{cite} has {len(images)} images; there is no image {', '.join(map(str, missing))}.",
                              f"⚠️ view_images: no image {missing[0]} in {cite}", retryable=True)
            chosen = [by_n[n] for n in args["numbers"] if not rng or by_n[n] in chosen]
        if not chosen:
            return result(False, f"{cite} has no images in those paragraphs. Its images are in ¶"
                          + ", ¶".join(str(p) for p in sorted({i["paragraph"] for i in images})) + ".",
                          f"🖼️ {cite}: no images there", retryable=True)
        left = VIEW_PER_RUN - ctx.run.images_viewed
        if left <= 0:
            return result(False, f"This turn has already been shown {VIEW_PER_RUN} images, the most one turn may see. Work from what you have seen.",
                          "⛔ view_images: the turn's image limit is reached", retryable=False)
        shown_now = chosen[:min(VIEW_PER_CALL, left)]
        fetched = await ctx.vision.view([i["src"] for i in shown_now])
        shown: List[str] = []
        lines: List[str] = []
        for img, got in zip(shown_now, fetched):
            if got.get("dataUrl"):
                shown.append(got["dataUrl"])
                lines.append(f"[Image {len(shown)}] = image {img['n']} of {len(images)}, in ¶{img['paragraph']}")
            else:
                lines.append(f"image {img['n']} (¶{img['paragraph']}): not shown — {got.get('error') or 'it could not be fetched'}")
        ctx.run.images_viewed += len(shown)
        rest = [i for i in chosen if i not in shown_now]
        more = (f" {len(rest)} more of those are not shown: ask for them with images=[{', '.join(str(i['n']) for i in rest[:VIEW_PER_CALL])}]." if rest else "")
        head = (f"{cite} has {len(images)} images. "
                + (f"Shown below, in this order:" if shown else "None of the requested images could be shown:"))
        content = head + "\n" + "\n".join(lines) + more
        nums = [str(i["n"]) for i, g in zip(shown_now, fetched) if g.get("dataUrl")]
        out = result(bool(shown), content,
                     f"🖼️ viewed {len(shown)} image{'' if len(shown) == 1 else 's'} of {cite}" + (f" (#{', #'.join(nums)})" if nums else ""),
                     retryable=False)
        if shown:
            out["images"] = shown
        return out

    return await with_loaded(ctx, target, body)


view_images_tool = Tool(
    name="view_images",
    description=("Look at the pictures in a chapter: they are sent to you as images, in order. A text read shows a picture only as [image]; "
                 "use this when what you write depends on what a picture shows (describing it, writing the scene it illustrates, a caption). "
                 f"Pick them by paragraph (the ¶ numbers of a read) or by their number in the chapter; at most {VIEW_PER_CALL} per call, {VIEW_PER_RUN} per turn — "
                 "each image costs about a thousand tokens, so look only at the ones you need."),
    parameters={"type": "object", "properties": {
        "chapter": {"type": "string", "description": "Optional. Its number in the CHAPTER INDEX or its exact title; omit for the active chapter."},
        "paragraphs": {"type": "string", "description": 'Optional. The images in these paragraphs, like "12-30" or "45".'},
        "images": {"type": "array", "items": {"type": "integer"}, "description": "Optional. Images by their number in the chapter (1 = its first image)."},
    }},
    kind="read", is_available=lambda ctx: getattr(ctx, "vision", None) is not None, parse=_parse, execute=_execute,
)
