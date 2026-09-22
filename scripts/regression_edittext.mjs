// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 BTLTECH LTD
//
// Edit Existing Text regression: does the shipped code still produce FROZEN9?
//
// The seven test corpora and the 133 recorded hashes live outside this repository,
// in the frozen reference snapshot, because they are third-party PDFs that BTLTECH
// may keep for testing but may not redistribute. Point EDITTEXT_REFERENCE at that
// snapshot (default ~/btltech-pdf-editor-reference-frozen9); without it this reports
// that it was skipped rather than passing vacuously.
//
//   node scripts/regression_edittext.mjs            every corpus
//   node scripts/regression_edittext.mjs corpus8    one of them
//
// With --write <dir> it does not compare: it writes each corpus's outputs and a
// results4.json into <dir>, which is how a new freeze is produced and handed to
// the independent PyMuPDF verifier. Comparing and re-freezing are deliberately
// separate: a run that writes a new reference must never be able to report PASS.
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

const REF = process.env.EDITTEXT_REFERENCE || path.join(os.homedir(), "btltech-pdf-editor-reference-frozen9");
const LISTING = process.env.EDITTEXT_LISTING || "FROZEN9.sha256";
const CORPORA = ["corpus", "corpus3", "corpus4", "corpus5", "corpus6", "corpus7", "corpus8"];
const args = process.argv.slice(2);
const writeAt = args.includes("--write") ? args[args.indexOf("--write") + 1] : null;
const named = args.filter((a) => !a.startsWith("--") && a !== writeAt);
const only = named.length ? named : CORPORA;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

if (!writeAt && !fs.existsSync(path.join(REF, "engine", LISTING))) {
  console.log(`SKIPPED: no frozen reference at ${REF}`);
  console.log("Set EDITTEXT_REFERENCE to the snapshot directory to run this suite.");
  process.exit(0);
}

// The listing records output paths as corpora/<corpus>/out4/<id>-<variant>.pdf
const frozen = new Map();
const listing = path.join(REF, "engine", LISTING);
for (const line of (fs.existsSync(listing) ? fs.readFileSync(listing, "utf8") : "").split("\n")) {
  if (!line.trim()) continue;
  const [hash, p] = line.trim().split(/\s+/, 2);
  const m = p.match(/corpora\/(corpus\d*)\/out4\/(.+)$/) || p.match(/\.\.\/(corpus\d*)\/out4\/(.+)$/);
  if (m) frozen.set(`${m[1]}/${m[2]}`, hash);
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
  const written = new Map(), rows = [];
  for (const c of cases) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(dir, "pdf", c.file)));
    const row = { id: c.id, file: c.file, find: c.find };
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
      row[variant] = { outcome: res.outcome, action: res.action, reason: res.reason, integrity: res.integrity, font: res.font, decorations: res.decorations, selfCheck: res.selfCheck };
      if (writeAt && res.savedBytes) written.set(`${c.id}-${variant}.pdf`, res.savedBytes);

      const key = `${corpus}/${c.id}-${variant}.pdf`;
      const want = frozen.get(key);
      if (res.savedBytes) {
        files++;
        const got = sha(res.savedBytes);
        if (!want) missingFrozen.push(`${key} (produced now, not in the frozen reference)`);
        else if (got === want) matched++;
        else if (isForm) {
          const why = await sameFormContent(res.savedBytes, path.join(dir, "out4", `${c.id}-${variant}.pdf`));
          if (why) mismatched.push(`${key}: ${why}`); else byContent++;
        } else mismatched.push(`${key}: ${got.slice(0, 12)} != frozen ${want.slice(0, 12)}`);
      } else if (want) {
        mismatched.push(`${key}: the frozen reference has a saved file, this run produced none (${outcome}${res.reason ? ": " + res.reason.slice(0, 60) : ""})`);
      }
    }
    rows.push(row);
  }
  if (writeAt) {
    const dir2 = path.join(writeAt, corpus);
    fs.mkdirSync(path.join(dir2, "out4"), { recursive: true });
    fs.cpSync(path.join(dir, "pdf"), path.join(dir2, "pdf"), { recursive: true });
    fs.copyFileSync(path.join(dir, "cases.json"), path.join(dir2, "cases.json"));
    for (const [name, bytes] of written) fs.writeFileSync(path.join(dir2, "out4", name), bytes);
    fs.writeFileSync(path.join(dir2, "results4.json"), JSON.stringify(rows, null, 1));
    written.clear(); rows.length = 0;
  }
  process.stdout.write(`  ${corpus} done\n`);
}

console.log(`\noutcomes: ${JSON.stringify(counts)}`);
console.log(`saved files: ${files}, byte-identical to the frozen reference: ${matched}` + (byContent ? `, form-field files matching by content (not byte-reproducible): ${byContent}` : ""));
if (missingFrozen.length) { console.log(`\nnot recorded in FROZEN8 (${missingFrozen.length}):`); missingFrozen.slice(0, 10).forEach((m) => console.log("  " + m)); }
if (mismatched.length) { console.log(`\nDIFFERENCES FROM THE FROZEN REFERENCE (${mismatched.length}):`); mismatched.slice(0, 20).forEach((m) => console.log("  " + m)); }

if (writeAt) {
  console.log(`\nwrote a new candidate reference to ${writeAt}`);
  console.log("This run did not compare against anything. Verify it independently before freezing it.");
  process.exit(0);
}
const ok = !mismatched.length && !missingFrozen.length;
console.log(ok
  ? `\nPASS: the shipped engine reproduces the frozen reference (${matched} byte-identical${byContent ? `, ${byContent} form-field by content` : ""}, ${counts.BLOCKED || 0} blocked, ${counts.UNSUPPORTED || 0} unsupported, ${counts.REFUSED || 0} refused)`
  : "\nFAIL: the shipped engine no longer reproduces the frozen reference");
process.exit(ok ? 0 : 1);
