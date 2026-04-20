"use strict";

(function initializeIdeUiTransportHelpers(root, factory) {
  const helpers = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }

  root.ideUiTransportHelpers = helpers;
})(typeof globalThis !== "undefined" ? globalThis : this, function createIdeUiTransportHelpers() {
  const DEFAULT_RECONNECT_BASE_DELAY_MS = 500;
  const DEFAULT_RECONNECT_MAX_DELAY_MS = 4_000;
  const DEFAULT_STALE_SYNC_MS = 8_000;

  function calculateReconnectDelay(
    attempt,
    baseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS
  ) {
    const safeAttempt = Math.max(1, Number(attempt) || 1);
    const exponent = Math.max(0, safeAttempt - 1);
    return Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
  }

  function shouldWatchForLiveUpdates(state) {
    if (state?.selectedRun?.status === "RUNNING") {
      return true;
    }

    return Array.isArray(state?.runs)
      && state.runs.some((run) => run?.status === "RUNNING");
  }

  function createUiTransport({
    connectPort,
    syncState,
    applyState,
    onStatusChange = () => {},
    setTimer = (handler, delayMs) => setTimeout(handler, delayMs),
    clearTimer = (timerId) => clearTimeout(timerId),
    now = () => Date.now(),
    reconnectBaseDelayMs = DEFAULT_RECONNECT_BASE_DELAY_MS,
    reconnectMaxDelayMs = DEFAULT_RECONNECT_MAX_DELAY_MS,
    staleSyncMs = DEFAULT_STALE_SYNC_MS
  } = {}) {
    if (typeof connectPort !== "function") {
      throw new Error("connectPort is required.");
    }

    if (typeof syncState !== "function") {
      throw new Error("syncState is required.");
    }

    if (typeof applyState !== "function") {
      throw new Error("applyState is required.");
    }

    let port = null;
    let reconnectAttempt = 0;
    let reconnectTimer = null;
    let staleTimer = null;
    let disposed = false;
    let lastStateAt = 0;
    let watchingLiveUpdates = false;

    function emitStatus(status) {
      onStatusChange(status);
    }

    function clearReconnectTimer() {
      if (!reconnectTimer) {
        return;
      }

      clearTimer(reconnectTimer);
      reconnectTimer = null;
    }

    function clearStaleTimer() {
      if (!staleTimer) {
        return;
      }

      clearTimer(staleTimer);
      staleTimer = null;
    }

    function detachPort(listeningPort = port) {
      if (!listeningPort) {
        return;
      }

      try {
        listeningPort.onMessage?.removeListener(handlePortMessage);
      } catch (error) {
        // Removing listeners is best-effort for browser message ports.
      }

      try {
        listeningPort.onDisconnect?.removeListener(handlePortDisconnect);
      } catch (error) {
        // Removing listeners is best-effort for browser message ports.
      }

      if (listeningPort === port) {
        port = null;
      }
    }

    function scheduleStaleSync() {
      clearStaleTimer();

      if (disposed || !watchingLiveUpdates) {
        return;
      }

      staleTimer = setTimer(async () => {
        staleTimer = null;

        if (disposed || !watchingLiveUpdates) {
          return;
        }

        const millisSinceLastState = now() - lastStateAt;
        if (millisSinceLastState < staleSyncMs) {
          scheduleStaleSync();
          return;
        }

        emitStatus({
          type: "stale-sync",
          reason: "watchdog",
          millisSinceLastState
        });

        const synced = await syncNow("watchdog");
        if (!synced) {
          scheduleReconnect("watchdog-sync-failed");
          return;
        }

        scheduleStaleSync();
      }, staleSyncMs);
    }

    function handleIncomingState(state, meta = {}) {
      lastStateAt = now();
      watchingLiveUpdates = shouldWatchForLiveUpdates(state);
      reconnectAttempt = 0;
      applyState(state, meta);
      scheduleStaleSync();
    }

    async function syncNow(reason = "manual") {
      if (disposed) {
        return false;
      }

      emitStatus({ type: "syncing", reason });

      try {
        const state = await syncState(reason);
        if (!state) {
          return false;
        }

        handleIncomingState(state, {
          source: "pull",
          reason
        });
        return true;
      } catch (error) {
        emitStatus({
          type: "sync-error",
          reason,
          error
        });
        return false;
      }
    }

    function scheduleReconnect(reason = "disconnect") {
      if (disposed || reconnectTimer) {
        return;
      }

      reconnectAttempt += 1;
      const delayMs = calculateReconnectDelay(
        reconnectAttempt,
        reconnectBaseDelayMs,
        reconnectMaxDelayMs
      );

      emitStatus({
        type: "reconnect-scheduled",
        reason,
        attempt: reconnectAttempt,
        delayMs
      });

      reconnectTimer = setTimer(() => {
        reconnectTimer = null;
        void connect(reason);
      }, delayMs);
    }

    function handlePortMessage(message) {
      if (message?.type !== "STATE_UPDATED") {
        return;
      }

      handleIncomingState(message.state, {
        source: "push"
      });
    }

    function handlePortDisconnect() {
      detachPort();
      clearStaleTimer();

      if (disposed) {
        return;
      }

      emitStatus({ type: "disconnected" });
      scheduleReconnect("disconnect");
    }

    async function connect(reason = "start") {
      if (disposed) {
        return false;
      }

      clearReconnectTimer();
      clearStaleTimer();
      const previousPort = port;
      detachPort(previousPort);

      try {
        previousPort?.disconnect?.();
      } catch (error) {
        // Ignore disconnect failures while replacing an existing port.
      }

      let nextPort = null;

      try {
        nextPort = connectPort();
      } catch (error) {
        emitStatus({
          type: "connect-error",
          reason,
          error
        });
        scheduleReconnect("connect-error");
        return false;
      }

      port = nextPort;
      port.onMessage?.addListener(handlePortMessage);
      port.onDisconnect?.addListener(handlePortDisconnect);

      emitStatus({
        type: "connected",
        reason
      });

      const synced = await syncNow(reason);
      if (!synced) {
        scheduleReconnect("initial-sync-failed");
      }

      return synced;
    }

    async function start() {
      disposed = false;
      return connect("start");
    }

    function stop() {
      disposed = true;
      clearReconnectTimer();
      clearStaleTimer();

      const activePort = port;
      detachPort(activePort);

      try {
        activePort?.disconnect?.();
      } catch (error) {
        // Ignore disconnect failures during page teardown.
      }
    }

    return {
      start,
      stop,
      syncNow
    };
  }

  return {
    calculateReconnectDelay,
    createUiTransport,
    shouldWatchForLiveUpdates
  };
});
