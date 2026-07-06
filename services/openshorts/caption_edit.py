"""
Caption editing + re-sync for the clip editor (Increment 2).

Captions are authored on the clip's ORIGINAL timeline (the persisted _base.ass /
_base.mp4). After a trim and/or middle cuts, the kept footage is a shorter
timeline, so every caption's timestamps must be recomputed to line up with the
new video — a line inside a removed region is dropped, and a line after a cut
shifts earlier by the total removed duration before it. This module does that
re-sync and writes a fresh ASS, reusing captions_marco's ASS builder styling.
"""
from __future__ import annotations


def _fmt_ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    total_cs = round(seconds * 100)
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def resync_caption_lines(lines: list[dict], keeps: list[tuple[float, float]]) -> list[dict]:
    """Map caption lines from the original timeline onto the post-edit timeline.

    `lines`: [{"start","end","text"}] on the ORIGINAL clip timeline.
    `keeps`: ordered, non-overlapping kept intervals on the original timeline
             (already = [trim] minus cuts, as the render engine computes them).

    A line is kept iff it overlaps a kept interval; its time is clamped to that
    interval and shifted so the kept footage starts at 0 (offsets accumulate as
    earlier kept intervals are concatenated). Lines fully inside a removed gap
    are dropped. Returns new lines with recomputed start/end on the new timeline.
    """
    out: list[dict] = []
    # new-timeline offset at which each kept interval begins
    offset = 0.0
    bounds = []  # (orig_start, orig_end, new_start_offset)
    for ks, ke in keeps:
        bounds.append((ks, ke, offset))
        offset += (ke - ks)

    for ln in lines or []:
        try:
            ls = float(ln.get("start"))
            le = float(ln.get("end"))
        except (TypeError, ValueError):
            continue
        text = str(ln.get("text", "")).strip()
        if not text or le <= ls:
            continue
        for ks, ke, base_off in bounds:
            # overlap of [ls,le] with this kept interval [ks,ke]
            os_ = max(ls, ks)
            oe = min(le, ke)
            if oe - os_ <= 0.02:
                continue
            new_start = base_off + (os_ - ks)
            new_end = base_off + (oe - ks)
            out.append({"start": round(new_start, 2), "end": round(new_end, 2), "text": text})
    out.sort(key=lambda w: w["start"])
    return out


def write_edited_ass(
    lines: list[dict],
    keeps: list[tuple[float, float]],
    video_width: int,
    video_height: int,
    output_path: str,
) -> str | None:
    """Re-sync `lines` to the post-edit timeline and write an ASS file.

    Reuses captions_marco's line-styling + layout so re-burned captions match the
    original pipeline exactly. Returns the path, or None if nothing to render.
    """
    import captions_marco as cm

    synced = resync_caption_lines(lines, keeps)
    if not synced:
        return None
    layout = cm._layout_params(video_width, video_height)
    # Each caption line becomes one styled dialogue event on the new timeline.
    grouped = [[{"text": ln["text"], "start": ln["start"], "end": ln["end"]}] for ln in synced]
    # Flatten to the events shape build_ass_file expects (list of lines of words).
    return cm.build_ass_file(grouped, video_width, video_height, output_path)
