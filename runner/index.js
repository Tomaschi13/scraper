#!/usr/bin/env node
"use strict";

const os = require("node:os");
const path = require("node:path");
const process = require("node:process");
const {
  getBlockedPageError
} = require("../Scraper/background/run-lifecycle-helpers.js");

let chromium;
const RUNNER_EVENT_PREFIX = "RUNNER_EVENT ";
const RUN_SOURCE = {
  portalServer: "PORTAL_SERVER"
};
const DEFAULT_START_URL_WARMUP_TIMEOUT_MS = 45_000;
const DEFAULT_START_URL_WARMUP_POLL_INTERVAL_MS = 750;
const DEFAULT_START_URL_WARMUP_RELOAD_AFTER_MS = 12_000;

const STEALTH_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const STEALTH_LOCALE = "en-US";
const STEALTH_TIMEZONE = "Europe/Vilnius";
const STEALTH_VIEWPORT = { width: 1440, height: 900 };
const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process,AutomationControlled",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-infobars",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--lang=en-US,en"
];
const STEALTH_EXTRA_HEADERS = {
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-CH-UA": "\"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\", \"Google Chrome\";v=\"131\"",
  "Sec-CH-UA-Mobile": "?0",
  "Sec-CH-UA-Platform": "\"macOS\""
};

const STEALTH_INIT_SCRIPT = `
  try {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined });
  } catch (_err) {}
  try {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  } catch (_err) {}
  try {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format' }
      ]
    });
  } catch (_err) {}
  try {
    window.chrome = window.chrome || { runtime: {}, loadTimes: function () {}, csi: function () {}, app: {} };
  } catch (_err) {}
  try {
    const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters && parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery.call(window.navigator.permissions, parameters)
      );
    }
  } catch (_err) {}
  try {
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (parameter) {
      if (parameter === 37445) return 'Intel Inc.';
      if (parameter === 37446) return 'Intel Iris OpenGL Engine';
      return getParameter.call(this, parameter);
    };
  } catch (_err) {}
`;

function loadChromium() {
  if (chromium) {
    return chromium;
  }

  try {
    ({ chromium } = require("playwright"));
    return chromium;
  } catch (error) {
    console.error("The runner needs the \"playwright\" package.");  // eslint-disable-line no-console
    console.error("Install it with: npm install --prefix runner");  // eslint-disable-line no-console
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    if (key === "headless") {
      options.headless = true;
      continue;
    }

    if (key === "headed" || key === "no-headless") {
      options.headless = false;
      continue;
    }

    if (key === "help") {
      options.help = true;
      continue;
    }

    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }

    options[key] = next;
    index += 1;
  }

  return options;
}

function resolveBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function resolveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePortalOrigin(origin) {
  const fallback = "http://127.0.0.1:5077";
  if (typeof origin !== "string" || !origin.trim()) {
    return fallback;
  }

  const trimmed = origin.trim().replace(/\/+$/, "");

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return fallback;
    }

    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch (_error) {
    return fallback;
  }
}

function parseJsonOption(rawValue, label) {
  if (typeof rawValue !== "string" || !rawValue.trim()) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch (error) {
    throw new Error(`Could not parse ${label} as JSON: ${error.message}`);
  }
}

function emitRunnerEvent(event, payload = {}) {
  console.log(`${RUNNER_EVENT_PREFIX}${JSON.stringify({ event, ...payload })}`);  // eslint-disable-line no-console
}

function usage() {
  return [
    "Usage:",
    "  npm start --prefix runner -- --portal-origin https://portal.example.com --email admin@example.com --password secret --robot-id robot_123",
    "",
    "Options:",
    "  --portal-origin      Portal base URL. Default: http://127.0.0.1:5077",
    "  --email              Portal login email",
    "  --password           Portal login password",
    "  --robot-id           Portal robot id to run",
    "  --step               Starting step name. Default: start",
    "  --start-url          Optional start URL override",
    "  --tag                Optional run tag override",
    "  --params-json        Optional JSON payload for step params",
    "  --config-json        Optional JSON payload for run config",
    "  --user-data-dir      Persistent Chromium profile directory",
    "  --extension-path     Extension source directory. Default: ../Scraper",
    "  --headless           Run Chromium headless",
    "  --headed             Run Chromium headed (recommended first with Xvfb on servers)",
    "  --poll-interval-ms   Run status polling interval. Default: 2000",
    "  --help               Show this message"
  ].join("\n");
}

function buildConfig(options) {
  const robotId = String(options["robot-id"] || process.env.ROBOT_ID || "").trim();
  const profileSuffix = robotId ? robotId.replace(/[^a-zA-Z0-9_-]+/g, "-") : "default";

  return {
    portalOrigin: normalizePortalOrigin(options["portal-origin"] || process.env.PORTAL_ORIGIN),
    email: String(options.email || process.env.PORTAL_EMAIL || "").trim(),
    password: String(options.password || process.env.PORTAL_PASSWORD || ""),
    robotId,
    step: String(options.step || process.env.ROBOT_STEP || "start").trim() || "start",
    startUrl: String(options["start-url"] || process.env.ROBOT_START_URL || "").trim(),
    tag: String(options.tag || process.env.ROBOT_TAG || "").trim(),
    params: parseJsonOption(options["params-json"] || process.env.ROBOT_PARAMS_JSON, "params-json"),
    runConfig: parseJsonOption(options["config-json"] || process.env.ROBOT_CONFIG_JSON, "config-json"),
    headless: resolveBoolean(
      options.headless !== undefined ? options.headless : process.env.RUNNER_HEADLESS,
      false
    ),
    pollIntervalMs: resolveInteger(
      options["poll-interval-ms"] || process.env.RUNNER_POLL_INTERVAL_MS,
      2000
    ),
    userDataDir: path.resolve(
      options["user-data-dir"]
        || process.env.RUNNER_USER_DATA_DIR
        || path.join(os.tmpdir(), "scraper-runner", profileSuffix)
    ),
    extensionPath: path.resolve(
      options["extension-path"]
        || process.env.RUNNER_EXTENSION_PATH
        || path.join(__dirname, "..", "Scraper")
    )
  };
}

function validateConfig(config) {
  const missing = [];

  if (!config.email) missing.push("--email");
  if (!config.password) missing.push("--password");
  if (!config.robotId) missing.push("--robot-id");

  if (missing.length) {
    throw new Error(`Missing required options: ${missing.join(", ")}`);
  }
}

async function waitForServiceWorker(context) {
  const existing = context.serviceWorkers();
  if (existing.length) {
    return existing[0];
  }

  return context.waitForEvent("serviceworker");
}

function getExtensionId(serviceWorker) {
  const url = new URL(serviceWorker.url());
  return url.host;
}

async function createBridgePage(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/runner/bridge.html`);
  await page.waitForFunction(() => Boolean(globalThis.scraperRunnerBridge));
  return page;
}

async function callBridge(page, method, payload) {
  return page.evaluate(async ({ bridgeMethod, bridgePayload }) => {
    const bridge = globalThis.scraperRunnerBridge;
    if (!bridge || typeof bridge[bridgeMethod] !== "function") {
      throw new Error(`Bridge method is unavailable: ${bridgeMethod}`);
    }

    return bridge[bridgeMethod](bridgePayload);
  }, {
    bridgeMethod: method,
    bridgePayload: payload
  });
}

function buildStartPayload(config) {
  return {
    robotId: config.robotId,
    runSource: RUN_SOURCE.portalServer,
    ...(config.step ? { step: config.step } : {}),
    ...(config.startUrl ? { url: config.startUrl } : {}),
    ...(config.tag ? { tag: config.tag } : {}),
    ...(config.params ? { params: config.params } : {}),
    ...(config.runConfig ? { config: config.runConfig } : {})
  };
}

function getRunFromState(state, runId) {
  if (!state) {
    return null;
  }

  if (state.selectedRun?.id === runId) {
    return state.selectedRun;
  }

  return Array.isArray(state.runs)
    ? state.runs.find((run) => run.id === runId) || null
    : null;
}

function resolveRobotStartUrl(config, refreshResult) {
  if (config.startUrl) {
    return config.startUrl;
  }

  const robots = Array.isArray(refreshResult?.state?.robots) ? refreshResult.state.robots : [];
  const matchedRobot = robots.find((robot) => String(robot?.id || "").trim() === config.robotId);
  return String(matchedRobot?.url || "").trim();
}

async function humanizePage(page) {
  try {
    const { width, height } = STEALTH_VIEWPORT;
    await page.mouse.move(Math.floor(width * 0.3), Math.floor(height * 0.4));
    await page.waitForTimeout(250 + Math.floor(Math.random() * 400));
    await page.mouse.move(Math.floor(width * 0.55), Math.floor(height * 0.6), { steps: 8 });
    await page.waitForTimeout(150 + Math.floor(Math.random() * 250));
    await page.mouse.wheel(0, 120);
  } catch (_error) {
    // Humanization is best-effort; ignore failures.
  }
}

async function waitForRunnablePage(page, {
  timeoutMs = DEFAULT_START_URL_WARMUP_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_START_URL_WARMUP_POLL_INTERVAL_MS,
  reloadAfterMs = DEFAULT_START_URL_WARMUP_RELOAD_AFTER_MS,
  startUrl = ""
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastBlockedError = "";
  let lastReloadAt = Date.now();
  let humanized = false;

  for (;;) {
    const pageTitle = await page.title().catch(() => "");
    const pageUrl = typeof page.url === "function" ? page.url() : "";
    const blockedPageError = getBlockedPageError({ pageTitle, pageUrl });

    if (!blockedPageError) {
      return {
        pageTitle,
        pageUrl
      };
    }

    lastBlockedError = blockedPageError;

    if (!humanized) {
      humanized = true;
      await humanizePage(page);
    }

    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for the start page to clear. ${lastBlockedError}`);
    }

    if (startUrl && Date.now() - lastReloadAt >= reloadAfterMs) {
      lastReloadAt = Date.now();
      try {
        await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch (_error) {
        // Retry via polling; the next iteration will re-check the page state.
      }
    }

    await page.waitForTimeout(Math.min(pollIntervalMs, Math.max(deadline - Date.now(), 0)));
  }
}

async function warmRobotStartUrl(context, startUrl) {
  if (!startUrl) {
    return null;
  }

  const page = await context.newPage();

  try {
    // Warm the origin with a referer-less visit to the site root when possible,
    // so the actual target request carries realistic cookies/session state.
    try {
      const origin = new URL(startUrl).origin;
      if (origin && origin !== startUrl) {
        await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => null);
        await page.waitForTimeout(1_200 + Math.floor(Math.random() * 800));
      }
    } catch (_error) {
      // Ignore URL parsing issues and fall through to the direct navigation.
    }

    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    return await waitForRunnablePage(page, { startUrl });
  } finally {
    await page.close().catch(() => null);
  }
}

async function monitorRun(page, runId, intervalMs) {
  let previousSummary = "";
  let seenLogCount = 0;

  for (;;) {
    const response = await callBridge(page, "getState");
    const run = getRunFromState(response?.state, runId);

    if (!run) {
      throw new Error(`Run ${runId} is no longer visible in extension state.`);
    }

    if (Array.isArray(run.logs) && run.logs.length > seenLogCount) {
      const nextLogs = run.logs.slice(seenLogCount);
      for (const entry of nextLogs) {
        console.log(entry);  // eslint-disable-line no-console
      }
      seenLogCount = run.logs.length;
    }

    const summary = `[run ${run.id}] status=${run.status} phase=${run.phase} queue=${run.queueLength} rows=${run.rows} emits=${run.emits} failures=${run.failures}`;
    if (summary !== previousSummary) {
      console.log(summary);  // eslint-disable-line no-console
      previousSummary = summary;
    }

    if (run.status !== "RUNNING") {
      return run;
    }

    await page.waitForTimeout(intervalMs);
  }
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());  // eslint-disable-line no-console
    return;
  }

  const config = buildConfig(options);
  validateConfig(config);

  let context;

  try {
    const browserChromium = loadChromium();

    context = await browserChromium.launchPersistentContext(config.userDataDir, {
      channel: "chromium",
      headless: config.headless,
      userAgent: STEALTH_USER_AGENT,
      locale: STEALTH_LOCALE,
      timezoneId: STEALTH_TIMEZONE,
      viewport: STEALTH_VIEWPORT,
      extraHTTPHeaders: STEALTH_EXTRA_HEADERS,
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        ...STEALTH_LAUNCH_ARGS,
        `--disable-extensions-except=${config.extensionPath}`,
        `--load-extension=${config.extensionPath}`
      ]
    });

    await context.addInitScript(STEALTH_INIT_SCRIPT);

    const serviceWorker = await waitForServiceWorker(context);
    const extensionId = getExtensionId(serviceWorker);
    const bridgePage = await createBridgePage(context, extensionId);

    await callBridge(bridgePage, "configurePortal", config.portalOrigin);
    const loginResult = await callBridge(bridgePage, "login", {
      email: config.email,
      password: config.password
    });

    console.log(`Authenticated as ${loginResult.user.email} against ${loginResult.portalOrigin}`);  // eslint-disable-line no-console

    const refreshResult = await callBridge(bridgePage, "refreshRobots");
    const robotCount = Array.isArray(refreshResult?.state?.robots) ? refreshResult.state.robots.length : 0;
    console.log(`Loaded ${robotCount} robot(s) from the portal.`);  // eslint-disable-line no-console

    const resolvedStartUrl = resolveRobotStartUrl(config, refreshResult);
    if (resolvedStartUrl) {
      console.log(`Priming start URL ${resolvedStartUrl} before starting the run.`);  // eslint-disable-line no-console
      const warmedPage = await warmRobotStartUrl(context, resolvedStartUrl);
      console.log(`Start URL is runnable at ${warmedPage.pageUrl}.`);  // eslint-disable-line no-console
    }

    const startResponse = await callBridge(bridgePage, "startRun", buildStartPayload(config));
    const runSummary = startResponse?.run;
    if (!runSummary?.id) {
      throw new Error("The extension did not return a run id.");
    }

    emitRunnerEvent("RUN_STARTED", {
      runId: runSummary.id,
      robotId: runSummary.robotId,
      startedAt: runSummary.startedAt || new Date().toISOString()
    });
    console.log(`Started run ${runSummary.id} for robot ${runSummary.robotId}.`);  // eslint-disable-line no-console

    const finalRun = await monitorRun(bridgePage, runSummary.id, config.pollIntervalMs);
    emitRunnerEvent(
      finalRun.status === "FINISHED"
        ? "RUN_FINISHED"
        : (finalRun.status === "ABORTED" ? "RUN_ABORTED" : "RUN_FAILED"),
      {
        runId: finalRun.id,
        robotId: finalRun.robotId,
        finishedAt: finalRun.finishedAt || null,
        status: finalRun.status
      }
    );
    console.log(JSON.stringify({ ok: true, run: finalRun }, null, 2));  // eslint-disable-line no-console

    if (finalRun.status !== "FINISHED") {
      process.exitCode = 1;
    }
  } finally {
    if (context) {
      await context.close();
    }
  }
}

if (require.main === module) {
  run().catch((error) => {
    emitRunnerEvent("RUN_ERROR", {
      message: error instanceof Error ? error.message : String(error)
    });
    console.error(error instanceof Error ? error.message : String(error));  // eslint-disable-line no-console
    process.exitCode = 1;
  });
}

module.exports = {
  buildConfig,
  buildStartPayload,
  getRunFromState,
  resolveRobotStartUrl,
  waitForRunnablePage,
  warmRobotStartUrl
};
