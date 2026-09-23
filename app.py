# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""BTL Tech - PDF to Word converter (V1 + V2).

Converts digital/text PDF files into editable .docx documents, preserving
images, tables, headings and general formatting.

Quick start:
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    .venv/bin/python app.py
Then open http://127.0.0.1:8000

Configuration (environment variables):
    PDF2WORD_HOST     interface to bind          (default 0.0.0.0)
    PDF2WORD_PORT     port to listen on          (default 8000)
    PDF2WORD_MAX_MB   max upload size in MB      (default 50)
    PDF2WORD_CONVERT_WORKERS    conversions run at once       (default 2)
    PDF2WORD_CONVERT_TIMEOUT_S  stop a conversion after this   (default 300)
"""

import asyncio
import logging
import html
import os
import sys
import re
import shutil
import tempfile
from pathlib import Path
from typing import Optional, Tuple

# PyMuPDF >= 1.24 exposes the modern `pymupdf` name; older releases only ship
# the legacy `fitz` alias. NB: pdf2docx still imports `fitz` internally, so each
# conversion's child process prints one PyMuPDF deprecation notice to stderr;
# run_converter() drops it. It is informational only.
try:
    import pymupdf as fitz
except ImportError:  # pragma: no cover - legacy PyMuPDF
    import fitz

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

import source_offer
import tools
from config import (
    CONVERT_TIMEOUT_S,
    CONVERT_WORKERS,
    HOST,
    MAX_UPLOAD_MB,
    PORT,
    SUPPORT_LABEL,
    SUPPORT_URL,
)

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

DOCX_MEDIA_TYPE = (
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

# Hold the root logger at WARNING so third-party chatter (pdf2docx logs a
# progress line per page at INFO) stays out of the log, while our own logger
# still reports every conversion at INFO.
_handler = logging.StreamHandler()
_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s  %(message)s"))
logging.basicConfig(level=logging.WARNING, handlers=[_handler], force=True)

log = logging.getLogger("pdf2word")
log.setLevel(logging.INFO)

app = FastAPI(title="BTL Tech PDF Toolkit", version="2.0.0")

# PDF -> Word runs in a child process per conversion (converter_worker.py), so
# pdf2docx's memory is returned when each one ends. This caps how many run at
# once; the rest wait their turn, which also caps peak memory.
WORKER = str(BASE_DIR / "converter_worker.py")
_convert_slots = asyncio.Semaphore(CONVERT_WORKERS)


async def run_converter(in_path: str, out_path: str, start: Optional[int], end: Optional[int]) -> None:
    """Convert in a separate process; raise RuntimeError with its message on failure."""
    args = [sys.executable, WORKER, in_path, out_path]
    if start is not None:
        args += [str(start), str(end)]
    async with _convert_slots:
        proc = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE
        )
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=CONVERT_TIMEOUT_S)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise RuntimeError(f"it took longer than {CONVERT_TIMEOUT_S} seconds and was stopped")
    if proc.returncode != 0:
        # pdf2docx imports PyMuPDF's legacy name and PyMuPDF prints a deprecation
        # notice to stderr; the worker's own message is always the last line.
        lines = [line for line in stderr.decode("utf-8", "replace").splitlines()
                 if line.strip() and "fitz` API is deprecated" not in line]
        raise RuntimeError(lines[-1] if lines else f"the converter exited with status {proc.returncode}")

# Server-side page tools (merge, split, compress, protect ...).
app.include_router(tools.router)

# AGPL-3.0 s.13 source offer: /source and /source.zip.
app.include_router(source_offer.router)

class StaticGZip(GZipMiddleware):
    """Compress the static assets, and only those.

    The text editor's PDFium build is 4.4 MB and gzips to 2.0 MB, so a first
    visit halves; the fonts and scripts gain similarly. Converted .docx files and
    PDFs are already compressed, and running them through gzip would spend CPU on
    every download to save nothing, so anything outside /static goes straight
    through untouched.
    """

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http" and scope.get("path", "").startswith("/static/"):
            return await super().__call__(scope, receive, send)
        return await self.app(scope, receive, send)


app.add_middleware(StaticGZip, minimum_size=1024)

# Stylesheet and other static assets.
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def parse_pages(spec: Optional[str]) -> Tuple[Optional[int], Optional[int]]:
    """Parse a 1-based page spec like '2' or '1-5,8' into (start, end).

    Returns bounds for pdf2docx's simple Converter API, which takes a
    0-based `start` and an exclusive `end`. (None, None) means all pages.
    """
    if not spec or not spec.strip():
        return None, None

    wanted = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        span = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if span:
            first, last = int(span.group(1)), int(span.group(2))
            wanted.update(range(min(first, last), max(first, last) + 1))
        elif part.isdigit():
            wanted.add(int(part))

    if not wanted or min(wanted) < 1:
        return None, None
    return min(wanted) - 1, max(wanted)


def _support_link() -> str:
    """The optional 'support this tool' link, or nothing at all.

    Deliberately a plain anchor: a payment provider's script on these pages would
    contradict what they promise about files never leaving the browser. Nothing is
    gated behind it - the tools are free either way.
    """
    if not SUPPORT_URL:
        return ""
    url = html.escape(SUPPORT_URL, quote=True)
    label = html.escape(SUPPORT_LABEL or "Support this tool")
    return (
        f'<span class="support-line">&middot; <a href="{url}" rel="noopener noreferrer nofollow"'
        f' target="_blank">{label}</a></span>'
    )


def _page(name: str) -> HTMLResponse:
    """Serve one of the static HTML pages."""
    path = STATIC_DIR / name
    if not path.is_file():
        raise HTTPException(404, f"Page '{name}' is not installed")
    return HTMLResponse(path.read_text(encoding="utf-8").replace("<!--SUPPORT-->", _support_link()))


@app.get("/", response_class=HTMLResponse)
async def home() -> HTMLResponse:
    """Toolkit landing page."""
    return _page("index.html")


@app.get("/convert", response_class=HTMLResponse)
async def convert_page() -> HTMLResponse:
    """PDF -> Word converter UI."""
    return _page("convert.html")


@app.get("/edit", response_class=HTMLResponse)
async def edit_page() -> HTMLResponse:
    """Browser-side PDF editor: annotate, sign, organise pages."""
    return _page("editor.html")


@app.get("/edit-text", response_class=HTMLResponse)
async def edit_text_page() -> HTMLResponse:
    """Edit the text already in a PDF. Runs entirely in the browser: no upload."""
    return _page("edittext.html")


@app.get("/privacy", response_class=HTMLResponse)
async def privacy_page() -> HTMLResponse:
    """What happens to a document, tool by tool."""
    return _page("privacy.html")


@app.get("/tools", response_class=HTMLResponse)
async def tools_page() -> HTMLResponse:
    """Server-side page tools UI."""
    return _page("tools.html")


@app.get("/api/health")
async def health() -> dict:
    """Simple readiness probe."""
    return {"status": "ok", "max_upload_mb": MAX_UPLOAD_MB}


@app.post("/api/convert")
async def convert(
    file: UploadFile = File(...),
    pages: Optional[str] = Query(
        None, description="Optional page range, e.g. '1-5' or '2,4-6'"
    ),
):
    """Convert an uploaded PDF to .docx and stream it back as a download."""
    filename = file.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are supported (.pdf)")

    data = await file.read()
    if not data:
        raise HTTPException(400, "The uploaded file is empty")
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"File is too large - the limit is {MAX_UPLOAD_MB} MB")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, "This file does not look like a valid PDF")

    start, end = parse_pages(pages)

    tmp_dir = tempfile.mkdtemp(prefix="pdf2word_")
    in_path = os.path.join(tmp_dir, "input.pdf")
    out_name = Path(filename).stem + ".docx"
    out_path = os.path.join(tmp_dir, out_name)

    try:
        with open(in_path, "wb") as handle:
            handle.write(data)

        # Pre-flight checks with PyMuPDF: fast, and gives friendly errors.
        doc = fitz.open(in_path)
        try:
            if doc.is_encrypted:
                raise HTTPException(
                    400, "This PDF is password-protected. Remove the password and retry."
                )
            page_count = doc.page_count
        finally:
            doc.close()

        if page_count == 0:
            raise HTTPException(400, "This PDF contains no pages")
        if start is not None and end is not None and (
            start >= page_count or end > page_count
        ):
            raise HTTPException(
                400,
                f"Page range out of bounds - the document has {page_count} "
                f"page{'s' if page_count != 1 else ''}",
            )

        # CPU-bound, and pdf2docx never hands its memory back, so it runs in
        # a child process that exits afterwards (see run_converter).
        await run_converter(in_path, out_path, start, end)

        if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
            raise HTTPException(
                500,
                "Conversion produced no output. This usually means the PDF is "
                "scanned (an image) rather than digital text - OCR is the V3 feature.",
            )

        converted = (end - start) if start is not None and end is not None else page_count
        # The filename is deliberately not logged. People name documents after
        # themselves, their clients and their cases, and a service that promises
        # to keep nothing should not leave that promise's exception in a log file
        # that outlives the upload. The extension, size and page count are what
        # diagnosing a failed conversion actually needs.
        log.info(
            "Converted a %s upload of %.1f MB (%s of %s page(s))",
            (os.path.splitext(filename)[1] or ".pdf").lower(),
            len(data) / 1_048_576,
            converted,
            page_count,
        )

        return FileResponse(
            path=out_path,
            media_type=DOCX_MEDIA_TYPE,
            filename=out_name,
            # Delete the temp working directory once the file has been sent.
            background=BackgroundTask(shutil.rmtree, tmp_dir, ignore_errors=True),
        )

    except HTTPException:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
        shutil.rmtree(tmp_dir, ignore_errors=True)
        log.exception("Conversion failed for a %s upload", (os.path.splitext(filename)[1] or ".pdf").lower())
        raise HTTPException(500, f"Conversion failed: {exc}") from exc


if __name__ == "__main__":
    import uvicorn

    log.info("BTL Tech PDF to Word converter listening on http://%s:%s", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT)