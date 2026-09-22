# Third-party notices

This service is licensed under the GNU Affero General Public License v3.0 or
later (see `LICENSE`). It is built on the components below. Licences were
checked on 22 September 2026 against the pinned versions in
`requirements.txt`, and on 23 September 2026 for the text-editing components.

## Shipped in this repository and served to browsers

These files are unmodified copies of the official releases (SHA-256 checked
against the published npm packages on 22 Sep 2026).

| File | Component | Licence | Notice |
|---|---|---|---|
| `static/vendor/pdf.min.js`, `static/vendor/pdf.worker.min.js` | pdf.js 3.11.174 (`pdfjs-dist`), Copyright 2023 Mozilla Foundation | Apache-2.0 | `LICENSES/Apache-2.0.txt`; source: https://github.com/mozilla/pdf.js/tree/v3.11.174 |
| `static/vendor/pdf-lib.min.js` | pdf-lib 1.17.1, Copyright (c) 2019 Andrew Dillon | MIT | `LICENSES/pdf-lib-MIT.txt`; source: https://github.com/Hopding/pdf-lib/tree/v1.17.1 |
| (bundled inside pdf-lib) | @pdf-lib/standard-fonts 1.0.0, @pdf-lib/upng 1.0.1 | MIT | as above |
| (bundled inside pdf-lib) | pako 1.0.x | MIT AND Zlib | https://github.com/nodeca/pako |
| (bundled inside pdf-lib) | tslib helpers, Copyright (c) Microsoft Corporation | Apache-2.0 (per the header in the bundle) | `LICENSES/Apache-2.0.txt` |
| `static/vendor/pdfium/pdfium.mjs`, `static/vendor/pdfium/pdfium.wasm` | @embedpdf/pdfium 2.15.1 (a WebAssembly build of PDFium) | MIT for the wrapper, BSD-3-Clause for PDFium itself | `LICENSES/embedpdf-pdfium-MIT.txt`, `LICENSES/pdfium-BSD-3-Clause.txt`; sources: https://github.com/embedpdf/embed-pdf-viewer and https://pdfium.googlesource.com/pdfium/ |
| `static/vendor/harfbuzz/harfbuzz-subset.wasm` | harfbuzzjs 1.6.2 (a WebAssembly build of HarfBuzz) | MIT | `LICENSES/harfbuzzjs-MIT.txt`; sources: https://github.com/harfbuzz/harfbuzzjs and https://github.com/harfbuzz/harfbuzz |
| `static/vendor/pdf-lib.cjs` | pdf-lib 1.17.1 (the CommonJS build, used by the edit-text integrity check) | MIT | `LICENSES/pdf-lib-MIT.txt` |

### Fonts served to browsers

`static/fonts/` holds the substitute fonts the text editor embeds when a
document's own font has no glyph for a character the customer typed. Only the
characters used are embedded, as a subset. All are free to embed and
redistribute; each font's own licence file sits beside it in that directory.

| Fonts | Copyright | Licence |
|---|---|---|
| Liberation Sans, Serif and Mono 2.1.5 | Copyright (c) 2012 Red Hat, Inc. | SIL OFL 1.1 (`static/fonts/liberation-LICENSE.txt`) |
| Carlito | Copyright (c) 2010-2013 Lukasz Dziedzic | SIL OFL 1.1 (`static/fonts/carlito-OFL.txt`) |
| Caladea | Copyright (c) 2012 Carolina Giovagnoli and Andres Torresi | SIL OFL 1.1 (`static/fonts/caladea-OFL.txt`) |
| Gelasio | Copyright (c) Eben Sorkin | SIL OFL 1.1 (`static/fonts/gelasio-OFL.txt`) |
| Source Sans 3 | Copyright 2010-2023 Adobe Systems Incorporated | SIL OFL 1.1 (`static/fonts/sourcesans3-OFL.txt`) |
| Inter | Copyright (c) 2016-2023 The Inter Project Authors | SIL OFL 1.1 (`static/fonts/inter-OFL.txt`) |
| DejaVu Sans 2.37 | Bitstream Vera Fonts Copyright (c) 2003 Bitstream, Inc.; DejaVu changes public domain | Bitstream Vera licence (`static/fonts/dejavu-LICENSE.txt`) |

The full text of SIL OFL 1.1 is also at `LICENSES/SIL-OFL-1.1.txt`. None of
these fonts is modified; subsetting happens in the browser at the moment of an
edit and produces a derived font inside the customer's own document, which the
OFL permits (the reserved font names are not used for the subsets).

## Installed from PyPI at deploy time (not included in this repository)

Production (`requirements.txt`):

| Package | Version | Licence |
|---|---|---|
| PyMuPDF (`pymupdf`) | 1.28.2 | AGPL-3.0 (or Artifex commercial licence) |
| pdf2docx | 0.5.13 | MIT |
| python-docx | 1.2.0 | MIT |
| lxml | 6.1.3 | BSD-3-Clause |
| fonttools | 4.65.0 | MIT |
| numpy | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| opencv-python-headless | 5.0.0.93 | Apache-2.0; the binary wheel bundles third-party libraries, see below |
| fire | 0.7.1 | Apache-2.0 |
| termcolor | 3.3.0 | MIT |
| fastapi | 0.141.1 | MIT |
| starlette | 1.6.0 | BSD-3-Clause |
| pydantic / pydantic_core | 2.13.5 / 2.46.5 | MIT |
| annotated-doc, annotated-types, typing-inspection | 0.0.5, 0.8.0, 0.4.4 | MIT |
| typing_extensions | 4.16.0 | PSF-2.0 |
| anyio | 4.15.1 | MIT |
| idna | 3.20 | BSD-3-Clause |
| python-multipart | 0.0.32 | Apache-2.0 |
| uvicorn | 0.53.0 | BSD-3-Clause |
| click | 8.5.0 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| httptools | 0.8.0 | MIT |
| uvloop | 0.22.1 | MIT OR Apache-2.0 |
| watchfiles | 1.3.0 | MIT |
| websockets | 17.1 | BSD-3-Clause |
| python-dotenv | 1.2.3 | BSD-3-Clause |
| PyYAML | 6.0.3 | MIT |

Test only (`requirements-dev.txt`, never installed on the server): httpx 0.28.1
(BSD-3-Clause), httpcore 1.0.9 (BSD-3-Clause), certifi 2026.7.22 (MPL-2.0).
Browser tests use playwright-core (Apache-2.0) from `package.json`.

### opencv-python-headless and bundled codec libraries

The opencv-python-headless binary wheel ships its own copies of FFmpeg and
codec libraries. The macOS arm64 wheel of 5.0.0.93 includes libx264, libx265,
libpostproc, librubberband and libvidstab, which are GPL-licensed, alongside
LGPL FFmpeg libraries. pdf2docx uses OpenCV only for image contour detection;
no video code is used.

This project does not redistribute those binaries: it contains no wheels, no
virtual environment and no container image, and the service runs them only on
its own server. Anyone who installs from `requirements.txt` obtains the wheel
directly from PyPI under the licences it carries. **If this service is ever
distributed as a container image or other binary bundle, the GPL/LGPL terms of
those libraries must be reviewed first.**

## Not part of this service

This repository contains no code from, and does not link to, any other BTLTECH
LTD software. The BTL Tech name and logo are not licensed under the AGPL.
