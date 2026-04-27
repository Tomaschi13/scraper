#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
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
const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143
};

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
const CONTROL_PLANE_PROXY_BYPASS_HOSTS = [
  "127.0.0.1",
  "localhost",
  "::1"
];

// In-house stealth payload. Mirrors the evasions from
// puppeteer-extra-plugin-stealth without the plugin's chrome.tabs-breaking
// hooks. Runs before every page script via context.addInitScript.
const STEALTH_INIT_SCRIPT = `
  (function () {
    // Only run on real web pages. chrome-extension:// and devtools:// contexts
    // must be left untouched — patching Function.prototype.toString or chrome.*
    // there breaks the extension's bridge page and chrome.tabs messaging.
    try {
      const proto = location.protocol;
      if (proto === 'chrome-extension:' || proto === 'devtools:' || proto === 'chrome:' || proto === 'about:') {
        return;
      }
    } catch (_err) { /* no location — bail */ return; }

    // Make an overridden function look native when inspected via toString().
    // CF and similar bot checks compare fn.toString() to a native-code string.
    const nativeToString = Function.prototype.toString;
    const toStringMap = new WeakMap();
    Function.prototype.toString = new Proxy(nativeToString, {
      apply(target, thisArg, args) {
        if (toStringMap.has(thisArg)) {
          return toStringMap.get(thisArg);
        }
        return target.apply(thisArg, args);
      }
    });
    const markNative = (fn, name) => {
      toStringMap.set(fn, 'function ' + name + '() { [native code] }');
      return fn;
    };

    // navigator.webdriver — delete from prototype so 'webdriver' in navigator is false.
    try {
      delete Object.getPrototypeOf(navigator).webdriver;
    } catch (_err) {}
    try {
      Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true });
    } catch (_err) {}

    // navigator.languages
    try {
      Object.defineProperty(Navigator.prototype, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    } catch (_err) {}

    // navigator.hardwareConcurrency / deviceMemory — stable, plausible values.
    try {
      Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => 8, configurable: true });
    } catch (_err) {}
    try {
      Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => 8, configurable: true });
    } catch (_err) {}

    // navigator.plugins + mimeTypes — mimic a real Chrome's PDF set (3 plugins, 2 mimeTypes).
    try {
      const mimePdf = Object.create(MimeType.prototype);
      Object.defineProperties(mimePdf, {
        type: { value: 'application/pdf' },
        suffixes: { value: 'pdf' },
        description: { value: 'Portable Document Format' }
      });
      const mimeOctet = Object.create(MimeType.prototype);
      Object.defineProperties(mimeOctet, {
        type: { value: 'text/pdf' },
        suffixes: { value: 'pdf' },
        description: { value: 'Portable Document Format' }
      });
      const buildPlugin = (name, desc) => {
        const p = Object.create(Plugin.prototype);
        Object.defineProperties(p, {
          name: { value: name },
          filename: { value: 'internal-pdf-viewer' },
          description: { value: desc },
          length: { value: 1 },
          0: { value: mimePdf }
        });
        return p;
      };
      const plugins = [
        buildPlugin('PDF Viewer', 'Portable Document Format'),
        buildPlugin('Chrome PDF Viewer', 'Portable Document Format'),
        buildPlugin('Chromium PDF Viewer', 'Portable Document Format'),
        buildPlugin('Microsoft Edge PDF Viewer', 'Portable Document Format'),
        buildPlugin('WebKit built-in PDF', 'Portable Document Format')
      ];
      Object.defineProperty(plugins, 'refresh', { value: () => {} });
      Object.setPrototypeOf(plugins, PluginArray.prototype);
      Object.defineProperty(Navigator.prototype, 'plugins', { get: () => plugins, configurable: true });

      const mimeTypes = [mimePdf, mimeOctet];
      Object.setPrototypeOf(mimeTypes, MimeTypeArray.prototype);
      Object.defineProperty(Navigator.prototype, 'mimeTypes', { get: () => mimeTypes, configurable: true });
    } catch (_err) {}

    // window.chrome — populate the fields real Chrome has. Bot-detection JS
    // frequently checks chrome.runtime, chrome.csi, chrome.loadTimes.
    try {
      if (!window.chrome) {
        Object.defineProperty(window, 'chrome', { value: {}, writable: true, configurable: true });
      }
      const chromeObj = window.chrome;
      chromeObj.app = chromeObj.app || {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
      };
      chromeObj.runtime = chromeObj.runtime || {
        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' }
      };
      if (!chromeObj.csi) {
        chromeObj.csi = markNative(function csi() {
          return { onloadT: Date.now(), startE: Date.now(), pageT: 1234, tran: 15 };
        }, 'csi');
      }
      if (!chromeObj.loadTimes) {
        chromeObj.loadTimes = markNative(function loadTimes() {
          return {
            requestTime: Date.now() / 1000,
            startLoadTime: Date.now() / 1000,
            commitLoadTime: Date.now() / 1000,
            finishDocumentLoadTime: Date.now() / 1000,
            finishLoadTime: Date.now() / 1000,
            firstPaintTime: Date.now() / 1000,
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: 'h2',
            wasAlternateProtocolAvailable: false,
            connectionInfo: 'h2'
          };
        }, 'loadTimes');
      }
    } catch (_err) {}

    // Notifications permissions query parity.
    try {
      const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
      if (originalQuery) {
        const patched = function query(parameters) {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission, onchange: null });
          }
          return originalQuery.call(window.navigator.permissions, parameters);
        };
        markNative(patched, 'query');
        window.navigator.permissions.query = patched;
      }
    } catch (_err) {}

    // WebGL vendor/renderer — spoof for both GL1 and GL2 contexts.
    try {
      const UNMASKED_VENDOR_WEBGL = 37445;
      const UNMASKED_RENDERER_WEBGL = 37446;
      const patchGetParameter = (proto) => {
        if (!proto || !proto.getParameter) return;
        const original = proto.getParameter;
        const patched = function getParameter(parameter) {
          if (parameter === UNMASKED_VENDOR_WEBGL) return 'Intel Inc.';
          if (parameter === UNMASKED_RENDERER_WEBGL) return 'Intel Iris OpenGL Engine';
          return original.call(this, parameter);
        };
        markNative(patched, 'getParameter');
        proto.getParameter = patched;
      };
      if (typeof WebGLRenderingContext !== 'undefined') patchGetParameter(WebGLRenderingContext.prototype);
      if (typeof WebGL2RenderingContext !== 'undefined') patchGetParameter(WebGL2RenderingContext.prototype);
    } catch (_err) {}

    // Battery API — return a sane, full-charge-ish reading.
    try {
      if (navigator.getBattery) {
        const batt = { charging: true, chargingTime: 0, dischargingTime: Infinity, level: 1, onchargingchange: null, onchargingtimechange: null, ondischargingtimechange: null, onlevelchange: null, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true };
        const patched = function getBattery() { return Promise.resolve(batt); };
        markNative(patched, 'getBattery');
        Navigator.prototype.getBattery = patched;
      }
    } catch (_err) {}

    // navigator.connection — real Chrome always has one.
    try {
      if (!navigator.connection || navigator.connection.rtt === 0) {
        const connection = {
          effectiveType: '4g',
          rtt: 50,
          downlink: 10,
          saveData: false,
          type: 'wifi',
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => true
        };
        Object.defineProperty(Navigator.prototype, 'connection', { get: () => connection, configurable: true });
      }
    } catch (_err) {}

    // MediaCodecs — make canPlayType return the same strings real Chrome does.
    try {
      if (typeof HTMLMediaElement !== 'undefined') {
        const original = HTMLMediaElement.prototype.canPlayType;
        const patched = function canPlayType(type) {
          if (!type) return '';
          const normalized = String(type).toLowerCase();
          if (normalized.includes('video/mp4')) return 'probably';
          if (normalized.includes('video/ogg')) return 'probably';
          if (normalized.includes('video/webm')) return 'probably';
          if (normalized.includes('audio/mpeg')) return 'probably';
          return original.call(this, type);
        };
        markNative(patched, 'canPlayType');
        HTMLMediaElement.prototype.canPlayType = patched;
      }
    } catch (_err) {}

    // iframe.contentWindow.chrome parity — ensure sub-frames also look real.
    try {
      const getContentWindow = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
      if (getContentWindow && getContentWindow.get) {
        const originalGet = getContentWindow.get;
        Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
          configurable: true,
          get: function () {
            const w = originalGet.call(this);
            try { if (w && !w.chrome) Object.defineProperty(w, 'chrome', { value: window.chrome }); } catch (_e) {}
            return w;
          }
        });
      }
    } catch (_err) {}
  })();
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

function createGracefulShutdownController({
  processImpl = process,
  logger = console
} = {}) {
  let context = null;
  let closePromise = null;
  let shutdownPromise = null;
  const handlers = new Map();

  async function closeContext(reason = "shutdown") {
    if (closePromise) {
      return closePromise;
    }

    const activeContext = context;
    context = null;

    if (!activeContext || typeof activeContext.close !== "function") {
      return false;
    }

    closePromise = Promise.resolve()
      .then(() => activeContext.close())
      .then(() => true)
      .catch((error) => {
        if (logger && typeof logger.error === "function") {
          logger.error(`Could not close Chromium context during ${reason}: ${error?.message || error}`);  // eslint-disable-line no-console
        }
        if (processImpl && !processImpl.exitCode) {
          processImpl.exitCode = 1;
        }
        return false;
      });

    return closePromise;
  }

  function requestShutdown(signal) {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    const exitCode = SIGNAL_EXIT_CODES[signal] || 1;
    if (processImpl && !processImpl.exitCode) {
      processImpl.exitCode = exitCode;
    }

    if (logger && typeof logger.log === "function") {
      logger.log(`Received ${signal}; closing Chromium before exiting.`);  // eslint-disable-line no-console
    }

    shutdownPromise = closeContext(signal)
      .finally(() => {
        if (processImpl && typeof processImpl.exit === "function") {
          processImpl.exit(processImpl.exitCode || exitCode);
        }
      });

    return shutdownPromise;
  }

  function install() {
    if (!processImpl || typeof processImpl.once !== "function") {
      return;
    }

    ["SIGTERM", "SIGINT"].forEach((signal) => {
      if (handlers.has(signal)) {
        return;
      }

      const handler = () => {
        void requestShutdown(signal);
      };
      handlers.set(signal, handler);
      processImpl.once(signal, handler);
    });
  }

  function dispose() {
    if (!processImpl || typeof processImpl.off !== "function") {
      handlers.clear();
      return;
    }

    handlers.forEach((handler, signal) => {
      processImpl.off(signal, handler);
    });
    handlers.clear();
  }

  return {
    setContext(nextContext) {
      context = nextContext || null;
    },
    clearContext() {
      context = null;
    },
    closeContext,
    requestShutdown,
    install,
    dispose
  };
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
    "  --browser-channel    Playwright channel: chromium | chrome | msedge. Default: chromium",
    "  --proxy-server       Upstream proxy, e.g. http://host:port or socks5://host:port",
    "  --proxy-username     Proxy auth username (optional)",
    "  --proxy-password     Proxy auth password (optional)",
    "  --proxy-bypass       Additional comma-separated proxy bypass list",
    "  --headless           Run Chromium headless",
    "  --headed             Run Chromium headed (recommended first with Xvfb on servers)",
    "  --poll-interval-ms   Run status polling interval. Default: 2000",
    "  --help               Show this message"
  ].join("\n");
}

function buildConfig(options) {
  const robotId = String(options["robot-id"] || process.env.ROBOT_ID || "").trim();
  const profileSuffix = robotId ? robotId.replace(/[^a-zA-Z0-9_-]+/g, "-") : "default";
  const portalOrigin = normalizePortalOrigin(options["portal-origin"] || process.env.PORTAL_ORIGIN);

  return {
    portalOrigin,
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
    ),
    browserChannel: String(
      options["browser-channel"]
        || process.env.RUNNER_BROWSER_CHANNEL
        || "chromium"
    ).trim() || "chromium",
    proxy: buildProxyConfig(options, { portalOrigin })
  };
}

function normalizeProxyBypassHost(value) {
  return String(value || "").trim().replace(/^\[|\]$/g, "");
}

function addProxyBypassEntry(entries, seen, value) {
  const entry = normalizeProxyBypassHost(value);
  if (!entry) {
    return;
  }

  const key = entry.toLowerCase();
  if (seen.has(key)) {
    return;
  }

  seen.add(key);
  entries.push(entry);
}

function getPortalProxyBypassHosts(portalOrigin) {
  const hosts = [];

  try {
    const parsed = new URL(portalOrigin);
    const hostname = normalizeProxyBypassHost(parsed.hostname);
    if (hostname) {
      hosts.push(hostname);
    }
  } catch (_error) {
    // Invalid portal origins are normalized elsewhere; keep the fallback hosts.
  }

  hosts.push(...CONTROL_PLANE_PROXY_BYPASS_HOSTS);
  return hosts;
}

function buildProxyBypassList(explicitBypass, portalOrigin) {
  const entries = [];
  const seen = new Set();

  String(explicitBypass || "")
    .split(",")
    .forEach((entry) => addProxyBypassEntry(entries, seen, entry));

  getPortalProxyBypassHosts(portalOrigin)
    .forEach((entry) => addProxyBypassEntry(entries, seen, entry));

  return entries.join(",");
}

function buildProxyConfig(options, { portalOrigin = "" } = {}) {
  const server = String(options["proxy-server"] || process.env.RUNNER_PROXY_SERVER || "").trim();
  if (!server) {
    return null;
  }

  const normalizedServer = /^[a-z][a-z0-9+.-]*:\/\//i.test(server) ? server : `http://${server}`;
  const username = String(options["proxy-username"] || process.env.RUNNER_PROXY_USERNAME || "").trim();
  const password = String(options["proxy-password"] || process.env.RUNNER_PROXY_PASSWORD || "");
  const bypass = buildProxyBypassList(
    options["proxy-bypass"] || process.env.RUNNER_PROXY_BYPASS,
    portalOrigin
  );

  const config = { server: normalizedServer };
  if (username) {
    config.username = username;
  }
  if (password) {
    config.password = password;
  }
  if (bypass) {
    config.bypass = bypass;
  }
  return config;
}

function describeProxy(proxy) {
  if (!proxy || !proxy.server) {
    return "none";
  }
  try {
    const parsed = new URL(proxy.server);
    const auth = proxy.username ? `${proxy.username}:***@` : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch (_error) {
    return proxy.username ? `${proxy.username}:***@${proxy.server}` : proxy.server;
  }
}

function computeUnpackedExtensionId(extensionPath) {
  const normalized = path.resolve(extensionPath);
  const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return hash.replace(/[0-9a-f]/g, (c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)));
}

function seedExtensionPreferences(userDataDir, extensionPath) {
  const extensionId = computeUnpackedExtensionId(extensionPath);
  const defaultDir = path.join(userDataDir, "Default");
  fs.mkdirSync(defaultDir, { recursive: true });
  const prefsPath = path.join(defaultDir, "Preferences");
  let prefs = {};
  try {
    prefs = JSON.parse(fs.readFileSync(prefsPath, "utf8"));
  } catch (_error) {
    prefs = {};
  }
  prefs.extensions = prefs.extensions || {};
  prefs.extensions.ui = prefs.extensions.ui || {};
  prefs.extensions.ui.developer_mode = true;
  prefs.extensions.settings = prefs.extensions.settings || {};
  prefs.extensions.settings[extensionId] = prefs.extensions.settings[extensionId] || {};
  prefs.extensions.settings[extensionId].user_scripts_allowed = true;
  fs.writeFileSync(prefsPath, JSON.stringify(prefs));
  return extensionId;
}

const EXTENSION_FINGERPRINT_FILE = ".scraper-extension-fingerprint";
const CACHED_SCRIPT_DIRS = [
  ["Default", "Service Worker", "ScriptCache"],
  ["Default", "Service Worker", "CacheStorage"],
  ["Default", "Code Cache"]
];
const CACHE_INVALIDATION_FILE_EXTENSIONS = new Set([
  ".js", ".mjs", ".cjs", ".html", ".json", ".css"
]);

function computeExtensionFingerprint(extensionPath) {
  const root = path.resolve(extensionPath);
  const stack = [root];
  let maxMtimeMs = 0;
  let fileCount = 0;

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_error) {
      continue;
    }
    for (const entry of entries) {
      // Skip hidden / nested deps; we only care about source the extension actually loads.
      if (entry.name === "node_modules" || entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!CACHE_INVALIDATION_FILE_EXTENSIONS.has(ext)) {
        continue;
      }
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs > maxMtimeMs) {
          maxMtimeMs = stat.mtimeMs;
        }
        fileCount += 1;
      } catch (_error) {
        // Vanished between readdir and stat — ignore.
      }
    }
  }

  // Include file count so adding/removing a file invalidates even when mtimes
  // happen to coincide (e.g. a checkout that touches no files).
  return `${Math.floor(maxMtimeMs)}:${fileCount}`;
}

function invalidateExtensionScriptCacheIfStale(userDataDir, extensionPath, { logger = console } = {}) {
  const resolvedUserDataDir = path.resolve(userDataDir);
  const fingerprintPath = path.join(resolvedUserDataDir, EXTENSION_FINGERPRINT_FILE);
  const currentFingerprint = computeExtensionFingerprint(extensionPath);

  let storedFingerprint = "";
  try {
    storedFingerprint = fs.readFileSync(fingerprintPath, "utf8").trim();
  } catch (_error) {
    // Missing file → treat as stale (first launch with this profile).
  }

  if (storedFingerprint && storedFingerprint === currentFingerprint) {
    return false;
  }

  for (const segments of CACHED_SCRIPT_DIRS) {
    const dir = path.join(resolvedUserDataDir, ...segments);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      logger?.warn?.(`Failed to clear Chromium cache dir ${dir}: ${error?.message || error}`);
    }
  }

  try {
    fs.mkdirSync(resolvedUserDataDir, { recursive: true });
    fs.writeFileSync(fingerprintPath, currentFingerprint);
  } catch (error) {
    logger?.warn?.(`Failed to write extension fingerprint to ${fingerprintPath}: ${error?.message || error}`);
  }

  return true;
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

  return context.waitForEvent("serviceworker", { timeout: 90_000 });
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
  const shutdown = createGracefulShutdownController();
  shutdown.install();

  try {
    const browserChromium = loadChromium();

    console.log(`Upstream proxy: ${describeProxy(config.proxy)}`);  // eslint-disable-line no-console

    const seededExtensionId = seedExtensionPreferences(config.userDataDir, config.extensionPath);
    console.log(`Seeded userScripts allow-list for extension ${seededExtensionId}.`);  // eslint-disable-line no-console

    if (invalidateExtensionScriptCacheIfStale(config.userDataDir, config.extensionPath)) {
      console.log(`Cleared stale Chromium script cache for extension ${seededExtensionId}.`);  // eslint-disable-line no-console
    }

    context = await browserChromium.launchPersistentContext(config.userDataDir, {
      channel: config.browserChannel,
      headless: config.headless,
      userAgent: STEALTH_USER_AGENT,
      locale: STEALTH_LOCALE,
      timezoneId: STEALTH_TIMEZONE,
      viewport: STEALTH_VIEWPORT,
      extraHTTPHeaders: STEALTH_EXTRA_HEADERS,
      ignoreDefaultArgs: ["--enable-automation"],
      ...(config.proxy ? { proxy: config.proxy } : {}),
      args: [
        ...STEALTH_LAUNCH_ARGS,
        `--disable-extensions-except=${config.extensionPath}`,
        `--load-extension=${config.extensionPath}`
      ]
    });
    shutdown.setContext(context);

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
      try {
        const warmedPage = await warmRobotStartUrl(context, resolvedStartUrl);
        console.log(`Start URL is runnable at ${warmedPage.pageUrl}.`);  // eslint-disable-line no-console
      } catch (error) {
        console.log(`Start URL warmup did not clear in time: ${error?.message || error}. Handing off to the in-run challenge handler.`);  // eslint-disable-line no-console
      }
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
    await shutdown.closeContext("runner finish");
    shutdown.dispose();
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
  buildProxyConfig,
  buildStartPayload,
  computeExtensionFingerprint,
  computeUnpackedExtensionId,
  createGracefulShutdownController,
  describeProxy,
  invalidateExtensionScriptCacheIfStale,
  seedExtensionPreferences,
  getRunFromState,
  resolveRobotStartUrl,
  waitForRunnablePage,
  warmRobotStartUrl
};
