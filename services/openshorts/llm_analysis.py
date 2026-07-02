"""
LLM provider chain for OpenShorts viral-moment analysis.
Anthropic (primary) → OpenAI (fallback).
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

DEFAULT_OPENAI_MODEL = "gpt-4o-mini"
DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"


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


def parse_clips_json(response_text: str) -> list[dict[str, Any]]:
    text = (response_text or "").strip()
    if text.startswith("```"):
        text = text.split("```", 1)[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.rsplit("```", 1)[0]
    text = text.strip()
    # Some models wrap JSON in prose — extract first array.
    if not text.startswith("["):
        match = re.search(r"\[[\s\S]*\]", text)
        if match:
            text = match.group(0)
    data = json.loads(text)
    if not isinstance(data, list):
        raise ValueError("LLM response is not a JSON array")
    return data


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


def _call_anthropic(prompt: str, api_key: str) -> str:
    model = os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL
    payload = {
        "model": model,
        "max_tokens": 4096,
        "messages": [{"role": "user", "content": prompt}],
    }
    with httpx.Client(timeout=120.0) as client:
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


def analyze_transcript_for_clips(prompt: str) -> tuple[list[dict[str, Any]], str]:
    """
    Run viral-moment analysis using the first working provider.
    Anthropic is primary (matches the rest of the content-manager system);
    OpenAI is the fallback if ANTHROPIC_API_KEY is missing or the call fails.
    Returns (clips_list, model_label).
    """
    errors: list[str] = []

    anthropic_key = _anthropic_key()
    if anthropic_key:
        try:
            text = _call_anthropic(prompt, anthropic_key)
            model = os.environ.get("ANTHROPIC_MODEL", "").strip() or DEFAULT_ANTHROPIC_MODEL
            return parse_clips_json(text), model
        except Exception as err:
            print(f"[content-ai] viral-clip analysis failed (anthropic): {err}")
            errors.append(f"Anthropic: {err}")

    openai_key = _openai_key()
    if openai_key:
        try:
            text = _call_openai(prompt, openai_key)
            model = os.environ.get("OPENAI_MODEL", "").strip() or DEFAULT_OPENAI_MODEL
            return parse_clips_json(text), model
        except Exception as err:
            print(f"[content-ai] viral-clip analysis failed (openai): {err}")
            errors.append(f"OpenAI: {err}")

    detail = "; ".join(errors) if errors else "no LLM API keys configured"
    raise RuntimeError(
        "AI analysis failed — set a valid ANTHROPIC_API_KEY (sk-ant-…) or OPENAI_API_KEY. "
        f"Attempts: {detail}"
    )
