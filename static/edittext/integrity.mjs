// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
// The download gate: a saved file is only offered once this says it is sound.
// Fix 2: check a saved file before it is offered for download.
// Every indirect reference must resolve. A reference to an object that was
// already null/absent in the original is legal per the PDF spec (treated as
// null) and only noted; a reference to an object that had content in the
// original but is missing now is a real loss and blocks the download.
// pdf-lib is a second, independent reader: PDFium wrote the file, so PDFium is
// not the right thing to ask whether it is sound. Under Node it is required from
// the vendored CommonJS build; in the browser the page loads it as a script first.
import { isNode } from "./assets.mjs";
let PDFLib;
if (isNode) {
  const { createRequire } = await import("node:module");
  PDFLib = createRequire(import.meta.url)(new URL("../vendor/pdf-lib.cjs", import.meta.url).pathname);
} else {
  PDFLib = globalThis.PDFLib;
  if (!PDFLib) throw new Error("pdf-lib must be loaded before the integrity check");
}
const { PDFDocument, PDFRef, PDFDict, PDFArray, PDFNull } = PDFLib;

async function scan(bytes) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const ctx = pdf.context, dangling = new Map();
  const visit = (o, depth = 0) => {
    if (!o || depth > 50) return;
    if (o instanceof PDFRef) { if (ctx.lookup(o) === undefined) dangling.set(`${o.objectNumber} ${o.generationNumber}`, o); return; }
    if (o instanceof PDFDict) { for (const [, v] of o.entries()) visit(v, depth + 1); return; }
    if (o instanceof PDFArray) { for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1); return; }
    if (o.dict instanceof PDFDict) visit(o.dict, depth + 1);
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) visit(obj);
  visit(ctx.trailerInfo.Root); visit(ctx.trailerInfo.Info);
  return { ctx, dangling, pages: pdf.getPageCount() };
}

export async function checkSaved(originalBytes, savedBytes, originalPages = null) {
  let saved, orig;
  try { saved = await scan(savedBytes); } catch (e) { return { ok: false, verdict: `saved file cannot be parsed (${e.message.slice(0, 80)})` }; }
  // The original is only needed to excuse a dangling reference in the saved file.
  // With none to excuse, a clean saved file is clean whatever the original was -
  // which matters because this parser cannot decrypt, and an encrypted original
  // keeps its objects in encrypted object streams. The page count still has to be
  // checked, so it comes from the caller's engine, which can decrypt.
  if (!saved.dangling.size && originalPages !== null) {
    const ok = saved.pages === originalPages;
    return { ok, verdict: ok ? "ok" : `page count changed ${originalPages} -> ${saved.pages}`, benign: [], lost: [], pages: saved.pages };
  }
  try { orig = await scan(originalBytes); }
  catch (e) {
    // The saved file has unresolved references and the original cannot be read to
    // say whether they were already there. Unprovable means not allowed.
    return { ok: false, verdict: `${saved.dangling.size} unresolved reference(s) in the saved file and the original could not be parsed to check whether they were already there (${e.message.slice(0, 60)})`, benign: [], lost: [...saved.dangling.keys()], pages: saved.pages, partial: true };
  }
  const benign = [], lost = [];
  for (const [key, ref] of saved.dangling) {
    const before = orig.ctx.lookup(ref);
    if (before === undefined || before === PDFNull || orig.dangling.has(key)) benign.push(key); else lost.push(key);
  }
  const ok = !lost.length && saved.pages === orig.pages;
  const verdict = !ok ? (lost.length ? `references lost content: ${lost.slice(0, 5).join(", ")}` : `page count changed ${orig.pages} -> ${saved.pages}`)
    : benign.length ? `ok (${benign.length} reference(s) to objects that were already empty in the original - legal, read as null)` : "ok";
  return { ok, verdict, benign, lost, pages: saved.pages };
}
