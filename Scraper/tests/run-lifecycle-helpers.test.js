"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isRunningRun,
  getPendingProxyOperationCount,
  hasPendingProxyOperations,
  shouldRefreshProxyAfterStepFailure,
  resolveStepFailureAction,
  incrementPendingProxyOperations,
  decrementPendingProxyOperations,
  withControlPlaneProxyBypass,
  startProxyUsage,
  stopProxyUsage,
  recordProxyDataLoaded,
  snapshotProxyUsage,
  trimOutputTables,
  appendRowsToOutputPreview,
  summarizeRunnerRunStatus,
  shouldProcessExecutionResult,
  createStepOutputCheckpoint,
  rollbackStepOutput,
  getBlockedPageError,
  resolveBlockedPageMaxAttempts,
  describeBlockedPageStepFailure,
  BLOCKED_PAGE_FAILURE_OPTIONS,
  createLegacyQueueEntries,
  isOpenUrlStep,
  dropPairedExecutionStepAfterOpenUrlFailure
} = require("../background/run-lifecycle-helpers.js");

test("withControlPlaneProxyBypass appends portal and loopback hosts", () => {
  assert.deepEqual(
    withControlPlaneProxyBypass([], "http://178.104.237.206:5077"),
    ["178.104.237.206", "127.0.0.1", "localhost", "::1"]
  );
});

test("withControlPlaneProxyBypass preserves custom bypasses and deduplicates case-insensitively", () => {
  assert.deepEqual(
    withControlPlaneProxyBypass("example.com, LOCALHOST, [::1]", "https://portal.example.com/app"),
    ["example.com", "LOCALHOST", "::1", "portal.example.com", "127.0.0.1"]
  );
});

test("isRunningRun returns true only for active runs", () => {
  assert.equal(isRunningRun({ status: "RUNNING" }), true);
  assert.equal(isRunningRun({ status: "ABORTED" }), false);
  assert.equal(isRunningRun(null), false);
});

test("pending proxy operation helpers clamp and mutate counts safely", () => {
  const run = {};

  assert.equal(getPendingProxyOperationCount(run), 0);
  assert.equal(hasPendingProxyOperations(run), false);

  assert.equal(incrementPendingProxyOperations(run), 1);
  assert.equal(incrementPendingProxyOperations(run), 2);
  assert.equal(getPendingProxyOperationCount(run), 2);
  assert.equal(hasPendingProxyOperations(run), true);

  assert.equal(decrementPendingProxyOperations(run), 1);
  assert.equal(decrementPendingProxyOperations(run), 0);
  assert.equal(decrementPendingProxyOperations(run), 0);
  assert.equal(hasPendingProxyOperations(run), false);
});

test("pending proxy operation count treats invalid values as zero", () => {
  assert.equal(getPendingProxyOperationCount({ pendingProxyOperations: -2 }), 0);
  assert.equal(getPendingProxyOperationCount({ pendingProxyOperations: "3.8" }), 3);
  assert.equal(getPendingProxyOperationCount({ pendingProxyOperations: "nope" }), 0);
  assert.equal(incrementPendingProxyOperations(null), 0);
  assert.equal(decrementPendingProxyOperations(null), 0);
});

test("resolveBlockedPageMaxAttempts shrinks the budget when an active proxy can be rotated", () => {
  assert.equal(resolveBlockedPageMaxAttempts({ hasActiveProxy: true }), 2);
  assert.equal(resolveBlockedPageMaxAttempts({ hasActiveProxy: false }), 5);
  assert.equal(resolveBlockedPageMaxAttempts({}), 5);
  assert.equal(resolveBlockedPageMaxAttempts(), 5);
});

test("describeBlockedPageStepFailure produces a non-fatal step failure so the proxy can refresh", () => {
  const failure = describeBlockedPageStepFailure(
    "Blocked by a Cloudflare challenge page (title \"foo\").",
    2
  );
  assert.equal(
    failure.message,
    "Blocked by a Cloudflare challenge page (title \"foo\"). Giving up after 2 attempts."
  );
  assert.equal(failure.options, BLOCKED_PAGE_FAILURE_OPTIONS);
  assert.equal(failure.options.fatal, false);
});

test("BLOCKED_PAGE_FAILURE_OPTIONS keeps blocked-page failures retryable and immutable", () => {
  assert.equal(BLOCKED_PAGE_FAILURE_OPTIONS.fatal, false);
  assert.throws(() => {
    BLOCKED_PAGE_FAILURE_OPTIONS.fatal = true;
  });
});

test("shouldRefreshProxyAfterStepFailure only refreshes active proxies for retryable failures", () => {
  const run = {
    status: "RUNNING",
    activeProxy: {
      type: "portalTag",
      tag: "resi"
    }
  };

  assert.equal(shouldRefreshProxyAfterStepFailure(run, { willRetry: true }), true);
  assert.equal(shouldRefreshProxyAfterStepFailure(run, { fatal: true, willRetry: true }), false);
  assert.equal(shouldRefreshProxyAfterStepFailure(run, { willRetry: false }), false);
  assert.equal(shouldRefreshProxyAfterStepFailure({ ...run, activeProxy: null }, { willRetry: true }), false);
  assert.equal(shouldRefreshProxyAfterStepFailure({ ...run, status: "FAILED" }, { willRetry: true }), false);
  assert.equal(shouldRefreshProxyAfterStepFailure(null, { willRetry: true }), false);
});

test("resolveStepFailureAction mirrors legacy retry, skip, then robot-fail behavior", () => {
  const retries = {
    intervalMs: 90000,
    maxStep: 2,
    maxRun: 500
  };

  assert.equal(resolveStepFailureAction({
    nextAttempt: 1,
    failures: 1,
    retries
  }), "retry");

  assert.equal(resolveStepFailureAction({
    nextAttempt: 2,
    failures: 2,
    retries
  }), "skipStep");

  assert.equal(resolveStepFailureAction({
    nextAttempt: 1,
    failures: 500,
    retries
  }), "failRun");

  assert.equal(resolveStepFailureAction({
    fatal: true,
    nextAttempt: 1,
    failures: 1,
    retries
  }), "failRun");
});

test("proxy usage aggregates data and active duration by proxy source", () => {
  const run = {};

  startProxyUsage(run, { type: "portalTag", tag: "RESI_LT" }, 1000);
  recordProxyDataLoaded(run, 2048, 1);
  recordProxyDataLoaded(run, 1024, 2);

  assert.deepEqual(snapshotProxyUsage(run, 2500), {
    lineItems: [{
      sourceType: "portalTag",
      proxyTag: "RESI_LT",
      label: "RESI_LT",
      bytesLoaded: 3072,
      requestCount: 3,
      proxyActiveMs: 1500
    }]
  });

  stopProxyUsage(run, 3000);
  assert.deepEqual(snapshotProxyUsage(run, 4000).lineItems[0], {
    sourceType: "portalTag",
    proxyTag: "RESI_LT",
    label: "RESI_LT",
    bytesLoaded: 3072,
    requestCount: 3,
    proxyActiveMs: 2000
  });
});

test("proxy usage ignores network data while no proxy is active", () => {
  const run = {};
  assert.equal(recordProxyDataLoaded(run, 1024, 1), null);
  assert.deepEqual(snapshotProxyUsage(run), { lineItems: [] });
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

test("appendRowsToOutputPreview keeps only the newest preview rows", () => {
  const tables = {
    products: [{ sku: "old" }]
  };

  appendRowsToOutputPreview(tables, "products", [
    { sku: "A" },
    { sku: "B" },
    { sku: "C" }
  ], 2);

  assert.deepEqual(tables, {
    products: [{ sku: "B" }, { sku: "C" }]
  });
});

test("trimOutputTables creates a bounded copy for persistence", () => {
  const original = {
    products: [{ sku: "A" }, { sku: "B" }, { sku: "C" }],
    emptyish: "not rows"
  };

  const trimmed = trimOutputTables(original, 2);
  trimmed.products[0].sku = "changed";

  assert.deepEqual(trimmed, {
    products: [{ sku: "changed" }, { sku: "C" }],
    emptyish: []
  });
  assert.equal(original.products[1].sku, "B");
});

test("summarizeRunnerRunStatus returns only the lean runner fields", () => {
  const summary = summarizeRunnerRunStatus({
    id: "run_1",
    robotId: "robot_1",
    robotName: "Example",
    status: "RUNNING",
    phase: "EXECUTING",
    currentUrl: "https://example.com/product",
    startedAt: "2026-05-14T10:00:00.000Z",
    updatedAt: "2026-05-14T10:01:00.000Z",
    queue: [{ id: "step_1" }],
    failures: "2",
    emits: 3,
    rows: 4,
    runSource: "PORTAL_SERVER",
    logs: ["must not leak"],
    outputTables: { products: [{ sku: "must not leak" }] },
    currentStep: { params: { huge: true } },
    code: "must not leak"
  });

  assert.deepEqual(summary, {
    id: "run_1",
    robotId: "robot_1",
    robotName: "Example",
    status: "RUNNING",
    phase: "EXECUTING",
    currentUrl: "https://example.com/product",
    startedAt: "2026-05-14T10:00:00.000Z",
    finishedAt: null,
    updatedAt: "2026-05-14T10:01:00.000Z",
    queueLength: 1,
    failures: 2,
    emits: 3,
    rows: 4,
    runSource: "PORTAL_SERVER"
  });
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

test("getBlockedPageError detects in-place 'Just a moment...' challenge on real URL", () => {
  const result = getBlockedPageError({
    pageTitle: "Just a moment...",
    pageUrl: "https://www.senukai.lt/c/telefonai-plansetiniai-kompiuteriai/mobilieji-telefonai/5nt"
  });
  assert.match(result, /Cloudflare challenge page/);
});

test("getBlockedPageError does not false-positive on titles that merely mention 'just a moment'", () => {
  assert.equal(getBlockedPageError({
    pageTitle: "Just a moment of your time: our story | Senukai",
    pageUrl: "https://www.senukai.lt/about"
  }), null);
});

test("createLegacyQueueEntries splits URL steps into execute then openUrl entries", () => {
  const entries = createLegacyQueueEntries({
    id: "step_execute",
    url: "https://example.com/p/1",
    step: "product",
    params: { sku: "1" },
    gofast: false,
    retryCount: 0
  }, {
    createId: () => "step_open"
  });

  assert.deepEqual(entries, [
    {
      id: "step_execute",
      url: "",
      step: "product",
      params: { sku: "1" },
      gofast: false,
      retryCount: 0,
      ajaxurl: ""
    },
    {
      id: "step_open",
      url: "https://example.com/p/1",
      method: "openUrl",
      retryCount: 0
    }
  ]);
  assert.equal(isOpenUrlStep(entries[1]), true);
});

test("dropPairedExecutionStepAfterOpenUrlFailure mirrors legacy openUrl skip behavior", () => {
  const queue = [
    { id: "unrelated", step: "next_product", url: "" },
    { id: "paired_execute", step: "product", url: "" }
  ];
  const dropped = dropPairedExecutionStepAfterOpenUrlFailure(queue, {
    id: "failed_open",
    method: "openUrl",
    url: "https://example.com/p/1"
  });

  assert.deepEqual(dropped, { id: "paired_execute", step: "product", url: "" });
  assert.deepEqual(queue, [{ id: "unrelated", step: "next_product", url: "" }]);
  assert.equal(dropPairedExecutionStepAfterOpenUrlFailure(queue, {
    id: "failed_execute",
    step: "product",
    url: ""
  }), null);
});

test("dropPairedExecutionStepAfterOpenUrlFailure ignores empty and invalid queues", () => {
  assert.equal(dropPairedExecutionStepAfterOpenUrlFailure([], {
    method: "openUrl",
    url: "https://example.com/p/1"
  }), null);
  assert.equal(dropPairedExecutionStepAfterOpenUrlFailure(null, {
    method: "openUrl",
    url: "https://example.com/p/1"
  }), null);
});

test("createLegacyQueueEntries keeps empty-url and gofast steps execute-only", () => {
  assert.deepEqual(createLegacyQueueEntries({
    id: "step_inline",
    url: "",
    step: "inline",
    params: null,
    gofast: false,
    retryCount: 0
  }), [{
    id: "step_inline",
    url: "",
    step: "inline",
    params: null,
    gofast: false,
    retryCount: 0,
    ajaxurl: ""
  }]);

  assert.deepEqual(createLegacyQueueEntries({
    id: "step_fast",
    url: "https://example.com/list",
    step: "grid",
    params: null,
    gofast: true,
    retryCount: 0
  }), [{
    id: "step_fast",
    url: "",
    step: "grid",
    params: null,
    gofast: true,
    retryCount: 0,
    ajaxurl: "https://example.com/list"
  }]);
});
