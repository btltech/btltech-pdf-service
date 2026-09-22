"""Shared configuration for the BTL Tech PDF services."""

import os

# Upload ceiling, in MB, applied to every endpoint.
MAX_UPLOAD_MB = int(os.environ.get("PDF2WORD_MAX_MB", "50"))

# Where the service listens.
HOST = os.environ.get("PDF2WORD_HOST", "0.0.0.0")
PORT = int(os.environ.get("PDF2WORD_PORT", "8000"))