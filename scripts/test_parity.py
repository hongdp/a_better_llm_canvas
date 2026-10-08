"""TypeScript ↔ Python parity (backend_authority.md phase 2).

scripts/parity/fixtures/*.json are written by src/parity/__tests__/parity.test.ts
from the TypeScript implementation. Each case here must reproduce its output
byte for byte. A failure means the port differs from the specification.
"""
import json
import os
import re

import pytest

from wc_text import (chapter_index, context_ledger, context_selection, diff, diff_resolution, document_tools, dynamic_context,
                     image_preservation, llm_context, paragraphs, pending_changes, polish, system_prompt, text)

FIXTURES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parity", "fixtures")


def normalize_diff_ids(html: str) -> str:
    seen = {}

    def sub(m):
        key = m.group(1)
        if key not in seen:
            seen[key] = f"diff-{len(seen) + 1}"
        return f'data-diff-id="{seen[key]}"'
    return re.sub(r'data-diff-id="([^"]*)"', sub, html)


def _replace_images(html, registry):
    out = image_preservation.replace_images_with_placeholders(html, registry)
    return {"html": out, "registry": registry}


def _plan_ledger(current, desired, docs, active, o=None):
    o = o or {}
    options = {}
    if o.get("render"):
        options["render"] = lambda doc_id, kind: f"[{kind}:{doc_id}]"
    if o.get("maxStaleChars") is not None:
        options["maxStaleChars"] = o["maxStaleChars"]
    return context_ledger.plan_ledger_turn(current, desired, docs, active, options)


def _volatile_tail(docs, active, selected, opts=None):
    registry = []
    return dynamic_context.build_volatile_tail(docs, active, selected, lambda h: image_preservation.replace_images_with_placeholders(h, registry), opts)


def _apply_locally(html, blocks):
    out = text.apply_edit_blocks_locally(html, blocks)
    return {**out, "html": normalize_diff_ids(out["html"])}


FUNCTIONS = {
    ("text", "strip_incomplete_end_tag"): text.strip_incomplete_end_tag,
    ("text", "chapter_attribute"): text.chapter_attribute,
    ("text", "new_chapter_attribute"): text.new_chapter_attribute,
    ("text", "extract_tagged_block"): text.extract_tagged_block,
    ("text", "has_elision_markers"): text.has_elision_markers,
    ("text", "validate_canvas_replacement"): text.validate_canvas_replacement,
    ("text", "parse_edit_blocks"): text.parse_edit_blocks,
    ("text", "strip_stray_document_markup"): text.strip_stray_document_markup,
    ("text", "parse_assistant_response"): text.parse_assistant_response,
    ("text", "apply_edit_blocks"): text.apply_edit_blocks,
    ("text", "apply_edit_blocks_locally"): _apply_locally,
    ("text", "strip_blank_paragraphs"): text.strip_blank_paragraphs,
    ("text", "count_words"): text.count_words,
    ("text", "parse_doc_status"): text.parse_doc_status,
    ("text", "strip_doc_status"): text.strip_doc_status,
    ("text", "detect_failed_document_update"): text.detect_failed_document_update,
    ("text", "trim_incomplete_html_tail"): text.trim_incomplete_html_tail,
    ("text", "is_blank_content"): text.is_blank_content,
    ("llm_context", "html_to_plain_text"): llm_context.html_to_plain_text,
    ("llm_context", "strip_chat_display_artifacts"): llm_context.strip_chat_display_artifacts,
    ("llm_context", "truncate_with_notice"): llm_context.truncate_with_notice,
    ("llm_context", "detect_referenced_doc_ids"): llm_context.detect_referenced_doc_ids,
    ("llm_context", "build_attachments_label"): llm_context.build_attachments_label,
    ("llm_context", "trim_history_for_context"): llm_context.trim_history_for_context,
    ("polish", "bare"): polish.bare,
    ("polish", "split_for_polish"): polish.split_for_polish,
    ("polish", "build_polish_prompt"): polish.build_polish_prompt,
    ("polish", "parse_polished"): polish.parse_polished,
    ("polish", "validate_polished"): polish.validate_polished,
    ("polish", "assemble_polished"): polish.assemble_polished,
    ("paragraphs", "block_text"): paragraphs.block_text,
    ("paragraphs", "top_level_blocks"): paragraphs.top_level_blocks,
    ("paragraphs", "chapter_paragraphs"): paragraphs.chapter_paragraphs,
    ("paragraphs", "chapter_chars"): paragraphs.chapter_chars,
    ("paragraphs", "numbered_line"): paragraphs.numbered_line,
    ("diff", "diff_html"): lambda a, b: normalize_diff_ids(diff.diff_html(a, b)),
    ("diff", "strip_diff_markup"): diff.strip_diff_markup,
    ("diff_resolution", "resolve_diff_markup_in_html"): diff_resolution.resolve_diff_markup_in_html,
    ("pending_changes", "pending_changes"): pending_changes.pending_changes,
    ("pending_changes", "render_pending_changes"): pending_changes.render_pending_changes,
    ("image_preservation", "replace_images_with_placeholders"): _replace_images,
    ("image_preservation", "restore_image_placeholders"): image_preservation.restore_image_placeholders,
    ("image_preservation", "reinsert_missing_images"): image_preservation.reinsert_missing_images,
    ("chapter_index", "get_chapter_digest"): chapter_index.get_chapter_digest,
    ("chapter_index", "build_chapter_index"): chapter_index.build_chapter_index,
    ("chapter_index", "extract_heading_tree"): chapter_index.extract_heading_tree,
    ("chapter_index", "pack_chapters_into_batches"): chapter_index.pack_chapters_into_batches,
    ("chapter_index", "whole_book_context_chars"): lambda: chapter_index.WHOLE_BOOK_CONTEXT_CHARS,
    ("dynamic_context", "render_ledger_chapter"): dynamic_context.render_ledger_chapter,
    ("dynamic_context", "ledger_block"): dynamic_context.ledger_block,
    ("dynamic_context", "build_ledger_messages"): dynamic_context.build_ledger_messages,
    ("dynamic_context", "build_volatile_tail"): _volatile_tail,
    ("context_ledger", "hash_content"): context_ledger.hash_content,
    ("context_ledger", "plan_ledger_turn"): _plan_ledger,
    ("context_ledger", "ledger_chapter_ids"): context_ledger.ledger_chapter_ids,
    ("context_ledger", "order_admissions_by_stability"): context_ledger.order_admissions_by_stability,
    ("context_selection", "extract_keywords"): context_selection.extract_keywords,
    ("context_selection", "select_reference_chapters"): context_selection.select_reference_chapters,
    ("system_prompt", "build_chat_system_prompt"): system_prompt.build_chat_system_prompt,
    ("document_tools", "document_tools"): lambda: document_tools.DOCUMENT_TOOLS,
    ("document_tools", "to_openai_tools"): document_tools.to_openai_tools,
    ("document_tools", "to_anthropic_tools"): document_tools.to_anthropic_tools,
    ("document_tools", "to_gemini_tools"): document_tools.to_gemini_tools,
    ("document_tools", "from_openai_tools"): document_tools.from_openai_tools,
}


def _cases():
    for name in sorted(os.listdir(FIXTURES)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
            fixture = json.load(fh)
        for fn, cases in fixture["cases"].items():
            for i, case in enumerate(cases):
                yield pytest.param(fixture["module"], fn, case, id=f"{fixture['module']}.{fn}[{i}]")


@pytest.mark.parametrize("module,fn,case", list(_cases()))
def test_python_matches_typescript(module, fn, case):
    impl = FUNCTIONS[(module, fn)]
    assert impl(*case["input"]) == case["output"]


def test_every_fixture_function_has_a_port():
    missing = []
    for name in os.listdir(FIXTURES):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
            fixture = json.load(fh)
        for fn in fixture["cases"]:
            if (fixture["module"], fn) not in FUNCTIONS:
                missing.append(f"{fixture['module']}.{fn}")
    assert missing == []
