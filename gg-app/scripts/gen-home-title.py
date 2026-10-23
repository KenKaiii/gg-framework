#!/usr/bin/env python3
"""Paint the home screen's "GG Coder" title, as GG Royale paints "Royale".

Alagard (Hewett Tsoi, free with credit; src/assets/fonts/alagard) at 48px, an
exact multiple of its 16px grid so every stroke is whole pixels, thresholded,
lit along the top of each stroke and outlined in ink: the same recipe and
colours as GG Royale's menu title. The PNG is shown at a whole-number scale
with nearest-neighbour sampling.

    python3 scripts/gen-home-title.py   (needs Pillow; run from gg-app/)
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/assets/home/gg-coder-title.png"
FONT = ROOT / "src/assets/fonts/alagard/alagard.ttf"

TEXT, SIZE, TRACK, PAD = "GG Coder", 48, 0, 3
FILL, LIGHT, OUTLINE = "#f0c060", "#fff2c0", "#2a1406"


def rgba(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4)) + (255,)


font = ImageFont.truetype(str(FONT), SIZE)
l, t, r, b = font.getbbox(TEXT)
w = r - l + PAD * 2 + TRACK * (len(TEXT) - 1)
h = b - t + PAD * 2
mask = Image.new("L", (w, h), 0)
draw = ImageDraw.Draw(mask)
x = PAD - l
for ch in TEXT:
    draw.text((x, PAD - t), ch, font=font, fill=255)
    x += font.getlength(ch) + TRACK
m = mask.load()
on = [[m[x, y] > 110 for x in range(w)] for y in range(h)]

img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
p = img.load()
for y in range(h):
    for x in range(w):
        if on[y][x]:
            p[x, y] = rgba(FILL) if y > 0 and on[y - 1][x] else rgba(LIGHT)
for y in range(h):
    for x in range(w):
        if not on[y][x] and any(
            0 <= y + dy < h and 0 <= x + dx < w and on[y + dy][x + dx]
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))
        ):
            p[x, y] = rgba(OUTLINE)
OUT.parent.mkdir(parents=True, exist_ok=True)
img.save(OUT, optimize=True)
print(f"wrote {OUT.relative_to(ROOT)}: {img.size[0]}x{img.size[1]}")
