"""Renders the brand images in custom_components/polyglot/brand/ (icon, logo, dark variants, @2x).

Two overlapping speech bubbles, "A" and "文": the usual translate symbol, in Home Assistant blue and a warm accent.
Run with: py -3 tools/make_brand.py  (needs Pillow and the Windows Segoe UI / Microsoft YaHei fonts).
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "custom_components" / "polyglot" / "brand"
FONTS = Path("C:/Windows/Fonts")
BLUE = (3, 169, 244, 255)  # Home Assistant primary
CORAL = (255, 112, 67, 255)
WHITE = (255, 255, 255, 255)
SS = 4  # supersampling


def bubble_mask(size, box, radius, tail):
    """Rounded rectangle plus a triangular tail, as an L mask."""
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle(box, radius=radius, fill=255)
    d.polygon(tail, fill=255)
    return m


def glyph(draw, center, text, font, fill):
    left, t, r, b = draw.textbbox((0, 0), text, font=font)
    draw.text((center[0] - (left + r) / 2, center[1] - (t + b) / 2), text, font=font, fill=fill)


def icon(px):
    s = px * SS
    u = s / 256  # design units: 256 grid
    size = (s, s)
    img = Image.new("RGBA", size, (0, 0, 0, 0))

    back_box = (8 * u, 16 * u, 160 * u, 140 * u)
    back = bubble_mask(size, back_box, 30 * u, [(36 * u, 128 * u), (84 * u, 128 * u), (30 * u, 176 * u)])
    front_box = (96 * u, 92 * u, 248 * u, 216 * u)
    front_tail = [(172 * u, 204 * u), (220 * u, 204 * u), (226 * u, 248 * u)]
    front = bubble_mask(size, front_box, 30 * u, front_tail)

    # Gap between the bubbles: cut the front shape, grown by a few units, out of the back bubble.
    gap = bubble_mask(
        size,
        (front_box[0] - 10 * u, front_box[1] - 10 * u, front_box[2] + 10 * u, front_box[3] + 10 * u),
        40 * u,
        front_tail,
    )
    back = ImageChops.subtract(back, gap)

    img.paste(Image.new("RGBA", size, BLUE), (0, 0), back)
    img.paste(Image.new("RGBA", size, CORAL), (0, 0), front)

    d = ImageDraw.Draw(img)
    glyph(d, (60 * u, 74 * u), "A", ImageFont.truetype(str(FONTS / "seguibl.ttf"), int(88 * u)), WHITE)
    glyph(d, (172 * u, 152 * u), "文", ImageFont.truetype(str(FONTS / "msyhbd.ttc"), int(84 * u)), WHITE)
    return img.resize((px, px), Image.LANCZOS)


def logo(height, text_color):
    """Icon plus the "Polyglot" wordmark, landscape."""
    ic = icon(height)
    font = ImageFont.truetype(str(FONTS / "segoeuib.ttf"), int(height * 0.5 * SS))
    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    left, t, r, b = probe.textbbox((0, 0), "Polyglot", font=font)
    gap = int(height * 0.18)
    width = height + gap + (r - left) // SS + gap // 2
    text = Image.new("RGBA", (width * SS, height * SS), (0, 0, 0, 0))
    td = ImageDraw.Draw(text)
    td.text(((height + gap) * SS - left, (height * SS - (t + b)) / 2), "Polyglot", font=font, fill=text_color)
    out = text.resize((width, height), Image.LANCZOS)
    out.alpha_composite(ic, (0, 0))
    return out


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, px in (("icon.png", 256), ("icon@2x.png", 512)):
        icon(px).save(OUT / name, optimize=True)
        # The bubbles read on both light and dark backgrounds, so the dark icon is the same image.
        icon(px).save(OUT / f"dark_{name}", optimize=True)
    for suffix, h in (("", 128), ("@2x", 256)):
        logo(h, (33, 33, 33, 255)).save(OUT / f"logo{suffix}.png", optimize=True)
        logo(h, (225, 225, 225, 255)).save(OUT / f"dark_logo{suffix}.png", optimize=True)
    print("written:", ", ".join(sorted(p.name for p in OUT.iterdir())))


if __name__ == "__main__":
    main()
