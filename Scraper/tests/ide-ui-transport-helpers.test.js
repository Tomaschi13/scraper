"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateReconnectDelay,
  createUiTransport,
  shouldWatchForLiveUpdates
} = require("../ide/ui-transport-helpers.js");

function createFakeEvent() {
  const listeners = new Set();

  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of Array.from(listeners)) {
        listener(...args);
      }
    }
  };
}

function createFakePort() {
  return {
    onMessage: createFakeEvent(),
    onDisconnect: createFakeEvent(),
    disconnect() {}
  };
}

function createFakeClock() {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();

  return {
    now: () => now,
    setTimer(handler, delayMs) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, {
        handler,
        runAt: now + Number(delayMs || 0)
      });
      return timerId;
    },
    clearTimer(timerId) {
      timers.delete(timerId);
    },
    async advance(delayMs) {
      now += Number(delayMs || 0);

      while (true) {
        const dueTimers = Array.from(timers.entries())
          .filter(([, timer]) => timer.runAt <= now)
          .sort((left, right) => left[1].runAt - right[1].runAt);

        if (!dueTimers.length) {
          break;
        }

        for (const [timerId, timer] of dueTimers) {
          timers.delete(timerId);
          const result = timer.handler();
          if (result && typeof result.then === "function") {
            await result;
          }
          await Promise.resolve();
        }
      }
    }
  };
}

test("calculateReconnectDelay backs off and caps at the configured maximum", () => {
  assert.equal(calculateReconnectDelay(1), 500);
  assert.equal(calculateReconnectDelay(2), 1000);
  assert.equal(calculateReconnectDelay(5), 4000);
});

test("shouldWatchForLiveUpdates tracks running work from the selected run or run list", () => {
  assert.equal(shouldWatchForLiveUpdates({
    selectedRun: { status: "RUNNING" },
    runs: []
  }), true);
  assert.equal(shouldWatchForLiveUpdates({
    selectedRun: { status: "FINISHED" },
    runs: [{ status: "RUNNING" }]
  }), true);
  assert.equal(shouldWatchForLiveUpdates({
    selectedRun: { status: "FINISHED" },
    runs: [{ status: "FAILED" }]
  }), false);
});

test("createUiTransport reconnects and re-syncs after the port disconnects", async () => {
  const clock = createFakeClock();
  const ports = [];
  const syncReasons = [];
  const applied = [];

  const transport = createUiTransport({
    connectPort() {
      const port = createFakePort();
      ports.push(port);
      return port;
    },
    async syncState(reason) {
      syncReasons.push(reason);
      return {
        selectedRun: null,
        runs: []
      };
    },
    applyState(state, meta) {
      applied.push({ state, meta });
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now
  });

  assert.equal(await transport.start(), true);
  assert.equal(ports.length, 1);
  assert.deepEqual(syncReasons, ["start"]);
  assert.equal(applied.length, 1);

  ports[0].onDisconnect.emit();
  await clock.advance(499);
  assert.equal(ports.length, 1);

  await clock.advance(1);
  await Promise.resolve();
  assert.equal(ports.length, 2);
  assert.deepEqual(syncReasons, ["start", "disconnect"]);
  assert.equal(applied.length, 2);

  transport.stop();
});

test("createUiTransport triggers a watchdog re-sync while a run is live", async () => {
  const clock = createFakeClock();
  const syncReasons = [];
  const applied = [];

  const transport = createUiTransport({
    connectPort() {
      return createFakePort();
    },
    async syncState(reason) {
      syncReasons.push(reason);
      return {
        selectedRun: {
          id: "run_live",
          status: "RUNNING"
        },
        runs: [{ id: "run_live", status: "RUNNING" }]
      };
    },
    applyState(state, meta) {
      applied.push(meta.source);
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    now: clock.now,
    staleSyncMs: 100
  });

  assert.equal(await transport.start(), true);
  assert.deepEqual(syncReasons, ["start"]);

  await clock.advance(99);
  assert.deepEqual(syncReasons, ["start"]);

  await clock.advance(1);
  await Promise.resolve();
  assert.deepEqual(syncReasons, ["start", "watchdog"]);
  assert.deepEqual(applied, ["pull", "pull"]);

  transport.stop();
});
