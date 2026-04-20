import {
  getPortalOrigin,
  setPortalOrigin
} from "../shared/portal-config.js";

const AUTH_STORAGE_KEY = "scraper.auth";

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

globalThis.scraperRunnerBridge = {
  configurePortal,
  getPortalOrigin,
  getState,
  login,
  refreshRobots,
  startRun,
  stopRun
};
