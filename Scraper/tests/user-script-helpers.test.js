"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LEGACY_USER_SCRIPT_FILES,
  LEGACY_USER_SCRIPT_PRELUDE,
  buildLegacyUserScriptBootstrap,
  buildLegacyUserScriptSources,
  configureUserScriptWorld
} = require("../background/user-script-helpers.js");

test("buildLegacyUserScriptSources prepends the legacy runtime files before robot code and bootstrap", () => {
  const sources = buildLegacyUserScriptSources(
    "steps.start = async function start() {};",
    "grid",
    { page: 2, filters: ["sale"] },
    "https://example.com/next"
  );

  assert.equal(sources[0].code, LEGACY_USER_SCRIPT_PRELUDE);
  assert.deepEqual(
    sources.slice(1, LEGACY_USER_SCRIPT_FILES.length + 1),
    LEGACY_USER_SCRIPT_FILES.map((file) => ({ file }))
  );
  assert.equal(sources[LEGACY_USER_SCRIPT_FILES.length + 1].code, "steps.start = async function start() {};");
  assert.match(sources[sources.length - 1].code, /const stepName = "grid";/);
  assert.match(sources[sources.length - 1].code, /"page":2/);
  assert.match(sources[sources.length - 1].code, /https:\/\/example\.com\/next/);
});

test("buildLegacyUserScriptBootstrap omits params when the step has no payload", () => {
  const bootstrap = buildLegacyUserScriptBootstrap("start", undefined, "");

  assert.match(bootstrap, /const stepParams = undefined;/);
  assert.match(bootstrap, /const ajaxUrl = "";/);
  assert.match(bootstrap, /stepFn\(\)/);
});

test("configureUserScriptWorld verifies availability and enables user-script messaging", async () => {
  const calls = [];
  const api = {
    async getScripts(filter) {
      calls.push(["getScripts", filter]);
      return [];
    },
    async execute() {
      return [];
    },
    async configureWorld(options) {
      calls.push(["configureWorld", options]);
    }
  };

  await configureUserScriptWorld(api);

  assert.deepEqual(calls, [
    ["getScripts", { ids: [] }],
    ["configureWorld", { messaging: true }]
  ]);
});

test("configureUserScriptWorld throws a friendly enable-user-scripts error when unavailable", async () => {
  await assert.rejects(
    () => configureUserScriptWorld(null),
    /Allow User Scripts/
  );
});

test("configureUserScriptWorld wraps API failures with the same enable-user-scripts guidance", async () => {
  const api = {
    async getScripts() {
      throw new Error("permission denied");
    },
    async execute() {
      return [];
    },
    async configureWorld() {}
  };

  await assert.rejects(
    () => configureUserScriptWorld(api),
    /permission denied/
  );
});
