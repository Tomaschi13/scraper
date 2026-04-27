"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWorkspaceRenderSignature,
  EDITOR_HYDRATION_REASONS,
  shouldHydrateEditorCode
} = require("../ide/editor-hydration-helpers.js");

test("shouldHydrateEditorCode allows explicit editor hydration events", () => {
  for (const reason of Object.values(EDITOR_HYDRATION_REASONS)) {
    assert.equal(shouldHydrateEditorCode({
      reason,
      currentCode: "old();",
      incomingCode: "fresh();"
    }), true);
  }
});

test("shouldHydrateEditorCode ignores passive background sync reasons", () => {
  assert.equal(shouldHydrateEditorCode({
    reason: null,
    currentCode: "userIsTyping();",
    incomingCode: "staleDraft();"
  }), false);

  assert.equal(shouldHydrateEditorCode({
    reason: "watchdog",
    currentCode: "userIsTyping();",
    incomingCode: "staleDraft();"
  }), false);

  assert.equal(shouldHydrateEditorCode({
    reason: "save-draft",
    currentCode: "userIsTyping();",
    incomingCode: "staleDraft();"
  }), false);
});

test("shouldHydrateEditorCode skips no-op writes even for explicit events", () => {
  assert.equal(shouldHydrateEditorCode({
    reason: EDITOR_HYDRATION_REASONS.robotLoad,
    currentCode: "same();",
    incomingCode: "same();"
  }), false);
});

test("shouldHydrateEditorCode normalizes non-string code values", () => {
  assert.equal(shouldHydrateEditorCode({
    reason: EDITOR_HYDRATION_REASONS.initialLoad,
    currentCode: "",
    incomingCode: null
  }), false);

  assert.equal(shouldHydrateEditorCode({
    reason: EDITOR_HYDRATION_REASONS.robotsRefresh,
    currentCode: "local();",
    incomingCode: undefined
  }), true);
});

test("createWorkspaceRenderSignature ignores draft code changes", () => {
  const baseState = {
    authRequired: false,
    draft: {
      selectedRobotId: "robot_1",
      name: "Robot",
      url: "https://example.com",
      tag: "TAG",
      code: "old();"
    },
    robots: [
      {
        id: "robot_1",
        name: "Robot",
        updatedAt: "2026-04-27T10:00:00.000Z"
      }
    ]
  };

  const codeOnlyChange = {
    ...baseState,
    draft: {
      ...baseState.draft,
      code: "userIsStillTyping();"
    }
  };

  assert.equal(
    createWorkspaceRenderSignature(baseState),
    createWorkspaceRenderSignature(codeOnlyChange)
  );
});

test("createWorkspaceRenderSignature tracks non-code workspace changes", () => {
  const baseState = {
    authRequired: false,
    draft: {
      selectedRobotId: "robot_1",
      name: "Robot",
      url: "https://example.com",
      tag: "TAG",
      code: "same();"
    },
    robots: []
  };

  const renamedState = {
    ...baseState,
    draft: {
      ...baseState.draft,
      name: "Renamed Robot"
    }
  };

  assert.notEqual(
    createWorkspaceRenderSignature(baseState),
    createWorkspaceRenderSignature(renamedState)
  );
});
