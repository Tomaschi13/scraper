"use strict";

(function initializeEditorHydrationHelpers(root, factory) {
  const helpers = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }

  root.ideEditorHydrationHelpers = helpers;
})(typeof globalThis !== "undefined" ? globalThis : this, function createEditorHydrationHelpers() {
  const EDITOR_HYDRATION_REASONS = Object.freeze({
    initialLoad: "initial-load",
    robotLoad: "robot-load",
    robotsRefresh: "robots-refresh"
  });

  const EXPLICIT_EDITOR_HYDRATION_REASONS = new Set(Object.values(EDITOR_HYDRATION_REASONS));

  function normalizeCode(value) {
    return typeof value === "string" ? value : "";
  }

  function shouldHydrateEditorCode({ reason, currentCode, incomingCode } = {}) {
    if (!EXPLICIT_EDITOR_HYDRATION_REASONS.has(reason)) {
      return false;
    }

    return normalizeCode(currentCode) !== normalizeCode(incomingCode);
  }

  function createWorkspaceRenderSignature(source = {}) {
    const draft = source.draft || {};
    const robots = Array.isArray(source.robots) ? source.robots : [];

    return JSON.stringify({
      authRequired: Boolean(source.authRequired),
      draft: {
        selectedRobotId: draft.selectedRobotId || "",
        name: draft.name || "",
        url: draft.url || "",
        tag: draft.tag || ""
      },
      robots: robots.map((robot) => ({
        id: robot.id || "",
        name: robot.name || "",
        updatedAt: robot.updatedAt || ""
      }))
    });
  }

  return {
    createWorkspaceRenderSignature,
    EDITOR_HYDRATION_REASONS,
    shouldHydrateEditorCode
  };
});
