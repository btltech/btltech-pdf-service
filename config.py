# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
"""Shared configuration for the BTL Tech PDF services."""

import os

# Upload ceiling, in MB, applied to every endpoint.
MAX_UPLOAD_MB = int(os.environ.get("PDF2WORD_MAX_MB", "50"))

# Where the service listens.
HOST = os.environ.get("PDF2WORD_HOST", "0.0.0.0")
PORT = int(os.environ.get("PDF2WORD_PORT", "8000"))

# AGPL-3.0 section 13: every user of this network service must be offered the
# source of the version they are using. /source always serves a ZIP built from
# the files actually running; these two settings add a link to the public
# repository and the exact revision, and are optional.
SOURCE_REPO_URL = os.environ.get("PDF_SOURCE_REPO_URL", "").strip()
SOURCE_VERSION = os.environ.get("PDF_SOURCE_VERSION", "").strip()
