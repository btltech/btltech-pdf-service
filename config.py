# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Shared configuration for the BTLTech PDF services."""

import os

# Upload ceiling, in MB, applied to every endpoint.
MAX_UPLOAD_MB = int(os.environ.get("PDF2WORD_MAX_MB", "50"))

# Where the service listens.
HOST = os.environ.get("PDF2WORD_HOST", "0.0.0.0")
# PORT (no prefix) is what Railway, Heroku and most other hosts set, so honour it
# when our own variable is not given.
PORT = int(os.environ.get("PDF2WORD_PORT") or os.environ.get("PORT") or "8000")

# How many PDF -> Word conversions run at once. Each one runs in its own child
# process (converter_worker.py) and needs roughly 150-250 MB while it works,
# so this also caps peak memory. Extra requests wait their turn.
CONVERT_WORKERS = max(1, int(os.environ.get("PDF2WORD_CONVERT_WORKERS", "2")))

# A conversion still running after this many seconds is stopped, so a
# pathological PDF cannot hold a conversion slot for ever.
CONVERT_TIMEOUT_S = max(10, int(os.environ.get("PDF2WORD_CONVERT_TIMEOUT_S", "300")))

# AGPL-3.0 section 13: every user of this network service must be offered the
# source of the version they are using. /source always serves a ZIP built from
# the files actually running; these two settings add a link to the public
# repository and the exact revision, and are optional.
SOURCE_REPO_URL = os.environ.get("PDF_SOURCE_REPO_URL", "").strip()
# Railway sets RAILWAY_GIT_COMMIT_SHA when it deploys from a connected
# repository. Falling back to it means the version named on /source is the one
# actually running, rather than whatever was last typed in by hand - a source
# offer that points at the wrong commit is worse than one that points at none.
SOURCE_VERSION = (
    os.environ.get("PDF_SOURCE_VERSION")
    or os.environ.get("RAILWAY_GIT_COMMIT_SHA")
    or ""
).strip()

# An optional link where people can support the service (a PayPal.me address, a
# PayPal donate link, or anything else). When it is empty - the default, and what
# production runs - no support link is rendered anywhere.
#
# How this service is funded is not settled. This variable is not that decision;
# it is only the mechanism for a voluntary link, and nothing is gated behind it.
# What is settled is narrower: a charge enforced by a check inside the text
# editor would not hold, because that editor runs in the customer's own browser.
# Charging for something the server performs and can withhold is a different
# question and remains open.
#
# It is a plain link on purpose. Embedding a payment provider's JavaScript would
# put third-party code on pages that promise the document never leaves the tab,
# and that promise is worth more than the convenience.
SUPPORT_URL = os.environ.get("PDF_SUPPORT_URL", "").strip()
SUPPORT_LABEL = os.environ.get("PDF_SUPPORT_LABEL", "Support this tool").strip()

# One address, so the service has one name. When the same deployment answers on
# several hostnames - a bare Railway URL, an old name, a broader umbrella name -
# only one should be the address people see, link to and share.
#
# CANONICAL_HOST is that name. REDIRECT_HOSTS lists the hostnames that should
# send visitors to it with a permanent redirect. Hostnames NOT in that list are
# left completely alone, which is what keeps the Railway URL, localhost and the
# test client working normally: this never guesses, it only acts on names it has
# been given.
CANONICAL_HOST = os.environ.get("PDF_CANONICAL_HOST", "").strip().lower()
REDIRECT_HOSTS = [
    h.strip().lower()
    for h in os.environ.get("PDF_REDIRECT_HOSTS", "").split(",")
    if h.strip()
]

# ----------------------------------------------------------------- billing ---
# Charging applies to the server-side conversion only. The browser editors run
# on the customer's own machine, so a payment check inside them could be lifted
# by anyone who looked; gating them would be a sign, not a lock.
#
# Everything here is off by default. The service only starts asking for money
# when it is switched on AND has somewhere to record what it sold.
BILLING_ON = os.environ.get("PDF_BILLING", "").strip().lower() in {"1", "on", "true", "yes"}
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()

# Conversions allowed per day before payment is asked for, counted against a
# salted hash of the caller's address.
FREE_PER_DAY = max(0, int(os.environ.get("PDF_FREE_PER_DAY", "1")))

# What can be bought: "credits:price" pairs, e.g. "10:2.00,25:4.00". Left empty
# on purpose - the right size and price come from real usage, not from a guess
# baked into the source.
PACKS_RAW = os.environ.get("PDF_PACKS", "").strip()
CURRENCY = os.environ.get("PDF_CURRENCY", "GBP").strip().upper()
CURRENCY_SYMBOL = os.environ.get("PDF_CURRENCY_SYMBOL", "£").strip()

# Secret that makes the daily caller hash unguessable. Without it the hash of an
# address could be worked out by anyone who tried every address, which would
# defeat the point of hashing at all.
BILLING_SALT = os.environ.get("PDF_BILLING_SALT", "").strip()

PAYPAL_CLIENT_ID = os.environ.get("PAYPAL_CLIENT_ID", "").strip()
PAYPAL_SECRET = os.environ.get("PAYPAL_SECRET", "").strip()
PAYPAL_ENV = os.environ.get("PAYPAL_ENV", "sandbox").strip().lower()
