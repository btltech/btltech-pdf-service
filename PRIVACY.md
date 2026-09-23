# Privacy notice — BTL Tech PDF Toolkit

**Draft for review.** Every factual statement below was checked against the code in
this repository on 23 September 2026, and the checks are named so they can be
repeated. What it does *not* do is decide which UK GDPR lawful basis applies, who
the controller is for a given tool, or how long host logs may be kept — those are
judgements for a solicitor, not for a developer reading source code.

## The one thing to understand first

This toolkit does two different things, and they make two different promises. Any
wording that flattens them into "we never see your files" would be untrue for half
the service.

| Tool | Does the file reach the server? |
|---|---|
| **PDF → Word** (`/convert`) | **Yes.** Uploaded, converted, sent back, deleted |
| **Page tools** (`/tools`) — merge, split, rotate, compress, protect… | **Yes.** Same path |
| **Edit PDF** (`/edit`) — annotate, sign, reorder | **No.** Opened and saved in your browser |
| **Edit existing text** (`/edit-text`) | **No.** Opened and saved in your browser |

## When a file is uploaded (PDF → Word, page tools)

- It is written into a temporary directory on the server, processed, and returned
  to you as a download.
- **That directory is deleted as soon as the download has been sent**, and also if
  the conversion fails or is rejected. (`app.py`: `BackgroundTask(shutil.rmtree,
  tmp_dir)` on success, `shutil.rmtree` in both error paths; `tools.py` does the
  same.)
- Nothing is copied anywhere else. There is no database, no object storage, no
  queue and no backup of uploads.
- **The file's name is not recorded.** The application log notes only the file
  extension, the size in megabytes and the number of pages — enough to diagnose a
  failed conversion, without keeping what the document was called. Documents are
  routinely named after people and cases, so the name is treated as part of the
  content rather than as metadata.

## When nothing is uploaded (both editors)

- The document is read by your own browser from the file you choose, held in that
  tab's memory, and saved back to your device.
- **There is no request that carries it anywhere.** The automated test suite
  asserts this rather than claiming it: `scripts/browser_edittext_test.mjs` watches
  every network request the page makes while a document is opened and edited, and
  fails if any of them is not a plain GET for this site's own assets.
- The PDF engine, fonts and scripts those pages use are served from this site, not
  from a third party, so opening them does not announce your visit to anyone else.

## What the site itself collects

- **This service sets no cookies** and loads no analytics, tracking pixels,
  advertising or third-party scripts of its own. (Checked: no `cookie`, analytics
  or beacon code in any page; the only external link in any page is to the GNU
  licence text.)
- **Cloudflare's proxy adds its own, and that has to be disclosed.** Measured on
  `pdf.btltech.co.uk` on 23 Sep 2026: a script from
  `static.cloudflareinsights.com/beacon.min.js`, a `POST /cdn-cgi/rum` of about
  839 bytes, and a `POST /cdn-cgi/challenge-platform/...` of about 16.5 KB of
  browser characteristics. Both POSTs fire on page load, before any document is
  opened, so they do not carry the file - but they are analytics and
  fingerprinting on a page whose whole selling point is that nothing leaves the
  browser. *Turning the orange cloud off for this hostname, or disabling Web
  Analytics and Bot Fight Mode for it, removes all three and lets this notice go
  back to the shorter claim. That is a decision for the owner.*
- **No accounts**, so no names, email addresses or passwords are held.
- **Host access logs.** Like any web server, the host records a line per request:
  IP address, time, the URL requested, and the browser's user-agent string. These
  are the hosting platform's operational logs, not something the application
  writes, and an IP address is personal data. *How long the host keeps them, and
  under what basis, is a question for whoever signs off the hosting arrangement —
  it is not determined by this code.*

## Your rights

Because uploads are deleted as soon as they are served and no accounts exist, there
is normally nothing held about you to access, correct or erase. If you believe
otherwise, contact BTLTECH LTD. *The contact route, the controller's identity and
the ICO registration position are business questions to settle before publication.*

## Things for the reviewer to decide

1. **Controller and lawful basis** for processing an uploaded document, and whether
   they differ between the server-side tools and the browser-only editors.
2. **Host log retention** — the figure, and where it is stated.
3. Whether the service should say anything about **special-category or confidential
   documents** (medical, legal, HR) being uploaded to the server-side tools, given
   the upload is transient but real.
4. Whether **"we delete it immediately"** should be qualified in any way for
   uploads interrupted mid-transfer.
5. The **contact address** for privacy enquiries and the ICO position.

## How to re-check these claims

```bash
grep -n "rmtree\|BackgroundTask" app.py tools.py     # uploads are deleted
grep -rn "cookie\|analytics\|gtag\|fbq" static/ app.py tools.py   # nothing tracks you
grep -n "log.info" app.py                            # what is written to the log
scripts/run_tests.sh --browser                       # the editors upload nothing
```
