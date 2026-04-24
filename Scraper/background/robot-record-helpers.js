"use strict";

const robotRecordHelpers = (() => {
  function cloneConfig(config) {
    return { ...(config || {}) };
  }

  function normalizeRobotFromPortal(portalRobot, {
    defaultConfig = {},
    defaultScript = "",
    fallbackRobot = null
  } = {}) {
    const fallback = fallbackRobot && typeof fallbackRobot === "object" ? fallbackRobot : {};
    const now = new Date().toISOString();

    return {
      id: String(portalRobot?.id || fallback.id || "").trim(),
      name: String(portalRobot?.name || fallback.name || ""),
      url: typeof portalRobot?.url === "string" ? portalRobot.url : (fallback.url || ""),
      tag: typeof portalRobot?.tag === "string" ? portalRobot.tag : (fallback.tag || ""),
      code: typeof portalRobot?.code === "string"
        ? portalRobot.code
        : (typeof fallback.code === "string" ? fallback.code : defaultScript),
      config: {
        ...defaultConfig,
        ...cloneConfig(fallback.config),
        ...cloneConfig(portalRobot?.config)
      },
      createdAt: portalRobot?.createdAt || fallback.createdAt || now,
      updatedAt: portalRobot?.updatedAt || fallback.updatedAt || now
    };
  }

  function robotRecordsEqual(left, right) {
    if (!left || !right) {
      return false;
    }

    return left.id === right.id
      && left.name === right.name
      && left.url === right.url
      && left.tag === right.tag
      && left.code === right.code
      && left.createdAt === right.createdAt
      && left.updatedAt === right.updatedAt
      && JSON.stringify(left.config || {}) === JSON.stringify(right.config || {});
  }

  function draftMatchesRobot(draft, robot) {
    if (!draft || !robot) {
      return false;
    }

    return draft.selectedRobotId === robot.id
      && draft.name === robot.name
      && draft.url === robot.url
      && draft.tag === robot.tag
      && draft.code === robot.code
      && JSON.stringify(draft.config || {}) === JSON.stringify(robot.config || {});
  }

  function applyPortalRobotUpdate({
    robots,
    draft,
    portalRobot,
    defaultConfig = {},
    defaultScript = "",
    forceDraftSync = false,
    syncDraft = false
  }) {
    const list = Array.isArray(robots) ? robots : [];
    const existingIndex = list.findIndex((robot) => robot.id === portalRobot?.id);
    const existingRobot = existingIndex === -1 ? null : list[existingIndex];
    const preMergeSnapshot = existingRobot ? { ...existingRobot, config: cloneConfig(existingRobot.config) } : null;
    const nextRobot = normalizeRobotFromPortal(portalRobot, {
      defaultConfig,
      defaultScript,
      fallbackRobot: existingRobot
    });

    let resolvedRobot = nextRobot;
    let changed = false;

    if (existingRobot) {
      if (!robotRecordsEqual(existingRobot, nextRobot)) {
        Object.assign(existingRobot, nextRobot);
        changed = true;
      }
      resolvedRobot = existingRobot;
    } else {
      list.push(nextRobot);
      changed = true;
    }

    let nextDraft = draft;
    const shouldSyncDraft = syncDraft && (forceDraftSync || draft?.selectedRobotId === resolvedRobot.id);
    if (shouldSyncDraft && !draftMatchesRobot(draft, resolvedRobot)) {
      const draftIsClean = forceDraftSync || (preMergeSnapshot ? draftMatchesRobot(draft, preMergeSnapshot) : false);
      if (draftIsClean) {
        nextDraft = {
          selectedRobotId: resolvedRobot.id,
          name: resolvedRobot.name,
          url: resolvedRobot.url,
          tag: resolvedRobot.tag,
          code: resolvedRobot.code,
          config: cloneConfig(resolvedRobot.config)
        };
        changed = true;
      }
    }

    return {
      robot: resolvedRobot,
      draft: nextDraft,
      changed
    };
  }

  return {
    applyPortalRobotUpdate,
    normalizeRobotFromPortal,
    robotRecordsEqual
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperRobotRecordHelpers = robotRecordHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = robotRecordHelpers;
}
