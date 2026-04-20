"use strict";

const userScriptHelpers = (() => {
  const LEGACY_USER_SCRIPT_FILES = Object.freeze([
    "vendor/jquery-3.6.0.min.js",
    "vendor/underscore.js",
    "vendor/moment-with-locales.min.js",
    "vendor/xlsx.core.min.js",
    "content/legacy-content.js"
  ]);
  const LEGACY_USER_SCRIPT_PRELUDE = `(() => {
  const runtime = globalThis.chrome?.runtime;

  if (!runtime || runtime.onMessage) {
    return;
  }

  try {
    Object.defineProperty(runtime, "onMessage", {
      configurable: true,
      value: { addListener() {} }
    });
  } catch (_) {}
})();`;

  function createUserScriptsUnavailableError(error) {
    const detail = error instanceof Error ? error.message : String(error || "");
    const suffix = detail ? ` Details: ${detail}` : "";
    return new Error(
      "chrome.userScripts is unavailable. Enable \"Allow User Scripts\" for this extension in chrome://extensions and reload the extension."
      + suffix
    );
  }

  async function configureUserScriptWorld(userScriptsApi) {
    if (!userScriptsApi
      || typeof userScriptsApi.getScripts !== "function"
      || typeof userScriptsApi.execute !== "function"
      || typeof userScriptsApi.configureWorld !== "function") {
      throw createUserScriptsUnavailableError();
    }

    try {
      await userScriptsApi.getScripts({ ids: [] });
      await userScriptsApi.configureWorld({ messaging: true });
    } catch (error) {
      throw createUserScriptsUnavailableError(error);
    }
  }

  function buildLegacyUserScriptBootstrap(stepName, stepParams, ajaxUrl) {
    const serializedStepName = JSON.stringify(stepName || "start");
    const serializedStepParams = typeof stepParams === "undefined"
      ? "undefined"
      : JSON.stringify(stepParams);
    const serializedAjaxUrl = JSON.stringify(ajaxUrl || "");

    return `(() => {
  const stepName = ${serializedStepName};
  const stepParams = ${serializedStepParams};
  const ajaxUrl = ${serializedAjaxUrl};
  const stepFn = globalThis.steps?.[stepName];

  if (typeof stepFn !== "function") {
    throw new Error(\`Step "\${stepName}" is not defined.\`);
  }

  const invoke = () => stepParams === null || typeof stepParams === "undefined"
    ? stepFn()
    : stepFn(stepParams);

  if (ajaxUrl) {
    globalThis.ajaxify(ajaxUrl, invoke);
  } else {
    invoke();
  }
})();`;
  }

  function buildLegacyUserScriptSources(robotCode, stepName, stepParams, ajaxUrl) {
    return [{ code: LEGACY_USER_SCRIPT_PRELUDE }]
      .concat(LEGACY_USER_SCRIPT_FILES.map((file) => ({ file })))
      .concat([
        { code: String(robotCode || "") },
        { code: buildLegacyUserScriptBootstrap(stepName, stepParams, ajaxUrl) }
      ]);
  }

  return {
    LEGACY_USER_SCRIPT_FILES,
    LEGACY_USER_SCRIPT_PRELUDE,
    buildLegacyUserScriptBootstrap,
    buildLegacyUserScriptSources,
    configureUserScriptWorld,
    createUserScriptsUnavailableError
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperUserScriptHelpers = userScriptHelpers;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = userScriptHelpers;
}
