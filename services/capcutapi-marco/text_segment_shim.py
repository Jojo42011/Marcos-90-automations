# ── Marco compatibility shim ──────────────────────────────────────────────────
# Upstream add_text_impl.py imports TextStyleRange, but the vendored library
# never defined it (broken at upstream HEAD). It is only ever used as a plain
# attribute bag (constructed by mcp_server.py, read by add_text_impl.py), so a
# minimal dataclass restores the contract without touching upstream behaviour.
class TextStyleRange:
    def __init__(self, start=0, end=0, font_size=None, font_color=None,
                 bold=False, italic=False, underline=False, font=None):
        self.start = start
        self.end = end
        self.font_size = font_size
        self.font_color = font_color
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.font = font
