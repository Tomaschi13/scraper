"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const router = require("../background/content-message-router.js");

function makeServicesSpy() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return undefined;
  };
  return {
    calls,
    services: {
      logFromTab: record("logFromTab"),
      queueStepsFromRuntime: record("queueStepsFromRuntime"),
      emitRowsFromRuntime: record("emitRowsFromRuntime"),
      completeStep: record("completeStep"),
      failCurrentStep: record("failCurrentStep"),
      clearRunQueue: record("clearRunQueue"),
      setRetries: record("setRetries"),
      setUserAgent: record("setUserAgent"),
      updateRunConfig: record("updateRunConfig"),
      setProxyDirect: record("setProxyDirect"),
      setProxyFromPortalTag: record("setProxyFromPortalTag"),
      resetProxySettings: record("resetProxySettings"),
      setImagesAllowed: record("setImagesAllowed"),
      setServerImagesAllowed: record("setServerImagesAllowed"),
      clearCookies: record("clearCookies"),
      clearBrowsingData: record("clearBrowsingData"),
      onRuntimeReady: record("onRuntimeReady"),
      stopRunByTab: record("stopRunByTab")
    }
  };
}

const sender = { tab: { id: 42, url: "https://example.com/page", title: "Example Page" } };

test("isLegacyPayload detects single method objects and method-bearing arrays", () => {
  assert.equal(router.isLegacyPayload({ method: "next", url: "x" }), true);
  assert.equal(router.isLegacyPayload([{ method: "emit", table: "t", rows: [] }]), true);
  assert.equal(router.isLegacyPayload([]), false);
  assert.equal(router.isLegacyPayload({ type: "GET_STATE" }), false);
  assert.equal(router.isLegacyPayload(null), false);
  assert.equal(router.isLegacyPayload("string"), false);
});

test("normalizeLegacyPayload drops invalid array entries and wraps single objects", () => {
  assert.deepEqual(router.normalizeLegacyPayload([{ method: "done" }, null, { method: "done" }]), [
    { method: "done" },
    { method: "done" }
  ]);
  assert.deepEqual(router.normalizeLegacyPayload({ method: "emit", table: "t", rows: [] }), [
    { method: "emit", table: "t", rows: [] }
  ]);
  assert.deepEqual(router.normalizeLegacyPayload({ type: "not-legacy" }), []);
});

test("dispatch next routes single step to queueStepsFromRuntime with correct defaults", async () => {
  const spy = makeServicesSpy();
  const response = await router.dispatchLegacyMethod(
    { method: "next", url: "https://foo/", step: "detail", params: { x: 1 } },
    spy.services,
    sender
  );
  assert.equal(response.ok, true);
  assert.deepEqual(spy.calls, [
    {
      name: "queueStepsFromRuntime",
      args: [42, [{ url: "https://foo/", step: "detail", params: { x: 1 }, gofast: false }]]
    }
  ]);
});

test("dispatch next preserves gofast and defaults missing fields", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "next", url: "https://foo/", gofast: true },
    spy.services,
    sender
  );
  assert.deepEqual(spy.calls[0].args[1], [{ url: "https://foo/", step: "start", params: null, gofast: true }]);
});

test("dispatch handleLegacyPayload queues batched next arrays in one runtime call", async () => {
  const spy = makeServicesSpy();
  const responses = await router.handleLegacyPayload([
    { method: "next", url: "https://a/", step: "s1" },
    { method: "next", url: "https://b/", step: "s2" }
  ], spy.services, sender);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].ok, true);
  assert.deepEqual(spy.calls, [{
    name: "queueStepsFromRuntime",
    args: [42, [
      { url: "https://a/", step: "s1", params: null, gofast: false },
      { url: "https://b/", step: "s2", params: null, gofast: false }
    ]]
  }]);
});

test("dispatch fork queues a single non-gofast step", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "fork", url: "https://x/", step: "child", params: [1, 2] },
    spy.services,
    sender
  );
  assert.deepEqual(spy.calls[0].args[1], [{ url: "https://x/", step: "child", params: [1, 2], gofast: false }]);
});

test("dispatch emit family all route to emitRowsFromRuntime with the shared table+rows shape", async () => {
  for (const method of ["emit", "emitKinesis", "emitBQ", "emitS3", "emitfb"]) {
    const spy = makeServicesSpy();
    await router.dispatchLegacyMethod(
      { method, table: "products", rows: [{ name: "A" }, { name: "B" }], bqTable: method === "emitBQ" ? "bq.table" : undefined },
      spy.services,
      sender
    );
    const emitCall = spy.calls.find((call) => call.name === "emitRowsFromRuntime");
    assert.ok(emitCall, `${method} should call emitRowsFromRuntime`);
    assert.equal(emitCall.args[0], 42);
    assert.equal(emitCall.args[1], "products");
    assert.deepEqual(emitCall.args[2], [{ name: "A" }, { name: "B" }]);
  }
});

test("dispatch emitBQ logs the bqTable target as a debug line", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "emitBQ", table: "t", rows: [{}], bqTable: "my.bq.table" },
    spy.services,
    sender
  );
  const logCall = spy.calls.find((call) => call.name === "logFromTab" && String(call.args[1]).includes("my.bq.table"));
  assert.ok(logCall);
});

test("dispatch emitDbg forwards to logFromTab with the supplied level", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "emitDbg", msg: "hello", level: "WARN" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "logFromTab", args: [42, "hello", "WARN"] });
});

test("dispatch done routes to completeStep with the sender tab URL and title", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "done" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "completeStep", args: [42, "https://example.com/page", "Example Page"] });
});

test("dispatch domReady routes to onRuntimeReady with tab + pageUrl", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "domReady" }, spy.services, sender);
  assert.equal(spy.calls[0].name, "onRuntimeReady");
  assert.equal(spy.calls[0].args[0], sender.tab);
});

test("dispatch setRetries maps the legacy {interval,...} shape to the SW's {intervalMs,...} shape", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "setRetries", interval: 30000, maxStep: 5, maxRun: 100 },
    spy.services,
    sender
  );
  assert.deepEqual(spy.calls[0], {
    name: "setRetries",
    args: [42, { intervalMs: 30000, maxStep: 5, maxRun: 100 }]
  });
});

test("dispatch clearQue triggers clearRunQueue", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "clearQue" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "clearRunQueue", args: [42] });
});

test("dispatch setUA forwards the UAstring field to setUserAgent", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "setUA", UAstring: "Mozilla/X" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "setUserAgent", args: [42, "Mozilla/X"] });
});

test("dispatch setSettings passes the settings blob to updateRunConfig", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "setSettings", settings: { skipVisited: true } }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "updateRunConfig", args: [42, { skipVisited: true }] });
});

test("dispatch setProxy routes server/port/bypass to setProxyDirect", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "setProxy", server: "1.2.3.4", port: 8080, bypass: ["localhost"] },
    spy.services,
    sender
  );
  assert.deepEqual(spy.calls[0], {
    name: "setProxyDirect",
    args: [
      {
        server: "1.2.3.4",
        port: 8080,
        bypass: ["localhost"],
        username: undefined,
        password: undefined,
        scheme: undefined
      },
      42
    ]
  });
});

test("dispatch setProxy2 applies object proxy parameters", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "setProxy2", parameters: { server: "1.2.3.4", port: 8080, username: "u" } },
    spy.services,
    sender
  );
  assert.deepEqual(spy.calls[0], {
    name: "setProxyDirect",
    args: [{ server: "1.2.3.4", port: 8080, username: "u" }, 42]
  });
});

test("dispatch setProxyPortal resolves proxy by portal tag", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "setProxyPortal", tag: "my-tag" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], {
    name: "setProxyFromPortalTag",
    args: ["my-tag", 42]
  });
});

test("dispatch resetProxy calls resetProxySettings", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "resetProxy" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "resetProxySettings", args: [42] });
});

test("dispatch clearCookies and clearBrowsingData forward their payloads", async () => {
  const spyA = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "clearCookies", domain: "example.com" }, spyA.services, sender);
  assert.deepEqual(spyA.calls[0], { name: "clearCookies", args: ["example.com"] });

  const spyB = makeServicesSpy();
  await router.dispatchLegacyMethod(
    { method: "clearBrowsingData", origins: ["https://a/"], settings: { cookies: true } },
    spyB.services,
    sender
  );
  assert.deepEqual(spyB.calls[0], {
    name: "clearBrowsingData",
    args: [["https://a/"], { cookies: true }]
  });
});

test("dispatch allowImages and blockImages toggle setImagesAllowed", async () => {
  const spyA = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "allowImages" }, spyA.services, sender);
  assert.deepEqual(spyA.calls[0], { name: "setImagesAllowed", args: [true] });

  const spyB = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "blockImages" }, spyB.services, sender);
  assert.deepEqual(spyB.calls[0], { name: "setImagesAllowed", args: [false] });
});

test("dispatch allowServerImages and blockServerImages toggle server-only image policy", async () => {
  const spyA = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "allowServerImages" }, spyA.services, sender);
  assert.deepEqual(spyA.calls[0], { name: "setServerImagesAllowed", args: [42, true] });

  const spyB = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "blockServerImages" }, spyB.services, sender);
  assert.deepEqual(spyB.calls[0], { name: "setServerImagesAllowed", args: [42, false] });
});

test("dispatch closeSocket is a no-op INFO log", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "closeSocket" }, spy.services, sender);
  assert.equal(spy.calls[0].name, "logFromTab");
  assert.equal(spy.calls[0].args[2], "INFO");
});

test("dispatch stop routes to stopRunByTab", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "stop" }, spy.services, sender);
  assert.deepEqual(spy.calls[0], { name: "stopRunByTab", args: [42] });
});

test("dispatch click logs a debug entry and does not dispatch any action", async () => {
  const spy = makeServicesSpy();
  await router.dispatchLegacyMethod({ method: "click" }, spy.services, sender);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].name, "logFromTab");
  assert.equal(spy.calls[0].args[2], "DEBUG");
});

test("dispatch emitFile, screenshot, and captcha warn but return ok", async () => {
  for (const message of [
    { method: "emitFile", file: "x.pdf", data: "data:..." },
    { method: "screenshot", file: "shot.png" },
    { method: "captcha", coordinates: {}, cbStep: "solve" }
  ]) {
    const spy = makeServicesSpy();
    const response = await router.dispatchLegacyMethod(message, spy.services, sender);
    assert.equal(response.ok, true);
    assert.equal(spy.calls[0].name, "logFromTab");
    assert.equal(spy.calls[0].args[2], "WARN");
  }
});

test("dispatch unknown method logs WARN and returns ok:false with reason", async () => {
  const spy = makeServicesSpy();
  const response = await router.dispatchLegacyMethod({ method: "totallyBogus" }, spy.services, sender);
  assert.equal(response.ok, false);
  assert.match(response.error, /unknown method/);
  assert.equal(spy.calls[0].args[2], "WARN");
});

test("handleLegacyPayload catches per-message throws and records them without short-circuiting the batch", async () => {
  const services = {
    logFromTab() {},
    queueStepsFromRuntime() { throw new Error("boom"); },
    emitRowsFromRuntime() {},
    completeStep() {},
    failCurrentStep() {},
    clearRunQueue() {},
    setRetries() {},
    setUserAgent() {},
    updateRunConfig() {},
    setProxyDirect() {},
    setProxyFromPortalTag() {},
    resetProxySettings() {},
    setImagesAllowed() {},
    setServerImagesAllowed() {},
    clearCookies() {},
    clearBrowsingData() {},
    onRuntimeReady() {},
    stopRunByTab() {}
  };

  const responses = await router.handleLegacyPayload([
    { method: "next", url: "https://x/", step: "s" },
    { method: "clearQue" }
  ], services, sender);

  assert.equal(responses.length, 2);
  assert.equal(responses[0].ok, false);
  assert.match(responses[0].error, /boom/);
  assert.equal(responses[1].ok, true);
});
