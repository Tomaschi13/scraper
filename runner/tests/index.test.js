"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  buildProxyConfig,
  computeExtensionFingerprint,
  computeUnpackedExtensionId,
  createPortalAuthRenewal,
  createGracefulShutdownController,
  describeProxy,
  installAggressiveResourceBlocker,
  invalidateExtensionScriptCacheIfStale,
  isServerImagesAllowed,
  loadEgressHistory,
  monitorRun,
  recordEgressIp,
  resolveRobotStartUrl,
  seedExtensionPreferences,
  setServerImagesAllowedFlag,
  shouldBlockRequestForBandwidth,
  DEFAULT_RUN_STATUS_FALLBACK_INTERVAL_MS,
  PORTAL_AUTH_RENEWAL_INTERVAL_MS,
  PORTAL_AUTH_RENEWAL_RETRY_MS,
  PORTAL_AUTH_TOKEN_TTL_MS,
  STEALTH_LAUNCH_ARGS,
  waitForRunnablePage
} = require("../index.js");

function createFakePage(states) {
  let index = 0;
  const sequence = Array.isArray(states) && states.length ? states : [{ title: "", url: "" }];

  return {
    async title() {
      return sequence[Math.min(index, sequence.length - 1)].title;
    },
    url() {
      return sequence[Math.min(index, sequence.length - 1)].url;
    },
    async waitForTimeout() {
      index += 1;
    }
  };
}

function createFakeProcess() {
  const events = new EventEmitter();
  return {
    exitCode: 0,
    exitCalls: [],
    once: events.once.bind(events),
    off: events.off.bind(events),
    emit: events.emit.bind(events),
    exit(code) {
      this.exitCalls.push(code);
    }
  };
}

function createFakeTimers() {
  let nextId = 1;
  const timers = [];

  return {
    timers,
    setTimeout(fn, delay) {
      const timer = {
        id: nextId++,
        async fn() {
          this.cleared = true;
          const index = timers.indexOf(this);
          if (index !== -1) {
            timers.splice(index, 1);
          }
          return fn();
        },
        delay,
        cleared: false,
        unrefCalled: false,
        unref() {
          this.unrefCalled = true;
        }
      };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index !== -1) {
        timers.splice(index, 1);
      }
      if (timer) {
        timer.cleared = true;
      }
    }
  };
}

test("shouldBlockRequestForBandwidth aborts heavy resource types on http(s) pages", () => {
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/banner.jpg", "image"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/video.mp4", "media"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/font.woff2", "font"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/style.css", "stylesheet"), true);
});

test("shouldBlockRequestForBandwidth aborts known analytics hosts even for scripts/xhr", () => {
  assert.equal(shouldBlockRequestForBandwidth("https://www.google-analytics.com/analytics.js", "script"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://www.googletagmanager.com/gtm.js?id=GTM-X", "script"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://connect.facebook.net/en_US/fbevents.js", "script"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://stats.g.doubleclick.net/g/collect", "xhr"), true);
  assert.equal(shouldBlockRequestForBandwidth("https://api.mixpanel.com/track", "xhr"), true);
});

test("shouldBlockRequestForBandwidth allows first-party HTML, scripts, and xhr", () => {
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/products/123", "document"), false);
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/_next/static/app.js", "script"), false);
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/api/products/123", "xhr"), false);
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/api/products/123", "fetch"), false);
});

test("shouldBlockRequestForBandwidth never blocks extension or chrome:// URLs", () => {
  assert.equal(shouldBlockRequestForBandwidth("chrome-extension://abc/popup.html", "document"), false);
  assert.equal(shouldBlockRequestForBandwidth("chrome-extension://abc/banner.png", "image"), false);
  assert.equal(shouldBlockRequestForBandwidth("chrome://settings", "document"), false);
  assert.equal(shouldBlockRequestForBandwidth("devtools://devtools/bundled/inspector.html", "document"), false);
});

test("shouldBlockRequestForBandwidth lets anti-bot challenge scripts load", () => {
  assert.equal(shouldBlockRequestForBandwidth("https://challenges.cloudflare.com/turnstile/v0/api.js", "script"), false);
  assert.equal(shouldBlockRequestForBandwidth("https://www.google.com/recaptcha/api.js", "script"), false);
  assert.equal(shouldBlockRequestForBandwidth("https://hcaptcha.com/1/api.js", "script"), false);
  assert.equal(shouldBlockRequestForBandwidth("https://js.datadome.co/tags.js", "script"), false);
});

test("installAggressiveResourceBlocker registers a single context-wide route handler", async () => {
  const routes = [];
  const fakeContext = {
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    }
  };

  await installAggressiveResourceBlocker(fakeContext);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, "**/*");

  const aborted = [];
  const continued = [];
  const handler = routes[0].handler;

  const imageRoute = { abort: async () => { aborted.push("image"); } };
  await handler(imageRoute, {
    url: () => "https://shop.example.com/photo.jpg",
    resourceType: () => "image"
  });

  const docRoute = { continue: async () => { continued.push("doc"); } };
  await handler(docRoute, {
    url: () => "https://shop.example.com/products/1",
    resourceType: () => "document"
  });

  assert.deepEqual(aborted, ["image"]);
  assert.deepEqual(continued, ["doc"]);
});

test("shouldBlockRequestForBandwidth allows first-party images when imagesAllowed is true", () => {
  // Default behavior unchanged: images blocked when not explicitly allowed.
  assert.equal(shouldBlockRequestForBandwidth("https://shop.example.com/banner.jpg", "image"), true);
  assert.equal(
    shouldBlockRequestForBandwidth("https://shop.example.com/banner.jpg", "image", { imagesAllowed: false }),
    true
  );

  // With the flag flipped on, first-party image requests pass through.
  assert.equal(
    shouldBlockRequestForBandwidth("https://shop.example.com/banner.jpg", "image", { imagesAllowed: true }),
    false
  );
});

test("shouldBlockRequestForBandwidth still blocks media/font/stylesheet when imagesAllowed=true", () => {
  // The toggle is image-only — bandwidth-heavy non-image resources should
  // remain blocked. This guards against accidentally widening the toggle.
  assert.equal(
    shouldBlockRequestForBandwidth("https://shop.example.com/video.mp4", "media", { imagesAllowed: true }),
    true
  );
  assert.equal(
    shouldBlockRequestForBandwidth("https://shop.example.com/font.woff2", "font", { imagesAllowed: true }),
    true
  );
  assert.equal(
    shouldBlockRequestForBandwidth("https://shop.example.com/style.css", "stylesheet", { imagesAllowed: true }),
    true
  );
});

test("shouldBlockRequestForBandwidth still blocks analytics/ad image beacons when imagesAllowed=true", () => {
  // Pixel beacons from analytics hosts must keep being blocked even after a
  // robot script flips images on for content rendering — leaving them open
  // would defeat the host-pattern allowlist's purpose.
  assert.equal(
    shouldBlockRequestForBandwidth("https://www.google-analytics.com/collect?v=1", "image", { imagesAllowed: true }),
    true
  );
  assert.equal(
    shouldBlockRequestForBandwidth("https://stats.g.doubleclick.net/p.gif", "image", { imagesAllowed: true }),
    true
  );
});

test("setServerImagesAllowedFlag toggles the runtime flag consulted by the route handler", async () => {
  // Reset to a known state — the flag is module-scoped so other tests in
  // this file run with the default.
  setServerImagesAllowedFlag(false);
  assert.equal(isServerImagesAllowed(), false);

  setServerImagesAllowedFlag(true);
  assert.equal(isServerImagesAllowed(), true);

  // Coerces truthy/falsy values to booleans.
  setServerImagesAllowedFlag(0);
  assert.equal(isServerImagesAllowed(), false);
  setServerImagesAllowedFlag("yes");
  assert.equal(isServerImagesAllowed(), true);

  setServerImagesAllowedFlag(false);
});

test("installAggressiveResourceBlocker route handler honors the live flag", async () => {
  // The route handler reads serverImagesAllowed on every request, so flipping
  // the flag mid-run must change subsequent decisions without reinstalling
  // the handler. This is the contract that makes allowServerImages() actually
  // work for a single navigation.
  setServerImagesAllowedFlag(false);

  const routes = [];
  const fakeContext = {
    async route(pattern, handler) {
      routes.push({ pattern, handler });
    }
  };

  await installAggressiveResourceBlocker(fakeContext);
  const handler = routes[0].handler;

  const events = [];
  function imageRequest() {
    return {
      route: {
        async abort() { events.push("abort"); },
        async continue() { events.push("continue"); }
      },
      request: {
        url: () => "https://shop.example.com/photo.jpg",
        resourceType: () => "image"
      }
    };
  }

  let r = imageRequest();
  await handler(r.route, r.request);

  setServerImagesAllowedFlag(true);
  r = imageRequest();
  await handler(r.route, r.request);

  setServerImagesAllowedFlag(false);
  r = imageRequest();
  await handler(r.route, r.request);

  assert.deepEqual(events, ["abort", "continue", "abort"]);

  setServerImagesAllowedFlag(false);
});

test("resolveRobotStartUrl prefers an explicit start-url override", () => {
  const result = resolveRobotStartUrl({
    robotId: "robot_1",
    startUrl: "https://override.example.com"
  }, {
    state: {
      robots: [
        { id: "robot_1", url: "https://robot.example.com" }
      ]
    }
  });

  assert.equal(result, "https://override.example.com");
});

test("resolveRobotStartUrl falls back to the refreshed robot url", () => {
  const result = resolveRobotStartUrl({
    robotId: "robot_2",
    startUrl: ""
  }, {
    state: {
      robots: [
        { id: "robot_1", url: "https://robot-1.example.com" },
        { id: "robot_2", url: "https://robot-2.example.com" }
      ]
    }
  });

  assert.equal(result, "https://robot-2.example.com");
});

test("waitForRunnablePage waits until the tab stops looking like a Cloudflare challenge", async () => {
  const result = await waitForRunnablePage(createFakePage([
    {
      title: "Attention Required! | Cloudflare",
      url: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
    },
    {
      title: "Just a moment...",
      url: "https://www.senukai.lt/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"
    },
    {
      title: "Mobilieji telefonai",
      url: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
    }
  ]), {
    timeoutMs: 5_000,
    pollIntervalMs: 1
  });

  assert.deepEqual(result, {
    pageTitle: "Mobilieji telefonai",
    pageUrl: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
  });
});

test("waitForRunnablePage throws when the challenge never clears", async () => {
  await assert.rejects(() => waitForRunnablePage(createFakePage([
    {
      title: "Attention Required! | Cloudflare",
      url: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
    },
    {
      title: "Attention Required! | Cloudflare",
      url: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
    }
  ]), {
    timeoutMs: 0,
    pollIntervalMs: 1
  }), /Timed out waiting for the start page to clear/);
});

test("monitorRun resolves from terminal bridge event without polling full UI state", async () => {
  const calls = [];
  const logLines = [];
  const finalRun = {
    id: "run_1",
    status: "FINISHED",
    phase: "IDLE",
    queueLength: 0,
    rows: 10,
    emits: 10,
    failures: 0
  };

  const result = await monitorRun({}, "run_1", 60_000, {
    async callBridgeFn(_page, method, payload) {
      calls.push({ method, payload });
      assert.notEqual(method, "getState");
      assert.equal(method, "waitForRunTerminal");
      return { ok: true, run: finalRun, timedOut: false };
    },
    logger: {
      log(message) {
        logLines.push(message);
      }
    }
  });

  assert.equal(result, finalRun);
  assert.deepEqual(calls, [{
    method: "waitForRunTerminal",
    payload: { runId: "run_1", timeoutMs: 60_000 }
  }]);
  assert.deepEqual(logLines, ["[run run_1] status=FINISHED phase=IDLE queue=0 rows=10 emits=10 failures=0"]);
});

test("monitorRun uses tiny status fallback when no terminal event arrives", async () => {
  const calls = [];
  const statuses = [
    {
      id: "run_1",
      status: "RUNNING",
      phase: "EXECUTING",
      queueLength: 2,
      rows: 5,
      emits: 5,
      failures: 0
    },
    {
      id: "run_1",
      status: "ABORTED",
      phase: "IDLE",
      queueLength: 2,
      rows: 5,
      emits: 5,
      failures: 1
    }
  ];

  const result = await monitorRun({}, "run_1", 0, {
    async callBridgeFn(_page, method, payload) {
      calls.push({ method, payload });
      assert.notEqual(method, "getState");
      if (method === "waitForRunTerminal") {
        return { ok: true, run: null, timedOut: true };
      }
      if (method === "getRunStatus") {
        return { ok: true, run: statuses.shift() };
      }
      throw new Error(`unexpected method ${method}`);
    },
    logger: { log() {} }
  });

  assert.equal(result.status, "ABORTED");
  assert.deepEqual(calls.map((call) => call.method), [
    "waitForRunTerminal",
    "getRunStatus",
    "waitForRunTerminal",
    "getRunStatus"
  ]);
  assert.equal(calls[0].payload.timeoutMs, DEFAULT_RUN_STATUS_FALLBACK_INTERVAL_MS);
});

test("buildProxyConfig returns null when no proxy is configured", () => {
  assert.equal(buildProxyConfig({}), null);
});

test("buildProxyConfig prefixes bare host:port with http:// and carries auth + bypass", () => {
  const result = buildProxyConfig({
    "proxy-server": "proxy.example.com:8080",
    "proxy-username": "user",
    "proxy-password": "secret",
    "proxy-bypass": "127.0.0.1,localhost"
  }, {
    portalOrigin: "https://portal.example.com"
  });

  assert.deepEqual(result, {
    server: "http://proxy.example.com:8080",
    username: "user",
    password: "secret",
    bypass: "127.0.0.1,localhost,portal.example.com,::1"
  });
});

test("buildProxyConfig automatically bypasses the portal origin for control-plane traffic", () => {
  const result = buildProxyConfig({
    "proxy-server": "socks5://127.0.0.1:1080"
  }, {
    portalOrigin: "http://178.104.237.206:5077"
  });

  assert.equal(result.server, "socks5://127.0.0.1:1080");
  assert.equal(result.bypass, "178.104.237.206,127.0.0.1,localhost,::1");
});

test("buildProxyConfig keeps loopback bypasses when the portal origin is malformed", () => {
  const result = buildProxyConfig({
    "proxy-server": "proxy.example.com:8080",
    "proxy-bypass": "api.internal.test"
  }, {
    portalOrigin: "not a url"
  });

  assert.equal(result.bypass, "api.internal.test,127.0.0.1,localhost,::1");
});

test("buildProxyConfig preserves explicit schemes like socks5", () => {
  const result = buildProxyConfig({ "proxy-server": "socks5://10.0.0.1:1080" });
  assert.equal(result.server, "socks5://10.0.0.1:1080");
  assert.equal(result.bypass, "127.0.0.1,localhost,::1");
  assert.ok(!("username" in result));
});

test("describeProxy masks the password in log output", () => {
  const described = describeProxy({
    server: "http://proxy.example.com:8080",
    username: "user",
    password: "secret"
  });
  assert.equal(described, "http://user:***@proxy.example.com:8080");
});

test("describeProxy returns 'none' when no proxy is set", () => {
  assert.equal(describeProxy(null), "none");
});

test("createPortalAuthRenewal schedules re-login before the portal token expires", async () => {
  const fakeTimers = createFakeTimers();
  const calls = [];
  const logs = [];
  const page = {};
  const credentials = { email: "runner@example.com", password: "secret" };

  const renewal = createPortalAuthRenewal({
    page,
    credentials,
    setTimeoutFn: fakeTimers.setTimeout,
    clearTimeoutFn: fakeTimers.clearTimeout,
    callBridgeFn: async (bridgePage, method, payload) => {
      calls.push({ bridgePage, method, payload });
      return { user: { email: payload.email } };
    },
    logger: { log: (line) => logs.push(line), warn: (line) => logs.push(line) }
  });

  assert.equal(renewal.isActive(), true);
  assert.equal(PORTAL_AUTH_RENEWAL_INTERVAL_MS, PORTAL_AUTH_TOKEN_TTL_MS - (15 * 60 * 1000));
  assert.equal(fakeTimers.timers.length, 1);
  assert.equal(fakeTimers.timers[0].delay, PORTAL_AUTH_RENEWAL_INTERVAL_MS);
  assert.equal(fakeTimers.timers[0].unrefCalled, true);

  const scheduled = fakeTimers.timers[0];
  await scheduled.fn();

  assert.deepEqual(calls, [
    {
      bridgePage: page,
      method: "login",
      payload: credentials
    }
  ]);
  assert.deepEqual(logs, ["Renewed portal auth for runner@example.com."]);
  assert.equal(fakeTimers.timers.length, 1);
  assert.equal(fakeTimers.timers[0].delay, PORTAL_AUTH_RENEWAL_INTERVAL_MS);

  renewal.stop();
});

test("createPortalAuthRenewal retries quickly after a failed renewal", async () => {
  const fakeTimers = createFakeTimers();
  const warnings = [];
  let attempts = 0;

  const renewal = createPortalAuthRenewal({
    page: {},
    credentials: { email: "runner@example.com", password: "secret" },
    setTimeoutFn: fakeTimers.setTimeout,
    clearTimeoutFn: fakeTimers.clearTimeout,
    callBridgeFn: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("network down");
      }
      return { user: { email: "runner@example.com" } };
    },
    logger: { log() {}, warn: (line) => warnings.push(line) }
  });

  await fakeTimers.timers[0].fn();

  assert.equal(attempts, 1);
  assert.equal(fakeTimers.timers.length, 1);
  assert.equal(fakeTimers.timers[0].delay, PORTAL_AUTH_RENEWAL_RETRY_MS);
  assert.match(warnings[0], /Portal auth renewal failed; retrying in 60s: network down/);

  await fakeTimers.timers[0].fn();

  assert.equal(attempts, 2);
  assert.equal(fakeTimers.timers.length, 1);
  assert.equal(fakeTimers.timers[0].delay, PORTAL_AUTH_RENEWAL_INTERVAL_MS);

  renewal.stop();
});

test("createPortalAuthRenewal stop clears the pending renewal timer", () => {
  const fakeTimers = createFakeTimers();

  const renewal = createPortalAuthRenewal({
    page: {},
    credentials: { email: "runner@example.com", password: "secret" },
    setTimeoutFn: fakeTimers.setTimeout,
    clearTimeoutFn: fakeTimers.clearTimeout,
    callBridgeFn: async () => ({ user: { email: "runner@example.com" } }),
    logger: { log() {}, warn() {} }
  });

  assert.equal(fakeTimers.timers.length, 1);
  renewal.stop();
  assert.equal(fakeTimers.timers.length, 0);
  assert.equal(renewal.isActive(), false);
});

test("computeUnpackedExtensionId is deterministic and uses a-p alphabet", () => {
  const id = computeUnpackedExtensionId("/tmp/some/extension");
  assert.equal(id.length, 32);
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(id, computeUnpackedExtensionId("/tmp/some/extension"));
});

test("seedExtensionPreferences writes developer_mode and user_scripts_allowed", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-prefs-"));
  const extensionPath = path.join(userDataDir, "ext");
  fs.mkdirSync(extensionPath);
  const id = seedExtensionPreferences(userDataDir, extensionPath);
  const prefs = JSON.parse(fs.readFileSync(path.join(userDataDir, "Default", "Preferences"), "utf8"));
  assert.equal(prefs.extensions.ui.developer_mode, true);
  assert.equal(prefs.extensions.settings[id].user_scripts_allowed, true);
});

test("seedExtensionPreferences preserves unrelated prefs fields", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-prefs-"));
  fs.mkdirSync(path.join(userDataDir, "Default"));
  fs.writeFileSync(
    path.join(userDataDir, "Default", "Preferences"),
    JSON.stringify({ profile: { name: "keep me" }, extensions: { settings: { existing: { x: 1 } } } })
  );
  seedExtensionPreferences(userDataDir, path.join(userDataDir, "ext"));
  const prefs = JSON.parse(fs.readFileSync(path.join(userDataDir, "Default", "Preferences"), "utf8"));
  assert.equal(prefs.profile.name, "keep me");
  assert.equal(prefs.extensions.settings.existing.x, 1);
  assert.equal(prefs.extensions.ui.developer_mode, true);
});

function makeExtensionFixture(rootDir, files) {
  fs.mkdirSync(rootDir, { recursive: true });
  for (const [relativePath, body] of Object.entries(files)) {
    const full = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
}

test("computeExtensionFingerprint changes when source files are touched, added, or removed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-extfp-"));
  const extensionPath = path.join(root, "ext");
  makeExtensionFixture(extensionPath, {
    "manifest.json": "{}",
    "background/service-worker.js": "// v1\n",
    "node_modules/should-be-ignored.js": "ignored"
  });

  const initial = computeExtensionFingerprint(extensionPath);
  assert.match(initial, /^\d+:2$/, "expected only the 2 in-extension files to count");

  // Touching a file with a later mtime changes the fingerprint.
  const futureMs = Date.now() + 60_000;
  fs.utimesSync(path.join(extensionPath, "background/service-worker.js"), futureMs / 1000, futureMs / 1000);
  const afterTouch = computeExtensionFingerprint(extensionPath);
  assert.notEqual(afterTouch, initial);

  // Adding a file changes the count even if mtimes happen to coincide.
  fs.writeFileSync(path.join(extensionPath, "background/new.js"), "// v3\n");
  const afterAdd = computeExtensionFingerprint(extensionPath);
  assert.match(afterAdd, /:3$/);
  assert.notEqual(afterAdd, afterTouch);
});

test("invalidateExtensionScriptCacheIfStale clears Chromium caches on first run and after extension edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runner-cache-"));
  const userDataDir = path.join(root, "profile");
  const extensionPath = path.join(root, "ext");

  makeExtensionFixture(extensionPath, {
    "manifest.json": "{}",
    "background/service-worker.js": "// v1\n"
  });

  const scriptCacheDir = path.join(userDataDir, "Default", "Service Worker", "ScriptCache");
  const codeCacheDir = path.join(userDataDir, "Default", "Code Cache");
  fs.mkdirSync(scriptCacheDir, { recursive: true });
  fs.mkdirSync(codeCacheDir, { recursive: true });
  fs.writeFileSync(path.join(scriptCacheDir, "stale_bytecode"), "leftover");
  fs.writeFileSync(path.join(codeCacheDir, "stale_codecache"), "leftover");

  const silentLogger = { warn() {} };

  // First call has no fingerprint stored — must invalidate.
  assert.equal(invalidateExtensionScriptCacheIfStale(userDataDir, extensionPath, { logger: silentLogger }), true);
  assert.equal(fs.existsSync(scriptCacheDir), false);
  assert.equal(fs.existsSync(codeCacheDir), false);
  assert.ok(fs.existsSync(path.join(userDataDir, ".scraper-extension-fingerprint")));

  // Second call without changes is a no-op.
  fs.mkdirSync(scriptCacheDir, { recursive: true });
  fs.writeFileSync(path.join(scriptCacheDir, "fresh_bytecode"), "fresh");
  assert.equal(invalidateExtensionScriptCacheIfStale(userDataDir, extensionPath, { logger: silentLogger }), false);
  assert.equal(fs.existsSync(path.join(scriptCacheDir, "fresh_bytecode")), true);

  // Editing the extension invalidates again.
  const futureMs = Date.now() + 60_000;
  fs.utimesSync(path.join(extensionPath, "background/service-worker.js"), futureMs / 1000, futureMs / 1000);
  assert.equal(invalidateExtensionScriptCacheIfStale(userDataDir, extensionPath, { logger: silentLogger }), true);
  assert.equal(fs.existsSync(scriptCacheDir), false);
});

test("graceful shutdown closes Chromium context before exiting on SIGTERM", async () => {
  const fakeProcess = createFakeProcess();
  const logLines = [];
  let closeCount = 0;
  let releaseClose;
  const closeStarted = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const controller = createGracefulShutdownController({
    processImpl: fakeProcess,
    logger: {
      log(message) {
        logLines.push(message);
      },
      error(message) {
        logLines.push(message);
      }
    }
  });

  controller.setContext({
    async close() {
      closeCount += 1;
      await closeStarted;
    }
  });
  controller.install();

  fakeProcess.emit("SIGTERM");
  await Promise.resolve();

  assert.equal(closeCount, 1);
  assert.equal(fakeProcess.exitCode, 143);
  assert.deepEqual(fakeProcess.exitCalls, []);
  assert.match(logLines[0], /Received SIGTERM/);

  releaseClose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fakeProcess.exitCalls, [143]);
});

test("graceful shutdown closes Chromium context only once across repeated requests", async () => {
  const fakeProcess = createFakeProcess();
  let closeCount = 0;
  const controller = createGracefulShutdownController({
    processImpl: fakeProcess,
    logger: { log() {}, error() {} }
  });

  controller.setContext({
    async close() {
      closeCount += 1;
    }
  });

  await Promise.all([
    controller.requestShutdown("SIGTERM"),
    controller.requestShutdown("SIGINT")
  ]);

  assert.equal(closeCount, 1);
  assert.equal(fakeProcess.exitCode, 143);
  assert.deepEqual(fakeProcess.exitCalls, [143]);
});

test("STEALTH_LAUNCH_ARGS includes WebRTC IP-leak prevention flags", () => {
  assert.ok(STEALTH_LAUNCH_ARGS.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp"));
  assert.ok(STEALTH_LAUNCH_ARGS.includes("--enforce-webrtc-ip-permission-check"));
});

test("recordEgressIp persists a ring of recent IPs and detects repeats", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-egress-"));

  const first = recordEgressIp(userDataDir, "203.0.113.10", { now: () => "2026-04-28T10:00:00.000Z" });
  assert.equal(first.repeated, false);
  assert.equal(first.recorded, true);

  const second = recordEgressIp(userDataDir, "203.0.113.20", { now: () => "2026-04-28T10:05:00.000Z" });
  assert.equal(second.repeated, false);

  const repeat = recordEgressIp(userDataDir, "203.0.113.10", { now: () => "2026-04-28T10:10:00.000Z" });
  assert.equal(repeat.repeated, true, "an IP we already saw must be flagged as repeated");

  const history = loadEgressHistory(userDataDir);
  assert.equal(history.length, 3);
  assert.deepEqual(history.map((entry) => entry.ip), ["203.0.113.10", "203.0.113.20", "203.0.113.10"]);
});

test("recordEgressIp evicts the oldest entries once the ring is full", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-egress-ring-"));

  for (let index = 0; index < 12; index += 1) {
    recordEgressIp(userDataDir, `203.0.113.${index}`);
  }

  const history = loadEgressHistory(userDataDir);
  assert.equal(history.length, 10, "ring should be capped at 10 entries");
  assert.equal(history[0].ip, "203.0.113.2", "oldest entries should have been evicted");
  assert.equal(history[9].ip, "203.0.113.11");
});

test("recordEgressIp returns recorded=false and skips writing when ip is empty", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-egress-empty-"));
  const result = recordEgressIp(userDataDir, "");
  assert.equal(result.repeated, false);
  assert.equal(result.recorded, false);
  assert.deepEqual(loadEgressHistory(userDataDir), []);
});

test("loadEgressHistory returns an empty list when the file is missing or corrupt", () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-egress-corrupt-"));
  assert.deepEqual(loadEgressHistory(userDataDir), []);

  fs.writeFileSync(path.join(userDataDir, ".scraper-egress-history.json"), "{not json");
  assert.deepEqual(loadEgressHistory(userDataDir), []);
});
