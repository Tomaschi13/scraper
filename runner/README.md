# Scraper Runner

This worker launches **Chromium + the existing Scraper extension** and starts a
robot through the same `START_RUN` message path the IDE uses.

## Install

```bash
npm install --prefix runner
npx playwright install chromium
```

## Run one robot

```bash
npm start --prefix runner -- \
  --portal-origin https://portal.example.com \
  --email admin@example.com \
  --password your-password \
  --robot-id robot_2026-04-20T00_00_00_000Z_abcd12
```

Useful options:

- `--headed` or `--headless`
- `--portal-origin https://portal.example.com`
- `--proxy-server socks5://127.0.0.1:1080`
- `--proxy-bypass api.internal.test`
- `--user-data-dir /path/to/profile`
- `--start-url https://example.com`
- `--step start`
- `--params-json '{"page":2}'`
- `--config-json '{"skipVisited":true}'`

If `--portal-origin` is omitted, the runner falls back to `http://127.0.0.1:5077`.
When `--proxy-server` is set, the runner automatically bypasses that proxy for
the portal origin plus loopback hosts (`127.0.0.1`, `localhost`, `::1`) so
portal login and run-state sync stay on the control-plane connection. Any
entries supplied through `--proxy-bypass` or `RUNNER_PROXY_BYPASS` are preserved
and merged with those defaults.

Server runs block image loading by default before start-page warmup and robot
execution. If a server robot needs images for a specific step, call
`allowServerImages()` from the IDE script before the navigation or reload that
needs them; call `blockServerImages()` to re-disable image loading afterward.
Those helpers are no-ops for local extension runs.

## Important notes

- Use **one runner process per scraper** so each run gets its own Chromium
  profile/container.
- For best parity with local behavior, start with **headed Chromium under
  Xvfb** on the server.
- The extension depends on `chrome.userScripts`, so the Chromium profile used by
  the runner still needs **Allow User Scripts** enabled for the extension.
- The runner closes Chromium when the run finishes. If the run fails or is
  aborted, the process exits with a non-zero code.
