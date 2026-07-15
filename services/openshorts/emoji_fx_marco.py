"""
Marco Puga Realty — colorful, animated emoji overlays for burned captions.

libass (captions_marco.py) renders subtitle text through FreeType and cannot
draw color bitmap emoji glyphs (Noto Color Emoji), only monochrome outline
fonts — which is why emoji used to render flat/mono instead of colorful. To
get real color AND Submagic-style motion (pop in / slide in), emoji have to
bypass ASS text rendering entirely: this module rasterizes each emoji to a
real colorful PNG sticker with Pillow (using the color-capable "Noto Color
Emoji" font already installed in the image for other purposes) and composites
it onto the video with ffmpeg's `overlay` filter, animated per-frame via
time-based `scale`/`overlay` position expressions instead of a static glyph.

Best-effort by contract: any failure here means the caller falls back to a
plain caption burn with no emoji overlay — this must never block a clip.
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from typing import Any

_COLOR_EMOJI_FONT = os.environ.get(
    "CAPTION_EMOJI_COLOR_FONT", "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"
)
# Noto Color Emoji is a CBDT bitmap font: it only has glyphs baked in at ONE
# fixed strike size (109px in the standard build) — ImageFont.truetype()
# raises "invalid pixel size" for any other point size. Canvas is padded a
# little larger than that strike so nothing clips; ffmpeg's `scale` filter
# resizes the rasterized PNG live for the actual on-screen animation (a small
# upscale for the pop-in overshoot peak is imperceptible at sticker size).
_FONT_STRIKE_SIZES = (109, 136, 128, 96, 72)
_RENDER_SIZE = 160
_CACHE_DIR = os.path.join(tempfile.gettempdir(), "openshorts_emoji_png_cache")

# Animation timing (all in seconds, clip-local — same clock as the caption
# card's own start/end).
_POP_GROW_S = 0.16       # 0 -> overshoot peak
_POP_SETTLE_S = 0.10     # overshoot peak -> resting size
_POP_PEAK_SCALE = 1.18   # overshoot amount on entrance
_FADE_IN_S = 0.10
_FADE_OUT_S = 0.18
# Continuous "float" so the emoji keeps moving the whole time it's on screen
# (the Submagic look) instead of popping once and freezing. All gentle:
_BREATHE_AMP = 0.055     # ±5.5% size pulse
_BREATHE_HZ = 0.85       # pulses per second
_DRIFT_X_FRAC = 0.10     # horizontal sway amplitude as a fraction of size
_DRIFT_Y_FRAC = 0.13     # vertical bob amplitude as a fraction of size
_DRIFT_X_HZ = 0.42
_DRIFT_Y_HZ = 0.60


def render_emoji_png(emoji: str) -> str | None:
    """Rasterize one emoji to a cached, colorful, transparent-background PNG.

    Cached indefinitely by emoji character — the same handful of glyphs get
    reused across every clip a container renders. Best-effort: returns None
    on any failure (missing font, Pillow without color-glyph support, etc.)
    so the caller can fall back to a plain caption burn.
    """
    if not emoji:
        return None
    try:
        os.makedirs(_CACHE_DIR, exist_ok=True)
        # Version suffix ("v2") invalidates older uncropped cache entries.
        key = "v2_" + hashlib.sha1(emoji.encode("utf-8")).hexdigest()[:16]
        path = os.path.join(_CACHE_DIR, f"{key}.png")
        if os.path.isfile(path) and os.path.getsize(path) > 0:
            return path
        from PIL import Image, ImageDraw, ImageFont  # lazy: best-effort dep

        font = None
        for candidate in _FONT_STRIKE_SIZES:
            try:
                font = ImageFont.truetype(_COLOR_EMOJI_FONT, candidate)
                break
            except OSError:
                continue  # not one of this font's baked-in bitmap strike sizes
        if font is None:
            print(f"[emoji-fx] no usable strike size in {_COLOR_EMOJI_FONT} for {_FONT_STRIKE_SIZES}")
            return None
        canvas = Image.new("RGBA", (_RENDER_SIZE, _RENDER_SIZE), (0, 0, 0, 0))
        draw = ImageDraw.Draw(canvas)
        bbox = draw.textbbox((0, 0), emoji, font=font, embedded_color=True)
        w, h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        if w <= 0 or h <= 0:
            return None
        cx = (_RENDER_SIZE - w) / 2 - bbox[0]
        cy = (_RENDER_SIZE - h) / 2 - bbox[1]
        draw.text((cx, cy), emoji, font=font, embedded_color=True)
        # Crop to the glyph's actual pixels (+ tiny pad) so the on-screen size
        # equals the requested px size — the strike glyph doesn't fill the
        # canvas, and leftover transparent margin made emojis render smaller
        # than intended.
        content = canvas.getbbox()
        if content:
            pad = 4
            canvas = canvas.crop((
                max(0, content[0] - pad), max(0, content[1] - pad),
                min(_RENDER_SIZE, content[2] + pad), min(_RENDER_SIZE, content[3] + pad),
            ))
        tmp_path = f"{path}.tmp{os.getpid()}.png"
        canvas.save(tmp_path, format="PNG")
        os.replace(tmp_path, path)
        return path
    except Exception as err:  # noqa: BLE001 — best-effort, never fatal
        print(f"[emoji-fx] render failed for {emoji!r}: {type(err).__name__}: {err}")
        return None


def _float_size_expr(start: float, size: float) -> str:
    """Per-frame edge-length expression (px): pop-in bounce, then a continuous
    gentle breathing pulse for the rest of the time on screen (so it never
    freezes). 2px floor because scale rejects a zero dimension.
    """
    peak = size * _POP_PEAK_SCALE
    grow_end = start + _POP_GROW_S
    settle_end = grow_end + _POP_SETTLE_S
    grow = f"2+({peak:.2f}-2)*pow(max(0,(t-{start:.3f}))/{_POP_GROW_S:.3f},0.5)"
    settle = f"({peak:.2f}-({peak:.2f}-{size:.2f})*(t-{grow_end:.3f})/{_POP_SETTLE_S:.3f})"
    # breathing pulse (applied after the entrance settles)
    breathe = f"({size:.2f}*(1+{_BREATHE_AMP}*sin(2*PI*(t-{settle_end:.3f})*{_BREATHE_HZ})))"
    return (
        f"if(lt(t,{start:.3f}),2,"
        f"if(lt(t,{grow_end:.3f}),{grow},"
        f"if(lt(t,{settle_end:.3f}),{settle},{breathe})))"
    )


def _drift_expr(center: str, start: float, amp: float, hz: float, phase: float) -> str:
    """Overlay position expression: resting `center` (a px expr string) plus a
    slow sine sway that only kicks in after `start` (0 before, so it doesn't
    yank on appearance)."""
    return (
        f"({center})+if(lt(t,{start:.3f}),0,"
        f"{amp:.1f}*sin(2*PI*(t-{start:.3f})*{hz}+{phase:.3f}))"
    )


def build_emoji_overlay_chain(
    events: list[dict[str, Any]],
    clip_duration: float,
) -> dict[str, Any] | None:
    """Build the ffmpeg extra-inputs + filter_complex fragment that composites
    every emoji event onto `[0:v]` with a Submagic-style floating animation:
    a pop-in entrance, then a continuous gentle bob + horizontal sway + size
    breathe for the whole time it is on screen, and a fade out. Each emoji
    gets a different sway phase so a run of them doesn't look mechanical.

    Each event: {"emoji","start","end","x","y","size"} — x/y are the resting
    TOP-LEFT position in pixels, size is the resting edge length in pixels.
    Returns {"inputs": [...ffmpeg -i args...], "filter": "...", "out_label":
    "..."} for the caller to chain the `ass=` burn onto, or None if nothing is
    renderable — callers must fall back to a plain caption burn.
    """
    inputs: list[str] = []
    filters: list[str] = []
    running = "0:v"
    used = 0
    for ev in events:
        png = render_emoji_png(str(ev.get("emoji") or ""))
        if not png:
            continue
        try:
            start = max(0.0, float(ev["start"]))
            end = max(start + 0.1, float(ev["end"]))
            x = float(ev["x"])
            y = float(ev["y"])
            size = max(8.0, float(ev["size"]))
        except (KeyError, TypeError, ValueError):
            continue
        if start >= clip_duration:
            continue
        end = min(end, clip_duration)
        used += 1
        k = used
        cx, cy = x + size / 2.0, y + size / 2.0
        phase = (used % 4) * 1.6  # stagger the sway between successive emojis
        label = f"e{k}"
        inputs += ["-loop", "1", "-t", f"{clip_duration:.3f}", "-i", png]

        w_expr = _float_size_expr(start, size)
        filters.append(
            f"[{k}:v]format=rgba,scale=w='trunc({w_expr})':h='trunc({w_expr})':eval=frame,"
            f"fade=t=in:st={start:.3f}:d={_FADE_IN_S:.3f}:alpha=1,"
            f"fade=t=out:st={end:.3f}:d={_FADE_OUT_S:.3f}:alpha=1[{label}]"
        )
        # Centre on (cx,cy) — overlay_w/h track the breathing scale so it stays
        # centred — plus the continuous drift.
        x_expr = _drift_expr(f"{cx:.1f}-overlay_w/2", start, size * _DRIFT_X_FRAC, _DRIFT_X_HZ, phase)
        y_expr = _drift_expr(f"{cy:.1f}-overlay_h/2", start, size * _DRIFT_Y_FRAC, _DRIFT_Y_HZ, phase + 0.8)

        out_label = f"ov{k}"
        filters.append(f"[{running}][{label}]overlay=x='{x_expr}':y='{y_expr}'[{out_label}]")
        running = out_label

    if used == 0:
        return None
    return {"inputs": inputs, "filter": ";".join(filters), "out_label": running}
