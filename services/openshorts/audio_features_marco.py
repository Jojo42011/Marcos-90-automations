"""
Marco Puga Realty — ffmpeg-only prosody / audio-feature extraction.

Claude cannot hear audio. This module extracts the *objective* vocal-delivery
signals ffmpeg CAN measure from the source video, so the clip-selection AI can
reason about HOW something was said (emphasis, pace, pauses), not only the words:

  • pauses  — silencedetect          → where the speaker stops (natural cut points)
  • energy  — astats RMS per window  → where the speaker is loud/emphatic vs flat
  • pace    — word timestamps        → where delivery speeds up / slows down

There are NO new dependencies here — only /usr/bin/ffmpeg (already required for
every clip). Everything is best-effort: any failure returns empty/None and the
caller proceeds exactly as before, so prosody can NEVER break a clip job. What
this deliberately does NOT do: pitch / F0 / emotion classification — that needs
a heavy DSP dependency (librosa) the project chose not to add, and inferring
"emotion" from pitch is unreliable anyway. We stick to signals ffmpeg measures
directly and let the language model interpret them alongside the transcript.
"""
from __future__ import annotations

import os
import re
import subprocess
from typing import Any, Optional

# Bound every probe so a pathological file can never hang a clip job. Audio-only
# passes (-vn) over a 60-min walkthrough are cheap, but a hard ceiling is safety.
_PROBE_TIMEOUT_S = int(os.environ.get("PROSODY_PROBE_TIMEOUT_S", "180"))
# Analysis sample rate — resample so window sizing is deterministic regardless of
# the source's native rate.
_SR = 44100

_SILENCE_START_RE = re.compile(r"silence_start:\s*([0-9.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)")
_PTS_RE = re.compile(r"pts_time:([0-9.]+)")
_RMS_RE = re.compile(r"lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+|-?inf|nan)", re.IGNORECASE)


def _run(cmd: list[str], timeout: int = _PROBE_TIMEOUT_S) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


def detect_pauses(
    video_path: str,
    noise_db: float = -30.0,
    min_silence_s: float = 0.45,
) -> list[dict[str, float]]:
    """Silence intervals via ffmpeg silencedetect (audio-only pass).

    Returns [{"start", "end", "dur"}] sorted by start. A pause is a natural
    place to start/end a clip or to tighten dead air — the AI is told about the
    longer ones so it can set clip boundaries on speech, not mid-breath.
    """
    try:
        proc = _run([
            "ffmpeg", "-hide_banner", "-nostats", "-vn", "-i", video_path,
            "-af", f"silencedetect=noise={noise_db}dB:d={min_silence_s}",
            "-f", "null", "-",
        ])
    except Exception as err:  # noqa: BLE001 — best-effort, never fatal
        print(f"[prosody] silencedetect failed: {type(err).__name__}: {err}")
        return []

    text = proc.stderr.decode("utf-8", "replace")
    pauses: list[dict[str, float]] = []
    pending_start: Optional[float] = None
    for line in text.splitlines():
        m_start = _SILENCE_START_RE.search(line)
        if m_start:
            pending_start = float(m_start.group(1))
            continue
        m_end = _SILENCE_END_RE.search(line)
        if m_end:
            end = float(m_end.group(1))
            dur = float(m_end.group(2))
            start = pending_start if pending_start is not None else max(0.0, end - dur)
            pauses.append({"start": round(start, 2), "end": round(end, 2), "dur": round(dur, 2)})
            pending_start = None
    pauses.sort(key=lambda p: p["start"])
    return pauses


def energy_windows(video_path: str, window_s: float = 1.0) -> list[dict[str, float]]:
    """Per-window RMS level (dBFS, ≤0; higher = louder) via astats.

    asetnsamples slices the decoded audio into fixed windows so astats+ametadata
    print one RMS reading per window with its pts_time. Loud windows are where
    the speaker leans in — the emphatic beats a good hook lands on.
    """
    n = max(1, int(_SR * max(0.25, window_s)))
    graph = (
        f"aresample={_SR},"
        f"asetnsamples=n={n}:p=0,"
        f"astats=metadata=1:reset=1,"
        f"ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-"
    )
    try:
        proc = _run([
            "ffmpeg", "-hide_banner", "-nostats", "-vn", "-i", video_path,
            "-af", graph, "-f", "null", "-",
        ])
    except Exception as err:  # noqa: BLE001
        print(f"[prosody] astats energy pass failed: {type(err).__name__}: {err}")
        return []

    out = proc.stdout.decode("utf-8", "replace")
    windows: list[dict[str, float]] = []
    cur_t: Optional[float] = None
    for line in out.splitlines():
        m_pts = _PTS_RE.search(line)
        if m_pts:
            cur_t = float(m_pts.group(1))
            continue
        m_rms = _RMS_RE.search(line)
        if m_rms and cur_t is not None:
            raw = m_rms.group(1).lower()
            # "-inf"/"nan" == pure silence; record as a very low floor so it reads
            # as a dip, not a gap.
            rms = -90.0 if raw in ("-inf", "nan") else float(raw)
            windows.append({"t": round(cur_t, 2), "rms_db": round(rms, 2)})
            cur_t = None
    return windows


def pace_windows(segments: list[dict[str, Any]], window_s: float = 3.0) -> list[dict[str, float]]:
    """Words-per-second over fixed windows, from whisper word timestamps.

    No ffmpeg — the transcript already carries per-word start times. Fast, clear
    delivery vs rambling shows up here; the sweet-spot clips tend to sit on the
    faster, punchier stretches.
    """
    starts: list[float] = []
    for seg in segments or []:
        for w in seg.get("words") or []:
            ws = w.get("start")
            if isinstance(ws, (int, float)):
                starts.append(float(ws))
    if not starts:
        return []
    starts.sort()
    end = starts[-1]
    win = max(1.0, window_s)
    buckets: dict[int, int] = {}
    for s in starts:
        buckets[int(s // win)] = buckets.get(int(s // win), 0) + 1
    windows: list[dict[str, float]] = []
    n_windows = int(end // win) + 1
    for i in range(n_windows):
        count = buckets.get(i, 0)
        windows.append({"t": round(i * win, 2), "wps": round(count / win, 2)})
    return windows


def analyze_prosody(
    video_path: str,
    transcript: dict[str, Any],
    video_duration: float,
) -> dict[str, Any]:
    """Bundle pauses + energy + pace into one compact prosody map.

    Returns a dict that is always safe to consume (empty lists on any failure).
    Also derives the *interesting* moments — energy peaks (emphasis) and dips —
    relative to the clip's own mean, since absolute dBFS means little on its own.
    """
    result: dict[str, Any] = {
        "duration": round(video_duration, 1) if video_duration else None,
        "pauses": [],
        "energy": {"mean_rms_db": None, "peaks": [], "dips": []},
        "pace": {"mean_wps": None, "fast": [], "slow": []},
        "available": False,
    }
    if not video_path or not os.path.isfile(video_path):
        return result

    pauses = detect_pauses(video_path)
    energy = energy_windows(video_path)
    pace = pace_windows((transcript or {}).get("segments", []))

    result["pauses"] = pauses

    if energy:
        vals = [w["rms_db"] for w in energy]
        mean_rms = sum(vals) / len(vals)
        result["energy"]["mean_rms_db"] = round(mean_rms, 2)
        # Peaks = windows a real margin above the mean (emphatic delivery).
        peaks = sorted(
            (w for w in energy if w["rms_db"] >= mean_rms + 3.0),
            key=lambda w: w["rms_db"],
            reverse=True,
        )
        dips = sorted(
            (w for w in energy if w["rms_db"] <= mean_rms - 6.0),
            key=lambda w: w["rms_db"],
        )
        result["energy"]["peaks"] = [w["t"] for w in peaks[:10]]
        result["energy"]["dips"] = [w["t"] for w in dips[:10]]

    if pace:
        pvals = [w["wps"] for w in pace]
        mean_wps = sum(pvals) / len(pvals)
        result["pace"]["mean_wps"] = round(mean_wps, 2)
        result["pace"]["fast"] = [w["t"] for w in pace if w["wps"] >= mean_wps * 1.3][:10]
        result["pace"]["slow"] = [
            w["t"] for w in pace if w["wps"] <= mean_wps * 0.6 and w["wps"] > 0
        ][:10]

    result["available"] = bool(pauses or energy or pace)
    return result


def _fmt_times(times: list[float], limit: int = 8) -> str:
    if not times:
        return "none detected"
    shown = ", ".join(f"{t:.0f}s" for t in sorted(times)[:limit])
    if len(times) > limit:
        shown += f", … (+{len(times) - limit} more)"
    return shown


def prosody_prompt_block(prosody: dict[str, Any]) -> str:
    """Render the prosody map as a compact brief for the clip-selection prompt.

    Kept short and interpretive — the model gets the *signal*, not a data dump,
    and clear instructions on what each signal implies for clip choice.
    """
    if not prosody or not prosody.get("available"):
        return ""

    energy = prosody.get("energy", {})
    pace = prosody.get("pace", {})
    pauses = prosody.get("pauses", [])
    long_pauses = [p for p in pauses if p.get("dur", 0) >= 0.7]

    mean_wps = pace.get("mean_wps")
    pace_desc = ""
    if mean_wps is not None:
        wpm = mean_wps * 60
        if wpm >= 170:
            pace_desc = f"fast overall (~{wpm:.0f} wpm)"
        elif wpm <= 110:
            pace_desc = f"slow/deliberate overall (~{wpm:.0f} wpm)"
        else:
            pace_desc = f"steady (~{wpm:.0f} wpm)"

    lines = [
        "",
        "VOCAL-DELIVERY SIGNALS (measured from the audio — use these ALONGSIDE the words):",
        "These are objective ffmpeg measurements, not guesses. Weight them when choosing clips.",
    ]
    if pace_desc:
        lines.append(f"- Pace: {pace_desc}.")
    if energy.get("peaks"):
        lines.append(
            f"- Emphasis peaks (speaker is loud/leaning in) around: {_fmt_times(energy['peaks'])}. "
            "The strongest hooks usually sit ON or JUST BEFORE these beats."
        )
    if pace.get("fast"):
        lines.append(
            f"- Punchiest / fastest delivery around: {_fmt_times(pace['fast'])}."
        )
    if long_pauses:
        pause_ts = [p["start"] for p in long_pauses]
        lines.append(
            f"- Notable pauses (natural clip boundaries — start/end clips here, not mid-breath): "
            f"{_fmt_times(pause_ts)}."
        )
    lines.append(
        "Guidance: open clips on an emphasis peak or a punchy stretch; set the clip's "
        "start and end on natural pauses so it never begins or ends mid-sentence; avoid "
        "long flat/low-energy stretches unless the words themselves carry the moment."
    )
    lines.append("")
    return "\n".join(lines)
