# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Write the sample invoice offered on /edit-text to people with no PDF to hand.

Somebody who scans the counter card on a phone rarely has a PDF ready, and an
empty "choose a file" box shows them nothing. This gives them one with two
mistakes worth fixing - an impossible date and a misspelt name - so the first
thing they see the editor do is the thing it is for.

Every line is a single, left-aligned line in a standard font, because a
customer's first edit should not be a refusal: no justified paragraph, no
scanned page, nothing the editor declines. The browser suite edits it to prove
that.

The server fingerprints this file when it starts and treats its clean copy as
free, so a visitor can go all the way through, download included, without
paying for a demonstration.

    .venv/bin/python scripts/make_sample_invoice.py
"""

import os

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "static", "samples", "sample-invoice.pdf")

NAVY = (0.14, 0.32, 0.51)
INK = (0.10, 0.12, 0.16)
MUTED = (0.40, 0.44, 0.50)


def main() -> None:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)          # A4

    page.insert_text((56, 90), "Invoice", fontsize=26, fontname="hebo", color=NAVY)
    page.insert_text((56, 118), "Northwood Servises Ltd", fontsize=12, fontname="helv", color=INK)
    page.insert_text((56, 136), "14 Mill Lane, London", fontsize=10, fontname="helv", color=MUTED)

    rows = [
        ("Invoice number", "INV-0417"),
        ("Date", "31 February 2026"),
        ("Payment due", "Within 30 days"),
    ]
    y = 190
    for label, value in rows:
        page.insert_text((56, y), label, fontsize=10, fontname="helv", color=MUTED)
        page.insert_text((200, y), value, fontsize=11, fontname="helv", color=INK)
        y += 22

    page.draw_line((56, 270), (539, 270), color=(0.85, 0.87, 0.90), width=0.8)
    page.insert_text((56, 296), "Website redesign and hosting", fontsize=11, fontname="helv", color=INK)
    page.insert_text((440, 296), "1,240.00", fontsize=11, fontname="helv", color=INK)
    page.draw_line((56, 312), (539, 312), color=(0.85, 0.87, 0.90), width=0.8)
    page.insert_text((56, 338), "Total due", fontsize=11, fontname="hebo", color=INK)
    page.insert_text((440, 338), "1,240.00", fontsize=11, fontname="hebo", color=INK)

    page.insert_text((56, 420), "Thank you for your business.", fontsize=11, fontname="helv", color=INK)
    page.insert_text((56, 780), "A sample document for trying the BTLTech text editor.",
                     fontsize=8, fontname="helv", color=MUTED)

    doc.set_metadata({"title": "Sample invoice", "author": "BTLTECH LTD",
                      "creator": "BTLTech PDF tools", "producer": "BTLTech PDF tools"})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc.save(OUT, garbage=4, deflate=True)
    print("wrote", os.path.relpath(OUT))


if __name__ == "__main__":
    main()
