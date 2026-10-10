"""Attachments and web access (docs/features/attachments_and_web.md):
storage and endpoints, the tools over an attached novel (section reads, grep,
analyze, the per-turn cap), the web tools on a fake browser, the pure parts
of server_web, and a server run that reads an attachment."""
import asyncio
import json
from typing import Any, Dict, List

import pytest

import server_attachments
import server_generation
import server_runs
import server_web
from test_agent import FakeBook, run_tool
from test_runs import Scripted, book, request, settle  # noqa: F401 — `book` is a fixture
from wc_agent.tools.analyze_book import ATTACHMENT_CHUNK_CHARS, analyze_book_tool
from wc_agent.tools.book_reads import grep_tool, read_chapter_tool
from wc_agent.tools.web import web_read_tool, web_search_tool
from wc_text.attachments import ATTACHMENT_RUN_READ_CAP, attachment_paragraphs, attachment_sections
from wc_text.web_text import UNTRUSTED_WEB_NOTE

CN = "零一二三四五六七八九"


def cn_number(n: int) -> str:
    """1..99 in Chinese numerals, as novel headings write them."""
    if n < 10:
        return CN[n]
    tens, ones = divmod(n, 10)
    return f"{'' if tens == 1 else CN[tens]}十{CN[ones] if ones else ''}"


def novel(chapters: int = 40, paragraphs: int = 50, width: int = 100) -> str:
    """A long novel in the shape of a downloaded .txt: headings, then indented paragraphs."""
    out: List[str] = []
    for c in range(1, chapters + 1):
        out.append(f"第{cn_number(c)}章 第{c}回的故事")
        for p in range(1, paragraphs + 1):
            body = f"〔{c}-{p}〕" + ("林动" if p == 7 else "") + "字" * width
            out.append("　　" + body[:width])
    return "\n".join(out)


class FakeAttachments:
    def __init__(self, items: Dict[str, str]) -> None:
        self.texts = {f"att-{i + 1}": t for i, t in enumerate(items.values())}
        self.meta = []
        for i, (name, text) in enumerate(items.items()):
            paras = attachment_paragraphs(text)
            self.meta.append({"id": f"att-{i + 1}", "ref": f"A{i + 1}", "name": name, "chars": sum(len(p) for p in paras),
                              "paragraphs": len(paras), "sections": attachment_sections(paras)})
        self.reads: List[str] = []

    def list(self):
        return self.meta

    async def paragraphs(self, attachment_id):
        self.reads.append(attachment_id)
        return attachment_paragraphs(self.texts[attachment_id])


def book_with_novel() -> FakeBook:
    fake = FakeBook("<p>start</p>", chapters=[{"id": "doc-2", "title": "第二章", "content": "<p>林动出场。</p>"}])
    fake.ctx.attachments = FakeAttachments({"万倍返还.txt": novel()})
    return fake


# ── reading an attachment ─────────────────────────────────────────────────────

def test_a_section_is_read_by_its_heading_in_either_numeral():
    fake = book_with_novel()
    by_chinese = run_tool(read_chapter_tool, {"chapters": ["A1"], "section": "第三十章"}, fake.ctx)
    assert by_chinese["ok"], by_chinese["content"]
    assert "〔30-1〕" in by_chinese["content"] and "〔31-" not in by_chinese["content"]
    assert by_chinese["trace"].startswith('📖 read A1 "万倍返还.txt" ¶')
    by_digits = run_tool(read_chapter_tool, {"chapters": ["附件1"], "section": "第30章"}, book_with_novel().ctx)
    assert by_digits["content"] == by_chinese["content"]


def test_an_unknown_section_names_the_ones_there_are():
    out = run_tool(read_chapter_tool, {"chapters": ["A1"], "section": "第九十九章"}, book_with_novel().ctx)
    assert not out["ok"]
    assert 'has no section matching "第九十九章"' in out["content"] and '"第一章 第1回的故事"' in out["content"]


def test_section_on_a_chapter_is_refused():
    out = run_tool(read_chapter_tool, {"chapters": ["2"], "section": "第一章"}, book_with_novel().ctx)
    assert not out["ok"] and "names a part of an attachment" in out["content"]


def test_a_whole_attachment_is_never_read_in_one_go_and_the_turn_is_capped():
    fake = book_with_novel()
    total = fake.ctx.attachments.meta[0]["chars"]
    assert total > 2 * ATTACHMENT_RUN_READ_CAP / 1.5  # the novel is bigger than what one turn may read
    seen = 0
    start = 1
    for _ in range(20):
        out = run_tool(read_chapter_tool, {"chapters": ["A1"], "paragraphs": f"{start}-"}, fake.ctx)
        if not out["ok"]:
            break
        body = out["content"]
        assert len(body) < 21_000  # one read is one part, never the file
        last = max(int(line[1:].split(" ")[0]) for line in body.splitlines() if line.startswith("¶"))
        start = last + 1
        seen = fake.ctx.run.attachment_chars
    assert seen <= ATTACHMENT_RUN_READ_CAP
    assert not out["ok"] and "never read into the conversation" in out["content"] and 'grep chapters=["A1"]' in out["content"]


def test_grep_searches_an_attachment_only_when_named():
    fake = book_with_novel()
    named = run_tool(grep_tool, {"pattern": "林动", "chapters": ["A1"], "max_results": 3}, fake.ctx)
    assert "40 match(es) in 1 chapter(s) in 1 chapter(s); showing the first 3:" in named["content"]
    assert 'A1 "万倍返还.txt" ¶8: ' in named["content"]
    assert named["trace"].startswith("🔎 grep /林动/ in A1 → 40 matches")
    whole_book = run_tool(grep_tool, {"pattern": "林动"}, fake.ctx)
    assert "A1" not in whole_book["content"] and '#2 "第二章" ¶1' in whole_book["content"]


def test_an_attachment_name_resolves_but_a_chapter_wins():
    fake = book_with_novel()
    out = run_tool(read_chapter_tool, {"chapters": ["万倍返还.txt"], "paragraphs": "1-2"}, fake.ctx)
    assert out["ok"] and "=== A1" in out["content"]
    out = run_tool(read_chapter_tool, {"chapters": ["第二章"]}, fake.ctx)
    assert "林动出场" in out["content"]


def test_analyze_book_reads_an_attachment_in_chunks_outside_the_conversation():
    fake = book_with_novel()
    seen: List[Dict[str, Any]] = []

    class Analyze:
        async def run(self, task, chapters, on_progress):
            seen.extend(chapters)
            return {"notes": "林动在每一章都出现。", "batches": 2, "total": 2}

    fake.ctx.analyze = Analyze()
    out = run_tool(analyze_book_tool, {"task": "林动的经历", "chapters": ["A1"]}, fake.ctx)
    assert out["ok"] and "林动在每一章都出现" in out["content"]
    assert len(seen) == 40 and seen[0]["title"].startswith('A1 "万倍返还.txt" — 第一章')
    assert all(len(c["content"]) <= ATTACHMENT_CHUNK_CHARS for c in seen)
    assert fake.ctx.run.attachment_chars == 0  # nothing of the file entered the conversation
    assert "A1" in out["trace"]


# ── web tools ─────────────────────────────────────────────────────────────────

class FakeWeb:
    def __init__(self, fail: str = "") -> None:
        self.fail = fail
        self.calls: List[Any] = []

    async def search(self, query, max_results):
        self.calls.append(("search", query, max_results))
        if self.fail:
            raise server_web.WebError(self.fail)
        return [{"title": "万倍返还 - 百科", "url": "https://example.org/wanbei", "snippet": "一部网络小说。"}]

    async def read(self, url):
        self.calls.append(("read", url))
        if self.fail:
            raise server_web.WebError(self.fail)
        return {"url": url, "title": "页面", "paragraphs": [f"第{i}段" for i in range(1, 31)]}


def test_web_tools_are_offered_only_with_a_browser():
    fake = book_with_novel()
    assert not web_search_tool.is_available(fake.ctx) and not web_read_tool.is_available(fake.ctx)
    fake.ctx.web = FakeWeb()
    assert web_search_tool.is_available(fake.ctx) and web_read_tool.is_available(fake.ctx)


def test_web_search_and_read_render_text_marked_untrusted():
    fake = book_with_novel()
    fake.ctx.web = FakeWeb()
    out = run_tool(web_search_tool, {"query": "万倍返还 小说", "max_results": 50}, fake.ctx)
    assert out["ok"] and UNTRUSTED_WEB_NOTE in out["content"] and "https://example.org/wanbei" in out["content"]
    assert fake.ctx.web.calls[0] == ("search", "万倍返还 小说", 10)
    assert out["trace"] == '🌐 search "万倍返还 小说" → 1 result'
    page = run_tool(web_read_tool, {"url": "https://example.org/wanbei", "paragraphs": "5-6"}, fake.ctx)
    assert page["ok"] and "¶5 第5段\n¶6 第6段" in page["content"] and "¶7" not in page["content"]
    assert page["trace"] == "🌐 read example.org ¶5–6 (0.0k)"


def test_a_web_failure_reaches_the_model_as_a_reason():
    fake = book_with_novel()
    fake.ctx.web = FakeWeb(fail="The search engine answered with a bot check; it was not bypassed.")
    out = run_tool(web_search_tool, {"query": "x"}, fake.ctx)
    assert not out["ok"] and "bot check" in out["content"] and out.get("retryable") is False


# ── server_web pure parts ─────────────────────────────────────────────────────

@pytest.mark.parametrize("ip,blocked", [("127.0.0.1", True), ("192.168.0.110", True), ("10.1.2.3", True), ("169.254.169.254", True),
                                        ("::1", True), ("0.0.0.0", True), ("8.8.8.8", False), ("2606:4700::1111", False)])
def test_private_and_local_addresses_are_blocked(ip, blocked):
    assert server_web.is_blocked_address(ip) is blocked


def test_the_user_agent_is_chromiums_own_without_headless():
    ua = server_web.chromium_user_agent("140.0.7339.16")
    assert "Chrome/140.0.0.0" in ua and "Headless" not in ua and "X11; Linux x86_64" in ua


def test_readable_paragraphs_drop_navigation_and_scripts():
    pytest.importorskip("bs4")
    html = """<html><head><title> 万倍返还 </title><script>var x=1</script></head><body>
      <nav><a href="/">首页</a><a href="/a">分类</a></nav>
      <h1>第一章</h1><p>林动睁开眼。</p><p>天亮了。</p><div><p>他起身。</p></div>
      <footer>版权所有</footer></body></html>"""
    title, paras = server_web.readable_paragraphs(html)
    assert title == "万倍返还"
    assert paras == ["# 第一章", "林动睁开眼。", "天亮了。", "他起身。"]


LITE_HTML = """<html><body><table>
<tr class="result-sponsored"><td><a class="result-link" href="https://ads.example/x">Ad</a></td></tr>
<tr class="result-sponsored"><td class="result-snippet">buy now</td></tr>
<tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fbook&rut=1">万倍返还 小说</a></td></tr>
<tr><td class="result-snippet">  一部 网络小说  </td></tr>
<tr><td><a class="result-link" href="https://example.com/b">第二个</a></td></tr>
<tr><td class="result-snippet">second</td></tr>
</table></body></html>"""


def test_search_results_are_parsed_with_ads_skipped_and_redirects_unwrapped():
    pytest.importorskip("bs4")
    results = server_web.parse_search_results(LITE_HTML, 8)
    assert results == [{"title": "万倍返还 小说", "url": "https://example.org/book", "snippet": "一部 网络小说"},
                       {"title": "第二个", "url": "https://example.com/b", "snippet": "second"}]
    assert len(server_web.parse_search_results(LITE_HTML, 1)) == 1


def test_a_bot_check_is_recognized():
    assert server_web.is_challenge_page('<div class="anomaly-modal">x</div>')
    assert not server_web.is_challenge_page(LITE_HTML)


# ── storage and endpoints ─────────────────────────────────────────────────────

def test_decode_text_handles_the_encodings_novels_come_in():
    text = "第一章 开端\n　　林动睁开眼。"
    assert server_attachments.decode_text(text.encode("utf-8")) == text
    assert server_attachments.decode_text(b"\xef\xbb\xbf" + text.encode("utf-8")) == text
    assert server_attachments.decode_text(text.encode("gb18030")) == text
    assert server_attachments.decode_text("第一章 開端\n　　林動睜開眼。".encode("big5")) == "第一章 開端\n　　林動睜開眼。"


def test_upload_list_read_and_delete_through_the_endpoints(book):  # noqa: F811
    from fastapi.testclient import TestClient
    import api_server

    client = TestClient(api_server.app)
    client.cookies.update({"web_canvas_session": "sess-1", "csrf_token": "tok-1"})
    headers = {"x-csrf-token": "tok-1", "content-type": "application/octet-stream"}
    raw = novel(3, 4, 20).encode("gb18030")
    res = client.post("/api/books/book-1/attachments?name=万倍返还.txt", content=raw, headers=headers)
    assert res.status_code == 200, res.text
    meta = res.json()["attachment"]
    assert meta["ref"] == "A1" and meta["name"] == "万倍返还.txt" and meta["paragraphs"] == 15 and len(meta["sections"]) == 3

    second = client.post("/api/books/book-1/attachments?name=notes.md", content="# 设定\n\n林动：主角".encode(), headers=headers).json()["attachment"]
    assert second["ref"] == "A2"
    listed = client.get("/api/books/book-1/attachments").json()["attachments"]
    assert [a["ref"] for a in listed] == ["A1", "A2"]

    text = client.get(f"/api/books/book-1/attachments/{meta['id']}/text").json()["text"]
    assert text.startswith("第一章 第1回的故事") and len(attachment_paragraphs(text)) == 15

    assert client.post("/api/books/book-1/attachments?name=x.pdf", content=b"%PDF", headers=headers).status_code == 400
    assert client.post("/api/books/nope/attachments?name=x.txt", content=b"abc", headers=headers).status_code == 404
    assert client.post("/api/books/book-1/attachments?name=x.txt", content=b"  \n", headers=headers).status_code == 400

    assert client.delete(f"/api/books/book-1/attachments/{meta['id']}", headers={"x-csrf-token": "tok-1"}).status_code == 200
    listed = client.get("/api/books/book-1/attachments").json()["attachments"]
    assert [(a["ref"], a["name"]) for a in listed] == [("A1", "notes.md")]
    assert client.get(f"/api/books/book-1/attachments/{meta['id']}/text").status_code == 404


# ── a server run ──────────────────────────────────────────────────────────────

def test_a_server_run_lists_and_reads_an_attachment_but_never_sends_it_whole(book, monkeypatch):  # noqa: F811
    server_attachments.store_attachment("alice", "book-1", "万倍返还.txt", novel().encode("utf-8"))
    monkeypatch.setattr(server_web, "available", lambda: False)
    provider = Scripted([
        {"text": "", "calls": [("c1", "read_chapter", json.dumps({"chapters": ["A1"], "section": "第三十章"}, ensure_ascii=False))]},
        "第三十章讲的是第30回的故事。\n<doc_status>unchanged</doc_status>",
    ])
    monkeypatch.setattr(server_generation, "_dispatch_provider", provider)

    async def main():
        run = book.submit("alice", "book-1", request("第三十章讲了什么？"))
        await settle(run)
        return run
    run = asyncio.run(main())
    assert run.status == "done", run.error
    first = provider.requests[0]
    last_user = first["messages"][-1]["content"]
    assert 'ATTACHMENTS' in last_user and 'A1 "万倍返还.txt"' in last_user
    whole = json.dumps(first["messages"], ensure_ascii=False)
    assert "〔30-1〕" not in whole and len(whole) < 60_000
    tools = [t.get("name") or t.get("function", {}).get("name") for t in (first["config"].get("tools") or [])]
    assert "read_chapter" in tools and "web_search" not in tools
    second = json.dumps(provider.requests[1]["messages"], ensure_ascii=False)
    assert "〔30-1〕" in second and "〔31-1〕" not in second


# ── analyze_book on part of an attachment, and what it costs (run-737f3d809b45) ──

class _AnalyzeSpy:
    def __init__(self, plan=None):
        self.seen = []
        self._plan = plan

    async def run(self, task, chapters, on_progress):
        self.seen.extend(chapters)
        return {"notes": "笔记。", "batches": 1, "total": 1, "stopped": False}


class _AnalyzeSpyWithPlan(_AnalyzeSpy):
    def plan(self, task, chapters):
        return self._plan


def test_analyze_reads_only_the_sections_or_paragraphs_named():
    fake = book_with_novel()
    spy = _AnalyzeSpy()
    fake.ctx.analyze = spy
    out = run_tool(analyze_book_tool, {"task": "t", "chapters": ["A1"], "section": "第十–十二章"}, fake.ctx)
    assert out["ok"] and "A1 第十–十二章" in out["trace"]
    assert [c["title"].split(" — ")[1].split(" (")[0] for c in spy.seen] == ["第十章 第10回的故事", "第十一章 第11回的故事", "第十二章 第12回的故事"]
    spy2 = _AnalyzeSpy()
    fake.ctx.analyze = spy2
    out = run_tool(analyze_book_tool, {"task": "t", "chapters": ["A1"], "paragraphs": "52-102"}, fake.ctx)
    text = "\n".join(c["content"] for c in spy2.seen)
    assert out["ok"] and "A1 ¶52–102" in out["trace"] and "〔2-1〕" in text and "〔1-50〕" not in text and "〔3-1〕" not in text
    assert "has no section matching" in run_tool(analyze_book_tool, {"task": "t", "chapters": ["A1"], "section": "第九十九章"}, fake.ctx)["content"]
    assert "pick a part of an attachment" in run_tool(analyze_book_tool, {"task": "t", "chapters": ["2"], "section": "第一章"}, fake.ctx)["content"]


def test_analyze_asks_first_past_the_token_line():
    fake = book_with_novel()
    spy = _AnalyzeSpyWithPlan({"calls": 11, "inputTokens": 1_500_000, "batchChars": 140_000})
    fake.ctx.analyze = spy
    first = run_tool(analyze_book_tool, {"task": "t", "chapters": ["A1"]}, fake.ctx)
    assert not first["ok"] and "1500000 input tokens in 11 model calls" in first["content"] and "ask_user" in first["content"]
    assert first["trace"] == "📚 analyze_book: A1 ≈ 1500k tokens in 11 calls — asks first" and spy.seen == []
    assert run_tool(analyze_book_tool, {"task": "t", "chapters": ["A1"], "confirmed": True}, fake.ctx)["ok"] and spy.seen


def test_batches_stay_under_groks_price_line_for_chinese_text():
    from wc_agent.polish import ANALYZE_CONFIRM_TOKENS, plan_analysis
    chapters = [{"id": f"c{i}", "title": f"第{i}章", "content": "字" * 100_000} for i in range(20)]
    plan = plan_analysis("t", chapters, "grok")
    assert plan["batchChars"] == 140_000 and plan["calls"] == 20
    assert plan["inputTokens"] > ANALYZE_CONFIRM_TOKENS and plan["inputTokens"] / plan["calls"] < 200_000
