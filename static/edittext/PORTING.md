# Porting notes: FROZEN8 -> this service

`engine.mjs` here is the frozen research engine (`engine4.mjs` in the reference
snapshot). Everything that decides whether an edit is safe is untouched. This file
records every difference, so that "it is the frozen engine" is a claim anyone can
check rather than one they have to take on trust.

Check it yourself:

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

## Two things the fixture exposed about the frozen engine

Found while building the browser suite, on `scripts/make_edittext_pdf.py`'s fixture.
Both are properties of FROZEN8 itself - the diff above shows the detector code is
byte-identical - and both are recorded rather than quietly patched, because changing
a threshold means re-validating all seven corpora.

1. **A plain line can be refused as justified.** `Client: Northwood Services Ltd`
   measures word gaps 9% wider than normal, just over the 8% threshold, on a line
   with only three gaps. The customer is told the line is justified when it is not.
   It fails safe - nothing is damaged, the edit is refused - but it is a refusal
   they did not deserve.
2. **A genuinely justified line can be missed.** The justified paragraph in the
   fixture is not detected, and is edited as though it were ordinary text.

Neither showed up across the seven real-world corpora, which is why the threshold
sits where it does. The statistic is simply noisy on lines with few word gaps.
Before this feature is charged for, the justified detector deserves its own targeted
corpus - documents that are justified, and documents with short left-aligned lines -
and a rule that accounts for how many gaps it is averaging over.
