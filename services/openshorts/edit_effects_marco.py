"""
Marco Puga Realty — editing-skill primitives for the /api/clips/edit engine.

ffmpeg-only, no new dependencies. Three families of skill, all optional and all
best-effort (a detection failure returns nothing and the edit proceeds):

  PHASE 2 — visual polish, applied as ONE re-encode pass on the edited timeline:
    • zoom_in / zoom_out / punch_in   (Ken Burns + emphasis punch, via zoompan)
    • auto exposure / colour correct  (eq + curves presets)

  PHASE 2 — structural tightening, computed as extra cuts BEFORE assembly:
    • dead-air / jump-cut tightening  (silencedetect → remove long gaps)
    • scene-aware cut points          (scene detection → snap cuts to real cuts)

  PHASE 3 — blooper / filler / pause classification:
    • distinguish a genuine blooper or dead gap (CUT) from an intentional
      dramatic pause (KEEP), so tightening never flattens deliberate beats.

All timeline math here is in the coordinate space the caller passes in and is
documented per-function, because the edit engine works in two spaces (the source
timeline for cuts, the edited timeline for visual effects).
"""
from __future__ import annotations

import os
import re
import subprocess
from typing import Any, Optional

_TIMEOUT_S = int(os.environ.get("EDIT_EFFECT_TIMEOUT_S", "180"))
_PTS_RE = re.compile(r"pts_time:([0-9.]+)")

# Words that, standing alone in a caption line, are almost always filler or a
# false start rather than content. Kept deliberately conservative.
_FILLER_RE = re.compile(
    r"^\s*(?:um+|uh+|erm+|hmm+|uhh+|ah+|er+|like|you know|i mean|so+|okay so|wait|"
    r"let me|hold on|start over|take two|cut that|scratch that)\s*[.,!?…-]*\s*$",
    re.IGNORECASE,
)


def _run(cmd: list[str], timeout: int = _TIMEOUT_S) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)


# ── PHASE 2: visual filter pass ──────────────────────────────────────────────

_COLOR_PRESETS: dict[str, str] = {
    # Subtle, safe defaults — lift exposure a touch, add gentle contrast/pop.
    "auto": "eq=contrast=1.06:brightness=0.02:saturation=1.10:gamma=1.02,curves=preset=lighter",
    "warm": "eq=saturation=1.12:gamma_r=1.06:gamma_b=0.96",
    "cool": "eq=saturation=1.10:gamma_r=0.96:gamma_b=1.06",
    "punch": "eq=contrast=1.12:saturation=1.20:brightness=0.01",
    "flat": "eq=contrast=0.96:saturation=0.94",
}

_ZOOM_TYPES = {"zoom_in", "zoom_out", "punch_in"}


def _zoom_subexpr(kind: str, a: float, b: float, amount: float, fps: float) -> str:
    """Per-frame zoom factor expression for one effect over [a, b] (edited-timeline
    seconds). Time is derived from the output frame index (on/fps) so it does not
    depend on ffmpeg's in_time being available. amount is a fraction (0.15 = 15%)."""
    t = f"(on/{fps:.6f})"
    span = max(0.01, b - a)
    if kind == "punch_in":
        return f"(1+{amount:.4f})"
    if kind == "zoom_out":
        return f"(1+{amount:.4f}*clip(({b:.3f}-{t})/{span:.3f},0,1))"
    # zoom_in (default Ken Burns)
    return f"(1+{amount:.4f}*clip(({t}-{a:.3f})/{span:.3f},0,1))"


def build_visual_filtergraph(
    effects: list[dict[str, Any]],
    color: Optional[str],
    width: int,
    height: int,
    fps: float,
) -> Optional[str]:
    """Compose the colour + zoom filtergraph for a single re-encode pass.

    Returns a -vf string, or None if there is nothing to do. Colour is applied
    first (correct the whole frame), then zoom (emphasise a region of the
    corrected frame). Zoom uses zoompan with d=1 + fps=<source fps> so the output
    has exactly one frame per input frame — duration and A/V sync are preserved.
    """
    parts: list[str] = []

    if color:
        preset = _COLOR_PRESETS.get(str(color).lower())
        if preset:
            parts.append(preset)

    zoom_effects = []
    for e in effects or []:
        kind = str(e.get("type", "")).lower()
        if kind not in _ZOOM_TYPES:
            continue
        try:
            a = float(e.get("start", 0))
            b = float(e.get("end", 0))
            amount = float(e.get("amount", 0.15))
        except (TypeError, ValueError):
            continue
        if b <= a:
            continue
        # Clamp the zoom amount to a sane, non-nauseating range.
        amount = max(0.03, min(0.6, amount))
        zoom_effects.append((a, b, kind, amount))

    if zoom_effects:
        zoom_effects.sort()
        # Nest the intervals: last-listed becomes the innermost fallback so the
        # first matching interval wins. Base factor 1.0 (no zoom).
        expr = "1"
        for a, b, kind, amount in reversed(zoom_effects):
            sub = _zoom_subexpr(kind, a, b, amount, fps)
            expr = f"if(between(on/{fps:.6f},{a:.3f},{b:.3f}),{sub},{expr})"
        w = width - (width % 2)
        h = height - (height % 2)
        parts.append(
            f"zoompan=z='{expr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':"
            f"d=1:fps={fps:.6f}:s={w}x{h}"
        )
        parts.append("setsar=1")

    if not parts:
        return None
    return ",".join(parts)


def probe_fps(video_path: str) -> float:
    """Average frame rate as a float (fallback 30.0)."""
    try:
        out = _run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=avg_frame_rate",
            "-of", "default=noprint_wrappers=1:nokey=1", video_path,
        ], timeout=30)
        raw = out.stdout.decode().strip()
        if "/" in raw:
            num, den = raw.split("/", 1)
            den_f = float(den)
            return (float(num) / den_f) if den_f else 30.0
        return float(raw) if raw else 30.0
    except Exception:
        return 30.0


def probe_resolution(video_path: str) -> tuple[int, int]:
    try:
        out = _run([
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0", video_path,
        ], timeout=30)
        w, h = out.stdout.decode().strip().split("x")
        return int(w), int(h)
    except Exception:
        return 1080, 1920


# ── PHASE 2: scene-aware cut points ──────────────────────────────────────────

def detect_scene_changes(video_path: str, threshold: float = 0.30) -> list[float]:
    """Timestamps (seconds, in this file's timeline) where the picture changes
    hard enough to read as a real cut. Uses select='gt(scene,thr)' + showinfo.
    A visual pass — run only on the short clip being edited, never the source."""
    try:
        proc = _run([
            "ffmpeg", "-hide_banner", "-nostats", "-i", video_path,
            "-vf", f"select='gt(scene,{threshold})',showinfo",
            "-an", "-f", "null", "-",
        ])
    except Exception as err:  # noqa: BLE001
        print(f"[edit] scene detection failed: {type(err).__name__}: {err}")
        return []
    text = proc.stderr.decode("utf-8", "replace")
    times = sorted({round(float(m.group(1)), 2) for m in _PTS_RE.finditer(text)})
    return times


def snap_cuts_to_scenes(
    cuts: list[list[float]],
    scenes: list[float],
    window: float = 0.75,
) -> list[list[float]]:
    """Nudge each cut boundary to the nearest scene change within `window`
    seconds, so a removed section starts/ends on a real visual cut instead of an
    arbitrary frame. Boundaries with no nearby scene change are left untouched."""
    if not scenes:
        return cuts
    def snap(v: float) -> float:
        near = min(scenes, key=lambda s: abs(s - v))
        return round(near, 2) if abs(near - v) <= window else v
    snapped = []
    for c in cuts:
        s, e = snap(float(c[0])), snap(float(c[1]))
        if e - s > 0.05:
            snapped.append([s, e])
    return snapped


# ── PHASE 2/3: dead-air tightening + blooper/filler classification ───────────

def classify_pauses(
    pauses: list[dict[str, float]],
    lines: list[dict[str, Any]],
    max_keep_gap: float,
) -> dict[str, Any]:
    """Split detected pauses into KEEP (intentional/dramatic) and CUT (dead air).

    A pause reads as an intentional beat — and is KEPT — when it is short-ish
    (≤ max_keep_gap) and lands right after a sentence-final word (., !, ?). Those
    are the dramatic pauses that make a delivery land. A pause is dead air — and
    becomes a CUT candidate — when it is long, or falls mid-sentence (a stumble,
    a lost train of thought, a reset). Filler-only caption lines are also flagged.
    """
    def ends_sentence_before(t: float) -> bool:
        # Did the last spoken word before this pause finish a sentence?
        best_text = ""
        best_end = -1.0
        for ln in lines or []:
            try:
                le = float(ln.get("end", 0))
            except (TypeError, ValueError):
                continue
            if le <= t + 0.05 and le > best_end:
                best_end = le
                best_text = str(ln.get("text", ""))
        return bool(best_text.strip()[-1:] in ".!?…") if best_text.strip() else False

    keep: list[dict[str, float]] = []
    cut: list[dict[str, float]] = []
    for p in pauses or []:
        dur = float(p.get("dur", 0))
        start = float(p.get("start", 0))
        dramatic = dur <= max_keep_gap and ends_sentence_before(start)
        (keep if dramatic else cut).append(p)

    fillers: list[dict[str, Any]] = []
    for ln in lines or []:
        text = str(ln.get("text", ""))
        if _FILLER_RE.match(text):
            try:
                fillers.append({"start": float(ln.get("start", 0)), "end": float(ln.get("end", 0)), "text": text})
            except (TypeError, ValueError):
                continue

    return {"keep": keep, "cut": cut, "fillers": fillers}


def deadair_cuts_from_pauses(
    cut_pauses: list[dict[str, float]],
    t_start: float,
    t_end: float,
    handle: float = 0.12,
) -> list[list[float]]:
    """Turn dead-air pauses into REMOVE intervals in the source timeline.

    Leaves a small `handle` of silence on each side so speech is never clipped
    and the join doesn't sound abrupt. Only pauses fully inside [t_start, t_end]
    are considered."""
    cuts: list[list[float]] = []
    for p in cut_pauses or []:
        s = float(p.get("start", 0)) + handle
        e = float(p.get("end", 0)) - handle
        s = max(s, t_start)
        e = min(e, t_end)
        if e - s > 0.15:  # only bother removing a meaningful gap
            cuts.append([round(s, 2), round(e, 2)])
    return cuts


def merge_intervals(intervals: list[list[float]]) -> list[list[float]]:
    """Union overlapping/adjacent REMOVE intervals. Removing sections is
    commutative, so overlaps are unambiguous — merge rather than reject."""
    if not intervals:
        return []
    ordered = sorted([[float(a), float(b)] for a, b in intervals])
    merged = [ordered[0]]
    for s, e in ordered[1:]:
        if s <= merged[-1][1] + 0.01:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged
