"""
Marco Puga Realty — visual frame analysis for clip selection.

Technique borrowed from github.com/bradautomates/claude-video (scene-change
extraction + frame dedup + Claude native image reading), reimplemented as an
AUTOMATED backend function our pipeline calls during processing — it returns
structured data (a small set of base64 frames), NOT a conversational tool.

What it does:
  1. SCENE-CHANGE detection — ffmpeg select='gt(scene,thr)' on a downscaled,
     audio-stripped decode (fast even on a 30-60 min walkthrough) to find frames
     where the shot actually changes (angle / room / big movement).
  2. TARGETED sampling — extra frames at the timestamps the transcript/audio
     analysis already flagged (energy peaks, long pauses/bloopers, fast-pace hook
     candidates) — the moments where a visual check adds the most value.
  3. DEDUP — a 64-bit average hash per candidate; drop frames within Hamming ≤ 6
     of one already kept, so multiple frames of the same static shot don't burn
     API budget.
  4. Cap the set (default 16) and return 768px JPEG base64, ready for Claude.

Zero new dependencies: ffmpeg only (already required), pure-Python hashing (no
PIL/numpy). Best-effort by contract — any failure returns [] and the caller
falls back to transcript+audio-only analysis.
"""
from __future__ import annotations

import base64
import os
import re
import subprocess
from typing import Any, Optional

_SCENE_TIMEOUT_S = int(os.environ.get("FRAME_SCENE_TIMEOUT_S", "120"))
_GRAB_TIMEOUT_S = int(os.environ.get("FRAME_GRAB_TIMEOUT_S", "20"))
_PTS_RE = re.compile(r"pts_time:([0-9.]+)")
# 8x8 grayscale average hash → 64 bits. Two frames within this Hamming distance
# are treated as the same shot and deduped.
_HASH_HAMMING_MAX = int(os.environ.get("FRAME_DEDUP_HAMMING", "6"))
_LONG_EDGE = int(os.environ.get("FRAME_LONG_EDGE", "768"))


def _run(cmd: list[str], timeout: int) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


def detect_scene_times(video_path: str, threshold: float = 0.4) -> list[float]:
    """Timestamps (seconds) where the shot changes. Runs on a 320px, audio-less
    decode so even a long source is cheap."""
    try:
        proc = _run(
            [
                "ffmpeg", "-hide_banner", "-nostats", "-i", video_path,
                "-vf", f"scale=320:-2,select='gt(scene,{threshold})',showinfo",
                "-an", "-f", "null", "-",
            ],
            timeout=_SCENE_TIMEOUT_S,
        )
    except Exception as err:  # noqa: BLE001
        print(f"[frames] scene detection failed: {type(err).__name__}: {err}")
        return []
    text = proc.stderr.decode("utf-8", "replace")
    return sorted({round(float(m.group(1)), 2) for m in _PTS_RE.finditer(text)})


def _frame_signature(video_path: str, t: float) -> Optional[tuple[int, int]]:
    """(mean_luma, ahash) for the frame at time t from an 8x8 grayscale grab.

    ahash is the classic 64-bit average hash (texture/layout); mean_luma is the
    overall brightness. Both are compared in _is_duplicate — average hash alone
    is degenerate on near-flat frames (they all hash to all-1s), so brightness
    distinguishes, e.g., a dark room cut from a bright one. None on error."""
    try:
        proc = _run(
            [
                "ffmpeg", "-hide_banner", "-nostats", "-ss", f"{max(0.0, t):.3f}",
                "-i", video_path, "-frames:v", "1",
                "-vf", "scale=8:8,format=gray", "-f", "rawvideo", "-",
            ],
            timeout=_GRAB_TIMEOUT_S,
        )
    except Exception:
        return None
    data = proc.stdout
    if len(data) < 64:
        return None
    px = data[:64]
    mean = sum(px) / 64.0
    bits = 0
    for i, v in enumerate(px):
        if v >= mean:
            bits |= (1 << i)
    return (int(round(mean)), bits)


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


# Two frames are the "same shot" only if their layout (ahash) AND brightness are
# both close — either differing meaningfully keeps the frame.
_MEAN_LUMA_MAX = int(os.environ.get("FRAME_DEDUP_LUMA", "12"))


def _is_duplicate(sig: tuple[int, int], kept: list[tuple[int, int]]) -> bool:
    mean, bits = sig
    for km, kb in kept:
        if _hamming(bits, kb) <= _HASH_HAMMING_MAX and abs(mean - km) <= _MEAN_LUMA_MAX:
            return True
    return False


def _grab_jpeg_b64(video_path: str, t: float, long_edge: int = _LONG_EDGE) -> Optional[str]:
    """One JPEG frame at time t, scaled to fit within long_edge×long_edge, base64."""
    try:
        proc = _run(
            [
                "ffmpeg", "-hide_banner", "-nostats", "-ss", f"{max(0.0, t):.3f}",
                "-i", video_path, "-frames:v", "1",
                "-vf", f"scale={long_edge}:{long_edge}:force_original_aspect_ratio=decrease",
                "-q:v", "3", "-f", "mjpeg", "-",
            ],
            timeout=_GRAB_TIMEOUT_S,
        )
    except Exception:
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    return base64.b64encode(proc.stdout).decode("ascii")


def extract_analysis_frames(
    video_path: str,
    flagged_timestamps: Optional[list[float]] = None,
    max_frames: int = 16,
    scene_threshold: float = 0.4,
) -> list[dict[str, Any]]:
    """Return a small, deduplicated set of frames for the analysis model.

    Each item: {"t": float, "b64": str, "media_type": "image/jpeg"}. Flagged
    moments are considered FIRST (they matter most), then scene changes, so the
    cap favours the moments the transcript/audio flagged. Best-effort: returns []
    on any failure so the caller can fall back to text-only analysis.
    """
    if not video_path or not os.path.isfile(video_path):
        return []
    try:
        flagged = [float(t) for t in (flagged_timestamps or []) if isinstance(t, (int, float))]
        scenes = detect_scene_times(video_path, scene_threshold)

        # Priority order: flagged first (dedup within a 0.5s grid), then scenes.
        ordered: list[float] = []
        seen_grid: set[int] = set()
        for t in flagged + scenes:
            key = int(round(t * 2))  # 0.5s grid to avoid trivially-close duplicates
            if key in seen_grid:
                continue
            seen_grid.add(key)
            ordered.append(round(t, 2))

        kept: list[dict[str, Any]] = []
        kept_sigs: list[tuple[int, int]] = []
        for t in ordered:
            if len(kept) >= max_frames:
                break
            sig = _frame_signature(video_path, t)
            if sig is not None and _is_duplicate(sig, kept_sigs):
                continue  # visually near-identical to a frame already kept
            b64 = _grab_jpeg_b64(video_path, t)
            if not b64:
                continue
            kept.append({"t": t, "b64": b64, "media_type": "image/jpeg"})
            if sig is not None:
                kept_sigs.append(sig)

        print(
            f"[frames] extracted {len(kept)} frame(s) "
            f"(flagged={len(flagged)}, scenes={len(scenes)}, cap={max_frames})"
        )
        return kept
    except Exception as err:  # noqa: BLE001 — never break the pipeline
        print(f"[frames] extraction error (falling back to text-only): {type(err).__name__}: {err}")
        return []
