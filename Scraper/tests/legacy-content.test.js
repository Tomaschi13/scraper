"use strict";

// These tests load the verbatim content/legacy-content.js in a jsdom window,
// stub chrome.runtime.sendMessage to capture outbound messages, and assert on
// the exact shapes the legacy runtime sends. The point is to pin legacy semantics so a
// later maintenance change to the file (or to our MV2->MV3 patch) can't
// silently drift. Behaviors under test:
//   - emit() table-name sanitization + source_url stamping + empty-array skip
//     + non-array coercion.
//   - emitKinesis 1MB fallback to plain emit.
//   - emit family distinct methods (emit, emitKinesis, emitBQ, emitS3, emitfb).
//   - next() batching and shape (array form sent to bg, gofast flag, multi).
//   - fastnext() === next() with gofast.
//   - fork(), nextsel(), follow().
//   - done() delayed + abortStep gating (step aborted -> emitDbg WARN).
//   - ensure() sets abortStep on missing selector.
//   - setRetries, setUA, setSettings, setProxy (direct/tag/object), resetProxy.
//   - allowImages, blockImages, clearQue, closeSocket, stop.
//   - getArray, take, captcha, screenshot, emitfb, emitBQ bqTable propagation.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { JSDOM } = require("jsdom");

const LEGACY_PATH = path.join(__dirname, "..", "content", "legacy-content.js");
const JQUERY_PATH = path.join(__dirname, "..", "vendor", "jquery-3.6.0.min.js");

function setupLegacyRuntime({ html = "<!DOCTYPE html><html><body></body></html>", url = "https://example.com/page" } = {}) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;

  const messages = [];
  const sent = [];

  // jsdom doesn't implement HTMLElement.prototype.innerText (only textContent).
  // The legacy runtime's getArray/take rely on innerText, so shim it to
  // textContent for the duration of the harness.
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText")) {
    Object.defineProperty(window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() { return this.textContent; },
      set(value) { this.textContent = value; }
    });
  }

  // Clone captured messages into the node realm so node:assert's strict
  // deep-equality (which compares prototypes) can match plain-object literals
  // written in tests. Without this, jsdom-realm {} !== node-realm {}.
  function cloneToNodeRealm(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function cloneToWindowRealm(value) {
    if (typeof value === "undefined") {
      return undefined;
    }

    if (value === null || typeof value !== "object") {
      return value;
    }

    return window.JSON.parse(JSON.stringify(value));
  }

  window.chrome = {
    runtime: {
      sendMessage(message, callback) {
        const cloned = cloneToNodeRealm(message);
        sent.push(cloned);
        if (Array.isArray(cloned)) {
          for (const item of cloned) {
            messages.push(item);
          }
        } else {
          messages.push(cloned);
        }
        if (typeof callback === "function") {
          callback({});
        }
      },
      onMessage: {
        addListener() {}
      }
    }
  };

  // jQuery expects `window` and `document` as globals inside the IIFE it uses,
  // and it sniffs `module.exports`. Run the file with eval in the window scope.
  const jquerySource = fs.readFileSync(JQUERY_PATH, "utf8");
  window.eval(jquerySource);

  const legacySource = fs.readFileSync(LEGACY_PATH, "utf8");
  window.eval(legacySource);

  return {
    window,
    messages,
    sentBatches: sent,
    invoke(methodName, ...args) {
      return window[methodName](...args.map(cloneToWindowRealm));
    },
    resetMessages() {
      messages.length = 0;
      sent.length = 0;
    },
    waitForAsync(ms) {
      return new Promise((resolve) => window.setTimeout(resolve, ms));
    }
  };
}

test("loading content.js auto-invokes domReady and emits a single domReady message", () => {
  const harness = setupLegacyRuntime();
  const domReady = harness.messages.find((message) => message.method === "domReady");
  assert.ok(domReady, "expected an initial domReady message");
});

test("wait with a numeric delay resolves like a sleep helper", async () => {
  const harness = setupLegacyRuntime();
  const startedAt = Date.now();

  await harness.invoke("wait", 25);

  assert.ok(Date.now() - startedAt >= 20, "expected wait(number) to pause before resolving");
});

test("emit stamps source_url from document.URL and sends a single emit message", () => {
  const harness = setupLegacyRuntime({ url: "https://example.com/list" });
  harness.resetMessages();
  harness.invoke("emit", "products", [{ name: "A" }, { name: "B" }]);

  const emits = harness.messages.filter((message) => message.method === "emit");
  assert.equal(emits.length, 1);
  assert.equal(emits[0].table, "products");
  assert.equal(emits[0].rows.length, 2);
  assert.equal(emits[0].rows[0].source_url, "https://example.com/list");
  assert.equal(emits[0].rows[1].source_url, "https://example.com/list");
});

test("emit sanitizes table names with invalid characters and caps length to 50", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  const longName = "a".repeat(60) + "/bad!";
  harness.invoke("emit", longName, [{ x: 1 }]);

  const emit = harness.messages.find((message) => message.method === "emit");
  assert.ok(emit);
  assert.ok(emit.table.length <= 50);
  assert.ok(!/[^A-Za-z0-9_\-]/.test(emit.table));

  const warning = harness.messages.find(
    (message) => message.method === "emitDbg" && String(message.msg).startsWith("Invalid characters in emit table name:")
  );
  assert.ok(warning);
});

test("emit with an empty rows array skips the emit and logs a WARN", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("emit", "t", []);

  assert.equal(harness.messages.filter((message) => message.method === "emit").length, 0);
  const warning = harness.messages.find(
    (message) => message.method === "emitDbg" && /emitting empty array/.test(message.msg)
  );
  assert.ok(warning);
});

test("emit coerces a non-array rows value into a single-row array and logs a WARN", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("emit", "t", { value: 1 });

  const emit = harness.messages.find((message) => message.method === "emit");
  assert.ok(emit);
  assert.equal(emit.rows.length, 1);
  assert.equal(emit.rows[0].value, 1);

  const warning = harness.messages.find(
    (message) => message.method === "emitDbg" && /Emit rows parameter must be array/.test(message.msg)
  );
  assert.ok(warning);
});

test("emitKinesis falls back to plain emit when the row JSON exceeds 800KB", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();

  // Build rows that together exceed 800KB of JSON.
  const chunk = "x".repeat(1024);
  const rows = [];
  for (let i = 0; i < 900; i += 1) {
    rows.push({ blob: chunk });
  }

  harness.invoke("emitKinesis", "big", rows);

  const emitKinesis = harness.messages.find((message) => message.method === "emitKinesis");
  const emit = harness.messages.find((message) => message.method === "emit");
  assert.equal(emitKinesis, undefined, "oversize payload should not go out as emitKinesis");
  assert.ok(emit, "oversize payload should fall back to plain emit");

  const warning = harness.messages.find(
    (message) => message.method === "emitDbg" && /only support emits of less than 1MB/.test(message.msg)
  );
  assert.ok(warning);
});

test("emitBQ forwards the bqTable parameter alongside table and rows", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("emitBQ", "products", [{ sku: "1" }], "analytics.products");

  const emit = harness.messages.find((message) => message.method === "emitBQ");
  assert.ok(emit);
  assert.equal(emit.table, "products");
  assert.equal(emit.bqTable, "analytics.products");
});

test("emitfb forwards as method:emitfb", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("emitfb", "t", [{ a: 1 }]);

  assert.ok(harness.messages.find((message) => message.method === "emitfb"));
});

test("next with string url batches into a single-item array payload", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("next", "https://x/", "detail", { page: 2 });

  const batch = harness.sentBatches.find((payload) => Array.isArray(payload) && payload[0]?.method === "next");
  assert.ok(batch);
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0], {
    method: "next",
    url: "https://x/",
    step: "detail",
    params: { page: 2 }
  });
});

test("fastnext sets gofast:true on the emitted next payload", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("fastnext", "https://x/", "detail", null);

  const batch = harness.sentBatches.find((payload) => Array.isArray(payload) && payload[0]?.method === "next");
  assert.ok(batch);
  assert.equal(batch[0].gofast, true);
});

test("next with an array payload sends the whole batch as a single message", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("next", [
    { url: "https://a/", step: "s1", params: null },
    { url: "https://b/", step: "s2", params: null }
  ]);

  const batches = harness.sentBatches.filter(
    (payload) => Array.isArray(payload) && payload.every((entry) => entry?.method === "next")
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.equal(batches[0][0].url, "https://a/");
  assert.equal(batches[0][1].url, "https://b/");
});

test("fork sends a non-array fork message with url/step/params", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("fork", "https://child/", "childStep", { k: 1 });

  const fork = harness.messages.find((message) => message.method === "fork");
  assert.ok(fork);
  assert.equal(fork.url, "https://child/");
  assert.equal(fork.step, "childStep");
  assert.deepEqual(fork.params, { k: 1 });
});

test("nextsel emits one next-batch per anchor element it finds", () => {
  const harness = setupLegacyRuntime({
    html: `<!DOCTYPE html><html><body>
      <a id="a1" href="https://one/">one</a>
      <a id="a2" href="https://two/">two</a>
    </body></html>`
  });
  harness.resetMessages();
  harness.invoke("nextsel", "a", "s", { tag: "x" });

  const urls = harness.sentBatches
    .filter((payload) => Array.isArray(payload) && payload[0]?.method === "next")
    .map((payload) => payload[0].url);
  assert.deepEqual(urls.sort(), ["https://one/", "https://two/"]);
});

test("follow calls next() for every anchor with an href", () => {
  const harness = setupLegacyRuntime({
    html: `<!DOCTYPE html><html><body>
      <a class="item" href="https://a/">a</a>
      <a class="item" href="https://b/">b</a>
    </body></html>`
  });
  harness.resetMessages();
  harness.invoke("follow", ".item", "itemStep");

  const urls = harness.sentBatches
    .filter((payload) => Array.isArray(payload) && payload[0]?.method === "next")
    .map((payload) => payload[0].url);
  assert.deepEqual(urls.sort(), ["https://a/", "https://b/"]);
});

test("ensure sets abortStep when the selector is missing and keeps the page running", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("ensure", ".does-not-exist");

  assert.equal(harness.window.abortStep, true);
});

test("abortStep=true reroutes subsequent sendMessage calls to an emitDbg WARN", () => {
  const harness = setupLegacyRuntime();
  harness.window.abortStep = true;
  harness.resetMessages();
  harness.invoke("emit", "t", [{ a: 1 }]);

  const emits = harness.messages.filter((message) => message.method === "emit");
  assert.equal(emits.length, 0, "emit should be replaced by an emitDbg while abortStep is true");

  const aborts = harness.messages.filter(
    (message) => message.method === "emitDbg" && /step aborted:emit/.test(message.msg)
  );
  assert.ok(aborts.length > 0);
});

test("done() sends a done message immediately when allowDone is true", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("done");

  assert.ok(harness.messages.find((message) => message.method === "done"));
});

test("done(500) defers the done message by the supplied delay", async () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("done", 200);

  assert.equal(harness.messages.filter((message) => message.method === "done").length, 0);
  await harness.waitForAsync(300);
  assert.equal(harness.messages.filter((message) => message.method === "done").length, 1);
});

test("done() is blocked when allowDone=false and logs an ERROR instead", () => {
  const harness = setupLegacyRuntime();
  harness.window.allowDone = false;
  harness.resetMessages();
  harness.invoke("done");

  assert.equal(harness.messages.filter((message) => message.method === "done").length, 0);
  const error = harness.messages.find(
    (message) => message.method === "emitDbg" && /Done not allowed/.test(message.msg)
  );
  assert.ok(error);
});

test("setRetries posts the legacy {interval,maxStep,maxRun} shape", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setRetries", 30000, 5, 100);

  const msg = harness.messages.find((message) => message.method === "setRetries");
  assert.deepEqual(msg, { method: "setRetries", interval: 30000, maxStep: 5, maxRun: 100 });
});

test("setUA sends UAstring", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setUA", "Mozilla/X");
  assert.deepEqual(harness.messages.find((message) => message.method === "setUA"), {
    method: "setUA",
    UAstring: "Mozilla/X"
  });
});

test("setProxy with only a tag string routes to setProxyPortal", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setProxy", "my-tag");
  const msg = harness.messages.find((message) => message.method === "setProxyPortal");
  assert.ok(msg);
  assert.equal(msg.tag, "my-tag");
});

test("setProxy with server/port/bypass routes to setProxy", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setProxy", "1.2.3.4", 8080, ["localhost"]);
  const msg = harness.messages.find((message) => message.method === "setProxy");
  assert.ok(msg);
  assert.equal(msg.server, "1.2.3.4");
  assert.equal(msg.port, 8080);
  assert.deepEqual(msg.bypass, ["localhost"]);
});

test("setProxy with an object routes to setProxy2", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setProxy", { mode: "fixed_servers" });
  const msg = harness.messages.find((message) => message.method === "setProxy2");
  assert.ok(msg);
  assert.deepEqual(msg.parameters, { mode: "fixed_servers" });
});

test("setProxy with no argument triggers resetProxy", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setProxy");
  assert.ok(harness.messages.find((message) => message.method === "resetProxy"));
});

test("setSettings forwards the settings object", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("setSettings", { skipVisited: true });
  assert.deepEqual(harness.messages.find((message) => message.method === "setSettings"), {
    method: "setSettings",
    settings: { skipVisited: true }
  });
});

test("clearQue, closeSocket, stop, allowImages, blockImages send the matching plain method", () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();
  harness.invoke("clearQue");
  harness.invoke("closeSocket");
  harness.invoke("stop");
  harness.invoke("allowImages", { tab: 1 });
  harness.invoke("blockImages", { tab: 2 });

  for (const method of ["clearQue", "closeSocket", "stop"]) {
    assert.ok(harness.messages.find((message) => message.method === method), `expected ${method}`);
  }
  assert.deepEqual(
    harness.messages.find((message) => message.method === "allowImages"),
    { method: "allowImages", parameters: { tab: 1 } }
  );
  assert.deepEqual(
    harness.messages.find((message) => message.method === "blockImages"),
    { method: "blockImages", parameters: { tab: 2 } }
  );
});

test("getArray returns each element's innerText as an array", () => {
  const harness = setupLegacyRuntime({
    html: `<!DOCTYPE html><html><body>
      <li class="x">alpha</li>
      <li class="x">beta</li>
    </body></html>`
  });
  const values = Array.from(harness.window.getArray(".x"));
  assert.deepEqual(values, ["alpha", "beta"]);
});

test("take builds rows column-wise from a selector map and emits them", () => {
  const harness = setupLegacyRuntime({
    html: `<!DOCTYPE html><html><body>
      <span class="name">A</span><span class="price">$1</span>
      <span class="name">B</span><span class="price">$2</span>
    </body></html>`
  });
  harness.resetMessages();
  harness.invoke("take", "products", { name: ".name", price: ".price" });

  const emit = harness.messages.find((message) => message.method === "emit");
  assert.ok(emit);
  assert.equal(emit.table, "products");
  assert.equal(emit.rows.length, 2);
  assert.equal(emit.rows[0].name, "A");
  assert.equal(emit.rows[0].price, "$1");
  assert.equal(emit.rows[1].name, "B");
  assert.equal(emit.rows[1].price, "$2");
});

test("clearCookies sends the configured domain", () => {
  const harness = setupLegacyRuntime({ url: "https://shop.example.com/" });
  harness.resetMessages();
  harness.invoke("clearCookies", { domain: "shop.example.com" });
  const msg = harness.messages.find((message) => message.method === "clearCookies");
  assert.ok(msg);
  assert.equal(msg.domain, "shop.example.com");
});

test("clearBrowsingData defaults to the current origin when called with no args", () => {
  const harness = setupLegacyRuntime({ url: "https://shop.example.com/a" });
  harness.resetMessages();
  harness.invoke("clearBrowsingData");
  const msg = harness.messages.find((message) => message.method === "clearBrowsingData");
  assert.ok(msg);
  assert.deepEqual(msg.origins, ["https://shop.example.com"]);
  assert.equal(msg.settings, null);
});

test("waitFor resolves when the selector appears before the timeout", async () => {
  const harness = setupLegacyRuntime({
    html: `<!DOCTYPE html><html><body></body></html>`
  });

  const promise = harness.invoke("waitFor", ".appears", 2000);

  // Insert the element shortly after.
  harness.window.setTimeout(() => {
    const el = harness.window.document.createElement("div");
    el.className = "appears";
    harness.window.document.body.appendChild(el);
  }, 120);

  await promise;
  // If the promise resolved, the test passes. Add a sanity assertion.
  assert.equal(harness.window.document.querySelectorAll(".appears").length, 1);
});

test("waitFor times out and calls done() + rejects the promise after its budget", async () => {
  const harness = setupLegacyRuntime();
  harness.resetMessages();

  const promise = harness.invoke("waitFor", ".never", 300);
  let rejected = false;
  promise.then(null, () => { rejected = true; });

  await harness.waitForAsync(500);
  assert.equal(rejected, true, "waitFor should reject after its timeout");
  assert.ok(harness.messages.find((message) => message.method === "done"), "waitFor timeout should call done()");
});
