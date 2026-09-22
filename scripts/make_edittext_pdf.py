# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Write the fixture the Edit Existing Text browser suite loads.

Two pages, built so that every kind of answer the editor can give is reachable:

  page 1  an underlined heading          -> an edit that keeps the underline
          ordinary lines                 -> a plain in-place replacement
          a justified paragraph          -> refused: re-setting it would lose the
                                            stretched word spacing
          a line of Chinese              -> refused: script this cannot re-set
  page 2  a picture and nothing else     -> refused: a scan, with no text to edit

Usage:
    .venv/bin/python scripts/make_edittext_pdf.py [out.pdf]
        (default test-output/edittext.pdf)
"""

import os
import sys

import pymupdf as fitz

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUT = os.path.join(HERE, "..", "test-output", "edittext.pdf")

JUSTIFIED = (
    "The supplier shall provide the services described in the schedule with "
    "reasonable skill and care, and shall not subcontract any part of them "
    "without the prior written consent of the client, such consent not to be "
    "unreasonably withheld or delayed."
)


def build(out: str) -> str:
    doc = fitz.open()

    page = doc.new_page(width=460, height=380)
    # heading with a rule under it, the width of the words: a real underline
    page.insert_text((40, 60), "Invoice Summary", fontsize=16, fontname="hebo")
    width = fitz.get_text_length("Invoice Summary", fontname="hebo", fontsize=16)
    page.draw_line(fitz.Point(40, 64.5), fitz.Point(40 + width, 64.5), width=1.1)

    page.insert_text((40, 100), "Client: Northwood Services Ltd", fontsize=11)
    page.insert_text((40, 120), "Reference: NW-2291", fontsize=11)
    page.insert_text((40, 140), "Amount due: 1,240.00", fontsize=11)

    page.insert_textbox(
        fitz.Rect(40, 170, 420, 260), JUSTIFIED, fontsize=10, align=fitz.TEXT_ALIGN_JUSTIFY
    )

    page.insert_text((40, 300), "客户名称与地址", fontsize=12, fontname="china-s")

    # page 2: a picture only, which is what a scan looks like to a PDF reader
    scan = doc.new_page(width=460, height=380)
    pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 360, 280), False)
    pix.set_rect(pix.irect, (246, 246, 240))
    for y in range(30, 250, 26):                     # grey bars, like lines of text
        pix.set_rect(fitz.IRect(24, y, 336, y + 9), (120, 120, 126))
    scan.insert_image(fitz.Rect(50, 50, 410, 330), pixmap=pix)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    doc.save(out, garbage=4, deflate=True)
    return out


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_OUT
    path = build(target)
    print(f"{path} ({os.path.getsize(path)} bytes)")
