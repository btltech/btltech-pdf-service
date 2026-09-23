# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Generate a demo PDF that exercises the V1 + V2 conversion features.

It contains a title, headings, body text, a ruled table and an image, so a
conversion of this file tells you whether tables / images / formatting survive.

Usage:
    .venv/bin/python scripts/make_sample_pdf.py
Creates:
    samples/demo.pdf  and  samples/logo.png
"""

import os

try:  # PyMuPDF >= 1.24 exposes the modern 'pymupdf' name
    import pymupdf as fitz
except ImportError:  # older releases only ship the classic 'fitz' alias
    import fitz  # PyMuPDF, installed as a pdf2docx dependency

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.normpath(os.path.join(HERE, "..", "samples"))

HEADER_ROW = ["Item", "Status", "Pages", "Updated"]
TABLE_ROWS = [
    HEADER_ROW,
    ["Quarterly report", "Final", "24", "12/2025"],
    ["Price list", "Draft", "3", "03/2026"],
    ["Staff handbook", "Final", "41", "09/2025"],
]


def make_logo(path: str) -> None:
    """Render a small PNG so the sample PDF has a real embedded image."""
    doc = fitz.open()
    page = doc.new_page(width=300, height=170)
    page.draw_rect(fitz.Rect(0, 0, 300, 170), color=None, fill=(0.05, 0.07, 0.12))
    page.draw_rect(fitz.Rect(20, 24, 120, 80), color=(0.36, 0.55, 1.0), fill=(0.14, 0.28, 0.62))
    page.draw_circle(fitz.Point(210, 60), 40, color=(1.0, 0.55, 0.3), fill=(0.85, 0.35, 0.15))
    page.insert_text((20, 120), "BTLTech", fontsize=22, color=(1, 1, 1))
    page.insert_text((20, 145), "PDF toolkit sample", fontsize=11, color=(0.7, 0.78, 0.9))
    page.get_pixmap().save(path)
    doc.close()


def draw_table(page: fitz.Page, x0: float, y0: float, col_widths, rows) -> float:
    """Draw a ruled table and return its total height."""
    row_height = 26.0
    total_h = row_height * len(rows)
    grid_color = (0.35, 0.35, 0.35)

    for index in range(len(rows) + 1):  # horizontal rules
        y = y0 + row_height * index
        page.draw_line(fitz.Point(x0, y), fitz.Point(x0 + sum(col_widths), y), color=grid_color)

    x_edges = [x0]
    for width in col_widths:  # vertical rules
        x_edges.append(x_edges[-1] + width)
    for x in x_edges:
        page.draw_line(fitz.Point(x, y0), fitz.Point(x, y0 + total_h), color=grid_color)

    for row_index, row in enumerate(rows):
        baseline = y0 + row_height * row_index + row_height - 8
        for col_index, cell in enumerate(row):
            page.insert_text(
                (x_edges[col_index] + 7, baseline),
                cell,
                fontsize=10,
                color=(0.1, 0.1, 0.1),
            )
    return total_h


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    logo_path = os.path.join(OUT_DIR, "logo.png")
    make_logo(logo_path)

    doc = fitz.open()
    page = doc.new_page()  # A4 portrait: 595 x 842 pt

    page.insert_text((72, 90), "BTLTech Sample Report", fontsize=26, color=(0.05, 0.07, 0.12))
    page.insert_text(
        (72, 116), "Sample document for the PDF to Word converter", fontsize=11, color=(0.4, 0.45, 0.55)
    )

    page.insert_text((72, 166), "1. About this document", fontsize=16, color=(0.1, 0.15, 0.3))
    page.insert_textbox(
        fitz.Rect(72, 182, 523, 250),
        "This sample exercises the converter's handling of headings, body text, "
        "ruled tables and images. If the .docx keeps the heading sizes, the table "
        "grid with its cells, and the picture below, then V1 + V2 are working as "
        "intended on this document.",
        fontsize=10.5,
    )

    page.insert_text((72, 280), "2. Document register", fontsize=16, color=(0.1, 0.15, 0.3))
    draw_table(page, 72, 296, [140, 100, 100, 111], TABLE_ROWS)

    page.insert_text((72, 450), "3. An embedded image", fontsize=16, color=(0.1, 0.15, 0.3))
    page.insert_image(fitz.Rect(72, 466, 282, 576), filename=logo_path)

    out_path = os.path.join(OUT_DIR, "demo.pdf")
    doc.save(out_path)
    doc.close()
    print(f"Created {out_path}")


if __name__ == "__main__":
    main()