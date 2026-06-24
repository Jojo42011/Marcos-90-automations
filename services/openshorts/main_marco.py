"""
Marco Puga Realty — OpenShorts main.py override
Patches viral clip detection to use Marco-specific prompts
"""
import os
import sys
import json

from prompts_marco import get_viral_moment_prompt, get_caption_prompt

try:
    import main as openshorts_main
except ImportError:
    print("Warning: OpenShorts main.py not found. Run scripts/setup-openshorts.sh first.")
    openshorts_main = None


def get_viral_clips_marco(
    transcript_result: dict,
    video_duration: float,
    pillar: str = "brand",
    trend_brief: str = "",
    target_clips: int = 7,
    gemini_api_key: str | None = None,
) -> dict:
    if openshorts_main is None:
        raise RuntimeError("OpenShorts main module not available")

    from google import genai

    api_key = gemini_api_key or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise ValueError("GEMINI_API_KEY not set")

    client = genai.Client(api_key=api_key)

    transcript_text = " ".join(
        [seg.get("text", "") for seg in transcript_result.get("segments", [])],
    )

    prompt = get_viral_moment_prompt(
        transcript=transcript_text,
        video_duration=video_duration,
        pillar=pillar,
        trend_brief=trend_brief,
        target_clips=target_clips,
    )

    response = client.models.generate_content(model="gemini-2.5-flash", contents=prompt)

    response_text = response.text.strip()
    if response_text.startswith("```"):
        response_text = response_text.split("```")[1]
        if response_text.startswith("json"):
            response_text = response_text[4:]

    clips_data = json.loads(response_text)

    return {
        "clips": clips_data,
        "model": "gemini-2.5-flash",
        "total_clips": len(clips_data),
    }


if openshorts_main is not None:
    def _patched_get_viral_clips(tr, dur, **kw):
        return get_viral_clips_marco(
            tr,
            dur,
            pillar=kw.get("pillar", "brand"),
            trend_brief=kw.get("trend_brief", ""),
            target_clips=kw.get("target_clips", 7),
            gemini_api_key=kw.get("gemini_api_key"),
        )

    openshorts_main.get_viral_clips = _patched_get_viral_clips
