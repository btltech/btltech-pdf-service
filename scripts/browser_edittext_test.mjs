// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
/* Browser test for Edit Existing Text (development tool - not needed at runtime).

   It drives real Chrome through the whole customer workflow - open a PDF, click a
   line, change the words, preview, save - and, just as importantly, through the
   refusals: a scanned page and a script the engine cannot re-set must be turned
   down in plain words with nothing offered for download.

   The saved PDF is then checked by scripts/verify_edittext_output.py.

   Run everything with:  scripts/run_tests.sh --browser
   (needs `npm install` once, Node, and an installed Chrome; set CHROME_PATH
   if Chrome is not in the default macOS location). */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

async function loadPlaywright() {
  try {
    return await import("playwright-core");
  } catch {
    const local = path.join(process.cwd(), "node_modules", "playwright-core", "index.js");
    if (fs.existsSync(local)) return await import(local);
    throw new Error(
      "playwright-core was not found. Run 'npm install playwright-core' in the folder " +
        "you are running this script from, then try again."
    );
  }
}

const playwright = await loadPlaywright();
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);
if (!chromium) throw new Error("playwright-core loaded but did not expose chromium - check its version.");

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.APP_URL || "http://127.0.0.1:8000";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = process.env.TEST_PDF || path.join(HERE, "..", "test-output", "edittext.pdf");
const OUTPUT = process.env.OUT_PDF || path.join(HERE, "..", "test-output", "edittext-edited.pdf");

const passed = [], failed = [];
function check(label, ok, detail = "") {
  (ok ? passed : failed).push(label);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  (" + detail + ")" : ""}`);
}

// CHROME_ARGS lets a run point Chrome at a specific address for a hostname, which
// is how a newly pointed domain can be tested before every resolver has caught up.
// Arguments are separated by newlines, not spaces, because Chrome's own flags take
// values containing spaces:
//   CHROME_ARGS='--host-resolver-rules=MAP example.com 1.2.3.4' node scripts/...
const extraArgs = (process.env.CHROME_ARGS || "").split("\n").map((a) => a.trim()).filter(Boolean);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: extraArgs });
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 950 } });
const page = await context.newPage();

const noise = [];
page.on("pageerror", (e) => noise.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") noise.push("console: " + m.text()); });

// The promise on this page is that the document never leaves the tab, so watch
// what actually goes over the wire rather than trusting the page to say so.
const requests = [];
page.on("request", (r) => requests.push({ method: r.method(), url: r.url(), body: (r.postData() || "").length }));

// Helpers that speak in the page's own terms.
const runs = () => page.evaluate(() => window.__edittext.runs.map((r) => r.text));
const selectRun = (i) => page.evaluate((idx) => window.__edittext.selectRun(idx), i);
const statusText = () => page.evaluate(() => {
  const s = document.getElementById("status");
  return s.hidden ? "" : s.textContent.trim();
});
const detailRows = () => page.evaluate(() => {
  const d = document.getElementById("details");
  if (d.hidden) return {};
  return Object.fromEntries([...d.querySelectorAll(".row")].map((r) => [r.children[0].textContent, r.children[1].textContent]));
});
async function typeAndPreview(text) {
  await page.fill("#newtext", text);
  await page.click("#preview");
  await page.waitForFunction(() => !document.getElementById("preview").disabled, null, { timeout: 30000 });
}

console.log("\n=== the page loads and the engine starts ===");
await page.goto(BASE + "/edit-text", { waitUntil: "load" });
check("page title names the feature", (await page.title()).includes("Edit the text"));
await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
check("the PDFium engine is ready in the browser", await page.evaluate(() => document.body.dataset.ready === "1"));
check("pdf-lib is loaded for the integrity check", await page.evaluate(() => typeof window.PDFLib === "object"));
check("the WASM is served from this site", (await page.evaluate(async () => (await fetch("/static/vendor/pdfium/pdfium.wasm")).status)) === 200);

console.log("\n=== opening a document ===");
// Dragging is not available on a phone and not available from a keyboard, so
// there has to be another way in. A global rule hides file inputs, which once
// left this page with drag-and-drop as the only option.
check("there is a visible way to choose a file",
  await page.evaluate(() => {
    const dz = document.getElementById("dropzone");
    return !!dz && getComputedStyle(dz).display !== "none" && /browse/i.test(dz.textContent);
  }));
// On a touch screen there is nothing to drag from, so the wording must not lead
// with dragging.
check("on a touch screen it does not tell you to drag",
  await page.evaluate(() => {
    const shown = [...document.querySelectorAll("#dropzone strong")]
      .filter((el) => getComputedStyle(el).display !== "none")
      .map((el) => el.textContent).join(" ");
    return window.matchMedia("(hover: none)").matches ? !/drag/i.test(shown) : /drag/i.test(shown);
  }));
check("the drop area is reachable from the keyboard",
  await page.evaluate(() => {
    const dz = document.getElementById("dropzone");
    return dz.getAttribute("role") === "button" && dz.tabIndex >= 0;
  }));
const opensPicker = await page.evaluate(() => new Promise((done) => {
  const input = document.getElementById("file");
  input.addEventListener("click", () => done(true), { once: true });
  document.getElementById("dropzone").click();
  setTimeout(() => done(false), 1000);
}));
check("clicking the drop area opens the file picker", opensPicker);

await page.setInputFiles("#file", SOURCE);
await page.waitForFunction(() => window.__edittext && window.__edittext.runs.length > 0, null, { timeout: 30000 });
check("the file name and page count are shown", (await page.textContent("#filename")).includes("2 page"));
const texts = await runs();
check("the text on the page was found", texts.some((t) => t.includes("Invoice Summary")), `${texts.length} runs`);
// The page is drawn to a canvas that carries its own width and height. If CSS
// shrinks one and not the other the document comes out visibly distorted, which
// is what happened on a phone.
const shape = await page.evaluate(() => {
  const c = document.getElementById("page");
  const r = c.getBoundingClientRect();
  return { pxRatio: c.width / c.height, cssRatio: r.width / r.height };
});
check("the page keeps its shape on screen",
  Math.abs(shape.pxRatio - shape.cssRatio) < 0.02,
  `drawn ${shape.pxRatio.toFixed(3)} vs shown ${shape.cssRatio.toFixed(3)}`);
// A phone browser zooms the whole page out when the layout overflows, which
// shrinks the text the customer is trying to tap. The page must fit its column.
check("the layout does not overflow the screen",
  await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1),
  await page.evaluate(() => `body ${document.body.scrollWidth} vs viewport ${window.innerWidth}`));
check("the page fits the space it is given",
  await page.evaluate(() => {
    const wrap = document.getElementById("pagewrap");
    return document.getElementById("page").width <= wrap.clientWidth + 1;
  }));
// A CDN in front of the site injects requests of its own - analytics and bot
// detection - which are not this page's doing and cannot be prevented from here.
// They are separated out rather than ignored: the assertions below are about what
// THIS PAGE does, and anything the CDN adds is printed in full so it can never
// pass unnoticed, because it still needs to be true of what /privacy says.
const injected = (u) => u.includes("/cdn-cgi/") || u.includes("cloudflareinsights.com");
const ours = requests.filter((r) => !injected(r.url));
const infra = requests.filter((r) => injected(r.url));
const sends = ours.filter((r) => r.method !== "GET" || r.body > 0);
check("this page sends no data anywhere", sends.length === 0, sends.map((r) => `${r.method} ${r.url}`).join(", ").slice(0, 120) || "no non-GET requests");
check("every request this page makes is for this site's own assets", ours.every((r) => r.url.startsWith(BASE)), ours.filter((r) => !r.url.startsWith(BASE)).map((r) => r.url).join(", ").slice(0, 120) || "all local");
if (infra.length) {
  console.log(`  [NOTE] the CDN in front of this site injected ${infra.length} request(s) of its own:`);
  for (const r of infra) console.log(`         ${r.method} ${r.url.slice(0, 96)}${r.body ? ` (${r.body} bytes sent)` : ""}`);
  console.log("         These are not this page's doing, but /privacy has to disclose them.");
}
const mark = requests.length;

console.log("\n=== an ordinary replacement ===");
const plain = (await runs()).findIndex((t) => t.includes("Amount due"));
await selectRun(plain);
check("clicking a line shows its current text", (await page.inputValue("#newtext")).includes("Amount due"));
await typeAndPreview("Amount due: 1,975.00");
let rows = await detailRows();
check("the edit was accepted", await page.evaluate(() => !document.getElementById("keep").disabled), rows["How it fits"] || (await statusText()).slice(0, 60));
check("it was replaced in place", (rows["How it fits"] || "").includes("in place"), rows["How it fits"]);
check("the integrity check passed", (rows["Integrity check"] || "").startsWith("ok"), rows["Integrity check"]);
check("a preview of the result is shown", await page.evaluate(() => !document.getElementById("previewwrap").hidden));

console.log("\n=== an underline follows the words ===");
const heading = (await runs()).findIndex((t) => t.includes("Invoice Summary"));
await selectRun(heading);
await typeAndPreview("Invoice Total");
rows = await detailRows();
check("the underline is kept", (rows["Kept"] || "").includes("underline"), JSON.stringify(rows["Kept"] || "none"));

console.log("\n=== refusals ===");
const cjk = (await runs()).findIndex((t) => /[一-鿿]/.test(t));
await selectRun(cjk);
await typeAndPreview("客户");
let status = await statusText();
check("Chinese text is refused", /Chinese/.test(status), status.slice(0, 80));
check("nothing is offered for download after a refusal", await page.evaluate(() => document.getElementById("keep").disabled));

// A justified paragraph must be refused: re-setting one of its lines would leave
// it short of the right margin while the rest of the paragraph stays flush.
const just = (await runs()).findIndex((t) => t.includes("The supplier shall provide"));
await selectRun(just);
await typeAndPreview("The supplier shall provide the amended services described in the schedule with");
status = await statusText();
check("a justified paragraph is refused", /justified paragraph/.test(status), status.slice(0, 90));
check("the refusal does not quote a nonsense gap figure", !/0% wider|1% wider|-\d+% wider/.test(status), status.slice(0, 60));

// its last line is short by design and safe to edit
const lastLine = (await runs()).findIndex((t) => t.includes("of the client, such consent"));
await selectRun(lastLine);
await typeAndPreview("of the client, such consent not to be unreasonably refused or delayed.");
check("the last line of a justified paragraph stays editable", await page.evaluate(() => !document.getElementById("keep").disabled), await statusText());

await page.click("#next");
await page.waitForFunction(() => document.getElementById("pagelabel").textContent.includes("2 of 2"), null, { timeout: 15000 });
status = await statusText();
check("a scanned page is refused, in plain words", /scan/i.test(status), status.slice(0, 80));
check("a scanned page offers nothing to click", await page.evaluate(() => window.__edittext.boxes.every((b) => b.blank)));

console.log("\n=== more than one change to the same document ===");
// This section exists because of a real fault. Keeping a change re-read the
// ORIGINAL document to redraw the page - correct, and what keeps line numbers
// stable - but it also wiped the result pane, so the customer watched their
// work disappear and reasonably concluded only one edit was possible. Every
// edit was in fact still being saved; nothing on screen said so.
await page.click("#prev").catch(() => {});
await page.waitForFunction(() => document.getElementById("pagelabel").textContent.includes("1 of 2"), null, { timeout: 15000 });

const refLine = (await runs()).findIndex((t) => t.includes("Reference"));
await selectRun(refLine);
await typeAndPreview("Reference: NW-9001");
await page.click("#keep");
await page.waitForFunction(() => window.__edittext.edits === 1, null, { timeout: 20000 });
check("the kept change stays on screen", await page.evaluate(() => !document.getElementById("previewwrap").hidden));
check("and the pane says how much is held", /1 change so far/i.test(await page.$eval("#aftercap", (e) => e.textContent)),
      await page.$eval("#aftercap", (e) => e.textContent));

const amountLine = (await runs()).findIndex((t) => t.includes("Amount due"));
await selectRun(amountLine);
check("picking another line does not wipe it", await page.evaluate(() => !document.getElementById("previewwrap").hidden));
await typeAndPreview("Amount due: 2,500.00");
check("the new preview says it includes the earlier change",
      /earlier one/i.test(await page.$eval("#aftercap", (e) => e.textContent)),
      await page.$eval("#aftercap", (e) => e.textContent));
await page.click("#keep");
await page.waitForFunction(() => window.__edittext.edits === 2, null, { timeout: 20000 });
check("two changes are held at once", await page.evaluate(() => window.__edittext.edits) === 2);

// Both must survive into the file itself, not just the screen.
const bothInFile = await page.evaluate(async () => {
  const E = await import("/static/edittext/engine.mjs");
  const doc = E.openDoc(window.__edittext.workingBytes);
  if (!doc.doc) return "could not open the working copy";
  const P = E.P, page0 = P.FPDF_LoadPage(doc.doc, 0), tp = P.FPDFText_LoadPage(page0);
  const n = P.FPDFText_CountChars(tp);
  let text = "";
  for (let i = 0; i < n; i++) text += String.fromCharCode(P.FPDFText_GetUnicode(tp, i));
  P.FPDFText_ClosePage(tp); P.FPDF_ClosePage(page0); P.FPDF_CloseDocument(doc.doc);
  return text;
});
check("both changes are in the document, not only on screen",
      typeof bothInFile === "string" && bothInFile.includes("NW-9001") && bothInFile.includes("2,500.00"),
      typeof bothInFile === "string" ? "NW-9001:" + bothInFile.includes("NW-9001") + " 2,500.00:" + bothInFile.includes("2,500.00") : bothInFile);

console.log("\n=== turning the page keeps the work ===");
// The result pane was cleared by showPage and put back only by the paths that
// remembered to. Turning the page was not one of them, so a customer editing a
// long document watched everything disappear at page 2.
await page.click("#next");
await page.waitForFunction(() => document.getElementById("pagelabel").textContent.includes("2 of 2"), null, { timeout: 15000 });
check("changing page does not blank the kept work", await page.evaluate(() => !document.getElementById("previewwrap").hidden));
check("and the count is still right", /2 changes so far/i.test(await page.$eval("#aftercap", (e) => e.textContent)),
      await page.$eval("#aftercap", (e) => e.textContent));
await page.click("#prev");
await page.waitForFunction(() => document.getElementById("pagelabel").textContent.includes("1 of 2"), null, { timeout: 15000 });

console.log("\n=== re-opening a line you already changed ===");
// It used to offer the wording from the FILE, so a line you had just edited
// showed its old words back and looked as though nothing had happened.
const reopened = (await runs()).findIndex((t) => t.includes("Reference"));
await selectRun(reopened);
check("the box starts from your wording, not the original",
      /NW-9001/.test(await page.inputValue("#newtext")), JSON.stringify(await page.inputValue("#newtext")));
check("and the panel says why", await page.evaluate(() => !document.getElementById("editnote").hidden));
check("the original is still shown beside it",
      /NW-2291/.test(await page.$eval("#original", (e) => e.textContent)));
await page.click("#cancel");
const untouched = (await runs()).findIndex((t) => t.includes("supplier shall provide"));
await selectRun(untouched);
check("a line never edited offers the original, with no note",
      await page.evaluate(() => document.getElementById("editnote").hidden));
await page.click("#cancel");

console.log("\n=== the two-step edit is explained, not just enforced ===");
check("the hint tells you Preview comes first",
      /Press Preview first/i.test(await page.$eval("#keephint", (e) => e.textContent)));

// Put the document back as this section found it. The checks below save a file
// and then have it read by a different PDF engine, which asserts that nothing
// EXCEPT the one edit moved - so the two changes just made have to go.
await page.reload({ waitUntil: "load" });
await page.waitForFunction(() => window.__edittext, null, { timeout: 30000 });
await page.setInputFiles("#file", SOURCE);
await page.waitForFunction(() => window.__edittext.runs.length > 0, null, { timeout: 30000 });
await page.click("#next");
await page.waitForFunction(() => document.getElementById("pagelabel").textContent.includes("2 of 2"), null, { timeout: 15000 });

console.log("\n=== saving ===");
await page.click("#prev");
await page.waitForFunction(() => document.getElementById("pagelabel").textContent.includes("1 of 2"), null, { timeout: 15000 });
const again = (await runs()).findIndex((t) => t.includes("Client"));
await selectRun(again);
await typeAndPreview("Client: Eastgate Holdings Limited");
check("a short left-aligned line is NOT mistaken for justified", await page.evaluate(() => !document.getElementById("keep").disabled), await statusText());
check("an edit is ready to keep", await page.evaluate(() => !document.getElementById("keep").disabled), await statusText());
// With no payment configured the export is free, so the clean copy saves directly.
await page.click("#keep");
await page.waitForFunction(() => document.querySelector("#exportbox button"), null, { timeout: 20000 });
const [download] = await Promise.all([
  page.waitForEvent("download"),
  page.click("#exportbox button"),
]);
await download.saveAs(OUTPUT);
check("a PDF was downloaded", fs.statSync(OUTPUT).size > 1000, fs.statSync(OUTPUT).size + " bytes");
check("the download is named after the source", download.suggestedFilename() === "edittext-edited.pdf", download.suggestedFilename());
const saved = await page.evaluate(() => ({ ...window.__edittext.lastSaved, replaced: document.getElementById("original").textContent }));
fs.writeFileSync(OUTPUT.replace(/\.pdf$/, "-expected.json"), JSON.stringify(saved));

const afterOpen = requests.slice(mark).filter((r) => !injected(r.url));
const uploads = afterOpen.filter((r) => r.method !== "GET" || r.body > 0);
check("opening, editing and saving a document uploads nothing",
  uploads.length === 0, uploads.map((r) => `${r.method} ${r.url}`).join(", ").slice(0, 120) || `${afterOpen.length} request(s), all plain GETs`);

console.log("\n=== browser health ===");
check("no uncaught page errors", noise.length === 0, noise.slice(0, 3).join(" | ").slice(0, 300));

await browser.close();

console.log("\n=== summary ===");
console.log("  passed:", passed.length);
console.log("  failed:", failed.length);
failed.forEach((l) => console.log("    -", l));
process.exit(failed.length ? 1 : 0);
