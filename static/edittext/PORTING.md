# Porting notes: FROZEN8 -> this service

`engine.mjs` here is the frozen research engine (`engine4.mjs` in the reference
snapshot). Everything that decides whether an edit is safe is untouched. This file
records every difference, so that "it is the frozen engine" is a claim anyone can
check rather than one they have to take on trust.

Check the port itself against FROZEN8 (this shows the I/O changes, and now also
the justified-detector fix described at the end of this file):

    diff -a ~/btltech-pdf-editor-reference/engine/engine4.mjs static/edittext/engine.mjs

and prove the behaviour is unchanged with:

    node scripts/regression_edittext.mjs

## The differences, in full

| # | Change | Why |
|---|---|---|
| 1 | Header comment and SPDX licence lines | It is now part of a published AGPL service |
| 2 | `import fs from "fs"` removed; PDFium and HarfBuzz WASM, fonts and files come from `./assets.mjs` | A browser has no filesystem. This is the only reason the file was touched at all |
| 3 | Font paths flattened: `liberation-fonts-ttf-2.1.5/LiberationSans-Regular.ttf` -> `LiberationSans-Regular.ttf` | The fonts are served from one flat `/static/fonts/` directory |
| 4 | `openDoc(path)` -> `openDoc(src)`, accepting bytes or (under Node) a path | The browser has the file as bytes from a file input; it never has a path |
| 5 | `saveDoc(doc, out)` writes a file -> `saveDoc(doc)` returns the bytes | Same reason. The caller decides; in the browser that is a download the customer starts |
| 6 | `OFL` and `CLASS` added to the exports | `fontset.mjs` needs to know which font files to fetch before the engine's synchronous font lookups run. Exporting the existing table is better than copying it somewhere it could rot |

Nothing else differs: not the fit ladder, the glyph validation, the obstacle and
ink checks, the table-column rule, the alignment, internal-spacing, justified or
decoration rules, or any threshold.

## Deliberate fidelity choice

`workflow.mjs` is the frozen harness's `runCase` moved into shared code. One place
invited an improvement and did not get one: on the fallback path where the original
font turns out not to draw the replacement and a substitute is tried, FROZEN8 does
**not** carry an underline across, and neither does this. Adding it there would be a
behaviour change, and behaviour changes belong in their own tested step rather than
being smuggled in with a port.

## The justified detector was fixed after the port (FROZEN8 -> FROZEN9)

The fixture exposed two faults in the frozen detector, in opposite directions: a
plain left-aligned line was refused as justified, and a genuinely justified
paragraph was missed. Both were real, both are fixed, and the fix is the reason the
reference moved from FROZEN8 to FROZEN9.

**It measured the wrong characters.** To find a line's word gaps it searched the
page's text for the line's first 16 characters and walked forward by index. Reading
order is not layout order: on a multi-column page that walk stepped from one column
into the next and counted the space between columns as a word gap. On a dictionary
page of 105,000 characters it reported ordinary sentences as stretched by 150% or
more. Characters are now selected by where they sit - inside the run's own box - so
the measurement matches what a reader sees. That change alone took the firing rate
across the seven corpora from 21% of all lines to 9%.

**It asked the wrong question.** The gap ratio is a weak signal, because a
justified line whose words nearly fill it is barely stretched: the fixture's
justified paragraph measured 1.07, under the 1.08 threshold, while being obviously
justified to the eye. What defines justified text is the shape of the block - every
line but the last reaching the right margin exactly. That is now the primary test,
with the gap ratio kept only for a line with no block to belong to (a dictionary
entry with a hanging indent, for instance). The last line of a justified paragraph
is short by design, so it is excluded from the test and stays editable: editing it
cannot break the paragraph's appearance.

Across the seven corpora this lifted 12 refusals and added 1. The one addition is
`corpus7/d10`, a European Commission contract with three lines flush at x=552.7 and
a short last line: FROZEN8 edited it, which was wrong. Independent verification
with PyMuPDF reports 0 problem outputs in all seven corpora.

The customer-facing wording branches on which evidence found the line, because
quoting "word gaps are 1% wider than normal" for a line detected by block shape
would read as nonsense and undersell a real reason to refuse.
