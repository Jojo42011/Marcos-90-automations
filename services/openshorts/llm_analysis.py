"""
LLM provider chain for OpenShorts viral-moment analysis.
Anthropic (primary) → OpenAI (fallback).
"""
from __future__ import annotations

import json
import os
from typing import Any

import httpx

DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"


class NoUsableClipsError(Exception):
    """The model RESPONDED successfully but produced no usable clips — e.g. it
    judged the transcript unclippable and replied in prose, or returned an empty
    or malformed array. This is a content outcome, NOT a provider/auth failure,
    and must never surface as an "API key" error."""


def _looks_like_auth_error(msg: str) -> bool:
    """True if a provider-call error looks like a credentials/permission problem
    (the only case where telling the user to fix their API key is correct)."""
    m = (msg or "").lower()
    return any(
        t in m
        for t in (
            "401",
            "403",
            "invalid_api_key",
            "invalid x-api-key",
            "invalid api key",
            "authentication",
            "unauthorized",
            "permission",
            "no llm api key",
        )
    )


def _openai_key() -> str | None:
    key = os.environ.get("OPENAI_API_KEY", "").strip()
    return key or None


def _anthropic_key() -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    return key or None


def any_llm_configured() -> bool:
    return bool(_anthropic_key() or _openai_key())


def configured_llm_summary() -> str:
    parts: list[str] = []
    if _anthropic_key():
        parts.append("anthropic")
    if _openai_key():
        parts.append("openai")
    return ", ".join(parts) if parts else "none"


def _loads_flexible(text: str) -> Any:
    """Parse JSON that may be surrounded by prose or trailing commentary.

    Tries the whole string first; if that fails, scans for the first balanced
    top-level array (then object), tolerating text before/after it. Bracket
    counting is string-aware so a ``]`` inside a caption never closes early.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    for opener, closer in (("[", "]"), ("{", "}")):
        start = text.find(opener)
        if start == -1:
            continue
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
                continue
            if ch == '"':
                in_str = True
            elif ch == opener:
                depth += 1
            elif ch == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start : i + 1])
                    except json.JSONDecodeError:
                        break
    raise json.JSONDecodeError("no parseable JSON array or object found", text, 0)


def parse_clips_json(response_text: str) -> list[dict[str, Any]]:
    """Return the clip list from a raw LLM response.

    Accepts a bare JSON array, a ```-fenced array, an array wrapped in prose,
    or an object wrapping the array (e.g. ``{"clips": [...]}``). Raises loudly
    with the raw response when it cannot produce a list — never silently
    returns an empty result.
    """
    raw = (response_text or "").strip()
    if not raw:
        raise ValueError("LLM returned an empty response (no text to parse)")

    text = raw
    if text.startswith("```"):
        text = text.split("```", 1)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.rsplit("```", 1)[0]
    text = text.strip()

    data = _loads_flexible(text)

    # Some models wrap the array in an object — unwrap common key names.
    if isinstance(data, dict):
        for key in ("clips", "results", "moments", "segments", "data"):
            if isinstance(data.get(key), list):
                data = data[key]
                break

    if not isinstance(data, list):
        raise ValueError(
            "LLM response was not a JSON array of clips — expected a top-level "
            f"array (or {{'clips': [...]}}), got {type(data).__name__}. "
            f"Raw response (first 500 chars): {raw[:500]!r}"
        )
    return data


# Field-name variants different models emit for the clip time bounds. The
# reframing step requires start_time/end_time (floats, seconds); we normalize
# any of these to that canonical shape so a rename in the model output can no
# longer silently drop every clip.
_START_ALIASES = ("start_time", "start", "startTime", "start_sec", "start_seconds", "begin", "from")
_END_ALIASES = ("end_time", "end", "endTime", "stop", "end_sec", "end_seconds", "to")


def _coerce_seconds(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        s = value.strip().rstrip("sS").strip()
        try:
            return float(s)
        except ValueError:
            return None
    return None


def _alias_value(clip: dict[str, Any], aliases: tuple[str, ...]) -> Any:
    for key in aliases:
        if key in clip:
            return clip[key]
    return None


def normalize_clips(raw_clips: list[Any]) -> tuple[list[dict[str, Any]], list[str]]:
    """Coerce each clip to canonical start_time/end_time floats.

    Returns (usable_clips, issues). A clip is dropped (with a recorded issue)
    if it is not an object, lacks a recognizable start/end, has non-numeric
    bounds, or has end <= start. Issues name exactly what was wrong so a bad
    payload is diagnosable from the logs without another round of archaeology.
    """
    usable: list[dict[str, Any]] = []
    issues: list[str] = []
    for idx, clip in enumerate(raw_clips):
        if not isinstance(clip, dict):
            issues.append(f"clip[{idx}] is {type(clip).__name__}, not an object")
            continue
        start = _coerce_seconds(_alias_value(clip, _START_ALIASES))
        end = _coerce_seconds(_alias_value(clip, _END_ALIASES))
        if start is None or end is None:
            issues.append(
                f"clip[{idx}] missing/invalid start or end (keys present: {sorted(clip.keys())})"
            )
            continue
        if end <= start:
            issues.append(f"clip[{idx}] end ({end}) <= start ({start})")
            continue
        normalized = dict(clip)
        normalized["start_time"] = start
        normalized["end_time"] = end
        usable.append(normalized)
    return usable, issues


def _call_openai(prompt: str, api_key: str) -> str:
    model = os.environ.get("OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_MODEL
    payload = {
        "model": model,
        "max_tokens": 4096,
        "messages": [
            {
                "role": "system",
                "content": "Return only valid JSON. No markdown fences or commentary.",
            },
            {"role": "user", "content": prompt},
        ],
    }
    with httpx.Client(timeout=120.0) as client:
        res = client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    if res.status_code >= 400:
        raise RuntimeError(f"OpenAI API {res.status_code}: {res.text[:500]}")
    data = res.json()
    text = (data.get("choices") or [{}])[0].get("message", {}).get("content", "")
    if not str(text).strip():
        raise RuntimeError("OpenAI returned empty response")
    return str(text).strip()


def _call_anthropic(
    prompt: str,
    api_key: str,
    images: list[dict[str, Any]] | None = None,
    model_override: str | None = None,
) -> str:
    model = (model_override or "").strip() or os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL
    # Multimodal: when frames are provided, send them as image blocks BEFORE the
    # text (Anthropic's recommended ordering) so the model grounds its reasoning
    # in what it sees. Otherwise a plain string content — unchanged behavior.
    if images:
        content: list[dict[str, Any]] = []
        for img in images:
            b64 = img.get("b64")
            if not b64:
                continue
            content.append({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": img.get("media_type", "image/jpeg"),
                    "data": b64,
                },
            })
        content.append({"type": "text", "text": prompt})
        message_content: Any = content
    else:
        message_content = prompt
    payload = {
        "model": model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": message_content}],
    }
    with httpx.Client(timeout=180.0) as client:
        res = client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            json=payload,
        )
    if res.status_code >= 400:
        raise RuntimeError(f"Anthropic API {res.status_code}: {res.text[:500]}")
    data = res.json()
    blocks = data.get("content") or []
    text = "".join(
        block.get("text", "")
        for block in blocks
        if isinstance(block, dict) and block.get("type") == "text"
    )
    if not text.strip():
        raise RuntimeError("Anthropic returned empty response")
    return text.strip()


def _parse_normalize_or_raise(text: str, model: str, provider: str) -> list[dict[str, Any]]:
    """Parse + normalize a provider response at the analysis→reframing boundary.

    Logs the raw response and the parsed/normalized result so the handoff is
    always diagnosable, and raises with the raw payload if nothing usable is
    produced — instead of returning an empty list that later surfaces only as
    the generic "Reframing produced no clips".
    """
    preview = text[:400].replace("\n", " ")
    print(f"[content-ai] {provider} raw response ({len(text)} chars): {preview}")

    try:
        parsed = parse_clips_json(text)
    except (ValueError, json.JSONDecodeError) as parse_err:
        # The provider responded but the reply is not a clip array — almost
        # always the model explaining, in prose, that there are no viable clips
        # (e.g. when the transcript was empty/garbled). This is a "no usable
        # clips" outcome, not a provider failure.
        raise NoUsableClipsError(
            f"{model} responded but returned no parseable clip array ({parse_err}). "
            f"Raw response (first 400 chars): {text[:400]!r}"
        )
    usable, issues = normalize_clips(parsed)
    print(
        f"[content-ai] {provider} parsed {len(parsed)} item(s), {len(usable)} usable clip(s)"
        + (f"; dropped: {issues[:5]}" if issues else "")
    )
    if not usable:
        raise NoUsableClipsError(
            f"{model} returned {len(parsed)} item(s) but none were usable clips. "
            f"Issues: {issues[:8]}. Raw response (first 400 chars): {text[:400]!r}"
        )
    return usable


def analyze_transcript_for_clips(
    prompt: str,
    images: list[dict[str, Any]] | None = None,
    vision_model: str | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """
    Run viral-moment analysis using the first working provider.
    Anthropic is primary (matches the rest of the content-manager system);
    OpenAI is the fallback if ANTHROPIC_API_KEY is missing or the call fails.
    Returns (clips_list, model_label).

    `images` (optional base64 frames) are sent ONLY on the Anthropic path, using
    `vision_model` (a stronger model than the text default). The OpenAI fallback
    stays text-only — Anthropic-format image blocks are not portable to it, and a
    text-only fallback is still a correct (if less visually-aware) analysis.
    """
    # Only genuine provider-CALL failures (network/HTTP/auth) go here. A
    # successful response that yields no clips raises NoUsableClipsError and
    # propagates straight out — it is NOT retried on the next provider and is
    # NEVER reported as an API-key problem.
    call_errors: list[str] = []

    providers: list[tuple[str, str, Any, str]] = []
    anthropic_key = _anthropic_key()
    if anthropic_key:
        providers.append((
            "anthropic",
            anthropic_key,
            _call_anthropic,
            os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL,
        ))
    openai_key = _openai_key()
    if openai_key:
        providers.append((
            "openai",
            openai_key,
            _call_openai,
            os.environ.get("OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_MODEL,
        ))

    if not providers:
        raise RuntimeError(
            "AI analysis unavailable — no LLM API key configured. "
            "Set a valid ANTHROPIC_API_KEY (sk-ant-…) or OPENAI_API_KEY."
        )

    for provider, key, caller, model in providers:
        try:
            if provider == "anthropic" and images:
                # Multimodal analysis on the vision model.
                model = (vision_model or "").strip() or model
                text = _call_anthropic(prompt, key, images=images, model_override=model)
                print(f"[content-ai] anthropic multimodal analysis with {len(images)} frame(s) on {model}")
            else:
                text = caller(prompt, key)  # transport/HTTP/auth failures raise here
        except Exception as err:
            print(f"[content-ai] {provider} call failed: {err}")
            call_errors.append(f"{provider}: {err}")
            continue  # a real provider failure — try the next configured provider
        # Provider responded. Parsing to clips (or a NoUsableClipsError) is a
        # content outcome — return or let NoUsableClipsError propagate; do not
        # fall through to the next provider as if the credentials were bad.
        return _parse_normalize_or_raise(text, model, provider), model

    # Every configured provider failed at the CALL level.
    detail = "; ".join(call_errors) if call_errors else "unknown error"
    if any(_looks_like_auth_error(e) for e in call_errors):
        raise RuntimeError(
            "AI analysis failed — the model API rejected the credentials. "
            f"Set a valid ANTHROPIC_API_KEY (sk-ant-…) or OPENAI_API_KEY. Attempts: {detail}"
        )
    raise RuntimeError(
        "AI analysis failed — the model API call did not succeed. This is a provider "
        f"or network error, not an API-key problem. Attempts: {detail}"
    )
