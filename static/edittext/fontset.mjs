// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// Which font files an edit might need.
//
// The engine picks a substitute font synchronously, by measuring several
// candidates. A browser cannot fetch synchronously, so the candidates have to be
// in memory first. This works out the same shortlist the engine will consider -
// from the engine's own table, not a copy of it - so the browser fetches a few
// hundred kilobytes rather than all 11 MB of the font set.
import { oflFamilyFor, OFL, CLASS } from "./engine.mjs";
export { ensureFonts } from "./assets.mjs";

export function fontFilesFor(fontName, flags) {
  const direct = oflFamilyFor(fontName, flags);
  const cls = direct.fam === "mono" ? "mono" : ["serif", "caladea", "gelasio"].includes(direct.fam) ? "serif" : "sans";
  const files = new Set();
  const add = (fam, style) => { const f = OFL[fam] && OFL[fam][style]; if (f) files.add(f); };
  add(direct.fam, direct.style);
  for (const fam of CLASS[cls]) {
    add(fam, direct.style);
    if (fam === "inter" && direct.style === "r") add(fam, "l");   // the engine's Light case
  }
  return [...files];
}
