"use strict";

const runtimeBridgeHelpers = (() => {
  function isPreviewableTab(tab) {
    return Boolean(tab && /^https?:/.test(tab.url || ""));
  }

  function selectPreviewTabId(runtimeState, tabs = []) {
    const activeRun = runtimeState?.lastRunId
      ? runtimeState?.runs?.[runtimeState.lastRunId]
      : null;

    if (Number.isInteger(activeRun?.tabId)) {
      return activeRun.tabId;
    }

    if (Number.isInteger(runtimeState?.lastPageTabId)) {
      return runtimeState.lastPageTabId;
    }

    const candidate = (Array.isArray(tabs) ? tabs : []).find(isPreviewableTab);
    return Number.isInteger(candidate?.id) ? candidate.id : null;
  }

  function shouldExecuteRunOnRuntimeReady(run) {
    return Boolean(
      run
      && run.status === "RUNNING"
      && run.currentStep
      && run.phase === "AWAITING_DOM_READY"
    );
  }

  return {
    selectPreviewTabId,
    shouldExecuteRunOnRuntimeReady
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRuntimeBridgeHelpers = runtimeBridgeHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = runtimeBridgeHelpers;
}
