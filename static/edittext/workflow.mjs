// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// Edit Existing Text V1 - the decision pipeline.
//
// Every gate between "the customer typed something" and "here is a file to
// download" lives here, in one place, so that the browser and the regression
// harness cannot drift apart: the harness exercises this exact module, so a pass
// there is a statement about what the customer's browser will actually do.
//
// The order of the gates is the order they were established in testing, and it is
// deliberate - each one only makes sense once the ones before it have passed:
//
//   1. can the file be opened at all                     -> REFUSED
//   2. is it a scanned page (with or without an OCR layer) -> UNSUPPORTED
//   3. is the text in a script this cannot re-set (CJK/RTL) -> UNSUPPORTED
//   4. is the line spaced out inside one text object      -> UNSUPPORTED
//   5. is the line justified                              -> UNSUPPORTED
//   6. does a font exist with every character needed      -> UNSUPPORTED
//   7. does it fit (FIT / SHIFT_LINE / SHRINK / WRAP)     -> or BLOCKED
//   8. does the result overprint text or existing ink,
//      leave the page, or fail to draw its glyphs         -> BLOCKED
//   9. is the saved file structurally sound               -> BLOCKED
//
// Nothing is ever saved quietly: if a gate fails there is no file, and the reason
// is in plain words for the customer.
import * as E from "./engine.mjs";
import { checkSaved } from "./integrity.mjs";
import { ensureFonts, fontFilesFor } from "./fontset.mjs";
import { stamp } from "./watermark.mjs";

const P = E.P;

/** Open the document and describe what can be done with it. */
export function openAndAnalyse(bytes, pageIndex = 0) {
  const opened = E.openDoc(bytes);
  if (opened.refused) return { refused: opened.refused };
  const model = E.analysePage(opened.doc, pageIndex);
  const out = { doc: opened.doc, model, signatures: opened.signatures, runs: E.styleRuns(model.items), pageKind: model.pageKind };
  if (opened.signatures > 0) {
    out.warning = `This PDF carries ${opened.signatures} digital signature${opened.signatures > 1 ? "s" : ""}. Any edit will invalidate ${opened.signatures > 1 ? "them" : "it"}.`;
  }
  if (model.pageKind === "scanned-image-only") out.unsupported = "This page is a scan - a picture of a document, with no text to edit. Reading text out of a picture is not something this tool does.";
  if (model.pageKind === "scanned-with-invisible-ocr") out.unsupported = "This page is a scan with an invisible searchable-text layer behind it. Changing that layer would not change anything you can see.";
  return out;
}

/** Find the run holding a piece of text (the regression harness selects this way). */
export function findRun(runs, needle) {
  return runs.findIndex((r) => r.text.includes(needle));
}

const notEditable = (reason) => ({ outcome: "UNSUPPORTED", reason });
const blocked = (reason, extra = {}) => ({ outcome: "BLOCKED", reason, ...extra });

/**
 * Work out which font can carry the new text, loading only what is needed.
 * Must be awaited before editRun, because the browser cannot fetch a font
 * synchronously and the engine's font paths are synchronous.
 */
export async function prepareFonts(run, newText) {
  const first = run.objs[0];
  await ensureFonts(fontFilesFor(first.fontName, first.flags));
}

/**
 * Apply one edit and, if every gate passes, return the bytes to download.
 *
 * `bytes` is the ORIGINAL file every time: each attempt starts from it, so a
 * rejected plan can never leave a half-applied edit behind.
 */
export async function editRun({ bytes, pageIndex = 0, runIndex, newText, watermark = false }) {
  const r = {};
  const fresh = () => {
    const o = E.openDoc(bytes);
    const m = E.analysePage(o.doc, pageIndex);
    return { doc: o.doc, model: m, run: E.styleRuns(m.items)[runIndex] };
  };
  const start = fresh();
  if (!start.run) return { outcome: "NOT FOUND", reason: "that text is no longer where it was - reopen the document" };
  const { doc, model, run } = start;

  // ---- gates that depend only on what is already on the page -----------------
  const spacing = E.usesInternalSpacing(model, run);
  if (spacing) return notEditable(`This line is spaced out inside a single piece of text (a ${spacing.gap}pt gap in ${spacing.em}pt text, around ${JSON.stringify(spacing.around)}). Re-setting it would collapse that spacing.`);
  const justified = E.isJustifiedLine(model, run);
  if (justified) {
    // Say which evidence found it. A line detected by the shape of its block is
    // often barely stretched at all, so quoting a "1% wider" gap figure there
    // would read as nonsense and undersell a real reason to refuse.
    return notEditable(justified.flushRight
      ? "This line is part of a justified paragraph - every line but the last reaches the right margin exactly. Re-setting it would leave it short of the margin and the paragraph would no longer line up."
      : `This line is justified - its word gaps are ${justified.extraPercent}% wider than normal (${justified.wordGap}pt against ${justified.normalGap}pt). Re-setting it would lose the stretched spacing.`);
  }
  const sp = E.scriptProblem(run.text) || E.scriptProblem(newText);
  if (sp) return notEditable(`This tool cannot re-set ${sp}.`);

  const first = run.objs[0];
  r.original = { font: E.clean(first.fontName), objects: run.objs.length, text: run.text };

  // ---- the font: the original only if it truly has every glyph --------------
  const missing = E.missingGlyphs(first.font, newText);
  r.missingInOriginal = missing;
  let fontObj;
  if (!missing.length) fontObj = { font: first.font, name: E.clean(first.fontName) + " (original)" };
  else {
    const sub = E.chooseSubstitute(doc, run, newText);
    if (!sub) return notEditable(`No available font has ${missing.map((c) => JSON.stringify(c)).join(", ")}.`);
    fontObj = { ...sub, name: sub.name + ` (substitute: ${sub.why})` };
  }
  r.font = fontObj.name;

  // ---- the fit ladder -------------------------------------------------------
  let plan = E.planEdit(model, run, newText, fontObj.font);
  plan.align = E.alignmentOf(model, run);
  plan.decorations = E.decorationsFor(model, run);
  if (plan.decorations.length) r.decorations = plan.decorations.map((d) => d.kind);
  if (plan.align.how !== "left") r.alignment = plan.align.how;
  if (fontObj.fam) {
    const drawn = plan.lines ? plan.lines.join(" ") : newText;
    const sub = E.loadOflSubset(doc, fontObj.fam, fontObj.style, drawn);
    if (sub) { r.fontEmbedded = `subset ${(sub.bytes / 1024).toFixed(1)} KB of ${(sub.fullBytes / 1024).toFixed(0)} KB`; fontObj = { ...fontObj, font: sub.font }; }
    else { const full = E.loadOfl(doc, fontObj.fam, fontObj.style); fontObj = { ...fontObj, font: full.font }; r.fontEmbedded = `full font ${(full.bytes / 1024).toFixed(0)} KB (subsetting unavailable)`; }
  }
  r.fit = plan.report; r.action = plan.kind;
  if (plan.kind === "NEEDS_USER") {
    r.autoSaved = false;
    if (!plan.report.moveAllowed) return blocked("It does not fit, and it cannot be moved without pushing the text around it out of place. Please shorten it.", r);
    const spot = E.findFreeSpot(model, run, newText, fontObj.font);
    if (!spot) return blocked("It does not fit, and there is no free space on the page to move it to. Please shorten it.", r);
    plan = spot; r.userAction = `moved to free space at y=${spot.box.y.toFixed(0)}, wrapped to ${spot.lines.length} line(s)`;
  }

  // ---- apply, then check what was actually produced -------------------------
  let target = doc, check = E.apply(doc, model, run, plan, fontObj, newText);
  r.selfCheck = check;

  if (check.badGlyphs && !fontObj.fam) {
    // The original font accepted the characters but drew nothing: try a substitute.
    const again = fresh();
    const sub0 = again.run && E.chooseSubstitute(again.doc, again.run, newText);
    if (sub0) {
      const emb = E.loadOflSubset(again.doc, sub0.fam, sub0.style, newText) || E.loadOfl(again.doc, sub0.fam, sub0.style);
      const plan0 = E.planEdit(again.model, again.run, newText, emb.font);
      plan0.align = E.alignmentOf(again.model, again.run);
      // No decoration handling on this path, matching FROZEN8 exactly. Carrying an
      // underline through here would be an improvement, but it is a change in
      // behaviour and belongs in its own tested step, not smuggled in with a port.
      if (plan0.kind !== "NEEDS_USER") {
        const chk0 = E.apply(again.doc, again.model, again.run, plan0, { ...sub0, font: emb.font }, newText);
        if (!chk0.badGlyphs && !chk0.overlaps && !chk0.off && !chk0.ink) {
          r.font = sub0.name + " (substitute: the original font would not draw the text)";
          r.action = plan0.kind; r.selfCheck = chk0; target = again.doc; check = chk0;
        } else return blocked(`The font will not draw that text (it came out as ${JSON.stringify(check.written)}).`, r);
      } else return blocked(`The font will not draw that text (it came out as ${JSON.stringify(check.written)}).`, r);
    } else return blocked(`The font will not draw that text (it came out as ${JSON.stringify(check.written)}).`, r);
  } else if (check.badGlyphs) {
    return blocked(`The substitute font will not draw that text (it came out as ${JSON.stringify(check.written)}).`, r);
  } else if (check.overlaps || check.off || check.ink) {
    r.rejectedPlan = plan.kind + (check.ink ? ` (would print over existing content: ${check.inkPixels} px)` : check.overlaps ? " (would print over other text)" : " (would run off the page)");
    if (r.userAction) return blocked("Even moved, it still collides with something. Please shorten it.", r);
    // Start again from the untouched file and try the move-to-free-space route.
    const again = fresh();
    let f2 = fontObj.name.includes("(original)")
      ? { font: again.run.objs[0].font, name: fontObj.name }
      : { ...E.chooseSubstitute(again.doc, again.run, newText), name: fontObj.name };
    if (f2.fam) { const sub2 = E.loadOflSubset(again.doc, f2.fam, f2.style, newText); if (sub2) f2 = { ...f2, font: sub2.font }; }
    const spot = E.findFreeSpot(again.model, again.run, newText, f2.font);
    if (!spot) return blocked("It does not fit, and every automatic option was rejected by the safety check. Please shorten it.", { ...r, autoSaved: false });
    r.userAction = `moved to free space at y=${spot.box.y.toFixed(0)}, wrapped to ${spot.lines.length} line(s)`;
    spot.align = { how: "left" };
    check = E.apply(again.doc, again.model, again.run, spot, f2, newText);
    r.selfCheck = check;
    if (check.badGlyphs) return blocked(`The font will not draw that text (it came out as ${JSON.stringify(check.written)}).`, r);
    if (check.overlaps || check.off || check.ink) return blocked("Even moved, it still collides with something. Please shorten it.", r);
    target = again.doc;
  }

  // ---- the download gate ----------------------------------------------------
  // The mark goes on BEFORE the save, so a locked export never produces a clean
  // file at all. Unlocking replays the edits and saves once without this.
  if (watermark) stamp(target);
  const savedBytes = E.saveDoc(target);
  const origPages = P.FPDF_GetPageCount(doc);
  const res = await checkSaved(bytes, savedBytes, origPages);
  const re = E.openDoc(savedBytes);
  const pdfiumOk = !!re.doc && P.FPDF_GetPageCount(re.doc) === res.pages;
  r.integrity = res.verdict + (pdfiumOk ? "" : " / PDFium could not reopen it");
  if (!res.ok || !pdfiumOk) return blocked("The edited file did not pass its integrity check, so it has not been produced: " + r.integrity, r);

  r.outcome = r.userAction ? "EDITED after customer action" : "EDITED";
  r.newText = newText;
  r.bytes = savedBytes.length;
  r.savedBytes = savedBytes;
  return r;
}

/**
 * Apply a list of edits in order, starting from the original file.
 *
 * Replaying from the original is what lets the clean copy be withheld: the
 * finished document is built once, at the moment it is paid for, rather than
 * being kept in the page while a button stays disabled. Because every replay
 * starts from the same bytes and applies the same edits in the same order, the
 * intermediate documents are identical each time, so the run each edit refers
 * to is still the run it referred to when the customer chose it.
 */
export async function replay({ bytes, edits, watermark = false }) {
  let current = bytes, last = null;
  for (const [i, edit] of edits.entries()) {
    const open = openAndAnalyse(current, edit.pageIndex);
    const run = open.runs && open.runs[edit.runIndex];
    if (!run) return { outcome: "NOT FOUND", reason: `edit ${i + 1} no longer matches the document`, failedAt: i };
    await prepareFonts(run, edit.newText);
    // only the final save carries the mark; the ones in between are working copies
    const isLast = i === edits.length - 1;
    last = await editRun({
      bytes: current, pageIndex: edit.pageIndex, runIndex: edit.runIndex,
      newText: edit.newText, watermark: watermark && isLast,
    });
    if (!last.savedBytes) return { ...last, failedAt: i };
    current = last.savedBytes;
  }
  return last || { outcome: "NOT FOUND", reason: "there were no edits to apply" };
}

/** AcroForm field values are a different thing entirely: set the value, not the page. */
export async function formFieldEdit(bytes, find, newText) {
  const PDFLib = await pdfLib();
  const pdf = await PDFLib.PDFDocument.load(bytes);
  const field = pdf.getForm().getFields().find((f) => f.getText && f.getText() === find);
  if (!field) return { outcome: "NOT FOUND", reason: "no form field holds that text" };
  field.setText(newText);
  return { outcome: "EDITED (form field)", action: "form value", savedBytes: await pdf.save(), newText };
}

async function pdfLib() {
  if (globalThis.PDFLib) return globalThis.PDFLib;
  const { createRequire } = await import("node:module");
  return createRequire(import.meta.url)(new URL("../vendor/pdf-lib.cjs", import.meta.url).pathname);
}
