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
- [ ] **Leave `PDF_SUPPORT_URL` unset until the commercial approach is decided.**
      It is only the mechanism for a voluntary link; it is not a decision about
      how the service is funded, and that decision is still open.

## Not a deployment blocker

A solicitor's review of the AGPL route is worth having before the service is
promoted, and it is on the owner's list, but it is not something the software
waits on: nothing about it changes whether this deploys or runs correctly. Treat
it as business sign-off running in parallel, not as a gate on the release.

Charging for the service is likewise not an AGPL question. The licence obliges an
offer of source; it does not require the service to be free, and BTLTECH could
charge for access or convenience while complying with it.

What has been established is narrower: a charge enforced by a check inside the
text editor would not hold, because that editor runs in the customer's browser and
anyone who looks can lift it. That rules out one implementation, not the idea of
charging. Gating something the server performs and can withhold - a conversion
quota, larger uploads, batch work - is still open, and no decision has been made.

## Settings

| Variable | Set it to | Why |
|---|---|---|
| `PDF_SOURCE_REPO_URL` | the public repository URL | AGPL s.13; shown on `/source` |
| `PDF_SOURCE_VERSION` | the deployed commit SHA | tells a user exactly which source they are running |
| `PDF2WORD_MAX_MB` | `50` (default) | upload ceiling |
| `PDF2WORD_CONVERT_WORKERS` | `2` (default) | caps concurrent conversions, and so peak memory |
| `PDF_SUPPORT_URL` | leave unset for now | would render a voluntary "support this tool" link; unset until the commercial approach is decided |
| `PDF_SUPPORT_LABEL` | e.g. `Support this tool` | the link's wording |

| `PDF_CANONICAL_HOST` | `pdf.btltech.co.uk` | the one address people see and link to |
| `PDF_REDIRECT_HOSTS` | `tools.btltech.co.uk` | comma-separated; these 301 to the canonical host, path and query intact |

`PORT` is set by Railway and picked up automatically.

## Giving it a BTLTech address

The generated `*.up.railway.app` address looks like infrastructure rather than a
product, so the service should answer on a BTLTech name before it is linked from
the main site. The plan is `pdf.btltech.co.uk` as the real address, with
`tools.btltech.co.uk` redirecting to it so the broader name is claimed and cannot
be taken later.

The redirect is done by the application (see `PDF_CANONICAL_HOST` above), not by a
Cloudflare rule, so it is covered by the test suite and moves with the code. Only
hostnames named in `PDF_REDIRECT_HOSTS` are touched; everything else, including the
Railway URL, is served normally.

**Adding the custom domains needs doing in the Railway dashboard.** `railway domain
pdf.btltech.co.uk` returns `Unauthorized` from the CLI while every other
authenticated call on the same login succeeds, which is what a plan restriction
looks like rather than a bad token - custom domains are a paid-plan feature. Check
the plan on the project, add both hostnames there, and Railway will show the CNAME
target to use.

Then, in Cloudflare for `btltech.co.uk`:

| Type | Name | Target | Proxy |
|---|---|---|---|
| CNAME | `pdf` | the target Railway shows | see below |
| CNAME | `tools` | the same target | see below |

If the records are proxied (orange cloud), set the zone's SSL/TLS mode to **Full**
or **Full (strict)**. Leaving it on Flexible with a backend that already serves
HTTPS is the classic cause of a redirect loop. DNS-only (grey cloud) also works and
is the simpler thing to try first.

Finally set `PDF_CANONICAL_HOST` and `PDF_REDIRECT_HOSTS`, redeploy, and check that
`https://tools.btltech.co.uk/edit-text` lands on `https://pdf.btltech.co.uk/edit-text`.

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

## Switching on paid conversions

Everything is built, deployed and tested; it is **off**, because a customer who
hit the limit today could not pay. Turning it on is four settings and a test.

1. **Create a PayPal app** at developer.paypal.com. Take the sandbox Client ID
   and Secret first - live credentials come later, after step 4.
2. **Put them in Railway** (you, not me - I do not handle keys):
   `PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_ENV=sandbox`.
3. **Set the packs and the allowance.** Already set: `PDF_FREE_PER_DAY=1` and
   `PDF_PACKS=10:2.00,25:4.00`. Change the packs freely - the format is
   `credits:price`, comma-separated, and nothing about them is in the code.
   `PDF_BILLING_SALT` is already set and should not be changed casually: doing so
   resets every free counter, which is harmless but means one extra free
   conversion each for everyone.
4. **Switch it on**: `PDF_BILLING=on`.

Then test with a PayPal sandbox account:

- `/convert` shows the allowance and the packs
- convert once: it works, and the count goes down
- convert again: refused with a message, not an error
- buy a pack: PayPal's window opens, approval returns, credits appear
- convert again: it works and spends a credit
- buy the same pack twice in quick succession: the second click adds nothing extra

When that all behaves, swap in the live credentials and set `PAYPAL_ENV=live`.

**Before taking real money**, settle the terms of sale: what a pack is, that
credits do not expire, that they live in the browser and are lost if site data
is cleared, and how refunds are handled. `PRIVACY.md` lists it alongside the
other open questions. The privacy notice already describes what a purchase
records; the terms of sale are a separate page that does not exist yet.

### What is and is not enforceable

Paid credits are counted on the server against a token this service issued, so
they cannot be forged or replayed. The **free allowance is a speed bump, not a
lock**: it is counted against the caller's address, and anyone reaching the
origin directly can send whatever address they like. That is a deliberate trade -
it costs an honest visitor nothing, and tightening it would mean accounts.
