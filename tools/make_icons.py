#!/usr/bin/env python3
"""Generate the extension's PNG icons.

A rounded terracotta square with a white cursor arrow. Written with zlib +
struct so it needs nothing beyond the standard library — run it after editing
the colours or shape:

    python3 tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

SIZES = (16, 32, 48, 128)
BG = (193, 85, 44)  # terracotta, matching the UI accent
FG = (255, 255, 255)
OUT_DIR = Path(__file__).resolve().parent.parent / "icons"

# Cursor arrow outline in a 0..1 coordinate space, drawn clockwise.
ARROW = [
    (0.34, 0.22),
    (0.74, 0.55),
    (0.55, 0.58),
    (0.66, 0.80),
    (0.55, 0.85),
    (0.44, 0.63),
    (0.30, 0.76),
]


def inside_polygon(x, y, points):
    """Even-odd point-in-polygon test."""
    inside = False
    count = len(points)
    for i in range(count):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % count]
        if (y1 > y) != (y2 > y):
            edge_x = x1 + (y - y1) / (y2 - y1) * (x2 - x1)
            if x < edge_x:
                inside = not inside
    return inside


def coverage(size, px, py, radius_ratio=0.22, samples=3):
    """Anti-aliased alpha for the rounded-square background at one pixel."""
    radius = size * radius_ratio
    hits = 0
    for sy in range(samples):
        for sx in range(samples):
            x = px + (sx + 0.5) / samples
            y = py + (sy + 0.5) / samples
            # Distance outside the rounded rect's straight edges.
            dx = max(radius - x, x - (size - radius), 0.0)
            dy = max(radius - y, y - (size - radius), 0.0)
            if dx * dx + dy * dy <= radius * radius:
                hits += 1
    return hits / (samples * samples)


def arrow_alpha(size, px, py, samples=3):
    hits = 0
    for sy in range(samples):
        for sx in range(samples):
            x = (px + (sx + 0.5) / samples) / size
            y = (py + (sy + 0.5) / samples) / size
            if inside_polygon(x, y, ARROW):
                hits += 1
    return hits / (samples * samples)


def render(size):
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            bg_alpha = coverage(size, x, y)
            fg_alpha = arrow_alpha(size, x, y) if bg_alpha > 0 else 0.0
            r = BG[0] + (FG[0] - BG[0]) * fg_alpha
            g = BG[1] + (FG[1] - BG[1]) * fg_alpha
            b = BG[2] + (FG[2] - BG[2]) * fg_alpha
            row += bytes((round(r), round(g), round(b), round(bg_alpha * 255)))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def main():
    OUT_DIR.mkdir(exist_ok=True)
    for size in SIZES:
        path = OUT_DIR / f"icon{size}.png"
        write_png(path, size, render(size))
        print(f"wrote {path} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
