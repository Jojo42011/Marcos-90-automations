"""
Marco Puga Realty — optional Pexels B-roll overlay.

Overlays a short, contextually matched stock clip (Pexels free API) over the
middle of a generated clip while Marco keeps talking — his audio is untouched,
only the picture switches for ~2.5s. Topics are detected from the transcript
words inside the clip (neighborhood names, pools, construction, keys...), so
the footage matches what he is saying.

Entirely optional and dormant by default: requires PEXELS_API_KEY. Best-effort
by contract — any failure (no key, no results, download error, ffmpeg error)
leaves the clip untouched and returns False.

Placement rules:
  • never in the first 4s (the hook needs Marco's face on screen)
  • never in the last 4s (the CTA needs Marco's face on screen)
  • one overlay per clip, roughly mid-clip, ~2.5s
"""
from __future__ import annotations

import os
import subprocess
import uuid
from typing import Any, Optional

_TIMEOUT_S = int(os.environ.get("OPENSHORTS_FFMPEG_TIMEOUT_S", "180"))
_BROLL_DUR_S = float(os.environ.get("OPENSHORTS_BROLL_DUR_S", "2.5"))

# Topic → Pexels search query. First match against the clip transcript wins.
_TOPIC_QUERIES: list[tuple[list[str], str]] = [
    (["stone oak"], "luxury homes suburb aerial"),
    (["canyon lake"], "lake waterfront homes texas"),
    (["new braunfels"], "texas small town homes"),
    (["san antonio", "texas"], "san antonio texas city aerial"),
    (["pool", "backyard"], "luxury home swimming pool"),
    (["kitchen"], "modern kitchen interior home"),
    (["bedroom", "master"], "luxury bedroom interior"),
    (["new construction", "builder", "building"], "new home construction site"),
    (["keys", "move in", "moving"], "house keys new home"),
    (["zestimate", "zillow", "estimate"], "laptop real estate website browsing"),
    (["mortgage", "interest rate", "loan"], "signing documents contract home"),
    (["sold", "closing", "closed"], "sold sign house real estate"),
    (["yard", "acre", "land", "lot"], "texas land property aerial"),
    (["family", "kids"], "family moving into new home"),
    (["car", "drive", "driving", "commute"], "driving suburban neighborhood"),
]


def enabled() -> bool:
    return bool(os.environ.get("PEXELS_API_KEY", "").strip())


def _clip_transcript_text(segments: list, clip_start: float, clip_end: float) -> str:
    parts = []
    for seg in segments or []:
        try:
            s, e = float(seg.get("start", 0)), float(seg.get("end", 0))
        except (TypeError, ValueError):
            continue
        if e <= clip_start or s >= clip_end:
            continue
        parts.append(str(seg.get("text", "")))
    return " ".join(parts).lower()


def _pick_query(text: str) -> Optional[str]:
    for keywords, query in _TOPIC_QUERIES:
        if any(kw in text for kw in keywords):
            return query
    return None


def _download_pexels_clip(query: str, out_dir: str) -> Optional[str]:
    """Download one short portrait clip from Pexels; returns local path or None."""
    api_key = os.environ.get("PEXELS_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        import requests  # noqa: PLC0415 — lazy; only needed when b-roll runs
    except ImportError:
        print("[broll] requests not installed — b-roll skipped")
        return None
    try:
        resp = requests.get(
            "https://api.pexels.com/videos/search",
            headers={"Authorization": api_key},
            params={
                "query": query,
                "per_page": 5,
                "orientation": "portrait",
                "size": "medium",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            print(f"[broll] Pexels API {resp.status_code} for '{query}'")
            return None
        videos = resp.json().get("videos", [])
        if not videos:
            return None
        # Smallest file that is still ≥720 wide — enough for a 1080 overlay
        # without downloading a 4K master.
        files = sorted(videos[0].get("video_files", []), key=lambda f: f.get("width", 0) or 0)
        target = next((f for f in files if (f.get("width") or 0) >= 720), files[-1] if files else None)
        if not target or not target.get("link"):
            return None
        out_path = os.path.join(out_dir, f"broll_{uuid.uuid4().hex[:8]}.mp4")
        with requests.get(target["link"], stream=True, timeout=30) as dl:
            dl.raise_for_status()
            with open(out_path, "wb") as f:
                for chunk in dl.iter_content(chunk_size=1024 * 1024):
                    f.write(chunk)
        return out_path
    except Exception as err:  # noqa: BLE001
        print(f"[broll] Pexels download failed: {type(err).__name__}: {err}")
        return None


def apply_broll(
    clip_path: str,
    segments: list[dict[str, Any]],
    clip_start: float,
    clip_end: float,
    clip_index: int,
) -> bool:
    """Overlay one topic-matched B-roll window onto clip_path IN PLACE.

    Returns True when the overlay was applied; False (clip untouched) otherwise.
    Runs BEFORE the caption burn so captions render on top of the b-roll.
    """
    if not enabled():
        return False
    broll_path = None
    out_path = None
    try:
        duration = clip_end - clip_start
        if duration < 15:
            return False  # too short — every second belongs to Marco's face
        text = _clip_transcript_text(segments, clip_start, clip_end)
        query = _pick_query(text)
        if not query:
            return False

        # Mid-clip placement, clamped away from hook and CTA.
        insert_at = max(4.0, min(duration * 0.5, duration - 4.0 - _BROLL_DUR_S))
        if insert_at + _BROLL_DUR_S > duration - 4.0:
            return False

        broll_path = _download_pexels_clip(query, os.path.dirname(clip_path))
        if not broll_path:
            return False

        out_path = clip_path.replace(".mp4", "_broll.mp4")
        end_at = insert_at + _BROLL_DUR_S
        # Cover-crop to the clip's REAL resolution (a 720p source reframes to
        # ~608x1080, not 1080x1920 — a hardcoded size would misframe the
        # overlay). Shift the b-roll PTS to the insertion point and gate
        # visibility with enable=. Marco's audio (0:a) passes through untouched.
        import edit_effects_marco  # noqa: PLC0415 — sibling module, lazy to avoid cycles
        vw, vh = edit_effects_marco.probe_resolution(clip_path)
        filter_complex = (
            f"[1:v]trim=0:{_BROLL_DUR_S},scale={vw}:{vh}:force_original_aspect_ratio=increase,"
            f"crop={vw}:{vh},setsar=1,setpts=PTS-STARTPTS+{insert_at}/TB[br];"
            f"[0:v][br]overlay=x=0:y=0:enable='between(t,{insert_at},{end_at})':eof_action=pass[outv]"
        )
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", clip_path,
                "-i", broll_path,
                "-filter_complex", filter_complex,
                "-map", "[outv]", "-map", "0:a?",
                "-threads", "2",
                "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
                "-c:a", "copy",
                out_path,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            timeout=_TIMEOUT_S,
        )
        if result.returncode != 0:
            print(f"[broll] overlay ffmpeg failed: {result.stderr.decode()[-300:]}")
            return False
        if os.path.isfile(out_path):
            os.replace(out_path, clip_path)
            print(
                f"[broll] Clip {clip_index}: b-roll '{query}' overlaid at "
                f"{insert_at:.1f}-{end_at:.1f}s"
            )
            return True
        return False
    except Exception as err:  # noqa: BLE001 — best-effort, never fail the clip
        print(f"[broll] failed for clip {clip_index} (keeping original): {type(err).__name__}: {err}")
        return False
    finally:
        for p in (broll_path, out_path):
            try:
                if p and os.path.exists(p):
                    os.remove(p)
            except Exception:
                pass
