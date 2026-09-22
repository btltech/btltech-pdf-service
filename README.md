# BTL Tech — PDF Toolkit

A self-contained PDF service for [btltech.co.uk](https://btltech.co.uk), in three parts:

| Part | What it does | Where it runs | Speed |
|---|---|---|---|
| **PDF → Word** | Editable `.docx` with headings, tables, images and formatting preserved (V1 + V2) | Server | ~1 s per document |
| **Edit PDF** | Text, draw/sign, highlight, box, stamp an image; reorder or delete pages | **Entirely in your browser** | instant, no upload |
| **Page tools** | Merge, extract, delete, rotate, compress, number pages, watermark, protect, unlock | Server | 11–69 ms each |

**Stack:** Python · FastAPI · PyMuPDF · pdf2docx, plus pdf.js and pdf-lib for the browser editor.
No database, no external API keys, no third-party cloud services.

Server-side work happens in a temporary folder and the file is deleted the moment the download
finishes. The editor uploads nothing at all — the document never leaves the device.

---

## Quick start

```bash
cd pdf2word
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python app.py
```

Open **http://127.0.0.1:8000**.

## Pages

| URL | Page |
|---|---|
| `/` | Hub with a card for each part |
| `/convert` | PDF → Word converter |
| `/edit` | Browser-side PDF editor |
| `/tools` | The nine page tools |

## API

### Convert to Word

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/convert` | `multipart/form-data` with `file=<pdf>`; optional `?pages=1-5` |

```bash
curl -F "file=@samples/demo.pdf" "http://127.0.0.1:8000/api/convert?pages=1-2" -o demo.docx
```

### Page tools

All of these take `multipart/form-data` and return a PDF (or a ZIP), with the temp file cleaned up
after the download. `/api/tools/info` returns JSON instead.

| Endpoint | Fields | Returns |
|---|---|---|
| `/api/tools/info` | `file` | JSON: pages, size, whether it is encrypted |
| `/api/tools/merge` | `files` (two or more) | one merged PDF, in upload order |
| `/api/tools/split` | `file`, `pages`, `separate` | the chosen pages, or a ZIP of single pages |
| `/api/tools/delete-pages` | `file`, `pages` | PDF without those pages |
| `/api/tools/rotate` | `file`, `angle` (90/180/270/−90), `pages` | rotated PDF |
| `/api/tools/compress` | `file`, `level` (light/balanced/strong) | smaller PDF |
| `/api/tools/protect` | `file`, `password`, `owner_password`, `allow_printing`, `allow_copying` | AES-256 encrypted PDF |
| `/api/tools/unlock` | `file`, `password` | PDF with the password removed |
| `/api/tools/watermark` | `file`, `text`, `opacity`, `font_size`, `angle`, `colour` | watermarked PDF |
| `/api/tools/page-numbers` | `file`, `position`, `start`, `font_size`, `label_format` | numbered PDF |

`pages` accepts `all` (the default), a single page (`3`), a list (`2,4,6`) or a range (`1-5,8-12`).
Responses carry `X-Page-Count`, `X-Original-Size` and `X-New-Size` headers, which the UI shows as
feedback (for example `11.9 MB → 18.1 KB` after compressing).

```bash
curl -F "file=@samples/demo.pdf" -F "text=DRAFT" -F "opacity=0.2" \
     http://127.0.0.1:8000/api/tools/watermark -o watermarked.pdf
```

### Measured timings

Four-page document, the same machine that builds this project:

| Operation | Time |
|---|---|
| Open + read page count | 0.30 ms |
| Render a page preview at 150 dpi | 2.64 ms |
| Delete / reorder / rotate + save | 19.32 ms |
| Compress | 23.36 ms |
| Add a password (AES-256) | 11.18 ms |
| Merge four PDFs into 16 pages | 68.63 ms |
| **PDF → Word conversion** | **932.65 ms** |

Conversion is the only CPU-heavy path. Everything else is 14–3000× cheaper, so the page tools add
no meaningful load to the server.

---

## The browser editor (`/edit`)

Built on pdf.js (rendering) and pdf-lib (writing), both served from `static/vendor/` — no CDN, so it
works offline and nothing third-party executes on your domain.

**Tools:** Select · Text · Draw / sign · Highlight · Box · Stamp image · Erase, with colour, weight
and text-size controls, Undo and Clear marks.

**Pages:** a thumbnail panel with move earlier / move later / leave out, and a Reset order button.
Pages you leave out are simply not written to the output; the rest keep their order.

**How it stays correct on rotated pages:** marks are stored in PDF user space (origin bottom-left),
which is exactly the space pdf-lib draws in. pdf.js's viewport converts in both directions, so pages
carrying a `/Rotate` entry need no hand-written trigonometry.

**Deliberate limits**

- Text is written in Helvetica, and text you add does not reflow the existing page content. This is
  the honest ceiling of a browser editor: PDF is a page-description format, not an editable document
  format. For real content editing the workflow is *edit lightly → convert to Word*.
- The editor renders the first 40 pages of very long documents (keeps the tab responsive).
- An encrypted PDF must be unlocked first — use **Page tools → Remove password**.

## Testing

Two suites, both runnable at any time.

```bash
# 29 assertions covering every endpoint, in-process (no server needed)
.venv/bin/python scripts/test_tools.py

# a demo document with headings, a ruled table and an image
.venv/bin/python scripts/make_sample_pdf.py
```

`scripts/test_tools.py` exercises merge, split, delete, rotate, compress, protect, unlock, watermark,
page numbers, every validation path, all four pages, the stylesheet and the Word converter. It exits
non-zero on failure, so it drops straight into CI.

The editor was verified by driving real Chrome through the UI (load → annotate → erase → reorder →
save) and then inspecting the produced PDF with PyMuPDF: 21 browser assertions plus 8 PDF-level ones
confirmed the saved file has the right page count, real selectable text, and the drawn marks baked in
as visible content. The page-tools and converter UIs were browser-tested the same way, 15 assertions
covering merge, compress, rotate, protect and the automatic `.docx` download.

That editor check ships as [`scripts/browser_test.mjs`](scripts/browser_test.mjs) if you want to
rerun it after changing anything. It is a development tool: install `playwright-core` in a scratch
folder, not in this project, and point it at any four-page PDF.

```bash
mkdir -p /tmp/pdfcheck && cd /tmp/pdfcheck && npm install playwright-core
TEST_PDF=/tmp/pdfcheck/four.pdf OUT_PDF=/tmp/pdfcheck/edited.pdf \
  node /path/to/pdf2word/scripts/browser_test.mjs
```

## Running it in production

Behind Nginx on a small VPS. 1 vCPU / 1 GB RAM is comfortable for typical documents:

```bash
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000 --workers 2
```

`--workers` should follow your CPU cores, because conversion is CPU-bound and occupies a worker for
roughly a second. The page tools are so fast (tens of milliseconds) that they can share that pool; at
higher traffic, consider moving them into a second small service so a conversion queue never delays
a merge. The editor costs the server nothing — it is static files plus the user's own CPU.

Set `client_max_body_size 50m;` in Nginx to match `PDF2WORD_MAX_MB`.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `PDF2WORD_HOST` | `0.0.0.0` | Interface to bind |
| `PDF2WORD_PORT` | `8000` | Port to listen on |
| `PDF2WORD_MAX_MB` | `50` | Max upload size in MB |

## Project structure

```
pdf2word/
├── app.py                     # FastAPI app: pages + the Word converter
├── tools.py                   # The nine page tools (PyMuPDF)
├── config.py                  # Shared settings
├── static/
│   ├── app.css                # Shared styles
│   ├── index.html             # Hub
│   ├── convert.html           # PDF -> Word UI
│   ├── editor.html            # Browser editor
│   ├── tools.html             # Page tools UI
│   └── vendor/                # pdf.js 3.11.174 + pdf-lib 1.17.1 (self-hosted)
├── scripts/
│   ├── make_sample_pdf.py     # Demo document generator
│   └── test_tools.py          # The endpoint test suite
└── requirements.txt
```

The whole folder is portable — move it anywhere and rerun the Quick start. Nothing references the
project it was developed inside.

## Notes and limits

- **Digital PDFs only for conversion.** A scanned PDF is a picture of a page, so there is no text to
  extract. The converter detects this and says so rather than returning something useless.
- **Layout fidelity** from PDF → Word is good but not 1:1. Dense multi-column academic layouts,
  unusual fonts and very large tables are the usual trouble spots — test against your real documents.
- **One startup notice.** pdf2docx imports PyMuPDF's legacy `fitz` alias, so the first conversion logs
  a deprecation notice. PyMuPDF writes it straight to file descriptor 2, so no logging setting can
  hide it; it is informational and harmless.
- **Compression** re-encodes oversized images and cleans up the file. Text is never touched, so it
  stays selectable. It will not shrink a document that has no oversized images.
- **Third-party licences:** pdf.js (Apache-2.0) and pdf-lib (MIT) are bundled in `static/vendor/`;
  PyMuPDF (AGPL-3.0) and pdf2docx (MIT) are Python dependencies. Note that PyMuPDF's AGPL licence is
  worth reviewing before commercial distribution — a commercial licence is available from Artifex.

## Roadmap: V3 (scanned PDFs, OCR, hard layouts)

When scanned documents matter:

1. **Fastest path** — send the scan to a cloud OCR API (Azure Document Intelligence or Google
   Document AI), get structured text and layout back, then build the `.docx` with `python-docx`.
   Pay-per-page, no GPU, best accuracy on messy scans.
2. **Free path** — self-host Tesseract, with image pre-processing (deskew, denoise, binarise) to
   rebuild layout. Lower accuracy, more code.

Either way it becomes a `?mode=ocr` option on the existing converter, so today's code stays intact.