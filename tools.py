"""Server-side PDF page tools (Tier 2 of the toolkit).

Merge, split, delete, rotate, compress, protect, unlock, watermark and number
pages. This is pure PyMuPDF work - no layout analysis and no re-rendering of
content - so each operation completes in milliseconds even on large files.

Every endpoint is a *sync* function on purpose: FastAPI runs those in its
worker threadpool, which keeps the event loop free while PyMuPDF works.

All results are returned as downloads; temp files are removed the moment the
response has been sent.
"""

import contextlib
import logging
import os
import re
import shutil
import tempfile
import zipfile
from typing import Iterator, List, Optional

try:
    import pymupdf as fitz
except ImportError:  # pragma: no cover - legacy PyMuPDF
    import fitz

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from config import MAX_UPLOAD_MB

log = logging.getLogger("pdf2word.tools")

router = APIRouter(prefix="/api/tools", tags=["page tools"])

PDF_MEDIA_TYPE = "application/pdf"
ZIP_MEDIA_TYPE = "application/zip"


# ------------------------------------------------------------------ helpers ---


def _pdf_bytes(upload: UploadFile) -> bytes:
    """Validate one uploaded PDF and return its bytes."""
    name = upload.filename or "upload.pdf"
    if not name.lower().endswith(".pdf"):
        raise HTTPException(400, f"'{name}' is not a PDF - only .pdf files are accepted")
    data = upload.file.read()
    if not data:
        raise HTTPException(400, f"'{name}' is empty")
    if len(data) > MAX_UPLOAD_MB * 1024 * 1024:
        raise HTTPException(413, f"'{name}' is larger than the {MAX_UPLOAD_MB} MB limit")
    if not data.startswith(b"%PDF"):
        raise HTTPException(400, f"'{name}' does not look like a valid PDF")
    return data


def _open(data: bytes, password: Optional[str] = None) -> "fitz.Document":
    """Open a PDF from bytes, authenticating if it is encrypted."""
    try:
        doc = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:
        raise HTTPException(400, f"Could not read this PDF: {exc}") from exc

    if doc.is_encrypted:
        if not password:
            doc.close()
            raise HTTPException(400, "This PDF is password-protected - supply its password")
        if not doc.authenticate(password):
            doc.close()
            raise HTTPException(400, "Incorrect password for this PDF")
    return doc


def _page_indices(spec: Optional[str], page_count: int) -> List[int]:
    """Parse 'all', '3' or '1,4-6' into sorted, validated 0-based page indices."""
    if not spec or not spec.strip() or spec.strip().lower() in ("all", "*"):
        return list(range(page_count))

    picked: List[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        span = re.fullmatch(r"(\d+)\s*-\s*(\d+)", part)
        if span:
            first, last = int(span.group(1)), int(span.group(2))
            picked.extend(range(min(first, last), max(first, last) + 1))
        elif part.isdigit():
            picked.append(int(part))
        else:
            raise HTTPException(400, f"Could not understand the page selection '{part}'")

    if not picked:
        raise HTTPException(400, "No pages were selected")
    for number in picked:
        if number < 1 or number > page_count:
            raise HTTPException(
                400, f"Page {number} is out of range - this PDF has {page_count} page(s)"
            )
    return sorted({number - 1 for number in picked})


class _Workspace:
    """Temporary working directory that always cleans up after itself."""

    def __init__(self) -> None:
        self.path = tempfile.mkdtemp(prefix="pdftools_")

    def file(self, name: str) -> str:
        return os.path.join(self.path, name)

    def save(self, doc: "fitz.Document", name: str, **kwargs) -> str:
        """Save a document into the workspace and close it."""
        out = self.file(name)
        try:
            doc.save(out, **kwargs)
        finally:
            doc.close()
        return out

    def response(
        self,
        path: str,
        download_name: str,
        media_type: str = PDF_MEDIA_TYPE,
        headers: Optional[dict] = None,
    ) -> FileResponse:
        return FileResponse(
            path=path,
            media_type=media_type,
            filename=download_name,
            headers=headers or {},
            background=BackgroundTask(shutil.rmtree, self.path, ignore_errors=True),
        )

    def fail(self) -> None:
        shutil.rmtree(self.path, ignore_errors=True)


@contextlib.contextmanager
def _workspace(label: str) -> Iterator[_Workspace]:
    """Provide a workspace, cleaning up on any failure."""
    workspace = _Workspace()
    try:
        yield workspace
    except HTTPException:
        workspace.fail()
        raise
    except Exception as exc:  # noqa: BLE001 - report the true cause to the caller
        workspace.fail()
        log.exception("%s failed", label)
        raise HTTPException(500, f"{label} failed: {exc}") from exc


def _close_quietly(doc: "fitz.Document") -> None:
    """Close a document, tolerating an already-closed one."""
    with contextlib.suppress(Exception):
        doc.close()


# ------------------------------------------------------------------- routes ---


@router.post("/info")
def info(file: UploadFile = File(...)) -> dict:
    """Report basic facts about a PDF so the UI can display them."""
    data = _pdf_bytes(file)
    doc = _open(data)
    try:
        return {
            "filename": file.filename,
            "pages": doc.page_count,
            "size_bytes": len(data),
            "encrypted": bool(doc.is_encrypted),
            "needs_password": bool(doc.needs_pass),
            "title": (doc.metadata or {}).get("title") or "",
        }
    finally:
        doc.close()


@router.post("/merge")
def merge(files: List[UploadFile] = File(...)):
    """Join several PDFs into one, in the order they were uploaded."""
    if len(files) < 2:
        raise HTTPException(400, "Select at least two PDFs to merge")

    with _workspace("Merge") as workspace:
        merged = fitz.open()
        total = 0
        try:
            for upload in files:
                doc = _open(_pdf_bytes(upload))
                merged.insert_pdf(doc)
                total += doc.page_count
                doc.close()
            out = workspace.save(merged, "merged.pdf", garbage=4, deflate=True)
        finally:
            _close_quietly(merged)
        return workspace.response(out, "merged.pdf", headers={"X-Page-Count": str(total)})


@router.post("/split")
def split(
    file: UploadFile = File(...),
    pages: str = Form("all"),
    separate: bool = Form(False),
):
    """Extract selected pages - as one PDF, or as a ZIP of single-page PDFs."""
    with _workspace("Split") as workspace:
        doc = _open(_pdf_bytes(file))
        try:
            wanted = _page_indices(pages, doc.page_count)

            if not separate:
                extract = fitz.open()
                try:
                    for index in wanted:
                        extract.insert_pdf(doc, from_page=index, to_page=index)
                    out = workspace.save(extract, "extracted.pdf", garbage=4, deflate=True)
                finally:
                    _close_quietly(extract)
                return workspace.response(out, "extracted.pdf")

            entries: List[str] = []
            for index in wanted:
                single = fitz.open()
                try:
                    single.insert_pdf(doc, from_page=index, to_page=index)
                    entries.append(
                        workspace.save(
                            single, f"page-{index + 1}.pdf", garbage=4, deflate=True
                        )
                    )
                finally:
                    _close_quietly(single)
        finally:
            doc.close()

        archive = workspace.file("pages.zip")
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for path in entries:
                bundle.write(path, os.path.basename(path))
        return workspace.response(archive, "pages.zip", media_type=ZIP_MEDIA_TYPE)


@router.post("/delete-pages")
def delete_pages(file: UploadFile = File(...), pages: str = Form(...)):
    """Remove the selected pages, keeping the remaining pages in order."""
    with _workspace("Delete pages") as workspace:
        doc = _open(_pdf_bytes(file))
        try:
            doomed = set(_page_indices(pages, doc.page_count))
            if len(doomed) >= doc.page_count:
                raise HTTPException(400, "Cannot delete every page - keep at least one")

            keep = fitz.open()
            try:
                for index in range(doc.page_count):
                    if index not in doomed:
                        keep.insert_pdf(doc, from_page=index, to_page=index)
                out = workspace.save(keep, "pages-deleted.pdf", garbage=4, deflate=True)
            finally:
                _close_quietly(keep)
        finally:
            doc.close()
        return workspace.response(out, "pages-deleted.pdf")


@router.post("/rotate")
def rotate(file: UploadFile = File(...), angle: int = Form(90), pages: str = Form("all")):
    """Rotate the selected pages by 90, 180 or 270 degrees (negative = anticlockwise)."""
    if angle % 90 != 0 or angle == 0:
        raise HTTPException(400, "Angle must be 90, 180 or 270")

    with _workspace("Rotate") as workspace:
        doc = _open(_pdf_bytes(file))
        try:
            for index in _page_indices(pages, doc.page_count):
                page = doc[index]
                page.set_rotation((page.rotation + angle) % 360)
            out = workspace.save(doc, "rotated.pdf", garbage=4, deflate=True)
            return workspace.response(out, "rotated.pdf")
        finally:
            _close_quietly(doc)


# ------------------------------------------------------------------ more tools ---

# dpi targets used by the compressor, per strength level
_COMPRESS_LEVELS = {"light": 220, "balanced": 150, "strong": 96}

# watermark colours
_WATERMARK_COLOURS = {
    "grey": (0.45, 0.45, 0.45),
    "black": (0.0, 0.0, 0.0),
    "red": (0.75, 0.10, 0.10),
    "blue": (0.10, 0.30, 0.75),
}


@router.post("/compress")
def compress(file: UploadFile = File(...), level: str = Form("balanced")):
    """Shrink a PDF by re-encoding oversized images and cleaning up the file."""
    dpi = _COMPRESS_LEVELS.get(level)
    if dpi is None:
        raise HTTPException(
            400, f"Unknown compression level '{level}' - use light, balanced or strong"
        )

    with _workspace("Compress") as workspace:
        data = _pdf_bytes(file)
        doc = _open(data)
        try:
            with contextlib.suppress(Exception):
                # PyMuPDF >= 1.24: downsamples images that exceed the dpi target.
                # Older builds fall through to the structural cleanup below.
                doc.rewrite_images(dpi_threshold=dpi + 40, dpi_target=dpi, quality=75)
            out = workspace.save(
                doc,
                "compressed.pdf",
                garbage=4,
                deflate=True,
                deflate_images=True,
                deflate_fonts=True,
                clean=True,
            )
        finally:
            _close_quietly(doc)

        return workspace.response(
            out,
            "compressed.pdf",
            headers={
                "X-Original-Size": str(len(data)),
                "X-New-Size": str(os.path.getsize(out)),
            },
        )


@router.post("/protect")
def protect(
    file: UploadFile = File(...),
    password: str = Form(...),
    owner_password: str = Form(""),
    allow_printing: bool = Form(True),
    allow_copying: bool = Form(False),
):
    """Encrypt a PDF with AES-256 and set its permissions."""
    if len(password) < 4:
        raise HTTPException(400, "Choose a password of at least 4 characters")

    with _workspace("Protect") as workspace:
        doc = _open(_pdf_bytes(file))
        try:
            permissions = fitz.PDF_PERM_ACCESSIBILITY
            if allow_printing:
                permissions |= fitz.PDF_PERM_PRINT
            if allow_copying:
                permissions |= fitz.PDF_PERM_COPY

            out = workspace.save(
                doc,
                "protected.pdf",
                encryption=fitz.PDF_ENCRYPT_AES_256,
                user_pw=password,
                owner_pw=owner_password or password,
                permissions=permissions,
            )
        finally:
            _close_quietly(doc)
        return workspace.response(out, "protected.pdf")


@router.post("/unlock")
def unlock(file: UploadFile = File(...), password: str = Form(...)):
    """Remove password protection, given the current password."""
    with _workspace("Unlock") as workspace:
        doc = _open(_pdf_bytes(file), password=password)
        try:
            # nb: PyMuPDF reports is_encrypted=False once a document has been
            # authenticated, so needs_pass is the reliable test for "protected".
            if not doc.needs_pass:
                raise HTTPException(400, "This PDF is not password-protected - nothing to unlock")
            out = workspace.save(
                doc,
                "unlocked.pdf",
                encryption=fitz.PDF_ENCRYPT_NONE,
                garbage=4,
                deflate=True,
            )
        finally:
            _close_quietly(doc)
        return workspace.response(out, "unlocked.pdf")


@router.post("/watermark")
def watermark(
    file: UploadFile = File(...),
    text: str = Form(...),
    opacity: float = Form(0.15),
    font_size: int = Form(48),
    angle: int = Form(45),
    colour: str = Form("grey"),
):
    """Stamp faint diagonal text across every page."""
    if not text.strip():
        raise HTTPException(400, "Enter the watermark text")
    if not 0.02 <= opacity <= 1.0:
        raise HTTPException(400, "Opacity must be between 0.02 and 1")
    if not 6 <= font_size <= 200:
        raise HTTPException(400, "Font size must be between 6 and 200")
    if not -180 <= angle <= 180:
        raise HTTPException(400, "Angle must be between -180 and 180 degrees")

    rgb = _WATERMARK_COLOURS.get(colour, _WATERMARK_COLOURS["grey"])
    lines = [line for line in text.splitlines() if line.strip()] or [text]

    with _workspace("Watermark") as workspace:
        doc = _open(_pdf_bytes(file))
        try:
            font = fitz.Font("helv")
            for page in doc:
                area = page.rect
                size = font_size
                # Shrink the text until its longest line fits across the page.
                for _ in range(8):
                    widest = max(font.text_length(line, fontsize=size) for line in lines)
                    if widest <= area.width * 0.92 or size <= 6:
                        break
                    size = max(6, int(size * 0.8))

                # TextWriter plus a morph matrix gives true arbitrary-angle
                # rotation. insert_textbox cannot: it only accepts 90-degree steps.
                writer = fitz.TextWriter(area)
                line_height = size * 1.25
                top = (area.height - line_height * len(lines)) / 2 + size
                for index, line in enumerate(lines):
                    width = font.text_length(line, fontsize=size)
                    writer.append(
                        fitz.Point((area.width - width) / 2, top + index * line_height),
                        line,
                        font=font,
                        fontsize=size,
                    )
                pivot = fitz.Point(area.width / 2, area.height / 2)
                writer.write_text(
                    page,
                    color=rgb,
                    opacity=opacity,
                    morph=(pivot, fitz.Matrix(angle)),
                )
            out = workspace.save(doc, "watermarked.pdf", garbage=4, deflate=True)
        finally:
            _close_quietly(doc)
        return workspace.response(out, "watermarked.pdf")


@router.post("/page-numbers")
def page_numbers(
    file: UploadFile = File(...),
    position: str = Form("bottom-centre"),
    start: int = Form(1),
    font_size: int = Form(10),
    label_format: str = Form("{n} of {total}"),
):
    """Stamp page numbers onto every page."""
    parts = position.rsplit("-", 1)
    if (
        len(parts) != 2
        or parts[0] not in ("top", "bottom")
        or parts[1] not in ("left", "centre", "right")
    ):
        raise HTTPException(400, "Position must be like bottom-centre or top-right")
    vertical, horizontal = parts
    if not 6 <= font_size <= 48:
        raise HTTPException(400, "Font size must be between 6 and 48")
    if "{n}" not in label_format:
        raise HTTPException(400, "The format must contain {n}, e.g. 'Page {n} of {total}'")

    with _workspace("Page numbers") as workspace:
        doc = _open(_pdf_bytes(file))
        try:
            total = doc.page_count
            margin = 36.0
            for index, page in enumerate(doc):
                label = label_format.replace("{n}", str(start + index)).replace(
                    "{total}", str(total)
                )
                width = fitz.get_text_length(label, fontname="helv", fontsize=font_size)
                area = page.rect
                if horizontal == "left":
                    x = margin
                elif horizontal == "right":
                    x = area.width - width - margin
                else:
                    x = (area.width - width) / 2
                y = margin + font_size if vertical == "top" else area.height - margin
                page.insert_text(
                    fitz.Point(x, y),
                    label,
                    fontname="helv",
                    fontsize=font_size,
                    color=(0.25, 0.25, 0.25),
                )
            out = workspace.save(doc, "numbered.pdf", garbage=4, deflate=True)
        finally:
            _close_quietly(doc)
        return workspace.response(out, "numbered.pdf")