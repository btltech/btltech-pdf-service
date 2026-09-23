# Deploying to Railway

Everything here is ready to deploy; nothing has been deployed.

## Release requirements

These come from how the service is built, and each one is finished by changing a
setting or a page:

- [ ] **Choose the public repository and set `PDF_SOURCE_REPO_URL`.** AGPL-3.0
      section 13 requires that every user of a network service is offered its
      source. `/source.zip` already serves the running code, so the obligation is
      met either way, but `/source` promises a repository link and should not
      point at nothing.
- [ ] **Publish the privacy notice.** The tools make two different promises and
      the notice has to say which is which: PDF → Word and the page tools receive
      the file on the server (converted in a temporary folder, deleted when the
      download finishes), while `/edit` and `/edit-text` never upload anything at
      all. `PRIVACY.md` in this repository is the draft.
- [ ] Decide whether `PDF_SUPPORT_URL` is set (see below). It is optional and
      nothing is gated behind it.

## Not a deployment blocker

A solicitor's review of the AGPL route is worth having before the service is
promoted, and it is on the owner's list, but it is not something the software
waits on: nothing about it changes whether this deploys or runs correctly. Treat
it as business sign-off running in parallel, not as a gate on the release.

Charging for the service is likewise not an AGPL question. The licence obliges an
offer of source; it does not require the service to be free, and BTLTECH could
charge for access or convenience while complying with it. The reason the text
editor is free is narrower and practical: it executes in the customer's browser,
so a payment check in the page can be bypassed by anyone who looks - the published
source makes that easier, but it is not what would forbid charging.

## Settings

| Variable | Set it to | Why |
|---|---|---|
| `PDF_SOURCE_REPO_URL` | the public repository URL | AGPL s.13; shown on `/source` |
| `PDF_SOURCE_VERSION` | the deployed commit SHA | tells a user exactly which source they are running |
| `PDF2WORD_MAX_MB` | `50` (default) | upload ceiling |
| `PDF2WORD_CONVERT_WORKERS` | `2` (default) | caps concurrent conversions, and so peak memory |
| `PDF_SUPPORT_URL` | a PayPal.me or donate link, or leave unset | renders an optional "support this tool" link in the footer |
| `PDF_SUPPORT_LABEL` | e.g. `Support this tool` | the link's wording |

`PORT` is set by Railway and picked up automatically.

**Access logs.** `railway.json` runs uvicorn with `--no-access-log`. Railway
records requests at its own edge either way, so the application's copy of that log
would only duplicate personal data (caller IP addresses) in a second place for a
service that otherwise holds nothing. Remove the flag if you need per-request
detail in the application log while debugging, and remember that `/privacy` says
requests are logged by the hosting platform - that wording has to stay true.

## Resources and what it should cost

Railway bills for the memory and CPU actually used, plus egress, so these are the
numbers that drive the bill:

- **Idle memory ~80-100 MB.** Each PDF → Word conversion runs in its own
  short-lived process and peaks around 250 MB while it works, so with the default
  two workers the ceiling is roughly 600 MB. **512 MB is too tight; give it 1 GB.**
- **CPU is near zero except during a conversion**, which takes about a second for
  a four-page document. The page tools take tens of milliseconds. The two browser
  editors cost the server nothing at all - they are static files and the visitor's
  own CPU.
- **Egress is the part that is easy to underestimate.** A first visit to
  `/edit-text` fetches the PDFium WebAssembly build and the scripts: about 5.3 MB
  uncompressed, **about 2.4 MB with the gzip that is now enabled** for `/static`.
  Substitute fonts are fetched only when a document's own font lacks a character,
  a few hundred KB when it happens. Repeat visits revalidate and transfer almost
  nothing. So roughly **2.4 MB per new visitor to the text editor**; check
  Railway's current per-GB egress rate against the traffic you expect rather than
  trusting an estimate here.

A sensible starting point is the Hobby plan with 1 GB of memory. Watch the metrics
for the first week of real traffic before sizing up.

## Containers and the licence

Railway builds an image with Nixpacks and runs it on your behalf. That is running
the software, not distributing it, so it does not trigger the GPL/LGPL obligations
that `THIRD_PARTY_NOTICES.md` warns about for the OpenCV wheel. **Do not push that
image to a public registry**, and do not publish a Dockerfile-built bundle: that
would be distribution, and those obligations have not been taken on.

## Deploying

```bash
railway login
railway link                # or: railway init
railway variables --set PDF_SOURCE_REPO_URL=... --set PDF_SOURCE_VERSION=$(git rev-parse HEAD)
railway up
```

Then check, on the live URL:

- `/api/health` returns `{"status":"ok"}`
- `/source` shows the repository link and `/source.zip` downloads
- `/edit-text` loads the engine and edits a document (the file never leaves the browser)
- the footer's "Source code" link is present on every page
