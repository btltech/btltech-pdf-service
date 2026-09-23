// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
/* Browser test for the page-tools and PDF -> Word pages (development tool).

   Drives real Chrome through /tools and /convert: merge, compress, rotate,
   protect, unlock and the automatic .docx download, plus the error messages.
   These are the 15 UI assertions the README has always described; until now
   they were run by hand and not kept in the repository.

   Run everything with:  scripts/run_tests.sh --browser */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const playwright = await import("playwright-core");
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "test-output");
const CHROME =
  process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.APP_URL || "http://127.0.0.1:8000";
const SOURCE = process.env.TEST_PDF || path.join(OUT_DIR, "four.pdf");

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
page.on("pageerror", (error) => noise.push(error.message));

const card = (endpoint) => page.locator(`.tool[data-endpoint="${endpoint}"]`);

async function runTool(endpoint, files, fields = {}) {
  const tool = card(endpoint);
  await tool.locator("input[type=file]").setInputFiles(files);
  for (const [name, value] of Object.entries(fields)) {
    await tool.locator(`[name="${name}"]`).fill(String(value));
  }
  const waiting = page.waitForEvent("download", { timeout: 30000 });
  await tool.locator("button.run").click();
  const download = await waiting;
  const saved = path.join(OUT_DIR, "ui-" + download.suggestedFilename());
  await download.saveAs(saved);
  await page.waitForFunction(
    (selector) => document.querySelector(selector + " .notice").classList.contains("ok"),
    `.tool[data-endpoint="${endpoint}"]`
  );
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(saved), notice: await tool.locator(".notice").innerText() };
}

async function runToolExpectingError(endpoint, files, fields = {}) {
  const tool = card(endpoint);
  await tool.locator("input[type=file]").setInputFiles(files);
  for (const [name, value] of Object.entries(fields)) {
    await tool.locator(`[name="${name}"]`).fill(String(value));
  }
  await tool.locator("button.run").click();
  await page.waitForFunction(
    (selector) => document.querySelector(selector + " .notice").classList.contains("err"),
    `.tool[data-endpoint="${endpoint}"]`
  );
  return tool.locator(".notice").innerText();
}

console.log("\n=== page tools ===");
await page.goto(BASE + "/tools", { waitUntil: "load" });
check("the page tools load with all nine tools", (await page.locator(".tool").count()) === 9);

await card("/api/tools/rotate").locator("button.run").click();
check(
  "running a tool with no file asks for one",
  (await card("/api/tools/rotate").locator(".notice").innerText()).includes("Choose a PDF first")
);

const merged = await runTool("/api/tools/merge", [SOURCE, SOURCE]);
check("merge downloads merged.pdf", merged.name === "merged.pdf" && merged.bytes.subarray(0, 4).toString() === "%PDF");
check("merge reports the combined page count", merged.notice.includes("Now 8 page(s)"), merged.notice);

const compressed = await runTool("/api/tools/compress", [SOURCE]);
check("compress downloads compressed.pdf", compressed.name === "compressed.pdf" && compressed.bytes.length > 1000);
check("compress reports before and after sizes", /→/.test(compressed.notice), compressed.notice);

const rotated = await runTool("/api/tools/rotate", [SOURCE]);
check("rotate downloads rotated.pdf", rotated.name === "rotated.pdf");
check("the rotated file carries a 90 degree rotation", /\/Rotate\s+90/.test(rotated.bytes.toString("latin1")));

const locked = await runTool("/api/tools/protect", [SOURCE], { password: "hunter2" });
check("protect downloads protected.pdf", locked.name === "protected.pdf");
check("the protected file is encrypted", /\/Encrypt\b/.test(locked.bytes.toString("latin1")));

const short = await runToolExpectingError("/api/tools/protect", [SOURCE], { password: "ab" });
check("a too-short password is refused with a clear message", /at least 4 characters/.test(short), short);

const lockedPath = path.join(OUT_DIR, "ui-protected.pdf");
const wrong = await runToolExpectingError("/api/tools/unlock", [lockedPath], { password: "not-it" });
check("unlock with the wrong password is refused", /Incorrect password/.test(wrong), wrong);

console.log("\n=== PDF to Word ===");
await page.goto(BASE + "/convert", { waitUntil: "load" });
check("the converter page loads", (await page.title()).includes("PDF to Word"));

const waiting = page.waitForEvent("download", { timeout: 60000 });
await page.setInputFiles("#fileInput", SOURCE);
const docx = await waiting;
const docxPath = path.join(OUT_DIR, "ui-" + docx.suggestedFilename());
await docx.saveAs(docxPath);
check("a single PDF downloads automatically as .docx", docx.suggestedFilename() === "four.docx", docx.suggestedFilename());
const docxBytes = fs.readFileSync(docxPath);
check(
  "the download is a real Word file",
  docxBytes.subarray(0, 2).toString() === "PK" && docxBytes.includes(Buffer.from("word/document.xml")),
  docxBytes.length + " bytes"
);

// A refused conversion must not strand the file. Someone who buys conversions to
// convert THIS document should not have to go and find it again, so the failed
// item keeps a way to run it. Simulated here by making the next conversion fail,
// which is what a payment refusal looks like to this page.
await page.route("**/api/convert*", (route) =>
  route.fulfill({ status: 402, contentType: "application/json",
                  body: JSON.stringify({ detail: "You have used today's free conversion." }) }));
await page.setInputFiles("#fileInput", SOURCE);
await page.waitForFunction(() => document.querySelectorAll("#queue .status.error").length > 0,
  null, { timeout: 20000 });
const errText = await page.textContent("#queue .status.error");
check("a refused conversion says so without repeating the panel",
  /not converted/i.test(errText || ""), (errText || "").slice(0, 60));
check("a refused file keeps a way to convert it",
  (await page.locator("#queue button", { hasText: "Try again" }).count()) > 0);

await page.unroute("**/api/convert*");
await page.locator("#queue button", { hasText: "Try again" }).first().click();
// With more than one file queued the page does not download automatically, so
// the retried file finishes with its own Download button, same as any other.
await page.waitForFunction(
  () => document.querySelectorAll("#queue button.dl").length >= 2, null, { timeout: 60000 });
const retried = page.waitForEvent("download", { timeout: 30000 });
await page.locator("#queue button", { hasText: "Download .docx" }).last().click();
const again = await retried;
check("trying again converts the same file, with nothing to re-add",
  again.suggestedFilename().endsWith(".docx"), again.suggestedFilename());

if (noise.length) console.log("  page errors:", noise.join(" | "));
await browser.close();

console.log("\n=== summary ===");
console.log("  passed:", passed.length);
console.log("  failed:", failed.length);
failed.forEach((label) => console.log("    -", label));
process.exit(failed.length ? 1 : 0);
