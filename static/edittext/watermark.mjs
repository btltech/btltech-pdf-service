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
 * The mark is drawn at an angle across the middle of the page in a grey that
 * stays legible on white and on a dark table fill alike, and large enough that
 * cropping it off would take the page with it.
 */
export function stamp(doc, text = "PREVIEW — BTLTech") {
  const pages = P.FPDF_GetPageCount(doc);
  for (let i = 0; i < pages; i++) {
    const page = P.FPDF_LoadPage(doc, i);
    if (!page) continue;
    const w = P.FPDF_GetPageWidthF(page), h = P.FPDF_GetPageHeightF(page);
    const font = P.FPDFText_LoadStandardFont(doc, "Helvetica-Bold");
    if (!font) { P.FPDF_ClosePage(page); continue; }

    // Size it by measuring the text rather than guessing from its length: a
    // guess put the end of the mark off the edge of the page, where cropping
    // would remove it and a narrow page would lose half the word.
    const diagonal = Math.hypot(w, h);
    const target = diagonal * 0.78;
    const atOne = E.measure(font, 1, 1, text) || text.length * 0.55;
    const size = Math.max(12, target / atOne);

    const obj = P.FPDFPageObj_CreateTextObj(doc, font, size);
    if (!obj) { P.FPDF_ClosePage(page); continue; }
    P.FPDFText_SetText(obj, utf16(text));
    P.FPDFPageObj_SetFillColor(obj, 130, 130, 140, 70);      // grey, mostly transparent

    // centred on the page, running corner to corner
    const angle = Math.atan2(h, w);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const runWidth = atOne * size;
    const x = w / 2 - (runWidth / 2) * cos;
    const y = h / 2 - (runWidth / 2) * sin;
    setMatrix(obj, [cos, sin, -sin, cos, x, y]);

    P.FPDFPage_InsertObject(page, obj);
    P.FPDFPage_GenerateContent(page);
    P.FPDF_ClosePage(page);
  }
}
