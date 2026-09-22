# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Release checks for public deployment under the AGPL.

Guards what is easy to lose in a later edit: the licence, the source offer
that AGPL-3.0 section 13 requires on every page, the contents of the source
download, the pdf.js security setting, the split between production and test
dependencies, PDF -> Word staying out of the server process (memory), and
the separation from all other BTLTECH LTD software.

Usage:
    .venv/bin/python scripts/test_release.py
"""

import hashlib
import io
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from fastapi.testclient import TestClient  # noqa: E402

import source_offer  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)
PASSED, FAILED = [], []

# SHA-256 of https://www.gnu.org/licenses/agpl-3.0.txt
AGPL_SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0"


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))


def read(rel):
    with open(os.path.join(ROOT, rel), "rb") as handle:
        return handle.read()


print("\n=== licence ===")
check("LICENSE is the unmodified GNU AGPL v3 text",
      hashlib.sha256(read("LICENSE")).hexdigest() == AGPL_SHA256)
for rel in ("THIRD_PARTY_NOTICES.md", "LICENSES/Apache-2.0.txt", "LICENSES/pdf-lib-MIT.txt"):
    check(f"{rel} is present", os.path.isfile(os.path.join(ROOT, rel)))

OWN_SOURCE = [
    "app.py", "tools.py", "config.py", "source_offer.py", "converter_worker.py",
    "static/index.html", "static/convert.html", "static/editor.html", "static/tools.html",
    "static/app.css",
] + sorted("scripts/" + name for name in os.listdir(os.path.join(ROOT, "scripts"))
           if name.endswith((".py", ".mjs", ".sh")))
missing = [rel for rel in OWN_SOURCE if b"SPDX-License-Identifier: AGPL-3.0-or-later" not in read(rel)[:400]]
check("every source file carries the AGPL-3.0-or-later identifier", not missing, ", ".join(missing))

print("\n=== source offer (AGPL-3.0 section 13) ===")
for path in ("/", "/convert", "/edit", "/tools", "/source"):
    response = client.get(path)
    check(f"{path} links to the source code", response.status_code == 200 and 'href="/source"' in response.text)

page = client.get("/source")
check("/source states the licence and offers the download",
      "GNU Affero General Public License" in page.text and 'href="/source.zip"' in page.text)

response = client.get("/source.zip")
names = []
if response.status_code == 200 and response.content[:2] == b"PK":
    with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
        names = [name.split("/", 1)[1] for name in bundle.namelist()]
required = ["app.py", "tools.py", "config.py", "source_offer.py", "converter_worker.py", "LICENSE", "THIRD_PARTY_NOTICES.md",
            "requirements.txt", "static/editor.html", "static/vendor/pdf.min.js", "static/vendor/pdf-lib.min.js"]
check("/source.zip contains the complete running source",
      all(name in names for name in required), ", ".join(n for n in required if n not in names))
check("/source.zip leaves out environments, caches and VCS data",
      not any(re.match(r"(\.venv|venv|\.git|node_modules|test-output)/", n) or "__pycache__" in n for n in names))
check("/source.zip reports which version it is", bool(response.headers.get("X-Source-Version")))

secret = os.path.join(ROOT, ".env.release-test")
with open(secret, "w") as handle:
    handle.write("EXAMPLE=never-shipped\n")
try:
    shipped = source_offer.source_files()
finally:
    os.remove(secret)
check("a .env file is never included in the source download", ".env.release-test" not in shipped)

print("\n=== security ===")
editor = read("static/editor.html").decode()
calls = re.findall(r"getDocument\(\{[^}]*\}", editor)
check("every pdf.js getDocument call sets isEvalSupported: false (CVE-2024-4367)",
      bool(calls) and all("isEvalSupported: false" in call for call in calls), "; ".join(calls))

print("\n=== memory ===")
before = "pdf2docx" in sys.modules
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from make_test_pdf import make_pdf  # noqa: E402

converted = client.post("/api/convert", files={"file": ("one.pdf", make_pdf(1), "application/pdf")})
check("PDF -> Word runs in a child process, never inside the server",
      converted.status_code == 200 and converted.content[:2] == b"PK" and not before and "pdf2docx" not in sys.modules)

print("\n=== dependencies ===")
prod = read("requirements.txt").decode().lower()
check("test-only packages are not production dependencies",
      not re.search(r"^(httpx|httpcore|certifi|playwright)", prod, re.M))
check("every production dependency is pinned exactly",
      all("==" in line for line in prod.splitlines() if line.strip() and not line.startswith("#")))

print("\n=== separation from other BTLTECH LTD software ===")
OTHER = re.compile(r"repairflow|myassistant|obd|\becm\b|ledgerpad|taxlane|rackrush|lyrid|filmloop|"
                   r"/users/|workers\.dev|railway\.app", re.I)
offenders = []
for dirpath, dirs, files in os.walk(ROOT):
    dirs[:] = [d for d in dirs if d not in {".git", ".venv", "node_modules", "test-output", "__pycache__",
                                              "vendor", "LICENSES", "samples"}]
    for name in files:
        rel = os.path.relpath(os.path.join(dirpath, name), ROOT)
        if rel in ("scripts/test_release.py", "LICENSE", "package-lock.json") or name.endswith((".pdf", ".png")):
            continue
        if OTHER.search(read(rel).decode("utf-8", "ignore")):
            offenders.append(rel)
check("no file refers to another BTLTECH LTD product or a local path", not offenders, ", ".join(offenders))
imports = set()
for rel in ("app.py", "tools.py", "config.py", "source_offer.py", "converter_worker.py"):
    imports |= set(re.findall(r"^\s*(?:from|import)\s+([\w.]+)", read(rel).decode(), re.M))
local = {name for name in imports if os.path.exists(os.path.join(ROOT, name.split(".")[0] + ".py"))}
check("the service imports only its own modules and published packages",
      local <= {"config", "tools", "source_offer", "app", "converter_worker"}, ", ".join(sorted(local)))

print("\n=== summary ===")
print(f"  passed: {len(PASSED)}")
print(f"  failed: {len(FAILED)}")
for label in FAILED:
    print(f"    - {label}")
sys.exit(1 if FAILED else 0)
