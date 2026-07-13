"""
Marco Puga Realty — burned-in caption generation.

The vendored OpenShorts engine (main.py) has no subtitle/caption support at all:
process_video_to_vertical() takes only (input_video, final_output_video) and
transcribe_video() returns word-level timestamps that nothing downstream uses.
This module builds an ASS subtitle file from those word timestamps and burns
it into a clip with ffmpeg's libass-backed `ass` filter, applied AFTER vertical
reframing so captions never get cropped by the reframe step.

STYLE — matched to Marco's own reference videos (measured directly from the
frames he provided): short static "cards" of 1-4 words (NOT word-by-word
karaoke reveal — the whole card appears at once and holds), wrapped across up
to 2 display lines when needed, bold uppercase, heavy black outline, anchored
from a FIXED TOP position (~68% down the frame) so a single-line card sits at
the same spot a two-line card's first line does. The card's last display line
is colored (alternating bright green / yellow across successive cards);
earlier lines stay white. A small content-matched emoji floats near the
upper-right, independent of the caption position.
"""
import os
import re
import subprocess

# Hard timeout for the caption burn-in pass — kill a hung ffmpeg instead of
# letting it block the job (mirrors _FFMPEG_TIMEOUT_S in app_marco.py).
_CAPTION_TIMEOUT_S = int(os.environ.get("OPENSHORTS_FFMPEG_TIMEOUT_S", "180"))

# Chunky bold uppercase sans (installed in the Docker image) — the reference
# style's high-impact viral-caption look. Falls back to whatever libass finds
# if the font isn't installed (dev boxes without the Docker image).
FONT_NAME = os.environ.get("CAPTION_FONT", "Archivo Black")

WHITE = "&H00FFFFFF"
BLACK = "&H00000000"
# Bright green / yellow accents, sampled directly from Marco's reference
# videos (the last display line of each caption card cycles between these).
ACCENT_GREEN = "&H002EF42E"  # ASS BGR order -> RGB(46,244,46)
ACCENT_YELLOW = "&H0016FAFC"  # ASS BGR order -> RGB(252,250,22)
_ACCENT_CYCLE = (ACCENT_GREEN, ACCENT_YELLOW)

# Monochrome outline emoji font (installed in the Docker image). libass renders
# through FreeType and cannot draw color bitmap fonts (Noto COLOR Emoji), which
# is why emojis burned as tofu rectangles — select the mono font explicitly.
EMOJI_FONT = os.environ.get("CAPTION_EMOJI_FONT", "Noto Emoji")

MAX_WORDS_PER_CARD = 6
PAUSE_GAP_SECONDS = 0.5
AVG_CHAR_WIDTH_FACTOR = 0.62  # rough bold-sans average glyph width as a fraction of font size
# A card wraps onto a second display line above this many characters — narrower
# than a card's own max width so short 2-4 word bursts naturally split 2+2 or
# 1+2 the way the reference style does, instead of always fitting on one line.
DISPLAY_LINE_CHAR_FACTOR = 0.5

# ── Content-aware caption emojis (viewer retention) ──────────────────────────
# One emoji per caption line, picked from what the line actually says. Rendered
# with the MONOCHROME "Noto Emoji" outline font via an explicit {\fn} override
# (see EMOJI_FONT above) — libass cannot draw color bitmap emoji fonts. Emojis
# must be single-codepoint (no ZWJ sequences, no U+FE0F variation selectors).
# Disable with CAPTION_EMOJIS=false.
CAPTION_EMOJIS = os.environ.get("CAPTION_EMOJIS", "true").lower() == "true"

# Ordered — first match wins, so the most specific real-estate signals sit on top.
_EMOJI_RULES: list[tuple[str, str]] = [
    (r"\b(dm|message|inbox)\b", "📩"),
    (r"\b(zestimate|zillow|redfin|estimate[ds]?|algorithm[s]?|algorithm)\b", "🤖"),
    (r"\b(price[ds]?|prices|pricing|dollar[s]?|money|cash|paid|pay(ing|s)?|afford|budget)\b", "💰"),
    (r"\b(interest|rate[s]?|mortgage|apr)\b", "📉"),
    (r"\b(sold|closing|closed|deal|offer[s]?|negotiat(e|ing|ion))\b", "🤝"),
    (r"\b(key[s]?|move[- ]?in|moving)\b", "🔑"),
    (r"\b(car[s]?|vehicle[s]?|driv(e|ing|er)|commut(e|ing)|truck[s]?|suv[s]?)\b", "🚗"),
    (r"\b(house[s]?|home[s]?|property|properties|listing[s]?|real estate|condo[s]?|townhome[s]?)\b", "🏠"),
    (r"\b(pool[s]?|yard|garden|backyard|patio|outdoor)\b", "🏊"),
    (r"\b(build(er|ing)?|construction|new build|renovat(e|ing|ion)|upgrad(e|ing))\b", "🏗"),
    (r"\b(san antonio|stone oak|canyon lake|new braunfels|alamo heights|neighborhood|area|location)\b", "📍"),
    (r"\b(stale|day[s]? on market|sit(ting)?|wait(ing)?|week[s]? (on|in)|dom)\b", "⏳"),
    (r"\b(up|increase[d]?|rising|jump(ed)?|grow(th|ing)?|more)\b", "📈"),
    (r"\b(down|drop(ped|s)?|falling|lower|decrease[d]?|reduc(e|ing|tion))\b", "📉"),
    (r"\b(save[d]?|saving[s]?|discount)\b", "🏦"),
    (r"\b(credit|score|loan[s]?|lender|va loan|fha)\b", "💳"),
    (r"\b(family|families|kids|children)\b", "👪"),
    (r"\b(school[s]?|district)\b", "🎓"),
    (r"\b(hot|fire|crazy|insane|huge)\b", "🔥"),
    (r"\b(warning|careful|mistake[s]?|avoid|scam)\b", "⚠"),
    (r"\b(secret[s]?|nobody|won'?t tell)\b", "🤫"),
    (r"\b(first[- ]time buyer[s]?|buyer[s]?|buy(ing)?|seller[s]?|sell(ing)?)\b", "🛒"),
    (r"\b(follow|subscribe)\b", "➕"),
    (r"\b(free)\b", "🎁"),
]
_EMOJI_COMPILED = [(re.compile(p, re.IGNORECASE), e) for p, e in _EMOJI_RULES]

# Cooldown: never the same emoji twice in a row — repetition reads as spam.
_last_emoji: list[str] = [""]


def emoji_for_text(text: str) -> str:
    """Pick one content-matched emoji for a caption line ('' if nothing fits)."""
    if not CAPTION_EMOJIS or not text:
        return ""
    for pattern, emoji in _EMOJI_COMPILED:
        if pattern.search(text):
            if emoji == _last_emoji[0]:
                continue  # skip repeat; fall through to the next matching rule
            _last_emoji[0] = emoji
            # Strip variation selectors (U+FE0F) — the mono emoji font has no
            # glyph for them and they render as a tofu box.
            return emoji.replace("\ufe0f", "")
    return ""


def _layout_params(video_width: int, video_height: int) -> dict:
    font_size = max(28, video_height // 24)
    # Fixed TOP anchor, measured from Marco's reference videos: the first
    # display line always starts at ~68.4% down the frame, whether the card
    # renders as one line or wraps to two — i.e. the block grows DOWNWARD
    # from a fixed point rather than growing upward from the bottom.
    margin_v = round(video_height * 0.684)
    margin_lr = round(video_width * 0.06)
    usable_width = max(video_width - 2 * margin_lr, font_size * 4)
    max_chars_per_card = max(8, int(usable_width / (font_size * AVG_CHAR_WIDTH_FACTOR)))
    max_chars_per_display_line = max(4, int(max_chars_per_card * DISPLAY_LINE_CHAR_FACTOR))
    return {
        "font_size": font_size,
        "margin_v": margin_v,
        "margin_lr": margin_lr,
        "max_chars_per_line": max_chars_per_card,
        "max_chars_per_display_line": max_chars_per_display_line,
        # Floating content-matched emoji: fixed upper-right position,
        # independent of the caption block (also measured from reference).
        "emoji_x": round(video_width * 0.86),
        "emoji_y": round(video_height * 0.40),
        "emoji_size": round(font_size * 1.3),
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


def group_words_into_cards(words: list[dict], max_chars_per_card: int) -> list[list[dict]]:
    """Group words into short static caption "cards" (one card at a time)."""
    cards: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    prev_end = None

    for word in words:
        gap = (word["start"] - prev_end) if prev_end is not None else 0
        would_overflow_chars = current_chars + len(word["text"]) + 1 > max_chars_per_card
        would_overflow_words = len(current) >= MAX_WORDS_PER_CARD
        natural_pause = prev_end is not None and gap > PAUSE_GAP_SECONDS

        if current and (would_overflow_chars or would_overflow_words or natural_pause):
            cards.append(current)
            current = []
            current_chars = 0

        current.append(word)
        current_chars += len(word["text"]) + 1
        prev_end = word["end"]

    if current:
        cards.append(current)

    return cards


def _wrap_card_for_display(tokens: list[str], max_chars_per_display_line: int) -> list[list[str]]:
    """Split a card's word tokens across up to 2 display lines.

    Greedily fills line 1 up to the width limit, then everything remaining
    goes on line 2 — matching the reference style's short 2-3-word-per-line
    wrap (e.g. "PER DAY" / "THAN YOUR" from one 4-word card). A card short
    enough to fit on one line stays on one line.
    """
    if not tokens:
        return []
    line1: list[str] = []
    chars = 0
    for tok in tokens:
        added = len(tok) + (1 if line1 else 0)
        if line1 and chars + added > max_chars_per_display_line:
            break
        line1.append(tok)
        chars += added
    remaining = tokens[len(line1):]
    return [line1, remaining] if remaining else [line1]


def _card_dialogue_events(
    card: list[dict],
    style_name: str,
    font_size: int,
    card_index: int,
    layout: dict,
) -> list[str]:
    """One static dialogue event for the whole card (no per-word reveal — the
    card appears and holds for its full duration), plus a second event for
    its floating content-matched emoji, if any."""
    # Tokens for display-wrapping: normally one dict per real word, but the
    # clip-editor's re-sync path (caption_edit.write_edited_ass) collapses a
    # whole caption line into a SINGLE dict whose text has embedded spaces —
    # splitting every dict's text on whitespace handles both uniformly.
    tokens: list[str] = []
    for w in card:
        tokens.extend((w.get("text") or "").split())
    if not tokens:
        return []

    start = card[0]["start"]
    end = card[-1]["end"]
    if end <= start:
        end = start + 0.05

    display_lines = _wrap_card_for_display(tokens, layout["max_chars_per_display_line"])
    accent = _ACCENT_CYCLE[card_index % len(_ACCENT_CYCLE)]

    ass_lines = []
    for idx, line_tokens in enumerate(display_lines):
        text = _ass_escape(" ".join(line_tokens)).upper()
        if not text:
            continue
        color = accent if idx == len(display_lines) - 1 else WHITE
        ass_lines.append(f"{{\\1c{color}&\\3c{BLACK}&\\bord6\\b1}}{text}")
    if not ass_lines:
        return []

    events = [
        f"Dialogue: 0,{_format_ass_time(start)},{_format_ass_time(end)},{style_name},,0,0,0,,"
        + "\\N".join(ass_lines)
    ]

    card_text = " ".join(tokens)
    emoji = emoji_for_text(card_text)
    if emoji:
        # Fixed floating position (upper-right), independent of the caption
        # block's own top-anchored alignment — \an7\pos overrides the style's
        # normal alignment/margin for this one event.
        ex, ey, esize = layout["emoji_x"], layout["emoji_y"], layout["emoji_size"]
        events.append(
            f"Dialogue: 0,{_format_ass_time(start)},{_format_ass_time(end)},{style_name},,0,0,0,,"
            f"{{\\an7\\pos({ex},{ey})\\fn{EMOJI_FONT}\\fs{esize}\\1c{WHITE}&\\3c{BLACK}&\\bord5}}{emoji}"
        )
    return events


def build_ass_file(
    cards: list[list[dict]],
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
Style: {style_name},{FONT_NAME},{font_size},{WHITE},{WHITE},{BLACK},{BLACK},1,0,0,0,100,100,0,0,1,6,0,8,{margin_lr},{margin_lr},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events = []
    for idx, card in enumerate(cards):
        events.extend(_card_dialogue_events(card, style_name, font_size, idx, layout))

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
    cards = group_words_into_cards(words, layout["max_chars_per_line"])
    if not cards:
        return None
    # Persist a card-level caption list next to the ASS so the clip editor can
    # display + edit caption text without parsing the styled ASS events.
    try:
        import json as _json
        line_objs = [
            {
                "start": round(c[0]["start"], 2),
                "end": round(c[-1]["end"], 2),
                "text": " ".join((w.get("text") or "").strip() for w in c).strip(),
            }
            for c in cards
            if c
        ]
        with open(output_path.replace(".ass", ".lines.json"), "w", encoding="utf-8") as f:
            _json.dump(line_objs, f)
    except Exception as err:
        print(f"[captions] could not write lines.json: {err}")
    return build_ass_file(cards, video_width, video_height, output_path)


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
