# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""The source-code offer required by AGPL-3.0 section 13.

Anyone using this service over the network can download the Corresponding
Source of the exact version they are using:

    GET /source       a page explaining the licence, with the download link
    GET /source.zip   the source, zipped from the files this process runs

The ZIP is built from the running directory rather than from a repository
checkout, so it cannot drift from what is deployed. Environments, caches,
test output and any .env file are left out; nothing else is.
"""

import io
import os
import subprocess
import zipfile
from functools import lru_cache
from html import escape
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import HTMLResponse, Response

from config import SOURCE_REPO_URL, SOURCE_VERSION

BASE_DIR = Path(__file__).resolve().parent

# Directories and files that are not source: virtual environments, VCS data,
# caches, generated samples and test output. Mirrors .gitignore.
EXCLUDED_DIRS = {
    ".venv", "venv", ".git", "__pycache__", "node_modules", "samples",
    "tmp", "test-output", ".idea", ".vscode", ".pytest_cache",
}
EXCLUDED_SUFFIXES = (".pyc", ".pyo")
EXCLUDED_NAMES = {".DS_Store"}

router = APIRouter(tags=["source"])


def _excluded_file(name: str) -> bool:
    # .env files hold deployment secrets, never source.
    return (
        name in EXCLUDED_NAMES
        or name.endswith(EXCLUDED_SUFFIXES)
        or name == ".env"
        or name.startswith(".env.")
    )


def source_files() -> list:
    """Every file shipped in the source ZIP, as paths relative to BASE_DIR."""
    found = []
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = sorted(d for d in dirs if d not in EXCLUDED_DIRS)
        for name in sorted(files):
            if not _excluded_file(name):
                found.append(os.path.relpath(os.path.join(root, name), BASE_DIR))
    return found


@lru_cache(maxsize=1)
def version() -> str:
    """The revision being served: PDF_SOURCE_VERSION, else the git commit."""
    if SOURCE_VERSION:
        return SOURCE_VERSION
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], cwd=BASE_DIR,
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=no"], cwd=BASE_DIR,
            capture_output=True, text=True, timeout=5, check=True,
        ).stdout.strip()
        return commit + ("+local-changes" if dirty else "")
    except Exception:  # noqa: BLE001 - no git on the server is normal
        return "unversioned"


@lru_cache(maxsize=1)
def _archive() -> bytes:
    # Built once per process: the running files do not change underneath it.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
        for rel in source_files():
            bundle.write(BASE_DIR / rel, os.path.join("btltech-pdf-service", rel))
    return buffer.getvalue()


@router.get("/source.zip")
def source_zip() -> Response:
    return Response(
        _archive(),
        media_type="application/zip",
        headers={
            "Content-Disposition": 'attachment; filename="btltech-pdf-service-source.zip"',
            "X-Source-Version": version(),
        },
    )


@router.get("/source", response_class=HTMLResponse)
def source_page() -> HTMLResponse:
    repo = (
        f'<p>The public repository is <a href="{escape(SOURCE_REPO_URL)}">'
        f"{escape(SOURCE_REPO_URL)}</a>.</p>"
        if SOURCE_REPO_URL else ""
    )
    return HTMLResponse(f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Source code &mdash; BTL Tech</title>
<link rel="stylesheet" href="/static/app.css" />
</head>
<body>
<nav class="top">
  <span class="logo">BTL Tech</span>
  <a href="/">Toolkit</a>
  <a href="/convert">PDF to Word</a>
  <a href="/edit">Edit PDF</a>
  <a href="/tools">Page tools</a>
</nav>
<header class="page">
  <h1>Source code</h1>
  <p class="sub">This PDF service is free software. You can read, change and share its code.</p>
</header>
<main class="card prose">
  <p>Copyright &copy; 2026 BTLTECH LTD. This program is free software: you can redistribute it
  and/or modify it under the terms of the GNU Affero General Public License as published by the
  Free Software Foundation, either version 3 of the License, or (at your option) any later version.</p>
  <p>It is distributed in the hope that it will be useful, but <strong>without any warranty</strong>;
  without even the implied warranty of merchantability or fitness for a particular purpose. See the
  <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU Affero General Public License</a> for details;
  a copy is in the download as <code>LICENSE</code>.</p>
  <p><a class="btn" href="/source.zip">Download the source of this version (ZIP)</a></p>
  <p class="small muted">Version: <code>{escape(version())}</code>. The download is built from the
  files this server is running, and includes the full licence, the third-party notices and the
  list of pinned dependencies.</p>
  {repo}
  <p class="small muted">The BTL Tech name and logo are not licensed under the AGPL. This offer covers this
  PDF service only; no other BTLTECH LTD software is part of it.</p>
</main>
<footer class="foot">
  <span class="source-line"><a href="/source">Source code</a> &middot; Free software under the
  <a href="https://www.gnu.org/licenses/agpl-3.0.html">GNU AGPL v3</a> &middot; No warranty</span>
</footer>
</body>
</html>""")
