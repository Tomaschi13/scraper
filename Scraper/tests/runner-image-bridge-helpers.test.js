"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { notifyRunnerImagesAllowed } = require("../background/runner-image-bridge-helpers.js");

function makeRuntime({ throws = null } = {}) {
  const calls = [];
  return {
    calls,
    runtime: {
      async sendMessage(message) {
        calls.push(message);
        if (throws) {
          throw throws;
        }
        return undefined;
      }
    }
  };
}

test("notifyRunnerImagesAllowed dispatches the change event with the coerced allowed flag", async () => {
  const fake = makeRuntime();
  await notifyRunnerImagesAllowed(fake.runtime, true);

  assert.deepEqual(fake.calls, [{ type: "RUNNER_IMAGES_ALLOWED_CHANGED", allowed: true }]);
});

test("notifyRunnerImagesAllowed coerces truthy/falsy inputs to a boolean", async () => {
  const fake = makeRuntime();
  await notifyRunnerImagesAllowed(fake.runtime, 1);
  await notifyRunnerImagesAllowed(fake.runtime, "");
  await notifyRunnerImagesAllowed(fake.runtime, null);

  assert.deepEqual(fake.calls.map((message) => message.allowed), [true, false, false]);
});

test("notifyRunnerImagesAllowed swallows the no-receiver rejection so callers never see it", async () => {
  const fake = makeRuntime({ throws: new Error("Could not establish connection. Receiving end does not exist.") });

  await assert.doesNotReject(() => notifyRunnerImagesAllowed(fake.runtime, true));
  assert.equal(fake.calls.length, 1);
});

test("notifyRunnerImagesAllowed is a no-op when the runtime or sendMessage is missing", async () => {
  await assert.doesNotReject(() => notifyRunnerImagesAllowed(null, true));
  await assert.doesNotReject(() => notifyRunnerImagesAllowed({}, true));
  await assert.doesNotReject(() => notifyRunnerImagesAllowed({ sendMessage: "not-a-function" }, true));
});
