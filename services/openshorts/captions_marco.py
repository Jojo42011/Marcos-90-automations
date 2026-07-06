"""
Marco Puga Realty — burned-in karaoke caption generation.

The vendored OpenShorts engine (main.py) has no subtitle/caption support at all:
process_video_to_vertical() takes only (input_video, final_output_video) and
transcribe_video() returns word-level timestamps that nothing downstream uses.
This module builds an ASS subtitle file from those word timestamps and burns
it into a clip with ffmpeg's libass-backed `ass` filter, applied AFTER vertical
reframing so captions never get cropped by the reframe step.
"""
import os
import subprocess

# Hard timeout for the caption burn-in pass — kill a hung ffmpeg instead of
# letting it block the job (mirrors _FFMPEG_TIMEOUT_S in app_marco.py).
_CAPTION_TIMEOUT_S = int(os.environ.get("OPENSHORTS_FFMPEG_TIMEOUT_S", "180"))

FONT_NAME = "Liberation Sans"  # metric-compatible Arial Bold substitute; ships via apt fonts-liberation

WHITE = "&H00FFFFFF"
BLACK = "&H00000000"
HIGHLIGHT_BG = "&H002B2BFF"  # ASS BGR order -> RGB(FF,2B,2B), bold red/orange

MAX_WORDS_PER_LINE = 6
PAUSE_GAP_SECONDS = 0.5
AVG_CHAR_WIDTH_FACTOR = 0.62  # rough bold-sans average glyph width as a fraction of font size


def _layout_params(video_width: int, video_height: int) -> dict:
    font_size = max(28, video_height // 24)
    margin_v = round(video_height * 0.17)  # lower third, breathing room from bottom edge
    margin_lr = round(video_width * 0.06)
    usable_width = max(video_width - 2 * margin_lr, font_size * 4)
    max_chars_per_line = max(8, int(usable_width / (font_size * AVG_CHAR_WIDTH_FACTOR)))
    return {
        "font_size": font_size,
        "margin_v": margin_v,
        "margin_lr": margin_lr,
        "max_chars_per_line": max_chars_per_line,
    }


def _ass_escape(text: str) -> str:
    return text.replace("\\", "").replace("{", "").replace("}", "").strip()


def _format_ass_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    total_cs = round(seconds * 100)
    cs = total_cs % 100
    total_s = total_cs // 100
    s = total_s % 60
    total_m = total_s // 60
    m = total_m % 60
    h = total_m // 60
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def slice_words_for_clip(transcript_segments: list[dict], clip_start: float, clip_end: float) -> list[dict]:
    """Extract word timestamps overlapping [clip_start, clip_end] and rebase them to clip-relative time."""
    clip_duration = max(0.0, clip_end - clip_start)
    words: list[dict] = []
    for seg in transcript_segments or []:
        for w in seg.get("words") or []:
            w_start = w.get("start")
            w_end = w.get("end")
            text = (w.get("word") or "").strip()
            if w_start is None or w_end is None or not text:
                continue
            if w_end <= clip_start or w_start >= clip_end:
                continue
            rel_start = max(0.0, w_start - clip_start)
            rel_end = min(clip_duration, max(rel_start + 0.05, w_end - clip_start))
            words.append({"text": text, "start": rel_start, "end": rel_end})
    words.sort(key=lambda w: w["start"])
    return words


def group_words_into_lines(words: list[dict], max_chars_per_line: int) -> list[list[dict]]:
    """Group words into short phrases (one line of captions at a time)."""
    lines: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    prev_end = None

    for word in words:
        gap = (word["start"] - prev_end) if prev_end is not None else 0
        would_overflow_chars = current_chars + len(word["text"]) + 1 > max_chars_per_line
        would_overflow_words = len(current) >= MAX_WORDS_PER_LINE
        natural_pause = prev_end is not None and gap > PAUSE_GAP_SECONDS

        if current and (would_overflow_chars or would_overflow_words or natural_pause):
            lines.append(current)
            current = []
            current_chars = 0

        current.append(word)
        current_chars += len(word["text"]) + 1
        prev_end = word["end"]

    if current:
        lines.append(current)

    return lines


def _line_dialogue_events(line: list[dict], style_name: str) -> list[str]:
    events = []
    for i, active_word in enumerate(line):
        start = active_word["start"]
        end = line[i + 1]["start"] if i + 1 < len(line) else active_word["end"]
        if end <= start:
            end = start + 0.05

        parts = []
        for word in line:
            text = _ass_escape(word["text"]).upper()
            if not text:
                continue
            if word is active_word:
                parts.append(f"{{\\1c{WHITE}&\\3c{HIGHLIGHT_BG}&\\bord14}}{text}")
            else:
                parts.append(f"{{\\1c{WHITE}&\\3c{BLACK}&\\bord5}}{text}")
        text_field = " ".join(parts)

        events.append(
            f"Dialogue: 0,{_format_ass_time(start)},{_format_ass_time(end)},{style_name},,0,0,0,,{text_field}"
        )
    return events


def build_ass_file(
    lines: list[list[dict]],
    video_width: int,
    video_height: int,
    output_path: str,
) -> str:
    style_name = "MarcoCaption"
    layout = _layout_params(video_width, video_height)
    font_size = layout["font_size"]
    margin_v = layout["margin_v"]
    margin_lr = layout["margin_lr"]

    header = f"""[Script Info]
Title: Marco Puga Realty Captions
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: {style_name},{FONT_NAME},{font_size},{WHITE},{WHITE},{BLACK},{BLACK},1,0,0,0,100,100,0,0,1,5,0,2,{margin_lr},{margin_lr},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events = []
    for line in lines:
        events.extend(_line_dialogue_events(line, style_name))

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("\n".join(events))
        f.write("\n")

    return output_path


def generate_captions_ass(
    transcript_segments: list[dict],
    clip_start: float,
    clip_end: float,
    video_width: int,
    video_height: int,
    output_path: str,
) -> str | None:
    """Build the ASS file for one clip's caption track. Returns None if no words fall in range."""
    words = slice_words_for_clip(transcript_segments, clip_start, clip_end)
    if not words:
        return None
    layout = _layout_params(video_width, video_height)
    lines = group_words_into_lines(words, layout["max_chars_per_line"])
    if not lines:
        return None
    # Persist a line-level caption list next to the ASS so the clip editor can
    # display + edit caption text without parsing per-word karaoke ASS events.
    try:
        import json as _json
        line_objs = [
            {
                "start": round(ln[0]["start"], 2),
                "end": round(ln[-1]["end"], 2),
                "text": " ".join((w.get("text") or "").strip() for w in ln).strip(),
            }
            for ln in lines
            if ln
        ]
        with open(output_path.replace(".ass", ".lines.json"), "w", encoding="utf-8") as f:
            _json.dump(line_objs, f)
    except Exception as err:
        print(f"[captions] could not write lines.json: {err}")
    return build_ass_file(lines, video_width, video_height, output_path)


def _escape_filter_path(path: str) -> str:
    return path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def get_video_resolution(video_path: str) -> tuple[int, int]:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "csv=s=x:p=0",
            video_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 or not result.stdout.strip():
        raise RuntimeError(f"ffprobe failed to read resolution: {result.stderr[-300:]}")
    width_str, height_str = result.stdout.strip().split("x")
    return int(width_str), int(height_str)


def burn_captions(input_video: str, ass_path: str, output_video: str) -> bool:
    """Render the ASS subtitle track onto the video frames via ffmpeg + libass."""
    # Phase 4c — veryfast over fast: same reasoning as _cut_clip in app_marco.py.
    escaped_ass_path = _escape_filter_path(ass_path)
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-i", input_video,
            "-vf", f"ass={escaped_ass_path}",
            "-threads", "2",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "copy",
            output_video,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        timeout=_CAPTION_TIMEOUT_S,
    )
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg caption burn failed: {result.stderr.decode()[-800:]}")
    return True
