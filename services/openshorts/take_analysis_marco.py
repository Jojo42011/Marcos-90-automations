"""
Marco Puga Realty — repeated-take detection + best-take selection by tonality.

Marco often re-records the same line several times back-to-back ("take 3 —
that's the one"). The raw footage therefore contains near-duplicate stretches,
and a professional edit keeps exactly one: the take with the best delivery.

This module finds those duplicate takes from the whisper transcript (fuzzy
text similarity between nearby segments) and scores each take's DELIVERY using
the ffmpeg-only prosody signals the pipeline already extracts:

  • energy    — mean RMS over the take (louder, leaned-in delivery wins)
  • liveliness— RMS variation inside the take (monotone reads score low)
  • pace      — words/sec sweet spot (~2.4-3.2 wps reads confident, not rushed)
  • fluency   — filler words ("um", "uh", "like,") and restarts penalised

The scores stay heuristic on purpose — no ML dependency, fully explainable —
and the LLM gets the map as a brief, so the final clip choice still weighs
CONTENT, with inferior takes marked as do-not-use ranges.

Best-effort by contract: bad/missing input → {"available": False} and the
pipeline behaves exactly as before.
"""
from __future__ import annotations

import os
import re
from difflib import SequenceMatcher
from typing import Any

# Two segments are the same "take" when their normalised text is at least this
# similar. 0.72 tolerates re-phrasings ("DM me the word HOUSE" vs "DM me HOUSE").
_SIMILARITY = float(os.environ.get("OPENSHORTS_TAKE_SIMILARITY", "0.72"))
# Retakes happen close together — only compare segments within this window.
_MAX_GAP_S = float(os.environ.get("OPENSHORTS_TAKE_MAX_GAP_S", "90"))
# Ignore tiny fragments; matching "okay" against "okay" is noise, not a retake.
_MIN_WORDS = int(os.environ.get("OPENSHORTS_TAKE_MIN_WORDS", "5"))

_FILLERS = re.compile(r"\b(um+|uh+|erm+|hmm+|like,|you know,)\b", re.IGNORECASE)
_NORM = re.compile(r"[^a-z0-9 ]+")


def _normalize(text: str) -> str:
    return _NORM.sub("", (text or "").lower()).strip()


def _seg_view(seg: dict[str, Any]) -> dict[str, Any] | None:
    text = (seg.get("text") or "").strip()
    start, end = seg.get("start"), seg.get("end")
    if not text or start is None or end is None or float(end) <= float(start):
        return None
    norm = _normalize(text)
    words = norm.split()
    if len(words) < _MIN_WORDS:
        return None
    return {"start": float(start), "end": float(end), "text": text, "norm": norm, "n_words": len(words)}


def _take_score(view: dict[str, Any], energy_windows: list[dict[str, float]]) -> dict[str, float]:
    """Delivery ("tonality") score 0-100 for one take, from measurable signals."""
    dur = max(0.2, view["end"] - view["start"])

    rms_vals = [
        w["rms_db"] for w in energy_windows or []
        if view["start"] - 0.5 <= w.get("t", -1) <= view["end"] + 0.5
    ]
    # Energy: -35dBFS (quiet) → 0 pts … -12dBFS (strong) → 40 pts
    if rms_vals:
        mean_rms = sum(rms_vals) / len(rms_vals)
        energy_pts = max(0.0, min(40.0, (mean_rms + 35.0) * (40.0 / 23.0)))
        spread = (max(rms_vals) - min(rms_vals)) if len(rms_vals) > 1 else 0.0
        # Liveliness: some dynamic range is good delivery; dead-flat is monotone.
        lively_pts = max(0.0, min(20.0, spread * (20.0 / 8.0)))
    else:
        mean_rms, energy_pts, lively_pts = None, 20.0, 10.0  # neutral when unmeasurable

    # Pace: 2.4-3.2 words/sec is the confident-delivery sweet spot.
    wps = view["n_words"] / dur
    if 2.4 <= wps <= 3.2:
        pace_pts = 25.0
    else:
        pace_pts = max(0.0, 25.0 - abs(wps - 2.8) * 12.0)

    # Fluency: each filler costs 5 of 15 points.
    fillers = len(_FILLERS.findall(view["text"]))
    fluency_pts = max(0.0, 15.0 - fillers * 5.0)

    total = round(energy_pts + lively_pts + pace_pts + fluency_pts, 1)
    return {
        "score": total,
        "mean_rms_db": round(mean_rms, 1) if mean_rms is not None else None,
        "wps": round(wps, 2),
        "fillers": fillers,
    }


def detect_retakes(
    segments: list[dict[str, Any]],
    energy_windows: list[dict[str, float]] | None = None,
) -> dict[str, Any]:
    """Group near-duplicate transcript segments into takes; score each; pick winners.

    Returns {"available": bool, "groups": [
        {"text": str, "takes": [{"start","end","score","wps","fillers","best"}...],
         "best_index": int}
    ], "inferior_spans": [[start, end]...]}   (absolute source-video seconds)
    """
    result: dict[str, Any] = {"available": False, "groups": [], "inferior_spans": []}
    views = [v for v in (_seg_view(s) for s in segments or []) if v]
    if len(views) < 2:
        return result

    # Union-find-lite: group segments whose text matches within the time window.
    group_of: dict[int, int] = {}
    groups: dict[int, list[int]] = {}
    next_group = 0
    for i in range(len(views)):
        for j in range(i + 1, len(views)):
            if views[j]["start"] - views[i]["end"] > _MAX_GAP_S:
                break
            # Cheap length pre-filter before the quadratic ratio.
            if abs(views[i]["n_words"] - views[j]["n_words"]) > max(4, views[i]["n_words"] // 2):
                continue
            if SequenceMatcher(None, views[i]["norm"], views[j]["norm"]).ratio() >= _SIMILARITY:
                gi = group_of.get(i)
                gj = group_of.get(j)
                if gi is None and gj is None:
                    group_of[i] = group_of[j] = next_group
                    groups[next_group] = [i, j]
                    next_group += 1
                elif gi is not None and gj is None:
                    group_of[j] = gi
                    groups[gi].append(j)
                elif gj is not None and gi is None:
                    group_of[i] = gj
                    groups[gj].append(i)

    out_groups: list[dict[str, Any]] = []
    inferior: list[list[float]] = []
    for members in groups.values():
        members = sorted(set(members), key=lambda k: views[k]["start"])
        if len(members) < 2:
            continue
        takes = []
        for k in members:
            v = views[k]
            s = _take_score(v, energy_windows or [])
            takes.append({
                "start": round(v["start"], 2),
                "end": round(v["end"], 2),
                **s,
                "best": False,
            })
        best_i = max(range(len(takes)), key=lambda idx: takes[idx]["score"])
        takes[best_i]["best"] = True
        for idx, t in enumerate(takes):
            if idx != best_i:
                inferior.append([t["start"], t["end"]])
        out_groups.append({
            "text": views[members[0]]["text"][:120],
            "takes": takes,
            "best_index": best_i,
        })

    inferior.sort()
    result.update(available=bool(out_groups), groups=out_groups, inferior_spans=inferior)
    return result


def retake_prompt_block(retakes: dict[str, Any]) -> str:
    """Compact best-take brief for the clip-selection prompt."""
    if not retakes or not retakes.get("available"):
        return ""
    lines = [
        "",
        "REPEATED-TAKE MAP (the speaker recorded the same line multiple times — "
        "delivery was scored from the audio; use ONLY the best take):",
    ]
    for g in retakes["groups"][:8]:
        take_bits = []
        for t in g["takes"]:
            tag = "BEST" if t["best"] else "inferior"
            take_bits.append(f"{t['start']:.0f}-{t['end']:.0f}s ({tag}, delivery {t['score']:.0f}/100)")
        lines.append(f'- "{g["text"]}": {"; ".join(take_bits)}')
    lines.append(
        "Guidance: never place a clip inside an inferior take — the same words exist "
        "with better delivery in the BEST take. Inferior takes overlapping a chosen "
        "clip will be cut automatically, so build clips around the BEST takes."
    )
    lines.append("")
    return "\n".join(lines)


def inferior_cut_candidates(
    retakes: dict[str, Any],
    clip_start: float,
    clip_end: float,
) -> list[tuple[float, float]]:
    """Inferior-take spans overlapping [clip_start, clip_end], CLIP-LOCAL time."""
    if not retakes or not retakes.get("available"):
        return []
    out: list[tuple[float, float]] = []
    for s, e in retakes.get("inferior_spans", []):
        cs = max(float(s), clip_start)
        ce = min(float(e), clip_end)
        if ce - cs >= 0.4:
            out.append((round(cs - clip_start, 2), round(ce - clip_start, 2)))
    return out
