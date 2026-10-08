"""Port of src/utils/providerProfile.ts — what each provider's prompt cache does."""
from typing import Any, Dict, Optional

PROFILES: Dict[str, Dict[str, Any]] = {
    "grok": {"mode": "automatic", "maxBreakpoints": 0, "routing": {"kind": "header", "name": "x-grok-conv-id"},
             "longContextThreshold": 200_000, "cachedTokensPath": ["prompt_tokens_details", "cached_tokens"],
             "exclusiveCache": False, "windowDiscovered": False},
    "ollama": {"mode": "automatic", "maxBreakpoints": 0, "exclusiveCache": True, "windowDiscovered": True},
    "anthropic": {"mode": "explicit", "maxBreakpoints": 4, "cachedTokensPath": ["cache_read_input_tokens"],
                  "exclusiveCache": False, "windowDiscovered": False},
    "openai": {"mode": "automatic", "maxBreakpoints": 0, "routing": {"kind": "header", "name": "prompt-cache-key"},
               "cachedTokensPath": ["prompt_tokens_details", "cached_tokens"], "exclusiveCache": False, "windowDiscovered": False},
    "gemini": {"mode": "automatic", "maxBreakpoints": 0, "cachedTokensPath": ["cachedContentTokenCount"],
               "exclusiveCache": False, "windowDiscovered": False},
}
UNKNOWN_PROFILE: Dict[str, Any] = {"mode": "none", "maxBreakpoints": 0, "exclusiveCache": False, "windowDiscovered": False}


def get_cache_profile(provider: str) -> Dict[str, Any]:
    return PROFILES.get(provider, UNKNOWN_PROFILE)


def target_prompt_tokens(profile: Dict[str, Any], context_window_tokens: int) -> int:
    threshold = profile.get("longContextThreshold")
    if threshold and threshold < context_window_tokens:
        return threshold
    return context_window_tokens


def check_threshold(profile: Dict[str, Any], prompt_tokens: int) -> Optional[Dict[str, Any]]:
    threshold = profile.get("longContextThreshold")
    if not threshold:
        return None
    return {"crossed": prompt_tokens > threshold, "threshold": threshold, "promptTokens": prompt_tokens,
            "overBy": max(0, prompt_tokens - threshold)}


def read_cached_tokens(profile: Dict[str, Any], usage: Any) -> Optional[int]:
    path = profile.get("cachedTokensPath")
    if not path:
        return None
    node = usage
    for key in path:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node if isinstance(node, (int, float)) and not isinstance(node, bool) else None
