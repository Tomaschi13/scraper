"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createSearchOptions,
  findActiveMatchIndex,
  formatSearchStatus,
  normalizeRange,
  rangesEqual
} = require("../ide/search-helpers.js");

test("createSearchOptions builds Ace-compatible search flags", () => {
  const currentRange = {
    start: { row: 2, column: 4 },
    end: { row: 2, column: 9 }
  };

  assert.deepEqual(createSearchOptions({
    query: "needle",
    caseSensitive: true,
    wholeWord: true,
    regExp: true,
    currentRange,
    backwards: true,
    skipCurrent: true
  }), {
    needle: "needle",
    caseSensitive: true,
    wholeWord: true,
    regExp: true,
    wrap: true,
    backwards: true,
    skipCurrent: true,
    start: currentRange
  });
});

test("rangesEqual and normalizeRange compare row and column values only", () => {
  const left = normalizeRange({
    start: { row: "1", column: "3" },
    end: { row: "1", column: "8" }
  });
  const right = {
    start: { row: 1, column: 3 },
    end: { row: 1, column: 8 }
  };

  assert.deepEqual(left, right);
  assert.equal(rangesEqual(left, right), true);
});

test("findActiveMatchIndex returns the current result position when the range matches", () => {
  const matches = [
    {
      start: { row: 0, column: 0 },
      end: { row: 0, column: 4 }
    },
    {
      start: { row: 3, column: 2 },
      end: { row: 3, column: 6 }
    }
  ];

  assert.equal(findActiveMatchIndex(matches, {
    start: { row: 3, column: 2 },
    end: { row: 3, column: 6 }
  }), 1);

  assert.equal(findActiveMatchIndex(matches, {
    start: { row: 4, column: 0 },
    end: { row: 4, column: 3 }
  }), -1);
});

test("formatSearchStatus reports empty, success, no-result, and error states", () => {
  assert.equal(formatSearchStatus({ query: "" }), "");
  assert.equal(formatSearchStatus({ query: "robot", totalMatches: 0 }), "No results");
  assert.equal(formatSearchStatus({
    query: "robot",
    totalMatches: 7,
    activeMatchIndex: -1
  }), "7 results");
  assert.equal(formatSearchStatus({
    query: "robot",
    totalMatches: 7,
    activeMatchIndex: 2
  }), "3 of 7");
  assert.equal(formatSearchStatus({
    query: "robot",
    totalMatches: 7,
    activeMatchIndex: -1,
    error: "Invalid regex"
  }), "Invalid regex");
});
