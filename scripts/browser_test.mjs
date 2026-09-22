// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
/* Browser test for the PDF editor (development tool - not needed at runtime).

   It drives real Chrome through the editor UI - load, annotate, erase, undo,
   reorder pages, zoom, save - and asserts on the state inside the page. The
   saved PDF is then checked by scripts/verify_editor_output.py.

   Run everything with:  scripts/run_tests.sh --browser
   (needs `npm install` once, Node, and an installed Chrome; set CHROME_PATH
   if Chrome is not in the default macOS location). */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// playwright-core is a dev dependency you install in a scratch folder, so a
// bare import would fail when this file is run from outside this project.
// Fall back to resolving it from the folder you run the script from.
async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch (error) {
    const local = path.join(process.cwd(), "node_modules", "playwright-core", "index.js");
    if (fs.existsSync(local)) return await import(local);
    throw new Error(
      "playwright-core was not found. Run 'npm install playwright-core' in the folder " +
        "you are running this script from, then try again."
    );
  }
}

// The bare ESM import exposes named exports; loading the CJS entry point
// directly puts everything under `default`. Accept either shape.
const playwright = await loadPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) {
  throw new Error("playwright-core loaded but did not expose chromium - check its version.");
}

const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.APP_URL || "http://127.0.0.1:8000";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = process.env.TEST_PDF || path.join(HERE, "..", "test-output", "four.pdf");
const OUTPUT = process.env.OUT_PDF || path.join(HERE, "..", "test-output", "edited.pdf");

const passed = [];
const failed = [];

function check(label, ok, detail = "") {
  (ok ? passed : failed).push(label);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  (" + detail + ")" : ""}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();

const noise = [];
page.on("pageerror", (error) => noise.push("pageerror: " + error.message));
page.on("console", (message) => {
  if (message.type() === "error") noise.push("console: " + message.text());
});

console.log("\n=== editor: loading ===");
await page.goto(BASE + "/edit", { waitUntil: "load" });

check("page title is the editor", (await page.title()).includes("Edit PDF"));
check("pdf.js is loaded", await page.evaluate(() => typeof window.pdfjsLib === "object"));
check("pdf-lib is loaded", await page.evaluate(() => typeof window.PDFLib === "object"));
check(
  "the pdf.js worker is served locally",
  (await page.evaluate(async () => (await fetch("/static/vendor/pdf.worker.min.js")).status)) === 200
);

await page.setInputFiles("#fileInput", SOURCE);
await page.waitForFunction(
  () => window.state && window.state.pages.filter(Boolean).length === 4,
  null,
  { timeout: 60000 }
);
await page.waitForFunction(
  () => window.state.pages.every((record) => record && record.base.width > 0),
  null,
  { timeout: 60000 }
);

const geometry = await page.evaluate(() => ({
  pages: window.state.pages.filter(Boolean).length,
  order: window.state.order.slice(),
  width: window.state.pages[0].base.width,
  height: window.state.pages[0].base.height,
  pointWidth: Math.round(window.state.pages[0].viewport1.width)
}));
check("all four pages rendered", geometry.pages === 4, "order " + JSON.stringify(geometry.order));
check(
  "page canvas matches the page size",
  geometry.width > 300 && geometry.height > 300,
  `${geometry.width}x${geometry.height} px for a ${geometry.pointWidth}pt page`
);
check("thumbnails were built", (await page.$$(".thumb")).length === 4);
check("save is enabled once loaded", !(await page.isDisabled("#saveBtn")));

console.log("\n=== editor: annotating ===");
const overlay = await page.$(".page canvas.overlay");
const box = await overlay.boundingBox();

await page.click('.tbtn[data-tool="text"]');
await page.fill("#textValue", "EDITOR TEST MARK");
await page.fill("#textSize", "20");
await page.mouse.click(box.x + 140, box.y + 170);
await page.waitForTimeout(200);

await page.click('.tbtn[data-tool="pen"]');
await page.mouse.move(box.x + 80, box.y + 260);
await page.mouse.down();
for (let step = 0; step <= 20; step++) {
  await page.mouse.move(box.x + 80 + step * 9, box.y + 260 + Math.sin(step / 3) * 24);
}
await page.mouse.up();
await page.waitForTimeout(200);

await page.click('.tbtn[data-tool="highlight"]');
await page.mouse.move(box.x + 240, box.y + 380);
await page.mouse.down();
await page.mouse.move(box.x + 400, box.y + 430, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);

await page.click('.tbtn[data-tool="box"]');
await page.mouse.move(box.x + 90, box.y + 470);
await page.mouse.down();
await page.mouse.move(box.x + 300, box.y + 520, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);

const marks = await page.evaluate(() =>
  window.state.marks.map((mark) => ({ type: mark.type, page: mark.page }))
);
const inkPoints = await page.evaluate(() => {
  const stroke = window.state.marks.find((mark) => mark.type === "ink");
  return stroke ? stroke.points.length : 0;
});

check("a text mark was captured", marks.some((mark) => mark.type === "text"), JSON.stringify(marks));
check("a pen stroke was captured", inkPoints > 10, inkPoints + " points");
check("a highlight was captured", marks.some((mark) => mark.type === "highlight"));
check("a box was captured", marks.some((mark) => mark.type === "box"));

const plausible = await page.evaluate(() =>
  window.state.marks.every((mark) => {
    const view = window.state.pages[mark.page].viewport1;
    let x;
    let y;
    if (mark.type === "ink") {
      x = mark.points[0][0];
      y = mark.points[0][1];
    } else if (mark.x !== undefined) {
      x = mark.x;
      y = mark.y;
    } else {
      x = Math.min(mark.rect[0], mark.rect[2]);
      y = Math.min(mark.rect[1], mark.rect[3]);
    }
    return x >= -2 && x <= view.width + 2 && y >= -2 && y <= view.height + 2;
  })
);
check("marks are stored inside the page's PDF coordinates", plausible);

const total = marks.length;
await page.click('.tbtn[data-tool="erase"]');
await page.mouse.click(box.x + 80, box.y + 260);
await page.waitForTimeout(200);
const afterErase = await page.evaluate(() => window.state.marks.length);
check("the erase tool removed one mark", afterErase === total - 1, `${total} -> ${afterErase}`);

await page.click("#undoBtn");
await page.waitForTimeout(150);
const afterUndo = await page.evaluate(() => window.state.marks.length);
check("undo removes the most recent mark", afterUndo === afterErase - 1, `${afterErase} -> ${afterUndo}`);

console.log("\n=== editor: pages ===");
await page.click(".thumb:nth-child(2) .acts button:nth-child(3)");
await page.waitForTimeout(200);
check(
  "leaving a page out is recorded",
  await page.evaluate(
    () => Object.keys(window.state.removed).length === 1 && window.livePages().length === 3
  ),
  JSON.stringify(await page.evaluate(() => window.livePages()))
);

const orderBefore = await page.evaluate(() => window.state.order.slice());
await page.click(".thumb:nth-child(3) .acts button:nth-child(1)");
await page.waitForTimeout(200);
const orderAfter = await page.evaluate(() => window.state.order.slice());
check(
  "moving a page changes the order",
  JSON.stringify(orderAfter) !== JSON.stringify(orderBefore),
  JSON.stringify(orderBefore) + " -> " + JSON.stringify(orderAfter)
);

const zoomed = await page.evaluate(async () => {
  document.getElementById("zoomIn").click();
  return new Promise((resolve) => setTimeout(() => resolve(window.state.scale), 2500));
});
check("zooming re-renders at a larger scale", zoomed > 1, "scale " + zoomed);

console.log("\n=== editor: saving ===");
const waiting = page.waitForEvent("download", { timeout: 60000 });
await page.click("#saveBtn");
const download = await waiting;
await download.saveAs(OUTPUT);
// Record the order the editor showed, so verify_editor_output.py can check
// the saved file matches it (1-based original page numbers).
fs.writeFileSync(
  OUTPUT.replace(/\.pdf$/, "-order.json"),
  JSON.stringify(await page.evaluate(() => window.livePages().map((index) => index + 1)))
);
check("a PDF was downloaded", fs.statSync(OUTPUT).size > 2000, fs.statSync(OUTPUT).size + " bytes");
check(
  "the download is named after the source",
  download.suggestedFilename() === "four-edited.pdf",
  download.suggestedFilename()
);

console.log("\n=== browser health ===");
check("no uncaught page errors", noise.length === 0, noise.slice(0, 3).join(" | ").slice(0, 300));

await browser.close();

console.log("\n=== summary ===");
console.log("  passed:", passed.length);
console.log("  failed:", failed.length);
failed.forEach((label) => console.log("    -", label));
process.exit(failed.length ? 1 : 0);