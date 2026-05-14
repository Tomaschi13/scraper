"use strict";

const runLifecycleHelpers = (() => {
  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isRunningRun(run) {
    return Boolean(run && run.status === "RUNNING");
  }

  function normalizeNonNegativeInteger(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  }

  const CONTROL_PLANE_PROXY_BYPASS_HOSTS = Object.freeze([
    "127.0.0.1",
    "localhost",
    "::1"
  ]);

  function normalizeProxyBypassEntry(value) {
    return String(value || "").trim().replace(/^\[|\]$/g, "");
  }

  function addProxyBypassEntry(entries, seen, value) {
    const entry = normalizeProxyBypassEntry(value);
    if (!entry) {
      return;
    }

    const key = entry.toLowerCase();
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    entries.push(entry);
  }

  function getPortalProxyBypassHost(portalOrigin) {
    try {
      return normalizeProxyBypassEntry(new URL(String(portalOrigin || "")).hostname);
    } catch (_error) {
      return "";
    }
  }

  function withControlPlaneProxyBypass(value, portalOrigin = "") {
    const entries = [];
    const seen = new Set();

    if (Array.isArray(value)) {
      value.forEach((entry) => addProxyBypassEntry(entries, seen, entry));
    } else {
      String(value || "")
        .split(",")
        .forEach((entry) => addProxyBypassEntry(entries, seen, entry));
    }

    addProxyBypassEntry(entries, seen, getPortalProxyBypassHost(portalOrigin));
    CONTROL_PLANE_PROXY_BYPASS_HOSTS.forEach((entry) => addProxyBypassEntry(entries, seen, entry));

    return entries;
  }

  function getPendingProxyOperationCount(run) {
    const count = Number(run?.pendingProxyOperations);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  }

  function hasPendingProxyOperations(run) {
    return getPendingProxyOperationCount(run) > 0;
  }

  function shouldRefreshProxyAfterStepFailure(run, { fatal = false, willRetry = false } = {}) {
    return isRunningRun(run)
      && Boolean(run.activeProxy)
      && !fatal
      && Boolean(willRetry);
  }

  function resolveStepFailureAction({ fatal = false, nextAttempt = 0, failures = 0, retries = {} } = {}) {
    const attemptCount = normalizeNonNegativeInteger(nextAttempt);
    const failureCount = normalizeNonNegativeInteger(failures);
    const maxStep = normalizeNonNegativeInteger(retries.maxStep);
    const maxRun = normalizeNonNegativeInteger(retries.maxRun);

    if (fatal || (maxRun > 0 && failureCount >= maxRun)) {
      return "failRun";
    }

    if (maxStep > 0 && attemptCount < maxStep) {
      return "retry";
    }

    return "skipStep";
  }

  function incrementPendingProxyOperations(run) {
    if (!run || typeof run !== "object") {
      return 0;
    }

    run.pendingProxyOperations = getPendingProxyOperationCount(run) + 1;
    return run.pendingProxyOperations;
  }

  function decrementPendingProxyOperations(run) {
    if (!run || typeof run !== "object") {
      return 0;
    }

    run.pendingProxyOperations = Math.max(getPendingProxyOperationCount(run) - 1, 0);
    return run.pendingProxyOperations;
  }

  function normalizeProxyUsageSource(source) {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      return null;
    }

    const sourceType = String(source.type || "unknown").trim() || "unknown";
    const proxyTag = sourceType === "portalTag"
      ? String(source.tag || "").trim()
      : "";
    const proxy = source.proxy && typeof source.proxy === "object" ? source.proxy : {};
    const directLabel = proxy.host
      ? `${proxy.scheme || "http"}://${proxy.host}:${proxy.port || 8888}`
      : "direct proxy";

    return {
      sourceType,
      proxyTag,
      label: proxyTag || directLabel
    };
  }

  function getProxyUsageKey(source) {
    const normalized = normalizeProxyUsageSource(source);
    if (!normalized) {
      return "";
    }
    if (normalized.proxyTag) {
      return `portalTag:${normalized.proxyTag.toLowerCase()}`;
    }
    return `${normalized.sourceType}:${normalized.label}`;
  }

  function ensureProxyUsageState(run) {
    if (!run || typeof run !== "object") {
      return null;
    }
    if (!isObject(run.proxyUsage)) {
      run.proxyUsage = {
        items: {},
        activeKey: "",
        activeStartedAt: null
      };
    }
    if (!isObject(run.proxyUsage.items)) {
      run.proxyUsage.items = {};
    }
    return run.proxyUsage;
  }

  function ensureProxyUsageItem(run, source) {
    const usage = ensureProxyUsageState(run);
    const normalized = normalizeProxyUsageSource(source);
    const key = getProxyUsageKey(source);
    if (!usage || !normalized || !key) {
      return null;
    }
    if (!usage.items[key]) {
      usage.items[key] = {
        key,
        sourceType: normalized.sourceType,
        proxyTag: normalized.proxyTag,
        label: normalized.label,
        bytesLoaded: 0,
        requestCount: 0,
        proxyActiveMs: 0
      };
    }
    return usage.items[key];
  }

  function addActiveProxyElapsed(run, nowMs = Date.now()) {
    const usage = ensureProxyUsageState(run);
    if (!usage?.activeKey || !Number.isFinite(Number(usage.activeStartedAt))) {
      return 0;
    }
    const startedAt = Number(usage.activeStartedAt);
    const elapsed = Math.max(normalizeNonNegativeInteger(nowMs - startedAt), 0);
    const item = usage.items[usage.activeKey];
    if (item && elapsed) {
      item.proxyActiveMs = normalizeNonNegativeInteger(item.proxyActiveMs) + elapsed;
    }
    usage.activeStartedAt = nowMs;
    return elapsed;
  }

  function startProxyUsage(run, source, nowMs = Date.now()) {
    const usage = ensureProxyUsageState(run);
    const item = ensureProxyUsageItem(run, source);
    if (!usage || !item) {
      return null;
    }

    if (usage.activeKey && usage.activeKey !== item.key) {
      addActiveProxyElapsed(run, nowMs);
    }

    usage.activeKey = item.key;
    usage.activeStartedAt = usage.activeStartedAt && usage.activeKey === item.key
      ? usage.activeStartedAt
      : nowMs;
    return item;
  }

  function stopProxyUsage(run, nowMs = Date.now()) {
    const usage = ensureProxyUsageState(run);
    if (!usage) {
      return null;
    }
    addActiveProxyElapsed(run, nowMs);
    usage.activeKey = "";
    usage.activeStartedAt = null;
    return usage;
  }

  function recordProxyDataLoaded(run, bytesLoaded, requestCount = 1) {
    const usage = ensureProxyUsageState(run);
    if (!usage?.activeKey) {
      return null;
    }
    const item = usage.items[usage.activeKey];
    if (!item) {
      return null;
    }
    item.bytesLoaded = normalizeNonNegativeInteger(item.bytesLoaded) + normalizeNonNegativeInteger(bytesLoaded);
    item.requestCount = normalizeNonNegativeInteger(item.requestCount) + normalizeNonNegativeInteger(requestCount);
    return item;
  }

  function snapshotProxyUsage(run, nowMs = Date.now()) {
    const usage = ensureProxyUsageState(run);
    if (!usage) {
      return { lineItems: [] };
    }

    const items = Object.values(usage.items).map((item) => ({ ...item }));
    if (usage.activeKey && Number.isFinite(Number(usage.activeStartedAt))) {
      const activeItem = items.find((item) => item.key === usage.activeKey);
      if (activeItem) {
        activeItem.proxyActiveMs += Math.max(normalizeNonNegativeInteger(nowMs - Number(usage.activeStartedAt)), 0);
      }
    }

    return {
      lineItems: items
        .filter((item) => item.bytesLoaded || item.requestCount || item.proxyActiveMs)
        .map(({ key: _key, ...item }) => item)
    };
  }

  function cloneOutputRow(row) {
    return isObject(row) ? { ...row } : row;
  }

  function trimOutputTables(outputTables, rowLimit = 250) {
    const limit = Math.max(Number(rowLimit) || 0, 0);
    const tables = {};

    if (!isObject(outputTables) || limit === 0) {
      return tables;
    }

    for (const [tableName, rows] of Object.entries(outputTables)) {
      if (!Array.isArray(rows)) {
        tables[tableName] = [];
        continue;
      }
      tables[tableName] = rows.slice(-limit).map(cloneOutputRow);
    }

    return tables;
  }

  function appendRowsToOutputPreview(outputTables, tableName, rows, rowLimit = 250) {
    const limit = Math.max(Number(rowLimit) || 0, 0);
    const tables = isObject(outputTables) ? outputTables : {};
    const name = String(tableName || "output");

    if (!Array.isArray(tables[name])) {
      tables[name] = [];
    }

    if (limit === 0) {
      tables[name] = [];
      return tables;
    }

    const incomingRows = Array.isArray(rows) ? rows : [];
    tables[name].push(...incomingRows.map(cloneOutputRow));

    if (tables[name].length > limit) {
      tables[name].splice(0, tables[name].length - limit);
    }

    return tables;
  }

  function shouldProcessExecutionResult(runtimeState, run, executionToken) {
    if (!runtimeState?.runs || !run || !executionToken) {
      return false;
    }

    const liveRun = runtimeState.runs[run.id];
    return liveRun === run
      && isRunningRun(run)
      && run.executionToken === executionToken;
  }

  function createStepOutputCheckpoint(run) {
    const tableLengths = {};
    const tables = isObject(run?.outputTables) ? run.outputTables : {};

    for (const [tableName, rows] of Object.entries(tables)) {
      tableLengths[tableName] = Array.isArray(rows) ? rows.length : 0;
    }

    return {
      tableLengths,
      emits: Number.isFinite(run?.emits) ? run.emits : 0,
      rows: Number.isFinite(run?.rows) ? run.rows : 0
    };
  }

  function rollbackStepOutput(run, checkpoint) {
    if (!run || !isObject(checkpoint) || !isObject(checkpoint.tableLengths)) {
      return { removedEmits: 0, removedRows: 0 };
    }

    const tables = isObject(run.outputTables) ? run.outputTables : {};
    const tableLengths = checkpoint.tableLengths;
    const previousEmits = Number.isFinite(run.emits) ? run.emits : 0;
    const previousRows = Number.isFinite(run.rows) ? run.rows : 0;

    for (const [tableName, rows] of Object.entries(tables)) {
      if (!Object.prototype.hasOwnProperty.call(tableLengths, tableName)) {
        delete tables[tableName];
        continue;
      }

      const checkpointLength = Math.max(Number(tableLengths[tableName]) || 0, 0);
      if (Array.isArray(rows)) {
        rows.splice(checkpointLength);
      } else {
        tables[tableName] = [];
      }
    }

    run.outputTables = tables;
    run.emits = Number.isFinite(checkpoint.emits) ? checkpoint.emits : previousEmits;
    run.rows = Number.isFinite(checkpoint.rows) ? checkpoint.rows : previousRows;

    return {
      removedEmits: Math.max(previousEmits - run.emits, 0),
      removedRows: Math.max(previousRows - run.rows, 0)
    };
  }

  const BLOCKED_PAGE_FAILURE_OPTIONS = Object.freeze({ fatal: false });

  function resolveBlockedPageMaxAttempts({ hasActiveProxy = false } = {}) {
    return hasActiveProxy ? 2 : 5;
  }

  function describeBlockedPageStepFailure(blockedPageError, maxAttempts) {
    return {
      message: `${blockedPageError} Giving up after ${maxAttempts} attempts.`,
      options: BLOCKED_PAGE_FAILURE_OPTIONS
    };
  }

  function getBlockedPageError({ pageTitle = "", pageUrl = "" } = {}) {
    const title = String(pageTitle || "").trim();
    const url = String(pageUrl || "").trim();
    const normalizedTitle = title.toLowerCase();
    const normalizedUrl = url.toLowerCase();
    const challengeUrlPattern = /\/cdn-cgi\/(challenge-platform|l\/chk_captcha)\b/;
    const cloudflareTitlePattern = /(attention required|just a moment|please wait|verify you are human|security check)/;

    const standaloneChallengeTitlePattern = /^just a moment\.*$/i;
    const looksLikeCloudflareChallenge = challengeUrlPattern.test(normalizedUrl)
      || (normalizedTitle.includes("cloudflare") && cloudflareTitlePattern.test(normalizedTitle))
      || (/^just a moment/i.test(normalizedTitle) && normalizedUrl.includes("/cdn-cgi/"))
      || standaloneChallengeTitlePattern.test(normalizedTitle);

    if (!looksLikeCloudflareChallenge) {
      return null;
    }

    const context = [];
    if (title) {
      context.push(`title "${title}"`);
    }
    if (url) {
      context.push(`URL ${url}`);
    }

    return `Blocked by a Cloudflare challenge page${context.length ? ` (${context.join(", ")})` : ""}.`;
  }

  function createLegacyQueueEntries(step, options = {}) {
    const idFactory = typeof options.createId === "function"
      ? options.createId
      : (prefix) => `${prefix}_${Math.random().toString(36).slice(2)}`;

    if (!step?.url || step.gofast) {
      return [{
        ...step,
        url: "",
        ajaxurl: step?.gofast ? (step.ajaxurl || step.url || "") : ""
      }];
    }

    return [
      {
        ...step,
        url: "",
        ajaxurl: ""
      },
      {
        id: idFactory("step"),
        url: step.url,
        method: "openUrl",
        retryCount: 0
      }
    ];
  }

  function isOpenUrlStep(step) {
    return step?.method === "openUrl";
  }

  function dropPairedExecutionStepAfterOpenUrlFailure(queue, failedStep) {
    if (!isOpenUrlStep(failedStep) || !Array.isArray(queue) || !queue.length) {
      return null;
    }

    return queue.pop() || null;
  }

  return {
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
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRunLifecycleHelpers = runLifecycleHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = runLifecycleHelpers;
}
