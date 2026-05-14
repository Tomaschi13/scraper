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
    .concat("\nmodule.exports = { portalFetch, updateRunInPortal };\n");

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
