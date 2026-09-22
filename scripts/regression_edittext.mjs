// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// Edit Existing Text regression: does the shipped code still produce FROZEN8?
//
// The seven test corpora and the 133 recorded hashes live outside this repository,
// in the frozen reference snapshot, because they are third-party PDFs that BTLTECH
// may keep for testing but may not redistribute. Point EDITTEXT_REFERENCE at that
// snapshot (default ~/btltech-pdf-editor-reference); without it this suite reports
// that it was skipped rather than passing vacuously.
//
//   node scripts/regression_edittext.mjs            every corpus
//   node scripts/regression_edittext.mjs corpus8    one of them
//
// It drives static/edittext/workflow.mjs - the same module the browser uses - so a
// pass here is a statement about the customer's editor, not about a copy of it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import * as E from "../static/edittext/engine.mjs";
import * as W from "../static/edittext/workflow.mjs";

const REF = process.env.EDITTEXT_REFERENCE || path.join(os.homedir(), "btltech-pdf-editor-reference");
const CORPORA = ["corpus", "corpus3", "corpus4", "corpus5", "corpus6", "corpus7", "corpus8"];
const only = process.argv[2] ? [process.argv[2]] : CORPORA;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

if (!fs.existsSync(path.join(REF, "engine", "FROZEN8.sha256"))) {
  console.log(`SKIPPED: no frozen reference at ${REF}`);
  console.log("Set EDITTEXT_REFERENCE to the snapshot directory to run this suite.");
  process.exit(0);
}

// FROZEN8 records output paths as ../corpusN/out4/<id>-<variant>.pdf
const frozen = new Map();
for (const line of fs.readFileSync(path.join(REF, "engine", "FROZEN8.sha256"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const [hash, p] = line.trim().split(/\s+/, 2);
  const m = p.match(/\.\.\/(corpus\d*)\/out4\/(.+)$/) || p.match(/^\.\/out4\/(.+)$/);
  if (m) frozen.set(m.length === 3 && m[2] ? `${m[1]}/${m[2]}` : `corpus/${m[1]}`, hash);
}

/** Select the run the same way the frozen harness did, with its selection gates. */
function select(open, find) {
  if (open.refused) return { outcome: "REFUSED", reason: open.refused };
  if (open.unsupported) return { outcome: "UNSUPPORTED", reason: open.unsupported };
  const idx = W.findRun(open.runs, find);
  if (idx >= 0) return { idx };
  if (open.model.nested.some((t) => t.includes(find.split(" ")[0])))
    return { outcome: "UNSUPPORTED", reason: "text is inside a nested graphic (form XObject)" };
  if (E.P.FPDFPage_GetAnnotCount(open.model.page) && !E.squash(open.runs.map((x) => x.text).join("")).includes(E.squash(find)))
    return { formField: true };
  const sp = E.scriptProblem(open.runs.map((x) => x.text).join(" "));
  if (sp) return { outcome: "UNSUPPORTED", reason: sp };
  return { outcome: "NOT FOUND" };
}

// A form-field edit goes through pdf-lib, which rewrites the XMP metadata on save
// and stamps the time into it. Those files are therefore not byte-reproducible -
// two runs a second apart differ - and never were, so they are compared by content
// instead: same page count, same field values. That is reported separately rather
// than folded into the byte-identical count.
async function sameFormContent(produced, frozenPath) {
  const PDFLib = createRequire(import.meta.url)(new URL("../static/vendor/pdf-lib.cjs", import.meta.url).pathname);
  const load = async (b) => {
    const d = await PDFLib.PDFDocument.load(b, { ignoreEncryption: true, updateMetadata: false });
    return { pages: d.getPageCount(), fields: d.getForm().getFields().map((f) => `${f.getName()}=${f.getText ? f.getText() : ""}`).sort() };
  };
  const a = await load(produced), b = await load(fs.readFileSync(frozenPath));
  if (a.pages !== b.pages) return `page count ${a.pages} != frozen ${b.pages}`;
  if (JSON.stringify(a.fields) !== JSON.stringify(b.fields)) return `field values differ: ${JSON.stringify(a.fields)} != ${JSON.stringify(b.fields)}`;
  return null;
}

// Nothing is written to disk: the comparison is a hash of the bytes in memory.
let files = 0, matched = 0, byContent = 0, mismatched = [], missingFrozen = [], counts = {};

for (const corpus of only) {
  const dir = path.join(REF, "corpora", corpus);
  if (!fs.existsSync(dir)) { console.log(`  ${corpus}: not in the reference, skipped`); continue; }
  const cases = JSON.parse(fs.readFileSync(path.join(dir, "cases.json"), "utf8"));
  for (const c of cases) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, "pdf", c.file)));
    for (const variant of ["short", "long"]) {
      const open = W.openAndAnalyse(bytes);
      const pick = select(open, c.find);
      let res;
      const isForm = !!pick.formField;
      if (pick.formField) res = await W.formFieldEdit(bytes, c.find, c[variant]);
      else if (pick.outcome) res = pick;
      else {
        const run = open.runs[pick.idx];
        await W.prepareFonts(run, run.text.replace(c.find, c[variant]));
        res = await W.editRun({ bytes, runIndex: pick.idx, newText: run.text.replace(c.find, c[variant]) });
      }
      const outcome = (res.outcome || "?").split(" (")[0].split(" after")[0];
      counts[outcome] = (counts[outcome] || 0) + 1;

      const key = `${corpus}/${c.id}-${variant}.pdf`;
      const want = frozen.get(key);
      if (res.savedBytes) {
        files++;
        const got = sha(res.savedBytes);
        if (!want) missingFrozen.push(`${key} (produced now, not in FROZEN8)`);
        else if (got === want) matched++;
        else if (isForm) {
          const why = await sameFormContent(res.savedBytes, path.join(dir, "out4", `${c.id}-${variant}.pdf`));
          if (why) mismatched.push(`${key}: ${why}`); else byContent++;
        } else mismatched.push(`${key}: ${got.slice(0, 12)} != frozen ${want.slice(0, 12)}`);
      } else if (want) {
        mismatched.push(`${key}: FROZEN8 has a saved file, this run produced none (${outcome}${res.reason ? ": " + res.reason.slice(0, 60) : ""})`);
      }
    }
  }
  process.stdout.write(`  ${corpus} done\n`);
}

console.log(`\noutcomes: ${JSON.stringify(counts)}`);
console.log(`saved files: ${files}, byte-identical to FROZEN8: ${matched}` + (byContent ? `, form-field files matching by content (not byte-reproducible): ${byContent}` : ""));
if (missingFrozen.length) { console.log(`\nnot recorded in FROZEN8 (${missingFrozen.length}):`); missingFrozen.slice(0, 10).forEach((m) => console.log("  " + m)); }
if (mismatched.length) { console.log(`\nDIFFERENCES FROM THE FROZEN REFERENCE (${mismatched.length}):`); mismatched.slice(0, 20).forEach((m) => console.log("  " + m)); }

const ok = !mismatched.length && !missingFrozen.length;
console.log(ok
  ? `\nPASS: the shipped engine reproduces FROZEN8 (${matched} byte-identical${byContent ? `, ${byContent} form-field by content` : ""}, ${counts.BLOCKED || 0} blocked, ${counts.UNSUPPORTED || 0} unsupported, ${counts.REFUSED || 0} refused)`
  : "\nFAIL: the shipped engine no longer reproduces FROZEN8");
process.exit(ok ? 0 : 1);
