// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// The watermark that makes a preview a preview.
//
// A customer can make as many edits as they like and see exactly how the
// finished document looks before paying anything. What they cannot do is take
// it away: until the export is paid for, every page carries a mark across it.
//
// The important part is WHEN this runs. It is applied to the document before it
// is saved, so the clean bytes are never produced at all while the export is
// locked - rather than being made and then hidden behind a disabled button,
// which would put the finished file in the page's memory for anyone who looked.
// Paying replays the edits and saves once, without this step.
//
// This is not a lock on a file, and it is not pretending to be: the editor runs
// on the customer's own machine and its source is published, so someone
// determined can always run it themselves. It is the difference between a sign
// and an open door, which for an honest customer is the whole difference.
import * as E from "./engine.mjs";

const P = E.P, M = P.pdfium;
const malloc = (n) => M.wasmExports.malloc(n), free = (p) => M.wasmExports.free(p);

function utf16(s) {
  const p = malloc((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) M.setValue(p + i * 2, s.charCodeAt(i), "i16");
  M.setValue(p + s.length * 2, 0, "i16");
  return p;
}

function setMatrix(obj, m) {
  const p = malloc(24);
  m.forEach((v, i) => M.setValue(p + i * 4, v, "float"));
  P.FPDFPageObj_SetMatrix(obj, p);
  free(p);
}

/**
 * Stamp every page of an open document.
 *
 * The mark repeats diagonally across the whole page rather than sitting once in
 * the middle. One mark leaves most of the page clean and a preview that is
 * perfectly usable as a document, which defeats the purpose; a repeating one
 * makes the file unsuitable for sending to anyone while still leaving every
 * edit clearly readable underneath, which is what the customer is here to
 * check.
 */
export function stamp(doc, text = "BTLTECH PREVIEW \u2014 UNPAID") {
  const pages = P.FPDF_GetPageCount(doc);
  for (let i = 0; i < pages; i++) {
    const page = P.FPDF_LoadPage(doc, i);
    if (!page) continue;
    const w = P.FPDF_GetPageWidthF(page), h = P.FPDF_GetPageHeightF(page);
    const font = P.FPDFText_LoadStandardFont(doc, "Helvetica-Bold");
    if (!font) { P.FPDF_ClosePage(page); continue; }

    // Measured, not guessed: a guess from the character count put the end of
    // the mark off the page. Roughly half the page width per instance leaves
    // room for two across and several down.
    const atOne = E.measure(font, 1, 1, text) || text.length * 0.55;
    const size = Math.max(9, (w * 0.52) / atOne);
    const runWidth = atOne * size;

    const angle = Math.PI / 6;                       // 30 degrees, an easy read
    const cos = Math.cos(angle), sin = Math.sin(angle);

    // A lattice of marks. Each row is shifted sideways against the rise of the
    // rotated text, so the rows stay evenly spaced down the page instead of
    // drifting into bands with clean gaps between them.
    const stepAcross = runWidth * 1.15;
    const stepDown = size * 3.4;
    const rows = Math.ceil((h + runWidth * sin) / stepDown) + 2;
    const cols = Math.ceil((w + runWidth) / stepAcross) + 2;
    for (let r = -1; r < rows; r++) {
      for (let c = -1; c < cols; c++) {
        const obj = P.FPDFPageObj_CreateTextObj(doc, font, size);
        if (!obj) continue;
        P.FPDFText_SetText(obj, utf16(text));
        P.FPDFPageObj_SetFillColor(obj, 120, 124, 136, 52);   // grey, faint
        const x = -runWidth * 0.6 + c * stepAcross + (r % 2) * stepAcross * 0.5;
        const y = h - r * stepDown - c * stepAcross * sin;
        setMatrix(obj, [cos, sin, -sin, cos, x, y]);
        P.FPDFPage_InsertObject(page, obj);
      }
    }
    P.FPDFPage_GenerateContent(page);
    P.FPDF_ClosePage(page);
  }
}
