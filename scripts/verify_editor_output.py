# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Inspect the PDF the editor saved during scripts/browser_test.mjs.

The browser test loads test-output/four.pdf (pages titled "BTL Tech test
page 1..4"), writes "EDITOR TEST MARK" and a highlight on page 1, removes
page 2, moves a page, and saves test-output/edited.pdf (plus the page
order it showed, in edited-order.json). This checks the
saved file itself: right pages, real selectable text, marks baked in.

These are the eight PDF-level assertions the README has always described;
until now they were run by hand and not kept in the repository.

Usage:
    .venv/bin/python scripts/verify_editor_output.py [source.pdf] [edited.pdf]
"""

import json
import os
import re
import sys

import pymupdf as fitz

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "..", "test-output")
SOURCE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(OUT_DIR, "four.pdf")
EDITED = sys.argv[2] if len(sys.argv) > 2 else os.path.join(OUT_DIR, "edited.pdf")

PASSED, FAILED = [], []


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))


def page_number(page):
    found = re.search(r"BTL Tech test page (\d+)", page.get_text())
    return int(found.group(1)) if found else None


print("\n=== editor output ===")
try:
    edited = fitz.open(EDITED)
    opened = True
except Exception as exc:  # noqa: BLE001
    edited, opened = None, False
    print(f"  cannot open {EDITED}: {exc}")
check("the saved file opens as a PDF", opened and edited.page_count > 0)
if not opened:
    sys.exit(1)

source = fitz.open(SOURCE)
order = [page_number(page) for page in edited]
check("one page was left out (4 -> 3 pages)", edited.page_count == source.page_count - 1,
      f"{edited.page_count} pages")
check("the left-out page is really gone", 2 not in order, f"pages {order}")
order_file = os.path.splitext(EDITED)[0] + "-order.json"
shown = json.load(open(order_file)) if os.path.exists(order_file) else None
check("pages are saved in the order the editor showed", order == shown,
      f"saved {order}, editor showed {shown}")

all_text = "\n".join(page.get_text() for page in edited)
check("added text is real, selectable text", "EDITOR TEST MARK" in all_text)
check("the original text survives", "row 5 value" in all_text and "BTL Tech test page 1" in all_text)

marked = next((page for page in edited if "EDITOR TEST MARK" in page.get_text()), None)
original_first = source[0]
extra_drawings = (len(marked.get_drawings()) - len(original_first.get_drawings())) if marked else 0
check("the highlight is baked into the page content", marked is not None and extra_drawings >= 1,
      f"{extra_drawings} extra vector drawing(s) on the marked page")
check("marks are page content, not removable annotations",
      all(not list(page.annots()) for page in edited))

print("\n=== summary ===")
print(f"  passed: {len(PASSED)}")
print(f"  failed: {len(FAILED)}")
for label in FAILED:
    print(f"    - {label}")
sys.exit(1 if FAILED else 0)
