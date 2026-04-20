"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  selectPreviewTabId,
  shouldExecuteRunOnRuntimeReady
} = require("../background/runtime-bridge-helpers.js");

test("selectPreviewTabId prefers the active run tab when one exists", () => {
  const runtime = {
    lastRunId: "run_1",
    lastPageTabId: 91,
    runs: {
      run_1: {
        tabId: 42
      }
    }
  };

  assert.equal(selectPreviewTabId(runtime, [{ id: 7, url: "https://example.com" }]), 42);
});

test("selectPreviewTabId falls back to the last seen page tab before scanning browser tabs", () => {
  const runtime = {
    lastRunId: null,
    lastPageTabId: 91,
    runs: {}
  };

  assert.equal(selectPreviewTabId(runtime, [{ id: 7, url: "https://example.com" }]), 91);
});

test("selectPreviewTabId uses the first previewable tab when runtime state has no tab ids", () => {
  const runtime = {
    lastRunId: null,
    lastPageTabId: null,
    runs: {}
  };

  assert.equal(selectPreviewTabId(runtime, [
    { id: 1, url: "chrome://extensions" },
    { id: 2, url: "https://example.com" }
  ]), 2);
});

test("selectPreviewTabId returns null when no page tab is available", () => {
  const runtime = {
    lastRunId: null,
    lastPageTabId: null,
    runs: {}
  };

  assert.equal(selectPreviewTabId(runtime, [{ id: 1, url: "chrome://extensions" }]), null);
});

test("shouldExecuteRunOnRuntimeReady returns true only for runs awaiting DOM readiness", () => {
  assert.equal(shouldExecuteRunOnRuntimeReady({
    status: "RUNNING",
    currentStep: { step: "start" },
    phase: "AWAITING_DOM_READY"
  }), true);

  assert.equal(shouldExecuteRunOnRuntimeReady({
    status: "RUNNING",
    currentStep: { step: "start" },
    phase: "EXECUTING"
  }), false);

  assert.equal(shouldExecuteRunOnRuntimeReady({
    status: "FAILED",
    currentStep: { step: "start" },
    phase: "AWAITING_DOM_READY"
  }), false);

  assert.equal(shouldExecuteRunOnRuntimeReady(null), false);
});
