<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# BTL Tech — PDF Toolkit

A free, self-contained PDF service run by BTLTECH LTD, in three parts:

| Part | What it does | Where it runs | Speed |
|---|---|---|---|
| **PDF → Word** | Editable `.docx` with headings, tables, images and formatting preserved (V1 + V2) | Server | ~1 s per document |
| **Edit PDF** | Text, draw/sign, highlight, box, stamp an image; reorder or delete pages | **Entirely in your browser** | instant, no upload |
| **Page tools** | Merge, extract, delete, rotate, compress, number pages, watermark, protect, unlock | Server | 11–69 ms each |

**Stack:** Python · FastAPI · PyMuPDF · pdf2docx, plus pdf.js and pdf-lib for the browser editor.
No database, no external API keys, no third-party cloud services.

Server-side work happens in a temporary folder and the file is deleted the moment the download
finishes. The editor uploads nothing at all — the document never leaves the device.

**Licence:** free software under the GNU Affero General Public License v3.0 or later (`LICENSE`).
Because this is a network service, anyone using it must be able to get its source code; every page
links to `/source`, which serves the exact code running. See [Licence and source code](#licence-and-source-code).
This repository is a standalone project: it contains no code from, and does not link to, any other
BTLTECH LTD software.

---

## Quick start

```bash
cd btltech-pdf-service
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt        # production dependencies, pinned
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
| `/source` | Licence and source-code download (AGPL-3.0 section 13) |
| `/source.zip` | The source of the running version, as a ZIP |

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

**Security:** pdf.js 3.11.174 is affected by CVE-2024-4367 (script execution from a crafted font
in an opened PDF). The editor passes `isEvalSupported: false` to `getDocument`, which closes it, and
`scripts/test_release.py` fails if any `getDocument` call loses that setting. Keep the flag after
upgrading pdf.js too.

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

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
npm install                        # browser tests only: installs playwright-core, pinned
scripts/run_tests.sh --browser     # everything; omit --browser for the Python suites only
```

| Suite | Script | Assertions |
|---|---|---|
| Every endpoint, validation path, page and the converter (in-process) | `scripts/test_tools.py` | 29 |
| Browser editor in real Chrome: load, annotate, erase, undo, reorder, zoom, save | `scripts/browser_test.mjs` | 21 |
| The editor's saved PDF: pages, order, selectable text, marks baked in | `scripts/verify_editor_output.py` | 8 |
| Page tools and PDF → Word pages in real Chrome | `scripts/browser_tools_test.mjs` | 15 |
| Release: AGPL notices, source offer on every page, source ZIP contents, pdf.js setting, dependency split, separation from other software, conversion kept out of the server process | `scripts/test_release.py` | 21 |

The first four are the original 73 assertions. The editor-output and page-tools UI checks used to be
run by hand; they are now scripts. `run_tests.sh --browser` generates its own four-page fixture
(`scripts/make_test_pdf.py`), starts the app on port 8765, runs the browser suites and stops it.
It needs Google Chrome; set `CHROME_PATH` if Chrome is not in the default macOS location. Output
goes to `test-output/` (ignored by git).

`scripts/make_sample_pdf.py` writes a demo document with headings, a ruled table and an image to
`samples/`.

## Running it in production

Run it from a checkout plus a virtual environment, behind Nginx on a small VPS. **Do not publish a
Docker or other container image, or any bundle of installed packages:** the OpenCV wheel pdf2docx
depends on includes GPL-licensed codec libraries, and redistributing those binaries brings
obligations this project has not taken on (see `THIRD_PARTY_NOTICES.md`). One server process is
enough:

```bash
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
```

**Memory.** Each PDF → Word conversion runs in its own short-lived process
(`converter_worker.py`) that exits when it finishes. pdf2docx never hands its memory back, so run
inside the server it grew the process from about 80 MB to about 675 MB over the first twenty
conversions; as separate processes, the server stayed at 81–97 MB over forty conversions, peaking
at about 250 MB while one runs (measured 22 Sep 2026, four-page document, ~1 s each). A crash inside
the PDF engine ends only that conversion. At most `PDF2WORD_CONVERT_WORKERS` (default 2) convert at
once and the rest queue, so peak memory stays bounded; conversions still running after
`PDF2WORD_CONVERT_TIMEOUT_S` (default 300) seconds are stopped. The page tools take tens of
milliseconds and run in the server itself. The editor costs the server nothing — it is static files
plus the user's own CPU.

Set `client_max_body_size 50m;` in Nginx to match `PDF2WORD_MAX_MB`.

## Licence and source code

This service is licensed under the GNU AGPL v3.0 or later. What that means for whoever deploys it:

- **Every page must keep its "Source code" link.** AGPL-3.0 section 13 requires that users of a
  network service are offered its source. The footer of every page links to `/source`, and
  `scripts/test_release.py` fails if any page loses it.
- **`/source.zip` is built from the files the server is running**, so it always matches the deployed
  version. It leaves out `.venv`, `.git`, caches, `node_modules`, test output and any `.env` file.
- **Publish each deployed version.** Set `PDF_SOURCE_REPO_URL` to the public repository and
  `PDF_SOURCE_VERSION` to the deployed tag or commit; `/source` then shows both.
- **Keep secrets out of the tree.** Configuration comes from environment variables; never commit a
  `.env` file or credentials, because everything else in the directory is published.
- **Keep it separate.** Do not import code from other BTLTECH LTD software into this service, and do
  not copy this code into other products; either would bring that software under the AGPL.
- The BTL Tech name and logo are not licensed under the AGPL.

Third-party components and their licences are listed in `THIRD_PARTY_NOTICES.md`; licence texts
for the bundled browser libraries are in `LICENSES/`.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `PDF2WORD_HOST` | `0.0.0.0` | Interface to bind |
| `PDF2WORD_PORT` | `8000` | Port to listen on |
| `PDF2WORD_MAX_MB` | `50` | Max upload size in MB |
| `PDF2WORD_CONVERT_WORKERS` | `2` | PDF → Word conversions that run at once (each ~150–250 MB) |
| `PDF2WORD_CONVERT_TIMEOUT_S` | `300` | Stop a conversion that runs longer than this |
| `PDF_SOURCE_REPO_URL` | *(empty)* | Public repository URL shown on `/source` |
| `PDF_SOURCE_VERSION` | git commit, if available | Version shown on `/source` and in `X-Source-Version` |

## Project structure

```
btltech-pdf-service/
├── app.py                     # FastAPI app: pages + the Word converter
├── converter_worker.py        # One PDF -> Word conversion, run as a child process
├── tools.py                   # The page tools (PyMuPDF)
├── source_offer.py            # /source and /source.zip (AGPL-3.0 s.13)
├── config.py                  # Settings from environment variables
├── static/
│   ├── app.css                # Shared styles
│   ├── index.html             # Hub
│   ├── convert.html           # PDF -> Word UI
│   ├── editor.html            # Browser editor
│   ├── tools.html             # Page tools UI
│   └── vendor/                # pdf.js 3.11.174 + pdf-lib 1.17.1 (unmodified releases)
├── scripts/
│   ├── run_tests.sh           # Runs every suite
│   ├── test_tools.py          # Endpoint suite
│   ├── test_release.py        # Licence, source offer, security and separation checks
│   ├── browser_test.mjs       # Editor in Chrome
│   ├── verify_editor_output.py
│   ├── browser_tools_test.mjs # Page tools and converter in Chrome
│   ├── make_test_pdf.py       # Four-page test fixture
│   └── make_sample_pdf.py     # Demo document generator
├── LICENSE                    # GNU AGPL v3
├── LICENSES/                  # Apache-2.0 (pdf.js) and MIT (pdf-lib) texts
├── THIRD_PARTY_NOTICES.md
├── requirements.txt           # Production dependencies, pinned
├── requirements-dev.txt       # + test-only packages
└── package.json               # Browser-test tooling only (playwright-core)
```

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
  PyMuPDF (AGPL-3.0) and pdf2docx (MIT) are Python dependencies. This service is itself AGPL, which
  is what allows it to use PyMuPDF without a commercial licence. See `THIRD_PARTY_NOTICES.md`.

## Roadmap: V3 (scanned PDFs, OCR, hard layouts)

When scanned documents matter:

1. **Fastest path** — send the scan to a cloud OCR API (Azure Document Intelligence or Google
   Document AI), get structured text and layout back, then build the `.docx` with `python-docx`.
   Pay-per-page, no GPU, best accuracy on messy scans.
2. **Free path** — self-host Tesseract, with image pre-processing (deskew, denoise, binarise) to
   rebuild layout. Lower accuracy, more code.

Either way it becomes a `?mode=ocr` option on the existing converter, so today's code stays intact.