import {
  getPortalOrigin,
  setPortalOrigin
} from "../shared/portal-config.js";

const AUTH_STORAGE_KEY = "scraper.auth";
const TERMINAL_RUN_STATUSES = new Set(["FINISHED", "FAILED", "ABORTED"]);
const terminalRunWaiters = new Map();

async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response || response.ok !== false) {
    return response;
  }

  throw new Error(response.error || "Extension request failed.");
}

async function login({ email, password }) {
  const portalOrigin = await getPortalOrigin();
  const response = await fetch(`${portalOrigin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });

  let body = {};
  try {
    body = await response.json();
  } catch (_error) {
    body = {};
  }

  if (!response.ok) {
    throw new Error(body.error || `Portal login failed with status ${response.status}.`);
  }

  const { token, user } = body;
  if (!token) {
    throw new Error("Portal login response did not include a token.");
  }

  await chrome.storage.local.set({
    [AUTH_STORAGE_KEY]: {
      token,
      email: user?.email || String(email || "").trim(),
      role: user?.role || "",
      storedAt: new Date().toISOString()
    }
  });

  await request({
    type: "AUTH_COMPLETE",
    token,
    user
  });

  return {
    ok: true,
    portalOrigin,
    user
  };
}

async function configurePortal(origin) {
  const portalOrigin = await setPortalOrigin(origin);
  return {
    ok: true,
    portalOrigin
  };
}

async function getState() {
  return request({ type: "GET_STATE" });
}

async function getRunStatus({ runId } = {}) {
  return request({
    type: "GET_RUN_STATUS",
    runId
  });
}

function isTerminalRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(String(status || "").toUpperCase());
}

function resolveTerminalRunWaiters(run) {
  const runId = String(run?.id || "");
  if (!runId || !isTerminalRunStatus(run?.status)) {
    return;
  }

  const waiters = terminalRunWaiters.get(runId);
  if (!waiters) {
    return;
  }

  terminalRunWaiters.delete(runId);
  waiters.forEach((resolve) => resolve(run));
}

async function waitForRunTerminal({ runId, timeoutMs = 60_000 } = {}) {
  const cleanRunId = String(runId || "").trim();
  if (!cleanRunId) {
    throw new Error("runId is required.");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let resolveTerminal = null;
    const waiters = terminalRunWaiters.get(cleanRunId) || [];
    const cleanup = () => {
      const nextWaiters = terminalRunWaiters.get(cleanRunId);
      if (!nextWaiters) {
        return;
      }

      const index = nextWaiters.indexOf(resolveTerminal);
      if (index !== -1) {
        nextWaiters.splice(index, 1);
      }

      if (!nextWaiters.length) {
        terminalRunWaiters.delete(cleanRunId);
      }
    };
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(payload);
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(error);
    };
    resolveTerminal = (run) => {
      finish({ ok: true, run, timedOut: false });
    };
    const delay = Math.max(Number(timeoutMs) || 0, 1);
    timer = setTimeout(() => {
      finish({ ok: true, run: null, timedOut: true });
    }, delay);

    waiters.push(resolveTerminal);
    terminalRunWaiters.set(cleanRunId, waiters);

    getRunStatus({ runId: cleanRunId })
      .then((response) => {
        if (isTerminalRunStatus(response?.run?.status)) {
          finish({ ok: true, run: response.run, timedOut: false });
        }
      })
      .catch(fail);
  });
}

async function refreshRobots() {
  return request({ type: "REFRESH_PORTAL_ROBOTS" });
}

async function startRun(payload = {}) {
  return request({
    type: "START_RUN",
    payload
  });
}

async function stopRun(runId) {
  return request({
    type: "STOP_RUN",
    runId
  });
}

async function allowImages() {
  return request({ type: "ALLOW_IMAGES" });
}

async function blockImages() {
  return request({ type: "BLOCK_IMAGES" });
}

// The Playwright runner installs __scraperRunnerOnImagesAllowedChanged via
// page.exposeBinding before this page loads. The SW fires
// RUNNER_IMAGES_ALLOWED_CHANGED whenever allowServerImages()/blockServerImages()
// (or ALLOW_IMAGES/BLOCK_IMAGES) flips chrome.contentSettings.images, so we
// just forward it through. When this page is opened by something other than
// the runner (i.e. the extension is running locally), the binding is absent
// and we silently skip.
chrome.runtime.onMessage.addListener((message) => {
  if (!message) {
    return;
  }

  if (message.type === "RUNNER_IMAGES_ALLOWED_CHANGED") {
    const notify = globalThis.__scraperRunnerOnImagesAllowedChanged;
    if (typeof notify === "function") {
      try {
        notify(Boolean(message.allowed));
      } catch (_error) {
        // The binding may be torn down mid-message during context shutdown;
        // dropping the notification is fine because the runner is exiting.
      }
    }
    return;
  }

  if (message.type === "RUNNER_RUN_TERMINAL") {
    resolveTerminalRunWaiters(message.run);
  }
});

globalThis.scraperRunnerBridge = {
  allowImages,
  blockImages,
  configurePortal,
  getPortalOrigin,
  getRunStatus,
  getState,
  login,
  refreshRobots,
  startRun,
  stopRun,
  waitForRunTerminal
};
