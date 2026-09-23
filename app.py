# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""BTLTech - PDF to Word converter (V1 + V2).

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

from fastapi import Body, FastAPI, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask

import billing
import paypal
import source_offer
import tools
from config import (
    CANONICAL_HOST,
    CONVERT_TIMEOUT_S,
    CURRENCY,
    CONVERT_WORKERS,
    HOST,
    MAX_UPLOAD_MB,
    PORT,
    REDIRECT_HOSTS,
    SUPPORT_LABEL,
    SUPPORT_URL,
)

BASE_DIR = Path(__file__).resolve().parent
# Short, stable per-deployment string used to address the assets.
ASSET_VERSION = (os.environ.get("PDF_SOURCE_VERSION") or os.environ.get("RAILWAY_GIT_COMMIT_SHA") or "")[:12]
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

app = FastAPI(title="BTLTech PDF Toolkit", version="2.0.0")

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


@app.middleware("http")
async def canonical_host(request, call_next):
    """Send the alternate hostnames to the canonical one, and nothing else.

    Only hosts named in PDF_REDIRECT_HOSTS are touched, so the Railway URL,
    localhost and the test client are unaffected. The path and query string are
    carried across, so a shared deep link still lands where it was meant to.
    """
    if CANONICAL_HOST and REDIRECT_HOSTS:
        host = (request.headers.get("host") or "").split(":")[0].lower()
        if host in REDIRECT_HOSTS and host != CANONICAL_HOST:
            target = f"https://{CANONICAL_HOST}{request.url.path}"
            if request.url.query:
                target += f"?{request.url.query}"
            return RedirectResponse(target, status_code=301)
    return await call_next(request)


app.add_middleware(StaticGZip, minimum_size=1024)

class FreshStatic(StaticFiles):
    """Static files that are allowed to be cached, but must be checked first.

    Without this the CDN in front of the site kept the stylesheet and the
    scripts for four hours, so a fix took four hours to reach anyone - and, far
    worse, a visitor could be served a new page with the old scripts, which is
    how a working site breaks in ways nobody can reproduce. `no-cache` does not
    mean "do not store": the browser and the CDN still keep the file and still
    send an ETag, so an unchanged file costs a 304 and no bytes.
    """

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", FreshStatic(directory=STATIC_DIR), name="static")


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
    html_text = path.read_text(encoding="utf-8").replace("<!--SUPPORT-->", _support_link())
    # A new deployment gets new asset addresses, so nothing already held in a
    # cache can be served against a page that has moved on.
    if ASSET_VERSION:
        html_text = re.sub(r'(/static/[A-Za-z0-9_./-]+\.(?:css|js|mjs))(["\'])',
                           rf"\1?v={ASSET_VERSION}\2", html_text)
    return HTMLResponse(html_text)


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


@app.on_event("startup")
async def _prepare_billing() -> None:
    """Create the billing tables when billing is switched on. Never fatal.

    A database that is briefly unreachable must not stop the service starting:
    the tools that do not charge should keep working, and `enabled()` already
    falls back to giving the service away rather than taking money it cannot
    record.
    """
    try:
        billing.setup()
    except Exception as exc:                                   # noqa: BLE001
        log.warning("billing storage is not ready: %s", exc)


def _return_credit(reservation) -> None:
    """Put back a reserved conversion. A failure here must not hide the real error."""
    try:
        billing.refund(reservation)
    except Exception as exc:                                   # noqa: BLE001
        log.warning("could not return a reserved conversion: %s", exc)


def _packs_payload() -> list:
    return [{"credits": p.credits, "price": p.price, "label": p.label} for p in billing.packs()]


@app.get("/api/allowance")
async def allowance(request: Request, x_pdf_token: Optional[str] = Header(None)) -> dict:
    """What this caller may convert right now, and what they could buy."""
    if not billing.enabled():
        return {"billing": False, "may_convert": True}
    try:
        state = billing.allowance(billing.caller_ip(request), x_pdf_token)
    except Exception as exc:                                   # noqa: BLE001
        log.warning("allowance lookup failed: %s", exc)
        return {"billing": False, "may_convert": True}
    return {
        "billing": True,
        "may_convert": state.may_convert,
        "free_left": state.free_left,
        "free_per_day": state.free_per_day,
        "credits": state.credits,
        "packs": _packs_payload(),
        "currency": CURRENCY,
    }


@app.get("/api/export/status")
async def export_status(doc: str = Query("", max_length=128),
                        x_pdf_token: Optional[str] = Header(None)) -> dict:
    """Has this finished document been paid for, and what would it cost?

    `doc` is a hash the browser worked out from the file. The file itself is
    never sent here, so this can answer the question without ever seeing the
    document it is answering about.
    """
    price = billing.export_price()
    if not billing.enabled() or not paypal.configured():
        # Nothing to sell and no way to pay: the export is simply free.
        return {"billing": False, "unlocked": True}
    try:
        unlocked = billing.export_unlocked(x_pdf_token, doc)
    except Exception as exc:                                   # noqa: BLE001
        log.warning("could not check an export entitlement, allowing it: %s", exc)
        return {"billing": False, "unlocked": True}
    return {"billing": True, "unlocked": unlocked, "price": price.price, "currency": CURRENCY}


@app.post("/api/pay/create")
async def pay_create(payload: dict = Body(...)) -> dict:
    """Start a PayPal payment for one of the configured packs."""
    if not billing.enabled() or not paypal.configured():
        raise HTTPException(503, "Payments are not available on this server")
    # Two things are on sale: conversion packs, and a clean copy of one edited
    # document. The price of each comes from this server, never from the browser.
    if payload.get("product") == "export":
        doc = str(payload.get("doc") or "").strip()
        if not doc:
            raise HTTPException(400, "No document was named")
        pack, description = billing.export_price(), "Clean copy of an edited PDF"
    else:
        wanted = payload.get("credits")
        pack = next((p for p in billing.packs() if p.credits == wanted), None)
        if pack is None:
            raise HTTPException(400, "That is not one of the packs on offer")
        description = f"{pack.credits} PDF conversions"
    try:
        order_id, approve_url = await paypal.create_order(pack.price, CURRENCY, description)
    except paypal.PayPalError as exc:
        # 409 rather than 502 on purpose: a CDN replaces an origin 5xx with its
        # own error page, which would throw away the explanation the customer
        # needs. This is something they can act on, not a server fault.
        raise HTTPException(409, str(exc)) from exc
    return {"order_id": order_id, "approve_url": approve_url,
            "credits": pack.credits, "price": pack.price, "currency": CURRENCY}


@app.post("/api/pay/capture")
async def pay_capture(payload: dict = Body(...), x_pdf_token: Optional[str] = Header(None)) -> dict:
    """Finish a payment and add the credits, on PayPal's word rather than the browser's."""
    if not billing.enabled() or not paypal.configured():
        raise HTTPException(503, "Payments are not available on this server")
    order_id = str(payload.get("order_id") or "").strip()
    if not order_id:
        raise HTTPException(400, "No payment was named")
    try:
        result = await paypal.capture_order(order_id)
    except paypal.PayPalError as exc:
        raise HTTPException(409, str(exc)) from exc        # see the note above
    if not result.completed:
        raise HTTPException(402, "PayPal has not completed that payment")
    if result.currency != CURRENCY:
        raise HTTPException(409, "That payment was in a currency this service does not sell in")

    # A clean copy of one finished document.
    doc = str(payload.get("doc") or "").strip()
    if payload.get("product") == "export" and doc:
        if result.amount != billing.export_price().price:
            log.warning("an export payment of %s did not match the price", result.amount)
            raise HTTPException(409, "That payment does not match the price of an export")
        try:
            token = billing.grant_export(order_id, x_pdf_token, doc, result.amount, result.currency)
        except Exception as exc:                               # noqa: BLE001
            # PayPal has taken the money and we could not write it down. The
            # customer must still get what they paid for, so this returns
            # success and the browser produces their document; the loud log is
            # what makes the missing record recoverable afterwards.
            log.error(
                "PAID BUT NOT RECORDED - order %s, %s %s, document %s: %s",
                order_id, result.amount, result.currency, doc[:16], exc,
            )
            return {"token": x_pdf_token or "", "unlocked": True, "doc": doc, "recorded": False}
        return {"token": token, "unlocked": True, "doc": doc, "recorded": True}

    # Otherwise a pack of conversions. A payment for an amount this server does
    # not sell buys nothing, whatever the browser asked for.
    pack = next((p for p in billing.packs() if p.price == result.amount), None)
    if pack is None:
        log.warning("a payment of %s %s matched no pack on offer", result.amount, result.currency)
        raise HTTPException(409, "That payment does not match anything on sale here")
    try:
        token = billing.grant(order_id, x_pdf_token, pack.credits, result.amount, result.currency)
        state = billing.allowance("", token)
    except Exception as exc:                                   # noqa: BLE001
        # Same again: paid, not recorded. Conversions cannot be handed over
        # without the record, so this says so plainly and gives the customer the
        # reference they will need, rather than a blank failure.
        log.error(
            "PAID BUT NOT RECORDED - order %s, %s %s, %s conversions: %s",
            order_id, result.amount, result.currency, pack.credits, exc,
        )
        raise HTTPException(
            409,
            f"Your payment went through but could not be recorded. Nothing is lost - "
            f"quote reference {order_id} and it will be put right.",
        ) from exc
    return {"token": token, "credits": state.credits, "added": pack.credits}


@app.get("/robots.txt", response_class=PlainTextResponse)
async def robots() -> str:
    """Let crawlers in, and point them at the sitemap.

    The API and the source download are excluded: they are not pages, and a
    crawler fetching /source.zip repeatedly would cost bandwidth for nothing.
    """
    host = CANONICAL_HOST or "pdf.btltech.co.uk"
    return (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /source.zip\n"
        f"\nSitemap: https://{host}/sitemap.xml\n"
    )


@app.get("/sitemap.xml")
async def sitemap() -> Response:
    """The pages worth indexing, which is all of them except the API."""
    host = CANONICAL_HOST or "pdf.btltech.co.uk"
    pages = [("/", "1.0"), ("/convert", "0.9"), ("/edit-text", "0.9"),
             ("/edit", "0.8"), ("/tools", "0.8"), ("/privacy", "0.3"), ("/source", "0.3")]
    urls = "".join(
        f"<url><loc>https://{host}{path}</loc><priority>{priority}</priority></url>"
        for path, priority in pages
    )
    body = ('<?xml version="1.0" encoding="UTF-8"?>'
            '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' + urls + "</urlset>")
    return Response(body, media_type="application/xml")


@app.get("/api/health")
async def health() -> dict:
    """Simple readiness probe."""
    return {"status": "ok", "max_upload_mb": MAX_UPLOAD_MB}


@app.post("/api/convert")
async def convert(
    request: Request,
    file: UploadFile = File(...),
    x_pdf_token: Optional[str] = Header(None),
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

    # Take the conversion from the free allowance, or from a paid credit, before
    # any work starts: two requests arriving together must not both spend the
    # last credit. If the conversion then fails, the credit goes back - nobody
    # pays for a document they did not get.
    reservation = None
    if billing.enabled():
        try:
            reservation = billing.reserve(billing.caller_ip(request), x_pdf_token)
        except billing.NeedsPayment:
            raise HTTPException(
                402,
                f"You have used today's free conversion. Another is free tomorrow, "
                f"or you can buy a pack of conversions that do not expire.",
            ) from None
        except Exception as exc:                               # noqa: BLE001
            # The meter is broken, not the converter. Letting the work through is
            # the right way to fail: the alternative is refusing a customer
            # because of a fault that is not theirs.
            log.warning("could not meter this conversion, allowing it: %s", exc)

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
        _return_credit(reservation)
        raise
    except Exception as exc:  # noqa: BLE001 - surface any failure to the UI
        shutil.rmtree(tmp_dir, ignore_errors=True)
        _return_credit(reservation)
        log.exception("Conversion failed for a %s upload", (os.path.splitext(filename)[1] or ".pdf").lower())
        raise HTTPException(500, f"Conversion failed: {exc}") from exc


if __name__ == "__main__":
    import uvicorn

    log.info("BTLTech PDF to Word converter listening on http://%s:%s", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT)