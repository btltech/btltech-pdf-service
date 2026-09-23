#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 BTLTECH LTD
#
# Run every test suite.
#
#   scripts/run_tests.sh            endpoint, release and edit-text regression suites
#   scripts/run_tests.sh --browser  also the editor, page-tools and converter UIs
#
# One-time setup:
#   python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
#   npm install                      (only for --browser; installs playwright-core)
# The browser suites need Google Chrome; set CHROME_PATH if it is not in the
# default macOS location.

set -u
cd "$(dirname "$0")/.."
PY=.venv/bin/python
FAILED=0

run() {
  echo; echo "################ $1"
  shift
  "$@" || FAILED=1
}

run "endpoints (35 assertions)" "$PY" scripts/test_tools.py
run "release checks" "$PY" scripts/test_release.py
run "paid conversion rules (46 assertions)" "$PY" scripts/test_billing.py
run "edit-text engine vs the frozen reference" node scripts/regression_edittext.mjs

if [ "${1:-}" = "--browser" ]; then
  PORT="${TEST_PORT:-8765}"
  export APP_URL="http://127.0.0.1:$PORT"
  mkdir -p test-output
  "$PY" scripts/make_test_pdf.py test-output/four.pdf >/dev/null
  "$PY" scripts/make_edittext_pdf.py test-output/edittext.pdf >/dev/null

  "$PY" -m uvicorn app:app --host 127.0.0.1 --port "$PORT" --log-level warning &
  SERVER=$!
  trap 'kill $SERVER 2>/dev/null' EXIT
  for _ in $(seq 1 50); do
    curl -sf "$APP_URL/api/health" >/dev/null && break
    sleep 0.2
  done

  run "editor in Chrome (21 assertions)" node scripts/browser_test.mjs
  run "editor output PDF (8 assertions)" "$PY" scripts/verify_editor_output.py
  run "page tools and converter in Chrome (18 assertions)" node scripts/browser_tools_test.mjs
  run "edit existing text in Chrome" node scripts/browser_edittext_test.mjs
  run "edit-text output PDF" "$PY" scripts/verify_edittext_output.py
fi

echo
if [ "$FAILED" = 0 ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit "$FAILED"
