# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Shared configuration for the BTL Tech PDF services."""

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
# PayPal donate link, or anything else). When it is empty - the default - no
# support link is rendered anywhere. Nothing is ever gated behind it: the tools
# are free, the source is published, and a paywall on code that runs in the
# customer's own browser would be theatre rather than a lock.
#
# It is a plain link on purpose. Embedding a payment provider's JavaScript would
# put third-party code on pages that promise the document never leaves the tab,
# and that promise is worth more than the convenience.
SUPPORT_URL = os.environ.get("PDF_SUPPORT_URL", "").strip()
SUPPORT_LABEL = os.environ.get("PDF_SUPPORT_LABEL", "Support this tool").strip()
