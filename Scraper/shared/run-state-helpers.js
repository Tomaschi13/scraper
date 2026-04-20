"use strict";

const runStateHelpers = (() => {
  function parseRunTime(value) {
    if (typeof value !== "string" || !value) {
      return 0;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function compareRunsByRecency(left, right) {
    const leftTime = parseRunTime(left?.updatedAt)
      || parseRunTime(left?.finishedAt)
      || parseRunTime(left?.startedAt);
    const rightTime = parseRunTime(right?.updatedAt)
      || parseRunTime(right?.finishedAt)
      || parseRunTime(right?.startedAt);

    if (leftTime !== rightTime) {
      return rightTime - leftTime;
    }

    const leftId = String(left?.id || "");
    const rightId = String(right?.id || "");
    return rightId.localeCompare(leftId);
  }

  function sortRuns(runs) {
    return (Array.isArray(runs) ? runs : []).slice().sort(compareRunsByRecency);
  }

  function findRunById(runs, runId) {
    if (!runId) {
      return null;
    }

    return (Array.isArray(runs) ? runs : []).find((run) => run?.id === runId) || null;
  }

  function resolveSelectedRunId(runs, selectedRunId) {
    const sortedRuns = sortRuns(runs);

    if (!sortedRuns.length) {
      return null;
    }

    if (findRunById(sortedRuns, selectedRunId)) {
      return selectedRunId;
    }

    const runningRun = sortedRuns.find((run) => run?.status === "RUNNING");
    return runningRun?.id || sortedRuns[0]?.id || null;
  }

  return {
    compareRunsByRecency,
    findRunById,
    resolveSelectedRunId,
    sortRuns
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRunStateHelpers = runStateHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = runStateHelpers;
}
