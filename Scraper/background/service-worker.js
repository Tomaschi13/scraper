import {
  updateRobotInPortal,
  createRunInPortal,
  updateRunInPortal,
  fetchRobotsFromPortal,
  fetchRobotFromPortal,
  setAuthToken,
  clearAuthToken,
  setAuthRequiredCallback
} from "./portal.js";
import { getPortalOrigin } from "../shared/portal-config.js";
import "../shared/run-state-helpers.js";
import "./run-lifecycle-helpers.js";
import "./runtime-bridge-helpers.js";
import "./content-message-router.js";
import "./auth-prompt-helpers.js";
import "./robot-record-helpers.js";
import "./user-script-helpers.js";

const {
  findRunById,
  resolveSelectedRunId,
  sortRuns
} = globalThis.ScraperRunStateHelpers;

const {
  isRunningRun,
  shouldProcessExecutionResult,
  createStepOutputCheckpoint,
  rollbackStepOutput,
  getBlockedPageError,
  createLegacyQueueEntries,
  isOpenUrlStep
} = globalThis.ScraperRunLifecycleHelpers;

const {
  selectPreviewTabId,
  shouldExecuteRunOnRuntimeReady
} = globalThis.ScraperRuntimeBridgeHelpers;

const {
  isLegacyPayload,
  handleLegacyPayload
} = globalThis.ScraperContentMessageRouter;

const {
  createClearedPortalState,
  findLoginTab,
  hasPortalData,
  shouldPromptForAuth
} = globalThis.ScraperAuthPromptHelpers;

const {
  applyPortalRobotUpdate,
  normalizeRobotFromPortal
} = globalThis.ScraperRobotRecordHelpers;

const {
  buildLegacyUserScriptSources,
  configureUserScriptWorld
} = globalThis.ScraperUserScriptHelpers;

const STORAGE_KEYS = {
  robots: "scraper.robots",
  draft: "scraper.draft",
  snapshots: "scraper.snapshots",
  runtime: "scraper.runtime",
  auth: "scraper.auth"
};

const RUN_STATUS = {
  idle: "IDLE",
  running: "RUNNING",
  finished: "FINISHED",
  failed: "FAILED",
  aborted: "ABORTED"
};

const RUN_SOURCE = {
  localExtension: "LOCAL_EXTENSION",
  portalServer: "PORTAL_SERVER"
};

const DEFAULT_CONFIG = {
  skipVisited: false,
  respectRobotsTxt: false,
  maxForks: 30,
  waitForRequests: false,
  dataUsageMetering: false
};

const DEFAULT_RETRIES = {
  intervalMs: 60_000,
  maxStep: 3,
  maxRun: 150
};

const IDE_WINDOW_OPTIONS = {
  type: "popup",
  focused: true,
  width: 1360,
  height: 920
};

const UI_DISCONNECT_ABORT_DELAY_MS = 500;
const UI_RUN_HISTORY_LIMIT = 20;
const PORTAL_AUTH_COOKIE_NAME = "auth_token";

const DEFAULT_SCRIPT = `steps.start = function start() {
  const rows = [];

  $("a").each(function collectLinks(index, element) {
    const label = $(element).text().trim();
    const href = element.href || "";

    if (href) {
      rows.push({
        position: index + 1,
        label,
        href
      });
    }
  });

  emit("links", rows);
  done();
};
`;

let robots = [];
let draft = null;
let snapshots = {};
let runtime = {
  runs: {},
  lastRunId: null,
  lastPageTabId: null,
  selectedRunId: null
};

// Auth state
let authPromptPending = false;
let isReauthenticating = false;
let loginTabId = null;

const uiPorts = new Set();
const runTimers = new Map();
let persistTimer = null;
let uiDisconnectAbortTimer = null;
let userScriptWorldReady = null;

const ready = initialize();

chrome.action.onClicked.addListener(() => {
  void withReady(async () => {
    await syncAuthFromPortalSession({ refreshPortalData: false });
    await openIdePage();
    await promptForAuthenticationIfNeeded();
  });
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "scraper-ui") {
    return;
  }

  clearUiDisconnectAbortTimer();
  uiPorts.add(port);
  port.onDisconnect.addListener(() => {
    uiPorts.delete(port);

    if (!uiPorts.size) {
      scheduleUiDisconnectAbort();
    }
  });

  void withReady(async () => {
    await syncAuthFromPortalSession();
    port.postMessage({
      type: "STATE_UPDATED",
      state: buildUiState()
    });

    if (authPromptPending) {
      await promptForAuthenticationIfNeeded();
    }
  });
});

registerRuntimeMessageListener(chrome.runtime.onMessage);
registerRuntimeMessageListener(chrome.runtime.onUserScriptMessage);

if (chrome.cookies?.onChanged?.addListener) {
  chrome.cookies.onChanged.addListener((changeInfo) => {
    void withReady(async () => {
      if (!(await isPortalAuthCookie(changeInfo?.cookie))) {
        return;
      }

      await syncAuthFromPortalSession({
        closeLoginTabOnSuccess: true,
        promptIfMissing: uiPorts.size > 0
      });
    });
  });
}

const legacyServices = {
  logFromTab: (tabId, message, level) => logFromTab(tabId, message, level),
  queueStepsFromRuntime: (tabId, steps) => queueStepsFromRuntime(tabId, steps),
  emitRowsFromRuntime: (tabId, table, rows) => emitRowsFromRuntime(tabId, table, rows),
  completeStep: (tabId, pageUrl) => completeStep(tabId, pageUrl),
  failCurrentStep: (tabId, error) => failCurrentStep(tabId, error),
  clearRunQueue: (tabId) => clearRunQueue(tabId),
  setRetries: (tabId, retries) => setRetries(tabId, retries),
  setUserAgent: (tabId, ua) => setUserAgent(tabId, ua),
  updateRunConfig: (tabId, settings) => updateRunConfig(tabId, settings),
  setProxyDirect: (proxy) => setProxyDirect(proxy),
  resetProxySettings: () => resetProxySettings(),
  setImagesAllowed: (allowed) => setImagesAllowed(allowed),
  clearCookies: (domain) => clearCookies(domain),
  clearBrowsingData: (origins, settings) => clearBrowsingData(origins, settings),
  onRuntimeReady: (tab, pageUrl) => onRuntimeReady(tab, pageUrl),
  stopRunByTab: (tabId) => stopRunByTab(tabId)
};

chrome.tabs.onRemoved.addListener((tabId) => {
  void withReady(async () => {
    // If the user closed the login tab without completing auth, clear the flag.
    if (tabId === loginTabId) {
      isReauthenticating = false;
      loginTabId = null;
      return;
    }

    const run = findRunByTabId(tabId);

    if (!run || run.status !== RUN_STATUS.running) {
      return;
    }

    appendLog(run, "Run tab closed. Aborting run.", "WARN");
    await finishRun(run, RUN_STATUS.aborted);
  });
});

async function initialize() {
  const stored = await chrome.storage.local.get(Object.values(STORAGE_KEYS));

  // When any portal call returns 401, mark auth as required. We only open the
  // login page on explicit user actions so passive worker wake-ups do not
  // spray login tabs across the browser.
  setAuthRequiredCallback(() => {
    authPromptPending = true;
    clearPortalDataForAuthFailure();

    if (uiPorts.size) {
      void promptForAuthenticationIfNeeded();
    }
  });

  robots = Array.isArray(stored[STORAGE_KEYS.robots]) ? stored[STORAGE_KEYS.robots] : [];

  draft = {
    ...createEmptyDraft(),
    ...(stored[STORAGE_KEYS.draft] || {})
  };

  if (typeof draft.code !== "string") {
    draft.code = "";
  }

  snapshots = isObject(stored[STORAGE_KEYS.snapshots]) ? stored[STORAGE_KEYS.snapshots] : {};

  const storedRuntime = isObject(stored[STORAGE_KEYS.runtime]) ? stored[STORAGE_KEYS.runtime] : {};
  runtime = {
    runs: {},
    lastRunId: typeof storedRuntime.lastRunId === "string" ? storedRuntime.lastRunId : null,
    lastPageTabId: Number.isInteger(storedRuntime.lastPageTabId) ? storedRuntime.lastPageTabId : null,
    selectedRunId: typeof storedRuntime.selectedRunId === "string" ? storedRuntime.selectedRunId : null
  };

  for (const [runId, runValue] of Object.entries(storedRuntime.runs || {})) {
    const run = hydrateRun(runValue);
    run.id = runId;

    if (run.status === RUN_STATUS.running) {
      run.status = RUN_STATUS.aborted;
      run.phase = RUN_STATUS.idle;
      run.currentStep = null;
      run.executionToken = null;
      appendLog(run, "Recovered after extension reload. Previous in-flight run was aborted.", "WARN");
      updateSnapshot(run);
    }

    runtime.runs[runId] = run;
  }

  const hasPortalSession = await syncAuthFromPortalSession({ refreshPortalData: false });
  if (hasPortalSession) {
    await syncWithPortal({ refreshSelectedRobot: true });
  }

  ensureDraftConsistency();
  schedulePersist();
  void ensureUserScriptWorldConfigured().catch(() => null);
}

function registerRuntimeMessageListener(event) {
  if (!event?.addListener) {
    return;
  }

  event.addListener((message, sender, sendResponse) => {
    void withReady(async () => {
      try {
        if (isLegacyPayload(message)) {
          const responses = await handleLegacyPayload(message, legacyServices, sender);
          sendResponse({ ok: true, responses });
          return;
        }

        const response = await handleMessage(message, sender);
        sendResponse(response);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        sendResponse({ ok: false, error: detail });
      }
    });

    return true;
  });
}

function ensureUserScriptWorldConfigured() {
  if (!userScriptWorldReady) {
    userScriptWorldReady = configureUserScriptWorld(chrome.userScripts).catch((error) => {
      userScriptWorldReady = null;
      throw error;
    });
  }

  return userScriptWorldReady;
}

async function syncWithPortal({ refreshSelectedRobot = false, strictSelectedRobot = false } = {}) {
  const portalRobots = await fetchRobotsFromPortal();

  if (portalRobots === null) {
    return null;
  }

  const wasAuthPromptPending = authPromptPending;
  authPromptPending = false;
  let changed = await mergePortalRobotsIntoLocal(portalRobots);

  if (draft?.selectedRobotId) {
    try {
      const selectedRobotRefresh = await syncRobotFromPortal(draft.selectedRobotId, { syncDraft: refreshSelectedRobot });
      changed = selectedRobotRefresh.changed || changed;
    } catch (error) {
      if (strictSelectedRobot) {
        throw error;
      }
      console.warn("[portal-sync] fetchRobotFromPortal failed:", error.message);
    }
  }

  if (changed) {
    schedulePersist();
  }

  if (changed || wasAuthPromptPending) {
    broadcastState();
  }

  return changed;
}

// Refresh robots from the portal during startup, auth completion, or explicit UI requests.
async function pullRobotsFromPortal() {
  // Skip refresh while the user is completing re-authentication so we do not
  // keep retrying behind an active login tab.
  if (isReauthenticating) return null;

  return syncWithPortal({ refreshSelectedRobot: true, strictSelectedRobot: true });
}

function clearPortalDataForAuthFailure() {
  const hadVisiblePortalData = hasPortalData({ robots, draft });
  const clearedState = createClearedPortalState(DEFAULT_CONFIG);

  robots = clearedState.robots;
  draft = clearedState.draft;

  clearAuthToken();
  void chrome.storage.local.remove(STORAGE_KEYS.auth).catch(() => null);

  if (hadVisiblePortalData) {
    schedulePersist();
  }

  broadcastState();
}

async function promptForAuthenticationIfNeeded() {
  if (!shouldPromptForAuth({ authPromptPending, isReauthenticating })) {
    return false;
  }

  return openLoginPage({ markReauthenticating: true });
}

async function openLoginPage({ markReauthenticating = false } = {}) {
  if (markReauthenticating) {
    isReauthenticating = true;
  }

  try {
    const portalOrigin = await getPortalOrigin();
    const loginUrl = new URL("/login", portalOrigin).toString();
    const tabs = await chrome.tabs.query({});
    const existingLoginTab = findLoginTab(tabs, loginUrl);

    if (existingLoginTab?.id) {
      loginTabId = existingLoginTab.id;
      await chrome.tabs.update(existingLoginTab.id, { active: true }).catch(() => null);

      if (Number.isInteger(existingLoginTab.windowId)) {
        await chrome.windows.update(existingLoginTab.windowId, { focused: true }).catch(() => null);
      }

      return true;
    }

    const tab = await chrome.tabs.create({ url: loginUrl, active: true });
    loginTabId = Number.isInteger(tab?.id) ? tab.id : null;
    return true;
  } catch (error) {
    console.warn("[auth] Failed to open login tab:", error instanceof Error ? error.message : String(error));

    if (markReauthenticating) {
      isReauthenticating = false;
    }

    loginTabId = null;
    return false;
  }
}

async function buildPortalRefreshErrorMessage() {
  const portalOrigin = await getPortalOrigin().catch(() => "");
  const target = portalOrigin || "the configured portal";

  if (isReauthenticating) {
    return `Portal login is already open for ${target}. Finish signing in and then refresh robots.`;
  }

  if (authPromptPending) {
    return `Sign in to the portal at ${target}. A login window should open automatically when the IDE is open.`;
  }

  return `Could not reach the portal at ${target}. Check the server URL and that the server is reachable.`;
}

async function getPortalAuthCookie() {
  if (!chrome.cookies?.get) {
    return null;
  }

  try {
    const portalOrigin = await getPortalOrigin();
    return await chrome.cookies.get({
      url: portalOrigin,
      name: PORTAL_AUTH_COOKIE_NAME
    });
  } catch (_error) {
    return null;
  }
}

async function isPortalAuthCookie(cookie) {
  if (!cookie || cookie.name !== PORTAL_AUTH_COOKIE_NAME) {
    return false;
  }

  try {
    const portalHost = new URL(await getPortalOrigin()).hostname;
    const cookieDomain = String(cookie.domain || "").replace(/^\./, "");
    return cookieDomain === portalHost || portalHost.endsWith(`.${cookieDomain}`);
  } catch (_error) {
    return false;
  }
}

async function persistAuthRecord(token, user = null) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.auth).catch(() => ({}));
  const previous = isObject(stored[STORAGE_KEYS.auth]) ? stored[STORAGE_KEYS.auth] : {};

  await chrome.storage.local.set({
    [STORAGE_KEYS.auth]: {
      token,
      email: user?.email || previous.email || "",
      role: user?.role || previous.role || "",
      storedAt: new Date().toISOString()
    }
  });
}

async function closeLoginTabIfOpen() {
  if (loginTabId === null) {
    return;
  }

  try {
    await chrome.tabs.remove(loginTabId);
  } catch (_) {
    // The tab may already be closed or redirected away.
  }

  loginTabId = null;
}

async function syncAuthFromPortalSession({
  closeLoginTabOnSuccess = false,
  promptIfMissing = false,
  refreshPortalData = true
} = {}) {
  const cookie = await getPortalAuthCookie();

  if (!cookie?.value) {
    authPromptPending = true;
    clearPortalDataForAuthFailure();

    if (promptIfMissing) {
      await promptForAuthenticationIfNeeded();
    }

    return false;
  }

  setAuthToken(cookie.value);
  authPromptPending = false;
  isReauthenticating = false;
  await persistAuthRecord(cookie.value);

  if (closeLoginTabOnSuccess) {
    await closeLoginTabIfOpen();
  }

  if (!refreshPortalData) {
    return true;
  }

  await syncWithPortal({ refreshSelectedRobot: true });
  return true;
}

async function mergePortalRobotsIntoLocal(portalRobots) {
  let changed = false;
  const portalById = new Map(portalRobots.map((robot) => [robot.id, robot]));

  for (const localRobot of [...robots]) {
    if (!portalById.has(localRobot.id)) {
      changed = (await purgeRobotState(localRobot.id)) || changed;
    }
  }

  for (const portalRobot of portalRobots) {
    const update = applyPortalRobotUpdate({
      robots,
      draft,
      portalRobot,
      defaultConfig: DEFAULT_CONFIG,
      defaultScript: DEFAULT_SCRIPT,
      syncDraft: true
    });
    draft = update.draft;
    changed = update.changed || changed;
  }

  changed = ensureDraftConsistency() || changed;

  return changed;
}

async function syncRobotFromPortal(robotId, { forceDraftSync = false, syncDraft = true } = {}) {
  if (!robotId) {
    return { robot: null, changed: false };
  }

  const portalRobot = await fetchRobotFromPortal(robotId);

  if (!portalRobot) {
    const changed = await purgeRobotState(robotId);
    return { robot: null, changed };
  }

  const update = applyPortalRobotUpdate({
    robots,
    draft,
    portalRobot,
    defaultConfig: DEFAULT_CONFIG,
    defaultScript: DEFAULT_SCRIPT,
    forceDraftSync,
    syncDraft
  });

  draft = update.draft;
  return update;
}

function withReady(task) {
  return ready.then(task);
}

async function handleMessage(message, sender) {
  if (!isObject(message)) {
    return { ok: false, error: "Invalid message payload." };
  }

  switch (message.type) {
    case "GET_STATE":
      return { ok: true, state: buildUiState() };
    case "REFRESH_PORTAL_ROBOTS": {
      const refreshed = await pullRobotsFromPortal();
      if (refreshed === null) {
        await promptForAuthenticationIfNeeded();
        return { ok: false, error: await buildPortalRefreshErrorMessage() };
      }
      return { ok: true, state: buildUiState() };
    }
    case "SAVE_DRAFT": {
      const incomingDraft = message.draft || {};
      draft = {
        ...draft,
        ...incomingDraft,
        selectedRobotId: typeof incomingDraft.selectedRobotId === "string"
          ? incomingDraft.selectedRobotId
          : (typeof incomingDraft.robotId === "string" ? incomingDraft.robotId : draft?.selectedRobotId || "")
      };
      schedulePersist();
      broadcastState();
      return { ok: true, draft };
    }
    case "SAVE_ROBOT":
      return { ok: true, robot: await saveRobot(message.robot || {}) };
    case "LOAD_ROBOT":
      return { ok: true, robot: await loadRobot(message.robotId) };
    case "START_RUN":
      return { ok: true, run: await startRun(message.payload || {}) };
    case "STOP_RUN":
      return { ok: true, stopped: await stopRun(message.runId) };
    case "SELECT_RUN":
      runtime.selectedRunId = resolveSelectedRunId(
        Object.values(runtime.runs),
        typeof message.runId === "string" ? message.runId : null
      );
      schedulePersist();
      broadcastState();
      return { ok: true, state: buildUiState() };
    case "CHECK_RESUME":
      await pullRobotsFromPortal();
      await promptForAuthenticationIfNeeded();
      return { ok: true, snapshot: getSnapshot(message.runId) };
    case "RESUME_RUN":
      await pullRobotsFromPortal();
      await promptForAuthenticationIfNeeded();
      return { ok: true, run: await resumeRun(message.runId) };
    case "FOCUS_RUN_TAB":
      return { ok: true, focused: await focusRunTab(message.runId) };
    case "PREVIEW_SELECTORS":
      return { ok: true, preview: await previewSelectors(message.preview || {}) };
    case "RESET_PROXY":
      await resetProxySettings();
      return { ok: true };
    case "ALLOW_IMAGES":
      await setImagesAllowed(true);
      return { ok: true };
    case "BLOCK_IMAGES":
      await setImagesAllowed(false);
      return { ok: true };
    case "RUNTIME_READY":
      runtime.lastPageTabId = sender.tab?.id ?? runtime.lastPageTabId;
      await onRuntimeReady(sender.tab, message.pageUrl);
      return { ok: true };
    case "DOM_READY":
      runtime.lastPageTabId = sender.tab?.id ?? runtime.lastPageTabId;
      await onRuntimeReady(sender.tab, message.pageUrl);
      return { ok: true };
    case "LOG":
      return { ok: true, logged: logFromTab(sender.tab?.id, message.message, message.level) };
    case "AUTH_COMPLETE":
      await handleAuthComplete(message.token, message.user);
      return { ok: true };
    default:
      return { ok: false, error: `Unknown message type: ${message.type}` };
  }
}

/**
 * Called when the login page successfully authenticates and sends AUTH_COMPLETE.
 * Stores the token in memory + chrome.storage, clears the re-auth guard.
 */
async function handleAuthComplete(token, user) {
  if (!token) return;

  // Update in-memory cache used by portalFetch.
  setAuthToken(token);
  authPromptPending = false;

  // Persist so the token survives service worker restarts.
  await persistAuthRecord(token, user);

  // Clear re-auth guard; close login tab if it's still open.
  isReauthenticating = false;
  await closeLoginTabIfOpen();

  await syncWithPortal({ refreshSelectedRobot: true });
  console.log(`[auth] Authenticated as ${user?.email || "unknown"} (${user?.role || "?"})`);
}

function createEmptyDraft() {
  return {
    selectedRobotId: "",
    name: "",
    url: "",
    tag: "",
    code: "",
    config: clone(DEFAULT_CONFIG)
  };
}

function createDraftFromRobot(robot) {
  return {
    selectedRobotId: robot.id,
    name: robot.name,
    url: robot.url,
    tag: robot.tag,
    code: robot.code,
    config: clone(robot.config || DEFAULT_CONFIG)
  };
}

function ensureDraftConsistency() {
  if (!draft) {
    draft = createEmptyDraft();
    return true;
  }

  if (draft.selectedRobotId) {
    const selectedRobot = robots.find((robot) => robot.id === draft.selectedRobotId);
    if (selectedRobot) {
      return false;
    }

    draft = { ...draft, selectedRobotId: "" };
    return true;
  }

  draft = {
    ...createEmptyDraft(),
    ...draft,
    config: isObject(draft.config) ? draft.config : clone(DEFAULT_CONFIG)
  };

  return false;
}

function buildUiState() {
  const orderedRuns = sortRuns(Object.values(runtime.runs));
  const selectedRunId = resolveSelectedRunId(orderedRuns, runtime.selectedRunId);
  const selectedRun = findRunById(orderedRuns, selectedRunId);

  return {
    authRequired: authPromptPending,
    draft,
    robots: robots
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((robot) => ({
        id: robot.id,
        name: robot.name,
        url: robot.url,
        tag: robot.tag,
        updatedAt: robot.updatedAt
      })),
    runs: orderedRuns
      .slice(0, UI_RUN_HISTORY_LIMIT)
      .map((run) => summarizeRunListItem(run)),
    selectedRunId,
    selectedRun: selectedRun ? summarizeRun(selectedRun) : null,
    snapshots: Object.values(snapshots)
      .sort((left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || ""))
      .slice(0, 20)
      .map((snapshot) => ({
        runId: snapshot.runId,
        robotName: snapshot.robotName,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        updatedAt: snapshot.updatedAt,
        remainingSteps: snapshot.queue.length + (snapshot.currentStep ? 1 : 0)
      }))
  };
}

function summarizeRunListItem(run) {
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
    updatedAt: run.updatedAt,
    queueLength: run.queue.length,
    currentStep: run.currentStep,
    failures: run.failures,
    emits: run.emits,
    rows: run.rows,
    runSource: run.runSource
  };
}

function summarizeRun(run) {
  if (!run) {
    return null;
  }

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
    logs: run.logs.slice(-300),
    outputTables: run.outputTables,
    queueLength: run.queue.length,
    currentStep: run.currentStep,
    failures: run.failures,
    emits: run.emits,
    rows: run.rows,
    retries: run.retries,
    config: run.config,
    runSource: run.runSource
  };
}

function hydrateRun(run) {
  return {
    id: run.id || createId("run"),
    robotId: run.robotId || "",
    robotName: run.robotName || "Untitled Robot",
    status: run.status || RUN_STATUS.idle,
    phase: run.phase || RUN_STATUS.idle,
    tag: run.tag || "",
    startUrl: run.startUrl || "",
    currentUrl: run.currentUrl || "",
    startedAt: run.startedAt || new Date().toISOString(),
    finishedAt: run.finishedAt || null,
    logs: Array.isArray(run.logs) ? run.logs : [],
    outputTables: isObject(run.outputTables) ? run.outputTables : {},
    queue: Array.isArray(run.queue) ? run.queue : [],
    currentStep: run.currentStep || null,
    retries: {
      ...DEFAULT_RETRIES,
      ...(run.retries || {})
    },
    config: {
      ...DEFAULT_CONFIG,
      ...(run.config || {})
    },
    failures: Number.isFinite(run.failures) ? run.failures : 0,
    emits: Number.isFinite(run.emits) ? run.emits : 0,
    rows: Number.isFinite(run.rows) ? run.rows : 0,
    runSource: run.runSource === RUN_SOURCE.portalServer
      ? RUN_SOURCE.portalServer
      : RUN_SOURCE.localExtension,
    visitedUrls: Array.isArray(run.visitedUrls) ? run.visitedUrls : [],
    visitedMap: isObject(run.visitedMap) ? run.visitedMap : {},
    code: typeof run.code === "string" ? run.code : DEFAULT_SCRIPT,
    tabId: Number.isInteger(run.tabId) ? run.tabId : null,
    updatedAt: run.updatedAt || new Date().toISOString(),
    executionToken: null,
    currentStepOutputCheckpoint: null
  };
}

function getLocalRobot(robotId) {
  return robots.find((robot) => robot.id === robotId) || null;
}

function deletedRobotMessage() {
  return "This robot is no longer available in the portal. It was deleted and cannot be recreated from the IDE.";
}

async function purgeRobotState(robotId) {
  let changed = false;

  const robotIndex = robots.findIndex((robot) => robot.id === robotId);
  if (robotIndex !== -1) {
    robots.splice(robotIndex, 1);
    changed = true;
  }

  for (const [runId, run] of Object.entries(runtime.runs)) {
    if (run.robotId !== robotId) {
      continue;
    }

    clearRunTimer(runId);
    if (run.tabId) {
      await chrome.debugger.detach({ tabId: run.tabId }).catch(() => null);
    }
    delete runtime.runs[runId];
    changed = true;
  }

  if (runtime.lastRunId && !runtime.runs[runtime.lastRunId]) {
    runtime.lastRunId = null;
    changed = true;
  }

  if (runtime.selectedRunId && !runtime.runs[runtime.selectedRunId]) {
    runtime.selectedRunId = null;
    changed = true;
  }

  for (const [snapshotId, snapshot] of Object.entries(snapshots)) {
    if (snapshot.robotId === robotId) {
      delete snapshots[snapshotId];
      changed = true;
    }
  }

  if (draft?.selectedRobotId === robotId) {
    draft = { ...draft, selectedRobotId: "" };
    changed = true;
  }

  return changed;
}

async function saveRobot(robotInput) {
  if (authPromptPending) {
    throw new Error("Sign in to the portal before loading or saving robots.");
  }

  const now = new Date().toISOString();
  const robotId = typeof robotInput.id === "string" ? robotInput.id.trim() : "";
  const name = (robotInput.name || "").trim();

  if (!robotId) {
    throw new Error("Create new robots in the portal. The IDE can only save robots that already exist.");
  }

  if (!name) {
    throw new Error("Robot name is required.");
  }

  if (/\s/.test(name)) {
    throw new Error("Robot names cannot contain spaces.");
  }

  const existingRobot = getLocalRobot(robotId);
  if (!existingRobot) {
    throw new Error(deletedRobotMessage());
  }

  const nextRobot = {
    id: robotId,
    name,
    url: normalizeUrl(robotInput.url || existingRobot.url || ""),
    tag: (robotInput.tag || "").trim(),
    code: typeof robotInput.code === "string" ? robotInput.code : existingRobot.code,
    config: {
      ...DEFAULT_CONFIG,
      ...(robotInput.config || existingRobot.config || {})
    },
    createdAt: existingRobot.createdAt || robotInput.createdAt || now,
    updatedAt: now
  };

  let savedRobot;
  try {
    savedRobot = await updateRobotInPortal(nextRobot);
  } catch (error) {
    if (error.status === 404) {
      const changed = await purgeRobotState(robotId);
      if (changed) {
        schedulePersist();
        broadcastState();
      }
      throw new Error(deletedRobotMessage());
    }

    throw new Error(`Could not save robot to the portal: ${error.message}`);
  }

  Object.assign(existingRobot, normalizeRobotFromPortal(savedRobot || nextRobot, {
    defaultConfig: DEFAULT_CONFIG,
    defaultScript: DEFAULT_SCRIPT,
    fallbackRobot: existingRobot
  }));
  draft = createDraftFromRobot(existingRobot);

  schedulePersist();
  broadcastState();
  return existingRobot;
}

async function loadRobot(robotId) {
  if (authPromptPending) {
    throw new Error("Sign in to the portal before loading robots.");
  }

  let refreshed;
  try {
    refreshed = await syncRobotFromPortal(robotId, { forceDraftSync: true, syncDraft: true });
  } catch (error) {
    throw new Error(`Could not load robot from the portal: ${error.message}`);
  }

  if (!refreshed.robot) {
    throw new Error(deletedRobotMessage());
  }

  schedulePersist();
  broadcastState();
  return refreshed.robot;
}

async function startRun(payload) {
  if (authPromptPending) {
    throw new Error("Sign in to the portal before running robots.");
  }

  const robotId = payload.robotId || draft.selectedRobotId || "";
  if (!robotId) {
    throw new Error("Select a robot from the portal before running it.");
  }

  let refreshedRobot;
  try {
    refreshedRobot = await syncRobotFromPortal(robotId, { syncDraft: false });
  } catch (error) {
    throw new Error(`Could not verify robot availability in the portal: ${error.message}`);
  }

  if (!refreshedRobot.robot) {
    if (refreshedRobot.changed) {
      schedulePersist();
      broadcastState();
    }
    throw new Error(deletedRobotMessage());
  }

  const localRobot = refreshedRobot.robot;
  const runSource = payload.runSource === RUN_SOURCE.portalServer
    ? RUN_SOURCE.portalServer
    : RUN_SOURCE.localExtension;
  const isServerRun = runSource === RUN_SOURCE.portalServer;

  // Server runs must use the authoritative robot record from the portal DB,
  // never the extension-local IDE draft (which can be stale or belong to a
  // different robot the operator last edited).
  const startUrl = normalizeUrl(
    payload.url || (isServerRun ? localRobot.url : (draft.url || localRobot.url))
  );
  const code = typeof payload.code === "string" && payload.code.trim()
    ? payload.code
    : (isServerRun ? localRobot.code : (draft.code || localRobot.code));
  const robotName = (
    payload.name
      || (isServerRun ? localRobot.name : draft.name)
      || localRobot.name
      || "Untitled Robot"
  ).trim();

  const run = hydrateRun({
    id: createId("run"),
    robotId,
    robotName,
    status: RUN_STATUS.running,
    phase: RUN_STATUS.idle,
    tag: payload.tag || draft.tag || "",
    startUrl,
    currentUrl: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    logs: [],
    outputTables: {},
    queue: [],
    currentStep: null,
    retries: clone(DEFAULT_RETRIES),
    config: {
      ...DEFAULT_CONFIG,
      ...(payload.config || draft.config || {})
    },
    failures: 0,
    emits: 0,
    rows: 0,
    runSource,
    visitedUrls: [],
    visitedMap: {},
    code
  });

  appendLog(run, `Run started for "${robotName}"`, "INFO");
  enqueueSteps(run, [
    createStep({
      url: startUrl,
      step: payload.step || "start",
      params: payload.params || null
    })
  ]);

  runtime.lastRunId = run.id;
  runtime.selectedRunId = run.id;
  runtime.runs[run.id] = run;

  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  void createRunInPortal(run);
  await dispatchNextStep(run);
  return summarizeRun(run);
}

async function stopRun(runId) {
  const run = runtime.runs[runId];

  if (!run) {
    return false;
  }

  appendLog(run, "Run stopped by user.", "WARN");
  await finishRun(run, RUN_STATUS.aborted);
  return true;
}

async function stopRunByTab(tabId) {
  const run = findRunByTabId(tabId);

  if (!run || !isRunningRun(run)) {
    return false;
  }

  appendLog(run, "Run stopped by stop() from page script.", "WARN");
  await finishRun(run, RUN_STATUS.aborted);
  return true;
}

function getSnapshot(runId) {
  return snapshots[runId] || null;
}

async function resumeRun(runId) {
  const snapshot = snapshots[runId];

  if (!snapshot) {
    throw new Error("No saved snapshot for that run ID.");
  }

  if (snapshot.robotId && !getLocalRobot(snapshot.robotId)) {
    throw new Error(deletedRobotMessage());
  }

  const run = hydrateRun({
    id: snapshot.runId,
    robotId: snapshot.robotId,
    robotName: snapshot.robotName,
    status: RUN_STATUS.running,
    phase: RUN_STATUS.idle,
    tag: snapshot.tag,
    startUrl: snapshot.startUrl,
    currentUrl: snapshot.currentUrl,
    startedAt: snapshot.startedAt,
    finishedAt: null,
    logs: snapshot.logs || [],
    outputTables: snapshot.outputTables || {},
    queue: snapshot.queue || [],
    currentStep: null,
    retries: snapshot.retries || DEFAULT_RETRIES,
    config: snapshot.config || DEFAULT_CONFIG,
    failures: snapshot.failures || 0,
    emits: snapshot.emits || 0,
    rows: snapshot.rows || 0,
    visitedUrls: snapshot.visitedUrls || [],
    visitedMap: snapshot.visitedMap || {},
    code: snapshot.code || DEFAULT_SCRIPT
  });

  if (snapshot.currentStep) {
    run.queue.push(snapshot.currentStep);
  }

  appendLog(run, `Run resumed from snapshot ${snapshot.runId}`, "INFO");
  runtime.lastRunId = run.id;
  runtime.selectedRunId = run.id;
  runtime.runs[run.id] = run;

  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  await dispatchNextStep(run);
  return summarizeRun(run);
}

async function onRuntimeReady(tab, pageUrl) {
  if (!tab?.id) {
    return;
  }

  const liveTab = await chrome.tabs.get(tab.id).catch(() => tab);
  const run = findRunByTabId(tab.id);

  if (!run || run.status !== RUN_STATUS.running || !run.currentStep) {
    schedulePersist();
    return;
  }

  run.currentUrl = pageUrl || liveTab?.url || tab.url || run.currentUrl;
  updateSnapshot(run);

  if (!shouldExecuteRunOnRuntimeReady(run)) {
    schedulePersist();
    broadcastState();
    return;
  }

  const blockedPageError = getBlockedPageError({
    pageTitle: liveTab?.title || tab.title || "",
    pageUrl: run.currentUrl
  });

  if (blockedPageError) {
    // Multiple domReady events can fire for a single page load; only count a
    // new attempt once the prior reload has fired and the next domReady comes.
    if (run.challengeReloadTimer) {
      schedulePersist();
      broadcastState();
      return;
    }
    run.challengeAttempts = (run.challengeAttempts || 0) + 1;
    if (run.challengeAttempts > CHALLENGE_MAX_ATTEMPTS) {
      appendLog(
        run,
        `${blockedPageError} Giving up after ${CHALLENGE_MAX_ATTEMPTS} attempts.`,
        "ERROR"
      );
      await finishRun(run, RUN_STATUS.failed);
      return;
    }
    appendLog(
      run,
      `${blockedPageError} Waiting for the real page before executing step ${describeStep(run.currentStep)} (attempt ${run.challengeAttempts}/${CHALLENGE_MAX_ATTEMPTS}).`,
      "WARN"
    );
    schedulePersist();
    broadcastState();
    scheduleChallengeReload(run, tab.id);
    return;
  }

  run.challengeAttempts = 0;
  if (isOpenUrlStep(run.currentStep)) {
    await completeOpenUrlStep(run, run.currentUrl);
    return;
  }

  await executeCurrentStep(run);
}

const CHALLENGE_RELOAD_DELAY_MS = 15_000;
const CHALLENGE_MAX_ATTEMPTS = 5;

function scheduleChallengeReload(run, tabId) {
  if (!run || run.challengeReloadTimer) {
    return;
  }
  run.challengeReloadTimer = setTimeout(async () => {
    run.challengeReloadTimer = null;
    if (!isRunningRun(run)) {
      return;
    }
    // If CF is mid-redirect (the URL has a __cf_chl_rt_tk token) let the
    // in-flight challenge finish rather than interrupt it with a reload.
    let currentUrl = "";
    try {
      const tab = await chrome.tabs.get(tabId);
      currentUrl = tab?.url || "";
    } catch (_error) { /* tab gone */ }
    if (currentUrl.includes("__cf_chl_rt_tk=")) {
      appendLog(run, "Cloudflare challenge is redirecting — waiting another cycle.", "DEBUG");
      schedulePersist();
      broadcastState();
      scheduleChallengeReload(run, tabId);
      return;
    }
    try {
      await chrome.tabs.reload(tabId, { bypassCache: false });
      appendLog(run, `Reloaded tab ${tabId} to re-check Cloudflare challenge.`, "DEBUG");
      schedulePersist();
      broadcastState();
    } catch (error) {
      appendLog(run, `Failed to reload tab ${tabId}: ${error?.message || error}`, "WARN");
    }
  }, CHALLENGE_RELOAD_DELAY_MS);
}

function logFromTab(tabId, message, level = "DEBUG") {
  const run = findRunByTabId(tabId);

  if (!isRunningRun(run)) {
    return false;
  }

  appendLog(run, message, level);
  schedulePersist();
  broadcastState();
  return true;
}

async function queueStepsFromRuntime(tabId, steps) {
  const run = findRunByTabId(tabId);

  if (!run || run.status !== RUN_STATUS.running || !Array.isArray(steps)) {
    return false;
  }

  enqueueSteps(run, steps.map((step) => createStep(step)));
  updateSnapshot(run);
  schedulePersist();
  broadcastState();

  if (!run.currentStep) {
    await dispatchNextStep(run);
  }

  return true;
}

function emitRowsFromRuntime(tabId, tableName, rows) {
  const run = findRunByTabId(tabId);

  if (!run || run.status !== RUN_STATUS.running || typeof tableName !== "string") {
    return false;
  }

  const sanitizedName = tableName.trim().replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50) || "output";
  const nextRows = Array.isArray(rows) ? rows : [];

  if (!run.outputTables[sanitizedName]) {
    run.outputTables[sanitizedName] = [];
  }

  for (const row of nextRows) {
    run.outputTables[sanitizedName].push({
      ...(isObject(row) ? row : { value: row }),
      source_url: run.currentUrl || run.startUrl
    });
  }

  run.emits += 1;
  run.rows += nextRows.length;

  appendLog(run, `Emit ${sanitizedName}: ${nextRows.length} row(s)`, "INFO");
  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  void updateRunInPortal(run);
  return true;
}

async function completeStep(tabId, pageUrl, pageTitle = "") {
  const run = findRunByTabId(tabId);

  if (!run || run.status !== RUN_STATUS.running || !run.currentStep) {
    return;
  }

  const blockedPageError = getBlockedPageError({
    pageTitle,
    pageUrl: pageUrl || run.currentUrl || run.startUrl
  });

  if (blockedPageError) {
    await failCurrentStep(tabId, blockedPageError, { fatal: true });
    return;
  }

  clearRunTimer(run.id);
  run.executionToken = null;
  run.currentStepOutputCheckpoint = null;
  run.currentUrl = pageUrl || run.currentUrl;
  run.phase = RUN_STATUS.idle;
  run.currentStep = null;
  appendLog(run, "Step completed.", "INFO");
  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  await dispatchNextStep(run);
}

async function failCurrentStep(tabId, errorMessage, options = {}) {
  const run = findRunByTabId(tabId);

  if (!run || run.status !== RUN_STATUS.running || !run.currentStep) {
    return;
  }

  clearRunTimer(run.id);
  appendLog(run, errorMessage, "ERROR");
  await retryOrFailRun(run, run.currentStep, options);
}

function clearRunQueue(tabId) {
  const run = findRunByTabId(tabId);

  if (!run) {
    return false;
  }

  run.queue = [];
  appendLog(run, "Run queue cleared.", "WARN");
  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  return true;
}

function setRetries(tabId, retries) {
  const run = findRunByTabId(tabId);

  if (!run) {
    return null;
  }

  run.retries = {
    intervalMs: Number.isFinite(Number(retries.intervalMs)) ? Number(retries.intervalMs) : run.retries.intervalMs,
    maxStep: Number.isFinite(Number(retries.maxStep)) ? Number(retries.maxStep) : run.retries.maxStep,
    maxRun: Number.isFinite(Number(retries.maxRun)) ? Number(retries.maxRun) : run.retries.maxRun
  };

  appendLog(run, `Retry policy updated: ${JSON.stringify(run.retries)}`, "INFO");
  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  return clone(run.retries);
}

async function setUserAgent(tabId, userAgent) {
  const run = findRunByTabId(tabId);

  if (!run || !userAgent) {
    return;
  }

  try {
    await chrome.debugger.attach({ tabId: run.tabId }, "1.3");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (!detail.includes("Another debugger")) {
      appendLog(run, `Could not attach debugger for UA override: ${detail}`, "WARN");
      return;
    }
  }

  await chrome.debugger.sendCommand(
    { tabId: run.tabId },
    "Network.setUserAgentOverride",
    { userAgent }
  );

  appendLog(run, `User-Agent override applied: ${userAgent}`, "INFO");
}

function updateRunConfig(tabId, settings) {
  const run = findRunByTabId(tabId);

  if (!run) {
    return null;
  }

  run.config = {
    ...run.config,
    ...settings
  };

  if (run.config.respectRobotsTxt) {
    appendLog(run, "respectRobotsTxt is stored but not enforced in the local rebuild.", "WARN");
  }

  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  return clone(run.config);
}

async function setProxyDirect(proxy) {
  if (!proxy.server) {
    await resetProxySettings();
    return;
  }

  const port = Number.isFinite(Number(proxy.port)) ? Number(proxy.port) : 8888;
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          host: proxy.server,
          port
        },
        bypassList: Array.isArray(proxy.bypass) ? proxy.bypass : []
      }
    },
    scope: "regular"
  });
}

async function resetProxySettings() {
  await chrome.proxy.settings.set({
    value: { mode: "system" },
    scope: "regular"
  });
}

async function setImagesAllowed(allowed) {
  await chrome.contentSettings.images.set({
    primaryPattern: "<all_urls>",
    setting: allowed ? "allow" : "block"
  });
}

async function clearCookies(domain) {
  if (!domain) {
    return;
  }

  const cookies = await chrome.cookies.getAll({ domain });

  await Promise.all(cookies.map((cookie) => {
    const protocol = cookie.secure ? "https:" : "http:";
    const url = `${protocol}//${cookie.domain.replace(/^\./, "")}${cookie.path}`;

    return chrome.cookies.remove({
      url,
      name: cookie.name,
      storeId: cookie.storeId
    });
  }));
}

async function clearBrowsingData(origins, settings) {
  const removalOptions = Array.isArray(origins) && origins.length ? { origins } : {};
  const dataToRemove = isObject(settings) && Object.keys(settings).length
    ? settings
    : {
        cacheStorage: true,
        cookies: true,
        indexedDB: true,
        localStorage: true,
        serviceWorkers: true
      };

  await chrome.browsingData.remove(removalOptions, dataToRemove);
}

async function previewSelectors(preview) {
  const tabId = await resolvePreviewTabId();

  if (!tabId) {
    throw new Error("No page tab is available to preview selectors against.");
  }

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "PREVIEW_SELECTORS",
    selectors: Array.isArray(preview.selectors) ? preview.selectors : []
  });

  return response || {
    headers: [],
    rows: [],
    code: ""
  };
}

async function focusRunTab(runId) {
  const run = runtime.runs[runId];

  if (!run?.tabId) {
    return false;
  }

  const tab = await chrome.tabs.get(run.tabId).catch(() => null);

  if (!tab?.id) {
    return false;
  }

  await chrome.tabs.update(tab.id, { active: true });

  if (Number.isInteger(tab.windowId)) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }

  return true;
}

async function resolvePreviewTabId() {
  const selectedFromState = selectPreviewTabId(runtime);
  if (selectedFromState) {
    return selectedFromState;
  }

  const tabs = await chrome.tabs.query({
    lastFocusedWindow: true
  });

  return selectPreviewTabId(runtime, tabs);
}

function enqueueSteps(run, steps) {
  let queuedCount = 0;

  for (const step of steps) {
    if (run.config.skipVisited && step.url && run.visitedMap[step.url]) {
      appendLog(run, `Skipping already-visited URL: ${step.url}`, "INFO");
      continue;
    }

    if (step.url) {
      run.visitedMap[step.url] = true;
      run.visitedUrls.push(step.url);
    }

    for (const queueEntry of createLegacyQueueEntries(step, { createId })) {
      run.queue.push(queueEntry);
      queuedCount += 1;
    }
  }

  appendLog(run, `Queued ${queuedCount} step(s). Queue size: ${run.queue.length}`, "DEBUG");
  run.updatedAt = new Date().toISOString();
}

async function dispatchNextStep(run) {
  if (!run || run.status !== RUN_STATUS.running || run.currentStep) {
    return;
  }

  const nextStep = run.queue.pop();

  if (!nextStep) {
    await finishRun(run, RUN_STATUS.finished);
    return;
  }

  run.currentStep = nextStep;
  run.currentStepOutputCheckpoint = isOpenUrlStep(nextStep)
    ? null
    : createStepOutputCheckpoint(run);
  run.phase = nextStep.gofast ? "EXECUTING" : "AWAITING_DOM_READY";
  run.updatedAt = new Date().toISOString();
  appendLog(
    run,
    isOpenUrlStep(nextStep)
      ? `Opening URL ${nextStep.url}`
      : nextStep.gofast
      ? `Executing fast step ${nextStep.step} against ${nextStep.url || run.currentUrl || run.startUrl}`
      : !nextStep.url
      ? `Executing step ${nextStep.step}`
      : `Navigating to ${nextStep.url} for step ${nextStep.step}`,
    "INFO"
  );

  armRunTimer(run);
  updateSnapshot(run);
  schedulePersist();
  broadcastState();

  if (nextStep.gofast || !nextStep.url) {
    await executeCurrentStep(run);
    return;
  }

  if (!run.tabId) {
    const tab = await chrome.tabs.create({
      url: nextStep.url,
      active: true
    });
    run.tabId = tab.id;
    runtime.lastPageTabId = tab.id;
    schedulePersist();
    broadcastState();
    return;
  }

  const updatedTab = await chrome.tabs.update(run.tabId, {
    url: nextStep.url
  }).catch(() => null);

  if (!updatedTab?.id) {
    const tab = await chrome.tabs.create({
      url: nextStep.url,
      active: true
    });
    run.tabId = tab.id;
    runtime.lastPageTabId = tab.id;
    schedulePersist();
    broadcastState();
  }
}

async function completeOpenUrlStep(run, pageUrl) {
  clearRunTimer(run.id);
  run.executionToken = null;
  run.currentStepOutputCheckpoint = null;
  run.currentUrl = pageUrl || run.currentUrl;
  run.phase = RUN_STATUS.idle;
  run.currentStep = null;
  appendLog(run, "URL opened.", "INFO");
  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  await dispatchNextStep(run);
}

async function executeCurrentStep(run) {
  if (!run?.currentStep || !run.tabId) {
    return;
  }

  const executionToken = createId("exec");
  run.executionToken = executionToken;
  run.phase = "EXECUTING";
  run.updatedAt = new Date().toISOString();
  updateSnapshot(run);
  schedulePersist();
  broadcastState();

  const step = run.currentStep;
  const ajaxUrl = step.gofast ? (step.ajaxurl || step.url || "") : "";

  try {
    await ensureUserScriptWorldConfigured();

    // User-provided robot code must run via chrome.userScripts so page CSP
    // cannot block it. The injected legacy runtime still reports emit/next/done
    // back through the existing message router.
    const [injection] = await chrome.userScripts.execute({
      target: { tabId: run.tabId, frameIds: [0] },
      injectImmediately: Boolean(step.gofast),
      js: buildLegacyUserScriptSources(
        run.code,
        step.step || "start",
        step.params ?? null,
        ajaxUrl
      )
    });

    if (injection?.error) {
      throw new Error(injection.error);
    }
  } catch (error) {
    if (!shouldProcessExecutionResult(runtime, run, executionToken)) {
      return;
    }

    const detail = error instanceof Error ? error.message : String(error);
    appendLog(run, `User script execution failed: ${detail}`, "ERROR");
    await retryOrFailRun(run, step);
  }
}

async function retryOrFailRun(run, step, { fatal = false } = {}) {
  run.executionToken = null;
  const rollback = rollbackStepOutput(run, run.currentStepOutputCheckpoint);
  run.currentStepOutputCheckpoint = null;

  if (rollback.removedRows > 0 || rollback.removedEmits > 0) {
    appendLog(
      run,
      `Discarded ${rollback.removedRows} row(s) from ${rollback.removedEmits} emit(s) because step ${describeStep(step)} failed.`,
      "WARN"
    );
  }

  run.failures += 1;
  const nextAttempt = (step.retryCount || 0) + 1;
  const updatedStep = {
    ...step,
    retryCount: nextAttempt
  };

  run.currentStep = null;
  run.phase = RUN_STATUS.idle;

  if (!fatal && nextAttempt < run.retries.maxStep && run.failures < run.retries.maxRun) {
    run.queue.push(updatedStep);
    appendLog(run, `Retrying step ${describeStep(updatedStep)}. Attempt ${nextAttempt}.`, "WARN");
    updateSnapshot(run);
    schedulePersist();
    broadcastState();
    await dispatchNextStep(run);
    return;
  }

  if (fatal) {
    appendLog(run, `Step ${describeStep(updatedStep)} failed without retry. Marking run as failed.`, "ERROR");
    await finishRun(run, RUN_STATUS.failed);
    return;
  }

  appendLog(run, `Too many failures for step ${describeStep(updatedStep)}. Marking run as failed.`, "ERROR");
  await finishRun(run, RUN_STATUS.failed);
}

async function finishRun(run, status) {
  clearRunTimer(run.id);
  run.executionToken = null;
  run.currentStepOutputCheckpoint = null;
  run.status = status;
  run.phase = RUN_STATUS.idle;
  run.currentStep = null;
  run.finishedAt = new Date().toISOString();
  run.updatedAt = run.finishedAt;

   if (run.tabId) {
    await chrome.debugger.detach({ tabId: run.tabId }).catch(() => null);
  }

  updateSnapshot(run);
  schedulePersist();
  broadcastState();
  void updateRunInPortal(run);
}

function updateSnapshot(run) {
  snapshots[run.id] = {
    runId: run.id,
    robotId: run.robotId,
    robotName: run.robotName,
    status: run.status,
    tag: run.tag,
    startUrl: run.startUrl,
    currentUrl: run.currentUrl,
    startedAt: run.startedAt,
    updatedAt: new Date().toISOString(),
    logs: run.logs.slice(-300),
    outputTables: clone(run.outputTables),
    queue: clone(run.queue),
    currentStep: clone(run.currentStep),
    retries: clone(run.retries),
    config: clone(run.config),
    failures: run.failures,
    emits: run.emits,
    rows: run.rows,
    runSource: run.runSource,
    visitedUrls: clone(run.visitedUrls),
    visitedMap: clone(run.visitedMap),
    code: run.code
  };
}

function appendLog(run, message, level = "INFO") {
  const timestamp = new Date().toISOString();
  run.logs.push(`${timestamp} ${level}: ${message}`);

  if (run.logs.length > 600) {
    run.logs.splice(0, run.logs.length - 600);
  }
}

function describeStep(step) {
  if (isOpenUrlStep(step)) {
    return "openUrl";
  }

  return step?.step || "unknown";
}

function armRunTimer(run) {
  clearRunTimer(run.id);
  runTimers.set(run.id, setTimeout(() => {
    void withReady(async () => {
      const liveRun = runtime.runs[run.id];

      if (!liveRun || liveRun.status !== RUN_STATUS.running || !liveRun.currentStep) {
        return;
      }

      appendLog(liveRun, `Timed out waiting for step ${describeStep(liveRun.currentStep)}.`, "WARN");
      await retryOrFailRun(liveRun, liveRun.currentStep);
    });
  }, run.retries.intervalMs));
}

function clearRunTimer(runId) {
  const timer = runTimers.get(runId);

  if (timer) {
    clearTimeout(timer);
    runTimers.delete(runId);
  }
}

function findRunByTabId(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }

  return Object.values(runtime.runs).find((run) => run.tabId === tabId) || null;
}

function createStep(step) {
  return {
    id: createId("step"),
    url: step.url ? normalizeUrl(step.url) : "",
    method: step.method || "",
    step: step.step || "start",
    params: step.params ?? null,
    gofast: Boolean(step.gofast),
    ajaxurl: step.ajaxurl ? normalizeUrl(step.ajaxurl) : "",
    retryCount: Number.isFinite(Number(step.retryCount)) ? Number(step.retryCount) : 0
  };
}

async function openIdePage() {
  const targetUrl = chrome.runtime.getURL("ide/index.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((tab) => tab.url === targetUrl);

  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId)) {
      const existingWindow = await chrome.windows.get(existing.windowId);

      if (existingWindow.type !== "popup") {
        await chrome.windows.create({
          tabId: existing.id,
          ...IDE_WINDOW_OPTIONS
        });
        return;
      }

      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  await chrome.windows.create({
    url: targetUrl,
    ...IDE_WINDOW_OPTIONS
  });
}

function schedulePersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }

  persistTimer = setTimeout(() => {
    void persistState();
  }, 100);
}

async function persistState() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.robots]: robots,
    [STORAGE_KEYS.draft]: draft,
    [STORAGE_KEYS.snapshots]: snapshots,
    [STORAGE_KEYS.runtime]: {
      runs: Object.fromEntries(
        Object.entries(runtime.runs).map(([runId, run]) => [runId, serializeRun(run)])
      ),
      lastRunId: runtime.lastRunId,
      lastPageTabId: runtime.lastPageTabId,
      selectedRunId: runtime.selectedRunId
    }
  });
}

function serializeRun(run) {
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
    logs: run.logs,
    outputTables: run.outputTables,
    queue: run.queue,
    currentStep: run.currentStep,
    retries: run.retries,
    config: run.config,
    failures: run.failures,
    emits: run.emits,
    rows: run.rows,
    runSource: run.runSource,
    visitedUrls: run.visitedUrls,
    visitedMap: run.visitedMap,
    code: run.code,
    tabId: run.tabId,
    updatedAt: run.updatedAt
  };
}

function broadcastState() {
  const state = buildUiState();

  for (const port of uiPorts) {
    try {
      port.postMessage({
        type: "STATE_UPDATED",
        state
      });
    } catch (error) {
      uiPorts.delete(port);
    }
  }
}

function clearUiDisconnectAbortTimer() {
  if (!uiDisconnectAbortTimer) {
    return;
  }

  clearTimeout(uiDisconnectAbortTimer);
  uiDisconnectAbortTimer = null;
}

function scheduleUiDisconnectAbort() {
  clearUiDisconnectAbortTimer();
  uiDisconnectAbortTimer = setTimeout(() => {
    uiDisconnectAbortTimer = null;

    void withReady(async () => {
      if (uiPorts.size) {
        return;
      }

      const runningRuns = Object.values(runtime.runs).filter(isRunningRun);

      for (const run of runningRuns) {
        appendLog(run, "IDE window closed. Aborting run.", "WARN");
        await finishRun(run, RUN_STATUS.aborted);
      }
    });
  }, UI_DISCONNECT_ABORT_DELAY_MS);
}

function normalizeUrl(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
}

function createId(prefix) {
  return `${prefix}_${new Date().toISOString().replace(/[:.]/g, "_")}_${Math.random().toString(36).slice(2, 8)}`;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
