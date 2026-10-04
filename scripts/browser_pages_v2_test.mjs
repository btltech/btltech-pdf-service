// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
/* Browser test for the redesigned pages: the hub, PDF to Word and Edit existing text.

   What it guards is what the redesign promised, not the tools' behaviour (the other
   suites do that): nothing scrolls sideways on a phone, everything you tap is big
   enough to tap, the small print is readable, and when a pack is for sale the
   notice about what buying gives up sits in the same box as the buttons.

   Run everything with:  scripts/run_tests.sh --browser */

import path from "path";
import { fileURLToPath } from "url";

const playwright = await import("playwright-core");
const chromium = playwright.chromium || (playwright.default && playwright.default.chromium);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.APP_URL || "http://127.0.0.1:8000";

const passed = [], failed = [];
function check(label, ok, detail = "") {
  (ok ? passed : failed).push(label);
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${label}${detail ? "  (" + String(detail).slice(0, 150) + ")" : ""}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const PAGES = [["the hub", "/"], ["PDF to Word", "/convert"], ["Edit existing text", "/edit-text"], ["Edit PDF", "/edit"], ["Page tools", "/tools"]];
const TEST_PDF = process.env.TEST_PDF || path.join(HERE, "..", "test-output", "four.pdf");
const SIZES = [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]];

// Contrast of a foreground colour against the colour actually behind it.
const contrastScript = () => {
  const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const backdrop = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length < 4 || c[3] > 0.5)) return c;
    }
    return [11, 18, 32];
  };
  return (el) => {
    const fg = parse(getComputedStyle(el).color), bg = backdrop(el);
    const a = lum(fg) + 0.05, b = lum(bg) + 0.05;
    return Math.max(a, b) / Math.min(a, b);
  };
};

for (const [sizeName, viewport] of SIZES) {
  console.log(`\n=== ${sizeName} ===`);
  for (const [name, url] of PAGES) {
    const ctx = await browser.newContext({ viewport, isMobile: sizeName === "phone", hasTouch: sizeName === "phone" });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(BASE + url, { waitUntil: "load" });
    if (url === "/edit-text") await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });

    if (url === "/convert" || url === "/edit-text") {
      const heads = await page.evaluate(() => [...document.querySelectorAll("#dropzone strong")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).display !== "none"; }).map((e) => e.textContent.trim()));
      const want = sizeName === "phone" ? /^Choose/ : /^Drag/;
      check(`${name}: the upload box says "drag" with a mouse and "choose" on a phone, never both`, heads.length === 1 && want.test(heads[0]), heads.join(" | "));
    }
    check(`${name}: nothing scrolls sideways`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    check(`${name}: no script errors`, errors.length === 0, errors.join(" | "));

    // Everything a finger has to hit: links, buttons, summaries, fields. 44px is the
    // usual minimum. Footer links and prose links inside sentences are text, not targets.
    const small = await page.evaluate(() => {
      const out = [];
      const sel = "nav.top a, a.tool, a.task, a.pickt, button:not([hidden]), summary, input[type=text], input[type=number], input[type=password], select, #dropzone, #trysample, label.pickfile, label.check, label.pick";
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || (r.width === 0 && r.height === 0)) continue;
        if (el.closest("[hidden]")) continue;
        if (r.height < 43.5) out.push((el.id || el.className || el.tagName) + ":" + Math.round(r.height));
      }
      return out;
    });
    check(`${name}: every tap target is at least 44px tall`, small.length === 0, small.join(", "));

    const lowContrast = await page.evaluate((src) => {
      const contrast = eval("(" + src + ")")();
      const out = [];
      for (const el of document.querySelectorAll("main p, main li, main span, main small, section p, section li, header p, .fine, .legal, .sub, .hint, summary, nav.top a, footer, footer a")) {
        if (!el.textContent.trim() || el.children.length > 0 && el.tagName !== "A") continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || el.closest("[hidden]")) continue;
        if (el.closest(".mini")) continue;            // the sample-invoice drawing is a picture of a page, not text to read
        const px = parseFloat(getComputedStyle(el).fontSize);
        const need = px >= 24 ? 3 : 4.5;
        const c = contrast(el);
        if (c < need) out.push(el.tagName + "." + el.className + " " + c.toFixed(1));
      }
      return out;
    }, contrastScript.toString());
    check(`${name}: text is readable against its background (4.5:1)`, lowContrast.length === 0, lowContrast.slice(0, 4).join(" | "));
    await ctx.close();
  }
}

// ---------------------------------------------------------------- PDF to Word, with a pack for sale ---
console.log("\n=== PDF to Word: what the page shows when something can be bought ===");
const packs = [
  { credits: 10, price: "2.00", label: "10 conversions for £2.00", display: "£2.00", each: "20p" },
  { credits: 25, price: "4.00", label: "25 conversions for £4.00", display: "£4.00", each: "16p" },
];
async function convertWith(allowance, viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  await page.route("**/api/allowance", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify(allowance) }));
  await page.goto(BASE + "/convert", { waitUntil: "load" });
  await page.waitForSelector("#billing:not([hidden])");
  return { ctx, page };
}

{
  const { ctx, page } = await convertWith({ billing: true, may_convert: false, free_left: 0, free_per_day: 1, credits: 0, packs, currency: "GBP" });
  check("with nothing left, the pill says so", (await page.textContent("#allow")).trim() === "No conversions left today");
  check("and the packs are open, not hidden away", await page.evaluate(() => document.querySelector("details.buy").open));
  const cards = await page.$$eval("button.pack", (bs) => bs.map((b) => b.innerText.replace(/\s+/g, " ").trim()));
  check("each pack shows its count, its price and what one conversion costs",
    JSON.stringify(cards) === JSON.stringify(["10 conversions £2.00 20p each", "25 conversions £4.00 16p each"]), JSON.stringify(cards));
  // The notice has to be beside the buttons: inside the same box, so it can never be
  // left out when the buttons are showing.
  const together = await page.evaluate(() => {
    const box = document.querySelector("details.buy .inner");
    return !!box && !!box.querySelector("button.pack") && /14-day right to cancel does not apply/.test(box.querySelector(".legal").textContent)
      && !!box.querySelector('.legal a[href="/terms"]');
  });
  check("the 14-day-cancellation notice and the terms link sit in the same box as the pay buttons", together);
  const lc = await page.evaluate((src) => {
    const contrast = eval("(" + src + ")")();
    return contrast(document.querySelector(".legal a"));
  }, contrastScript.toString());
  check("the terms link is readable (it used to be dark blue on navy)", lc >= 4.5, lc.toFixed(1));
  check("the two packs are separate cards with a gap between them", await page.evaluate(() => {
    const [a, b] = document.querySelectorAll("button.pack"); const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    return rb.left - ra.right >= 8;
  }));
  await ctx.close();
}
{
  const { ctx, page } = await convertWith({ billing: true, may_convert: true, free_left: 1, free_per_day: 1, credits: 0, packs, currency: "GBP" });
  check("with a free conversion left, the pill says how many", (await page.textContent("#allow")).trim() === "1 free conversion left today");
  check("and the packs are tucked away until asked for", await page.evaluate(() => !document.querySelector("details.buy").open));
  check("the notice is still in the box with the buttons when it is opened",
    await page.evaluate(() => { const d = document.querySelector("details.buy"); d.open = true; return d.querySelector(".legal").textContent.includes("Terms of sale") && d.querySelectorAll("button.pack").length === 2; }));
  await ctx.close();
}
{
  const { ctx, page } = await convertWith({ billing: true, may_convert: true, free_left: 0, free_per_day: 1, credits: 4, packs, currency: "GBP" });
  check("with credits, the pill counts them and the free ones",
    /You have 4 conversions left, and 0 free today/.test((await page.textContent("#allow")).replace(/\s+/g, " ")));
  await ctx.close();
}
{
  const { ctx, page } = await convertWith({ billing: true, may_convert: false, free_left: 0, free_per_day: 1, credits: 0,
    packs: [{ credits: 10, price: "2.00", label: "10 conversions for £2.00" }], currency: "GBP" });
  const text = await page.$eval("button.pack", (b) => b.innerText.trim());
  check("a server that has not been updated (no display or each) still shows the pack, from its label", text === "10 conversions for £2.00", text);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.route("**/api/allowance", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ billing: false, may_convert: true }) }));
  await page.goto(BASE + "/convert", { waitUntil: "load" });
  await page.waitForTimeout(400);
  check("a deployment that charges nothing shows no pill and no billing box",
    await page.evaluate(() => document.getElementById("allow").hidden && document.getElementById("billing").hidden));
  await ctx.close();
}

// ---------------------------------------------------------------- Edit existing text: the two states ---
console.log("\n=== Edit existing text: empty and loaded ===");
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/edit-text", { waitUntil: "load" });
  await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
  const layout = await page.evaluate(() => {
    const main = document.querySelector("main.edittext > section.panel").getBoundingClientRect();
    const aside = getComputedStyle(document.querySelector("main.edittext > aside")).display;
    return { mainLeft: main.left, mainRight: main.right, vw: window.innerWidth, aside, cards: document.querySelectorAll(".willwont .card").length,
             cardsVisible: document.querySelector(".willwont").getBoundingClientRect().height > 0 };
  });
  check("empty: the upload card is centred, not stretched to the page edges", layout.mainLeft > 100 && Math.abs((layout.mainLeft + layout.mainRight) / 2 - layout.vw / 2) < 4, JSON.stringify(layout));
  check("empty: the side panel is out of the way", layout.aside === "none");
  check("empty: what it will and will not do is shown as two cards", layout.cards === 2 && layout.cardsVisible);
  await page.click("#trysample");
  await page.waitForSelector("#stage:not([hidden])", { timeout: 30000 });
  const loaded = await page.evaluate(() => ({
    aside: getComputedStyle(document.querySelector("main.edittext > aside")).display,
    cards: document.querySelector(".willwont").getBoundingClientRect().height,
    two: getComputedStyle(document.querySelector("main.edittext")).gridTemplateColumns.split(" ").length,
  }));
  check("loaded: the side panel appears beside the page", loaded.aside !== "none" && loaded.two === 2, JSON.stringify(loaded));
  check("loaded: the will/will-not cards get out of the way", loaded.cards === 0);
  check("loaded: the upload box has shrunk to a strip above the page", await page.evaluate(() => document.getElementById("dropzone").getBoundingClientRect().height < 90));
  check("loaded: nothing scrolls sideways", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await ctx.close();
}

// ---------------------------------------------------------------- Edit existing text on a phone: the save bar ---
console.log("\n=== Edit existing text on a phone: the save bar ===");
async function phoneEdit(locked) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  if (locked) {
    await page.route("**/api/export/status*", (r) => r.fulfill({ contentType: "application/json",
      body: JSON.stringify({ billing: true, unlocked: false, price: "1.00", currency: "GBP" }) }));
  }
  await page.goto(BASE + "/edit-text", { waitUntil: "load" });
  await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
  await page.click("#trysample");
  await page.waitForSelector("#stage:not([hidden])", { timeout: 30000 });
  return { ctx, page };
}
const barVisible = (page) => page.evaluate(() => { const b = document.getElementById("savebar"); const r = b.getBoundingClientRect();
  return !b.hidden && getComputedStyle(b).display !== "none" && r.height > 0; });
async function keepOneEdit(page) {
  await page.evaluate(() => window.__edittext.selectRun(1));
  await page.fill("#newtext", "Northwood Services Ltd");
  await page.click("#preview");
  await page.waitForFunction(() => !document.getElementById("preview").disabled, null, { timeout: 30000 });
  await page.click("#keep");
  await page.waitForTimeout(300);
}
{
  const { ctx, page } = await phoneEdit(true);
  check("before any change there is no save bar", !(await barVisible(page)));
  await keepOneEdit(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  check("after a change the bar appears with the count", (await barVisible(page)) && /1 change kept/.test(await page.textContent("#savecount")), await page.textContent("#savecount"));
  check("and shows the price on its button", (await page.textContent("#savego")).trim() === "Save · £1.00", await page.textContent("#savego"));
  const boxFar = await page.evaluate(() => { const r = document.getElementById("exportbox").getBoundingClientRect(); return r.top > window.innerHeight || r.bottom < 0; });
  check("while the real save box is off screen", boxFar);
  const before = await page.evaluate(() => window.scrollY);
  await page.click("#savego");
  await page.waitForFunction(() => { const r = document.getElementById("exportbox").getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; }, null, { timeout: 5000 });
  check("tapping it scrolls to the save box rather than paying", (await page.evaluate(() => window.scrollY)) > before && (await page.isVisible("#buyexport")));
  check("where the notice about giving up the 14-day right to cancel is shown beside the pay button",
    /14-day right to cancel does not apply/.test(await page.$eval("#exportbox", (e) => e.textContent)) && await page.isVisible('#exportbox a[href="/terms"]'));
  check("and the bar steps aside once the box is in view", !(await barVisible(page)));
  check("nothing was paid or requested by tapping it", await page.evaluate(() => !document.getElementById("buyexport").disabled));
  await ctx.close();
}
{
  const { ctx, page } = await phoneEdit(false);
  await keepOneEdit(page);
  check("when the document is not locked the bar offers a plain Save", /Save the PDF/.test(await page.textContent("#savego")));
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/edit-text", { waitUntil: "load" });
  await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 30000 });
  await page.click("#trysample");
  await page.waitForSelector("#stage:not([hidden])", { timeout: 30000 });
  await keepOneEdit(page);
  check("on a computer there is no bar: the save box is already beside the page", !(await barVisible(page)));
  await ctx.close();
}

// ---------------------------------------------------------------- Edit PDF ---
console.log("\n=== Edit PDF ===");
const shown = (page, sel) => page.evaluate((q) => { const e = document.querySelector(q); if (!e) return false; const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== "none" && r.width > 0 && r.height > 0; }, sel);
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/edit", { waitUntil: "load" });
  check("empty: the tools are out of the way until there is a document", !(await shown(page, ".sidebar")));
  check("empty: the upload card and the three things you can do are shown", (await shown(page, "#dropzone")) && (await shown(page, ".featrow")));
  check("empty: the Download button is off, and says why on the page", (await page.isDisabled("#saveBtn")) === true && !(await shown(page, ".stagebar")));
  await page.setInputFiles("#fileInput", TEST_PDF);
  await page.waitForSelector(".pdfpage", { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById("saveBtn").disabled, null, { timeout: 30000 });
  check("loaded: the tools appear beside the page", (await shown(page, ".sidebar")) && (await shown(page, ".tbtn")));
  check("loaded: the upload card and the feature cards get out of the way", !(await shown(page, "#dropzone")) && !(await shown(page, ".featrow")));
  check("loaded: Download is on", (await page.isDisabled("#saveBtn")) === false && !(await shown(page, ".savehint")));
  const opts = async () => page.evaluate(() => ({
    ink: !!document.querySelector(".opt-ink") && getComputedStyle(document.querySelector(".opt-ink")).display !== "none",
    weight: (() => { const e = document.querySelector(".f-weight"); return !!e && e.getBoundingClientRect().width > 0 && getComputedStyle(e).display !== "none"; })(),
    text: getComputedStyle(document.querySelector(".opt-text")).display !== "none",
    image: getComputedStyle(document.querySelector(".opt-image")).display !== "none" }));
  const tool = async (t) => { await page.click(`.tbtn[data-tool="${t}"]`); return opts(); };
  let o = await opts();
  check("Select: no options are shown", !o.ink && !o.text && !o.image, JSON.stringify(o));
  o = await tool("text");
  check("Text: colour, size and the text box", o.ink && o.text && !o.weight && !o.image, JSON.stringify(o));
  check("Text: the box you type into is on screen", await shown(page, "#textValue"));
  o = await tool("pen");
  check("Draw / sign: colour and weight, nothing about text", o.ink && o.weight && !o.text && !o.image, JSON.stringify(o));
  o = await tool("highlight");
  check("Highlight: colour only", o.ink && !o.weight && !o.text, JSON.stringify(o));
  o = await tool("box");
  check("Box: colour and weight", o.ink && o.weight && !o.text, JSON.stringify(o));
  o = await tool("image");
  check("Stamp image: only the image chooser", o.image && !o.ink && !o.text, JSON.stringify(o));
  check("and it is a real button, not the browser's grey 'Choose File'", await page.evaluate(() => { const l = document.querySelector("label.pickfile"); return !!l && l.getBoundingClientRect().height >= 44 && getComputedStyle(l).backgroundColor !== "rgba(0, 0, 0, 0)"; }));
  o = await tool("erase");
  check("Erase: no options", !o.ink && !o.text && !o.image, JSON.stringify(o));
  const acts = await page.$$eval(".thumb .acts button", (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().height)));
  check("every page-strip button is at least 44px tall", acts.length >= 8 && acts.every((h) => h >= 44), acts.join(","));
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE + "/edit", { waitUntil: "load" });
  await page.setInputFiles("#fileInput", TEST_PDF);
  await page.waitForSelector(".pdfpage", { timeout: 30000 });
  await page.waitForFunction(() => !document.getElementById("saveBtn").disabled, null, { timeout: 30000 });
  check("phone: the tools are one row you can swipe", await page.evaluate(() => { const t = document.querySelector(".toolbar"); return t.scrollWidth > t.clientWidth && getComputedStyle(t).overflowX === "auto"; }));
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(300);
  const top = await page.evaluate(() => Math.round(document.querySelector(".sidebar > .panel:first-child").getBoundingClientRect().top));
  check("phone: the tools stay pinned to the top while the document scrolls", top >= 0 && top <= 2, "top=" + top);
  check("phone: the pages strip still has its heading", await page.evaluate(() => { const h = document.querySelector(".sidebar > .panel:last-child > h3"); return !!h && getComputedStyle(h).display !== "none"; }));
  check("phone: the pages strip comes after the document", await page.evaluate(() => document.querySelector(".stage").getBoundingClientRect().top < document.querySelector(".sidebar > .panel:last-child").getBoundingClientRect().top + window.scrollY));
  await ctx.close();
}

// ---------------------------------------------------------------- Page tools ---
console.log("\n=== Page tools ===");
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE + "/tools", { waitUntil: "load" });
  const info = await page.evaluate(() => ({
    tiles: [...document.querySelectorAll("a.pickt")].map((a) => a.getAttribute("href")),
    cards: [...document.querySelectorAll("section.tool")].map((c) => c.id),
    groups: [...document.querySelectorAll(".pgroup")].map((g) => g.querySelectorAll("section.tool").length),
    cols: getComputedStyle(document.querySelector(".tcards")).gridTemplateColumns.split(" ").length,
    strips: [...document.querySelectorAll("section.tool .dropzone")].map((d) => Math.round(d.getBoundingClientRect().height)),
    unlabelled: [...document.querySelectorAll("section.tool input:not([type=file]), section.tool select")].filter((e) => !e.closest("label")).length,
  }));
  check("nine tools, in three groups of three", info.cards.length === 9 && JSON.stringify(info.groups) === "[3,3,3]", JSON.stringify(info.groups));
  check("a picker tile for every tool, and each one lands on a real card", info.tiles.length === 9 && info.tiles.every((h) => info.cards.includes(h.slice(1))), info.tiles.join(","));
  check("three cards across on a computer", info.cols === 3, String(info.cols));
  check("each upload area is a compact strip, not a big box", info.strips.every((h) => h <= 80), info.strips.join(","));
  check("every field is inside its label, so it is announced with it and taps with it", info.unlabelled === 0, String(info.unlabelled));
  await page.click('a.pickt[href="#rotate"]');
  await page.waitForTimeout(600);
  check("tapping a tile takes you to that tool", await page.evaluate(() => { const r = document.getElementById("rotate").getBoundingClientRect(); return r.top >= 0 && r.top < 400 && location.hash === "#rotate"; }));
  await page.setInputFiles('#merge input[type=file]', [TEST_PDF]);
  await page.waitForTimeout(400);
  check("choosing a file marks the strip as filled and names it", await page.evaluate(() => { const c = document.getElementById("merge"); return c.querySelector(".picked").textContent.trim().length > 0 && getComputedStyle(c.querySelector(".dropzone")).borderTopStyle === "solid"; }));
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto(BASE + "/tools", { waitUntil: "load" });
  check("phone: one card across", await page.evaluate(() => getComputedStyle(document.querySelector(".tcards")).gridTemplateColumns.split(" ").length === 1));
  check("phone: the page is no longer than it needs to be (nine compact cards)", await page.evaluate(() => document.documentElement.scrollHeight < 6200), String(await page.evaluate(() => document.documentElement.scrollHeight)));
  await ctx.close();
}

await browser.close();
console.log(`\n=== summary ===\n  passed: ${passed.length}\n  failed: ${failed.length}`);
for (const f of failed) console.log("    - " + f);
process.exit(failed.length ? 1 : 0);
