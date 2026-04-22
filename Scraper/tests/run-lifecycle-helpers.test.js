"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRunningRun,
  shouldProcessExecutionResult,
  createStepOutputCheckpoint,
  rollbackStepOutput,
  getBlockedPageError
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

test("createStepOutputCheckpoint snapshots current table lengths and counters", () => {
  const checkpoint = createStepOutputCheckpoint({
    outputTables: {
      pages: [{ id: 1 }, { id: 2 }],
      products: [{ sku: "A" }]
    },
    emits: 3,
    rows: 7
  });

  assert.deepEqual(checkpoint, {
    tableLengths: {
      pages: 2,
      products: 1
    },
    emits: 3,
    rows: 7
  });
});

test("rollbackStepOutput removes rows and tables added by a failed step", () => {
  const run = {
    outputTables: {
      pages: [{ id: 1 }, { id: 2 }, { id: 3 }],
      products: [{ sku: "A" }],
      transient: [{ temp: true }]
    },
    emits: 5,
    rows: 9
  };

  const rollback = rollbackStepOutput(run, {
    tableLengths: {
      pages: 2,
      products: 1
    },
    emits: 3,
    rows: 7
  });

  assert.deepEqual(run.outputTables, {
    pages: [{ id: 1 }, { id: 2 }],
    products: [{ sku: "A" }]
  });
  assert.equal(run.emits, 3);
  assert.equal(run.rows, 7);
  assert.deepEqual(rollback, {
    removedEmits: 2,
    removedRows: 2
  });
});

test("getBlockedPageError detects Cloudflare challenge titles and URLs", () => {
  const titleOnly = getBlockedPageError({
    pageTitle: "Attention Required! | Cloudflare",
    pageUrl: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
  });
  assert.match(titleOnly, /Cloudflare challenge page/);

  const urlOnly = getBlockedPageError({
    pageTitle: "Just a moment...",
    pageUrl: "https://www.example.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"
  });
  assert.match(urlOnly, /Cloudflare challenge page/);

  assert.equal(getBlockedPageError({
    pageTitle: "Mobile Phones",
    pageUrl: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
  }), null);
});
