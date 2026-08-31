#!/usr/bin/env python3
"""Measure an OpenAI-compatible endpoint against this workstation's numbers.

    python3 measure.py http://<pod-ip>:<port>/v1

Answers the two questions that decide whether renting is worth it, using the
same shapes the app actually sends:

  * how big a context the server came up with, and whether the weights left
    room for one worth having;
  * prefill and generation speed, next to the local baseline.

Prefill is the one that matters. The complaint that started all of this was
42.87s to first token on a 4,661-token prompt — all of it prefill — because
42 of 48 layers of experts live in system RAM on the workstation. A single
96 GB card holds them all; whether that actually helps has never been
measured, and no amount of reasoning substitutes for the number.
"""

import json
import statistics
import sys
import time
import urllib.error
import urllib.request

# Measured on this workstation: RTX 4080 16 GB + 62 GB DDR, IQ3_XXS with
# --n-cpu-moe 42 (see local_model/README.md).
LOCAL_BASELINE = {
    "generation_tok_s": 18.8,
    "prefill_tok_s": 137.0,      # 4,558-token prompt, cold
    "n_ctx": 262144,
}

CJK = "江湖夜雨十年灯，剑气如霜照旧痕。少年不识愁滋味，只把长歌当酒吞。"


def post(base: str, path: str, payload: dict, timeout: float = 900.0) -> dict:
    req = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


def get(base: str, path: str, timeout: float = 30.0) -> dict:
    with urllib.request.urlopen(f"{base.rstrip('/')}{path}", timeout=timeout) as res:
        return json.loads(res.read())


def complete(base: str, prompt: str, max_tokens: int) -> dict:
    """One non-streamed turn. llama.cpp reports what it did in `timings`."""
    body = post(base, "/chat/completions", {
        "model": "measure",
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": 0,
        "stream": False,
    })
    t = body.get("timings", {}) or {}
    usage = body.get("usage", {}) or {}
    return {
        # prompt_n is what was COMPUTED; the total lives in usage.
        "prompt_total": usage.get("prompt_tokens", 0),
        "prompt_cached": t.get("cache_n", 0),
        "prompt_ms": t.get("prompt_ms", 0.0),
        "gen_tokens": t.get("predicted_n", 0),
        "gen_tok_s": t.get("predicted_per_second", 0.0),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    base = sys.argv[1]

    print(f"endpoint: {base}\n")

    try:
        models = get(base, "/models")
    except (urllib.error.URLError, TimeoutError) as exc:
        print(f"unreachable: {exc}")
        return 1

    served = models.get("data", [{}])[0]
    meta = served.get("meta", {}) or {}
    n_ctx = meta.get("n_ctx")
    print(f"model  : {served.get('id')}")
    print(f"n_ctx  : {n_ctx}  (workstation: {LOCAL_BASELINE['n_ctx']})")
    if n_ctx and n_ctx < 32768:
        print("  ⚠ under 32k — a chapter plus its reference chapters will not fit")
    print()

    # A prompt the size of a real turn. Nonce first: llama.cpp keeps an LRU of
    # past prompts in RAM, and a repeat would report a cache hit instead of a
    # cold prefill, which is not what we are trying to measure.
    nonce = f"[measure {time.time_ns()}]"
    long_prompt = nonce + "\n" + (CJK * 120) + "\n请用一句话总结上文。"

    print("── cold prefill ─────────────────────────────────────────")
    cold = complete(base, long_prompt, max_tokens=1)
    prefill_computed = cold["prompt_total"] - cold["prompt_cached"]
    prefill_tok_s = prefill_computed / (cold["prompt_ms"] / 1000) if cold["prompt_ms"] else 0
    print(f"  {prefill_computed} tokens computed in {cold['prompt_ms']/1000:.1f}s "
          f"= {prefill_tok_s:.0f} tok/s")
    print(f"  workstation baseline: {LOCAL_BASELINE['prefill_tok_s']:.0f} tok/s "
          f"→ {prefill_tok_s / LOCAL_BASELINE['prefill_tok_s']:.1f}×")
    print()

    print("── generation ───────────────────────────────────────────")
    rates = []
    for i in range(3):
        r = complete(base, f"{nonce}-{i}\n写一段两百字的雪夜场景描写。", max_tokens=200)
        rates.append(r["gen_tok_s"])
        print(f"  run {i+1}: {r['gen_tokens']} tokens at {r['gen_tok_s']:.1f} tok/s")
    median = statistics.median(rates)
    print(f"  median {median:.1f} tok/s vs workstation {LOCAL_BASELINE['generation_tok_s']} "
          f"→ {median / LOCAL_BASELINE['generation_tok_s']:.1f}×")
    print()

    print("── verdict ──────────────────────────────────────────────")
    prefill_gain = prefill_tok_s / LOCAL_BASELINE["prefill_tok_s"]
    gen_gain = median / LOCAL_BASELINE["generation_tok_s"]
    if prefill_gain < 1.2:
        print("  Prefill is NOT meaningfully faster than the workstation.")
        print("  That was the whole complaint — renting does not fix it.")
    elif gen_gain < 1.5:
        print("  Prefill improves but generation barely does; weigh the monthly")
        print("  storage floor (~$10) against a gain you may not feel.")
    else:
        print(f"  Both improve ({prefill_gain:.1f}× prefill, {gen_gain:.1f}× generation).")
        print("  Worth a network volume and the wake proxy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
