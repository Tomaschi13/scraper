"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRunningRun,
  shouldProcessExecutionResult
} = require("../background/run-lifecycle-helpers.js");

test("isRunningRun returns true only for active runs", () => {
  assert.equal(isRunningRun({ status: "RUNNING" }), true);
  assert.equal(isRunningRun({ status: "ABORTED" }), false);
  assert.equal(isRunningRun(null), false);
});

test("shouldProcessExecutionResult accepts only the live running run with a matching token", () => {
  const run = {
    id: "run_1",
    status: "RUNNING",
    executionToken: "exec_1"
  };
  const runtimeState = {
    runs: {
      run_1: run
    }
  };

  assert.equal(shouldProcessExecutionResult(runtimeState, run, "exec_1"), true);
  assert.equal(shouldProcessExecutionResult(runtimeState, run, "exec_2"), false);
});

test("shouldProcessExecutionResult rejects stale executions after a run object is replaced", () => {
  const staleRun = {
    id: "run_1",
    status: "RUNNING",
    executionToken: "exec_old"
  };
  const liveRun = {
    id: "run_1",
    status: "RUNNING",
    executionToken: "exec_new"
  };
  const runtimeState = {
    runs: {
      run_1: liveRun
    }
  };

  assert.equal(shouldProcessExecutionResult(runtimeState, staleRun, "exec_old"), false);
});

test("shouldProcessExecutionResult rejects non-running runs even when the token matches", () => {
  const run = {
    id: "run_1",
    status: "ABORTED",
    executionToken: "exec_1"
  };
  const runtimeState = {
    runs: {
      run_1: run
    }
  };

  assert.equal(shouldProcessExecutionResult(runtimeState, run, "exec_1"), false);
});
