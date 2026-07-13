"""
Marco Puga Realty — repeated-take detection + last-take selection.

Marco often re-records the same line several times back-to-back ("take 3 —
that's the one"). The raw footage therefore contains near-duplicate stretches,
and a professional edit keeps exactly one: the LAST take Marco recorded.

Marco's workflow: the final time he says a line is always the keeper — he
intentionally re-records until he's happy, so the last occurrence is by
definition the approved version. Delivery scoring is still computed for the
LLM brief (context only), but the LAST take in time wins.

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
# Verbatim word-run repeat detector (below): minimum run length to count as a
# real repeat, not a coincidental short phrase match.
_MIN_REPEAT_WORDS = int(os.environ.get("OPENSHORTS_TAKE_MIN_REPEAT_WORDS", "3"))

_FILLERS = re.compile(r"\b(um+|uh+|erm+|hmm+|like,|you know,)\b", re.IGNORECASE)
_NORM = re.compile(r"[^a-z0-9 ]+")
_SENTENCE_END = re.compile(r'[.!?]+["\')\]]*$')
# A gap this long inside continuous speech reads as a hard break (new thought,
# or the start of a fresh take) even with no terminal punctuation — Whisper
# sometimes drops punctuation on a re-take that trails off.
_SENTENCE_PAUSE_S = 1.5


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


def _flatten_words(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """All words across all segments, time-ordered, each with a normalized form."""
    words: list[dict[str, Any]] = []
    for seg in segments or []:
        for w in seg.get("words") or []:
            text = (w.get("word") or "").strip()
            start, end = w.get("start"), w.get("end")
            if not text or start is None or end is None:
                continue
            words.append({"text": text, "start": float(start), "end": float(end), "norm": _normalize(text)})
    words.sort(key=lambda w: w["start"])
    return words


def _find_repeated_word_runs(
    words: list[dict[str, Any]],
    min_words: int = _MIN_REPEAT_WORDS,
    max_gap_s: float = _MAX_GAP_S,
) -> list[tuple[int, int, int, int]]:
    """Verbatim-repeated word runs anywhere in continuous speech.

    Catches a mid-utterance stumble/restart ("week three silent week three
    silent") that sentence-level comparison can't see because there is no
    punctuation or pause between the two deliveries at all — this scans the
    raw word stream directly, independent of any sentence/segment boundary.

    Returns non-overlapping (earlier_start, earlier_end, later_start,
    later_end) WORD-INDEX ranges (end exclusive), longest/most-confident
    matches preferred when candidates overlap.
    """
    n = len(words)
    norms = [w["norm"] for w in words]
    candidates: list[tuple[int, int, int, int, int]] = []
    for i in range(n):
        if not norms[i]:
            continue
        for j in range(i + 1, n):
            if words[j]["start"] - words[i]["end"] > max_gap_s:
                break
            if norms[j] != norms[i]:
                continue
            k = 0
            while i + k < j and j + k < n and norms[i + k] and norms[i + k] == norms[j + k]:
                k += 1
            if k < min_words:
                continue
            # Require at least two real content words (4+ chars) in the run so
            # a coincidental run of short function words ("in the a") can't
            # trigger a cut — "week three silent" or "san antonio" qualify.
            content_words = sum(1 for w in norms[i:i + k] if len(w) >= 4)
            if content_words < 2:
                continue
            candidates.append((i, i + k, j, j + k, k))

    # Greedy non-max suppression: longest runs first. An "earlier/cut" range
    # can never overlap anything already claimed (cut or kept) — one word run
    # can't be both a stumble and part of the final take. But a "later/keep"
    # range MAY be referenced by more than one earlier duplicate: if Marco
    # stumbles twice before landing the clean version ("...watch. I watched
    # sellers... $60k...transaction." — a false start, THEN the same phrase
    # again as the real take), both earlier occurrences point at the same
    # final keeper, and both should be cut. Only forbid a "later" range from
    # overlapping something already marked CUT (a keeper can't itself be
    # inside removed content).
    candidates.sort(key=lambda c: -c[4])
    taken_cut: list[tuple[int, int]] = []
    taken_keep: list[tuple[int, int]] = []
    accepted: list[tuple[int, int, int, int]] = []

    def overlaps(a0: int, a1: int, ranges: list[tuple[int, int]]) -> bool:
        return any(not (a1 <= t0 or a0 >= t1) for t0, t1 in ranges)

    for i0, i1, j0, j1, _k in candidates:
        if overlaps(i0, i1, taken_cut) or overlaps(i0, i1, taken_keep):
            continue
        if overlaps(j0, j1, taken_cut):
            continue
        taken_cut.append((i0, i1))
        taken_keep.append((j0, j1))
        accepted.append((i0, i1, j0, j1))
    return accepted


def _snap_to_sentences(
    start: float,
    end: float,
    sentence_views: list[dict[str, Any]],
) -> tuple[float, float]:
    """Extend [start, end] to cover every sentence it overlaps.

    A verbatim word-run match often covers only PART of the sentence it's in
    (the surrounding wording differs even though a long stretch matches
    exactly). Cutting just the matched words leaves a broken remnant of the
    sentence behind (e.g. "I watched one seller lose" with no completion).
    Snapping to whole sentences guarantees every cut/keep span is a complete
    thought, never a fragment.
    """
    overlapping = [s for s in sentence_views if s["start"] < end and s["end"] > start]
    if not overlapping:
        return start, end
    return min(s["start"] for s in overlapping), max(s["end"] for s in overlapping)


def _repeated_run_views(
    segments: list[dict[str, Any]],
    sentence_views: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[list[float]]]:
    """Groups + inferior spans from verbatim word-run repeats, in the same
    shape _match_views produces, so detect_retakes can union it in directly.

    Each match is snapped outward to its enclosing sentence(s) — see
    _snap_to_sentences — so a partial-word match never leaves a broken
    sentence fragment on either side of the cut.
    """
    words = _flatten_words(segments)
    if len(words) < _MIN_REPEAT_WORDS * 2:
        return [], []
    runs = _find_repeated_word_runs(words)
    out_groups: list[dict[str, Any]] = []
    inferior: list[list[float]] = []
    for i0, i1, j0, j1 in runs:
        e_start, e_end = _snap_to_sentences(words[i0]["start"], words[i1 - 1]["end"], sentence_views)
        l_start, l_end = _snap_to_sentences(words[j0]["start"], words[j1 - 1]["end"], sentence_views)
        if e_end > l_start:
            continue  # snapping made the two spans overlap — skip, too ambiguous to cut safely
        text = " ".join(w["text"] for w in words[i0:i1])
        out_groups.append({
            "text": text[:120],
            "takes": [
                {"start": round(e_start, 2), "end": round(e_end, 2), "score": None, "best": False},
                {"start": round(l_start, 2), "end": round(l_end, 2), "score": None, "best": True},
            ],
            "best_index": 1,
        })
        inferior.append([e_start, e_end])
    return out_groups, inferior


def _sentences_from_words(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Reconstruct sentence-level views from WORD timestamps, ignoring Whisper's
    own segment boundaries.

    Whisper chunks `segments` by its own pause heuristics, which shift between
    two takes of the same line — take 1 might pause after "transaction" while
    take 2 runs straight through into the next clause. Comparing whole
    segments then misses the retake entirely because no single segment in
    take 1 lines up with any single segment in take 2. Sentences reconstructed
    from word-level timestamps are far more stable across retakes: Marco
    re-says roughly the same SENTENCE, not the same arbitrary whisper chunk.

    Returns views in the same shape as _seg_view (start/end/text/norm/n_words),
    unfiltered by _MIN_WORDS — callers that need that floor apply it themselves.
    """
    words: list[dict[str, Any]] = []
    for seg in segments or []:
        for w in seg.get("words") or []:
            text = (w.get("word") or "").strip()
            start, end = w.get("start"), w.get("end")
            if not text or start is None or end is None:
                continue
            words.append({"text": text, "start": float(start), "end": float(end)})
    if not words:
        return []
    words.sort(key=lambda w: w["start"])

    sentences: list[list[dict[str, Any]]] = []
    current: list[dict[str, Any]] = []
    prev_end: float | None = None
    for w in words:
        if current and prev_end is not None and w["start"] - prev_end > _SENTENCE_PAUSE_S:
            sentences.append(current)
            current = []
        current.append(w)
        prev_end = w["end"]
        if _SENTENCE_END.search(w["text"]):
            sentences.append(current)
            current = []
    if current:
        sentences.append(current)

    views: list[dict[str, Any]] = []
    for sent in sentences:
        if not sent:
            continue
        text = " ".join(w["text"] for w in sent)
        norm = _normalize(text)
        n_words = len(norm.split())
        if n_words == 0:
            continue
        views.append({
            "start": sent[0]["start"],
            "end": sent[-1]["end"],
            "text": text,
            "norm": norm,
            "n_words": n_words,
        })
    return views


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


def _match_views(
    views: list[dict[str, Any]],
    energy_windows: list[dict[str, float]] | None,
) -> tuple[list[dict[str, Any]], list[list[float]]]:
    """Core near-duplicate grouping, shared across granularities (sentence and
    paragraph). Groups views whose normalized text matches within the time
    window, scores each member, keeps the LAST as the keeper. Returns
    (groups, inferior_spans)."""
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
        # Always keep the LAST take — Marco's workflow is to re-record until
        # satisfied, so the final occurrence is the approved delivery.
        best_i = len(takes) - 1
        takes[best_i]["best"] = True
        for idx, t in enumerate(takes):
            if idx != best_i:
                inferior.append([t["start"], t["end"]])
        out_groups.append({
            "text": views[members[0]]["text"][:120],
            "takes": takes,
            "best_index": best_i,
        })
    return out_groups, inferior


def _merge_spans(spans: list[list[float]]) -> list[list[float]]:
    """Union overlapping/adjacent [start, end] spans."""
    if not spans:
        return []
    ordered = sorted((float(a), float(b)) for a, b in spans)
    merged = [list(ordered[0])]
    for s, e in ordered[1:]:
        if s <= merged[-1][1] + 0.05:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return merged


def detect_retakes(
    segments: list[dict[str, Any]],
    energy_windows: list[dict[str, float]] | None = None,
) -> dict[str, Any]:
    """Group near-duplicate transcript stretches into takes; score each; pick
    winners. Runs TWO complementary detectors and unions the results:

      • sentence-level fuzzy match (reconstructed from word timestamps, not
        Whisper's own segments — those shift between takes and cause misses):
        catches a PARAPHRASED retake ("lose 20 even $40,000" restated later as
        "$20,000, $40,000, even $60,000") that lines up at sentence boundaries.
      • verbatim word-run repeat scan: catches a mid-utterance stumble/restart
        ("week three silent week three silent") with NO pause or punctuation
        between the two deliveries at all — sentence comparison can't see it
        because there's no boundary to split on, so this scans the raw word
        stream directly for repeated runs regardless of sentence structure.

    Falls back to Whisper's raw segments only when word timestamps are
    unavailable entirely.

    Returns {"available": bool, "groups": [
        {"text": str, "takes": [{"start","end","score","best"}...],
         "best_index": int}
    ], "inferior_spans": [[start, end]...]}   (absolute source-video seconds)
    """
    result: dict[str, Any] = {"available": False, "groups": [], "inferior_spans": []}

    all_sentences = _sentences_from_words(segments)
    sentence_views = [v for v in all_sentences if v["n_words"] >= _MIN_WORDS]

    if not all_sentences:
        views = [v for v in (_seg_view(s) for s in segments or []) if v]
        if len(views) < 2:
            return result
        out_groups, inferior = _match_views(views, energy_windows)
    else:
        s_groups, s_inferior = _match_views(sentence_views, energy_windows) if len(sentence_views) >= 2 else ([], [])
        # _snap_to_sentences uses the FULL (unfiltered) sentence list — a
        # short interjection ("Yeah.") is still a real utterance boundary
        # even though it's too short to itself be a fuzzy-match candidate.
        r_groups, r_inferior = _repeated_run_views(segments, all_sentences)
        out_groups = s_groups + r_groups
        inferior = s_inferior + r_inferior

    if not out_groups:
        return result

    inferior_merged = _merge_spans(inferior)
    result.update(available=True, groups=out_groups, inferior_spans=inferior_merged)
    return result


def retake_prompt_block(retakes: dict[str, Any]) -> str:
    """Compact best-take brief for the clip-selection prompt."""
    if not retakes or not retakes.get("available"):
        return ""
    lines = [
        "",
        "REPEATED-TAKE MAP (the speaker recorded the same line multiple times — "
        "the LAST take is always the keeper; earlier takes will be cut automatically):",
    ]
    # The sentence-level and word-run detectors can independently rediscover
    # the same pairing — dedup by the (cut, keep) span signature so the LLM
    # doesn't see the same moment listed twice.
    seen_spans: set[tuple[float, float, float, float]] = set()
    shown = 0
    for g in retakes["groups"]:
        if shown >= 8:
            break
        key = (g["takes"][0]["start"], g["takes"][0]["end"], g["takes"][-1]["start"], g["takes"][-1]["end"])
        if key in seen_spans:
            continue
        seen_spans.add(key)
        shown += 1
        take_bits = []
        for t in g["takes"]:
            tag = "LAST (keeper)" if t["best"] else "earlier take"
            score_bit = f", delivery {t['score']:.0f}/100" if t.get("score") is not None else ""
            take_bits.append(f"{t['start']:.0f}-{t['end']:.0f}s ({tag}{score_bit})")
        lines.append(f'- "{g["text"]}": {"; ".join(take_bits)}')
    lines.append(
        "Guidance: never place a clip inside an earlier take — the LAST take is the "
        "approved delivery. Earlier takes overlapping a chosen clip will be cut "
        "automatically, so build clips around the LAST (keeper) takes."
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


# ── Blooper / off-script detection — profanity and break-character moments ──
# ("well I got a fucking script here, bro") must NEVER ship in a client-facing
# real estate video. Unlike gaze/dead-air cuts, these are a content-safety
# requirement, not a polish nicety: the caller treats blooper spans as
# MANDATORY removal, applied even when honoring them would shrink a clip
# below the normal story-flow floor.
_BLOOPER_RE = re.compile(
    r"\b(fuck(ing|ed|er)?|shit|bullshit|bitch|assh?ole|goddamn|dammit)\b"
    r"|\bgot a script\b"
    r"|\blet me start (that |this )?over\b"
    r"|\bscratch that\b"
    r"|\bcut that\b"
    r"|\bhold on,? (let me|i)\b"
    r"|\bwait,? sorry\b"
    r"|\b(one )?more time\b"
    r"|\blet'?s redo\b"
    r"|\bi'?ll redo\b"
    r"|\bstart (that |this )?again\b"
    r"|\btake two\b"
    r"|\bthat was (bad|terrible|awful|rough)\b",
    re.IGNORECASE,
)


# A neighboring sentence this short, sitting this close to a flagged blooper,
# reads as part of the same broken moment (e.g. "Well," ... [profanity] ...
# "Bro.") rather than independent content — swallow it into the cut so it
# doesn't survive as a dangling fragment.
_BLOOPER_NEIGHBOR_MAX_WORDS = 3
_BLOOPER_NEIGHBOR_MAX_GAP_S = 2.5


def detect_bloopers(segments: list[dict[str, Any]]) -> dict[str, Any]:
    """Sentence-level spans containing profanity or an off-script/break-
    character moment. Uses the same word-level sentence reconstruction as
    detect_retakes, so a blooper mid-segment is isolated to just its own
    sentence rather than the whole surrounding Whisper chunk. Short
    interjections immediately bookending a flagged sentence ("Well," ...
    "Bro.") are folded into the same span so they don't survive as orphaned
    fragments once the profanity between them is cut.

    Returns {"available": bool, "spans": [[start, end], ...]} in absolute
    source-video seconds. Best-effort: {"available": False} on any failure.
    """
    try:
        sentences = _sentences_from_words(segments)
        flagged_idx = {i for i, s in enumerate(sentences) if _BLOOPER_RE.search(s["text"])}
        spans: list[list[float]] = []
        for i in flagged_idx:
            start, end = sentences[i]["start"], sentences[i]["end"]
            # Extend backward/forward through short, close neighbors.
            j = i - 1
            while (
                j >= 0
                and sentences[j]["n_words"] <= _BLOOPER_NEIGHBOR_MAX_WORDS
                and start - sentences[j]["end"] <= _BLOOPER_NEIGHBOR_MAX_GAP_S
            ):
                start = sentences[j]["start"]
                j -= 1
            j = i + 1
            while (
                j < len(sentences)
                and sentences[j]["n_words"] <= _BLOOPER_NEIGHBOR_MAX_WORDS
                and sentences[j]["start"] - end <= _BLOOPER_NEIGHBOR_MAX_GAP_S
            ):
                end = sentences[j]["end"]
                j += 1
            spans.append([round(start, 2), round(end, 2)])
        spans = _merge_spans(spans)
        return {"available": bool(spans), "spans": spans}
    except Exception as err:  # noqa: BLE001 — best-effort, never fatal
        print(f"[take] blooper detection failed: {type(err).__name__}: {err}")
        return {"available": False, "spans": []}


def blooper_prompt_block(bloopers: dict[str, Any]) -> str:
    """Compact warning for the clip-selection prompt — defense in depth so the
    LLM avoids choosing bounds around a flagged moment in the first place."""
    if not bloopers or not bloopers.get("available"):
        return ""
    shown = ", ".join(f"{s:.0f}-{e:.0f}s" for s, e in bloopers["spans"][:8])
    return (
        "\nFLAGGED MOMENTS (profanity or off-script break, e.g. talking about the "
        f"script / asking to redo a take): {shown}. NEVER select a clip whose "
        "start/end includes one of these ranges — pick a different moment or a "
        "narrower window that excludes it entirely.\n"
    )


def blooper_cut_candidates(
    bloopers: dict[str, Any],
    clip_start: float,
    clip_end: float,
) -> list[tuple[float, float]]:
    """Blooper spans overlapping [clip_start, clip_end], CLIP-LOCAL time."""
    if not bloopers or not bloopers.get("available"):
        return []
    out: list[tuple[float, float]] = []
    for s, e in bloopers.get("spans", []):
        cs = max(float(s), clip_start)
        ce = min(float(e), clip_end)
        if ce - cs >= 0.2:
            out.append((round(cs - clip_start, 2), round(ce - clip_start, 2)))
    return out
