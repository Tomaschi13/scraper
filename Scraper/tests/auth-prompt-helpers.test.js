"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createClearedPortalState,
  findLoginTab,
  hasPortalData,
  isLoginUrl,
  shouldPromptForAuth
} = require("../background/auth-prompt-helpers.js");

test("isLoginUrl treats the same login page with different hash fragments as one target", () => {
  assert.equal(
    isLoginUrl(
      "chrome-extension://abc123/login/login.html#retry",
      "chrome-extension://abc123/login/login.html"
    ),
    true
  );
});

test("findLoginTab returns the existing login tab when one is already open", () => {
  const tabs = [
    { id: 11, url: "https://example.com" },
    { id: 12, url: "chrome-extension://abc123/login/login.html#step-2", windowId: 4 }
  ];

  assert.deepEqual(
    findLoginTab(tabs, "chrome-extension://abc123/login/login.html"),
    { id: 12, url: "chrome-extension://abc123/login/login.html#step-2", windowId: 4 }
  );
});

test("findLoginTab ignores tabs without ids or non-matching urls", () => {
  const tabs = [
    { id: 11, url: "https://example.com" },
    { url: "chrome-extension://abc123/login/login.html" }
  ];

  assert.equal(findLoginTab(tabs, "chrome-extension://abc123/login/login.html"), null);
});

test("shouldPromptForAuth only prompts when auth is pending and no login flow is active", () => {
  assert.equal(shouldPromptForAuth({
    authPromptPending: true,
    isReauthenticating: false
  }), true);

  assert.equal(shouldPromptForAuth({
    authPromptPending: true,
    isReauthenticating: true
  }), false);

  assert.equal(shouldPromptForAuth({
    authPromptPending: false,
    isReauthenticating: false
  }), false);
});

test("hasPortalData detects cached robots or loaded draft code", () => {
  assert.equal(hasPortalData({
    robots: [{ id: "robot_1" }],
    draft: null
  }), true);

  assert.equal(hasPortalData({
    robots: [],
    draft: { selectedRobotId: "", name: "", url: "", tag: "", code: "steps.start = function() {};" }
  }), true);

  assert.equal(hasPortalData({
    robots: [],
    draft: { selectedRobotId: "", name: "", url: "", tag: "", code: "" }
  }), false);
});

test("createClearedPortalState returns an empty robot list and blank draft", () => {
  assert.deepEqual(
    createClearedPortalState({ skipVisited: false, maxForks: 30 }),
    {
      robots: [],
      draft: {
        selectedRobotId: "",
        name: "",
        url: "",
        tag: "",
        code: "",
        config: {
          skipVisited: false,
          maxForks: 30
        }
      }
    }
  );
});
