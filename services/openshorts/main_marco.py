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


# Phase 4b — faster-whisper model size, overridable without a code change.
# "base" is fine for short clips but real-estate walkthroughs run 30-60min;
# "small" is the right default balance of speed and accuracy for CPU-only
# processing at that length. "medium"/"large" are too slow to be practical
# here (see the model-speed table this was chosen from).
WHISPER_MODEL_SIZE = os.environ.get("WHISPER_MODEL", "small")
_whisper_model = None


def _get_whisper_model():
    """
    Lazily load and cache the faster-whisper model for the life of the
    process. The vendored transcribe_video() reloaded a fresh model on every
    single call — wasted load time on every job for no reason, since nothing
    about the model depends on the video being transcribed.
    """
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        print(f"[openshorts] Loading faster-whisper model '{WHISPER_MODEL_SIZE}' (cached for process lifetime)...")
        _whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="int8")
    return _whisper_model


def transcribe_video_marco(video_path: str) -> dict:
    """Marco override of OpenShorts' transcribe_video() — same return shape,
    configurable/cached model instead of a hardcoded reload-per-call "base"."""
    print(f"🎙️  Transcribing video with Faster-Whisper ({WHISPER_MODEL_SIZE}, CPU int8)...")
    model = _get_whisper_model()
    segments, info = model.transcribe(video_path, word_timestamps=True)
    print(f"   Detected language '{info.language}' with probability {info.language_probability:.2f}")

    transcript_segments = []
    full_text = ""
    for segment in segments:
        print(f"   [{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
        seg_dict = {"text": segment.text, "start": segment.start, "end": segment.end, "words": []}
        if segment.words:
            for word in segment.words:
                seg_dict["words"].append(
                    {"word": word.word, "start": word.start, "end": word.end, "probability": word.probability}
                )
        transcript_segments.append(seg_dict)
        full_text += segment.text + " "

    return {"text": full_text.strip(), "segments": transcript_segments, "language": info.language}


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
    openshorts_main.transcribe_video = transcribe_video_marco
