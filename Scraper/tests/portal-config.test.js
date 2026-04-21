"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadPortalConfig() {
  const sourcePath = path.join(__dirname, "..", "shared", "portal-config.js");
  const source = fs.readFileSync(sourcePath, "utf8")
    .replaceAll("export const ", "const ")
    .replaceAll("export async function ", "async function ")
    .replaceAll("export function ", "function ")
    .concat("\nmodule.exports = { DEFAULT_PORTAL_ORIGIN, normalizePortalOrigin };\n");

  const context = {
    URL,
    chrome: undefined,
    module: { exports: {} },
    exports: {}
  };

  vm.runInNewContext(source, context, { filename: sourcePath });
  return context.module.exports;
}

test("normalizePortalOrigin keeps remote http/https portal URLs and strips query/hash noise", async () => {
  const {
    normalizePortalOrigin
  } = loadPortalConfig();

  assert.equal(
    normalizePortalOrigin(" https://portal.example.com/scraper/?tab=robots#login "),
    "https://portal.example.com/scraper"
  );
});

test("normalizePortalOrigin falls back to the default portal for invalid values", async () => {
  const {
    DEFAULT_PORTAL_ORIGIN,
    normalizePortalOrigin
  } = loadPortalConfig();

  assert.equal(normalizePortalOrigin(""), DEFAULT_PORTAL_ORIGIN);
  assert.equal(normalizePortalOrigin("ftp://portal.example.com"), DEFAULT_PORTAL_ORIGIN);
  assert.equal(normalizePortalOrigin("not a url"), DEFAULT_PORTAL_ORIGIN);
});
