const SELECTOR_PREVIEW_DEBOUNCE_MS = 300;
const AUTH_REQUIRED_MESSAGE = "Sign in to the configured portal to load robots and code. A login window should open automatically.";
const DEFAULT_PORTAL_MESSAGE = "Use Refresh robots to pull the latest portal changes.";
const {
  createSearchOptions,
  findActiveMatchIndex,
  formatSearchStatus,
  normalizeRange
} = window.ideSearchHelpers;
const {
  createUiTransport
} = window.ideUiTransportHelpers;
const AceSearch = ace.require("ace/search").Search;

const elements = {
  tabs: Array.from(document.querySelectorAll("[data-tab-target]")),
  panels: {
    code: document.querySelector("#code"),
    logtab: document.querySelector("#logtab"),
    output: document.querySelector("#output"),
    seltab: document.querySelector("#seltab"),
    resume: document.querySelector("#resume"),
    config: document.querySelector("#config")
  },
  robotSelect: document.querySelector("#robotSelect"),
  robotNameInput: document.querySelector("#robotNameInput"),
  robotDropdown: document.querySelector("#robotDropdown"),
  urlInput: document.querySelector("#url1"),
  tagInput: document.querySelector("#tag1"),
  codeInput: document.querySelector("#codeInput"),
  editorHost: document.querySelector("#code1"),
  runButton: document.querySelector("#btnRun"),
  stopButton: document.querySelector("#btnStop"),
  saveButton: document.querySelector("#btnSave"),
  findButton: document.querySelector("#btnFind"),
  refreshRobotsButton: document.querySelector("#btnRefreshRobots"),
  statusText: document.querySelector("#status"),
  portalRefreshStatus: document.querySelector("#portalRefreshStatus"),
  editorSearchBar: document.querySelector("#editorSearch"),
  editorSearchInput: document.querySelector("#editorSearchInput"),
  editorSearchCaseButton: document.querySelector("#editorSearchCase"),
  editorSearchWordButton: document.querySelector("#editorSearchWord"),
  editorSearchRegexButton: document.querySelector("#editorSearchRegex"),
  editorSearchStatus: document.querySelector("#editorSearchStatus"),
  editorSearchPrevButton: document.querySelector("#editorSearchPrev"),
  editorSearchNextButton: document.querySelector("#editorSearchNext"),
  editorSearchCloseButton: document.querySelector("#editorSearchClose"),
  logOutput: document.querySelector("#log"),
  focusRunLink: document.querySelector("#fulldata"),
  tableSelect: document.querySelector("#tableSelect"),
  outputTableHead: document.querySelector("#outputTable thead"),
  outputTableBody: document.querySelector("#outputTable tbody"),
  outputRaw: document.querySelector("#content"),
  downloadJsonButton: document.querySelector("#downloadJsonButton"),
  downloadCsvButton: document.querySelector("#downloadCsvButton"),
  selectorTableBody: document.querySelector("#selectorTableBody"),
  copySelectorCodeButton: document.querySelector("#copySelCode"),
  selectorCodeOutput: document.querySelector("#selectorsCode"),
  selectorPreviewHead: document.querySelector("#selectorPreviewTable thead"),
  selectorPreviewBody: document.querySelector("#selectorPreviewTable tbody"),
  resumeRunIdInput: document.querySelector("#resumeRunId"),
  checkResumeButton: document.querySelector("#checkResumeRun"),
  checkResumeLabel: document.querySelector("#checkResumeRunLabel"),
  resumeButton: document.querySelector("#resumeRun"),
  resumeLabel: document.querySelector("#resumeRunLabel"),
  resumePreviewOutput: document.querySelector("#resumePreview"),
  resetProxyButton: document.querySelector("#resetProxy"),
  allowImagesButton: document.querySelector("#allowImages"),
  blockImagesButton: document.querySelector("#blockImages")
};

const state = {
  activeTab: "code",
  authRequired: false,
  draft: null,
  robots: [],
  runs: [],
  selectedRunId: null,
  selectedRun: null,
  snapshots: [],
  selectedTable: "",
  selectorRows: [
    { name: "row", selector: "a" },
    { name: "label", selector: "$(row).text().trim()" },
    { name: "href", selector: "row.href" },
    { name: "", selector: "" }
  ],
  lastSnapshotPreview: null,
  editorSearch: {
    visible: false,
    query: "",
    caseSensitive: false,
    wholeWord: false,
    regExp: false,
    matches: [],
    activeMatchIndex: -1,
    error: ""
  }
};

let aceEditor = null;
let persistDraftTimer = null;
let selectorPreviewTimer = null;
let isRefreshingRobots = false;
let hasBootstrappedState = false;

const uiTransport = createUiTransport({
  connectPort: () => chrome.runtime.connect({ name: "scraper-ui" }),
  syncState: async () => {
    const response = await sendMessage({ type: "GET_STATE" });
    if (!response.ok || !response.state) {
      throw new Error(response.error || "Could not sync IDE state.");
    }

    return response.state;
  },
  applyState: (nextState) => {
    applyIncomingState(nextState, {
      fullRender: !hasBootstrappedState
    });
  }
});

initializeEditor();
bindEvents();
boot();

function initializeEditor() {
  ace.config.set("loadWorkerFromBlob", false);
  aceEditor = ace.edit(elements.editorHost);
  aceEditor.session.setMode("ace/mode/javascript");
  aceEditor.setTheme("ace/theme/twilight");
  aceEditor.session.setUseWorker(false);
  aceEditor.setShowPrintMargin(false);
  aceEditor.$blockScrolling = Infinity;
  aceEditor.commands.addCommand({
    name: "saveRobot",
    bindKey: { win: "Ctrl-S", mac: "Command-S" },
    exec: () => {
      void saveRobot();
    }
  });
  aceEditor.commands.addCommand({
    name: "find",
    bindKey: { win: "Ctrl-F", mac: "Command-F" },
    exec: () => {
      openEditorSearch({ seedFromSelection: true });
    },
    readOnly: true
  });
  aceEditor.session.on("change", scheduleDraftPersist);
  aceEditor.selection.on("changeSelection", () => {
    if (state.editorSearch.visible) {
      refreshEditorSearchStatus();
    }
  });
  resizeEditor();
}

function bindEvents() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      setActiveTab(tab.dataset.tabTarget);
    });
  });

  elements.robotNameInput.addEventListener("input", () => {
    syncRobotSelectionFromInput();
    scheduleDraftPersist();
    updateDropdown();
  });

  elements.robotNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDropdown();
      return;
    }

    if (event.key === "Enter") {
      const exactMatch = syncRobotSelectionFromInput();
      const items = getDropdownItems();
      if (!items.length && exactMatch) {
        event.preventDefault();
        void selectRobotFromDropdown(exactMatch);
        return;
      }
    }

    const items = getDropdownItems();
    if (!items.length) return;
    const active = getActiveDropdownItem();
    let nextIndex = -1;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const currentIndex = active ? Array.from(items).indexOf(active) : -1;
      nextIndex = (currentIndex + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const currentIndex = active ? Array.from(items).indexOf(active) : items.length;
      nextIndex = (currentIndex - 1 + items.length) % items.length;
    } else if (event.key === "Enter") {
      event.preventDefault();
      (active || items[0]).click();
      return;
    }
    if (nextIndex !== -1) {
      setActiveDropdownItem(items[nextIndex]);
      items[nextIndex].scrollIntoView({ block: "nearest" });
    }
  });

  elements.robotNameInput.addEventListener("blur", () => {
    // Delay so a click on a dropdown item fires before the list closes.
    setTimeout(closeDropdown, 150);
  });

  elements.urlInput.addEventListener("input", scheduleDraftPersist);
  elements.tagInput.addEventListener("input", scheduleDraftPersist);

  elements.runButton.addEventListener("click", async () => {
    const response = await sendMessage({
      type: "START_RUN",
      payload: collectDraft()
    });

    if (!response.ok) {
      alert(response.error);
      return;
    }

    await selectRun(response.run?.id || null, response.run || null);
    setActiveTab("logtab");
  });

  elements.stopButton.addEventListener("click", async () => {
    if (!state.selectedRun?.id) {
      return;
    }

    await sendMessage({
      type: "STOP_RUN",
      runId: state.selectedRun.id
    });
  });

  elements.saveButton.addEventListener("click", () => {
    void saveRobot();
  });

  elements.findButton.addEventListener("click", () => {
    openEditorSearch({ seedFromSelection: true });
  });

  elements.refreshRobotsButton.addEventListener("click", () => {
    void refreshRobotsFromPortal();
  });

  elements.editorSearchInput.addEventListener("input", () => {
    state.editorSearch.query = elements.editorSearchInput.value;
    runEditorSearch({ skipCurrent: false });
  });

  elements.editorSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      navigateEditorSearch(event.shiftKey);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeEditorSearch();
      aceEditor.focus();
    }
  });

  elements.editorSearchCaseButton.addEventListener("click", () => {
    state.editorSearch.caseSensitive = !state.editorSearch.caseSensitive;
    runEditorSearch({ skipCurrent: false });
  });

  elements.editorSearchWordButton.addEventListener("click", () => {
    state.editorSearch.wholeWord = !state.editorSearch.wholeWord;
    runEditorSearch({ skipCurrent: false });
  });

  elements.editorSearchRegexButton.addEventListener("click", () => {
    state.editorSearch.regExp = !state.editorSearch.regExp;
    runEditorSearch({ skipCurrent: false });
  });

  elements.editorSearchPrevButton.addEventListener("click", () => {
    navigateEditorSearch(true);
  });

  elements.editorSearchNextButton.addEventListener("click", () => {
    navigateEditorSearch(false);
  });

  elements.editorSearchCloseButton.addEventListener("click", () => {
    closeEditorSearch();
    aceEditor.focus();
  });

  elements.focusRunLink.addEventListener("click", async (event) => {
    event.preventDefault();
    if (!state.selectedRun?.id) {
      return;
    }

    await sendMessage({
      type: "FOCUS_RUN_TAB",
      runId: state.selectedRun.id
    });
  });

  elements.tableSelect.addEventListener("change", () => {
    state.selectedTable = elements.tableSelect.value;
    renderOutput();
  });

  elements.downloadJsonButton.addEventListener("click", () => {
    const rows = getSelectedTableRows();
    downloadFile(`${selectedTableName()}.json`, JSON.stringify(rows, null, 2), "application/json");
  });

  elements.downloadCsvButton.addEventListener("click", () => {
    const rows = getSelectedTableRows();
    downloadFile(`${selectedTableName()}.csv`, toCsv(rows), "text/csv;charset=utf-8");
  });

  elements.copySelectorCodeButton.addEventListener("click", async () => {
    const code = buildSelectorCode(collectSelectorRows());
    elements.selectorCodeOutput.value = code;

    try {
      await navigator.clipboard.writeText(code);
    } catch (error) {
      elements.selectorCodeOutput.focus();
      elements.selectorCodeOutput.select();
      document.execCommand("copy");
    }
  });

  elements.checkResumeButton.addEventListener("click", async () => {
    const runId = elements.resumeRunIdInput.value.trim();
    if (!runId) {
      return;
    }

    const response = await sendMessage({
      type: "CHECK_RESUME",
      runId
    });

    if (!response.ok) {
      elements.checkResumeLabel.textContent = response.error;
      return;
    }

    state.lastSnapshotPreview = response.snapshot;
    elements.checkResumeLabel.textContent = response.snapshot
      ? response.snapshot.resumable === false
        ? "Metadata found. Full queue is too large for local resume."
        : "Snapshot found."
      : "No snapshot found.";
    renderResumePreview();
  });

  elements.resumeButton.addEventListener("click", async () => {
    const runId = elements.resumeRunIdInput.value.trim();
    if (!runId) {
      return;
    }

    const response = await sendMessage({
      type: "RESUME_RUN",
      runId
    });

    if (!response.ok) {
      elements.resumeLabel.textContent = response.error;
      return;
    }

    elements.resumeLabel.textContent = "Run resumed.";
    await selectRun(response.run?.id || null, response.run || null);
    setActiveTab("logtab");
  });

  elements.resetProxyButton.addEventListener("click", () => {
    void sendMessage({ type: "RESET_PROXY" });
  });

  elements.allowImagesButton.addEventListener("click", () => {
    void sendMessage({ type: "ALLOW_IMAGES" });
  });

  elements.blockImagesButton.addEventListener("click", () => {
    void sendMessage({ type: "BLOCK_IMAGES" });
  });

  window.addEventListener("resize", resizeEditor);
  window.addEventListener("beforeunload", () => {
    uiTransport.stop();
    void persistDraft();
  });
}

async function boot() {
  const synced = await uiTransport.start();
  if (synced || hasBootstrappedState) {
    renderPortalStatus();
  }

  if (!hasBootstrappedState) {
    render();
  }
}

async function saveRobot() {
  const response = await sendMessage({
    type: "SAVE_ROBOT",
    robot: collectDraft()
  });

  if (!response.ok) {
    alert(response.error);
    return;
  }

  mergeState({
    draft: {
      selectedRobotId: response.robot.id,
      name: response.robot.name,
      url: response.robot.url,
      tag: response.robot.tag,
      code: response.robot.code,
      config: response.robot.config
    }
  });
  render();
}

async function loadRobot(robotId) {
  const response = await sendMessage({
    type: "LOAD_ROBOT",
    robotId
  });

  if (!response.ok) {
    alert(response.error);
    return;
  }

  mergeState({
    draft: {
      selectedRobotId: response.robot.id,
      name: response.robot.name,
      url: response.robot.url,
      tag: response.robot.tag,
      code: response.robot.code,
      config: response.robot.config
    }
  });
  render();
}

function mergeState(nextState) {
  if (Object.prototype.hasOwnProperty.call(nextState, "authRequired")) {
    state.authRequired = Boolean(nextState.authRequired);
  }
  state.draft = nextState.draft || state.draft;
  state.robots = nextState.robots || state.robots;
  state.runs = Array.isArray(nextState.runs) ? nextState.runs : state.runs;
  if (Object.prototype.hasOwnProperty.call(nextState, "selectedRunId")) {
    state.selectedRunId = nextState.selectedRunId;
  }
  if (Object.prototype.hasOwnProperty.call(nextState, "selectedRun")) {
    state.selectedRun = nextState.selectedRun || null;
  }
  state.snapshots = nextState.snapshots || state.snapshots;
  syncSelectedTable();
}

function applyIncomingState(nextState, { fullRender = false } = {}) {
  const shouldFullRender = fullRender || hasWorkspaceStateChanged(nextState);
  const previousLiveState = captureLiveState();
  mergeState(nextState);
  hasBootstrappedState = true;

  if (shouldFullRender) {
    render();
    return;
  }

  renderLiveState(previousLiveState);
}

function captureLiveState() {
  return {
    workspaceSignature: getWorkspaceStateSignature(state),
    statusSignature: getRunStatusSignature(state.selectedRun),
    logSignature: getRunLogSignature(state.selectedRun),
    outputSignature: getRunOutputSignature(state.selectedRun, state.selectedTable)
  };
}

function hasWorkspaceStateChanged(nextState) {
  return getWorkspaceStateSignature(nextState) !== getWorkspaceStateSignature(state);
}

function getWorkspaceStateSignature(source = {}) {
  const draft = source.draft || {};
  const robots = Array.isArray(source.robots) ? source.robots : [];

  return JSON.stringify({
    authRequired: Boolean(source.authRequired),
    draft: {
      selectedRobotId: draft.selectedRobotId || "",
      name: draft.name || "",
      url: draft.url || "",
      tag: draft.tag || "",
      code: draft.code || ""
    },
    robots: robots.map((robot) => ({
      id: robot.id || "",
      name: robot.name || "",
      updatedAt: robot.updatedAt || ""
    }))
  });
}

function renderLiveState(previousLiveState) {
  const nextLiveState = captureLiveState();

  if (previousLiveState.workspaceSignature !== nextLiveState.workspaceSignature) {
    renderDraft();
    renderRobots();
    renderPortalStatus();
  }

  if (previousLiveState.statusSignature !== nextLiveState.statusSignature) {
    renderRunSummary();
  }

  if (state.activeTab === "logtab" && previousLiveState.logSignature !== nextLiveState.logSignature) {
    renderLogs();
  }

  if (state.activeTab === "output" && previousLiveState.outputSignature !== nextLiveState.outputSignature) {
    renderOutput();
  }
}

function getRunStatusSignature(run) {
  if (!run) {
    return "idle";
  }

  return [
    run.id || "",
    run.status || "",
    run.phase || "",
    run.queueLength || 0,
    run.failures || 0,
    run.emits || 0,
    run.rows || 0,
    run.currentUrl || "",
    run.startedAt || "",
    run.finishedAt || "",
    run.currentStep?.step || "",
    run.currentStep?.url || ""
  ].join("|");
}

function getRunLogSignature(run) {
  if (!run) {
    return "idle";
  }

  const logs = Array.isArray(run.logs) ? run.logs : [];
  return [
    run.id || "",
    logs.length,
    logs[logs.length - 1] || ""
  ].join("|");
}

function getRunOutputSignature(run, selectedTable) {
  if (!run) {
    return `idle|${selectedTable || ""}`;
  }

  const tables = run.outputTables || {};
  const tableNames = Object.keys(tables).sort();
  const activeTable = selectedTable && tables[selectedTable]
    ? selectedTable
    : tableNames[0] || "";
  const activeRows = activeTable ? (tables[activeTable] || []).length : 0;

  return [
    run.id || "",
    run.emits || 0,
    run.rows || 0,
    activeTable,
    activeRows,
    tableNames.join(",")
  ].join("|");
}

function render() {
  renderDraft();
  renderRobots();
  renderPortalStatus();
  renderRunSummary();
  renderEditorSearch();
  renderSelectorRows();
  renderResumePreview();
  setActiveTab(state.activeTab);
}

function renderDraft() {
  if (!state.draft) {
    return;
  }

  const hasSelectedRobot = Boolean(state.draft.selectedRobotId);
  const shouldForceBlankFields = state.authRequired || (!hasSelectedRobot && !state.robots.length);
  elements.runButton.disabled = !hasSelectedRobot;
  elements.saveButton.disabled = !hasSelectedRobot;

  const selectedRobot = state.robots.find((robot) => robot.id === state.draft.selectedRobotId);
  elements.robotSelect.value = state.draft.selectedRobotId || "";
  if (shouldForceBlankFields || document.activeElement !== elements.robotNameInput) {
    elements.robotNameInput.value = selectedRobot?.name || state.draft.name || "";
  }
  if (shouldForceBlankFields || document.activeElement !== elements.urlInput) {
    elements.urlInput.value = state.draft.url || "";
  }
  if (shouldForceBlankFields || document.activeElement !== elements.tagInput) {
    elements.tagInput.value = state.draft.tag || "";
  }
  elements.codeInput.value = state.draft.code || "";

  if (aceEditor.getValue() !== (state.draft.code || "")) {
    aceEditor.setValue(state.draft.code || "", -1);
  }
}

function renderRobots() {
  const currentValue = state.draft?.selectedRobotId || "";
  const shouldRefreshDropdown = document.activeElement === elements.robotNameInput;

  elements.robotSelect.innerHTML = "";
  closeDropdown();

  const blankOption = document.createElement("option");
  blankOption.value = "";
  blankOption.textContent = "";
  elements.robotSelect.append(blankOption);

  state.robots.forEach((robot) => {
    const selectOption = document.createElement("option");
    selectOption.value = robot.id;
    selectOption.textContent = robot.name;
    selectOption.selected = robot.id === currentValue;
    elements.robotSelect.append(selectOption);
  });

  if (shouldRefreshDropdown) {
    updateDropdown();
  }
}

function renderPortalStatus() {
  if (state.authRequired) {
    setPortalRefreshMessage(AUTH_REQUIRED_MESSAGE);
    return;
  }

  if (!elements.portalRefreshStatus.textContent || elements.portalRefreshStatus.textContent === AUTH_REQUIRED_MESSAGE) {
    setPortalRefreshMessage(DEFAULT_PORTAL_MESSAGE);
  }
}

function updateDropdown() {
  const query = elements.robotNameInput.value.trim().toLowerCase();

  if (query.length < 2) {
    closeDropdown();
    return;
  }

  const matches = state.robots.filter((robot) =>
    robot.name.toLowerCase().includes(query)
  );

  if (!matches.length) {
    closeDropdown();
    return;
  }

  elements.robotDropdown.innerHTML = "";
  matches.forEach((robot, index) => {
    const item = document.createElement("li");
    item.textContent = robot.name;
    item.addEventListener("mouseenter", () => {
      setActiveDropdownItem(item);
    });
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    item.addEventListener("click", async (event) => {
      event.preventDefault();
      await selectRobotFromDropdown(robot);
    });

    if (index === 0) {
      item.classList.add("dropdown-active");
    }

    elements.robotDropdown.append(item);
  });

  elements.robotDropdown.style.display = "block";
}

function closeDropdown() {
  elements.robotDropdown.style.display = "none";
  elements.robotDropdown.innerHTML = "";
}

function getDropdownItems() {
  return Array.from(elements.robotDropdown.querySelectorAll("li"));
}

function getActiveDropdownItem() {
  return elements.robotDropdown.querySelector("li.dropdown-active");
}

function setActiveDropdownItem(nextItem) {
  getDropdownItems().forEach((item) => item.classList.toggle("dropdown-active", item === nextItem));
}

async function selectRobotFromDropdown(robot) {
  elements.robotNameInput.value = robot.name;
  closeDropdown();
  await loadRobot(robot.id);
}

function renderRunSummary() {
  const run = state.selectedRun;

  if (!run) {
    elements.statusText.textContent = "Idle";
    elements.focusRunLink.classList.remove("is-visible");
    return;
  }

  const statusParts = [
    `Status: ${run.status}`,
    run.phase ? `Phase: ${run.phase}` : "",
    run.currentStep?.step ? `Step: ${run.currentStep.step}` : "",
    `Que: ${run.queueLength || 0}`,
    `Fails: ${run.failures || 0}`,
    `Emits: ${run.emits || 0}`,
    `Rows: ${run.rows || 0}`,
    `Dur: ${formatDuration(run.startedAt, run.finishedAt)}`
  ].filter(Boolean);

  elements.statusText.textContent = statusParts.join(" | ");
  elements.focusRunLink.classList.add("is-visible");
}

function renderEditorSearch() {
  elements.editorSearchBar.hidden = !state.editorSearch.visible;

  if (elements.editorSearchInput.value !== state.editorSearch.query) {
    elements.editorSearchInput.value = state.editorSearch.query;
  }

  setEditorSearchToggleState(elements.editorSearchCaseButton, state.editorSearch.caseSensitive);
  setEditorSearchToggleState(elements.editorSearchWordButton, state.editorSearch.wholeWord);
  setEditorSearchToggleState(elements.editorSearchRegexButton, state.editorSearch.regExp);

  elements.editorSearchStatus.textContent = formatSearchStatus({
    query: state.editorSearch.query,
    totalMatches: state.editorSearch.matches.length,
    activeMatchIndex: state.editorSearch.activeMatchIndex,
    error: state.editorSearch.error
  });

  const hasResults = state.editorSearch.matches.length > 0 && !state.editorSearch.error;
  elements.editorSearchPrevButton.disabled = !hasResults;
  elements.editorSearchNextButton.disabled = !hasResults;
}

function renderLogs() {
  elements.logOutput.textContent = state.selectedRun?.logs?.join("\n") || "No logs yet.";
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function renderOutput() {
  const tables = state.selectedRun?.outputTables || {};
  const tableNames = Object.keys(tables);
  const hasTables = tableNames.length > 0;

  elements.tableSelect.innerHTML = "";
  elements.downloadJsonButton.disabled = !hasTables;
  elements.downloadCsvButton.disabled = !hasTables;

  if (!hasTables) {
    elements.tableSelect.style.visibility = "hidden";
    elements.outputTableHead.innerHTML = "";
    elements.outputTableBody.innerHTML = "";
    elements.outputRaw.textContent = "No emitted rows yet.";
    return;
  }

  if (!state.selectedTable || !tables[state.selectedTable]) {
    state.selectedTable = tableNames[0];
  }

  tableNames.forEach((tableName) => {
    const option = document.createElement("option");
    option.value = tableName;
    option.textContent = tableName;
    option.selected = tableName === state.selectedTable;
    elements.tableSelect.append(option);
  });

  elements.tableSelect.style.visibility = tableNames.length > 1 ? "visible" : "hidden";

  const rows = getSelectedTableRows();
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

  elements.outputTableHead.innerHTML = "";
  elements.outputTableBody.innerHTML = "";

  const headRow = document.createElement("tr");
  columns.forEach((column) => {
    const cell = document.createElement("th");
    cell.textContent = column;
    headRow.append(cell);
  });
  elements.outputTableHead.append(headRow);

  rows.slice(-250).forEach((row) => {
    const tableRow = document.createElement("tr");
    columns.forEach((column) => {
      const cell = document.createElement("td");
      const content = document.createElement("div");
      content.className = "output-cell-content";
      content.textContent = stringifyCell(row[column]);
      cell.append(content);
      tableRow.append(cell);
    });
    elements.outputTableBody.append(tableRow);
  });

  elements.outputRaw.textContent = JSON.stringify(rows, null, 2);
}

function openEditorSearch({ seedFromSelection = false } = {}) {
  state.editorSearch.visible = true;

  const selectedText = aceEditor.getSelectedText();
  if (seedFromSelection && selectedText && !selectedText.includes("\n")) {
    state.editorSearch.query = selectedText;
  }

  renderEditorSearch();
  refreshEditorSearchStatus();

  requestAnimationFrame(() => {
    elements.editorSearchInput.focus();
    elements.editorSearchInput.select();
  });
}

function closeEditorSearch() {
  state.editorSearch.visible = false;
  state.editorSearch.error = "";
  renderEditorSearch();
}

function navigateEditorSearch(backwards) {
  runEditorSearch({
    backwards: Boolean(backwards),
    skipCurrent: true
  });
}

function runEditorSearch({ backwards = false, skipCurrent = false } = {}) {
  state.editorSearch.query = elements.editorSearchInput.value;

  if (!state.editorSearch.query) {
    state.editorSearch.matches = [];
    state.editorSearch.activeMatchIndex = -1;
    state.editorSearch.error = "";
    renderEditorSearch();
    return;
  }

  try {
    const search = createEditorSearchEngine({
      backwards,
      skipCurrent
    });
    const matches = search.findAll(aceEditor.session).map(normalizeRange);
    const nextMatch = search.find(aceEditor.session);

    if (nextMatch) {
      aceEditor.selection.setRange(nextMatch, false);
      aceEditor.renderer.scrollSelectionIntoView(aceEditor.selection.anchor, aceEditor.selection.lead);
    }

    updateEditorSearchResults(matches, nextMatch || aceEditor.getSelectionRange());
  } catch (error) {
    state.editorSearch.matches = [];
    state.editorSearch.activeMatchIndex = -1;
    state.editorSearch.error = state.editorSearch.regExp ? "Invalid regex" : "Search failed";
    renderEditorSearch();
  }
}

function refreshEditorSearchStatus() {
  if (!state.editorSearch.query) {
    state.editorSearch.matches = [];
    state.editorSearch.activeMatchIndex = -1;
    state.editorSearch.error = "";
    renderEditorSearch();
    return;
  }

  try {
    const matches = createEditorSearchEngine()
      .findAll(aceEditor.session)
      .map(normalizeRange);
    updateEditorSearchResults(matches, aceEditor.getSelectionRange());
  } catch (error) {
    state.editorSearch.matches = [];
    state.editorSearch.activeMatchIndex = -1;
    state.editorSearch.error = state.editorSearch.regExp ? "Invalid regex" : "Search failed";
    renderEditorSearch();
  }
}

function createEditorSearchEngine(overrides = {}) {
  const search = new AceSearch();
  search.set(createSearchOptions({
    query: state.editorSearch.query,
    caseSensitive: state.editorSearch.caseSensitive,
    wholeWord: state.editorSearch.wholeWord,
    regExp: state.editorSearch.regExp,
    currentRange: aceEditor.getSelectionRange(),
    ...overrides
  }));
  return search;
}

function updateEditorSearchResults(matches, activeRange) {
  state.editorSearch.matches = matches;
  state.editorSearch.activeMatchIndex = findActiveMatchIndex(matches, activeRange);
  state.editorSearch.error = "";
  renderEditorSearch();
}

function setEditorSearchToggleState(button, isActive) {
  button.classList.toggle("is-active", isActive);
  button.setAttribute("aria-pressed", String(isActive));
}

function renderSelectorRows() {
  normalizeSelectorRows();
  elements.selectorTableBody.innerHTML = "";

  state.selectorRows.forEach((row, index) => {
    const tableRow = document.createElement("tr");
    tableRow.innerHTML = `
      <td><input data-field="name" data-index="${index}" value="${escapeHtml(row.name)}" /></td>
      <td><input data-field="selector" data-index="${index}" value="${escapeHtml(row.selector)}" /></td>
    `;
    elements.selectorTableBody.append(tableRow);
  });

  elements.selectorTableBody.querySelectorAll("input").forEach((input) => {
    input.addEventListener("input", () => {
      const index = Number(input.dataset.index);
      const field = input.dataset.field;
      state.selectorRows[index][field] = input.value;
      if (index === state.selectorRows.length - 1 && (state.selectorRows[index].name || state.selectorRows[index].selector)) {
        state.selectorRows.push({ name: "", selector: "" });
        renderSelectorRows();
        const nextInput = elements.selectorTableBody.querySelector(`input[data-index="${index}"][data-field="${field}"]`);
        nextInput?.focus();
        nextInput?.setSelectionRange(input.value.length, input.value.length);
        return;
      }
      renderSelectorCode();
      scheduleSelectorPreview();
    });

    input.addEventListener("change", () => {
      normalizeSelectorRows();
      renderSelectorRows();
      scheduleSelectorPreview();
    });
  });

  renderSelectorCode();
}

function renderSelectorCode() {
  elements.selectorCodeOutput.value = buildSelectorCode(collectSelectorRows());
}

function renderSelectorPreview(preview) {
  const headers = preview.headers || [];
  const rows = preview.rows || [];

  elements.selectorPreviewHead.innerHTML = "";
  elements.selectorPreviewBody.innerHTML = "";

  if (!headers.length && !rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.textContent = "No selector preview data yet.";
    row.append(cell);
    elements.selectorPreviewBody.append(row);
    return;
  }

  const headRow = document.createElement("tr");
  headers.forEach((header) => {
    const cell = document.createElement("th");
    cell.textContent = header;
    headRow.append(cell);
  });
  elements.selectorPreviewHead.append(headRow);

  rows.forEach((rowValues) => {
    const tableRow = document.createElement("tr");
    rowValues.forEach((value) => {
      const cell = document.createElement("td");
      cell.textContent = stringifyCell(value);
      tableRow.append(cell);
    });
    elements.selectorPreviewBody.append(tableRow);
  });

  if (preview.code) {
    elements.selectorCodeOutput.value = preview.code;
  }
}

function renderResumePreview() {
  const snapshot = state.lastSnapshotPreview;

  if (!snapshot) {
    elements.resumePreviewOutput.textContent = "Preview of run will be here";
    elements.resumeButton.disabled = true;
    return;
  }

  elements.resumePreviewOutput.textContent = JSON.stringify(snapshot, null, 2);
  elements.resumeButton.disabled = snapshot.resumable === false;
}

function collectDraft() {
  // Prefer the id of the currently-loaded robot so that renaming updates the
  // existing robot instead of creating a new one. Fall back to a name match
  // only when no robot is loaded.
  const loadedId = state.draft?.selectedRobotId || "";
  const matchedByName = syncRobotSelectionFromInput();
  const robotId = loadedId || matchedByName?.id || "";

  // Keep the hidden select in sync with the loaded id.
  elements.robotSelect.value = robotId;

  return {
    id: robotId,
    robotId,
    selectedRobotId: robotId,
    name: elements.robotNameInput.value.trim(),
    url: elements.urlInput.value.trim(),
    tag: elements.tagInput.value.trim(),
    code: aceEditor.getValue(),
    config: state.draft?.config || {}
  };
}

function scheduleDraftPersist() {
  clearTimeout(persistDraftTimer);
  persistDraftTimer = setTimeout(() => {
    void persistDraft();
  }, 150);
}

async function persistDraft() {
  clearTimeout(persistDraftTimer);
  const response = await sendMessage({
    type: "SAVE_DRAFT",
    draft: collectDraft()
  });

  if (response.ok) {
    state.draft = response.draft;
  }
}

function scheduleSelectorPreview() {
  clearTimeout(selectorPreviewTimer);
  if (state.activeTab !== "seltab") {
    return;
  }

  selectorPreviewTimer = setTimeout(() => {
    void previewSelectors();
  }, SELECTOR_PREVIEW_DEBOUNCE_MS);
}

async function previewSelectors() {
  const selectors = collectSelectorRows();
  const response = await sendMessage({
    type: "PREVIEW_SELECTORS",
    preview: {
      selectors
    }
  });

  if (!response.ok) {
    renderSelectorPreview({
      headers: ["Error"],
      rows: [[response.error || "Preview failed."]],
      code: buildSelectorCode(selectors)
    });
    return;
  }

  renderSelectorPreview({
    ...(response.preview || { headers: [], rows: [] }),
    code: buildSelectorCode(selectors)
  });
}

function collectSelectorRows() {
  return state.selectorRows.filter((row) => row.name || row.selector);
}

function normalizeSelectorRows() {
  const populatedRows = state.selectorRows.filter((row) => row.name || row.selector);
  state.selectorRows = [...populatedRows, { name: "", selector: "" }];
}

function buildSelectorCode(rows) {
  if (!rows.length) {
    return "";
  }

  const hasRowSelector = rows[0].name === "row";
  const lines = ["var row = {};"];

  rows.forEach((row, index) => {
    if (index === 0 && hasRowSelector) {
      return;
    }

    if (!row.selector) {
      return;
    }

    if (isSelectorExpression(row.selector)) {
      lines.push(`row["${row.name}"] = ${row.selector.replace(/;$/, "")};`);
    } else {
      const scope = hasRowSelector ? ", row" : "";
      lines.push(`row["${row.name}"] = $("${row.selector}"${scope}).text().trim();`);
    }
  });

  if (hasRowSelector) {
    return [
      "var rows = [];",
      `$("${rows[0].selector}").each(function(index, row) {`,
      ...lines.map((line) => `  ${line}`),
      "  rows.push(row);",
      "});"
    ].join("\n");
  }

  return lines.join("\n");
}

function getSelectedTableRows() {
  const tables = state.selectedRun?.outputTables || {};
  return tables[state.selectedTable] || [];
}

function syncSelectedTable() {
  const tables = state.selectedRun?.outputTables || {};

  if (state.selectedTable && tables[state.selectedTable]) {
    return;
  }

  const [firstTable] = Object.keys(tables);
  state.selectedTable = firstTable || "";
}

async function selectRun(runId, runDetails = null) {
  state.selectedRunId = runId || null;

  if (runDetails) {
    state.selectedRun = runDetails;
    syncSelectedTable();
    render();
  }

  const response = await sendMessage({
    type: "SELECT_RUN",
    runId
  });

  if (response.ok && response.state) {
    applyIncomingState(response.state, {
      fullRender: true
    });
  }
}

function selectedTableName() {
  return state.selectedTable || "output";
}

function setActiveTab(name) {
  state.activeTab = name;

  elements.tabs.forEach((tab) => {
    const isActive = tab.dataset.tabTarget === name;
    tab.parentElement.classList.toggle("active", isActive);
  });

  Object.entries(elements.panels).forEach(([panelName, panel]) => {
    panel.classList.toggle("active", panelName === name);
  });

  if (name === "code") {
    resizeEditor();
  }

  if (name === "logtab") {
    renderLogs();
  }

  if (name === "output") {
    renderOutput();
  }

  if (name === "seltab") {
    scheduleSelectorPreview();
  }
}

function syncRobotSelectionFromInput() {
  const inputName = elements.robotNameInput.value.trim().toLowerCase();
  const match = state.robots.find((robot) => robot.name.trim().toLowerCase() === inputName) || null;
  elements.robotSelect.value = match?.id || "";
  return match;
}

function resizeEditor() {
  const top = elements.editorHost.getBoundingClientRect().top;
  const nextHeight = Math.max(320, window.innerHeight - top - 24);
  elements.editorHost.style.height = `${nextHeight}px`;
  aceEditor.resize();
}

function formatDuration(startedAt, finishedAt) {
  const start = startedAt ? new Date(startedAt).getTime() : Date.now();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const totalSeconds = Math.max(0, Math.floor((end - start) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toCsv(rows) {
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const lines = [columns.join(",")];

  rows.forEach((row) => {
    lines.push(columns.map((column) => csvCell(row[column])).join(","));
  });

  return lines.join("\n");
}

function csvCell(value) {
  const cell = stringifyCell(value).replaceAll("\"", "\"\"");
  return `"${cell}"`;
}

function stringifyCell(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isSelectorExpression(selector) {
  const value = String(selector || "").trim();
  return value.includes("$") || value.startsWith("row.") || value.startsWith("document.") || value.startsWith("window.");
}

async function refreshRobotsFromPortal() {
  if (isRefreshingRobots) {
    return;
  }

  isRefreshingRobots = true;
  elements.refreshRobotsButton.disabled = true;
  elements.refreshRobotsButton.textContent = "Refreshing...";
  setPortalRefreshMessage("Checking portal for the latest robots...");

  const response = await sendMessage({ type: "REFRESH_PORTAL_ROBOTS" });

  isRefreshingRobots = false;
  elements.refreshRobotsButton.disabled = false;
  elements.refreshRobotsButton.textContent = "Refresh robots";

  if (!response.ok) {
    setPortalRefreshMessage(response.error || "Could not refresh robots.");
    return;
  }

  if (response.state) {
    applyIncomingState(response.state, {
      fullRender: true
    });
  }

  setPortalRefreshMessage(`Robots refreshed at ${formatRefreshTime(new Date())}.`);
}

function setPortalRefreshMessage(message) {
  elements.portalRefreshStatus.textContent = message || "";
}

function formatRefreshTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

async function sendMessage(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
