"use strict";

// DevTools evaluates bare identifiers like `$` against the selected world.
// In the content-script world we want that to resolve to jQuery just like the
// legacy Scraper extension, not Chrome's command-line helper.
const runtimeWindow = typeof window !== "undefined"
  ? window
  : (typeof globalThis !== "undefined" ? globalThis.window : undefined);
const runtimeJQuery = typeof runtimeWindow?.jQuery === "function"
  ? runtimeWindow.jQuery
  : (typeof globalThis !== "undefined" && typeof globalThis.jQuery === "function"
      ? globalThis.jQuery
      : undefined);

if (typeof globalThis !== "undefined" && typeof runtimeJQuery === "function") {
  globalThis.jQuery = runtimeJQuery;
  globalThis.$ = runtimeJQuery;
}

var jQuery = runtimeJQuery;
var $ = runtimeJQuery;

const RUNTIME_SOURCE = "scraper-runtime";

function isContextInvalidatedError(error) {
  const detail = error instanceof Error ? error.message : String(error || "");
  const normalized = detail.toLowerCase();

  return normalized.includes("extension context invalidated")
    || normalized.includes("context invalidated")
    || normalized.includes("receiving end does not exist")
    || normalized.includes("the message port closed before a response was received")
    || normalized.includes("message channel closed before a response was received");
}

async function sendRuntimeMessage(runtime, message, options = {}) {
  const logger = typeof options.logger === "function" ? options.logger : null;

  if (!runtime || typeof runtime.sendMessage !== "function") {
    return null;
  }

  try {
    return await runtime.sendMessage(message);
  } catch (error) {
    if (!isContextInvalidatedError(error) && logger) {
      logger(error);
    }

    return null;
  }
}

function normalizeNodes(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean);
  }

  if (!value) {
    return [];
  }

  if (typeof value.length === "number" && typeof value !== "string") {
    return Array.from(value).filter(Boolean);
  }

  return [value];
}

function nodeText(node) {
  if (!node) {
    return "";
  }

  if (typeof node.textContent === "string") {
    return node.textContent;
  }

  if (typeof node.innerText === "string") {
    return node.innerText;
  }

  return "";
}

function queryAll(selector, context, fallbackDocument) {
  if (!selector) {
    return [];
  }

  const scope = context && typeof context.querySelectorAll === "function"
    ? context
    : fallbackDocument;

  if (!scope || typeof scope.querySelectorAll !== "function") {
    return [];
  }

  try {
    return normalizeNodes(scope.querySelectorAll(selector));
  } catch (_) {
    return [];
  }
}

function wrapNodes(nodes, runQuery) {
  const list = normalizeNodes(nodes);
  const wrapper = {
    length: list.length,
    text() {
      return list.map((node) => nodeText(node)).join("");
    },
    attr(name) {
      const first = list[0];
      if (!first) {
        return null;
      }

      if (typeof first.getAttribute === "function") {
        return first.getAttribute(name);
      }

      return Object.prototype.hasOwnProperty.call(first, name) ? first[name] : null;
    },
    first() {
      return wrapNodes(list.slice(0, 1), runQuery);
    },
    eq(index) {
      if (!Number.isInteger(index)) {
        return wrapNodes([], runQuery);
      }

      const resolvedIndex = index < 0 ? list.length + index : index;
      return wrapNodes(list.slice(resolvedIndex, resolvedIndex + 1), runQuery);
    },
    find(selector) {
      return wrapNodes(
        list.flatMap((node) => runQuery(selector, node)),
        runQuery
      );
    },
    each(callback) {
      if (typeof callback !== "function") {
        return wrapper;
      }

      list.forEach((node, index) => {
        callback.call(node, index, node);
      });
      return wrapper;
    },
    map(callback) {
      if (typeof callback !== "function") {
        return [];
      }

      return list.map((node, index) => callback.call(node, index, node));
    },
    get(index) {
      if (typeof index === "undefined") {
        return list.slice();
      }

      return list[index];
    },
    toArray() {
      return list.slice();
    }
  };

  return wrapper;
}

function resolvePreviewJQuery(environment = {}) {
  if (typeof environment.jQuery === "function") {
    return environment.jQuery;
  }

  if (typeof environment.window?.jQuery === "function") {
    return environment.window.jQuery;
  }

  if (typeof globalThis !== "undefined" && typeof globalThis.jQuery === "function") {
    return globalThis.jQuery;
  }

  return null;
}

function createPreviewQuery(document, preferredQuery = null) {
  const runQuery = (selector, context) => queryAll(selector, context, document);
  const jquery = typeof preferredQuery === "function" ? preferredQuery : null;

  return function previewQuery(selector, context) {
    if (jquery) {
      if (typeof selector === "string") {
        return jquery(selector, context || document);
      }

      return jquery(selector);
    }

    if (typeof selector === "string") {
      return wrapNodes(runQuery(selector, context || document), runQuery);
    }

    return wrapNodes(selector, runQuery);
  };
}

function isSelectorExpression(selector) {
  const value = String(selector || "").trim();
  return value.includes("$")
    || value.startsWith("row.")
    || value.startsWith("document.")
    || value.startsWith("window.");
}

function evaluateSelectorValue(selector, rowElement, environment) {
  if (!selector) {
    return "";
  }

  const $ = createPreviewQuery(environment.document, resolvePreviewJQuery(environment));

  if (isSelectorExpression(selector)) {
    try {
      const compute = new Function("$", "row", "document", "window", `return (${selector});`);
      return compute($, rowElement, environment.document, environment.window);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  return $(selector, rowElement).text().trim();
}

function buildSelectorPreview(selectors, environment = {}) {
  const preview = {
    headers: [],
    rows: []
  };

  const document = environment.document;

  if (!document || !Array.isArray(selectors) || !selectors.length) {
    return preview;
  }

  const rowSelector = selectors[0]?.name === "row" ? selectors[0].selector : null;
  const dataSelectors = rowSelector ? selectors.slice(1) : selectors;

  dataSelectors.forEach((entry) => {
    if (entry.selector) {
      preview.headers.push(entry.name || "");
    }
  });

  if (rowSelector) {
    queryAll(rowSelector, document, document).forEach((rowElement) => {
      preview.rows.push(
        dataSelectors.map((entry) => evaluateSelectorValue(entry.selector, rowElement, environment))
      );
    });
    return preview;
  }

  preview.rows.push(
    dataSelectors.map((entry) => evaluateSelectorValue(entry.selector, document, environment))
  );
  return preview;
}

function createRuntimeBridge(options) {
  const runtime = options.chromeRuntime;
  const document = options.document;
  const windowObject = options.window;
  const location = options.location;
  const logger = options.consoleObject && typeof options.consoleObject.warn === "function"
    ? (error) => options.consoleObject.warn(
        "[Scraper WARN] Runtime bridge message failed:",
        error instanceof Error ? error.message : String(error)
      )
    : null;

  return {
    async notifyRuntimeReady() {
      return sendRuntimeMessage(runtime, {
        source: RUNTIME_SOURCE,
        type: "RUNTIME_READY",
        pageUrl: location?.href || ""
      }, { logger });
    },
    handleMessage(message, sender, sendResponse) {
      if (!message || typeof message !== "object") {
        return false;
      }

      if (message.type !== "PREVIEW_SELECTORS") {
        return false;
      }

      sendResponse(buildSelectorPreview(
        Array.isArray(message.selectors) ? message.selectors : [],
        {
          document,
          window: windowObject,
          jQuery: resolvePreviewJQuery({ window: windowObject })
        }
      ));
      return true;
    }
  };
}

function bootstrapRuntimeBridge(globalObject) {
  const runtime = globalObject?.chrome?.runtime;

  if (!runtime?.onMessage?.addListener || typeof runtime.sendMessage !== "function") {
    return null;
  }

  const bridge = createRuntimeBridge({
    chromeRuntime: runtime,
    document: globalObject.document,
    window: globalObject.window,
    location: globalObject.location,
    consoleObject: globalObject.console
  });

  runtime.onMessage.addListener((message, sender, sendResponse) => (
    bridge.handleMessage(message, sender, sendResponse)
  ));

  void bridge.notifyRuntimeReady();
  return bridge;
}

bootstrapRuntimeBridge(typeof globalThis === "undefined" ? null : globalThis);

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    buildSelectorPreview,
    bootstrapRuntimeBridge,
    createRuntimeBridge,
    createPreviewQuery,
    evaluateSelectorValue,
    isContextInvalidatedError,
    isSelectorExpression,
    sendRuntimeMessage
  };
}
