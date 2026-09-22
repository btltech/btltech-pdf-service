# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Check the PDF that scripts/browser_edittext_test.mjs saved.

PDFium produced that file, so PDFium is not the right thing to ask whether it is
sound. This reads it with PyMuPDF - a different engine entirely - and checks that
the new wording is really there, the old wording is really gone, nothing else
moved, and the document still opens cleanly.

    .venv/bin/python scripts/verify_edittext_output.py
"""

import json
import os
import re
import sys

import pymupdf

pymupdf.TOOLS.mupdf_display_errors(False)

HERE = os.path.dirname(os.path.abspath(__file__))
EDITED = os.environ.get("OUT_PDF", os.path.join(HERE, "..", "test-output", "edittext-edited.pdf"))
SOURCE = os.environ.get("TEST_PDF", os.path.join(HERE, "..", "test-output", "edittext.pdf"))
EXPECTED = EDITED.replace(".pdf", "-expected.json")

passed, failed = [], []


def check(label: str, ok: bool, detail: str = "") -> None:
    (passed if ok else failed).append(label)
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))


def squash(s: str) -> str:
    return re.sub(r"\s+", "", s)


for path in (EDITED, SOURCE):
    if not os.path.exists(path):
        print(f"  [FAIL] missing {path} - run the browser suite first")
        sys.exit(1)

expected = json.load(open(EXPECTED)) if os.path.exists(EXPECTED) else {}
new_text = expected.get("newText", "")

src = pymupdf.open(SOURCE)
pymupdf.TOOLS.reset_mupdf_warnings()
doc = pymupdf.open(EDITED)
[p.get_text() for p in doc]
warnings = sorted(set(pymupdf.TOOLS.mupdf_warnings().splitlines()))

print("\n=== the saved file ===")
check("it opens in a different PDF engine", doc.page_count > 0)
check("the page count is unchanged", doc.page_count == src.page_count, f"{doc.page_count} vs {src.page_count}")
check("it needed no repairing", not doc.is_repaired)
check("it produced no reader warnings", not warnings, "; ".join(warnings[:2]))

page, before = doc[0], src[0]
after_text = page.get_text()

print("\n=== the edit ===")
if new_text:
    check("the new wording is in the file", squash(new_text) in squash(after_text), repr(new_text[:40]))
    old = expected.get("replaced") or ""
    if old:
        check("the old wording is gone", squash(old) not in squash(after_text), repr(old[:40]))
else:
    check("the browser suite recorded what it saved", False, "no -expected.json")

# Everything the edit did not touch must still be there, in the same place.
def lines(p):
    return {
        squash("".join(s["text"] for s in l["spans"])): tuple(round(v, 1) for v in l["bbox"])
        for b in p.get_text("dict")["blocks"]
        for l in b.get("lines", [])
        if squash("".join(s["text"] for s in l["spans"]))
    }


a, b = lines(before), lines(page)
kept = [t for t in a if t in b]
moved = [t for t in kept if a[t] != b[t]]
check("the rest of the page is untouched", not moved, f"{len(moved)} line(s) moved: {moved[:2]}")
check("most of the original text is still there", len(kept) >= len(a) - 2, f"{len(kept)} of {len(a)} lines")

print("\n=== summary ===")
print("  passed:", len(passed))
print("  failed:", len(failed))
for label in failed:
    print("    -", label)
sys.exit(1 if failed else 0)
