"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSelectorPreview,
  createPreviewQuery,
  createRuntimeBridge,
  sendRuntimeMessage
} = require("../content/runtime.js");

function createNode({ textContent = "", attributes = {}, children = {} } = {}) {
  return {
    textContent,
    querySelectorAll(selector) {
      return (children[selector] || []).slice();
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name]
        : null;
    }
  };
}

function createDocument(children = {}) {
  return {
    querySelectorAll(selector) {
      return (children[selector] || []).slice();
    }
  };
}

test("sendRuntimeMessage returns the runtime response when messaging succeeds", async () => {
  const runtime = {
    sendMessage: async () => ({ ok: true })
  };

  const result = await sendRuntimeMessage(runtime, { type: "RUNTIME_READY" });
  assert.deepEqual(result, { ok: true });
});

test("sendRuntimeMessage swallows invalidated extension context errors", async () => {
  const runtime = {
    sendMessage: async () => {
      throw new Error("Extension context invalidated.");
    }
  };

  let loggerCalls = 0;
  const result = await sendRuntimeMessage(runtime, { type: "RUNTIME_READY" }, {
    logger() {
      loggerCalls += 1;
    }
  });

  assert.equal(result, null);
  assert.equal(loggerCalls, 0);
});

test("sendRuntimeMessage swallows message-channel closures during async responses", async () => {
  const runtime = {
    sendMessage: async () => {
      throw new Error(
        "A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received"
      );
    }
  };

  let loggerCalls = 0;
  const result = await sendRuntimeMessage(runtime, { type: "RUNTIME_READY" }, {
    logger() {
      loggerCalls += 1;
    }
  });

  assert.equal(result, null);
  assert.equal(loggerCalls, 0);
});

test("sendRuntimeMessage logs unexpected message failures and returns null", async () => {
  const runtime = {
    sendMessage: async () => {
      throw new Error("Permission denied");
    }
  };

  const logged = [];
  const result = await sendRuntimeMessage(runtime, { type: "RUNTIME_READY" }, {
    logger(error) {
      logged.push(error.message);
    }
  });

  assert.equal(result, null);
  assert.deepEqual(logged, ["Permission denied"]);
});

test("buildSelectorPreview builds row-based previews with native selectors", () => {
  const rowOne = createNode({
    children: {
      ".title": [createNode({ textContent: "Alpha" })]
    }
  });
  const rowTwo = createNode({
    children: {
      ".title": [createNode({ textContent: "Beta" })]
    }
  });
  const document = createDocument({
    ".row": [rowOne, rowTwo]
  });

  const preview = buildSelectorPreview([
    { name: "row", selector: ".row" },
    { name: "title", selector: ".title" }
  ], {
    document,
    window: {}
  });

  assert.deepEqual(preview, {
    headers: ["title"],
    rows: [["Alpha"], ["Beta"]]
  });
});

test("buildSelectorPreview supports expression-based selector previews without jQuery", () => {
  const row = createNode({
    children: {
      ".link": [
        createNode({
          textContent: "Read more",
          attributes: { href: "/details" }
        })
      ]
    }
  });
  const document = createDocument({
    ".row": [row]
  });

  const preview = buildSelectorPreview([
    { name: "row", selector: ".row" },
    { name: "href", selector: '$(".link", row).attr("href")' },
    { name: "label", selector: '$(".link", row).text().trim()' }
  ], {
    document,
    window: {}
  });

  assert.deepEqual(preview, {
    headers: ["href", "label"],
    rows: [["/details", "Read more"]]
  });
});

test("createPreviewQuery prefers the injected jQuery implementation when available", () => {
  const document = createDocument();
  const calls = [];
  const expected = { jquery: "3.6.0" };
  const previewQuery = createPreviewQuery(document, (selector, context) => {
    calls.push({ selector, context });
    return expected;
  });

  assert.equal(previewQuery(".breadcrumb"), expected);
  assert.deepEqual(calls, [{
    selector: ".breadcrumb",
    context: document
  }]);
});

test("createRuntimeBridge notifies the background when the page bridge becomes ready", async () => {
  const calls = [];
  const chromeRuntime = {
    sendMessage: async (message) => {
      calls.push(message);
      return { ok: true };
    }
  };
  const bridge = createRuntimeBridge({
    chromeRuntime,
    document: createDocument(),
    window: {},
    location: { href: "https://example.com/page" },
    consoleObject: { warn() {} }
  });

  await bridge.notifyRuntimeReady();

  assert.deepEqual(calls, [{
    source: "scraper-runtime",
    type: "RUNTIME_READY",
    pageUrl: "https://example.com/page"
  }]);
});

test("createRuntimeBridge responds to preview requests and ignores unrelated messages", () => {
  const document = createDocument({
    ".headline": [createNode({ textContent: "Example" })]
  });
  const bridge = createRuntimeBridge({
    chromeRuntime: { sendMessage: async () => ({ ok: true }) },
    document,
    window: {},
    location: { href: "https://example.com" },
    consoleObject: { warn() {} }
  });

  let previewResponse = null;
  assert.equal(bridge.handleMessage({ type: "NOOP" }, null, () => {}), false);
  assert.equal(bridge.handleMessage({
    type: "PREVIEW_SELECTORS",
    selectors: [{ name: "headline", selector: ".headline" }]
  }, null, (value) => {
    previewResponse = value;
  }), true);

  assert.deepEqual(previewResponse, {
    headers: ["headline"],
    rows: [["Example"]]
  });
});
