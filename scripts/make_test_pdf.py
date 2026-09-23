# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Write the four-page fixture the browser tests load.

Same construction as make_pdf() in test_tools.py: a heading, six ruled rows and
an embedded image per page, so every page has text, vector drawings and a
picture.

Usage:
    .venv/bin/python scripts/make_test_pdf.py [out.pdf]   (default test-output/four.pdf)
"""

import os
import sys

import pymupdf as fitz

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "test-output", "four.pdf")


def make_pdf(pages: int = 4) -> bytes:
    art = fitz.open()
    art_page = art.new_page(width=900, height=600)
    for step in range(50):
        art_page.draw_rect(
            fitz.Rect(10 + step, 10 + step, 320 + step, 220 + step),
            color=(step / 50, 0.2, 0.8),
        )
    image_bytes = art_page.get_pixmap(dpi=200).tobytes("png")
    art.close()

    doc = fitz.open()
    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 90), f"BTLTech test page {index + 1}", fontsize=18)
        for row in range(6):
            box = fitz.Rect(72, 140 + row * 20, 400, 158 + row * 20)
            page.draw_rect(box, color=(0.4, 0.4, 0.4))
            page.insert_text((box.x0 + 4, box.y1 - 5), f"row {row} value", fontsize=9)
        page.insert_image(fitz.Rect(72, 300, 300, 452), stream=image_bytes)
    return doc.tobytes()


if __name__ == "__main__":
    out = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as handle:
        handle.write(make_pdf())
    print(f"Wrote {out}")
