"use strict";

// Pure router that translates the legacy content-script messages
// (emitted by content/legacy-content.js) into calls against the existing
// service-worker helpers. Split out from service-worker.js so we can unit-test
// dispatch without bootstrapping the whole extension.
//
// The legacy content script sends two shapes:
//   1. { method: "emit", ... }              -- single message
//   2. [ { method: "next", ... }, ... ]     -- batched array (used by next())
// Both are accepted here. Unknown methods short-circuit and are logged.

const contentMessageRouter = (() => {
  function normalizeLegacyPayload(payload) {
    if (Array.isArray(payload)) {
      return payload.filter((entry) => entry && typeof entry === "object" && typeof entry.method === "string");
    }

    if (payload && typeof payload === "object" && typeof payload.method === "string") {
      return [payload];
    }

    return [];
  }

  function isLegacyPayload(payload) {
    if (Array.isArray(payload)) {
      return payload.some((entry) => entry && typeof entry === "object" && typeof entry.method === "string");
    }

    return Boolean(payload) && typeof payload === "object" && typeof payload.method === "string";
  }

  function toRetries(message) {
    return {
      intervalMs: Number(message.interval),
      maxStep: Number(message.maxStep),
      maxRun: Number(message.maxRun)
    };
  }

  function toNextStep(message) {
    return {
      url: message.url || "",
      step: message.step || "start",
      params: message.params ?? null,
      gofast: Boolean(message.gofast)
    };
  }

  async function dispatchLegacyMethod(message, services, sender) {
    const tabId = sender?.tab?.id;

    switch (message.method) {
      case "domReady":
        await services.onRuntimeReady(sender?.tab, message.pageUrl || sender?.tab?.url || "");
        return { ok: true };

      case "emitDbg":
        services.logFromTab(tabId, message.msg || "", message.level || "DEBUG");
        return { ok: true };

      case "next": {
        // Callers always array-wrap next()/fastnext()/nextsel(). Single-message
        // form {method:"next", url, step, params, gofast} also shows up from
        // non-array branches, so normalize both.
        await services.queueStepsFromRuntime(tabId, [toNextStep(message)]);
        return { ok: true };
      }

      case "fork": {
        const step = {
          url: message.url || "",
          step: message.step || "start",
          params: message.params ?? null,
          gofast: false
        };
        await services.queueStepsFromRuntime(tabId, [step]);
        return { ok: true };
      }

      case "emit":
      case "emitKinesis":
      case "emitBQ":
      case "emitS3":
      case "emitfb": {
        const rows = Array.isArray(message.rows) ? message.rows : [];
        await services.emitRowsFromRuntime(tabId, message.table || "", rows);
        if (message.method === "emitBQ" && message.bqTable) {
          services.logFromTab(tabId, `emitBQ target: ${message.bqTable}`, "DEBUG");
        }
        return { ok: true };
      }

      case "emitFile":
        services.logFromTab(tabId, `emitFile(${message.file || "?"}): not supported in the local rebuild.`, "WARN");
        return { ok: true };

      case "done":
        await services.completeStep(tabId, sender?.tab?.url || "", sender?.tab?.title || "");
        return { ok: true };

      case "setRetries": {
        const retries = toRetries(message);
        services.setRetries(tabId, retries);
        return { ok: true };
      }

      case "screenshot":
        services.logFromTab(tabId, `screenshot(${message.file || ""}): not supported in the local rebuild.`, "WARN");
        return { ok: true };

      case "captcha":
        services.logFromTab(tabId, "captcha(): not supported in the local rebuild.", "WARN");
        return { ok: true };

      case "clearQue":
        services.clearRunQueue(tabId);
        return { ok: true };

      case "setUA":
        await services.setUserAgent(tabId, message.UAstring || "");
        return { ok: true };

      case "setSettings":
        services.updateRunConfig(tabId, message.settings || {});
        return { ok: true };

      case "setProxy":
        await services.setProxyDirect({
          server: message.server,
          port: message.port,
          bypass: message.bypass,
          username: message.username || message.user_name,
          password: message.password,
          scheme: message.scheme
        });
        return { ok: true };

      case "setProxy2":
        await services.setProxyDirect(message.parameters || {});
        return { ok: true };

      case "setProxyPortal":
        await services.setProxyFromPortalTag(message.tag, tabId);
        return { ok: true };

      case "resetProxy":
        await services.resetProxySettings();
        return { ok: true };

      case "clearCookies":
        await services.clearCookies(message.domain || "");
        return { ok: true };

      case "clearBrowsingData":
        await services.clearBrowsingData(message.origins || [], message.settings || null);
        return { ok: true };

      case "closeSocket":
        services.logFromTab(tabId, "closeSocket(): no-op in the local rebuild.", "INFO");
        return { ok: true };

      case "allowImages":
        await services.setImagesAllowed(true);
        return { ok: true };

      case "blockImages":
        await services.setImagesAllowed(false);
        return { ok: true };

      case "stop":
        await services.stopRunByTab(tabId);
        return { ok: true };

      case "click":
        // Legacy content.js sends this purely as a debug counter; page-side
        // event dispatch already happened.
        services.logFromTab(tabId, "click()", "DEBUG");
        return { ok: true };

      default:
        services.logFromTab(tabId, `Unknown legacy method ignored: ${message.method}`, "WARN");
        return { ok: false, error: `unknown method: ${message.method}` };
    }
  }

  async function handleLegacyPayload(payload, services, sender) {
    const messages = normalizeLegacyPayload(payload);
    const responses = [];

    if (messages.length && messages.every((message) => message.method === "next")) {
      try {
        await services.queueStepsFromRuntime(sender?.tab?.id, messages.map(toNextStep));
        return messages.map((message) => ({ method: message.method, ok: true }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return messages.map((message) => ({ method: message.method, ok: false, error: detail }));
      }
    }

    for (const message of messages) {
      try {
        const response = await dispatchLegacyMethod(message, services, sender);
        responses.push({ method: message.method, ...response });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        responses.push({ method: message.method, ok: false, error: detail });
      }
    }

    return responses;
  }

  return {
    normalizeLegacyPayload,
    isLegacyPayload,
    dispatchLegacyMethod,
    handleLegacyPayload
  };
})();

if (typeof globalThis !== "undefined") {
  globalThis.ScraperContentMessageRouter = contentMessageRouter;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = contentMessageRouter;
}
