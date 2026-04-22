#!/usr/bin/env bash
set -euo pipefail

# Runs on the production server after rsync. Installs runner deps,
# ensures Playwright Chromium is present, and restarts scraper-portal.
# Assumes CWD is /opt/runner. Configure via env:
#   PLAYWRIGHT_BROWSERS_PATH   (required, e.g. /opt/ms-playwright)
#   RESTART_COMMAND            (required, e.g. sudo /usr/bin/systemctl restart scraper-portal)

: "${PLAYWRIGHT_BROWSERS_PATH:?PLAYWRIGHT_BROWSERS_PATH must be set}"
: "${RESTART_COMMAND:?RESTART_COMMAND must be set}"

export NODE_ENV=production
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"

echo "Installing runner production dependencies..."
/usr/bin/npm ci --omit=dev

echo "Ensuring Playwright Chromium is installed..."
/usr/bin/npx playwright install chromium

echo "Restarting scraper-portal service..."
bash -lc "$RESTART_COMMAND"

echo "Deploy complete."
