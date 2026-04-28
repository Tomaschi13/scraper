#!/usr/bin/env bash
set -euo pipefail

# Runs on the production server after rsync. Installs runner deps,
# ensures the cloakbrowser stealth Chromium binary is present, and
# restarts scraper-portal. Assumes CWD is /opt/runner. Configure via env:
#   RESTART_COMMAND  (required, e.g. sudo /usr/bin/systemctl restart scraper-portal)

: "${RESTART_COMMAND:?RESTART_COMMAND must be set}"

export NODE_ENV=production
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

echo "Installing runner production dependencies..."
/usr/bin/npm ci --omit=dev

# cloakbrowser ships its own patched Chromium and would auto-download it
# on first launch — but we pre-fetch here so the first run after deploy
# isn't slowed (or blocked) by a ~200MB download. Cached at ~/.cloakbrowser/.
echo "Ensuring cloakbrowser Chromium binary is installed..."
/usr/bin/npx --no-install cloakbrowser install

echo "Restarting scraper-portal service..."
bash -lc "$RESTART_COMMAND"

echo "Deploy complete."
