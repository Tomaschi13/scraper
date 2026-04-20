"use strict";

const runLifecycleHelpers = (() => {
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

  return {
    isRunningRun,
    shouldProcessExecutionResult
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRunLifecycleHelpers = runLifecycleHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = runLifecycleHelpers;
}
