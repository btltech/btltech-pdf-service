<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
# BTLTech — PDF Toolkit

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
| `/edit` | Browser-side PDF editor: annotate, sign, organise pages |
| `/edit-text` | Edit the text already in a PDF, in the browser |
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

## Editing the text already in a PDF (`/edit-text`)

Click a line, change the words, save. It runs entirely in the browser on PDFium
compiled to WebAssembly: the document is read from a file input and never sent
anywhere, which is also asserted by the browser suite watching the network.

The engine came from a long feasibility study and is frozen: **FROZEN9** is the
reference the deployed code is measured against, after a justification fix
superseded the original FROZEN8 freeze (both are described below). What ships here
is that frozen engine with its file access changed and nothing else;
`static/edittext/PORTING.md` lists every difference, and
`scripts/regression_edittext.mjs` proves the point by reproducing all 134 saved
outputs from the frozen reference.

### What it does

Replaces the text of a line, keeping the font, size, colour, alignment and any
underline or strike-through. When the new wording does not fit it works down a
ladder, and says which rung it used:

| Rung | What happens |
|---|---|
| FIT | It fits; replaced in place |
| SHIFT_LINE | The rest of the line moves along to make room |
| SHRINK | Set very slightly narrower (never below 92%) |
| WRAP | Wrapped onto another line |
| free space | Moved to empty space on the page |
| refused | None of those is safe, so nothing is saved and the reason is shown |

### What it refuses, and why that matters

It refuses rather than guessing. Scanned pages (with or without an invisible OCR
layer); Chinese, Japanese, Korean, Arabic and Hebrew; lines spaced out inside a
single text object; justified lines; text inside a nested graphic; any edit whose
result would print over existing text or artwork, run off the page, or come out as
missing glyphs. Every file that does pass is checked for structural soundness with
pdf-lib - a different library from the one that wrote it - before the customer can
download it, and a file that fails is discarded rather than offered.

**It does not reflow paragraphs.** Editing a line does not re-break the paragraph
around it. That is a V2 question and deliberately out of scope here.

### The frozen reference

The seven corpora and the 133 recorded hashes live outside this repository, in a
snapshot at `~/btltech-pdf-editor-reference-frozen9` (override with `EDITTEXT_REFERENCE`), with the previous FROZEN8 snapshot kept beside it.
They are third-party PDFs downloaded for testing: fine to keep privately, not ours
to publish under the AGPL. Without that snapshot the regression suite reports that
it was skipped rather than passing on nothing.

    python3 ~/btltech-pdf-editor-reference-frozen9/verify_frozen.py   # the snapshot is intact
    node scripts/regression_edittext.mjs                      # the shipped code matches it

### The justified detector, and why the reference moved to FROZEN9

The first fixture caught the detector being wrong in both directions: a plain
left-aligned line refused as justified, and a real justified paragraph missed. It
was measuring word gaps by walking the page's text index, which on a multi-column
page walks from one column into another, and it was judging on the gap ratio alone,
which barely moves on a justified line whose words nearly fill it.

Characters are now chosen by position rather than by text index, and the primary
test is the shape of the block - every line but the last reaching the right margin
exactly - with the gap ratio kept for lines that have no block. The last line of a
justified paragraph stays editable, because editing it cannot break the alignment.

Across the seven corpora that lifted 12 wrong refusals and added 1 correct one, and
the independent PyMuPDF verifier reports 0 problem outputs. `FROZEN9` records the
result; `FROZEN8` is kept unchanged beside it as the before picture.

## Testing

```bash
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
npm install                        # browser tests only: installs playwright-core, pinned
scripts/run_tests.sh --browser     # everything; omit --browser for the Python suites only
```

| Suite | Script | Assertions |
|---|---|---|
| Every endpoint, validation path, page and the converter (in-process) | `scripts/test_tools.py` | 35 |
| Browser editor in real Chrome: load, annotate, erase, undo, reorder, zoom, save | `scripts/browser_test.mjs` | 21 |
| The editor's saved PDF: pages, order, selectable text, marks baked in | `scripts/verify_editor_output.py` | 8 |
| Page tools and PDF → Word pages in real Chrome | `scripts/browser_tools_test.mjs` | 15 |
| Edit existing text in real Chrome: open, select, preview, refusals, save, and that nothing is uploaded | `scripts/browser_edittext_test.mjs` | 26 |
| That editor's saved PDF, read back with PyMuPDF | `scripts/verify_edittext_output.py` | 8 |
| The shipped edit-text engine against the frozen FROZEN9 reference | `scripts/regression_edittext.mjs` | 134 outputs |
| Release: AGPL notices, source offer on every page, source ZIP contents, pdf.js setting, dependency split, separation from other software, conversion kept out of the server process | `scripts/test_release.py` | 21 |

The first four are the original 73 assertions. The editor-output and page-tools UI checks used to be
run by hand; they are now scripts. `run_tests.sh --browser` generates its own four-page fixture
(`scripts/make_test_pdf.py`), starts the app on port 8765, runs the browser suites and stops it.
It needs Google Chrome; set `CHROME_PATH` if Chrome is not in the default macOS location. Output
goes to `test-output/` (ignored by git).

`scripts/make_sample_pdf.py` writes a demo document with headings, a ruled table and an image to
`samples/`.

## Deploying

`DEPLOYING.md` covers Railway: the settings to set, what it should cost, the
checklist to clear before the service is public, and why building an image there is
running the software rather than distributing it.

Static assets are gzipped (the PDFium build is 4.4 MB and compresses to 2.0 MB, so a
first visit to the text editor transfers about 2.4 MB rather than 5.3 MB). Downloads
and API responses are left alone: .docx and PDF files are already compressed, and
gzipping them would cost CPU to save nothing.

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
- The BTLTech name and logo are not licensed under the AGPL.

Third-party components and their licences are listed in `THIRD_PARTY_NOTICES.md`; licence texts
for the bundled browser libraries are in `LICENSES/`.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `PDF2WORD_HOST` | `0.0.0.0` | Interface to bind |
| `PDF2WORD_PORT` | `8000` | Port to listen on |
| `PDF2WORD_MAX_MB` | `50` | Max upload size in MB |
| `PDF2WORD_CONVERT_WORKERS` | `2` | PDF → Word conversions that run at once (each ~150–250 MB) |
| `PDF_SUPPORT_URL` | *(unset)* | Optional "support this tool" link in the footer. Unset in production, and how this service is funded has not been decided. If it is ever used it stays a plain link with nothing gated behind it: a payment provider's script would contradict what these pages promise about files staying in the browser |
| `PDF_SUPPORT_LABEL` | `Support this tool` | The wording of that link |
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
│   ├── edittext.html          # Edit existing text UI
│   ├── tools.html             # Page tools UI
│   ├── edittext/              # The frozen V1 text-editing engine
│   │   ├── engine.mjs         #   FROZEN9, file access aside (see PORTING.md)
│   │   ├── workflow.mjs       #   every gate, shared by the browser and the tests
│   │   ├── integrity.mjs      #   the download gate
│   │   ├── subset.mjs         #   HarfBuzz font subsetting
│   │   ├── assets.mjs         #   the only place it touches files
│   │   ├── fontset.mjs        #   which fonts to fetch before an edit
│   │   └── ui.mjs             #   the screen, and nothing else
│   ├── fonts/                 # OFL substitute fonts (subset at edit time)
│   └── vendor/                # pdf.js, pdf-lib, PDFium WASM, HarfBuzz WASM (unmodified)
├── scripts/
│   ├── run_tests.sh           # Runs every suite
│   ├── test_tools.py          # Endpoint suite
│   ├── test_release.py        # Licence, source offer, security and separation checks
│   ├── browser_test.mjs       # Editor in Chrome
│   ├── verify_editor_output.py
│   ├── browser_tools_test.mjs # Page tools and converter in Chrome
│   ├── browser_edittext_test.mjs   # Edit existing text in Chrome
│   ├── verify_edittext_output.py
│   ├── regression_edittext.mjs     # Shipped engine vs the frozen reference
│   ├── make_test_pdf.py       # Four-page test fixture
│   ├── make_edittext_pdf.py   # Text-editing fixture (underline, justified, CJK, a scan)
│   └── make_sample_pdf.py     # Demo document generator
├── LICENSE                    # GNU AGPL v3
├── LICENSES/                  # Apache-2.0, MIT, BSD-3-Clause and SIL OFL texts
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