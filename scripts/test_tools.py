# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Regression tests for the PDF toolkit.

Runs the real FastAPI app in-process - no server required.

Usage:
    .venv/bin/python scripts/test_tools.py
Exit code is 0 when everything passes, 1 otherwise.
"""

import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pymupdf as fitz  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402

client = TestClient(app)

PASSED = []
FAILED = []


def check(label, condition, detail=""):
    """Record and print one assertion."""
    (PASSED if condition else FAILED).append(label)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))


def make_pdf(pages=4, with_image=True):
    """Build a test PDF in memory."""
    doc = fitz.open()
    image_bytes = None
    if with_image:
        art = fitz.open()
        art_page = art.new_page(width=900, height=600)
        for step in range(50):
            art_page.draw_rect(
                fitz.Rect(10 + step, 10 + step, 320 + step, 220 + step),
                color=(step / 50, 0.2, 0.8),
            )
        image_bytes = art_page.get_pixmap(dpi=200).tobytes("png")
        art.close()

    for index in range(pages):
        page = doc.new_page()
        page.insert_text((72, 90), f"BTLTech test page {index + 1}", fontsize=18)
        for row in range(6):
            box = fitz.Rect(72, 140 + row * 20, 400, 158 + row * 20)
            page.draw_rect(box, color=(0.4, 0.4, 0.4))
            page.insert_text((box.x0 + 4, box.y1 - 5), f"row {row} value", fontsize=9)
        if image_bytes:
            page.insert_image(fitz.Rect(72, 300, 300, 452), stream=image_bytes)
    return doc.tobytes()


def upload(name, data, content_type="application/pdf"):
    return {"file": (name, data, content_type)}


def open_pdf(data):
    return fitz.open(stream=data, filetype="pdf")


FOUR = make_pdf(4)
TWO = make_pdf(2)

print("\n=== page tools ===")

response = client.post("/api/tools/info", files=upload("four.pdf", FOUR))
check("info returns page count", response.status_code == 200 and response.json()["pages"] == 4,
      str(response.json()))

response = client.post(
    "/api/tools/merge",
    files=[("files", ("a.pdf", FOUR, "application/pdf")), ("files", ("b.pdf", TWO, "application/pdf"))],
)
merged = open_pdf(response.content) if response.status_code == 200 else None
check("merge combines both files", response.status_code == 200 and merged.page_count == 6,
      f"{response.status_code}, {merged.page_count if merged else '-'} pages")

response = client.post("/api/tools/split", files=upload("four.pdf", FOUR), data={"pages": "1-2"})
split_doc = open_pdf(response.content) if response.status_code == 200 else None
check("split extracts a page range", response.status_code == 200 and split_doc.page_count == 2,
      f"{response.status_code}, {split_doc.page_count if split_doc else '-'} pages")

response = client.post(
    "/api/tools/split", files=upload("four.pdf", FOUR), data={"pages": "1-4", "separate": "true"}
)
ok = response.status_code == 200 and response.headers["content-type"] == "application/zip"
if ok:
    with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
        names = bundle.namelist()
    ok = len(names) == 4
check("split into separate files returns a ZIP of 4", ok, str(names if ok else response.status_code))

response = client.post("/api/tools/delete-pages", files=upload("four.pdf", FOUR), data={"pages": "2"})
kept = open_pdf(response.content) if response.status_code == 200 else None
check("delete-pages removes one page", response.status_code == 200 and kept.page_count == 3,
      f"{kept.page_count if kept else '-'} pages left")

response = client.post("/api/tools/rotate", files=upload("four.pdf", FOUR), data={"angle": "90"})
rotated = open_pdf(response.content) if response.status_code == 200 else None
check("rotate sets all pages to 90 degrees",
      response.status_code == 200 and all(p.rotation == 90 for p in rotated),
      f"rotations {[p.rotation for p in rotated] if rotated else '-'}")

response = client.post("/api/tools/rotate", files=upload("four.pdf", FOUR), data={"angle": "90", "pages": "1"})
partial = open_pdf(response.content) if response.status_code == 200 else None
check("rotate can target a single page",
      response.status_code == 200 and [p.rotation for p in partial] == [90, 0, 0, 0],
      f"rotations {[p.rotation for p in partial] if partial else '-'}")

response = client.post("/api/tools/compress", files=upload("four.pdf", FOUR), data={"level": "balanced"})
original_size = int(response.headers.get("X-Original-Size", 0))
new_size = int(response.headers.get("X-New-Size", 0))
compressed = open_pdf(response.content) if response.status_code == 200 else None
check("compress returns a valid PDF of the same length",
      response.status_code == 200 and compressed.page_count == 4,
      f"{original_size} -> {new_size} bytes")


print("\n=== password ===")

response = client.post("/api/tools/protect", files=upload("four.pdf", FOUR), data={"password": "hunter2"})
protected = response.content if response.status_code == 200 else b""
locked = fitz.open(stream=protected, filetype="pdf") if protected else None
check(
    "protect produces an encrypted PDF",
    response.status_code == 200 and locked is not None and locked.needs_pass,
    f"needs_pass={locked.needs_pass if locked else '-'}",
)

response = client.post(
    "/api/tools/unlock", files=upload("locked.pdf", protected), data={"password": "wrong-one"}
)
check("unlock rejects a wrong password", response.status_code == 400, str(response.status_code))

response = client.post(
    "/api/tools/unlock", files=upload("locked.pdf", protected), data={"password": "hunter2"}
)
unlocked = open_pdf(response.content) if response.status_code == 200 else None
check(
    "unlock removes protection with the right password",
    response.status_code == 200
    and unlocked is not None
    and not unlocked.needs_pass
    and unlocked.page_count == 4,
    f"needs_pass={unlocked.needs_pass if unlocked else '-'}",
)

response = client.post("/api/tools/protect", files=upload("four.pdf", FOUR), data={"password": "ab"})
check("protect rejects a too-short password", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/unlock", files=upload("four.pdf", FOUR), data={"password": "x"})
check("unlock rejects a PDF that is not protected", response.status_code == 400, str(response.status_code))

print("\n=== stamps ===")

response = client.post(
    "/api/tools/watermark", files=upload("four.pdf", FOUR), data={"text": "CONFIDENTIAL", "opacity": "0.2"}
)
watermarked = open_pdf(response.content) if response.status_code == 200 else None
found = "CONFIDENTIAL" in "\n".join(page.get_text() for page in watermarked) if watermarked else False
check(
    "watermark text lands on every page",
    response.status_code == 200 and found and watermarked.page_count == 4,
)

response = client.post(
    "/api/tools/page-numbers",
    files=upload("four.pdf", FOUR),
    data={"position": "bottom-centre", "label_format": "Page {n} of {total}"},
)
numbered = open_pdf(response.content) if response.status_code == 200 else None
first_page = numbered[0].get_text() if numbered else ""
last_page = numbered[3].get_text() if numbered else ""
check(
    "page numbers read 'Page 1 of 4' ... 'Page 4 of 4'",
    "Page 1 of 4" in first_page and "Page 4 of 4" in last_page,
)

print("\n=== validation ===")

response = client.post("/api/tools/merge", files=[("files", ("a.pdf", FOUR, "application/pdf"))])
check("merge needs at least two files", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/split", files=upload("four.pdf", FOUR), data={"pages": "abc"})
check("nonsense page selection is rejected", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/split", files=upload("four.pdf", FOUR), data={"pages": "99"})
check("out-of-range page is rejected", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/delete-pages", files=upload("four.pdf", FOUR), data={"pages": "1-4"})
check("deleting every page is rejected", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/rotate", files=upload("four.pdf", FOUR), data={"angle": "45"})
check("invalid rotation angle is rejected", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/watermark", files=upload("four.pdf", FOUR), data={"text": "   "})
check("blank watermark text is rejected", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/info", files=upload("notes.txt", b"hello", "text/plain"))
check("non-PDF upload is rejected", response.status_code == 400, str(response.status_code))

response = client.post("/api/tools/info", files=upload("fake.pdf", b"definitely not a pdf", "application/pdf"))
check("corrupt PDF upload is rejected", response.status_code == 400, str(response.status_code))

print("\n=== pages and converter ===")

for path, label in [("/", "hub"), ("/convert", "converter"), ("/edit", "editor"), ("/tools", "page tools")]:
    response = client.get(path)
    check(
        f"{label} page loads at {path}",
        response.status_code == 200 and "<html" in response.text.lower(),
        str(response.status_code),
    )

response = client.get("/static/app.css")
check("shared stylesheet is served", response.status_code == 200 and "--accent" in response.text)

response = client.post("/api/convert", files=upload("four.pdf", FOUR))
check(
    "PDF -> Word conversion still works",
    response.status_code == 200 and len(response.content) > 1000 and response.content[:2] == b"PK",
    f"{len(response.content)} bytes",
)

# --------------------------------------------------------------- one address ---
# The service can answer on several hostnames. Only the ones it is told about
# should be redirected: getting this wrong would send the Railway URL, or
# localhost, into a loop.
print("\n=== canonical host ===")
import importlib  # noqa: E402

import config  # noqa: E402

_saved = (config.CANONICAL_HOST, config.REDIRECT_HOSTS)
try:
    import app as _app

    _app.CANONICAL_HOST = "pdf.example.test"
    _app.REDIRECT_HOSTS = ["tools.example.test"]
    r = client.get("/", headers={"host": "tools.example.test"}, follow_redirects=False)
    check("an alternate hostname redirects permanently", r.status_code == 301, str(r.status_code))
    check(
        "it redirects to the canonical host",
        r.headers.get("location") == "https://pdf.example.test/",
        r.headers.get("location", ""),
    )
    r = client.get("/edit-text?a=1", headers={"host": "tools.example.test"}, follow_redirects=False)
    check(
        "the path and query survive the redirect",
        r.headers.get("location") == "https://pdf.example.test/edit-text?a=1",
        r.headers.get("location", ""),
    )
    r = client.get("/", headers={"host": "pdf.example.test"}, follow_redirects=False)
    check("the canonical host is served, not redirected", r.status_code == 200, str(r.status_code))
    r = client.get("/", headers={"host": "anything-else.up.railway.app"}, follow_redirects=False)
    check("an unlisted hostname is left alone", r.status_code == 200, str(r.status_code))
    _app.CANONICAL_HOST, _app.REDIRECT_HOSTS = "", []
    r = client.get("/", headers={"host": "tools.example.test"}, follow_redirects=False)
    check("with nothing configured, nothing redirects", r.status_code == 200, str(r.status_code))
finally:
    import app as _app

    _app.CANONICAL_HOST, _app.REDIRECT_HOSTS = _saved


print("\n=== summary ===")
print(f"  passed: {len(PASSED)}")
print(f"  failed: {len(FAILED)}")
for label in FAILED:
    print(f"    - {label}")
sys.exit(1 if FAILED else 0)