"use strict";

const authPromptHelpers = (() => {
  function normalizeUrl(url) {
    try {
      const parsed = new URL(String(url || ""));
      parsed.hash = "";
      return parsed.href;
    } catch (_) {
      return String(url || "").split("#")[0];
    }
  }

  function isLoginUrl(url, loginUrl) {
    return normalizeUrl(url) === normalizeUrl(loginUrl);
  }

  function findLoginTab(tabs, loginUrl) {
    if (!Array.isArray(tabs) || !loginUrl) {
      return null;
    }

    return tabs.find((tab) => Number.isInteger(tab?.id) && isLoginUrl(tab.url, loginUrl)) || null;
  }

  function shouldPromptForAuth(state = {}) {
    return Boolean(state.authPromptPending && !state.isReauthenticating);
  }

  function hasPortalData(state = {}) {
    const robots = Array.isArray(state.robots) ? state.robots : [];
    const draft = state.draft || {};

    return robots.length > 0 || Boolean(
      draft.selectedRobotId
      || draft.name
      || draft.url
      || draft.tag
      || draft.code
    );
  }

  function createClearedPortalState(defaultConfig = {}) {
    return {
      robots: [],
      draft: {
        selectedRobotId: "",
        name: "",
        url: "",
        tag: "",
        code: "",
        config: { ...defaultConfig }
      }
    };
  }

  return {
    createClearedPortalState,
    findLoginTab,
    hasPortalData,
    isLoginUrl,
    normalizeUrl,
    shouldPromptForAuth
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperAuthPromptHelpers = authPromptHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = authPromptHelpers;
}
