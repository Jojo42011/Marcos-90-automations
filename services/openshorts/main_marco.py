"""
Marco Puga Realty — OpenShorts main.py override
Patches viral clip detection to use Marco-specific prompts + multi-provider LLM.
"""
import os

from prompts_marco import get_viral_moment_prompt
from llm_analysis import analyze_transcript_for_clips

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

    clips_data, model = analyze_transcript_for_clips(prompt, gemini_api_key=gemini_api_key)

    return {
        "clips": clips_data,
        "model": model,
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
