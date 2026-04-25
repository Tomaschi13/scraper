"use strict";

const runLifecycleHelpers = (() => {
  function isObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function isRunningRun(run) {
    return Boolean(run && run.status === "RUNNING");
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

  return {
    isRunningRun,
    shouldProcessExecutionResult,
    createStepOutputCheckpoint,
    rollbackStepOutput,
    getBlockedPageError,
    createLegacyQueueEntries,
    isOpenUrlStep
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRunLifecycleHelpers = runLifecycleHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = runLifecycleHelpers;
}
