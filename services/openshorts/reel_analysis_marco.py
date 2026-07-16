"""
Marco Puga Realty — pasted-reel ingestion for Harvey.

Harvey's chat box now accepts Instagram / TikTok / YouTube-Shorts links. This
module is the one genuinely new piece: turning a public reel URL into a local
mp4 (plus its metadata) with yt-dlp, which is already installed in the sidecar.
Everything downstream — Whisper transcript, keyframe extraction, vision-LLM
read — is the exact machinery the batch clipper already runs, so the endpoint
in app_marco.py just reuses it (see process_reel_job).

Everything here is best-effort and defensive: a private/blocked reel or a
yt-dlp failure raises a ReelDownloadError with a human-readable reason that
Harvey relays back, rather than crashing the worker.
"""
from __future__ import annotations

import glob
import json
import os
import subprocess
import tempfile
import uuid
from typing import Any

# yt-dlp caps: reels are short, so keep the box safe from a mis-pasted 2-hour
# link. Overridable via env for the rare long-form analysis.
_MAX_FILESIZE = os.environ.get("REEL_MAX_FILESIZE", "350M")
_DL_TIMEOUT_S = int(os.environ.get("REEL_DL_TIMEOUT_S", "150"))
# Optional cookies file — Instagram often blocks anonymous downloads; pointing
# this at an exported cookies.txt makes private/rate-limited reels fetchable.
_COOKIES_FILE = os.environ.get("YT_DLP_COOKIES_FILE", "").strip()

_URL_RE_HINTS = ("instagram.com", "tiktok.com", "youtube.com", "youtu.be", "vt.tiktok", "vm.tiktok")


class ReelDownloadError(Exception):
    """Raised when a reel cannot be fetched — message is safe to show a user."""


def looks_like_reel_url(text: str) -> str | None:
    """Return the first http(s) URL in `text` that looks like a social video,
    else the first http(s) URL at all, else None. Kept permissive: the Node
    tool already decides intent, this just extracts a clean URL to hand yt-dlp."""
    import re

    urls = re.findall(r"https?://[^\s<>\"']+", text or "")
    if not urls:
        return None
    for u in urls:
        low = u.lower()
        if any(h in low for h in _URL_RE_HINTS):
            return u.rstrip(").,")
    return urls[0].rstrip(").,")


def _platform_of(url: str) -> str:
    low = (url or "").lower()
    if "instagram.com" in low:
        return "instagram"
    if "tiktok" in low:
        return "tiktok"
    if "youtube.com" in low or "youtu.be" in low:
        return "youtube"
    return "unknown"


def download_reel(url: str, dest_dir: str | None = None) -> dict[str, Any]:
    """Download a public reel to a local mp4 with yt-dlp; return path + metadata.

    Returns {"path", "metadata": {...}}. Raises ReelDownloadError on any
    failure with a message safe to relay to Harvey.
    """
    url = (url or "").strip()
    if not url.startswith("http"):
        raise ReelDownloadError("That doesn't look like a link — paste the full reel URL.")

    platform = _platform_of(url)
    work = dest_dir or tempfile.mkdtemp(prefix="reel_", dir=tempfile.gettempdir())
    os.makedirs(work, exist_ok=True)
    out_tmpl = os.path.join(work, f"{uuid.uuid4().hex}.%(ext)s")

    cmd = [
        "yt-dlp",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--max-filesize", _MAX_FILESIZE,
        # Prefer a single already-muxed file (no separate video+audio download +
        # ffmpeg remux step, which is the slowest part). <=720p is ample for
        # transcription and reading on-screen text from keyframes.
        "-f", "b[height<=720][ext=mp4]/b[ext=mp4]/b",
        "--write-info-json",
        "-o", out_tmpl,
    ]
    if _COOKIES_FILE and os.path.isfile(_COOKIES_FILE):
        cmd += ["--cookies", _COOKIES_FILE]
    cmd.append(url)

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=_DL_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise ReelDownloadError(
            f"The download timed out after {_DL_TIMEOUT_S}s — the reel may be very long or the host is slow."
        )

    # Find the downloaded media file (yt-dlp may pick mp4/webm/mov).
    media = None
    for ext in ("mp4", "mkv", "webm", "mov", "m4v"):
        hits = glob.glob(os.path.join(work, f"*.{ext}"))
        if hits:
            media = max(hits, key=os.path.getsize)
            break

    if not media or not os.path.isfile(media) or os.path.getsize(media) < 1024:
        stderr = (proc.stderr or "").strip()
        reason = _humanize_ytdlp_error(stderr, platform)
        raise ReelDownloadError(reason)

    # Metadata from the sidecar .info.json (best-effort).
    meta: dict[str, Any] = {"platform": platform, "source_url": url}
    info_hits = glob.glob(os.path.join(work, "*.info.json"))
    if info_hits:
        try:
            with open(info_hits[0], "r", encoding="utf-8") as fh:
                info = json.load(fh)
            meta.update(
                title=info.get("title") or info.get("fulltitle") or "",
                description=(info.get("description") or "")[:1500],
                uploader=info.get("uploader") or info.get("channel") or info.get("uploader_id") or "",
                view_count=info.get("view_count"),
                like_count=info.get("like_count"),
                comment_count=info.get("comment_count"),
                duration=info.get("duration"),
                webpage_url=info.get("webpage_url") or url,
                upload_date=info.get("upload_date") or "",
            )
        except Exception:  # noqa: BLE001 — metadata is a nicety, never fatal
            pass

    return {"path": media, "metadata": meta}


def _humanize_ytdlp_error(stderr: str, platform: str) -> str:
    """Map raw yt-dlp stderr to a short, actionable reason."""
    low = (stderr or "").lower()
    if "login required" in low or "log in" in low or "rate-limit" in low or "429" in low:
        if platform == "instagram":
            return (
                "Instagram blocked the download (it wants a login for this reel). "
                "Public reels usually work — if this one is private or age-restricted, I can't fetch it."
            )
        return "The platform is rate-limiting downloads right now — try again in a minute."
    if "private" in low or "not available" in low or "unavailable" in low:
        return "That reel looks private or unavailable, so I can't open it."
    if "max-filesize" in low or "larger than" in low:
        return "That video is too large to analyze here."
    if "unsupported url" in low or "no video" in low:
        return "I couldn't find a video at that link — double-check it's a reel/short URL."
    if not low:
        return "The download produced no file — the link may be invalid or the reel was removed."
    # Fall back to the last non-empty stderr line, trimmed.
    last = [ln for ln in (stderr or "").splitlines() if ln.strip()]
    tail = last[-1][:180] if last else "unknown error"
    return f"Couldn't download that reel ({tail})."


def build_reel_analysis_prompt(
    transcript: str,
    metadata: dict[str, Any],
    note: str,
    has_frames: bool,
) -> str:
    """Prompt for the vision LLM: read the reel like a short-form strategist and
    tell Marco what it is and what he can take from it."""
    meta = metadata or {}
    platform = meta.get("platform", "social")
    title = (meta.get("title") or "").strip()
    uploader = (meta.get("uploader") or "").strip()
    caption = (meta.get("description") or "").strip()

    stats_bits = []
    for label, key in (("views", "view_count"), ("likes", "like_count"), ("comments", "comment_count")):
        val = meta.get(key)
        if isinstance(val, (int, float)) and val > 0:
            stats_bits.append(f"{int(val):,} {label}")
    if meta.get("duration"):
        stats_bits.append(f"{int(meta['duration'])}s long")
    stats = " · ".join(stats_bits) if stats_bits else "no public metrics"

    note_line = f'\nMarco added this note with the link: "{note.strip()}"\n' if note and note.strip() else ""
    frames_line = (
        "You are also given several keyframes from the reel — use them to describe what is ON screen "
        "(setting, person, text overlays, b-roll, editing style), not just the words.\n"
        if has_frames
        else "No frames were available, so judge from the transcript and metadata alone.\n"
    )
    caption_line = f"\nCAPTION / DESCRIPTION:\n{caption}\n" if caption else ""
    header = f"{platform.title()} reel"
    if title:
        header += f' — "{title}"'
    if uploader:
        header += f" by {uploader}"

    return (
        "You are Harvey, Marco Puga's sharp short-form content strategist. Marco just pasted a reel "
        "into your chat for you to break down. Analyze it the way a top creator-coach would — concrete, "
        "honest, and immediately useful for a real-estate agent's TikTok/Instagram.\n"
        f"{note_line}"
        f"\nREEL: {header}\nSTATS: {stats}\n"
        f"{caption_line}"
        f"\n{frames_line}"
        f"\nTRANSCRIPT (what is said):\n{transcript.strip() or '(no speech detected — likely music/text-only)'}\n"
        "\nWrite your breakdown as a few flowing PARAGRAPHS of plain prose, the way you'd explain it out "
        "loud to Marco — NOT as headers, bullet lists, tables, or numbered sections. Do NOT use any "
        "markdown formatting (no #, *, -, |, backticks, or bold). Just clean sentences and paragraphs.\n"
        "Cover, woven naturally into the prose: what the reel is and who made it; the exact hook in the "
        "first couple seconds and whether it stops the scroll; how it's built and paced; the real reason "
        "it works or falls flat; and — most important — two or three specific, copyable moves Marco should "
        "steal for his own real-estate content. Keep it tight: about 3 to 5 short paragraphs, no filler. "
        "Talk straight to Marco.\n"
        "\nAfter the paragraphs, add ONE final line in exactly this format, for a voice summary:\n"
        "SPOKEN_SUMMARY: <3–4 sentences of plain conversational speech — the way you'd verbally sum up this "
        "reel and the single biggest thing Marco should take from it, said out loud to him.>"
    )


def split_spoken_summary(analysis_text: str) -> tuple[str, str]:
    """Separate the written breakdown from the SPOKEN_SUMMARY line so the UI can
    display the full breakdown while Harvey speaks the short summary aloud.
    Returns (written_breakdown, spoken_summary)."""
    text = analysis_text or ""
    marker = "SPOKEN_SUMMARY:"
    idx = text.rfind(marker)
    if idx == -1:
        return text.strip(), ""
    written = text[:idx].rstrip().rstrip("-").rstrip()
    spoken = text[idx + len(marker):].strip()
    # Strip any stray markdown the model may have left in the spoken line.
    for ch in ("**", "*", "#", "`", "_"):
        spoken = spoken.replace(ch, "")
    spoken = " ".join(spoken.split())
    return written.strip(), spoken.strip()
