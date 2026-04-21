#!/usr/bin/env bash
set -euo pipefail

restart_command="${SCRAPER_DEPLOY_RESTART_COMMAND:-}"
env_file="${SCRAPER_DEPLOY_ENV_FILE:-}"
browsers_path="${SCRAPER_DEPLOY_PLAYWRIGHT_BROWSERS_PATH:-}"

if [ ! -f "Scraper/manifest.json" ] || [ ! -f "runner/package.json" ] || [ ! -f "runner/index.js" ]; then
  echo "Run this script from the scraper repo root." >&2
  exit 1
fi

if [ -n "$env_file" ]; then
  if [ ! -f "$env_file" ]; then
    echo "SCRAPER_DEPLOY_ENV_FILE points to a missing file: $env_file" >&2
    exit 1
  fi

  set -a
  # shellcheck disable=SC1090
  . "$env_file"
  set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

if [ -n "$browsers_path" ]; then
  export PLAYWRIGHT_BROWSERS_PATH="$browsers_path"
  mkdir -p "$PLAYWRIGHT_BROWSERS_PATH"
fi

echo "Installing runner dependencies..."
npm ci --omit=dev --prefix runner

echo "Ensuring Playwright Chromium is installed..."
(
  cd runner
  npx playwright install chromium
)

if [ -n "$restart_command" ]; then
  echo "Restarting scraper runner service..."
  bash -lc "$restart_command"
else
  echo "Skipping service restart because SCRAPER_DEPLOY_RESTART_COMMAND is not set."
fi

echo "Deploy complete."
