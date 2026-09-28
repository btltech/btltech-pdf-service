# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""What a page says about prices, and what it tells search engines.

Two jobs, kept out of the HTML files on purpose.

Prices. What a clean export or a pack costs is configuration (PDF_EXPORT_PRICE,
PDF_PACKS), so the pages cannot type it in: a price written into the HTML is a
price that goes stale the day the setting changes, and a customer told one
figure and charged another has been misled. Pages say {{EXPORT_PRICE}} and
{{PACKS}}, and wrap anything that only applies while charging is switched on
in <!--IF-BILLING-->...<!--/IF-BILLING--> (with <!--IF-FREE--> as its
opposite), so a deployment that charges nothing never mentions money.

Structured data. The JSON-LD a search engine reads is built from the same
configuration, and the FAQ markup is read out of the page's own visible
questions rather than written a second time - so the two cannot disagree,
which is the thing search engines penalise.

The sample invoice. /edit-text offers one to people with no PDF to hand. Its
clean copy is free: nobody should pay to finish a demonstration. The server
knows it by the same fingerprint the browser computes.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from functools import lru_cache
from pathlib import Path
from typing import List, Optional

import billing
import config
import paypal

STATIC_DIR = Path(__file__).parent / "static"
SAMPLE_PATH = STATIC_DIR / "samples" / "sample-invoice.pdf"
SITE = "https://" + (config.CANONICAL_HOST or "pdf.btltech.co.uk")


@lru_cache(maxsize=1)
def sample_hash() -> str:
    """SHA-256 of the sample invoice, exactly as the browser computes it."""
    try:
        return hashlib.sha256(SAMPLE_PATH.read_bytes()).hexdigest()
    except OSError:
        return ""


def is_sample(doc: Optional[str]) -> bool:
    return bool(doc) and doc == sample_hash()


def charging() -> bool:
    """True only when something can actually be bought: billing on AND a way to pay."""
    return billing.enabled() and paypal.configured()


def _money(amount: str) -> str:
    return f"{config.CURRENCY_SYMBOL}{amount}"


def _packs_text() -> str:
    packs = billing.packs()
    parts = [f"{p.credits} for {_money(p.price)}" for p in packs]
    if len(parts) <= 1:
        return "".join(parts)
    return ", ".join(parts[:-1]) + " or " + parts[-1]


def _count_word(n: int) -> str:
    words = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five"}
    return words.get(n, str(n))


def _free_conversions() -> str:
    n = config.FREE_PER_DAY
    return f"{_count_word(n)} free conversion{'' if n == 1 else 's'}"


def fill(text: str) -> str:
    """Put the configured prices into a page, and drop what does not apply."""
    on = charging()
    keep, drop = ("IF-BILLING", "IF-FREE") if on else ("IF-FREE", "IF-BILLING")
    text = re.sub(rf"<!--{drop}-->.*?<!--/{drop}-->", "", text, flags=re.S)
    text = text.replace(f"<!--{keep}-->", "").replace(f"<!--/{keep}-->", "")
    return (text
            .replace("{{EXPORT_PRICE}}", _money(billing.export_price().price))
            .replace("{{PACKS}}", _packs_text())
            .replace("{{FREE_CONVERSIONS}}", _free_conversions())
            .replace("{{FREE_PER_DAY}}", _count_word(config.FREE_PER_DAY))
            .replace("{{MAX_MB}}", str(config.MAX_UPLOAD_MB)))


# ---------------------------------------------------------- structured data ---
APPS = {
    "edittext.html": ("Edit text in a PDF", "/edit-text",
                      "Change the words already in a PDF and keep its font, size and layout. "
                      "Runs in the browser; the document is never uploaded."),
    "convert.html": ("PDF to Word converter", "/convert",
                     "Convert a PDF into an editable Word document, keeping headings, tables, "
                     "images and formatting."),
    "editor.html": ("Edit PDF: annotate, sign and organise", "/edit",
                    "Add text, draw, highlight, place a signature or an image, and reorder or "
                    "delete pages, in the browser."),
    "tools.html": ("PDF page tools", "/tools",
                   "Merge, split, rotate, delete, compress, number, watermark, protect and "
                   "unlock PDF pages."),
}


def _offer(price: str, description: str) -> dict:
    return {"@type": "Offer", "price": price, "priceCurrency": config.CURRENCY,
            "description": description}


def _offers(name: str) -> List[dict]:
    if not charging():
        return [_offer("0", "Free")]
    if name == "edittext.html":
        return [_offer("0", "Editing and preview"),
                _offer(billing.export_price().price, "Clean copy of one edited document")]
    if name == "convert.html":
        free = _count_word(config.FREE_PER_DAY)
        return ([_offer("0", f"{free.capitalize()} conversion a day")]
                + [_offer(p.price, f"{p.credits} conversions") for p in billing.packs()])
    return [_offer("0", "Free")]


def _faq(page: str) -> List[dict]:
    """The page's own visible questions, so the markup can never say something the page does not."""
    items = []
    for block in re.findall(r'<details class="faq">(.*?)</details>', page, flags=re.S):
        q = re.search(r"<summary>(.*?)</summary>", block, flags=re.S)
        if not q:
            continue
        answer = block[q.end():]
        clean = lambda s: html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()
        items.append({"@type": "Question", "name": clean(q.group(1)),
                      "acceptedAnswer": {"@type": "Answer", "text": clean(answer)}})
    return items


def structured_data(name: str, page: str) -> str:
    """JSON-LD for a page, or nothing if it is not one of the tools."""
    if name not in APPS:
        return ""
    title, path, description = APPS[name]
    graph: List[dict] = [{
        "@type": "WebApplication",
        "name": title,
        "url": SITE + path,
        "description": description,
        "applicationCategory": "UtilitiesApplication",
        "operatingSystem": "Any, in a web browser",
        "offers": _offers(name),
        "provider": {"@type": "Organization", "name": "BTLTECH LTD", "url": "https://btltech.co.uk"},
    }]
    faq = _faq(page)
    if faq:
        graph.append({"@type": "FAQPage", "mainEntity": faq})
    data = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)
    # "</" would end the script element early if an answer ever contained it
    return '<script type="application/ld+json">' + data.replace("</", "<\\/") + "</script>\n"


def render(name: str, page: str) -> str:
    """Everything a page needs from configuration, in one pass."""
    page = fill(page)
    ld = structured_data(name, page)
    return page.replace("</head>", ld + "</head>", 1) if ld else page
