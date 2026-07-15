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

EMOJI — NOT rendered as ASS text. libass renders subtitle glyphs through
FreeType and cannot draw color bitmap emoji fonts, so a real colorful,
animated (pop-in / slide-in) emoji has to be composited as a video overlay
instead (see emoji_fx_marco.py). This module's job is only to decide WHICH
emoji goes with which caption card and WHERE/WHEN it should appear; that
metadata is written to a `.emoji.json` sidecar next to the `.ass` file, and
app_marco.py's burn step (captions_marco.burn_captions_with_emoji) reads it
to build the actual overlay.
"""
import os
import re
import subprocess

# ══════════════════════════════════════════════════════════════════════════
# ASS TIME-UNIT WARNING — read before editing any animation tag:
#   \k / \kf / \ko karaoke durations are in CENTISECONDS ({\k100} = 1 second)
#   \t(...) animation times are in MILLISECONDS (\t(0,100,...) = 0.1 seconds)
# Mixing these up is the classic ASS bug. Double-check units on every edit.
# ══════════════════════════════════════════════════════════════════════════

# Hard timeout for the caption burn-in pass — kill a hung ffmpeg instead of
# letting it block the job (mirrors _FFMPEG_TIMEOUT_S in app_marco.py).
_CAPTION_TIMEOUT_S = int(os.environ.get("OPENSHORTS_FFMPEG_TIMEOUT_S", "180"))


def hex_to_ass_color(hex_color: str, alpha: int = 0) -> str:
    """Convert #RRGGBB web hex to ASS &HAABBGGRR (alpha + BGR, reversed).

    hex_to_ass_color("#25f4ee") -> "&H00EEF425" (teal)
    hex_to_ass_color("#FFFF00") -> "&H0000FFFF" (yellow)
    """
    hex_color = hex_color.lstrip("#")
    r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
    return f"&H{alpha:02X}{b}{g}{r}".upper()

# Chunky bold uppercase sans (installed in the Docker image) — the reference
# style's high-impact viral-caption look. Falls back to whatever libass finds
# if the font isn't installed (dev boxes without the Docker image).
FONT_NAME = os.environ.get("CAPTION_FONT", "Archivo Black")

WHITE = hex_to_ass_color("#FFFFFF")
BLACK = hex_to_ass_color("#000000")
# Bright green / yellow accents, sampled directly from Marco's reference
# videos (the last display line of each caption card cycles between these).
ACCENT_GREEN = hex_to_ass_color("#2EF42E")   # &H002EF42E
ACCENT_YELLOW = hex_to_ass_color("#FCFA16")  # &H0016FAFC
ACCENT_RED = hex_to_ass_color("#FF2E4C")     # vivid red, matches the Submagic rotation
# The colored (last) display line rotates through this palette per caption card
# — green → yellow → red → … — so the highlight visibly "changes after each
# take" like Submagic, instead of just flipping between two colors.
# Override the set with CAPTION_ACCENT_CYCLE (comma-separated #hex).
_ACCENT_CYCLE = (ACCENT_GREEN, ACCENT_YELLOW, ACCENT_RED)
_env_cycle = os.environ.get("CAPTION_ACCENT_CYCLE", "").strip()
if _env_cycle:
    try:
        _ACCENT_CYCLE = tuple(hex_to_ass_color(c.strip()) for c in _env_cycle.split(",") if c.strip())
    except Exception:
        _ACCENT_CYCLE = (ACCENT_GREEN, ACCENT_YELLOW, ACCENT_RED)
# Alternates the floating emoji's entrance animation card-to-card (pop-in vs
# slide-in-from-the-right) so a clip with several emoji doesn't feel robotic —
# same alternation pattern as the accent color cycle above.
_ANIM_CYCLE = ("pop", "slide")
TEAL = hex_to_ass_color("#25F4EE")  # brand teal for the karaoke/pop presets

# ── Caption style presets ─────────────────────────────────────────────────────
# "marco" (default) — the reference-video card style Marco approved: static
#   1-4 word cards, top-anchored, last display line green/yellow. This is the
#   look measured pixel-for-pixel from his example videos; keep it the default.
# "karaoke" — professional \k sweep: one Dialogue event per card, each word
#   flips SecondaryColour(white) → PrimaryColour(teal) at its spoken time.
# "pop" — Submagic-style: per-word tiled events, active word teal + 112% scale,
#   inactive words dimmed white.
# Selected via CAPTION_STYLE env; unknown values fall back to "marco".
CAPTION_STYLE_PRESETS: dict[str, dict] = {
    "marco": {"mode": "cards"},
    "karaoke": {
        "mode": "karaoke",
        "inactive": WHITE,
        "active": TEAL,
        "max_words": 5,
        "uppercase": True,
    },
    "pop": {
        "mode": "pop",
        "inactive": WHITE,
        "active": TEAL,
        "max_words": 4,
        "uppercase": True,
    },
}
CAPTION_STYLE = os.environ.get("CAPTION_STYLE", "marco").strip().lower()
if CAPTION_STYLE not in CAPTION_STYLE_PRESETS:
    CAPTION_STYLE = "marco"

MAX_WORDS_PER_CARD = 6
PAUSE_GAP_SECONDS = 0.5
AVG_CHAR_WIDTH_FACTOR = 0.62  # rough bold-sans average glyph width as a fraction of font size
# A card wraps onto a second display line above this many characters — narrower
# than a card's own max width so short 2-4 word bursts naturally split 2+2 or
# 1+2 the way the reference style does, instead of always fitting on one line.
DISPLAY_LINE_CHAR_FACTOR = 0.5

# ── Content-aware caption emojis (viewer retention) ──────────────────────────
# One emoji per caption line, picked from what the line actually says. Handed
# off to emoji_fx_marco.py as a real colorful animated overlay (see module
# docstring above) — NOT rendered as ASS text. Emojis must be single-codepoint
# (no ZWJ sequences, no U+FE0F variation selectors) since the color-emoji
# rasterizer keys its render cache on the raw character.
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
        # Floating content-matched emoji (Submagic-style): big, in the upper
        # third, and animated by emoji_fx_marco (pop-in + continuous float).
        # emoji_x/y are the resting TOP-LEFT anchor; size ~16% of frame width
        # matches the reference. Kept safely on-screen (x + size < width) with
        # room for the horizontal sway.
        "emoji_size": round(video_width * 0.16),
        "emoji_x": round(video_width * 0.66),
        "emoji_y": round(video_height * 0.24),
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


def group_words_into_cards(
    words: list[dict],
    max_chars_per_card: int,
    max_words: int = MAX_WORDS_PER_CARD,
) -> list[list[dict]]:
    """Group words into short caption "cards" (one card shown at a time).

    Breaks at: word/char caps, a natural speech pause (> PAUSE_GAP_SECONDS),
    or sentence-ending punctuation — a card should never straddle a sentence
    boundary. Never orphans a single trailing word: if the final card would
    be 1 word, it's pulled into the previous card instead.
    """
    cards: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    prev_end = None
    prev_ended_sentence = False

    for word in words:
        gap = (word["start"] - prev_end) if prev_end is not None else 0
        would_overflow_chars = current_chars + len(word["text"]) + 1 > max_chars_per_card
        would_overflow_words = len(current) >= max_words
        natural_pause = prev_end is not None and gap > PAUSE_GAP_SECONDS

        if current and (would_overflow_chars or would_overflow_words or natural_pause or prev_ended_sentence):
            cards.append(current)
            current = []
            current_chars = 0

        current.append(word)
        current_chars += len(word["text"]) + 1
        prev_end = word["end"]
        prev_ended_sentence = word["text"].strip().endswith((".", "!", "?"))

    if current:
        if len(current) == 1 and cards and len(cards[-1]) <= max_words:
            cards[-1].extend(current)  # no orphaned single word
        else:
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
) -> tuple[list[str], dict | None]:
    """One static dialogue event for the whole card (no per-word reveal — the
    card appears and holds for its full duration), plus a metadata dict for
    its floating content-matched emoji, if any (None if no emoji matched).
    The emoji is NOT part of the returned ASS text — see module docstring."""
    # Tokens for display-wrapping: normally one dict per real word, but the
    # clip-editor's re-sync path (caption_edit.write_edited_ass) collapses a
    # whole caption line into a SINGLE dict whose text has embedded spaces —
    # splitting every dict's text on whitespace handles both uniformly.
    tokens: list[str] = []
    for w in card:
        tokens.extend((w.get("text") or "").split())
    if not tokens:
        return [], None

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
        return [], None

    events = [
        f"Dialogue: 0,{_format_ass_time(start)},{_format_ass_time(end)},{style_name},,0,0,0,,"
        + "\\N".join(ass_lines)
    ]

    card_text = " ".join(tokens)
    emoji = emoji_for_text(card_text)
    emoji_meta = None
    if emoji:
        # Fixed floating position (upper-right), independent of the caption
        # block's own top-anchored alignment — same anchor point the old
        # \an7\pos-based glyph used, now the RESTING position an animated
        # overlay sticker pops/slides in to (see emoji_fx_marco.py).
        ex, ey, esize = layout["emoji_x"], layout["emoji_y"], layout["emoji_size"]
        emoji_meta = {
            "emoji": emoji,
            "start": round(start, 3),
            "end": round(end, 3),
            "x": ex,
            "y": ey,
            "size": esize,
            "anim": _ANIM_CYCLE[card_index % len(_ANIM_CYCLE)],
        }
    return events, emoji_meta


def _card_word_timings(card: list[dict]) -> list[dict]:
    """Per-word (text, start, end) entries for the karaoke/pop builders.

    Normal path: one dict per word — pass through. The clip-editor re-sync
    path collapses a whole line into one dict with embedded spaces and only
    line-level timing; in that case the line's duration is spread evenly
    across its tokens so \\k timing still exists (approximate but watchable).
    """
    out: list[dict] = []
    for w in card:
        tokens = (w.get("text") or "").split()
        if not tokens:
            continue
        if len(tokens) == 1:
            out.append({"text": tokens[0], "start": float(w["start"]), "end": float(w["end"])})
            continue
        span = max(0.05, float(w["end"]) - float(w["start"]))
        step = span / len(tokens)
        for i, tok in enumerate(tokens):
            out.append({
                "text": tok,
                "start": float(w["start"]) + i * step,
                "end": float(w["start"]) + (i + 1) * step,
            })
    return out


def _karaoke_group_event(card: list[dict], style_name: str, preset: dict) -> list[str]:
    """One Dialogue event per card using native \\k tags (CENTISECONDS).

    Each word flips SecondaryColour → PrimaryColour at its spoken time; the
    style header (see build_ass_file) carries the two colors, so the event
    text needs only the \\k timing. A word stays lit until the NEXT word's
    start (not its own end), so the highlight never dies inside a gap.
    """
    words = _card_word_timings(card)
    if not words:
        return []
    group_start = words[0]["start"]
    group_end = words[-1]["end"] + 0.08  # small tail so the last word stays lit

    parts = []
    for i, w in enumerate(words):
        if i < len(words) - 1:
            duration_s = words[i + 1]["start"] - w["start"]
        else:
            duration_s = (w["end"] - w["start"]) + 0.08
        duration_cs = max(1, round(duration_s * 100))  # CENTISECONDS (\k unit)
        text = _ass_escape(w["text"])
        if preset.get("uppercase"):
            text = text.upper()
        parts.append(f"{{\\k{duration_cs}}}{text}")

    text_line = " ".join(parts)
    return [
        f"Dialogue: 0,{_format_ass_time(group_start)},{_format_ass_time(group_end)},{style_name},,0,0,0,,{text_line}"
    ]


def _pop_word_events(card: list[dict], style_name: str, preset: dict) -> list[str]:
    """Submagic-style pop: one Dialogue event per word window. The active word
    renders in the accent color at 112% scale; inactive words are dimmed.
    Windows tile exactly (each ends when the next begins) so no flicker frame
    ever renders without a caption."""
    words = _card_word_timings(card)
    if not words:
        return []
    active_color = preset["active"]
    inactive_color = preset["inactive"]

    events = []
    for active_idx, active_word in enumerate(words):
        win_start = active_word["start"]
        win_end = words[active_idx + 1]["start"] if active_idx < len(words) - 1 else active_word["end"] + 0.08
        if win_end <= win_start:
            win_end = win_start + 0.05

        parts = []
        for idx, w in enumerate(words):
            text = _ass_escape(w["text"])
            if preset.get("uppercase"):
                text = text.upper()
            if not text:
                continue
            if idx == active_idx:
                parts.append(f"{{\\1c{active_color}&\\fscx112\\fscy112\\b1}}{text}{{\\r}}")
            else:
                parts.append(f"{{\\1c{inactive_color}&\\alpha&H55&}}{text}{{\\r}}")

        events.append(
            f"Dialogue: 0,{_format_ass_time(win_start)},{_format_ass_time(win_end)},{style_name},,0,0,0,,"
            + " ".join(parts)
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
    margin_lr = layout["margin_lr"]
    preset = CAPTION_STYLE_PRESETS[CAPTION_STYLE]
    mode = preset["mode"]

    if mode == "cards":
        # Marco reference style: top-anchored block (Alignment 8) at a fixed
        # point, growing downward. Primary/Secondary are both white — the
        # per-line colors are applied inline in _card_dialogue_events.
        primary, secondary = WHITE, WHITE
        alignment = 8
        margin_v = layout["margin_v"]
    else:
        # Karaoke/pop presets: classic bottom-third placement (Alignment 2).
        # For karaoke, the ASS spec requires PrimaryColour = the color a word
        # flips TO (active) and SecondaryColour = the un-highlighted state.
        primary, secondary = preset["active"], preset["inactive"]
        alignment = 2
        margin_v = round(video_height * 0.17)

    header = f"""[Script Info]
Title: Marco Puga Realty Captions
ScriptType: v4.00+
PlayResX: {video_width}
PlayResY: {video_height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: {style_name},{FONT_NAME},{font_size},{primary},{secondary},{BLACK},{BLACK},1,0,0,0,100,100,0,0,1,6,0,{alignment},{margin_lr},{margin_lr},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    events = []
    emoji_events: list[dict] = []
    for idx, card in enumerate(cards):
        if mode == "karaoke":
            events.extend(_karaoke_group_event(card, style_name, preset))
        elif mode == "pop":
            events.extend(_pop_word_events(card, style_name, preset))
        else:
            card_events, emoji_meta = _card_dialogue_events(card, style_name, font_size, idx, layout)
            events.extend(card_events)
            if emoji_meta:
                emoji_events.append(emoji_meta)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("\n".join(events))
        f.write("\n")

    # Sidecar for the animated emoji overlay burn (see burn_captions_with_emoji
    # / emoji_fx_marco.py). Always write-or-clear so a re-render of the same
    # output_path never composites a stale previous render's emoji timings.
    emoji_sidecar = output_path.replace(".ass", ".emoji.json")
    if emoji_events:
        try:
            import json as _json
            with open(emoji_sidecar, "w", encoding="utf-8") as ef:
                _json.dump(emoji_events, ef)
        except Exception as err:
            print(f"[captions] could not write emoji.json sidecar: {err}")
    elif os.path.isfile(emoji_sidecar):
        try:
            os.remove(emoji_sidecar)
        except Exception:
            pass

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
    preset = CAPTION_STYLE_PRESETS[CAPTION_STYLE]
    cards = group_words_into_cards(
        words, layout["max_chars_per_line"],
        max_words=preset.get("max_words", MAX_WORDS_PER_CARD),
    )
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


def _load_emoji_events(ass_path: str) -> list[dict]:
    sidecar = ass_path.replace(".ass", ".emoji.json")
    if not os.path.isfile(sidecar):
        return []
    try:
        import json
        with open(sidecar, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _probe_duration(video_path: str) -> float:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video_path],
            capture_output=True, text=True, timeout=15,
        )
        return float(result.stdout.strip())
    except Exception:
        return 0.0


def burn_captions_with_emoji(input_video: str, ass_path: str, output_video: str) -> bool:
    """Like burn_captions, but also composites colorful animated emoji
    stickers (see emoji_fx_marco.py) read from the `.emoji.json` sidecar next
    to `ass_path`, if any. Falls back to the plain ass-only burn on any
    failure or when there is nothing to composite — the emoji overlay must
    never be the reason a clip fails to ship."""
    events = _load_emoji_events(ass_path)
    if not events:
        return burn_captions(input_video, ass_path, output_video)
    try:
        import emoji_fx_marco  # noqa: PLC0415 — lazy: best-effort dep (Pillow)

        duration = _probe_duration(input_video)
        if duration <= 0:
            return burn_captions(input_video, ass_path, output_video)
        chain = emoji_fx_marco.build_emoji_overlay_chain(events, duration)
        if not chain:
            return burn_captions(input_video, ass_path, output_video)
        escaped_ass_path = _escape_filter_path(ass_path)
        filter_complex = f"{chain['filter']};[{chain['out_label']}]ass={escaped_ass_path}[vout]"
        result = subprocess.run(
            [
                "ffmpeg", "-y",
                "-i", input_video,
                *chain["inputs"],
                "-filter_complex", filter_complex,
                "-map", "[vout]", "-map", "0:a?",
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
            print(f"[captions] emoji overlay burn failed, falling back to plain captions: {result.stderr.decode()[-500:]}")
            return burn_captions(input_video, ass_path, output_video)
        return True
    except Exception as err:  # noqa: BLE001 — best-effort, never blocks a clip
        print(f"[captions] emoji overlay pipeline failed, falling back: {type(err).__name__}: {err}")
        return burn_captions(input_video, ass_path, output_video)
