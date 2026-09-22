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
};

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
  state.pageIndex = 0;
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
  const avail = $("pagewrap").clientWidth || 0;
  const fit = avail > 320 ? Math.min(avail, 900) : 760;
  state.scale = Math.max(0.6, Math.min(2, fit / state.model.w));
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
  $("save").disabled = true;
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
    await W.prepareFonts(run, newText);
    const res = await W.editRun({ bytes: state.bytes, pageIndex: state.pageIndex, runIndex: state.selected, newText });
    state.result = res;

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
    $("save").disabled = false;
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

function save() {
  if (!state.preview) return;
  const blob = new Blob([state.preview], { type: "application/pdf" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.name.replace(/\.pdf$/i, "") + "-edited.pdf";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  say("Saved to your downloads. The document never left this tab.", "ok");
}

// --------------------------------------------------------------------- wire ---
$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
const dz = $("dropzone");
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("over"); });
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("over"); loadFile(e.dataTransfer.files[0]); });
$("overlay").addEventListener("click", pick);
$("preview").addEventListener("click", preview);
$("save").addEventListener("click", save);
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
  get lastSaved() { return state.result ? { action: state.result.action, outcome: state.result.outcome, integrity: state.result.integrity, newText: state.result.newText } : null; },
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
