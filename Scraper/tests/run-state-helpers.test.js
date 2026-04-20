"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compareRunsByRecency,
  findRunById,
  resolveSelectedRunId,
  sortRuns
} = require("../shared/run-state-helpers.js");

test("sortRuns orders runs from newest to oldest by updatedAt and startedAt", () => {
  const runs = sortRuns([
    { id: "run_old", startedAt: "2026-04-18T10:00:00.000Z", updatedAt: "2026-04-18T10:05:00.000Z" },
    { id: "run_new", startedAt: "2026-04-18T11:00:00.000Z", updatedAt: "2026-04-18T11:01:00.000Z" },
    { id: "run_mid", startedAt: "2026-04-18T10:30:00.000Z" }
  ]);

  assert.deepEqual(runs.map((run) => run.id), ["run_new", "run_mid", "run_old"]);
  assert.equal(compareRunsByRecency(runs[0], runs[1]) < 0, true);
});

test("resolveSelectedRunId preserves the explicit selection when it still exists", () => {
  const runs = [
    { id: "run_1", status: "FINISHED", updatedAt: "2026-04-18T10:00:00.000Z" },
    { id: "run_2", status: "RUNNING", updatedAt: "2026-04-18T11:00:00.000Z" }
  ];

  assert.equal(resolveSelectedRunId(runs, "run_1"), "run_1");
});

test("resolveSelectedRunId falls back to the running run when the selection is missing", () => {
  const runs = [
    { id: "run_1", status: "FINISHED", updatedAt: "2026-04-18T10:00:00.000Z" },
    { id: "run_2", status: "RUNNING", updatedAt: "2026-04-18T09:00:00.000Z" },
    { id: "run_3", status: "FINISHED", updatedAt: "2026-04-18T11:00:00.000Z" }
  ];

  assert.equal(resolveSelectedRunId(runs, "missing_run"), "run_2");
});

test("resolveSelectedRunId falls back to the newest run when nothing is running", () => {
  const runs = [
    { id: "run_1", status: "FINISHED", updatedAt: "2026-04-18T08:00:00.000Z" },
    { id: "run_2", status: "FAILED", updatedAt: "2026-04-18T09:00:00.000Z" }
  ];

  assert.equal(resolveSelectedRunId(runs, null), "run_2");
});

test("findRunById returns the selected run or null", () => {
  const runs = [{ id: "run_1" }, { id: "run_2" }];

  assert.deepEqual(findRunById(runs, "run_2"), { id: "run_2" });
  assert.equal(findRunById(runs, "run_3"), null);
});
