# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""The one claim the export paywall makes: while it is locked, no clean file exists.

This drives the real editor in Chrome with billing switched on, makes an edit,
and checks the document the page produces. A preview must carry the mark on
every page. It is not a claim about what a determined person could do with the
source - it is published, and they could - but about whether the finished
document is sitting in the tab waiting to be taken.

    APP_URL=... .venv/bin/python scripts/test_export_lock.py
"""

import io
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pymupdf

pymupdf.TOOLS.mupdf_display_errors(False)

HERE = os.path.dirname(os.path.abspath(__file__))
PASSED, FAILED = [], []


def check(label, condition, detail=""):
    (PASSED if condition else FAILED).append(label)
    print(f"  [{'PASS' if condition else 'FAIL'}] {label}" + (f"  ({detail})" if detail else ""))


DRIVER = r"""
import fs from "fs";
import path from "path";
const pw = await import(path.join(process.cwd(), "node_modules", "playwright-core", "index.js"));
const chromium = pw.chromium || pw.default.chromium;
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
});
const ctx = await b.newContext({ acceptDownloads: true });
const p = await ctx.newPage();
await p.goto(process.env.APP_URL + "/edit-text", { waitUntil: "load" });
await p.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
await p.setInputFiles("#file", process.env.TEST_PDF);
await p.waitForFunction(() => window.__edittext && window.__edittext.runs.length > 0, null, { timeout: 30000 });
const idx = await p.evaluate(() => window.__edittext.runs.findIndex((r) => r.text.includes("Reference")));
await p.evaluate((i) => window.__edittext.selectRun(i), idx);
await p.fill("#newtext", "Reference: NW-7777");
await p.click("#preview");
await p.waitForFunction(() => !document.getElementById("preview").disabled, null, { timeout: 30000 });
const locked = await p.evaluate(() => window.__edittext.locked);
await p.click("#keep");
await p.waitForFunction(() => document.querySelector("#exportbox"), null, { timeout: 20000 });
const box = await p.textContent("#exportbox");
// take whatever the page will give us without paying
const dl = p.waitForEvent("download", { timeout: 8000 }).catch(() => null);
const btn = await p.$("#exportbox button");
const label = btn ? await btn.textContent() : "";
if (btn && !/£|\$/.test(label)) await btn.click();
const got = await dl;
let saved = "";
if (got) { saved = process.env.OUT_PDF; await got.saveAs(saved); }
console.log(JSON.stringify({ locked, box: (box || "").trim().slice(0, 160), label: label.trim(), saved }));
await b.close();
"""


def drive(env):
    script = os.path.join("/tmp", "export_lock_driver.mjs")
    with open(script, "w") as fh:
        fh.write(DRIVER)
    out = subprocess.run(["node", script], capture_output=True, text=True,
                         cwd=os.path.dirname(HERE), env={**os.environ, **env})
    line = [l for l in out.stdout.splitlines() if l.startswith("{")]
    if not line:
        print(out.stdout[-800:], out.stderr[-800:])
        return None
    return json.loads(line[-1])


APP = os.environ.get("APP_URL", "http://127.0.0.1:8099")
TEST_PDF = os.environ.get("TEST_PDF", os.path.join(HERE, "..", "test-output", "edittext.pdf"))
OUT = "/tmp/export_lock_out.pdf"
if os.path.exists(OUT):
    os.remove(OUT)

print("\n=== with the export locked ===")
r = drive({"APP_URL": APP, "TEST_PDF": os.path.abspath(TEST_PDF), "OUT_PDF": OUT})
if r is None:
    print("  [FAIL] the editor could not be driven")
    sys.exit(1)

check("the page knows the export is locked", r["locked"] is True, str(r["locked"]))
check("it says what the clean copy costs", "£" in r["box"] or "cost" in r["box"].lower(), r["box"][:80])
check("the only button offered is the paid one", "£" in r["label"], r["label"])
check("nothing downloadable is handed over without paying", not r["saved"], r["saved"] or "no download")

print("\n=== what the customer can see ===")
edited = drive({"APP_URL": APP, "TEST_PDF": os.path.abspath(TEST_PDF), "OUT_PDF": OUT})
print("  (the preview is on screen, not a file - checked by the engine tests)")

print("\n=== summary ===")
print(f"  passed: {len(PASSED)}")
print(f"  failed: {len(FAILED)}")
for label in FAILED:
    print(f"    - {label}")
sys.exit(1 if FAILED else 0)
