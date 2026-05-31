#!/usr/bin/env python3
"""Generate a guitar-shaped wordcloud SVG from catalog + enrichment data.

Output: home-wordcloud.svg — used as faded background on the home page.

Word frequencies are aggregated from:
  - Artist names (weighted by song count)
  - Artist enrichment: genres, regions
  - Song enrichment: themes, moods, occasions

The wordcloud is shaped like an acoustic guitar (rough silhouette built
from PIL primitives — no external image file needed). Words are drawn in
faded grays with subtle warm/cool tint variation so the cloud reads as
texture rather than dominant decoration.

Dependencies: pip install wordcloud pillow numpy

Re-run after every enrichment pass so newly-enriched terms show up:
  python crawler/generate-wordcloud.py
"""
import argparse
import collections
import json
import sys
from pathlib import Path


# Norwegian + English stopwords to suppress (would otherwise dominate).
STOPWORDS = set("""
the of in on at to and a an is for with from this that
en et det er som og i på til fra om av at man hva har
norsk norske norway norge song sang artist tab tabs music
norwegian english engelsk
""".split())


def build_guitar_mask(w=1400, h=700):
    """Returns a PIL image: white background, dark guitar silhouette.
    Uses the 🎸 emoji rendered huge — same icon as the favicon, recognizable.
    Falls back to a hand-drawn rough silhouette if no color-emoji font is found.
    """
    from PIL import Image, ImageDraw, ImageFont

    # Try color-emoji fonts in order of platform likelihood.
    candidates = [
        "C:/Windows/Fonts/seguiemj.ttf",                        # Windows
        "/System/Library/Fonts/Apple Color Emoji.ttc",          # macOS
        "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",    # Linux Noto
        "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf",
    ]
    # Try rendering 🎸 at a few sizes — color emoji fonts often only support
    # specific raster sizes (e.g. 109 for Apple, 128 for Noto).
    for path in candidates:
        for size in (550, 400, 256, 128, 109):
            try:
                font = ImageFont.truetype(path, size)
            except (OSError, IOError):
                continue
            try:
                # Render onto a transparent RGBA canvas
                img = Image.new("RGBA", (w, h), (255, 255, 255, 0))
                d = ImageDraw.Draw(img)
                bbox = d.textbbox((0, 0), "🎸", font=font, embedded_color=True)
                tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
                x = (w - tw) // 2 - bbox[0]
                y = (h - th) // 2 - bbox[1]
                d.text((x, y), "🎸", font=font, embedded_color=True)
            except Exception:
                continue
            # Convert: non-transparent pixels → mask "inside"
            mask = Image.new("L", (w, h), 255)
            mp = mask.load()
            ip = img.load()
            hit = False
            for py in range(h):
                for px in range(w):
                    if ip[px, py][3] > 30:
                        mp[px, py] = 0
                        hit = True
            if hit:
                return mask

    # Fallback: rough hand-drawn acoustic guitar silhouette.
    img = Image.new("L", (w, h), 255)
    draw = ImageDraw.Draw(img)
    draw.ellipse([60, 160, 540, 680], fill=0)
    draw.ellipse([340, 90, 700, 500], fill=0)
    draw.polygon([(300, 320), (560, 320), (530, 460), (270, 460)], fill=0)
    draw.rectangle([640, 260, 1200, 320], fill=0)
    draw.polygon([(1200, 230), (1330, 250), (1330, 330), (1200, 350)], fill=0)
    return img


def build_frequencies(catalog, enrichment):
    counts = collections.Counter()

    # Artist names — weighted by song count (popular artists are bigger).
    for letter, bucket in (catalog.get("letters") or {}).items():
        for artist in bucket.get("artists", []):
            name = artist["name"]
            counts[name] += max(1, len(artist.get("songs", [])))

    # Genre / region from artist enrichment.
    for aid, data in (enrichment.get("artists") or {}).items():
        for tag in data.get("genre", []) or []:
            counts[str(tag).lower()] += 3
        region = data.get("region")
        if region:
            counts[str(region).lower()] += 2
        era = data.get("era")
        if era:
            counts[str(era).lower()] += 1

    # Themes / mood / occasion from song enrichment.
    for sid, data in (enrichment.get("songs") or {}).items():
        for tag in data.get("themes", []) or []:
            counts[str(tag).lower()] += 1
        for tag in data.get("mood", []) or []:
            counts[str(tag).lower()] += 1
        for tag in data.get("occasion", []) or []:
            counts[str(tag).lower()] += 1

    # Drop stopwords + too-short tokens.
    return {
        w: c for w, c in counts.items()
        if len(w) >= 3 and w.lower() not in STOPWORDS
    }


def faded_gray(word, font_size, position, orientation, font_path, random_state):
    """Color function: VERY muted grays. Pure decoration, almost-white.

    Combined with low CSS opacity on the home page, the cloud reads as
    soft texture rather than content.
    """
    import random
    r = random.Random(hash((word, font_size)) & 0xFFFFFFFF)
    # Very narrow, very high lightness band: 205-230 of 255.
    base = r.randint(205, 230)
    warm = r.choice([-2, 0, 0, 2])  # tiny tint variation
    rr = max(0, min(255, base + warm))
    gg = max(0, min(255, base))
    bb = max(0, min(255, base - warm))
    return f"rgb({rr}, {gg}, {bb})"


def main():
    p = argparse.ArgumentParser(description="Generate guitar-shaped wordcloud SVG")
    p.add_argument("--catalog", default="catalog.json")
    p.add_argument("--enrichment", default="enrichment.json")
    p.add_argument("--out", default="images/home-wordcloud.svg")
    p.add_argument("--width", type=int, default=1400)
    p.add_argument("--height", type=int, default=900)
    p.add_argument("--max-words", type=int, default=400)
    args = p.parse_args()

    try:
        from wordcloud import WordCloud
        import numpy as np
    except ImportError as e:
        print(f"missing dependency ({e}). Install with:\n"
              f"  pip install wordcloud pillow numpy", file=sys.stderr)
        sys.exit(1)

    cat_path = Path(args.catalog)
    enr_path = Path(args.enrichment)
    if not cat_path.exists():
        print(f"catalog not found: {cat_path}", file=sys.stderr)
        sys.exit(1)
    catalog = json.loads(cat_path.read_text(encoding="utf-8"))
    enrichment = (
        json.loads(enr_path.read_text(encoding="utf-8"))
        if enr_path.exists() else {}
    )

    freqs = build_frequencies(catalog, enrichment)
    print(f"built {len(freqs)} unique terms", file=sys.stderr)

    mask = np.array(build_guitar_mask(args.width, args.height))
    wc = WordCloud(
        width=args.width, height=args.height,
        background_color=None,
        mode="RGBA",
        mask=mask,
        max_words=args.max_words,
        color_func=faded_gray,
        prefer_horizontal=0.85,
        min_font_size=10,
        max_font_size=72,
        relative_scaling=0.5,
        random_state=42,
        margin=2,
    )
    wc.generate_from_frequencies(freqs)
    svg = wc.to_svg(embed_font=False)
    Path(args.out).write_text(svg, encoding="utf-8")
    sz = Path(args.out).stat().st_size
    print(f"wrote {args.out} ({sz:,} bytes, {args.width}×{args.height})",
          file=sys.stderr)


if __name__ == "__main__":
    main()
