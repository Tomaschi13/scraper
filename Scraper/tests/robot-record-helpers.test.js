"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyPortalRobotUpdate,
  normalizeRobotFromPortal
} = require("../background/robot-record-helpers.js");

const DEFAULT_CONFIG = {
  skipVisited: false,
  respectRobotsTxt: false,
  maxForks: 30,
  waitForRequests: false,
  dataUsageMetering: false
};

const DEFAULT_SCRIPT = "steps.start = function start() { done(); };";

test("normalizeRobotFromPortal preserves cached code when the portal list payload omits it", () => {
  const normalized = normalizeRobotFromPortal(
    {
      id: "robot-1",
      name: "Robot 1",
      updatedAt: "2026-04-21T08:30:00.000Z"
    },
    {
      defaultConfig: DEFAULT_CONFIG,
      defaultScript: DEFAULT_SCRIPT,
      fallbackRobot: {
        id: "robot-1",
        name: "Robot 1",
        url: "https://example.com",
        tag: "phones",
        code: "steps.start = function start() { wait(1500); done(); };",
        config: { ...DEFAULT_CONFIG, skipVisited: true },
        createdAt: "2026-04-20T08:30:00.000Z",
        updatedAt: "2026-04-20T08:30:00.000Z"
      }
    }
  );

  assert.equal(normalized.code, "steps.start = function start() { wait(1500); done(); };");
  assert.equal(normalized.url, "https://example.com");
  assert.deepEqual(normalized.config, { ...DEFAULT_CONFIG, skipVisited: true });
});

test("applyPortalRobotUpdate refreshes the selected draft from the portal when requested", () => {
  const robots = [{
    id: "robot-1",
    name: "Robot 1",
    url: "https://old.example.com",
    tag: "phones",
    code: "old();",
    config: { ...DEFAULT_CONFIG },
    createdAt: "2026-04-20T08:30:00.000Z",
    updatedAt: "2026-04-20T08:30:00.000Z"
  }];
  const draft = {
    selectedRobotId: "robot-1",
    name: "Robot 1",
    url: "https://old.example.com",
    tag: "phones",
    code: "old();",
    config: { ...DEFAULT_CONFIG }
  };

  const result = applyPortalRobotUpdate({
    robots,
    draft,
    portalRobot: {
      id: "robot-1",
      name: "Robot 1",
      url: "https://fresh.example.com",
      tag: "phones",
      code: "fresh();",
      config: { skipVisited: true },
      createdAt: "2026-04-20T08:30:00.000Z",
      updatedAt: "2026-04-21T08:30:00.000Z"
    },
    defaultConfig: DEFAULT_CONFIG,
    defaultScript: DEFAULT_SCRIPT,
    syncDraft: true
  });

  assert.equal(result.robot.code, "fresh();");
  assert.equal(result.draft.code, "fresh();");
  assert.equal(result.draft.url, "https://fresh.example.com");
  assert.equal(result.changed, true);
});

test("applyPortalRobotUpdate keeps unsaved draft code when the refresh is cache-only", () => {
  const robots = [{
    id: "robot-1",
    name: "Robot 1",
    url: "https://old.example.com",
    tag: "phones",
    code: "old();",
    config: { ...DEFAULT_CONFIG },
    createdAt: "2026-04-20T08:30:00.000Z",
    updatedAt: "2026-04-20T08:30:00.000Z"
  }];
  const draft = {
    selectedRobotId: "robot-1",
    name: "Robot 1",
    url: "https://old.example.com",
    tag: "phones",
    code: "localUnsaved();",
    config: { ...DEFAULT_CONFIG }
  };

  const result = applyPortalRobotUpdate({
    robots,
    draft,
    portalRobot: {
      id: "robot-1",
      name: "Robot 1",
      url: "https://fresh.example.com",
      tag: "phones",
      code: "freshFromPortal();",
      config: { skipVisited: true },
      createdAt: "2026-04-20T08:30:00.000Z",
      updatedAt: "2026-04-21T08:30:00.000Z"
    },
    defaultConfig: DEFAULT_CONFIG,
    defaultScript: DEFAULT_SCRIPT,
    syncDraft: false
  });

  assert.equal(result.robot.code, "freshFromPortal();");
  assert.equal(result.draft.code, "localUnsaved();");
  assert.equal(result.draft.url, "https://old.example.com");
  assert.equal(result.changed, true);
});

test("applyPortalRobotUpdate preserves a dirty draft even when syncDraft is true", () => {
  const robots = [{
    id: "robot-1",
    name: "Robot 1",
    url: "https://old.example.com",
    tag: "phones",
    code: "old();",
    config: { ...DEFAULT_CONFIG },
    createdAt: "2026-04-20T08:30:00.000Z",
    updatedAt: "2026-04-20T08:30:00.000Z"
  }];
  const draft = {
    selectedRobotId: "robot-1",
    name: "Robot 1",
    url: "https://old.example.com",
    tag: "phones",
    code: "userEditedButNotSaved();",
    config: { ...DEFAULT_CONFIG }
  };

  const result = applyPortalRobotUpdate({
    robots,
    draft,
    portalRobot: {
      id: "robot-1",
      name: "Robot 1",
      url: "https://fresh.example.com",
      tag: "phones",
      code: "freshFromPortal();",
      config: { skipVisited: true },
      createdAt: "2026-04-20T08:30:00.000Z",
      updatedAt: "2026-04-21T08:30:00.000Z"
    },
    defaultConfig: DEFAULT_CONFIG,
    defaultScript: DEFAULT_SCRIPT,
    syncDraft: true
  });

  assert.equal(result.robot.code, "freshFromPortal();");
  assert.equal(result.draft.code, "userEditedButNotSaved();");
  assert.equal(result.draft.url, "https://old.example.com");
  assert.equal(result.changed, true);
});
