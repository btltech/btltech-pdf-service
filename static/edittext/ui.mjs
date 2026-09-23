// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// Edit Existing Text V1 - the page.
//
// This file is only the screen: what the customer sees, clicks and reads. Every
// decision about whether an edit is safe belongs to workflow.mjs, so that the
// regression suite - which drives that module directly - is testing the same
// judgement the customer gets. Nothing here uploads anything: the file is read
// through a file input and stays in this tab's memory.
import * as E from "./engine.mjs";
import * as W from "./workflow.mjs";

const $ = (id) => document.getElementById(id);
const P = E.P, M = P.pdfium;

const state = {
  bytes: null, name: "", doc: null, model: null, runs: [], boxes: [],
  pageIndex: 0, pageCount: 0, selected: -1, scale: 1,
  preview: null, previewDoc: null, result: null,
  // Edits are kept as a list and replayed from the original file. That is what
  // lets the clean copy be withheld until it is paid for: the finished document
  // is built at the moment of payment, not kept in this tab behind a button.
  edits: [], working: null, docHash: "", locked: false, price: "", currency: "",
};

const TOKEN_KEY = "btltech-pdf-credits";
const token = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } };
const keepToken = (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch (e) {} };

/** A fingerprint of the file, worked out here. The file itself is never sent. */
async function hashOf(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function refreshLock() {
  if (!state.docHash) return;
  try {
    const headers = token() ? { "X-PDF-Token": token() } : {};
    const r = await fetch(`/api/export/status?doc=${encodeURIComponent(state.docHash)}`, { headers });
    const d = await r.json();
    state.locked = d.billing === true && d.unlocked !== true;
    state.price = d.price || ""; state.currency = d.currency || "";
  } catch (e) {
    state.locked = false;            // if the question cannot be asked, do not charge
  }
}

// --------------------------------------------------------------- rendering ---
function renderPageTo(page, canvas, wPt, hPt, scale) {
  const w = Math.max(1, Math.ceil(wPt * scale)), h = Math.max(1, Math.ceil(hPt * scale));
  const bmp = P.FPDFBitmap_Create(w, h, 0);
  P.FPDFBitmap_FillRect(bmp, 0, 0, w, h, 0xffffffff);
  P.FPDF_RenderPageBitmap(bmp, page, 0, 0, w, h, 0, 0);
  const buf = P.FPDFBitmap_GetBuffer(bmp), stride = P.FPDFBitmap_GetStride(bmp);
  const img = new ImageData(w, h);
  for (let y = 0; y < h; y++) {
    let src = buf + y * stride, dst = (y * w) * 4;
    for (let x = 0; x < w; x++, src += 4, dst += 4) {
      img.data[dst] = M.HEAPU8[src + 2];        // PDFium writes BGRA
      img.data[dst + 1] = M.HEAPU8[src + 1];
      img.data[dst + 2] = M.HEAPU8[src];
      img.data[dst + 3] = 255;
    }
  }
  P.FPDFBitmap_Destroy(bmp);
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").putImageData(img, 0, 0);
  return { w, h };
}

/** A run's box in canvas pixels. FPDF_PageToDevice handles any page rotation. */
function deviceBoxOf(page, run, w, h) {
  const malloc = (n) => M.wasmExports.malloc(n), free = (p) => M.wasmExports.free(p);
  const px = malloc(4), py = malloc(4);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of run.objs) {
    for (const [x, y] of o.quad) {
      P.FPDF_PageToDevice(page, 0, 0, w, h, 0, x, y, px, py);
      const dx = M.getValue(px, "i32"), dy = M.getValue(py, "i32");
      x0 = Math.min(x0, dx); y0 = Math.min(y0, dy); x1 = Math.max(x1, dx); y1 = Math.max(y1, dy);
    }
  }
  free(px); free(py);
  return [x0, y0, x1, y1];
}

function drawOverlay() {
  const c = $("overlay"), ctx = c.getContext("2d");
  ctx.clearRect(0, 0, c.width, c.height);
  state.boxes.forEach((b, i) => {
    if (b.blank) return;
    const [x0, y0, x1, y1] = b.box;
    ctx.fillStyle = i === state.selected ? "rgba(91,140,255,.30)" : "rgba(91,140,255,.09)";
    ctx.fillRect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
    ctx.strokeStyle = i === state.selected ? "#5b8cff" : "rgba(91,140,255,.35)";
    ctx.lineWidth = i === state.selected ? 2 : 1;
    ctx.strokeRect(x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
  });
}

// ------------------------------------------------------------------ status ---
function say(html, kind = "") {
  const el = $("status");
  el.className = "note " + kind;
  el.innerHTML = html;
  el.hidden = false;
}
const hideStatus = () => { $("status").hidden = true; };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ------------------------------------------------------------ loading a PDF ---
async function loadFile(file) {
  if (!file) return;
  if (!/\.pdf$/i.test(file.name)) { say("That is not a PDF.", "bad"); return; }
  state.name = file.name;
  state.bytes = new Uint8Array(await file.arrayBuffer());
  state.edits = []; state.working = null;
  state.pageIndex = 0;
  state.docHash = await hashOf(state.bytes);
  await refreshLock();
  closeDocs();
  say("Reading the document…");
  const probe = E.openDoc(state.bytes);
  if (probe.refused) { say(`This PDF cannot be opened: ${esc(probe.refused)}`, "bad"); return; }
  state.pageCount = P.FPDF_GetPageCount(probe.doc);
  P.FPDF_CloseDocument(probe.doc);
  $("filename").textContent = `${file.name} — ${state.pageCount} page${state.pageCount > 1 ? "s" : ""}`;
  $("stage").hidden = false;
  $("dropzone").classList.add("small");
  await showPage(0);
}

function closeDocs() {
  if (state.doc) { try { P.FPDF_CloseDocument(state.doc); } catch { /* already gone */ } state.doc = null; }
  if (state.previewDoc) { try { P.FPDF_CloseDocument(state.previewDoc); } catch { /* already gone */ } state.previewDoc = null; }
}

/**
 * Size and draw the page, and work out where every run sits on it.
 *
 * Kept separate from showPage so the view can be rebuilt when the window is
 * resized without losing the customer's selection - and so that a container that
 * measures implausibly small (a hidden tab, a pane not yet laid out) falls back to
 * a readable width instead of rendering a postage stamp nobody can click.
 */
function layout() {
  if (!state.model) return;
  // Only a measurement of nothing is treated as broken. 320 was too generous:
  // a real phone is narrower than that, and was being shown a 760px-wide page
  // squashed into a 309px column - the document came out visibly distorted.
  const avail = $("pagewrap").clientWidth || 0;
  const fit = avail > 80 ? Math.min(avail, 900) : 760;
  // The page is fitted to the space it has. Drawing it larger and letting the
  // frame scroll was tried and made things worse: a canvas wider than the phone
  // made the browser zoom the whole page out to fit, which shrank the text more
  // than fitting it ever did. On a small screen the text ends up small, and
  // pinch-zoom is the answer, exactly as it is in any PDF reader.
  state.scale = Math.max(0.4, Math.min(2.5, fit / state.model.w));
  const dim = renderPageTo(state.model.page, $("page"), state.model.w, state.model.h, state.scale);
  const ov = $("overlay");
  ov.width = dim.w; ov.height = dim.h;
  ov.style.width = $("page").style.width = dim.w + "px";
  ov.style.height = $("page").style.height = dim.h + "px";
  state.boxes = state.runs.map((run) => ({
    box: deviceBoxOf(state.model.page, run, dim.w, dim.h),
    blank: !run.text.trim(),
  }));
  drawOverlay();
  if (state.previewDoc && !$("previewwrap").hidden) {
    const page = P.FPDF_LoadPage(state.previewDoc, state.pageIndex);
    renderPageTo(page, $("previewcanvas"), state.model.w, state.model.h, state.scale);
  }
}

async function showPage(index) {
  state.pageIndex = index;
  state.selected = -1;
  state.result = null;
  clearPreview();
  if (state.doc) { P.FPDF_CloseDocument(state.doc); state.doc = null; }

  const open = W.openAndAnalyse(state.bytes, index);
  if (open.refused) { say(`This PDF cannot be opened: ${esc(open.refused)}`, "bad"); return; }
  state.doc = open.doc; state.model = open.model; state.runs = open.runs;

  layout();

  $("pagelabel").textContent = `Page ${index + 1} of ${state.pageCount}`;
  $("prev").disabled = index === 0;
  $("next").disabled = index >= state.pageCount - 1;

  const messages = [];
  if (open.warning) messages.push(`<strong>${esc(open.warning)}</strong>`);
  if (open.unsupported) messages.push(esc(open.unsupported));
  if (!open.unsupported && !state.boxes.some((b) => !b.blank)) messages.push("There is no editable text on this page.");
  if (open.model.nested.length) messages.push("Some text on this page is inside a nested graphic and cannot be edited; it is not highlighted.");
  if (messages.length) say(messages.join("<br>"), open.unsupported ? "bad" : "warn"); else hideStatus();
  $("editor").hidden = true;
  $("pickhint").hidden = false;
  renderActions();
}

// --------------------------------------------------------------- selection ---
function pick(ev) {
  const rect = $("overlay").getBoundingClientRect();
  const x = (ev.clientX - rect.left) * ($("overlay").width / rect.width);
  const y = (ev.clientY - rect.top) * ($("overlay").height / rect.height);
  let best = -1, bestArea = Infinity;
  state.boxes.forEach((b, i) => {
    if (b.blank) return;
    const [x0, y0, x1, y1] = b.box;
    if (x < x0 - 2 || x > x1 + 2 || y < y0 - 2 || y > y1 + 2) return;
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea) { best = i; bestArea = area; }
  });
  if (best < 0) return;
  state.selected = best;
  drawOverlay();
  const run = state.runs[best];
  $("editor").hidden = false;
  $("pickhint").hidden = true;
  $("original").textContent = run.text;
  $("newtext").value = run.text;
  $("newtext").focus();
  clearPreview();
  hideStatus();
}

function clearPreview() {
  state.preview = null;
  if (state.previewDoc) { try { P.FPDF_CloseDocument(state.previewDoc); } catch { /* gone */ } state.previewDoc = null; }
  $("previewwrap").hidden = true;
  $("aftercap").hidden = true;
  $("keep").disabled = true;
  $("details").hidden = true;
}

// ----------------------------------------------------------------- editing ---
async function preview() {
  if (state.selected < 0) return;
  const run = state.runs[state.selected];
  const newText = $("newtext").value;
  if (newText === run.text) { say("The text has not been changed.", "warn"); return; }
  if (!newText.trim()) { say("The replacement cannot be empty. To remove text, use the page tools.", "warn"); return; }

  $("preview").disabled = true;
  say("Working out whether that fits and whether it is safe to save…");
  try {
    const pending = state.edits.concat([{ pageIndex: state.pageIndex, runIndex: state.selected, newText }]);
    const res = await W.replay({ bytes: state.bytes, edits: pending, watermark: state.locked });
    state.result = res;
    if (res.savedBytes) state.pending = pending;

    if (!res.savedBytes) {
      const label = res.outcome === "UNSUPPORTED" ? "This cannot be edited" : "This change was not made";
      say(`<strong>${label}.</strong><br>${esc(res.reason || "no reason given")}`, "bad");
      clearPreview();
      return;
    }

    state.preview = res.savedBytes;
    const opened = E.openDoc(res.savedBytes);
    state.previewDoc = opened.doc;
    const page = P.FPDF_LoadPage(opened.doc, state.pageIndex);
    const wPt = state.model.w, hPt = state.model.h;
    renderPageTo(page, $("previewcanvas"), wPt, hPt, state.scale);
    $("previewwrap").hidden = false;
    $("aftercap").hidden = false;
    $("keep").disabled = false;
    renderActions();
    showDetails(res);
    say("Checked and ready. Look at the preview, then save it.", "ok");
  } catch (err) {
    say(`Something went wrong while editing: ${esc(err.message)}`, "bad");
    clearPreview();
  } finally {
    $("preview").disabled = false;
  }
}

const HOW = {
  FIT: "replaced in place",
  SHIFT_LINE: "replaced, and the rest of the line moved along to make room",
  SHRINK: "replaced, very slightly narrower to fit the space",
  WRAP: "replaced and wrapped onto another line",
  USER_BOX: "moved to free space on the page",
};

function showDetails(res) {
  const rows = [];
  rows.push(["How it fits", HOW[res.action] || res.action]);
  if (res.userAction) rows.push(["Moved", res.userAction]);
  rows.push(["Font", res.font]);
  if (res.fontEmbedded) rows.push(["Embedded", res.fontEmbedded]);
  if (res.decorations) rows.push(["Kept", res.decorations.join(", ")]);
  if (res.alignment) rows.push(["Alignment", `kept ${res.alignment}`]);
  rows.push(["Integrity check", res.integrity]);
  rows.push(["Size", `${(res.bytes / 1024).toFixed(0)} KB`]);
  $("details").innerHTML = "<h3>What was done</h3>" + rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("");
  $("details").hidden = false;
}

/** Keep this change and carry on editing the same document. */
async function keepEdit() {
  if (!state.pending) return;
  state.edits = state.pending;
  state.pending = null;
  state.working = state.preview;
  say(`${state.edits.length} change${state.edits.length === 1 ? "" : "s"} so far. Keep editing, or save when you are done.`, "ok");
  clearPreview();
  await showPage(state.pageIndex);
}

/**
 * Pay for a clean copy of this document, then build it.
 *
 * The clean file is made here, after the server has confirmed the payment -
 * not unhidden. Until this runs, no un-watermarked version of the document has
 * existed in this tab at all.
 */
async function unlockAndSave(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Opening PayPal…";
  try {
    const started = await fetch("/api/pay/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ product: "export", doc: state.docHash }),
    });
    const order = await started.json();
    if (!started.ok) throw new Error(order.detail || "Could not start the payment");
    const win = window.open(order.approve_url, "paypal", "width=500,height=700");
    if (!win) throw new Error("Allow pop-ups to pay, then try again");
    await new Promise((done) => {
      const poll = setInterval(() => { if (win.closed) { clearInterval(poll); done(); } }, 800);
    });
    button.textContent = "Checking the payment…";
    const headers = { "Content-Type": "application/json" };
    if (token()) headers["X-PDF-Token"] = token();
    const captured = await fetch("/api/pay/capture", {
      method: "POST", headers,
      body: JSON.stringify({ product: "export", doc: state.docHash, order_id: order.order_id }),
    });
    const result = await captured.json();
    if (!captured.ok) throw new Error(result.detail || "That payment did not complete");
    keepToken(result.token);
    await refreshLock();
    button.textContent = "Preparing your file…";
    const clean = await W.replay({ bytes: state.bytes, edits: state.edits, watermark: false });
    if (!clean.savedBytes) throw new Error(clean.reason || "The document could not be produced");
    state.preview = clean.savedBytes;
    download(clean.savedBytes);
    say("Thank you — your document has been saved without the preview mark.", "ok");
  } catch (err) {
    say(`${err.message}. If you were charged, nothing has been lost: reopen the document and the export will already be paid for.`, "bad");
  } finally {
    button.disabled = false;
    button.textContent = original;
    renderActions();
  }
}

function download(bytes) {
  const blob = new Blob([bytes], { type: "application/pdf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.name.replace(/\.pdf$/i, "") + "-edited.pdf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function save() {
  if (!state.preview) return;
  download(state.preview);
  say("Saved to your downloads. The document never left this tab.", "ok");
}

/** Show the right buttons for where the customer is: keep editing, or take it away. */
function renderActions() {
  const box = $("exportbox");
  if (!box) return;
  const edits = state.edits.length + (state.pending ? 1 : 0);
  if (!edits) { box.hidden = true; return; }
  box.hidden = false;
  if (!state.locked) {
    box.innerHTML = `<button id="saveclean">Save the PDF</button>`;
    $("saveclean").addEventListener("click", () => {
      if (state.pending) { state.edits = state.pending; state.pending = null; }
      W.replay({ bytes: state.bytes, edits: state.edits, watermark: false }).then((r) => {
        if (r.savedBytes) { download(r.savedBytes); say("Saved to your downloads. The document never left this tab.", "ok"); }
      });
    });
    return;
  }
  box.innerHTML =
    `<p class="hint">Your changes are shown with a preview mark across the page. ` +
    `Saving the clean copy of this document costs ${esc(state.currency === "GBP" ? "£" : "")}${esc(state.price)}, ` +
    `once — you can keep editing it as much as you like first.</p>` +
    `<div class="btnrow"><button id="buyexport">Save clean copy &mdash; ` +
    `${esc(state.currency === "GBP" ? "£" : "")}${esc(state.price)}</button></div>`;
  $("buyexport").addEventListener("click", (e) => unlockAndSave(e.target));
}

// --------------------------------------------------------------------- wire ---
$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
// Dragging is not the only way people open a file, and on a phone it is not a
// way at all: the drop area is also a button, and reachable from the keyboard.
const dz = $("dropzone");
dz.addEventListener("click", () => $("file").click());
dz.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("file").click(); }
});
for (const ev of ["dragenter", "dragover"]) {
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); });
}
for (const ev of ["dragleave", "drop"]) {
  dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); });
}
dz.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));
$("overlay").addEventListener("click", pick);
$("preview").addEventListener("click", preview);
$("keep").addEventListener("click", keepEdit);
$("cancel").addEventListener("click", () => { state.selected = -1; $("editor").hidden = true; $("pickhint").hidden = false; clearPreview(); drawOverlay(); hideStatus(); });
$("prev").addEventListener("click", () => showPage(state.pageIndex - 1));
$("next").addEventListener("click", () => showPage(state.pageIndex + 1));
$("newtext").addEventListener("input", () => { clearPreview(); });
let resizeTimer = null;
window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(layout, 150); });
window.addEventListener("beforeunload", closeDocs);

// A small, deliberate hook for scripts/browser_edittext_test.mjs. It exposes what
// is on screen and lets the suite choose a line without guessing pixel positions;
// it adds no capability the page does not already have through clicking.
window.__edittext = {
  get runs() { return state.runs.map((r) => ({ text: r.text })); },
  get boxes() { return state.boxes; },
  get edits() { return state.edits.length; },
  get locked() { return state.locked; },
  get docHash() { return state.docHash; },
  keepEdit() { return keepEdit(); },
  get lastSaved() {
    // after an edit is kept, state.result is cleared; the edit itself is what
    // was saved, so report that
    const last = state.edits[state.edits.length - 1];
    if (state.result) return { action: state.result.action, outcome: state.result.outcome, integrity: state.result.integrity, newText: state.result.newText };
    return last ? { action: "kept", outcome: "EDITED", newText: last.newText } : null;
  },
  selectRun(i) {
    if (i < 0 || i >= state.runs.length) throw new Error("no such run: " + i);
    state.selected = i;
    drawOverlay();
    const run = state.runs[i];
    $("editor").hidden = false;
    $("pickhint").hidden = true;
    $("original").textContent = run.text;
    $("newtext").value = run.text;
    clearPreview();
    hideStatus();
  },
};

$("loading").hidden = true;
$("dropzone").hidden = false;
document.body.dataset.ready = "1";     // the browser test waits for this
