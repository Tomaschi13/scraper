import { portalUrl } from "../shared/portal-config.js";

/**
 * Portal sync helpers.
 *
 * All API calls to the portal go through portalFetch(), which:
 *   - Attaches the cached Bearer token automatically.
 *   - On a 401 response, clears the token and fires the onAuthRequired
 *     callback so the service worker can open the login tab.
 *
 * Token lifecycle:
 *   - setAuthToken(token)  — called after successful login (AUTH_COMPLETE).
 *   - clearAuthToken()     — called on 401 or explicit logout.
 *   - getAuthToken()       — used by service worker to check initial state.
 */

// In-memory token cache. Populated from chrome.storage on service worker init.
let cachedToken = null;
const RUN_SOURCE = {
  localExtension: "LOCAL_EXTENSION",
  portalServer: "PORTAL_SERVER"
};

// Registered by the service worker; fired when a 401 is received.
let authRequiredCallback = null;

export function setAuthToken(token) {
  cachedToken = token;
}

export function clearAuthToken() {
  cachedToken = null;
}

export function getAuthToken() {
  return cachedToken;
}

/**
 * Register a callback to be invoked when any portal request returns 401.
 * The service worker uses this to open the login tab.
 */
export function setAuthRequiredCallback(cb) {
  authRequiredCallback = cb;
}

/**
 * Central fetch wrapper for all portal API calls.
 * Adds Authorization header and handles 401 globally.
 */
async function portalFetch(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (cachedToken) {
    headers["Authorization"] = `Bearer ${cachedToken}`;
  }

  const response = await fetch(await portalUrl(path), { ...options, headers });

  if (response.status === 401) {
    clearAuthToken();
    if (authRequiredCallback) {
      authRequiredCallback();
    }
    const error = new Error("Authentication required — please sign in.");
    error.status = 401;
    throw error;
  }

  if (!response.ok) {
    let code = "";
    let detail = "";
    try {
      const json = await response.json();
      detail = json.error || "";
      code = json.code || "";
    } catch (_) {
      // ignore parse error
    }
    const error = new Error(`Portal ${path} responded ${response.status}${detail ? `: ${detail}` : ""}`);
    error.status = response.status;
    if (code) {
      error.code = code;
    }
    throw error;
  }

  return response.json();
}

// ---------------------------------------------------------------------------
// Public sync functions
// ---------------------------------------------------------------------------

/**
 * Fetch all robots from the portal and return them.
 * Returns null on failure so callers can avoid treating a fetch failure
 * like an authoritative "no robots exist" response.
 */
export async function fetchRobotsFromPortal() {
  try {
    return (await portalFetch("/api/robots")).robots ?? [];
  } catch (error) {
    console.warn("[portal-sync] fetchRobotsFromPortal failed:", error.message);
    return null;
  }
}

/**
 * Fetch a single robot from the portal.
 * Returns null when the robot no longer exists.
 */
export async function fetchRobotFromPortal(robotId) {
  try {
    const data = await portalFetch(`/api/robots/${encodeURIComponent(robotId)}`);
    return data.robot || null;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Update an existing robot in the portal.
 * Throws when the robot no longer exists so the caller can purge stale cache.
 */
export async function updateRobotInPortal(robot) {
  const data = await portalFetch(`/api/robots/${encodeURIComponent(robot.id)}`, {
    method: "PUT",
    body: JSON.stringify({
      name: robot.name,
      url: robot.url,
      tag: robot.tag,
      code: robot.code,
      config: robot.config
    })
  });
  return data.robot || null;
}

/**
 * Create a run record in the portal when a run starts.
 * Returns the run as stored by the portal (or null on failure).
 */
export async function createRunInPortal(run) {
  try {
    const data = await portalFetch("/api/runs", {
      method: "POST",
      body: JSON.stringify(buildRunPayload(run))
    });
    return data.run || null;
  } catch (error) {
    console.warn("[portal-sync] createRunInPortal failed:", error.message);
    return null;
  }
}

/**
 * Push an updated run snapshot to the portal.
 * Called after significant state changes (emit, step complete, finish).
 */
export async function updateRunInPortal(run) {
  try {
    await portalFetch(`/api/runs/${run.id}`, {
      method: "PUT",
      body: JSON.stringify(buildRunPayload(run))
    });
  } catch (error) {
    console.warn("[portal-sync] updateRunInPortal failed:", error.message);
  }
}

export async function appendRunOutputInPortal(run, tableName, rows, options = {}) {
  if (!run?.id || !Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  try {
    const data = await portalFetch(`/api/runs/${encodeURIComponent(run.id)}/output`, {
      method: "POST",
      body: JSON.stringify({
        table: tableName,
        rows,
        stepId: options.stepId || null
      })
    });
    return data.chunk || null;
  } catch (error) {
    console.warn("[portal-sync] appendRunOutputInPortal failed:", error.message);
    return null;
  }
}

export async function updateRunCostInPortal(run, usage = {}) {
  if (!run?.id) {
    return null;
  }

  const lineItems = Array.isArray(usage.lineItems) ? usage.lineItems : [];
  if (!lineItems.length) {
    return null;
  }

  try {
    const data = await portalFetch(`/api/runs/${encodeURIComponent(run.id)}/cost`, {
      method: "PUT",
      body: JSON.stringify({ lineItems })
    });
    return data.cost || null;
  } catch (error) {
    console.warn("[portal-sync] updateRunCostInPortal failed:", error.message);
    return null;
  }
}

export async function discardRunOutputForStepInPortal(run, stepId) {
  if (!run?.id || !stepId) {
    return false;
  }

  try {
    await portalFetch(`/api/runs/${encodeURIComponent(run.id)}/output/steps/${encodeURIComponent(stepId)}`, {
      method: "DELETE"
    });
    return true;
  } catch (error) {
    console.warn("[portal-sync] discardRunOutputForStepInPortal failed:", error.message);
    return false;
  }
}

export async function updateRunResumeStateInPortal(run) {
  if (!run?.id) {
    return null;
  }

  try {
    const data = await portalFetch(`/api/runs/${encodeURIComponent(run.id)}/resume`, {
      method: "PUT",
      body: JSON.stringify({
        status: run.status || "RUNNING",
        phase: run.phase || "IDLE",
        currentUrl: run.currentUrl || "",
        queue: Array.isArray(run.queue) ? run.queue : [],
        visitedUrls: Array.isArray(run.visitedUrls) ? run.visitedUrls : [],
        visitedMap: run.visitedMap && typeof run.visitedMap === "object" ? run.visitedMap : {},
        currentStep: run.currentStep || null,
        outputTables: run.outputTables || {},
        code: run.code || "",
        logs: Array.isArray(run.logs) ? run.logs.slice(-300) : [],
        retries: run.retries || null,
        config: run.config || null,
        failures: run.failures || 0,
        emits: run.emits || 0,
        rows: run.rows || 0,
        runSource: run.runSource || "LOCAL_EXTENSION"
      })
    });
    return data.resume || null;
  } catch (error) {
    console.warn("[portal-sync] updateRunResumeStateInPortal failed:", error.message);
    return null;
  }
}

export async function fetchRunResumeStateFromPortal(runId) {
  const cleanRunId = String(runId || "").trim();
  if (!cleanRunId) {
    return null;
  }

  try {
    const data = await portalFetch(`/api/runs/${encodeURIComponent(cleanRunId)}/resume`);
    return data.resume || null;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    console.warn("[portal-sync] fetchRunResumeStateFromPortal failed:", error.message);
    return null;
  }
}

export async function fetchProxyFromPortal(tag) {
  const cleanTag = String(tag || "").trim();
  if (!cleanTag) {
    throw new Error("Proxy name is required.");
  }
  const data = await portalFetch(`/api/proxies/${encodeURIComponent(cleanTag)}/resolve`);
  return data.proxy || null;
}

function buildRunPayload(run) {
  return {
    id: run.id,
    robotId: run.robotId,
    robotName: run.robotName,
    status: run.status,
    phase: run.phase,
    tag: run.tag,
    startUrl: run.startUrl,
    currentUrl: run.currentUrl,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    logs: Array.isArray(run.logs) ? run.logs.slice(-300) : [],
    outputTables: run.outputTables || {},
    queueLength: run.queue ? run.queue.length : 0,
    currentStep: run.currentStep || null,
    failures: run.failures || 0,
    emits: run.emits || 0,
    rows: run.rows || 0,
    retries: run.retries || null,
    config: run.config || null,
    runSource: run.runSource === RUN_SOURCE.portalServer
      ? RUN_SOURCE.portalServer
      : RUN_SOURCE.localExtension
  };
}
