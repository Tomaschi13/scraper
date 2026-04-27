"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  buildProxyConfig,
  computeUnpackedExtensionId,
  createGracefulShutdownController,
  describeProxy,
  resolveRobotStartUrl,
  seedExtensionPreferences,
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
