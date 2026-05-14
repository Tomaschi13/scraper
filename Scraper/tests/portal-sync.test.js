"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPortalModule({ fetchImpl }) {
  const sourcePath = path.join(__dirname, "..", "background", "portal.js");
  const source = fs.readFileSync(sourcePath, "utf8")
    .replace(
      'import { portalUrl } from "../shared/portal-config.js";',
      "const portalUrl = globalThis.portalUrl;"
    )
    .replaceAll("export async function ", "async function ")
    .replaceAll("export function ", "function ")
    .concat("\nmodule.exports = { portalFetch, updateRunInPortal, updateRunResumeStateInPortal };\n");

  const context = {
    AbortController,
    clearTimeout,
    console: { warn() {} },
    fetch: fetchImpl,
    globalThis: {
      portalUrl: async (route) => `http://portal.test${route}`
    },
    module: { exports: {} },
    setTimeout
  };

  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.module.exports;
}

function okJson(body = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => body
  };
}

test("portalFetch aborts portal calls that exceed the configured timeout", async () => {
  const { portalFetch } = loadPortalModule({
    fetchImpl: (_url, options = {}) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })
  });

  await assert.rejects(
    () => portalFetch("/api/runs/run_1", { timeoutMs: 5 }),
    (error) => {
      assert.equal(error.code, "PORTAL_SYNC_TIMEOUT");
      assert.match(error.message, /timed out after 5ms/);
      return true;
    }
  );
});

test("updateRunInPortal records throttled sync failures in run logs", async () => {
  const { updateRunInPortal } = loadPortalModule({
    fetchImpl: async () => {
      throw new Error("network down");
    }
  });
  const run = {
    id: "run_1",
    robotId: "robot_1",
    robotName: "robot",
    status: "RUNNING",
    logs: []
  };

  assert.equal(await updateRunInPortal(run), false);
  assert.equal(await updateRunInPortal(run), false);
  assert.equal(run.logs.length, 1);
  assert.match(
    run.logs[0],
    /WARN: Portal sync failed while updating the run record: network down/
  );
});

test("updateRunInPortal sends only lean metadata for portal server runs", async () => {
  let payload = null;
  const { updateRunInPortal } = loadPortalModule({
    fetchImpl: async (_url, options = {}) => {
      payload = JSON.parse(options.body);
      return okJson({});
    }
  });

  const run = {
    id: "run_1",
    robotId: "robot_1",
    robotName: "robot",
    status: "RUNNING",
    phase: "EXECUTING",
    currentUrl: "https://example.com/current",
    startedAt: "2026-05-14T10:00:00.000Z",
    logs: ["must not leak"],
    outputTables: { products: [{ sku: "must not leak" }] },
    queue: [{ id: "step_1" }],
    currentStep: { id: "step_0", params: { huge: true } },
    retries: { maxStep: 10 },
    config: { skipVisited: true },
    emits: 2,
    rows: 3,
    failures: 1,
    runSource: "PORTAL_SERVER"
  };

  assert.equal(await updateRunInPortal(run), true);
  assert.equal(payload.runSource, "PORTAL_SERVER");
  assert.equal(payload.rows, 3);
  assert.equal(payload.queueLength, 1);
  assert.equal(Object.hasOwn(payload, "logs"), false);
  assert.equal(Object.hasOwn(payload, "outputTables"), false);
  assert.equal(Object.hasOwn(payload, "currentStep"), false);
  assert.equal(Object.hasOwn(payload, "retries"), false);
  assert.equal(Object.hasOwn(payload, "config"), false);
});

test("updateRunResumeStateInPortal sends only heartbeat metadata for portal server runs", async () => {
  let payload = null;
  const { updateRunResumeStateInPortal } = loadPortalModule({
    fetchImpl: async (_url, options = {}) => {
      payload = JSON.parse(options.body);
      return okJson({ resume: { runId: "run_1" } });
    }
  });

  const run = {
    id: "run_1",
    status: "RUNNING",
    phase: "EXECUTING",
    currentUrl: "https://example.com/current",
    queue: [{ id: "step_1" }],
    visitedUrls: ["https://example.com/a"],
    visitedMap: { "https://example.com/a": true },
    currentStep: { id: "step_0", params: { huge: true } },
    outputTables: { products: [{ sku: "must not leak" }] },
    code: "must not leak",
    logs: ["must not leak"],
    retries: { maxStep: 10 },
    config: { skipVisited: true },
    emits: 2,
    rows: 3,
    failures: 1,
    runSource: "PORTAL_SERVER"
  };

  const resume = await updateRunResumeStateInPortal(run);

  assert.deepEqual(resume, { runId: "run_1" });
  assert.equal(payload.runSource, "PORTAL_SERVER");
  assert.equal(payload.rows, 3);
  assert.equal(Object.hasOwn(payload, "queue"), false);
  assert.equal(Object.hasOwn(payload, "visitedUrls"), false);
  assert.equal(Object.hasOwn(payload, "visitedMap"), false);
  assert.equal(Object.hasOwn(payload, "currentStep"), false);
  assert.equal(Object.hasOwn(payload, "outputTables"), false);
  assert.equal(Object.hasOwn(payload, "code"), false);
  assert.equal(Object.hasOwn(payload, "logs"), false);
  assert.equal(Object.hasOwn(payload, "retries"), false);
  assert.equal(Object.hasOwn(payload, "config"), false);
});
