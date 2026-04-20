"use strict";

(function initializeIdeSearchHelpers(root, factory) {
  const helpers = factory();

  if (typeof module !== "undefined" && module.exports) {
    module.exports = helpers;
  }

  root.ideSearchHelpers = helpers;
})(typeof globalThis !== "undefined" ? globalThis : this, function createIdeSearchHelpers() {
  function createSearchOptions({
    query = "",
    caseSensitive = false,
    wholeWord = false,
    regExp = false,
    currentRange = null,
    backwards = false,
    skipCurrent = false
  } = {}) {
    return {
      needle: String(query || ""),
      caseSensitive: Boolean(caseSensitive),
      wholeWord: Boolean(wholeWord),
      regExp: Boolean(regExp),
      wrap: true,
      backwards: Boolean(backwards),
      skipCurrent: Boolean(skipCurrent),
      start: currentRange || undefined
    };
  }

  function normalizeRange(range) {
    if (!range || !range.start || !range.end) {
      return null;
    }

    return {
      start: {
        row: Number(range.start.row),
        column: Number(range.start.column)
      },
      end: {
        row: Number(range.end.row),
        column: Number(range.end.column)
      }
    };
  }

  function samePoint(left, right) {
    return Boolean(left && right)
      && left.row === right.row
      && left.column === right.column;
  }

  function rangesEqual(left, right) {
    const normalizedLeft = normalizeRange(left);
    const normalizedRight = normalizeRange(right);

    if (!normalizedLeft || !normalizedRight) {
      return false;
    }

    return samePoint(normalizedLeft.start, normalizedRight.start)
      && samePoint(normalizedLeft.end, normalizedRight.end);
  }

  function findActiveMatchIndex(matches, range) {
    const currentRange = normalizeRange(range);

    if (!currentRange) {
      return -1;
    }

    return matches.findIndex((match) => rangesEqual(match, currentRange));
  }

  function formatSearchStatus({
    query = "",
    totalMatches = 0,
    activeMatchIndex = -1,
    error = ""
  } = {}) {
    if (error) {
      return error;
    }

    if (!query) {
      return "";
    }

    if (!totalMatches) {
      return "No results";
    }

    if (activeMatchIndex < 0) {
      return `${totalMatches} results`;
    }

    const nextIndex = Math.min(activeMatchIndex + 1, totalMatches);

    return `${nextIndex} of ${totalMatches}`;
  }

  return {
    createSearchOptions,
    findActiveMatchIndex,
    formatSearchStatus,
    normalizeRange,
    rangesEqual
  };
});
