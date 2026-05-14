"use strict";

const runnerImageBridgeHelpers = (() => {
  async function notifyRunnerImagesAllowed(runtime, allowed) {
    if (!runtime || typeof runtime.sendMessage !== "function") {
      return;
    }

    try {
      await runtime.sendMessage({
        type: "RUNNER_IMAGES_ALLOWED_CHANGED",
        allowed: Boolean(allowed)
      });
    } catch (_error) {
      // No listener: local extension run, or the runner's bridge page is not
      // open yet. The Playwright route blocker only exists when the runner is
      // driving the browser, so dropping the notification on the floor is
      // correct in those cases.
    }
  }

  async function notifyRunnerRunTerminal(runtime, run) {
    if (!runtime || typeof runtime.sendMessage !== "function" || !run?.id) {
      return;
    }

    try {
      await runtime.sendMessage({
        type: "RUNNER_RUN_TERMINAL",
        run
      });
    } catch (_error) {
      // No bridge page is open for local extension runs, and the runner may
      // already be exiting. The portal has already received its own final run
      // update before this notification is sent.
    }
  }

  return {
    notifyRunnerImagesAllowed,
    notifyRunnerRunTerminal
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRunnerImageBridgeHelpers = runnerImageBridgeHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = runnerImageBridgeHelpers;
}
