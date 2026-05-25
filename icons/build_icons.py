"""Generate Lumina extension icons at the sizes Chrome requires.

Run once after changing the design:
    python icons/build_icons.py

Produces icon16.png, icon32.png, icon48.png, icon128.png next to this file.
"""
from __future__ import annotations
import os
from PIL import Image, ImageDraw, ImageFilter

SIZES = (16, 32, 48, 128)
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# Palette
BG_TOP = (28, 22, 56)        # deep indigo
BG_BOT = (52, 26, 84)        # violet
HALO = (192, 132, 252, 140)  # purple halo
ORB_OUTER = (236, 178, 255)  # soft pink-purple
ORB_INNER = (255, 252, 252)  # near-white core
HIGHLIGHT = (255, 255, 255, 235)
SPARKLE = (255, 255, 255, 235)


def _gradient_bg(size: int) -> Image.Image:
    """Vertical gradient background (top-to-bottom)."""
    img = Image.new("RGBA", (size, size))
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(BG_TOP[0] * (1 - t) + BG_BOT[0] * t)
        g = int(BG_TOP[1] * (1 - t) + BG_BOT[1] * t)
        b = int(BG_TOP[2] * (1 - t) + BG_BOT[2] * t)
        for x in range(size):
            img.putpixel((x, y), (r, g, b, 255))
    return img


def _radial_orb(size: int, radius: int, outer, inner) -> Image.Image:
    """Soft radial-gradient orb on a transparent layer."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    cx = cy = size // 2
    for r in range(radius, 0, -1):
        t = 1 - (r / radius)
        rr = int(outer[0] * (1 - t) + inner[0] * t)
        gg = int(outer[1] * (1 - t) + inner[1] * t)
        bb = int(outer[2] * (1 - t) + inner[2] * t)
        d = ImageDraw.Draw(layer)
        d.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=(rr, gg, bb, 255))
    return layer


def make_icon(size: int) -> Image.Image:
    base = _gradient_bg(size)

    # Mask to rounded square corners
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [(0, 0), (size - 1, size - 1)],
        radius=max(2, size // 5),
        fill=255,
    )
    rounded = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rounded.paste(base, (0, 0), mask)

    # Soft halo behind the orb
    halo = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    halo_r = int(size * 0.40)
    cx = cy = size // 2
    ImageDraw.Draw(halo).ellipse(
        [(cx - halo_r, cy - halo_r), (cx + halo_r, cy + halo_r)],
        fill=HALO,
    )
    halo = halo.filter(ImageFilter.GaussianBlur(radius=max(1, size // 12)))
    rounded = Image.alpha_composite(rounded, halo)

    # Main orb with radial gradient
    orb_r = int(size * 0.27)
    orb = _radial_orb(size, orb_r, ORB_OUTER, ORB_INNER)
    rounded = Image.alpha_composite(rounded, orb)

    # Highlight (small white reflection on top-left of orb)
    if size >= 24:
        hl_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        hl_r = max(1, int(orb_r * 0.38))
        hl_x = cx - orb_r // 3
        hl_y = cy - orb_r // 3
        ImageDraw.Draw(hl_layer).ellipse(
            [(hl_x - hl_r, hl_y - hl_r), (hl_x + hl_r, hl_y + hl_r)],
            fill=HIGHLIGHT,
        )
        hl_layer = hl_layer.filter(ImageFilter.GaussianBlur(radius=max(1, size // 50)))
        rounded = Image.alpha_composite(rounded, hl_layer)

    # Sparkles only on larger sizes (would be muddy at 16px)
    if size >= 32:
        d = ImageDraw.Draw(rounded)
        sparkles = [
            (0.22, 0.22, 0.040),
            (0.80, 0.20, 0.030),
            (0.82, 0.80, 0.045),
            (0.20, 0.80, 0.030),
        ]
        for px, py, ps in sparkles:
            sx, sy = int(size * px), int(size * py)
            sr = max(1, int(size * ps))
            t = max(1, sr // 3)
            d.rectangle([(sx - sr, sy - t), (sx + sr, sy + t)], fill=SPARKLE)
            d.rectangle([(sx - t, sy - sr), (sx + t, sy + sr)], fill=SPARKLE)

    return rounded


def main() -> None:
    for s in SIZES:
        out = os.path.join(OUT_DIR, f"icon{s}.png")
        make_icon(s).save(out)
        print(f"wrote {out}")


if __name__ == "__main__":
    main()
