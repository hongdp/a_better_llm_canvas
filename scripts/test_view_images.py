"""view_images (2026-10-18): the agent looks at a chapter's pictures — the tool on a fake book,
the four wire formats carrying a result's images, and the compaction weighing them."""
import asyncio

from test_agent import FakeBook, run_tool
from wc_agent.tools.view_images import VIEW_PER_CALL, VIEW_PER_RUN, chapter_images, supports_vision, view_images_tool
from wc_providers.anthropic import build_anthropic_request
from wc_providers.gemini import build_gemini_request
from wc_providers.openai_compat import build_openai_request
from wc_providers.responses import build_responses_request
from wc_text.run_compaction import IMAGE_TOKENS, plan_elisions, prompt_tokens

PHOTO = "data:image/jpeg;base64,QUJD"


class FakeVision:
    def __init__(self, fail=()):
        self.asked = []
        self.fail = set(fail)

    async def view(self, srcs):
        self.asked.append(list(srcs))
        return [{"error": "HTTP 404"} if s in self.fail else {"dataUrl": f"data:image/jpeg;base64,{s[-1]}"} for s in srcs]


def _book(n_images=3, fail=()):
    body = "<h1>第一章</h1><p>她推开门。</p>" + "".join(f'<p><img src="https://pics.example/{i}"></p><p>第{i}段。</p>' for i in range(1, n_images + 1))
    fake = FakeBook(body)
    fake.ctx.vision = FakeVision(fail)
    return fake


def test_chapter_images_are_numbered_with_the_paragraph_a_read_shows():
    html = '<p>a</p><p><img src="x1"></p><p>b <img src=\'x2\'></p><p><ins class="diff-addition" data-diff-id="d">new</ins></p>'
    assert chapter_images(html) == [{"n": 1, "paragraph": 2, "src": "x1"}, {"n": 2, "paragraph": 3, "src": "x2"}]


def test_viewing_sends_the_pictures_on_the_result_in_order():
    fake = _book(3)
    out = run_tool(view_images_tool, {}, fake.ctx)
    assert out["ok"] and out["images"] == ["data:image/jpeg;base64,1", "data:image/jpeg;base64,2", "data:image/jpeg;base64,3"]
    assert "has 3 images" in out["content"] and "[Image 2] = image 2 of 3, in ¶5" in out["content"]
    assert out["trace"] == '🖼️ viewed 3 images of #1 "Chapter 1" (#1, #2, #3)'


def test_pictures_are_chosen_by_paragraph_or_by_number_and_failures_are_named():
    fake = _book(4, fail=("https://pics.example/3",))
    out = run_tool(view_images_tool, {"paragraphs": "5-7"}, fake.ctx)
    assert fake.ctx.vision.asked[-1] == ["https://pics.example/2", "https://pics.example/3"]
    assert len(out["images"]) == 1 and "image 3 (¶7): not shown — HTTP 404" in out["content"]
    out = run_tool(view_images_tool, {"images": [4]}, fake.ctx)
    assert fake.ctx.vision.asked[-1] == ["https://pics.example/4"]
    out = run_tool(view_images_tool, {"images": [9]}, fake.ctx)
    assert out["ok"] is False and "there is no image 9" in out["content"]
    out = run_tool(view_images_tool, {"paragraphs": "1-2"}, fake.ctx)
    assert out["ok"] is False and "Its images are in ¶3, ¶5, ¶7, ¶9" in out["content"]


def test_a_call_and_a_turn_are_capped():
    fake = _book(VIEW_PER_CALL + 2)
    out = run_tool(view_images_tool, {}, fake.ctx)
    assert len(out["images"]) == VIEW_PER_CALL and "2 more of those are not shown" in out["content"]
    fake.ctx.run.images_viewed = VIEW_PER_RUN
    out = run_tool(view_images_tool, {"images": [7]}, fake.ctx)
    assert out["ok"] is False and "image limit" in out["trace"]


def test_a_chapter_without_pictures_says_so_and_the_tool_needs_a_vision_model():
    fake = FakeBook("<p>只有文字。</p>")
    assert not view_images_tool.is_available(fake.ctx)
    fake.ctx.vision = FakeVision()
    assert view_images_tool.is_available(fake.ctx)
    assert run_tool(view_images_tool, {}, fake.ctx)["content"] == '#1 "Chapter 1" has no images.'
    assert supports_vision("anthropic", "claude-opus-5-5") and supports_vision("grok", "grok-4.6")
    assert not supports_vision("ollama", "qwen3:14b") and not supports_vision("moonshot", "kimi-k3")


# ── the wire formats ─────────────────────────────────────────────────────────

CALL = {"role": "assistant", "content": "", "toolCalls": [{"id": "c1", "name": "view_images", "argumentsText": "{}"}]}
RESULT = {"role": "tool", "toolCallId": "c1", "name": "view_images", "content": "Shown below", "images": [PHOTO]}
TURN = [{"role": "system", "content": "sys"}, {"role": "user", "content": "看图"}, CALL, RESULT, {"role": "user", "content": "next"}]


def test_anthropic_puts_the_pictures_inside_the_tool_result():
    _, _, body = build_anthropic_request({"apiKey": "k", "model": "claude-sonnet-5-5"}, TURN)
    block = body["messages"][2]["content"][0]
    assert block["type"] == "tool_result" and block["content"][0] == {"type": "text", "text": "Shown below"}
    assert block["content"][2] == {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"}}


def test_responses_follow_the_outputs_with_a_user_message_of_pictures():
    _, _, body = build_responses_request({"apiKey": "k", "model": "grok-4.6", "baseUrl": "https://api.x.ai/v1"}, TURN)
    kinds = [i.get("type") or i.get("role") for i in body["input"]]
    assert kinds == ["system", "user", "function_call", "function_call_output", "user", "user"]
    assert body["input"][4]["content"][1] == {"type": "input_image", "image_url": PHOTO}


def test_gemini_puts_the_pictures_after_the_function_responses():
    _, _, body = build_gemini_request({"apiKey": "k", "model": "gemini-4-argon", "baseUrl": "https://g"}, TURN)
    parts = body["contents"][2]["parts"]
    assert "functionResponse" in parts[0] and parts[2] == {"inlineData": {"mimeType": "image/jpeg", "data": "QUJD"}}


def test_chat_completions_follow_the_tool_messages_with_a_user_message_of_pictures():
    _, _, body = build_openai_request({"apiKey": "k", "model": "m", "baseUrl": "https://x"}, TURN, "openai")
    roles = [m["role"] for m in body["messages"]]
    assert roles == ["system", "user", "assistant", "tool", "user", "user"]
    assert body["messages"][4]["content"][1] == {"type": "image_url", "image_url": {"url": PHOTO}}


def test_compaction_weighs_pictures_and_drops_them_with_an_elided_result():
    messages = [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}, CALL, RESULT, CALL, {**RESULT, "toolCallId": "c2"}]
    assert prompt_tokens(messages) >= 2 * IMAGE_TOKENS
    plan = plan_elisions(messages, [{"index": 3, "trace": "viewed"}], 2_000, 5)
    assert plan["elided"] == ["viewed"] and "images" not in plan["messages"][3]
    assert plan["messages"][5]["images"] == [PHOTO]
