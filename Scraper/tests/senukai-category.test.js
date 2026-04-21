"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { JSDOM } = require("jsdom");

const LEGACY_PATH = path.join(__dirname, "..", "content", "legacy-content.js");
const JQUERY_PATH = path.join(__dirname, "..", "vendor", "jquery-3.6.0.min.js");
const SENUKAI_PATH = path.join(__dirname, "..", "examples", "senukai-category.js");
const SENUKAI_URL = "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt";

function setupHarness({ url = SENUKAI_URL } = {}) {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url,
    runScripts: "outside-only",
    pretendToBeVisual: true
  });
  const { window } = dom;

  const messages = [];
  const sentBatches = [];

  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, "innerText")) {
    Object.defineProperty(window.HTMLElement.prototype, "innerText", {
      configurable: true,
      get() {
        return this.textContent;
      },
      set(value) {
        this.textContent = value;
      }
    });
  }

  window.chrome = {
    runtime: {
      sendMessage(message, callback) {
        const cloned = JSON.parse(JSON.stringify(message));
        sentBatches.push(cloned);
        if (Array.isArray(cloned)) {
          messages.push(...cloned);
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

  window.eval(fs.readFileSync(JQUERY_PATH, "utf8"));
  window.eval(fs.readFileSync(LEGACY_PATH, "utf8"));
  window.eval(fs.readFileSync(SENUKAI_PATH, "utf8"));

  return {
    window,
    messages,
    sentBatches,
    resetMessages() {
      messages.length = 0;
      sentBatches.length = 0;
    }
  };
}

test("Senukai example uses an explicit sleep helper instead of wait(number)", () => {
  const source = fs.readFileSync(SENUKAI_PATH, "utf8");

  assert.match(source, /function sleep\(ms\)/);
  assert.doesNotMatch(source, /\bawait\s+wait\s*\(\s*\d+\s*\)/);
});

test("Senukai start step queues the grid step under the legacy runtime", async () => {
  const harness = setupHarness();
  harness.resetMessages();

  harness.window.sleep = () => Promise.resolve();
  harness.window.done = () => {};

  await harness.window.steps.start();

  assert.ok(
    harness.messages.find((message) => message.method === "setRetries"),
    "expected start() to update the retry policy"
  );
  assert.ok(
    harness.messages.find((message) => message.method === "setSettings"),
    "expected start() to update run settings"
  );

  const nextBatch = harness.sentBatches.find(
    (payload) => Array.isArray(payload) && payload[0]?.method === "next"
  );

  assert.ok(nextBatch, "expected start() to queue the grid step");
  assert.deepEqual(nextBatch[0], {
    method: "next",
    url: `${SENUKAI_URL}?page=1&page_per=72`,
    step: "grid",
    params: {
      category_url: SENUKAI_URL,
      page_size: 72
    }
  });
});
