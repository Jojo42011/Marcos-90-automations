"""
Marco Puga Realty — OpenShorts main.py override
Patches viral clip detection to use Marco-specific prompts + multi-provider LLM.
"""
import os

from prompts_marco import get_viral_moment_prompt
from llm_analysis import analyze_transcript_for_clips
import audio_features_marco
import frame_analysis_marco
import gaze_analysis_marco
import take_analysis_marco

# Visual frame analysis. Frames are read by a stronger vision model than the
# text default (env-overridable) — Sonnet materially out-reasons Haiku on framing/
# expression/quality judgments. Frame count is capped in frame_analysis_marco.
VISION_MODEL = os.environ.get("VISION_MODEL", "claude-sonnet-4-20250514")
MAX_ANALYSIS_FRAMES = int(os.environ.get("MAX_ANALYSIS_FRAMES", "16"))

# Phase 4 — quality-over-volume. target_clips is now a MAXIMUM, not a quota. The
# engine returns FEWER, higher-quality clips per source video; the daily 7 stays a
# raw-recording goal upstream. Clips below this viral_score floor are dropped rather
# than padding the list. Env-overridable so the bar can be tuned without a deploy.
VIRAL_SCORE_FLOOR = int(os.environ.get("VIRAL_SCORE_FLOOR", "70"))

try:
    import main as openshorts_main
except ImportError:
    print("Warning: OpenShorts main.py not found. Run scripts/setup-openshorts.sh first.")
    openshorts_main = None


def _apply_quality_gate(clips: list, target_clips: int) -> list:
    """Phase 4 — enforce quality-over-volume on the model's output.

    Keep only clips at or above VIRAL_SCORE_FLOOR, best first, capped at
    target_clips (a MAX). If nothing clears the floor, keep the single strongest
    clip so a decent source never yields zero — but never pad up to the count.
    """
    scored = sorted(
        clips,
        key=lambda c: float(c.get("viral_score", 0) or 0),
        reverse=True,
    )
    strong = [c for c in scored if float(c.get("viral_score", 0) or 0) >= VIRAL_SCORE_FLOOR]
    if strong:
        kept = strong[:target_clips]
    else:
        kept = scored[:1]  # nothing cleared the bar — the single best, not filler
    print(
        f"[content-ai] quality gate (floor={VIRAL_SCORE_FLOOR}, max={target_clips}): "
        f"{len(clips)} analyzed → {len(kept)} kept "
        f"({'above floor' if strong else 'fallback: best-of below floor'})"
    )
    return kept


def get_viral_clips_marco(
    transcript_result: dict,
    video_duration: float,
    pillar: str = "brand",
    trend_brief: str = "",
    target_clips: int = 7,
    video_path: str | None = None,
    user_context: str = "",
    script_text: str = "",
) -> dict:
    if openshorts_main is None:
        raise RuntimeError("OpenShorts main module not available")

    transcript_text = " ".join(
        [seg.get("text", "") for seg in transcript_result.get("segments", [])],
    )

    # Phase 1 — extract ffmpeg-only vocal-delivery signals (pauses/energy/pace)
    # and hand the model a compact brief so clip selection aligns with HOW Marco
    # delivers, not just the words. Best-effort: a failure yields an empty brief
    # and the prompt is exactly what it was before.
    prosody_brief = ""
    prosody: dict = {}
    if video_path:
        try:
            prosody = audio_features_marco.analyze_prosody(
                video_path, transcript_result, video_duration
            )
            prosody_brief = audio_features_marco.prosody_prompt_block(prosody)
            if prosody_brief:
                print(
                    f"[content-ai] prosody signals attached "
                    f"(pauses={len(prosody.get('pauses', []))}, "
                    f"energy_peaks={len(prosody.get('energy', {}).get('peaks', []))})"
                )
        except Exception as prosody_err:  # noqa: BLE001 — never fatal
            print(f"[content-ai] prosody analysis skipped: {type(prosody_err).__name__}: {prosody_err}")

    # Full-timeline gaze scan — every moment of the video is checked locally
    # (MediaPipe FaceMesh) for camera eye contact. Produces the away-look map
    # used both in the prompt and for generation-time cutting. Best-effort.
    gaze: dict = {}
    if video_path:
        try:
            gaze = gaze_analysis_marco.analyze_gaze(video_path)
            if gaze.get("available"):
                print(
                    f"[content-ai] gaze map: {gaze['frames_analyzed']} frames at "
                    f"{gaze['sample_fps']}fps, coverage {gaze['coverage'] * 100:.0f}%, "
                    f"{len(gaze['away_segments'])} away segment(s) "
                    f"({gaze['away_total_s']}s total){'' if gaze['reliable'] else ' — UNRELIABLE, cuts disabled'}"
                )
        except Exception as gaze_err:  # noqa: BLE001 — never fatal
            print(f"[content-ai] gaze analysis skipped: {type(gaze_err).__name__}: {gaze_err}")
            gaze = {}

    # Repeated-take map — near-duplicate transcript stretches scored by delivery
    # (energy/liveliness/pace/fluency); only the best take should survive.
    retakes: dict = {}
    try:
        energy_wins = audio_features_marco.energy_windows(video_path) if video_path else []
        retakes = take_analysis_marco.detect_retakes(
            transcript_result.get("segments", []), energy_wins
        )
        if retakes.get("available"):
            print(
                f"[content-ai] retake map: {len(retakes['groups'])} repeated-take group(s), "
                f"{len(retakes['inferior_spans'])} inferior take(s) marked for avoidance"
            )
    except Exception as take_err:  # noqa: BLE001 — never fatal
        print(f"[content-ai] retake analysis skipped: {type(take_err).__name__}: {take_err}")
        retakes = {}

    # Visual frames — scene changes + the prosody-flagged moments (energy peaks,
    # long pauses/bloopers, fast-pace hook candidates). Best-effort: on any
    # failure `images` is empty and analysis proceeds transcript+audio-only.
    images: list = []
    if video_path:
        try:
            energy = prosody.get("energy", {}) if isinstance(prosody, dict) else {}
            pace = prosody.get("pace", {}) if isinstance(prosody, dict) else {}
            pauses = prosody.get("pauses", []) if isinstance(prosody, dict) else []
            flagged: list[float] = []
            flagged += [float(t) for t in energy.get("peaks", [])]
            flagged += [float(t) for t in pace.get("fast", [])]
            flagged += [float(p.get("start", 0)) for p in pauses if float(p.get("dur", 0)) >= 0.7]
            flagged.append(0.5)  # the opening frame (hook)
            images = frame_analysis_marco.extract_analysis_frames(
                video_path, flagged_timestamps=flagged, max_frames=MAX_ANALYSIS_FRAMES
            )
        except Exception as frame_err:  # noqa: BLE001 — never fatal
            print(f"[content-ai] frame extraction skipped: {type(frame_err).__name__}: {frame_err}")
            images = []

    # Gaze + retake briefs ride the prosody_brief slot — they are delivery
    # signals of the same kind, and this keeps the prompt signature stable.
    signals_brief = prosody_brief
    signals_brief += gaze_analysis_marco.gaze_prompt_block(gaze)
    signals_brief += take_analysis_marco.retake_prompt_block(retakes)

    prompt = get_viral_moment_prompt(
        transcript=transcript_text,
        video_duration=video_duration,
        pillar=pillar,
        trend_brief=trend_brief,
        target_clips=target_clips,
        prosody_brief=signals_brief,
        quality_floor=VIRAL_SCORE_FLOOR,
        has_frames=bool(images),
        user_context=user_context,
        script_text=script_text,
    )
    if user_context or script_text:
        print(
            f"[content-ai] human direction attached "
            f"(context={len(user_context)} chars, script={len(script_text)} chars)"
        )

    clips_data, model = analyze_transcript_for_clips(
        prompt, images=images, vision_model=VISION_MODEL if images else None
    )
    clips_data = _apply_quality_gate(clips_data, target_clips)

    return {
        "clips": clips_data,
        "model": model,
        "total_clips": len(clips_data),
        # Full-timeline maps for generation-time cutting (app_marco).
        "gaze": gaze,
        "retakes": retakes,
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
    configurable/cached model instead of a hardcoded reload-per-call "base".
    Also carries whisper's confidence signals (language probability, per-segment
    avg_logprob and no_speech_prob) so a hallucinated transcript can be caught
    before the expensive AI analysis call (see assess_transcript_quality)."""
    print(f"🎙️  Transcribing video with Faster-Whisper ({WHISPER_MODEL_SIZE}, CPU int8)...")
    model = _get_whisper_model()
    segments, info = model.transcribe(video_path, word_timestamps=True)
    lang = getattr(info, "language", "") or ""
    lang_prob = float(getattr(info, "language_probability", 0.0) or 0.0)
    print(f"   Detected language '{lang}' with probability {lang_prob:.2f}")

    transcript_segments = []
    full_text = ""
    no_speech_probs: list[float] = []
    avg_logprobs: list[float] = []
    for segment in segments:
        print(f"   [{segment.start:.2f}s -> {segment.end:.2f}s] {segment.text}")
        nsp = getattr(segment, "no_speech_prob", None)
        alp = getattr(segment, "avg_logprob", None)
        if nsp is not None:
            no_speech_probs.append(float(nsp))
        if alp is not None:
            avg_logprobs.append(float(alp))
        seg_dict = {
            "text": segment.text,
            "start": segment.start,
            "end": segment.end,
            "no_speech_prob": float(nsp) if nsp is not None else None,
            "avg_logprob": float(alp) if alp is not None else None,
            "words": [],
        }
        if segment.words:
            for word in segment.words:
                seg_dict["words"].append(
                    {"word": word.word, "start": word.start, "end": word.end, "probability": word.probability}
                )
        transcript_segments.append(seg_dict)
        full_text += segment.text + " "

    return {
        "text": full_text.strip(),
        "segments": transcript_segments,
        "language": lang,
        "language_probability": lang_prob,
        "mean_no_speech_prob": (sum(no_speech_probs) / len(no_speech_probs)) if no_speech_probs else None,
        "mean_avg_logprob": (sum(avg_logprobs) / len(avg_logprobs)) if avg_logprobs else None,
    }


# ── Transcript quality guard ─────────────────────────────────────────────────
# faster-whisper hallucinates fluent text (often in a wrong language) when the
# audio is silent, near-silent, or non-speech. These checks catch that BEFORE
# the expensive AI analysis call so a garbage transcript fails fast with a clear
# reason instead of burning an analysis call and returning a confusing error.
# All thresholds are env-overridable so they can be tuned without a code change.
EXPECTED_LANGUAGE = os.environ.get("WHISPER_EXPECTED_LANGUAGE", "en").strip().lower()
_MIN_LANGUAGE_PROB = float(os.environ.get("WHISPER_MIN_LANGUAGE_PROB", "0.5"))
_MIN_WORDS_PER_MIN = float(os.environ.get("WHISPER_MIN_WORDS_PER_MIN", "5"))
_MAX_NO_SPEECH_PROB = float(os.environ.get("WHISPER_MAX_NO_SPEECH_PROB", "0.6"))
_MAX_NON_LATIN_RATIO = float(os.environ.get("WHISPER_MAX_NON_LATIN_RATIO", "0.5"))
_MIN_UNIQUE_WORD_RATIO = float(os.environ.get("WHISPER_MIN_UNIQUE_WORD_RATIO", "0.15"))

# The single user-facing message for every "the audio had no usable speech"
# outcome (Phase 1 wording). Distinct from any API-key / provider-error message.
NO_SPEECH_MESSAGE = (
    "Transcription produced no usable speech content for this video — the audio "
    "may be silent, very quiet, or non-speech. Try a different source clip or "
    "check the video's audio track."
)


def _non_latin_alpha_ratio(text: str) -> float:
    """Fraction of alphabetic characters that are NOT basic Latin A–Z/a–z.
    A high ratio means the transcript is in a different script (Georgian,
    Cyrillic, CJK, …) — a strong hallucination signal when we expect English."""
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return 0.0
    non_latin = sum(1 for c in letters if not ("A" <= c <= "Z" or "a" <= c <= "z"))
    return non_latin / len(letters)


def assess_transcript_quality(transcript_result: dict, video_duration: float) -> dict:
    """Judge whether a transcript is real speech or a likely hallucination.

    Returns {ok, message, debug, signals}. On ok=False, `message` is the
    user-facing NO_SPEECH_MESSAGE and `debug` names the exact signal that fired.
    Conservative by design: a normal English talking-head clip passes all checks.
    """
    text = (transcript_result.get("text") or "").strip()
    words = text.split()
    word_count = len(words)
    lang = (transcript_result.get("language") or "").lower()
    lang_prob = transcript_result.get("language_probability")
    mean_no_speech = transcript_result.get("mean_no_speech_prob")
    non_latin = _non_latin_alpha_ratio(text)
    wpm = (word_count / (video_duration / 60.0)) if video_duration and video_duration > 0 else None
    unique_ratio = (len({w.lower() for w in words}) / word_count) if word_count else 0.0

    signals = {
        "word_count": word_count,
        "language": lang,
        "language_probability": lang_prob,
        "mean_no_speech_prob": mean_no_speech,
        "non_latin_ratio": round(non_latin, 3),
        "words_per_min": round(wpm, 1) if wpm is not None else None,
        "unique_word_ratio": round(unique_ratio, 3),
        "video_duration": round(video_duration, 1) if video_duration else None,
    }

    def reject(debug: str) -> dict:
        return {"ok": False, "message": NO_SPEECH_MESSAGE, "debug": debug, "signals": signals}

    # a) Empty / whitespace transcript — no speech at all.
    if word_count == 0 or len(text) < 2:
        return reject("empty transcript (no speech detected)")
    # b) Dominant non-Latin script — the classic wrong-language hallucination.
    if non_latin > _MAX_NON_LATIN_RATIO:
        return reject(f"dominant non-Latin script (non_latin_ratio={non_latin:.2f})")
    # c) Wrong language with shaky confidence (a confident non-English detection
    #    on Latin text is left alone — could be legitimate Spanish content).
    if lang and EXPECTED_LANGUAGE and lang != EXPECTED_LANGUAGE:
        if lang_prob is None or lang_prob < 0.85:
            return reject(f"detected non-{EXPECTED_LANGUAGE} language '{lang}' (prob={lang_prob})")
    # d) Low language-detection confidence overall.
    if lang_prob is not None and lang_prob < _MIN_LANGUAGE_PROB:
        return reject(f"low language-detection confidence ({lang_prob:.2f})")
    # e) Audio scored as non-speech by whisper's own no_speech head.
    if mean_no_speech is not None and mean_no_speech > _MAX_NO_SPEECH_PROB:
        return reject(f"high mean no_speech_prob ({mean_no_speech:.2f}) — audio likely non-speech/silent")
    # f) Almost no words for a video of real length.
    if wpm is not None and video_duration > 15 and wpm < _MIN_WORDS_PER_MIN:
        return reject(f"very sparse speech ({wpm:.1f} words/min over {video_duration:.0f}s)")
    # g) Extreme repetition — a common hallucination signature.
    if word_count >= 20 and unique_ratio < _MIN_UNIQUE_WORD_RATIO:
        return reject(f"highly repetitive transcript (unique-word ratio {unique_ratio:.2f})")

    return {"ok": True, "message": "", "debug": "transcript passed quality checks", "signals": signals}


if openshorts_main is not None:
    def _patched_get_viral_clips(tr, dur, **kw):
        return get_viral_clips_marco(
            tr,
            dur,
            pillar=kw.get("pillar", "brand"),
            trend_brief=kw.get("trend_brief", ""),
            target_clips=kw.get("target_clips", 7),
        )

    openshorts_main.get_viral_clips = _patched_get_viral_clips
    openshorts_main.transcribe_video = transcribe_video_marco
