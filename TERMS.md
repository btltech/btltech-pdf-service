# Terms of sale — BTLTech PDF Toolkit

**Draft for review.** This is the companion to `PRIVACY.md` and follows the same
rule: every factual statement about how the service behaves was read out of the
code in this repository on 23 September 2026 and the check is named, so it can be
repeated. What it does **not** do is settle the legal questions — whether the
cancellation right is validly lost, what the confirmation on a durable medium must
contain, VAT, or governing law. Those are listed at the end for a solicitor.

This matters more than the privacy notice did. Since the PayPal keys were switched
to live, `PAYPAL_ENV=live`, this service takes real money from consumers, and
until the page below is published it does so with nothing shown about what is
being bought, what happens to it, or how to get it back.

---

## 1. What is actually on sale

Two things, and nothing else. Both prices come from the server; the browser cannot
propose a price (`app.py: pay_create` looks the price up and ignores the body).

| | What the customer gets | Price | Where it comes from |
|---|---|---|---|
| **Clean copy of an edited PDF** | The un-watermarked export of **one** document | `PDF_EXPORT_PRICE`, live value **£1.00** | `billing.export_price()` |
| **Conversion pack** | Credits, one spent per PDF → Word conversion | `PDF_PACKS`, live value **10 for £2.00**, **25 for £4.00** | `billing.packs()` |

Verified against the running service on 23 Sep 2026:

```
$ curl -s https://pdf.btltech.co.uk/api/allowance
{"billing":true,...,"packs":[{"credits":10,"price":"2.00",...},{"credits":25,"price":"4.00",...}],"currency":"GBP"}
$ curl -s "https://pdf.btltech.co.uk/api/export/status?doc=abc"
{"billing":true,"unlocked":false,"price":"1.00","currency":"GBP"}
```

Everything else is free and ungated: both editors, all the page tools, and
`PDF_FREE_PER_DAY` conversions a day (live value: 1).

## 2. What the £1 export unlocks, precisely

This is the part most likely to be misunderstood, so it is worth stating exactly.

- The unlock is recorded as `(token, doc)` in `document_export` (`billing.grant_export`).
- `doc` is a SHA-256 the browser computes **from the original file the customer
  opened**, before any edit (`static/edittext/ui.mjs:121`, `state.docHash =
  await hashOf(state.bytes)` immediately after the file is read).
- So the unlock follows the *source document*, not one particular set of edits.
  Re-open the same file in the same browser later, change it differently, and the
  clean save is still unlocked. That is genuinely generous and should be said.
- It does **not** cover a different file, nor the same content re-saved and
  re-opened (the bytes differ, so the hash differs).
- There is no expiry column on `document_export` or `credit_pack`. Nothing lapses
  with time.

## 3. What the customer is relying on, and can lose

There are no accounts. Entitlement is an opaque bearer token issued by the server
and kept by the browser in `localStorage` under the key `btltech-pdf-credits`
(`static/convert.html:197`, `static/edittext/ui.mjs:28`).

Consequences, all of which follow directly from that and all of which must be
disclosed before payment rather than after:

- Clearing this site's data, or "clear cookies and site data", loses it.
- Another browser, another device, or a private window does not have it.
- Anyone who has the token has the credits. There is nothing to log in to and no
  way to prove a lost token was yours.
- There is therefore no mechanism in the code to restore a lost entitlement. The
  only record that a payment happened is the PayPal order id in `paid_order`, which
  is why the terms tell people to keep the PayPal receipt.

## 4. Failure paths already handled in code

Worth stating in the terms because they are customer-favourable and true:

- **A conversion that fails returns the credit.** The credit is taken before the
  work and put back if the work fails (`billing.reserve` / `billing.refund`,
  `app.py: _return_credit`). Tested in `scripts/test_billing.py`.
- **Paid but not recorded, export:** if the database write fails after PayPal has
  taken the money, the customer still gets their file and the failure is logged
  loudly (`app.py`, `PAID BUT NOT RECORDED`).
- **Paid but not recorded, pack:** credits cannot be handed over without the
  record, so the customer is given the PayPal order reference and told it will be
  put right (HTTP 409 with the reference in the message).
- **The meter failing open.** If the database is unreachable, `/api/allowance` and
  `/api/export/status` let the customer through free rather than making them wait
  (`billing.py`: pool `timeout=3`; both endpoints catch and return `billing:false`).

## 5. Payment

PayPal Orders v2, capture intent. The customer approves on PayPal's own pages; no
card details reach this service (`paypal.py`). The credit or unlock is granted on
PayPal's answer to a server-to-server capture, never on the browser's claim, and
a capture that reports an amount this service does not sell for grants nothing
(`app.py: pay_capture`).

---

## What the published page says, and the two sentences that are judgements

`static/terms.html` states everything in sections 1–5 as fact. Two things in it are
**not** facts read out of code, and are marked here so they are not mistaken for
them:

1. **The refund promise.** Drafted as: a full refund where the thing bought could
   not be produced or did not work, asked for within 30 days quoting the PayPal
   reference; and unused conversion credits refundable within 14 days of purchase.
   Those numbers are a business decision, not a legal minimum, and the owner should
   confirm or change them.
2. **The cancellation wording.** Drafted so that the customer is told, before
   paying, that they are asking for the content immediately and that the statutory
   14-day cancellation right is lost once it is supplied. Whether that is *validly*
   obtained here is question 1 below.

---

## Questions for the reviewer

1. **Cancellation right and express consent.** The Consumer Contracts (Information,
   Cancellation and Additional Charges) Regulations 2013 reg. 37 provides that the
   right to cancel digital content not on a tangible medium is lost where the
   consumer gives express consent to supply beginning before the end of the
   cancellation period and acknowledges that the right will be lost. As built, the
   customer sees a sentence next to the pay button saying both things and then
   clicks it. **Is a statement adjacent to the button enough, or does this need a
   separate affirmative act — a tick — and should the consent be recorded against
   the order?** Recording it is a small change (`paid_order` gains a column); it has
   not been made, because guessing at the requirement seemed worse than asking.
2. **Confirmation on a durable medium.** Reg. 16 requires confirmation of the
   contract on a durable medium within a reasonable time, and, where applicable,
   confirmation of that consent and acknowledgement. Today the only thing the
   customer receives is PayPal's own receipt, which BTLTECH does not control and
   which will not mention the consent. **Does this need an emailed confirmation —
   which would mean collecting an email address the service currently, deliberately,
   does not collect and the privacy notice says it does not hold?**
3. **Pre-contract information.** Sch. 2 lists what must be given before a distance
   contract binds. The page covers identity, address, price, payment, what is
   supplied, complaints and cancellation. **Is anything missing for this kind of
   sale — in particular, is a model cancellation form required where the right is
   being excluded by consent?**
4. **VAT — answered.** The owner confirmed on 23 September 2026 that BTLTECH LTD is
   **not registered for VAT**, so no number is required by the E-Commerce
   Regulations 2002 reg. 6 and nothing is added to the price. The page now says so
   plainly. *This is the owner's statement, not something read out of a register;
   it needs revisiting if the company crosses the registration threshold.*
5. **Statutory rights under the Consumer Rights Act 2015.** Digital content is
   covered by Part 1 Chapter 3 (ss. 33–47): satisfactory quality, fit for purpose,
   as described, with remedies of repair or replacement and price reduction, and
   s. 46 on damage to the customer's device or other digital content. The page says
   these rights are not affected and does not attempt to exclude them. **Is the
   "no warranty" language inherited from the AGPL — which governs the software
   licence, not the sale — capable of being read as an attempted exclusion, and
   should the two be separated more sharply on the page?**
6. **Losing an entitlement is normal here, not exceptional.** A customer who clears
   their browser data loses what they paid for and there is no way to restore it.
   The page says so before payment, in plain words. **Is disclosure sufficient, or
   does a term that allocates that loss to the consumer need to survive the
   fairness test in CRA 2015 Part 2?** This is the term most likely to be
   challenged, and the cheapest answer if it fails is to keep an email address
   against the order — which the privacy position currently avoids.
7. **Governing law and jurisdiction**, and whether anything is needed about
   alternative dispute resolution or the ODR platform.
8. **Trading disclosures.** Company name, registered number, registered office and
   email are on the page (Companies (Trading Disclosures) Regulations 2008;
   E-Commerce Regulations 2002 reg. 6). **Confirm the registered office on the page
   matches Companies House for 13311691 today** — it is taken from the main site's
   `data.json`, not from the register.

## How to re-check the factual claims

```bash
grep -n "EXPORT_PRICE\|PDF_PACKS\|FREE_PER_DAY" config.py        # what is on sale
grep -n "docHash" static/edittext/ui.mjs                          # what the unlock follows
grep -rn "localStorage" static/                                   # where entitlement lives
grep -n "expire\|expiry\|INTERVAL" billing.py                     # nothing expires but free_use
grep -n "PAID BUT NOT RECORDED" app.py                            # the failure paths
.venv/bin/python -m pytest scripts/test_billing.py -q             # reserve/refund/grant
curl -s https://pdf.btltech.co.uk/api/allowance                   # the live prices
```
