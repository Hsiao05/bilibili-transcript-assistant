"""Generate the extension's simple PNG icons with the standard library only."""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "apps" / "extension" / "public" / "icons"
BLUE = (37, 99, 235)
WHITE = (255, 255, 255)


def rounded_rect(x0: int, y0: int, x1: int, y1: int, radius: int, w: int, h: int):
    for y in range(max(0, y0), min(h, y1)):
        for x in range(max(0, x0), min(w, x1)):
            dx = min(x - x0, x1 - 1 - x)
            dy = min(y - y0, y1 - 1 - y)
            if dx < 0 or dy < 0:
                continue
            if dx < radius and dy < radius:
                if (radius - dx) ** 2 + (radius - dy) ** 2 > radius**2:
                    continue
            yield x, y


def make_icon(size: int) -> bytes:
    pixels = [[BLUE + (255,)] * size for _ in range(size)]
    # White document lines, slightly narrower than the tile.
    margin = max(2, round(size * 0.18))
    bar_h = max(1, round(size * 0.10))
    radius = max(1, bar_h // 2)
    rows = [0.28, 0.48, 0.68]
    widths = [0.64, 0.46, 0.58]
    for row, width_ratio in zip(rows, widths):
        y0 = round(size * row)
        x0 = margin
        x1 = round(size * (0.18 + width_ratio))
        for x, y in rounded_rect(x0, y0, x1, y0 + bar_h, radius, size, size):
            pixels[y][x] = WHITE + (255,)
    raw = bytearray()
    for row in pixels:
        raw.append(0)
        for pixel in row:
            raw.extend(pixel)
    compressed = zlib.compress(bytes(raw), 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        (OUT / f"icon{size}.png").write_bytes(make_icon(size))
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
