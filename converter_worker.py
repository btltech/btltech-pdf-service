# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""PDF -> Word conversion, run as a short-lived child process.

pdf2docx and PyMuPDF keep caches that are never handed back to the operating
system. Converted in the web server's own threads, each conversion left about
24 MB behind until the server settled near 675 MB. Here every conversion is a
separate process that exits when it is done, so its memory is returned and the
server stays near its idle size. A crash inside the PDF engine now ends only
that one conversion, not the web server.

The web server runs it as:

    python converter_worker.py INPUT.pdf OUTPUT.docx [START END]

START is the 0-based first page and END the exclusive last page, as pdf2docx
expects; omit both for the whole document. Exit status 0 means OUTPUT.docx was
written. On failure the last line of stderr is the message shown to the user.
"""

import logging
import sys


def convert(in_path, out_path, start=None, end=None):
    from pdf2docx import Converter

    cv = Converter(in_path)
    try:
        kwargs = {} if start is None else {"start": start, "end": end}
        cv.convert(out_path, **kwargs)
    finally:
        cv.close()


def main(argv):
    if len(argv) not in (3, 5):
        print("usage: converter_worker.py INPUT.pdf OUTPUT.docx [START END]", file=sys.stderr)
        return 2
    start = end = None
    if len(argv) == 5:
        start, end = int(argv[3]), int(argv[4])
    # pdf2docx logs a progress line per page at INFO; keep stderr for errors.
    logging.basicConfig(level=logging.WARNING)
    try:
        convert(argv[1], argv[2], start, end)
    except Exception as exc:  # noqa: BLE001 - report the cause to the web server
        print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
